/**
 * A rota do modelo preenchido: a unidade vem da CAIXA da conversa (ou, na conta de clínica sem caixa mapeada, da única unidade da conta) — nunca do pedido —, a regra é a da régua,
 * a rota sai no CORS do botão (só POST, só as origens do Chatwoot) e a chave desliga.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://t:t@localhost:5432/t';
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { preenchimentoDaConversa, corsDoAssistente, assistenteModeloPreenchidoHandler } = await import('./assistente.controller.js');
const U = await import('../lib/chatwoot-unidades.js');
const { CAIXAS_REGUA } = await import('../lib/chatwoot-regua.js');

const unitParau = { slug: 'doutor-hernia-parauapebas', name: 'Doutor Hérnia Parauapebas', pixKey: null };
const lida = (nome: string, attrs: Record<string, unknown> = {}) => ({ id: 77, nome, telefone: null, attrs, etiquetas: [], grupo: false, interno: false });
const consulta = { data_consulta: '2026-12-02', hora_consulta: '15:00' };
const caixaDeParau = Number(Object.entries(CAIXAS_REGUA).find(([, s]) => s === 'doutor-hernia-parauapebas')![0]);

afterEach(() => {
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS]);
});

test('caixa de Parauapebas: modelo do CRM com os MESMOS valores da régua', async () => {
  const r = await preenchimentoDaConversa({ modelo: 'parau_consulta_lembrete_vespera', lida: lida('maria souza', consulta), caixa: caixaDeParau, conta: 1 }, { unidade: async (slug) => (slug === unitParau.slug ? (unitParau as never) : null) });
  assert.equal(r.origem, 'crm');
  assert.deepEqual(r.valores, { '1': 'Maria', '2': '02/12 às 15:00' });
});

test('conta de clínica SEM caixa mapeada (Timbó, conta 3): a unidade é a única da conta, e o modelo de fora é lido pelo texto', async () => {
  const dados = { nome: 'Doutor Hérnia Timbó', cidade: 'Timbó', endereco: 'Rua A, 1', mapa: 'https://maps.example/t' };
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, { ...U.SEMENTE_PARAUAPEBAS, slug: 'doutor-hernia-timbo', contaId: 3, subdominio: 'drtimbo', prefixoModelos: 'timbocrm_', envSufixo: 'TIMBO', usuarioCelularId: null, gerenteId: null, metaAgendamentosDia: null, kapsoPhoneNumberId: null, wabaId: null, dadosModelos: dados, caixas: [{ id: 9901, tipo: 'cloud', instanciaEvolution: null }] }]);
  const vistas: string[] = [];
  const r = await preenchimentoDaConversa(
    { modelo: 'timbo_confirmacao', corpo: 'Olá, {{1}}!\n🗓 Data e horário: {{2}}', lida: lida('Ana Paula', consulta), caixa: null, conta: 3 },
    { unidade: async (slug) => { vistas.push(slug); return { slug, name: 'Doutor Hérnia Timbó', pixKey: null } as never; } },
  );
  assert.deepEqual(vistas, ['doutor-hernia-timbo']);
  assert.deepEqual(r, { origem: 'externo', valores: { '1': 'Ana', '2': '02/12 às 15:00' } });
  // o modelo do CRM de Timbó (prefixo timbocrm_) usa a régua com os dados dela
  const crm = await preenchimentoDaConversa({ modelo: 'timbocrm_consulta_lembrete_vespera', lida: lida('Ana', consulta), caixa: null, conta: 3 }, { unidade: async (slug) => ({ slug, name: 'Doutor Hérnia Timbó', pixKey: null }) as never });
  assert.equal(crm.origem, 'crm');
  assert.deepEqual(crm.valores, { '1': 'Ana', '2': '02/12 às 15:00' });
});

test('sem unidade (caixa desconhecida, conta sem clínica) ou unidade que o banco não tem: resposta vazia, nunca erro e nunca palpite', async () => {
  const vazio = { origem: 'nenhuma', valores: {} };
  assert.deepEqual(await preenchimentoDaConversa({ modelo: 'timbo_x', corpo: 'Olá, {{1}}', lida: lida('Ana'), caixa: 424242, conta: 1 }, { unidade: async () => null }), vazio);
  assert.deepEqual(await preenchimentoDaConversa({ modelo: 'timbo_x', corpo: 'Olá, {{1}}', lida: lida('Ana'), caixa: null, conta: 99 }, { unidade: async () => ({ slug: 'x', name: 'x', pixKey: null }) as never }), vazio);
  assert.deepEqual(await preenchimentoDaConversa({ modelo: 'parau_consulta_lembrete_vespera', lida: lida('Ana'), caixa: caixaDeParau, conta: 1 }, { unidade: async () => null }), vazio);
});

test('a unidade NÃO vem do pedido: o corpo do pedido não tem campo de unidade e o valor é o da conversa lida com o login', async () => {
  const r = await preenchimentoDaConversa({ modelo: 'parau_consulta_lembrete_vespera', ...({ slug: 'outra-unidade' } as object), lida: lida('Maria', consulta), caixa: caixaDeParau, conta: 1 }, { unidade: async (slug) => { assert.equal(slug, 'doutor-hernia-parauapebas'); return unitParau as never; } });
  assert.equal(r.origem, 'crm');
});

test('CORS do botão: a rota nova é só POST e só da origem do Chatwoot (com os cabeçalhos do login e o corpo JSON)', () => {
  const origem = 'https://atendimento.doutordigitalconsultoria.com';
  const r = corsDoAssistente('/api/public/assistente/modelo-preenchido', origem, [origem, 'https://drtimbo.doutordigitalconsultoria.com']);
  assert.ok(r);
  assert.deepEqual(r!.methods, ['POST', 'OPTIONS']);
  assert.deepEqual(r!.allowedHeaders, ['X-CW-Token', 'X-CW-Client', 'X-CW-Uid', 'Content-Type']);
  assert.equal(corsDoAssistente('/api/public/assistente/modelo-preenchido', 'https://evil.example', [origem]), null);
  assert.equal(r!.credentials, false);
});

test('a rota exige o login do Chatwoot (sem cabeçalhos = 401, sem tocar em nada)', async () => {
  let status = 0; let corpo: unknown = null;
  const res = { status(n: number) { status = n; return this; }, json(b: unknown) { corpo = b; return this; }, set() { return this; } } as never;
  const req = { query: {}, body: { conversa: 5, modelo: 'parau_x' }, get: () => undefined } as never;
  await assistenteModeloPreenchidoHandler(req, res);
  assert.ok(status === 401 || status === 404, 'status ' + status);
  assert.ok(corpo);
});
