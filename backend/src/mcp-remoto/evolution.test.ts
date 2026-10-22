import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  confirmar,
  contaEvolutionDoAmbiente,
  criarContextoEvolution,
  grupos,
  LIMITES_EVOLUTION,
  normalizarNumero,
  preparar,
  registrarFerramentasEvolution,
  rotaDeLeitura,
} from './evolution.js';

// O WhatsApp da Suzanne pelo claude.ai (22/10/2026): token DA INSTÂNCIA, leitura direta, envio em dois passos.

const CONTA = { url: 'https://evo.test', instancia: 'Suzanne - Relatorios', chave: 'TOKEN-INST' };
const DIA = Date.parse('2026-10-22T18:00:00Z'); // 15:00 em Brasília
const NOITE = Date.parse('2026-10-23T01:30:00Z'); // 22:30 em Brasília

function falso(respostas: Record<string, unknown> = {}, demora = 0) {
  const chamadas: Array<{ url: string; metodo: string; corpo: any; chave: string }> = [];
  const buscar = (async (url: string, init: any) => {
    chamadas.push({ url, metodo: init.method, corpo: init.body ? JSON.parse(init.body) : null, chave: init.headers.apikey });
    if (demora) await new Promise((r) => setTimeout(r, demora));
    const k = Object.keys(respostas).find((x) => url.includes(x));
    return { ok: true, status: 200, text: async () => JSON.stringify(k ? respostas[k] : { ok: true }) };
  }) as unknown as typeof globalThis.fetch;
  return { fetch: buscar, chamadas };
}
const ctx = (f: ReturnType<typeof falso>, agora = () => DIA) => criarContextoEvolution(CONTA, { fetch: f.fetch, agora });

test('conta: sem instância ou token no ambiente, nada liga', () => {
  assert.equal(contaEvolutionDoAmbiente({}), null);
  assert.equal(contaEvolutionDoAmbiente({ MCP_EVOLUTION_INSTANCIA: 'x' }), null);
  assert.deepEqual(contaEvolutionDoAmbiente({ MCP_EVOLUTION_INSTANCIA: 'Suzanne - Relatorios', MCP_EVOLUTION_TOKEN: 't' }), {
    url: 'https://evolution.doutordigitalconsultoria.com',
    instancia: 'Suzanne - Relatorios',
    chave: 't',
  });
});

test('número: máscara vira DDI+DDD; JID passa', () => {
  assert.equal(normalizarNumero('+55 63 8141-1248'), '556381411248');
  assert.equal(normalizarNumero('(63) 98141-1248'), '5563981411248');
  assert.equal(normalizarNumero('120363338386986419@g.us'), '120363338386986419@g.us');
  assert.throws(() => normalizarNumero('1234'), /inválido/);
});

test('preparar não chama a API; confirmar manda com "digitando" e a instância codificada no caminho', async () => {
  const f = falso();
  const c = ctx(f);
  const p = preparar(c, 'u1', 'texto', { para: '63 98141-1248', texto: 'Oi' });
  assert.equal(f.chamadas.length, 0);
  assert.equal(p.aviso, null);
  await confirmar(c, 'u1', p.codigo);
  assert.equal(f.chamadas[0].url, 'https://evo.test/message/sendText/Suzanne%20-%20Relatorios');
  assert.equal(f.chamadas[0].chave, 'TOKEN-INST');
  assert.equal(f.chamadas[0].corpo.number, '5563981411248');
  assert.ok(f.chamadas[0].corpo.delay >= 1200 && f.chamadas[0].corpo.delay <= 3000);
});

test('o código é de quem preparou e vale uma vez', async () => {
  const c = ctx(falso());
  const { codigo } = preparar(c, 'u1', 'texto', { para: '5563981411248', texto: 'Oi' });
  await assert.rejects(() => confirmar(c, 'u2', codigo), /outro usuário/);
  // a tentativa do outro usuário não queima o código do dono
  const { codigo: c2 } = preparar(c, 'u1', 'texto', { para: '5563981411248', texto: 'Oi' });
  await confirmar(c, 'u1', c2);
  await assert.rejects(() => confirmar(c, 'u1', c2), /desconhecido ou já usado/);
});

test('à noite não sai (anti-ban) — e o preparar já avisa', async () => {
  const f = falso();
  const c = ctx(f, () => NOITE);
  const p = preparar(c, 'u1', 'texto', { para: '5563981411248', texto: 'Oi' });
  assert.match(String(p.aviso), /silêncio/);
  await assert.rejects(() => confirmar(c, 'u1', p.codigo), /silêncio/);
  assert.equal(f.chamadas.length, 0);
});

test('teto por hora, mesmo com confirmações juntas', async () => {
  const f = falso();
  const c = ctx(f);
  for (let i = 0; i < LIMITES_EVOLUTION.porHora - 1; i++) await confirmar(c, 'u1', preparar(c, 'u1', 'texto', { para: '5563981411248', texto: `m${i}` }).codigo);
  const a = preparar(c, 'u1', 'texto', { para: '5563981411248', texto: 'a' }).codigo;
  const b = preparar(c, 'u1', 'texto', { para: '5563981411248', texto: 'b' }).codigo;
  const r = await Promise.allSettled([confirmar(c, 'u1', a), confirmar(c, 'u1', b)]);
  assert.deepEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(f.chamadas.length, LIMITES_EVOLUTION.porHora);
});

test('mexer em grupo também é em dois passos, mas não conta no teto nem para à noite', async () => {
  const f = falso();
  const c = ctx(f, () => NOITE);
  const { codigo } = preparar(c, 'u1', 'grupo_participantes', { grupo: '120363338386986419@g.us', participantes: ['63981411248'], acao: 'add' });
  await confirmar(c, 'u1', codigo);
  assert.equal(f.chamadas[0].url, 'https://evo.test/group/updateParticipant/Suzanne%20-%20Relatorios?groupJid=120363338386986419%40g.us');
  assert.deepEqual(f.chamadas[0].corpo, { action: 'add', participants: ['5563981411248'] });
});

test('rota avulsa: só leitura, caminho inteiro, método da rota', async () => {
  const f = falso();
  const c = ctx(f);
  await rotaDeLeitura(c, '/chat/findStatusMessage', {});
  await rotaDeLeitura(c, '/group/participants', { ignorado: 1 }, { groupJid: '1@g.us' });
  assert.equal(f.chamadas[0].metodo, 'POST');
  assert.equal(f.chamadas[1].metodo, 'GET');
  assert.equal(f.chamadas[1].corpo, null);
  for (const r of ['/instance/delete', 'instance/logout', '/webhook/set', '/message/sendText', '/business/updateCatalog', '/chat/findChats/../../instance/delete']) {
    assert.throws(() => rotaDeLeitura(c, r), /bloqueada|só rota de leitura/, r);
  }
});

test('grupos: guarda a lista; enquanto o WhatsApp monta, quem pede ouve "tente em 1 minuto" e a busca segue', async () => {
  const antes = LIMITES_EVOLUTION.esperaGruposMs;
  LIMITES_EVOLUTION.esperaGruposMs = 20;
  try {
    const f = falso({ '/group/fetchAllGroups': [{ id: '1@g.us', subject: 'Mkt | Dr Hérnia Serra', size: 14 }, { id: '2@g.us', subject: 'Família', size: 5 }] }, 60);
    const c = ctx(f);
    await assert.rejects(() => grupos(c, {}), /peça de novo em 1 minuto/);
    await new Promise((r) => setTimeout(r, 80));
    const r = await grupos(c, { busca: 'mkt' });
    assert.deepEqual(r, { total: 1, mostrando: 1, grupos: [{ grupo: '1@g.us', nome: 'Mkt | Dr Hérnia Serra', membros: 14 }] });
    assert.equal(f.chamadas.length, 1, 'a 2ª pergunta usou a lista guardada');
  } finally {
    LIMITES_EVOLUTION.esperaGruposMs = antes;
  }
});

async function conectar(contexto: ReturnType<typeof criarContextoEvolution>, usuario: string) {
  const server = new McpServer({ name: 't', version: '0' });
  registrarFerramentasEvolution(server, contexto, usuario, () => undefined);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const cliente = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(a), cliente.connect(b)]);
  return cliente;
}
const texto = (r: any) => String(r.content?.[0]?.text ?? '');

test('pelo protocolo: sem conta não há ferramenta; com conta, preparar → confirmar funciona e o código não serve a outro usuário', async () => {
  const semConta = new McpServer({ name: 't', version: '0' });
  registrarFerramentasEvolution(semConta, criarContextoEvolution(null), 'u1', () => undefined);
  const [x, y] = InMemoryTransport.createLinkedPair();
  const cli0 = new Client({ name: 'teste', version: '0' });
  await Promise.all([semConta.connect(x), cli0.connect(y)]).catch(() => undefined);
  const lista0 = await cli0.listTools().catch(() => ({ tools: [] }));
  assert.equal(lista0.tools.length, 0);

  const f = falso();
  const c = ctx(f);
  const joao = await conectar(c, 'u-joao');
  const nomes = (await joao.listTools()).tools.map((t) => t.name);
  for (const n of ['evo_conversas', 'evo_grupos', 'evo_preparar', 'evo_confirmar']) assert.ok(nomes.includes(n), n);
  assert.ok(!nomes.some((n) => /delete|logout|webhook/.test(n)));

  const prep = JSON.parse(texto(await joao.callTool({ name: 'evo_preparar', arguments: { tipo: 'texto', para: '63 98141-1248', texto: 'Bom dia' } })));
  assert.equal(f.chamadas.length, 0);
  const outro = await conectar(c, 'u-outro');
  const r1 = await outro.callTool({ name: 'evo_confirmar', arguments: { codigo: prep.codigo } });
  assert.equal(r1.isError, true);
  assert.match(texto(r1), /outro usuário/);
  const prep2 = JSON.parse(texto(await joao.callTool({ name: 'evo_preparar', arguments: { tipo: 'texto', para: '63 98141-1248', texto: 'Bom dia' } })));
  const r2 = await joao.callTool({ name: 'evo_confirmar', arguments: { codigo: prep2.codigo } });
  assert.notEqual(r2.isError, true);
  assert.equal(f.chamadas.length, 1);
  assert.equal(f.chamadas[0].corpo.text, 'Bom dia');
});

test('JID fora do formato do WhatsApp e ação de grupo desconhecida não passam (achados do Codex)', () => {
  const c = ctx(falso());
  for (const j of ['fulano@gmail.com', '123@g.us.evil', 'abc@s.whatsapp.net', '@g.us']) {
    assert.throws(() => preparar(c, 'u1', 'texto', { para: j, texto: 'Oi' }), /JID inválido/, j);
  }
  assert.doesNotThrow(() => preparar(c, 'u1', 'texto', { para: '5563981411248@s.whatsapp.net', texto: 'Oi' }));
  assert.throws(() => preparar(c, 'u1', 'grupo_participantes', { grupo: '120363338386986419@g.us', participantes: ['63981411248'], acao: 'apagar' }), /inválida/);
});
