import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEM_PAUSA,
  executarComando,
  lerAtualizacao,
  lerComando,
  mudarPeloPainel,
  montarStatus,
  segredoDoTelegramConfere,
  type ArmazemPausa,
  type DepsComando,
  type EstadoPausa,
} from './suporte-pausa.js';

const JOAO = '7822226023';
const AGORA = new Date('2026-11-11T15:00:00Z');

/** Armazém em memória com a mesma regra do de verdade: gravar devolve o estado ANTERIOR e não mexe se já estava assim. */
function armazemEmMemoria(inicial: EstadoPausa = SEM_PAUSA) {
  let estado = inicial;
  const a: ArmazemPausa & { ignorar(): void; gravacoes: number } = {
    gravacoes: 0,
    async ler() {
      return estado;
    },
    async gravar({ pausado, por, quando }) {
      const antes = estado;
      if (antes.pausado === pausado) return antes;
      a.gravacoes += 1;
      estado = pausado ? { pausado: true, desde: quando, por, ignoradas: 0 } : SEM_PAUSA;
      return antes;
    },
    ignorar() {
      if (estado.pausado) estado = { ...estado, ignoradas: estado.ignoradas + 1 };
    },
  };
  return a;
}

const depsDe = (pausa: ArmazemPausa, modo = 'ligado'): DepsComando => ({
  pausa,
  agora: () => AGORA,
  modoDoMenu: () => modo,
  dadosDoStatus: async () => ({ abertas: 3, reabertas: 1, lembrete: 'desligado' }),
});

const mensagem = (texto: string, extra: { chat?: unknown; de?: unknown; tipo?: string; bot?: boolean } = {}) => ({
  update_id: 1,
  message: {
    chat: { id: extra.chat ?? Number(JOAO), type: extra.tipo ?? 'private' },
    from: { id: extra.de ?? Number(JOAO), is_bot: extra.bot ?? false },
    text: texto,
  },
});

// ─── lerComando ─────────────────────────────────────────────────────────────────────────────────────────

test('lerComando: aceita /pausar, /voltar, /status, com @bot, maiúsculas e argumentos; o resto é null', () => {
  assert.equal(lerComando('/pausar'), 'pausar');
  assert.equal(lerComando('/Pausar@ddchamados_bot'), 'pausar');
  assert.equal(lerComando('  /voltar  agora '), 'voltar');
  assert.equal(lerComando('/retomar'), 'voltar');
  assert.equal(lerComando('/status'), 'status');
  assert.equal(lerComando('/ajuda'), 'ajuda');
  assert.equal(lerComando('/start'), 'ajuda');
  assert.equal(lerComando('/apagartudo'), null);
  assert.equal(lerComando('pausar'), null, 'sem a barra não é comando');
  assert.equal(lerComando('por favor /pausar'), null, 'o comando tem de ser a primeira palavra');
  assert.equal(lerComando(undefined), null);
  assert.equal(lerComando(42), null);
});

// ─── lerAtualizacao: quem pode mandar ───────────────────────────────────────────────────────────────────

test('lerAtualizacao: só o chat privado do João, nos dois campos (chat e remetente)', () => {
  assert.deepEqual(lerAtualizacao(mensagem('/pausar'), JOAO), { ok: true, comando: 'pausar' });
  assert.deepEqual(lerAtualizacao(mensagem('/xyz'), JOAO), { ok: true, comando: 'desconhecido' });
});

test('lerAtualizacao: outro chat, outro remetente, grupo, bot, mensagem editada, texto comum e corpo torto são ignorados', () => {
  const motivo = (c: unknown) => {
    const r = lerAtualizacao(c, JOAO);
    assert.equal(r.ok, false);
    return r.ok ? '' : r.motivo;
  };
  assert.equal(motivo(mensagem('/pausar', { chat: 111, de: 111 })), 'chat não autorizado');
  assert.equal(motivo(mensagem('/pausar', { chat: Number(JOAO), de: 111 })), 'chat não autorizado', 'chat certo, remetente errado');
  assert.equal(motivo(mensagem('/pausar', { tipo: 'group' })), 'não é conversa privada');
  assert.equal(motivo(mensagem('/pausar', { bot: true })), 'remetente é bot');
  assert.equal(motivo(mensagem('oi')), 'não é comando');
  assert.equal(motivo({ update_id: 1, edited_message: mensagem('/pausar').message }), 'não é mensagem nova');
  assert.equal(motivo(null), 'não é mensagem nova');
  assert.equal(motivo('texto'), 'não é mensagem nova');
  assert.equal(motivo([]), 'não é mensagem nova');
  assert.equal(motivo({ message: { text: '/pausar' } }), 'sem remetente');
});

test('lerAtualizacao: sem chat do João configurado, nada passa', () => {
  assert.equal(lerAtualizacao(mensagem('/pausar'), '').ok, false);
});

test('lerAtualizacao: id do chat comparado como texto (o Telegram manda número; a config é texto)', () => {
  assert.equal(lerAtualizacao(mensagem('/status', { chat: JOAO, de: JOAO }), JOAO).ok, true);
});

// ─── o segredo do webhook ───────────────────────────────────────────────────────────────────────────────

test('segredoDoTelegramConfere: exato; vazio, ausente, lista e diferente são recusados; sem segredo no servidor recusa tudo', () => {
  assert.equal(segredoDoTelegramConfere('abc-123_XYZ', 'abc-123_XYZ'), true);
  assert.equal(segredoDoTelegramConfere('abc-123_XYZ', 'abc-123_XYz'), false);
  assert.equal(segredoDoTelegramConfere('abc-123_XYZ', 'abc'), false);
  assert.equal(segredoDoTelegramConfere('abc-123_XYZ', ''), false);
  assert.equal(segredoDoTelegramConfere('abc-123_XYZ', undefined), false);
  assert.equal(segredoDoTelegramConfere('abc-123_XYZ', ['abc-123_XYZ']), false);
  assert.equal(segredoDoTelegramConfere(undefined, 'qualquer'), false);
  assert.equal(segredoDoTelegramConfere('', ''), false);
  assert.equal(segredoDoTelegramConfere('   ', '   '), false);
});

// ─── os comandos ────────────────────────────────────────────────────────────────────────────────────────

test('/pausar grava a pausa (quem = telegram, quando = agora) e avisa; de novo, não regrava', async () => {
  const a = armazemEmMemoria();
  const t1 = await executarComando('pausar', depsDe(a));
  assert.match(t1, /PAUSADO/);
  assert.deepEqual(await a.ler(), { pausado: true, desde: AGORA, por: 'telegram', ignoradas: 0 });
  assert.equal(a.gravacoes, 1);
  a.ignorar();
  a.ignorar();
  const t2 = await executarComando('pausar', depsDe(a));
  assert.match(t2, /Já estava pausado/);
  assert.match(t2, /2 mensagem/);
  assert.equal(a.gravacoes, 1, 'a segunda vez não regrava (não zera a contagem nem a hora)');
});

test('/pausar com o menu desligado no servidor avisa que a pausa só vale quando ele for ligado', async () => {
  const t = await executarComando('pausar', depsDe(armazemEmMemoria(), 'desligado'));
  assert.match(t, /"desligado" no servidor/);
  const ligado = await executarComando('pausar', depsDe(armazemEmMemoria(), 'ligado'));
  assert.doesNotMatch(ligado, /no servidor/);
});

test('/voltar retoma e diz quantas mensagens ficaram sem resposta; sem pausa, só diz que já estava ativo', async () => {
  const a = armazemEmMemoria();
  assert.match(await executarComando('voltar', depsDe(a)), /já estava ativo/);
  assert.equal(a.gravacoes, 0);
  await executarComando('pausar', depsDe(a));
  a.ignorar();
  a.ignorar();
  a.ignorar();
  const t = await executarComando('voltar', depsDe(a));
  assert.match(t, /RETOMADO/);
  assert.match(t, /3 mensagem/);
  assert.match(t, /mandar de novo/);
  assert.deepEqual(await a.ler(), SEM_PAUSA);
});

test('/status mostra o modo do servidor, a pausa, as abertas e o lembrete', async () => {
  const a = armazemEmMemoria();
  const livre = await executarComando('status', depsDe(a));
  assert.match(livre, /Servidor: ligado/);
  assert.match(livre, /ativo \(não pausado\)/);
  assert.match(livre, /Demandas abertas: 3 \(1 reaberta\)/);
  assert.match(livre, /Lembretes das 9h e 17h: desligado/);
  await executarComando('pausar', depsDe(a));
  a.ignorar();
  const pausado = await executarComando('status', depsDe(a, 'desligado'));
  assert.match(pausado, /PAUSADO desde 11\/11 12:00 pelo Telegram — 1 mensagem/);
  assert.match(pausado, /Servidor: DESLIGADO/);
});

test('montarStatus: modo seco descrito como "não envia nem grava"', () => {
  assert.match(montarStatus({ modo: 'seco', pausa: SEM_PAUSA, abertas: 0, reabertas: 0, lembrete: 'x' }), /seco \(não envia nem grava\)/);
});

test('comando desconhecido e /ajuda não tocam no banco', async () => {
  const a = armazemEmMemoria();
  assert.match(await executarComando('desconhecido', depsDe(a)), /Não conheço/);
  assert.match(await executarComando('ajuda', depsDe(a)), /\/pausar/);
  assert.equal(a.gravacoes, 0);
});

// ─── o painel ───────────────────────────────────────────────────────────────────────────────────────────

test('painel: pausar e retomar gravam a pessoa, avisam o Telegram e dão o mesmo estado que o comando', async () => {
  const a = armazemEmMemoria();
  const deps = { pausa: a, agora: () => AGORA, modoDoMenu: () => 'ligado' };
  const p = await mudarPeloPainel(true, 'suzanne@x.com', deps);
  assert.equal(p.mudou, true);
  assert.deepEqual(p.estado, { pausado: true, desde: AGORA, por: 'suzanne@x.com', ignoradas: 0 });
  assert.match(p.aviso ?? '', /PAUSADO pelo painel \(suzanne@x\.com\)/);

  const repetido = await mudarPeloPainel(true, 'joao@x.com', deps);
  assert.equal(repetido.mudou, false);
  assert.equal(repetido.aviso, null, 'sem mudança, sem aviso');
  assert.equal(repetido.estado.por, 'suzanne@x.com', 'a pausa original não é sobrescrita');

  a.ignorar();
  const r = await mudarPeloPainel(false, 'joao@x.com', deps);
  assert.equal(r.mudou, true);
  assert.deepEqual(r.estado, SEM_PAUSA);
  assert.match(r.aviso ?? '', /RETOMADO pelo painel/);
  assert.match(r.aviso ?? '', /1 mensagem/);
});

test('os dois caminhos enxergam a mesma chave: pausa pelo Telegram, retoma pelo painel', async () => {
  const a = armazemEmMemoria();
  await executarComando('pausar', depsDe(a));
  const r = await mudarPeloPainel(false, 'joao@x.com', { pausa: a, agora: () => AGORA, modoDoMenu: () => 'ligado' });
  assert.equal(r.mudou, true);
  assert.match(await executarComando('voltar', depsDe(a)), /já estava ativo/);
});
