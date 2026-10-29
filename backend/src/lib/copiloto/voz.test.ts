import test from 'node:test';
import assert from 'node:assert/strict';
import { corpoDaSessao, criarSessaoDeVoz, instrucoesDaVoz, lerEtapaDoPedido, reservarSessao, _limparSessoesDoDia, VALIDADE_DO_SEGREDO_S } from './voz.js';
import { fichaDaEtapa, FICHAS_DAS_ETAPAS } from './fichas-das-etapas.js';

test('fichaDaEtapa: acha pelo nome, com ou sem acento, e junta "leads de entrada" com "Incoming leads"', () => {
  assert.equal(fichaDaEtapa('em qualificacao')?.nome, 'EM QUALIFICAÇÃO');
  assert.equal(fichaDaEtapa('Etapa de leads de entrada')?.nome, 'Incoming leads');
  assert.equal(fichaDaEtapa('CONFERIR NA FRANQUIA'), null);
  assert.equal(fichaDaEtapa(null), null);
  assert.equal(Object.keys(FICHAS_DAS_ETAPAS).length, 13);
});

test('instrucoesDaVoz: com etapa traz a missão e os campos; sem etapa manda perguntar qual é', () => {
  const com = instrucoesDaVoz('EM QUALIFICAÇÃO');
  assert.match(com, /etapa EM QUALIFICAÇÃO/);
  assert.match(com, /Qualificação \(Quente\/Morno\/Frio\)/);
  assert.match(com, /AGENDADO ou EM ESPERA/);
  const sem = instrucoesDaVoz(null);
  assert.match(sem, /pergunte qual etapa/);
  assert.doesNotMatch(sem, /Ficha da etapa/);
});

test('instrucoesDaVoz: as regras de segurança estão sempre lá', () => {
  for (const e of [null, 'AGENDADO', 'etapa que não existe']) {
    const t = instrucoesDaVoz(e);
    assert.match(t, /NUNCA invente regra, preço, chave Pix/);
    assert.match(t, /NUNCA dê orientação médica/);
    assert.match(t, /Não peça nem repita nome, telefone, CPF/);
    assert.match(t, /Você não altera nada no Kommo/);
  }
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
