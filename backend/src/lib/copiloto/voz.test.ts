import test from 'node:test';
import assert from 'node:assert/strict';
import { corpoDaSessao, criarSessaoDeVoz, instrucoesDaVoz, lerEtapaDoPedido, reservarSessao, _limparSessoesDoDia, VALIDADE_DO_SEGREDO_S } from './voz.js';

test('instrucoesDaVoz: sem perfil cai na regra geral e manda não dizer que o cartão anda sozinho', () => {
  const t = instrucoesDaVoz(null);
  assert.match(t, /DIVISÃO DE TRABALHO COM A IA/);
  assert.match(t, /não diga à pessoa para mover o cartão nem que ele anda sozinho/);
  assert.match(t, /pergunte qual etapa/);
});

test('instrucoesDaVoz: com perfil e ficha viva usa os dois e proíbe o processo antigo de memória', () => {
  const t = instrucoesDaVoz('EM QUALIFICAÇÃO', {
    perfil: { temSofia: true, etapasDaSofia: ['Incoming leads', 'EM QUALIFICAÇÃO'], moveAutomatico: true, sincronizaFranquia: true },
    ficha: { etapa: 'EM QUALIFICAÇÃO', visiveis: ['✎ Queixa', '★ Qualificação'], obrigatorios: ['★ Qualificação'], chegamSozinhos: [] },
  });
  assert.match(t, /Esta unidade TEM a Sofia/);
  assert.match(t, /Ela atende nas etapas: Incoming leads, EM QUALIFICAÇÃO/);
  assert.match(t, /O CARTÃO ANDA SOZINHO/);
  assert.match(t, /lida do Kommo agora/);
  assert.match(t, /Não use aulas, manuais ou processos antigos de memória/);
  assert.doesNotMatch(t, /Leia a conversa, salve o nome no título/);
});

test('instrucoesDaVoz: etapa dita mas ficha não lida → não lista campos', () => {
  const t = instrucoesDaVoz('AGENDADO', { perfil: null, ficha: null });
  assert.match(t, /não consegui ler a ficha dela agora. Não liste campos/);
});

test('lerEtapaDoPedido: só texto, aparado e limitado', () => {
  assert.equal(lerEtapaDoPedido({ etapa: '  AGENDADO ' }), 'AGENDADO');
  assert.equal(lerEtapaDoPedido({ etapa: 42 }), null);
  assert.equal(lerEtapaDoPedido(null), null);
  assert.equal(lerEtapaDoPedido({ etapa: 'x'.repeat(500) })?.length, 60);
});

test('corpoDaSessao: validade curta, transcrição em português e voz escolhida', () => {
  const c = corpoDaSessao('modelo-x', 'marin', 'oi');
  assert.equal(c.expires_after.seconds, VALIDADE_DO_SEGREDO_S);
  assert.equal(c.session.model, 'modelo-x');
  assert.equal(c.session.audio.output.voice, 'marin');
  assert.equal(c.session.audio.input.transcription.language, 'pt');
});

test('criarSessaoDeVoz: devolve o segredo; manda a chave só no cabeçalho', async () => {
  let visto: { url: string; init: RequestInit } | null = null;
  const falso = (async (url: string, init: RequestInit) => {
    visto = { url, init };
    return new Response(JSON.stringify({ value: 'ek_teste', expires_at: 123 }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await criarSessaoDeVoz('sk-minha-chave-123456', { a: 1 }, falso);
  assert.deepEqual(r, { segredo: 'ek_teste', expiraEm: 123 });
  assert.equal(visto!.url, 'https://api.openai.com/v1/realtime/client_secrets');
  assert.equal((visto!.init.headers as Record<string, string>).authorization, 'Bearer sk-minha-chave-123456');
  assert.doesNotMatch(String(visto!.init.body), /sk-minha-chave/);
});

test('criarSessaoDeVoz: erro da OpenAI não carrega a chave nem o corpo enviado', async () => {
  const falso = (async () => new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(
    () => criarSessaoDeVoz('sk-minha-chave-123456', { instrucoes: 'segredo do prompt' }, falso),
    (e: Error) => /OpenAI 404: model not found/.test(e.message) && !/sk-minha-chave|segredo do prompt/.test(e.message),
  );
  const semSegredo = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(() => criarSessaoDeVoz('sk-x-1234567890', {}, semSegredo), /sem segredo/);
});

test('reservarSessao: conta por unidade e por dia, e zera no dia seguinte', () => {
  _limparSessoesDoDia();
  const d1 = new Date('2026-10-29T12:00:00Z'), d2 = new Date('2026-10-30T12:00:00Z');
  assert.equal(reservarSessao('timbo', 2, d1), true);
  assert.equal(reservarSessao('timbo', 2, d1), true);
  assert.equal(reservarSessao('timbo', 2, d1), false);
  assert.equal(reservarSessao('caxias', 2, d1), true);
  assert.equal(reservarSessao('timbo', 2, d2), true);
});
