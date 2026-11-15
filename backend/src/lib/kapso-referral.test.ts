/**
 * kapso-referral: só mensagem de paciente da caixa oficial sem referral; pergunta ao Kapso pela mensagem (chave só no cabeçalho,
 * tenta o próximo número no 404); guarda o referral; sem chave / Kapso fora = não faz nada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { aplicarReferralDoKapso, consultarKapso, mensagemParaConsultar, referralDaMensagemDoKapso } = await import('./kapso-referral.js');

const WAMID = 'wamid.HBgMNTU5NDkyNDg0NDk5FQIAEhggQUMzMjUxRTJE';
const msg = (o: { tipo?: unknown; caixa?: number; ref?: unknown; source?: string; privada?: boolean } = {}) => ({
  event: 'message_created',
  message_type: o.tipo ?? 'incoming',
  private: o.privada ?? false,
  source_id: o.source ?? WAMID,
  content_attributes: o.ref === undefined ? {} : { referral: o.ref },
  conversation: { id: 900, inbox_id: o.caixa ?? 3 },
});
const CAIXAS = new Set([3]);

test('qual mensagem consultar: paciente, caixa oficial, com wamid e SEM referral', () => {
  assert.deepEqual(mensagemParaConsultar(msg(), CAIXAS), { conversa: 900, caixa: 3, wamid: WAMID, contato: null });
  assert.equal(mensagemParaConsultar(msg({ tipo: 'outgoing' }), CAIXAS), null);
  assert.equal(mensagemParaConsultar(msg({ privada: true }), CAIXAS), null);
  assert.equal(mensagemParaConsultar(msg({ caixa: 2 }), CAIXAS), null, 'caixa sem Kapso');
  assert.equal(mensagemParaConsultar(msg({ source: 'abc' }), CAIXAS), null, 'sem wamid');
  assert.equal(mensagemParaConsultar(msg({ ref: { ctwa_clid: 'x' } }), CAIXAS), null, 'o Chatwoot já tem o referral');
  assert.equal(mensagemParaConsultar({ ...msg(), event: 'conversation_updated' }, CAIXAS), null);
});

test('referral da mensagem do Kapso: anúncio com ctwa_clid; publicação sem id de anúncio; sem referral = null', () => {
  const r = referralDaMensagemDoKapso({ timestamp: '1794557921', referral: { source_type: 'ad', source_id: '120253955239410514', ctwa_clid: 'Afd123', headline: 'Dor na coluna?', source_url: 'https://fb.me/x' } });
  assert.deepEqual(r, {
    anuncio: '120253955239410514',
    ctwaClid: 'Afd123',
    tipo: 'ad',
    titulo: 'Dor na coluna?',
    url: 'https://fb.me/x',
    quando: 1794557921000,
    corpo: null,
    midia: null,
    tipoMidia: null,
    video: null,
  });
  assert.equal(referralDaMensagemDoKapso({ referral: { source_type: 'post', source_id: '9' } })!.anuncio, null);
  assert.equal(referralDaMensagemDoKapso({ text: { body: 'oi' } }), null);
});

test('consultarKapso: UMA consulta, no número da CAIXA da mensagem (Parauapebas: o mesmo número de sempre); 404 = não veio de anúncio; chave só no cabeçalho', async () => {
  const urls: string[] = [];
  const cabs: string[] = [];
  const f = (async (url: string, init: { headers: Record<string, string> }) => {
    urls.push(url);
    cabs.push(init.headers['X-API-Key']!);
    if (url.includes('/404404404404/')) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    return { ok: true, status: 200, json: async () => ({ data: { timestamp: '1', referral: { source_type: 'ad', source_id: '55555', ctwa_clid: 'C1' } } }) };
  }) as any;
  const r = await consultarKapso(WAMID, 3, { KAPSO_API_KEY: 'chave-secreta-kapso' }, f);
  assert.equal(r?.ref?.ctwaClid, 'C1');
  assert.deepEqual(urls.map((u) => u.split('/v24.0/')[1]!.split('/')[0]), ['1212928641906230'], 'um número só: o de Parauapebas, como sempre');
  assert.ok(urls.every((u) => !u.includes('chave-secreta-kapso')) && cabs.every((c) => c === 'chave-secreta-kapso'));
  assert.equal(await consultarKapso(WAMID, 3, {}, f), null, 'sem chave');
  const recusa = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as any;
  assert.equal(await consultarKapso(WAMID, 3, { KAPSO_API_KEY: 'k' }, recusa), null);
  const quebra = (async () => { throw new Error('rede'); }) as any;
  assert.equal(await consultarKapso(WAMID, 3, { KAPSO_API_KEY: 'k' }, quebra), null);
});

test('consultarKapso com várias clínicas: cada mensagem vai ao número DA SUA CAIXA; erro no número de uma não impede a outra; caixa sem número ou fora da lista do ambiente não consulta', async () => {
  const { aplicarConfigs, SEMENTE_PARAUAPEBAS } = await import('./chatwoot-unidades.js');
  const demo = { ...SEMENTE_PARAUAPEBAS, slug: 'clinica-demonstracao', contaId: 2, prefixoModelos: 'demo_', envSufixo: 'DEMO', kapsoPhoneNumberId: '404404404404', wabaId: '999888777666555', caixas: [{ id: 20, tipo: 'cloud' as const }], usuarioCelularId: null, gerenteId: null };
  const semNumero = { ...demo, slug: 'sem-numero', prefixoModelos: 'semn_', envSufixo: 'SEMN', kapsoPhoneNumberId: null, wabaId: null, caixas: [{ id: 30, tipo: 'cloud' as const }] };
  aplicarConfigs([SEMENTE_PARAUAPEBAS, demo, semNumero]);
  try {
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      if (url.includes('/1212928641906230/')) return { ok: false, status: 500, json: async () => ({}) }; // o número de Parauapebas está com erro
      return { ok: true, status: 200, json: async () => ({ data: { timestamp: '1', referral: { source_type: 'ad', source_id: '77777', ctwa_clid: 'D1' } } }) };
    }) as any;
    const env = { KAPSO_API_KEY: 'k' };
    // a clínica demo acha a mensagem dela mesmo com o número de Parauapebas quebrado (antes o laço parava no 1º erro)
    assert.equal((await consultarKapso(WAMID, 20, env, f))?.ref?.ctwaClid, 'D1');
    assert.deepEqual(urls.map((u) => u.split('/v24.0/')[1]!.split('/')[0]), ['404404404404']);
    // e a mensagem de Parauapebas NÃO é perguntada pelo número da demo
    urls.length = 0;
    assert.equal(await consultarKapso(WAMID, 3, env, f), null);
    assert.deepEqual(urls.map((u) => u.split('/v24.0/')[1]!.split('/')[0]), ['1212928641906230']);
    // caixa sem número, caixa desconhecida: nenhuma consulta
    urls.length = 0;
    assert.equal(await consultarKapso(WAMID, 30, env, f), null);
    assert.equal(await consultarKapso(WAMID, 999, env, f), null);
    // a lista do ambiente manda: número que ela não inclui não é consultado
    assert.equal(await consultarKapso(WAMID, 20, { ...env, KAPSO_PHONE_NUMBER_IDS: '1212928641906230' }, f), null);
    assert.deepEqual(urls, []);
  } finally {
    aplicarConfigs([SEMENTE_PARAUAPEBAS]);
  }
});

test('aplicar: guarda só quando veio de anúncio; não lança', async () => {
  const guardados: unknown[] = [];
  const guardar = (async (...a: unknown[]) => { guardados.push(a); }) as any;
  const m = { conversa: 900, caixa: 3, wamid: WAMID };
  assert.equal(await aplicarReferralDoKapso(m, { consultar: (async () => ({ achou: true, ref: { anuncio: '1', ctwaClid: 'C', tipo: 'ad', titulo: null, url: null, quando: 1 } })) as any, guardar }), 'guardado');
  assert.equal(guardados.length, 1);
  const achados: unknown[] = [];
  await aplicarReferralDoKapso({ ...m, contato: 77 }, { consultar: (async () => ({ achou: true, ref: { anuncio: '1', ctwaClid: 'C', tipo: 'ad', titulo: null, url: null, quando: 1 } })) as any, guardar, aoAchar: async (x: unknown) => { achados.push(x); } });
  assert.deepEqual(achados, [{ conversa: 900, caixa: 3, contato: 77 }], 'avisa quem preenche a origem');
  assert.equal(await aplicarReferralDoKapso(m, { consultar: (async () => ({ achou: true, ref: null })) as any, guardar }), 'sem-anuncio');
  assert.equal(await aplicarReferralDoKapso(m, { consultar: (async () => null) as any, guardar }), 'sem-chave');
  assert.equal(await aplicarReferralDoKapso(m, { consultar: (async () => { throw new Error('x'); }) as any, guardar }), 'falhou');
  assert.equal(guardados.length, 2, 'só as duas vezes que veio de anúncio');
});
