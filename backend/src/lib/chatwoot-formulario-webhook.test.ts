/**
 * Origem «Formulário» pelo webhook de verdade (webhook → portas → chamadas ao Chatwoot): o texto pronto do formulário, sem referral,
 * vira Origem = «Formulário» + etiqueta; contato com origem de anúncio nunca é tocado; sem chave da unidade (Parauapebas hoje) não toca em nada.
 */
import { test, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const IA = await import('./chatwoot-ia.js');
const C = await import('../mcp-remoto/chatwoot.js');
const { limparCacheDoFormulario } = await import('./chatwoot-origem.js');
const { prisma } = await import('./prisma.js');
const { _esquecerOBancoParaTeste } = await import('./automacoes-estado.js');

const ENV = { CHATWOOT_API_TOKEN: 'tk-do-ambiente', CHATWOOT_CONTA_ID: '1', CHATWOOT_URL: 'https://crm.exemplo.test' } as NodeJS.ProcessEnv;
const CHAVES = [...Object.keys(ENV), 'CHATWOOT_FORMULARIO_SLUGS'];
const salvo = new Map(CHAVES.map((k) => [k, process.env[k]]));
/** Troca um delegate do Prisma por um de mentira (o delegate é um proxy) e desfaz no fim de cada teste. Nada aqui chega ao banco de verdade. */
const originais: Array<() => void> = [];
function trocarDelegate(nome: string, falso: Record<string, unknown>): void {
  const antes = (prisma as any)[nome];
  Object.defineProperty(prisma, nome, { value: falso, configurable: true, writable: true });
  originais.push(() => Object.defineProperty(prisma, nome, { value: antes, configurable: true, writable: true }));
}
beforeEach(() => {
  _esquecerOBancoParaTeste();
  trocarDelegate('unitAutomacao', { findMany: async () => [] });
  trocarDelegate('unit', { findUnique: async () => ({ pipelineIntents: null }) });
  trocarDelegate('systemLog', { create: async () => ({}) });
});
afterEach(() => {
  while (originais.length) originais.pop()!();
  _esquecerOBancoParaTeste();
  for (const [k, v] of salvo) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  IA.esquecerEstadosDaIa();
  C.esquecerContextoDoAmbiente();
  limparCacheDoFormulario();
});

const TEXTO = 'Olá! Meu nome é Ana, moro em Capivari e estou com dor na coluna. Vim pelo formulário e quero saber mais.';

function chatwootDeMentira(contato: Record<string, unknown>, opcoesOrigem: string[] = ['Meta Ads', 'Formulário']) {
  const escritas: string[] = [];
  const f = (async (url: string, o: { method?: string; body?: string } = {}) => {
    const u = new URL(url);
    const metodo = o.method ?? 'GET';
    const caminho = u.pathname.replace('/api/v1/accounts/1/', '');
    const r = (j: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) }) as Response;
    if (metodo !== 'GET') escritas.push(`${metodo} ${caminho} ${o.body ?? ''}`);
    if (metodo === 'GET' && caminho === 'contacts/77') return r({ payload: { custom_attributes: contato } });
    if (metodo === 'GET' && caminho === 'conversations/5/messages') return r({ payload: [{ message_type: 0, private: false, content: TEXTO }] });
    if (metodo === 'GET' && caminho === 'custom_attribute_definitions') return r([{ attribute_key: 'origem', attribute_values: opcoesOrigem }]);
    if (metodo === 'GET' && caminho === 'conversations/5') return r({ id: 5, status: 'open', labels: ['anuncio-nao'], meta: { sender: {} }, custom_attributes: {} });
    return r({});
  }) as unknown as typeof fetch;
  return { escritas, f };
}

const resp = () => ({ json: () => undefined, status: () => ({ json: () => undefined }) }) as never;
const disparar = async (corpo: unknown) => {
  IA.eventoChatwootHandler({ query: { k: IA.chaveDoEvento(ENV.CHATWOOT_API_TOKEN!) }, body: corpo } as never, resp());
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};
const paciente = { event: 'message_created', message_type: 'incoming', private: false, content: TEXTO, conversation: { id: 5, inbox_id: 3 }, content_attributes: {}, sender: { id: 77, type: 'contact' } };

test('webhook: chave da unidade LIGADA + texto do formulário → contato ganha Origem = Formulário e a conversa a etiqueta', async () => {
  Object.assign(process.env, ENV, { CHATWOOT_FORMULARIO_SLUGS: 'doutor-hernia-parauapebas' });
  const w = chatwootDeMentira({});
  const f = mock.method(globalThis, 'fetch', w.f as never);
  try {
    await disparar(paciente);
    assert.ok(w.escritas.some((l) => l.startsWith('PUT contacts/77') && l.includes('"origem":"Formulário"')), w.escritas.join(' | '));
    assert.ok(w.escritas.some((l) => l.startsWith('POST conversations/5/labels') && l.includes('formulario')), 'etiqueta formulario');
  } finally {
    f.mock.restore();
  }
});

test('webhook: contato JÁ com origem de anúncio → nada é escrito', async () => {
  Object.assign(process.env, ENV, { CHATWOOT_FORMULARIO_SLUGS: 'doutor-hernia-parauapebas' });
  const w = chatwootDeMentira({ origem: 'Meta Ads' });
  const f = mock.method(globalThis, 'fetch', w.f as never);
  try {
    await disparar(paciente);
    assert.deepEqual(w.escritas.filter((l) => l.includes('contacts/77') || l.includes('labels')), []);
  } finally {
    f.mock.restore();
  }
});

test('webhook: SEM chave da unidade (como Parauapebas hoje) → não lê nem escreve nada por causa do formulário', async () => {
  Object.assign(process.env, ENV);
  delete process.env.CHATWOOT_FORMULARIO_SLUGS;
  const w = chatwootDeMentira({});
  const f = mock.method(globalThis, 'fetch', w.f as never);
  try {
    await disparar(paciente);
    assert.deepEqual(w.escritas.filter((l) => l.includes('contacts/77') || l.includes('labels')), []);
  } finally {
    f.mock.restore();
  }
});
