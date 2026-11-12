import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prisma } from '../lib/prisma.js';
import { zerarConversasDeTeste } from '../lib/conversa-de-teste.js';
import { criarConversaHandler, paginaAprendizadosHandler } from './aprendizados.controller.js';
import type { ResultadoDoTeste } from './playground.controller.js';

const SLUG = 'doutor-hernia-timbo';
const unidade = { id: 'u1', slug: SLUG, isActive: true, pausaCodigo: '482913', name: 'Timbó', spineTimezone: 'America/Sao_Paulo' };

function ok(reply: string, actions: Array<{ tool: string; args: Record<string, unknown>; result: string }> = []): ResultadoDoTeste {
  return {
    ok: true,
    reply,
    actions,
    timeline: [{ kind: 'assistant_message', ts: 0, content: reply }],
    meta: { base: 'vivo', model: 'claude-sonnet-5', iterations: 1, totalLatencyMs: 10, tokens: null, costUsd: 0.011 },
  };
}

type Chamada = { unit: unknown; messages: unknown; opts: unknown };

function chamar(
  handler: ReturnType<typeof criarConversaHandler>,
  corpo: unknown,
  { slug = SLUG, ip = '10.0.0.1' }: { slug?: string; ip?: string } = {},
) {
  const out: { status: number; body?: any } = { status: 200 };
  const res = {
    status(c: number) {
      out.status = c;
      return this;
    },
    json(b: unknown) {
      out.body = b;
      return this;
    },
  };
  const req = { params: { slug }, ip, method: 'POST', query: {}, body: corpo };
  return handler(req as never, res as never).then(() => out);
}

const FALA = [{ role: 'user', content: 'Oi, quanto custa a consulta?' }];

let antesUnit: unknown;
let antesEnv: string | undefined;
let antesTeto: string | undefined;
beforeEach(() => {
  antesUnit = (prisma as unknown as { unit: unknown }).unit;
  antesEnv = process.env.APRENDIZADOS_PELA_UNIDADE_SLUGS;
  antesTeto = process.env.APRENDIZADOS_CONVERSA_MAX_POR_DIA;
  process.env.APRENDIZADOS_PELA_UNIDADE_SLUGS = SLUG;
  delete process.env.APRENDIZADOS_CONVERSA_MAX_POR_DIA;
  zerarConversasDeTeste();
  Object.defineProperty(prisma, 'unit', {
    value: { ...(antesUnit as object), findUnique: async (a: { where: { slug: string } }) => (a.where.slug === SLUG ? unidade : null) },
    configurable: true,
  });
});
afterEach(() => {
  Object.defineProperty(prisma, 'unit', { value: antesUnit, configurable: true });
  if (antesEnv === undefined) delete process.env.APRENDIZADOS_PELA_UNIDADE_SLUGS;
  else process.env.APRENDIZADOS_PELA_UNIDADE_SLUGS = antesEnv;
  if (antesTeto === undefined) delete process.env.APRENDIZADOS_CONVERSA_MAX_POR_DIA;
  else process.env.APRENDIZADOS_CONVERSA_MAX_POR_DIA = antesTeto;
  zerarConversasDeTeste();
});

test('conversa: com chave ligada e código certo roda o sandbox, sem leadId, e devolve só a fala e as ações', async () => {
  const chamadas: Chamada[] = [];
  const h = criarConversaHandler(async (unit, messages, opts) => {
    chamadas.push({ unit, messages, opts });
    return ok('Oi! A consulta custa R$ 350.', [{ tool: 'consultar_horarios', args: { data: '13/11/2026' }, result: '[SANDBOX] ...' }]);
  });
  const r = await chamar(h, { codigo: '482913', messages: FALA });
  assert.equal(r.status, 200);
  assert.equal(r.body.reply, 'Oi! A consulta custa R$ 350.');
  assert.deepEqual(r.body.acoes, ['Consultou a agenda (fictícia)']);
  assert.equal(r.body.restantes, 59);
  assert.equal(chamadas.length, 1);
  assert.deepEqual(chamadas[0].messages, [{ role: 'user', content: 'Oi, quanto custa a consulta?' }]);
  // o prompt é o REAL da unidade: sem prompt de teste trocado, sem regra extra (isso é da prévia)
  assert.equal(chamadas[0].opts, undefined);
  // o corpo não vaza a linha do tempo nem modelo/custo
  assert.deepEqual(Object.keys(r.body).sort(), ['acoes', 'reply', 'restantes']);
});

test('conversa: chave desligada = 404, antes de olhar o código (não dá para sondar)', async () => {
  process.env.APRENDIZADOS_PELA_UNIDADE_SLUGS = 'outra-unidade';
  let rodou = 0;
  const h = criarConversaHandler(async () => (rodou++, ok('x')));
  const r = await chamar(h, { codigo: '482913', messages: FALA });
  assert.equal(r.status, 404);
  assert.equal((await chamar(h, { codigo: '000000', messages: FALA })).status, 404, 'código errado também é 404, não 403');
  assert.equal(rodou, 0);
});

test('conversa: código errado ou ausente = 403 e o modelo não roda; 12 erros travam o ip', async () => {
  let rodou = 0;
  const h = criarConversaHandler(async () => (rodou++, ok('x')));
  assert.equal((await chamar(h, { codigo: '000000', messages: FALA }, { ip: '10.9.9.9' })).status, 403);
  assert.equal((await chamar(h, { messages: FALA }, { ip: '10.9.9.9' })).status, 403);
  for (let i = 0; i < 10; i++) await chamar(h, { codigo: '000000', messages: FALA }, { ip: '10.9.9.9' });
  assert.equal((await chamar(h, { codigo: '482913', messages: FALA }, { ip: '10.9.9.9' })).status, 429, 'bloqueado: nem o código certo passa');
  assert.equal(rodou, 0);
});

test('conversa: teto diário por unidade (env) — passou, 429 e o modelo não roda', async () => {
  process.env.APRENDIZADOS_CONVERSA_MAX_POR_DIA = '2';
  let rodou = 0;
  const h = criarConversaHandler(async () => (rodou++, ok('resposta')));
  assert.equal((await chamar(h, { codigo: '482913', messages: FALA })).status, 200);
  const segunda = await chamar(h, { codigo: '482913', messages: FALA });
  assert.equal(segunda.status, 200);
  assert.equal(segunda.body.restantes, 0);
  const terceira = await chamar(h, { codigo: '482913', messages: FALA });
  assert.equal(terceira.status, 429);
  assert.match(terceira.body.error, /acabaram/);
  assert.equal(rodou, 2);
});

test('conversa: se o modelo falha, a resposta volta para o teto dela (erro nosso não gasta)', async () => {
  process.env.APRENDIZADOS_CONVERSA_MAX_POR_DIA = '1';
  let falhar = true;
  const h = criarConversaHandler(async () => (falhar ? { ok: false, status: 500, error: 'playground_failed' } : ok('agora foi')));
  assert.equal((await chamar(h, { codigo: '482913', messages: FALA })).status, 502);
  falhar = false;
  const r = await chamar(h, { codigo: '482913', messages: FALA });
  assert.equal(r.status, 200, 'a tentativa que falhou não consumiu o único lugar do dia');
  // e uma exceção solta também
  zerarConversasDeTeste();
  const quebra = criarConversaHandler(async () => {
    throw new Error('banco caiu');
  });
  assert.equal((await chamar(quebra, { codigo: '482913', messages: FALA })).status, 500);
  assert.equal((await chamar(h, { codigo: '482913', messages: FALA })).status, 200);
});

test('conversa: pedidos ao mesmo tempo — a terceira espera (429) e a vaga volta quando a chamada termina', async () => {
  const liberar: Array<() => void> = [];
  let rodou = 0;
  const h = criarConversaHandler(
    () =>
      new Promise<ResultadoDoTeste>((fim) => {
        rodou++;
        liberar.push(() => fim(ok('ok')));
      }),
  );
  const a = chamar(h, { codigo: '482913', messages: FALA });
  const b = chamar(h, { codigo: '482913', messages: FALA });
  await new Promise((r) => setTimeout(r, 20));
  const c = await chamar(h, { codigo: '482913', messages: FALA });
  assert.equal(c.status, 429);
  assert.equal(rodou, 2, 'a terceira nem chegou ao modelo');
  liberar.forEach((f) => f());
  assert.equal((await a).status, 200);
  assert.equal((await b).status, 200);
  const d = chamar(h, { codigo: '482913', messages: FALA });
  await new Promise((r) => setTimeout(r, 20));
  liberar[2]?.();
  assert.equal((await d).status, 200, 'a vaga voltou');
});

test('conversa: histórico longo é encurtado antes do modelo, e o que não termina no paciente é 400', async () => {
  const vistas: number[] = [];
  const h = criarConversaHandler(async (_u, messages) => (vistas.push(messages.length), ok('ok')));
  const longa = Array.from({ length: 120 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `fala ${i}` }));
  longa.push({ role: 'user', content: 'e agora?' });
  assert.equal((await chamar(h, { codigo: '482913', messages: longa })).status, 200);
  assert.ok(vistas[0] <= 40, `o modelo recebeu ${vistas[0]} falas`);
  assert.equal((await chamar(h, { codigo: '482913', messages: [{ role: 'assistant', content: 'oi' }] })).status, 400);
  assert.equal((await chamar(h, { codigo: '482913', messages: [{ role: 'user', content: 'x'.repeat(601) }] })).status, 400);
  assert.equal((await chamar(h, { codigo: '482913' })).status, 400);
  assert.equal(vistas.length, 1);
});

test('sandbox: o núcleo que a conversa usa não importa Kommo, franquia, Asaas, WhatsApp nem grava conversa/trace de paciente', () => {
  const fonte = readFileSync(new URL('./playground.controller.ts', import.meta.url), 'utf8');
  const imports = fonte.split('\n').filter((l) => /^\s*(import|\}\s*from)\b/.test(l) || /from '/.test(l));
  const proibido = /kommo|franquia|spine|asaas|whatsapp|evolution|zapi|telegram|conversation|trace|webhook|n8n/i;
  for (const l of imports) assert.ok(!proibido.test(l), `o sandbox passou a importar algo de produção: ${l.trim()}`);
  // todas as ferramentas do sandbox se anunciam como simuladas
  const corpos = fonte.slice(fonte.indexOf('function buildSandboxTools'), fonte.indexOf('export type ResultadoDoTeste'));
  const funcs = corpos.match(/func: async/g)?.length ?? 0;
  const simuladas = corpos.match(/\[SANDBOX\]/g)?.length ?? 0;
  assert.ok(funcs >= 12 && simuladas >= funcs, `${simuladas} resultados [SANDBOX] para ${funcs} ferramentas`);
  // a conversa nunca passa leadId ao montar o prompt: sem cartão, sem franquia, sem memória de paciente real
  assert.ok(!/leadId:\s*[^,}\n]*\bcomposeSystemPromptForUnit\b/.test(fonte));
  const compose = fonte.slice(fonte.indexOf('composeSystemPromptForUnit({'), fonte.indexOf('const sandboxPreamble'));
  assert.ok(!/leadId/.test(compose), 'composeSystemPromptForUnit no sandbox não pode receber leadId');
  assert.ok(/traceId: null/.test(fonte), 'a chamada ao modelo do sandbox não pertence a nenhum trace');
});

test('a página: tem a aba de conversa, avisa que é teste, guarda o histórico só no navegador e o script compila', async () => {
  const saida: { html?: string; status: number } = { status: 200 };
  const res = {
    status(c: number) {
      saida.status = c;
      return this;
    },
    type() {
      return this;
    },
    send(h: string) {
      saida.html = h;
      return this;
    },
  };
  const antes = (prisma as unknown as { unit: Record<string, unknown> }).unit;
  Object.defineProperty(prisma, 'unit', {
    value: { ...antes, findUnique: async () => ({ name: 'Timbó <b>', isActive: true }) },
    configurable: true,
  });
  await paginaAprendizadosHandler({ params: { slug: SLUG } } as never, res as never);
  const html = saida.html ?? '';
  assert.equal(saida.status, 200);
  assert.ok(html.includes('Conversar com a Sofia (teste)'));
  assert.ok(html.includes('nada é enviado a paciente'));
  assert.ok(html.includes('meta name="viewport"'), 'mobile primeiro');
  const script = html.split('<script>')[1].split('</script>')[0];
  assert.doesNotThrow(() => new Function(script), 'o JavaScript da página tem erro de sintaxe');
  assert.ok(!script.includes('innerHTML'), 'fala de paciente só entra na tela por textContent');
  assert.ok(script.includes("'/conversa'") && script.includes("localStorage.setItem(KH,"));
  // as regex do script chegam inteiras (\\s no código-fonte vira \s na página)
  assert.ok(script.includes('/\\s+/g') && script.includes("'\\n'"), 'barra invertida do template comida');
  // o texto da conversa nunca vai para a URL
  assert.ok(!/conversa[^\n]*\?codigo=/.test(script));
});

test('a página: chave desligada = 404, sem mostrar a aba', async () => {
  process.env.APRENDIZADOS_PELA_UNIDADE_SLUGS = 'outra-unidade';
  const saida: { html?: string; status: number } = { status: 200 };
  const res = {
    status(c: number) {
      saida.status = c;
      return this;
    },
    type() {
      return this;
    },
    send(h: string) {
      saida.html = h;
      return this;
    },
  };
  await paginaAprendizadosHandler({ params: { slug: SLUG } } as never, res as never);
  assert.equal(saida.status, 404);
  assert.ok(!(saida.html ?? '').includes('Conversar'));
});
