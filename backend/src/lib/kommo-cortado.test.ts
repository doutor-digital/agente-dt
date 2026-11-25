/**
 * Unidade que saiu da Kommo (corte de Timbó, 25/11/2026): a trava «cartão ATIVO no Kommo» não pode mais calar a Sofia do CRM.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { kommoCortado, confereCartaoNoKommo } = await import('./kommo-cortado.js');
const IA = await import('./chatwoot-ia.js');
const C = await import('../mcp-remoto/chatwoot.js');

const ENV = { CHATWOOT_API_TOKEN: 'tk-do-ambiente', CHATWOOT_CONTA_ID: '1', CHATWOOT_URL: 'https://crm.exemplo.test' } as NodeJS.ProcessEnv;
const TIMBO = 'doutor-hernia-timbo';

test('kommoCortado: só o slug da lista; espaços e vírgulas sobrando não atrapalham; lista vazia ou sem slug = não cortado', () => {
  assert.equal(kommoCortado(TIMBO, 'doutor-hernia-timbo'), true);
  assert.equal(kommoCortado(TIMBO, ' doutor-hernia-salto , doutor-hernia-timbo ,'), true);
  assert.equal(kommoCortado('doutor-hernia-salto', 'doutor-hernia-timbo'), false);
  // não casa pedaço do nome
  assert.equal(kommoCortado('doutor-hernia-tim', 'doutor-hernia-timbo'), false);
  assert.equal(kommoCortado(TIMBO, ''), false);
  assert.equal(kommoCortado(TIMBO, undefined), false);
  assert.equal(kommoCortado(null, 'doutor-hernia-timbo'), false);
  assert.equal(kommoCortado('', 'doutor-hernia-timbo'), false);
});

test('kommoCortado: sem segundo argumento lê CHATWOOT_KOMMO_CORTADO_SLUGS', () => {
  const antes = process.env.CHATWOOT_KOMMO_CORTADO_SLUGS;
  try {
    process.env.CHATWOOT_KOMMO_CORTADO_SLUGS = TIMBO;
    assert.equal(kommoCortado(TIMBO), true);
    delete process.env.CHATWOOT_KOMMO_CORTADO_SLUGS;
    assert.equal(kommoCortado(TIMBO), false);
  } finally {
    if (antes === undefined) delete process.env.CHATWOOT_KOMMO_CORTADO_SLUGS;
    else process.env.CHATWOOT_KOMMO_CORTADO_SLUGS = antes;
  }
});

test('Sofia do CRM: unidade cortada NÃO consulta a Kommo — cartão aberto lá não cala a Sofia', async () => {
  const antes = process.env.CHATWOOT_KOMMO_CORTADO_SLUGS;
  const chamadas: string[] = [];
  const f = mock.method(globalThis, 'fetch', (async (url: unknown) => {
    chamadas.push(String(url));
    throw new Error('rede desligada no teste');
  }) as never);
  try {
    const ctx = C.criarContextoChatwoot(C.contaChatwootDoAmbiente(ENV), { fetch: (async () => { throw new Error('sem Chatwoot no teste'); }) as never });
    const portas = IA.portasReais(ctx, { tokenRobo: null });
    const unidade = (slug: string) => ({ id: 9, slug, kommoSubdomain: 'clinica', kommoAccessToken: 'tok-kommo' }) as never;

    process.env.CHATWOOT_KOMMO_CORTADO_SLUGS = TIMBO;
    assert.equal(await portas.cartaoNoKommo(unidade(TIMBO), '5547999990001'), null);
    assert.equal(chamadas.filter((u) => u.includes('kommo')).length, 0, 'unidade cortada não pode chamar a Kommo');

  } finally {
    f.mock.restore();
    if (antes === undefined) delete process.env.CHATWOOT_KOMMO_CORTADO_SLUGS;
    else process.env.CHATWOOT_KOMMO_CORTADO_SLUGS = antes;
  }
});

test('confereCartaoNoKommo: confere só com Kommo configurado e unidade NÃO cortada (a mesma regra na Sofia e na régua)', () => {
  const com = { slug: TIMBO, kommoSubdomain: 'clinica', kommoAccessToken: 'tok' };
  assert.equal(confereCartaoNoKommo(com, ''), true);
  assert.equal(confereCartaoNoKommo(com, 'doutor-hernia-salto'), true);
  assert.equal(confereCartaoNoKommo(com, TIMBO), false);
  assert.equal(confereCartaoNoKommo({ ...com, kommoAccessToken: null }, ''), false);
  assert.equal(confereCartaoNoKommo({ ...com, kommoSubdomain: '' }, ''), false);
});
