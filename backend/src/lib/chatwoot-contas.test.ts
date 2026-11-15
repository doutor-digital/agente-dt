/**
 * Passo 2 do «uma conta do Chatwoot por clínica»: de que CONTA é cada unidade e cada caixa, e o contexto da conta. Identidade de Parauapebas:
 * sem `conta_id`, tudo devolve EXATAMENTE o que a conta única do ambiente devolvia (inclusive o mesmo objeto de contexto).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const U = await import('./chatwoot-unidades.js');
const C = await import('../mcp-remoto/chatwoot.js');

const AMBIENTE = { CHATWOOT_API_TOKEN: 'tk-do-ambiente', CHATWOOT_CONTA_ID: '1', CHATWOOT_URL: 'https://crm.exemplo.test' } as NodeJS.ProcessEnv;
const PARAU = U.SEMENTE_PARAUAPEBAS.slug;
const DEMO: import('./chatwoot-unidades.js').ConfigChatwootUnidade = {
  slug: 'clinica-demonstracao',
  contaId: 2,
  prefixoModelos: 'demo_',
  usuarioCelularId: null,
  gerenteId: 51,
  metaAgendamentosDia: 5,
  kapsoPhoneNumberId: null,
  wabaId: null,
  envSufixo: 'DEMO',
  dadosModelos: { nome: 'Clínica Demonstração', cidade: 'Demonstração', endereco: 'Rua Exemplo, 100 — Centro, Demonstração/PA', mapa: 'https://maps.example/demo' },
  caixas: [{ id: 20, tipo: 'cloud' }],
};

afterEach(() => U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS]));

test('IDENTIDADE: Parauapebas (sem conta_id) tem conta null (a do ambiente), o token é o global e o contexto é o MESMO objeto', () => {
  assert.equal(U.SEMENTE_PARAUAPEBAS.contaId, null);
  assert.equal(U.contaDaUnidade(PARAU), null);
  assert.equal(U.contaDaCaixa(2), null);
  assert.equal(U.contaDaCaixa(3), null);
  assert.equal(U.contaDaCaixa(4), null, 'a caixa de histórico também é de Parauapebas');
  assert.deepEqual(C.contaChatwootDaUnidade(PARAU, AMBIENTE), C.contaChatwootDoAmbiente(AMBIENTE));
  assert.deepEqual(C.contasDoChatwoot(AMBIENTE), [1]);
  const ctx = C.criarContextoChatwoot(C.contaChatwootDoAmbiente(AMBIENTE));
  assert.equal(C.contextoDaUnidade(ctx, PARAU, AMBIENTE), ctx);
  assert.equal(C.contextoDaCaixa(ctx, 3, AMBIENTE), ctx);
  assert.equal(C.contextoDaCaixa(ctx, 2, AMBIENTE), ctx);
  assert.equal(C.contextoDaCaixa(ctx, 4, AMBIENTE), ctx);
  assert.equal(C.contaChatwootDaUnidade(PARAU, {} as NodeJS.ProcessEnv), null, 'sem token/conta no ambiente: nada a chamar');
});

test('DESCONHECIDA é diferente de «conta do ambiente»: unidade ou caixa que ninguém tem RECUSA (null), nunca cai na conta 1', () => {
  assert.equal(U.contaDaUnidade('unidade-que-nao-existe'), undefined);
  assert.equal(U.contaDaCaixa(999), undefined);
  assert.equal(C.contaChatwootDaUnidade('unidade-que-nao-existe', AMBIENTE), null);
  const ctx = C.criarContextoChatwoot(C.contaChatwootDoAmbiente(AMBIENTE));
  assert.equal(C.contextoDaUnidade(ctx, 'unidade-que-nao-existe', AMBIENTE), null);
  assert.equal(C.contextoDaCaixa(ctx, 999, AMBIENTE), null);
});

test('conta_id inválido: a configuração é descartada e a unidade vira DESCONHECIDA (recusa) — nunca «conta 1» em silêncio', () => {
  for (const ruim of [0, -3, 1.5, Number.NaN]) assert.match(U.problemasDaConfig({ ...DEMO, contaId: ruim }).join(';'), /conta do Chatwoot inválida/, String(ruim));
  assert.deepEqual(U.problemasDaConfig(DEMO), []);
  assert.deepEqual(U.problemasDaConfig({ ...DEMO, contaId: null }), []);
  const avisos: string[] = [];
  const lista = U.mesclarComSemente([{ ...DEMO, contaId: -1 }], (m) => avisos.push(m));
  assert.deepEqual(lista.map((c) => c.slug), [PARAU]);
  assert.match(avisos.join(), /conta do Chatwoot inválida/);
  U.aplicarConfigs(lista);
  assert.equal(U.contaDaUnidade('clinica-demonstracao'), undefined);
  assert.equal(U.contaDaCaixa(20), undefined);
  const ctx = C.criarContextoChatwoot(C.contaChatwootDoAmbiente(AMBIENTE));
  assert.equal(C.contextoDaUnidade(ctx, 'clinica-demonstracao', AMBIENTE), null, 'a clínica de conta inválida não escreve na conta de ninguém');
});

test('linha do banco sem a coluna nova (antes da migration) vira conta null; linha com conta_id vira a conta', () => {
  const base = { unitId: 'u1', prefixoModelos: 'demo_', usuarioCelularId: null, gerenteId: 51, metaAgendamentosDia: 5, kapsoPhoneNumberId: null, wabaId: null, envSufixo: 'DEMO', dadosModelos: DEMO.dadosModelos, unit: { slug: DEMO.slug }, caixas: [{ caixaId: 20, tipo: 'cloud', instanciaEvolution: null }] };
  assert.equal(U.configDaLinha(base).contaId, null);
  assert.equal(U.configDaLinha({ ...base, contaId: null }).contaId, null);
  assert.equal(U.configDaLinha({ ...base, contaId: 2 }).contaId, 2);
});

test('TOKEN POR CONTA: CHATWOOT_API_TOKEN_<SUFIXO> da unidade vale só para ela; sem ele, o global; o token de uma clínica nunca vai para a conta de outra', async () => {
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO]);
  const env = { ...AMBIENTE, CHATWOOT_API_TOKEN_DEMO: 'tk-so-da-demo' } as NodeJS.ProcessEnv;
  assert.deepEqual(C.contaChatwootDaUnidade('clinica-demonstracao', env), { url: 'https://crm.exemplo.test', conta: 2, token: 'tk-so-da-demo' });
  assert.deepEqual(C.contaChatwootDaUnidade(PARAU, env), { url: 'https://crm.exemplo.test', conta: 1, token: 'tk-do-ambiente' }, 'Parauapebas segue com o token global');
  assert.deepEqual(C.contaChatwootDaUnidade('clinica-demonstracao', AMBIENTE), { url: 'https://crm.exemplo.test', conta: 2, token: 'tk-do-ambiente' }, 'sem o token da conta: o global');
  assert.deepEqual(C.contaChatwootDaUnidade(PARAU, { ...AMBIENTE, CHATWOOT_API_TOKEN_PARAUAPEBAS: 'tk-so-de-parau' } as NodeJS.ProcessEnv)?.token, 'tk-so-de-parau', 'a regra vale igual para Parauapebas');

  const chamadas: Array<{ url: string; token: string | undefined }> = [];
  const fetchFalso = (async (url: string, o: { headers?: Record<string, string> }) => {
    chamadas.push({ url: String(url), token: o.headers?.api_access_token });
    return { ok: true, status: 200, text: async () => '[]' } as Response;
  }) as unknown as typeof fetch;
  const ctx = C.criarContextoChatwoot(C.contaChatwootDoAmbiente(env), { fetch: fetchFalso });
  await C.chamar(C.contextoDaUnidade(ctx, PARAU, env)!, 'GET', 'inboxes');
  await C.chamar(C.contextoDaUnidade(ctx, 'clinica-demonstracao', env)!, 'GET', 'inboxes');
  await C.chamar(C.contextoDaCaixa(ctx, 20, env)!, 'GET', 'labels');
  assert.deepEqual(chamadas, [
    { url: 'https://crm.exemplo.test/api/v1/accounts/1/inboxes', token: 'tk-do-ambiente' },
    { url: 'https://crm.exemplo.test/api/v1/accounts/2/inboxes', token: 'tk-so-da-demo' },
    { url: 'https://crm.exemplo.test/api/v1/accounts/2/labels', token: 'tk-so-da-demo' },
  ]);
  assert.deepEqual(C.contasDoChatwoot(env), [1, 2]);
  assert.deepEqual(U.contasExplicitas(), [2]);
  assert.equal(U.contaDaCaixa(20), 2);
  assert.equal(U.contaDaCaixa(3), null, 'a caixa de Parauapebas não muda de conta');
});

test('o contexto de outra conta é guardado (mesmo objeto na 2ª vez), tem as PRÓPRIAS confirmações pendentes e não altera o original', () => {
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO]);
  const ctx = C.criarContextoChatwoot(C.contaChatwootDoAmbiente(AMBIENTE));
  const c2 = C.contextoDaUnidade(ctx, 'clinica-demonstracao', AMBIENTE)!;
  assert.notEqual(c2, ctx);
  assert.equal(C.contextoDaUnidade(ctx, 'clinica-demonstracao', AMBIENTE), c2);
  assert.equal(c2.conta!.conta, 2);
  assert.equal(ctx.conta!.conta, 1, 'o contexto original não foi alterado');
  assert.notEqual(c2.pendentes, ctx.pendentes);
  assert.equal(c2.fetch, ctx.fetch);
  assert.equal(c2.agora, ctx.agora);
  // outro token para a mesma conta = outro contexto (o token é parte da identidade)
  const c2b = C.contextoDaUnidade(ctx, 'clinica-demonstracao', { ...AMBIENTE, CHATWOOT_API_TOKEN_DEMO: 'outro' } as NodeJS.ProcessEnv)!;
  assert.notEqual(c2b, c2);
});
