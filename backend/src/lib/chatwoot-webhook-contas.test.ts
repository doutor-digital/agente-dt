/**
 * A chave `?k=` dos webhooks é POR CONTA (derivada do token da conta): quem tem a chave de uma clínica não forja evento de outra, nem de Parauapebas.
 * Antes, a chave vinha do token global e valia para qualquer conta.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://x:y@127.0.0.1:1/z';
process.env.SESSION_JWT_SECRET ??= 'segredo-de-teste-com-mais-de-32-caracteres-ok';

const IA = await import('./chatwoot-ia.js');
const Lida = await import('./chatwoot-lida.js');
const U = await import('./chatwoot-unidades.js');
const C = await import('../mcp-remoto/chatwoot.js');

const DEMO = {
  slug: 'clinica-demonstracao',
  contaId: 2,
  prefixoModelos: 'demo_',
  usuarioCelularId: 77,
  gerenteId: 51,
  metaAgendamentosDia: 5,
  kapsoPhoneNumberId: null,
  wabaId: null,
  envSufixo: 'DEMO',
  dadosModelos: { nome: 'Clínica Demonstração', cidade: 'Demonstração', endereco: 'Rua Exemplo, 100 — Centro, Demonstração/PA', mapa: 'https://maps.example/demo' },
  caixas: [{ id: 20, tipo: 'cloud' as const }, { id: 21, tipo: 'evolution' as const, instanciaEvolution: 'demo-unidade' }],
};
const AMB = { CHATWOOT_API_TOKEN: 'tk-do-ambiente', CHATWOOT_CONTA_ID: '1', CHATWOOT_URL: 'https://crm.exemplo.test' };
const SALVO = { ...process.env };

function preparar(comTokenProprio = true) {
  Object.assign(process.env, AMB);
  if (comTokenProprio) process.env.CHATWOOT_API_TOKEN_DEMO = 'tk-so-da-demo';
  else delete process.env.CHATWOOT_API_TOKEN_DEMO;
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO as never]);
  C.esquecerContextoDoAmbiente();
  IA.esquecerEstadosDaIa();
  Lida.esquecerPortasDaLida();
}
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SALVO)) delete process.env[k];
  Object.assign(process.env, SALVO);
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS]);
  C.esquecerContextoDoAmbiente();
});

function chamar(handler: (req: never, res: never) => void, query: Record<string, unknown>, body: unknown): { status: number } {
  const r = { status: 200 };
  const res = { status: (n: number) => ((r.status = n), { json: () => undefined }), json: () => undefined };
  handler({ query, body } as never, res as never);
  return r;
}
const evento = (conta: number | undefined, caixa: number | undefined) => ({ event: 'conversation_visibility_changed', ...(conta ? { account: { id: conta } } : {}), ...(caixa ? { conversation: { id: 5, inbox_id: caixa } } : {}) });
const chaveAmb = () => IA.chaveDoEvento(AMB.CHATWOOT_API_TOKEN);
const chaveDemo = () => IA.chaveDoEvento('tk-so-da-demo');

test('IDENTIDADE: Parauapebas segue igual — a chave do ambiente vale para eventos da conta 1 (com e sem `account`/caixa); chave errada é 401', () => {
  preparar();
  assert.equal(chamar(IA.eventoChatwootHandler, { k: chaveAmb() }, evento(1, 3)).status, 200);
  assert.equal(chamar(IA.eventoChatwootHandler, { k: chaveAmb() }, evento(undefined, 3)).status, 200);
  assert.equal(chamar(IA.eventoChatwootHandler, { k: chaveAmb() }, evento(undefined, undefined)).status, 200);
  assert.equal(chamar(IA.eventoChatwootHandler, { k: 'x'.repeat(32) }, evento(1, 3)).status, 401);
  assert.equal(chamar(IA.eventoChatwootHandler, {}, evento(1, 3)).status, 401);
});

test('ATAQUE: a chave de Parauapebas NÃO forja evento da clínica (conta 2, por `account` ou só pela caixa); a da clínica não forja Parauapebas', () => {
  preparar();
  assert.equal(chamar(IA.eventoChatwootHandler, { k: chaveAmb() }, evento(2, 20)).status, 401);
  assert.equal(chamar(IA.eventoChatwootHandler, { k: chaveAmb() }, evento(undefined, 20)).status, 401, 'sem `account`, só a caixa da clínica');
  assert.equal(chamar(IA.eventoChatwootHandler, { k: chaveAmb() }, evento(2, undefined)).status, 401);
  assert.equal(chamar(IA.eventoChatwootHandler, { k: chaveDemo() }, evento(2, 20)).status, 200, 'a chave da própria clínica vale');
  assert.equal(chamar(IA.eventoChatwootHandler, { k: chaveDemo() }, evento(1, 3)).status, 401, 'a da clínica não vale para Parauapebas');
  assert.equal(chamar(IA.eventoChatwootHandler, { k: chaveDemo() }, evento(undefined, 3)).status, 401);
});

test('conta que o servidor não conhece: só a chave do ambiente passa (e o evento é ignorado); a da clínica não', () => {
  preparar();
  assert.equal(chamar(IA.eventoChatwootHandler, { k: chaveDemo() }, evento(99, 3)).status, 401);
  assert.equal(chamar(IA.eventoChatwootHandler, { k: chaveAmb() }, evento(99, 3)).status, 200);
});

test('clínica SEM token próprio (cairia no global): nenhuma chave vale para a conta dela — nem a de Parauapebas', () => {
  preparar(false);
  assert.equal(chamar(IA.eventoChatwootHandler, { k: chaveAmb() }, evento(2, 20)).status, 401);
  assert.equal(chamar(IA.eventoChatwootHandler, { k: chaveDemo() }, evento(2, 20)).status, 401);
});

test('LIDA (Evolution): a chave é da conta da caixa da instância — a de Parauapebas não vale para a instância da clínica', () => {
  preparar();
  const aviso = (instancia: string) => ({ event: 'messages.update', instance: instancia, data: { key: { remoteJid: '5594999990000@s.whatsapp.net', fromMe: true }, status: 'READ' } });
  const chaveLida = (t: string) => Lida.chaveDaLida(t);
  assert.equal(chamar(Lida.lidaEvolutionHandler, { k: chaveLida(AMB.CHATWOOT_API_TOKEN) }, aviso('parauapebas-unidade')).status, 200, 'Parauapebas igual a antes');
  assert.equal(chamar(Lida.lidaEvolutionHandler, { k: chaveLida(AMB.CHATWOOT_API_TOKEN) }, aviso('demo-unidade')).status, 401);
  assert.equal(chamar(Lida.lidaEvolutionHandler, { k: chaveLida('tk-so-da-demo') }, aviso('demo-unidade')).status, 200);
  assert.equal(chamar(Lida.lidaEvolutionHandler, { k: chaveLida('tk-so-da-demo') }, aviso('parauapebas-unidade')).status, 401);
  // instância desconhecida e corpo torto: só a chave do ambiente (como sempre)
  assert.equal(chamar(Lida.lidaEvolutionHandler, { k: chaveLida(AMB.CHATWOOT_API_TOKEN) }, aviso('ninguem')).status, 200);
  assert.equal(chamar(Lida.lidaEvolutionHandler, { k: chaveLida('tk-so-da-demo') }, aviso('ninguem')).status, 401);
  assert.equal(chamar(Lida.lidaEvolutionHandler, { k: chaveLida(AMB.CHATWOOT_API_TOKEN) }, { lixo: true }).status, 200);
  // outro evento da MESMA instância da clínica (não é leitura) também precisa da chave da clínica — e passa com ela
  const entrega = { event: 'messages.update', instance: 'demo-unidade', data: { status: 'DELIVERY_ACK' } };
  assert.equal(chamar(Lida.lidaEvolutionHandler, { k: chaveLida('tk-so-da-demo') }, entrega).status, 200);
  assert.equal(chamar(Lida.lidaEvolutionHandler, { k: chaveLida(AMB.CHATWOOT_API_TOKEN) }, entrega).status, 401);
});
