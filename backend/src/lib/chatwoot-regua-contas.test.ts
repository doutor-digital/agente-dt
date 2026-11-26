/**
 * Passo 3a (régua): cada CAIXA usa o Chatwoot da conta dela. Identidade de Parauapebas: com a clínica na conta do ambiente, a régua faz EXATAMENTE
 * as mesmas chamadas ao Chatwoot e as mesmas gravações no banco, na mesma ordem e com os mesmos tetos, que fazia com o contexto único.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
// o ambiente do Chatwoot do servidor (o contexto de cada caixa nasce DELE): mesmo token, mesma URL, conta 1
process.env.CHATWOOT_API_TOKEN = 'tk-do-ambiente';
process.env.CHATWOOT_CONTA_ID = '1';
process.env.CHATWOOT_URL = 'https://crm.exemplo.test';

const W = await import('./chatwoot-regua-worker.js');
const U = await import('./chatwoot-unidades.js');
const C = await import('../mcp-remoto/chatwoot.js');
const { estadoDoAmbiente } = await import('./automacoes-estado.js');

const SLUG_PARAU = U.SEMENTE_PARAUAPEBAS.slug;
const unix = (s: string) => Math.floor(new Date(s).getTime() / 1000);
const DADOS = { nome: 'Doutor Hérnia Parauapebas', pixKey: 'pix@parau.com', valorAntecipado: 250 };
const CONSULTA = { etapa: 'Agendado', situacao_consulta: 'Agendado', data_consulta: '2026-11-17', hora_consulta: '14:30' };
const PARTIDA = new Date('2026-11-16T17:20:00Z');
const VESPERA = new Date('2026-11-16T17:30:00Z');

afterEach(() => U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS]));

const bruta = (id: number) => ({
  id,
  created_at: unix('2026-10-01T12:00:00Z'),
  labels: [],
  custom_attributes: CONSULTA,
  meta: { sender: { name: 'Maria da Silva', phone_number: `+55949${String(90000000 + id).slice(-8)}` }, assignee: { name: 'Ana' } },
  last_non_activity_message: null,
});

/** Um Chatwoot de mentira (só o que a régua toca) e o armazém de mentira, os dois escrevendo no MESMO registro, na ordem em que acontecem. */
function cenario(total: number) {
  const log: string[] = [];
  const lista = Array.from({ length: total }, (_, i) => bruta(100 + i));
  const fetchFalso = (async (url: string, o: { method?: string; body?: string } = {}) => {
    const u = new URL(url);
    const metodo = o.method ?? 'GET';
    log.push(`${metodo} ${u.pathname}${u.search}${o.body ? ` ${o.body}` : ''}`);
    if (metodo === 'GET' && u.pathname.endsWith('/conversations')) {
      const pagina = Number(u.searchParams.get('page') ?? '1');
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { payload: lista.slice((pagina - 1) * 25, pagina * 25) } }) } as Response;
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ payload: [] }) } as Response;
  }) as unknown as typeof fetch;
  const vistos: Array<{ conversationId: number; campo: string; valor: string; desde: Date; inicial: boolean }> = [];
  const feitos: Array<{ conversationId: number; regra: string; chave: string; modo: string }> = [];
  const armazem: import('./chatwoot-regua-worker.js').Armazem = {
    async vistos() {
      return vistos.map((v) => ({ ...v }));
    },
    async salvar(caixa, mudancas) {
      log.push(`salvar caixa=${caixa} ${mudancas.length} mudança(s): ${mudancas.map((m) => `${m.conversationId}:${m.campo}:${m.tipo}`).join(',')}`);
      for (const m of mudancas) if (m.tipo !== 'remover') vistos.push({ conversationId: m.conversationId, campo: m.campo, valor: (m as { valor: string }).valor, desde: (m as { desde: Date }).desde, inicial: (m as { inicial?: boolean }).inicial ?? false });
    },
    async feitos(caixa) {
      log.push(`feitos caixa=${caixa}`);
      return feitos.map((f) => ({ ...f }));
    },
    async registrar(l) {
      log.push(`registrar caixa=${l.caixa} conversa=${l.conversationId} ${l.regra} ${l.chave} ${l.modo}`);
      if (feitos.some((f) => f.conversationId === l.conversationId && f.regra === l.regra && f.chave === l.chave)) return false;
      feitos.push({ conversationId: l.conversationId, regra: l.regra, chave: l.chave, modo: l.modo });
      return true;
    },
    async desfazer(conversationId, regra, chave, caixa) {
      log.push(`desfazer caixa=${caixa} conversa=${conversationId} ${regra} ${chave}`);
    },
  };
  return { log, fetchFalso, armazem };
}

/** Os dois ciclos (a partida e a véspera) numa caixa, com o `chat` que a função de montagem devolve. */
async function rodar(total: number, caixa: number, slug: string, contaDoAmbiente: number, montarChat: (ctx: import('../mcp-remoto/chatwoot.js').ContextoChatwoot) => import('./chatwoot-regua-worker.js').Chat) {
  const c = cenario(total);
  const ctx = C.criarContextoChatwoot({ url: 'https://crm.exemplo.test', conta: contaDoAmbiente, token: 'tk-do-ambiente' }, { fetch: c.fetchFalso });
  const deps = { armazem: c.armazem, chat: montarChat(ctx), pausa: async () => undefined };
  await W.cicloDaCaixa(deps, caixa, slug, 'ligado', DADOS, PARTIDA);
  await W.cicloDaCaixa(deps, caixa, slug, 'ligado', DADOS, VESPERA);
  return c.log;
}

test('IDENTIDADE: com Parauapebas na conta do ambiente, a régua faz as MESMAS chamadas e gravações, na mesma ordem e com o mesmo teto (60 mensagens por ciclo)', async () => {
  const total = W.MAX_MENSAGENS_POR_CICLO + 10;
  const antes = await rodar(total, 2, SLUG_PARAU, 1, (ctx) => W.chatDoChatwoot(ctx)); // como era: um contexto só
  const depois = await rodar(total, 2, SLUG_PARAU, 1, (ctx) => W.chatDaCaixa(ctx, 2)!); // como é: o Chatwoot da caixa
  assert.deepEqual(depois, antes);
  const mensagens = depois.filter((l) => l.startsWith('POST') && l.includes('/messages'));
  assert.equal(mensagens.length, W.MAX_MENSAGENS_POR_CICLO, 'o teto de mensagens por ciclo é o de sempre');
  assert.ok(depois.every((l) => !l.includes('/accounts/2/')), 'nada saiu para outra conta');
  assert.ok(depois.some((l) => l.includes('/accounts/1/conversations?')), 'a listagem foi na conta 1');
  assert.ok(depois.length > 100, `o cenário é grande o bastante para valer (${depois.length} registros)`);
});

test('a caixa de Parauapebas continua na conta do ambiente mesmo com outra clínica cadastrada em outra conta', async () => {
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO]);
  const antes = await rodar(12, 2, SLUG_PARAU, 1, (ctx) => W.chatDoChatwoot(ctx));
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO]);
  const depois = await rodar(12, 2, SLUG_PARAU, 1, (ctx) => W.chatDaCaixa(ctx, 2)!);
  assert.deepEqual(depois, antes);
});

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
  caixas: [{ id: 20, tipo: 'evolution', instanciaEvolution: 'demo-unidade' }],
};

test('clínica de conta própria: a régua dela lê e escreve NA CONTA 2 (nunca na 1), com os mesmos tetos, e grava o registro com a caixa dela', async () => {
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO]);
  const total = W.MAX_MENSAGENS_POR_CICLO + 10;
  const log = await rodar(total, 20, 'clinica-demonstracao', 1, (ctx) => W.chatDaCaixa(ctx, 20)!);
  const http = log.filter((l) => /^(GET|POST) /.test(l));
  assert.ok(http.length > 0 && http.every((l) => l.includes('/accounts/2/')), 'toda chamada ao Chatwoot foi na conta 2');
  assert.ok(log.filter((l) => l.startsWith('POST') && l.includes('/messages')).length === W.MAX_MENSAGENS_POR_CICLO);
  assert.ok(log.filter((l) => l.startsWith('registrar')).every((l) => l.includes('caixa=20 ')));
  // a mesma conversa 100 existe nas duas contas: a régua de cada uma registra a dela (a chave do registro leva a caixa)
  const demoLog = log.filter((l) => l.startsWith('registrar') && l.includes('conversa=100 '));
  assert.ok(demoLog.length >= 1);
});

test('clínica NOVA (conta própria, nada gravado): a régua nasce em SECO — decide e anota, não escreve ao paciente; Parauapebas segue desligada sem nada gravado', () => {
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO]);
  assert.equal(estadoDoAmbiente('clinica-demonstracao', undefined, 'chatwoot-regua'), 'seco');
  assert.equal(estadoDoAmbiente('clinica-demonstracao', undefined, 'chatwoot-ia'), 'seco');
  assert.equal(estadoDoAmbiente('clinica-demonstracao', undefined, 'chatwoot-agenda'), 'seco');
  assert.equal(estadoDoAmbiente('clinica-demonstracao', undefined, 'chatwoot-capi'), 'seco');
  assert.equal(estadoDoAmbiente(SLUG_PARAU, undefined, 'chatwoot-regua'), 'desligado', 'Parauapebas: igual a antes');
  assert.equal(estadoDoAmbiente('unidade-sem-config', undefined, 'chatwoot-regua'), 'desligado');
  assert.equal(estadoDoAmbiente('clinica-demonstracao', 'clinica-demonstracao', 'chatwoot-regua'), 'ligado', 'quem está na lista do ambiente continua ligado');
  assert.equal(estadoDoAmbiente('clinica-demonstracao', undefined, 'asaas-qualquer'), 'desligado', 'só as automações do CRM com modo seco');
});

test('caixa que nenhuma unidade configurada tem (ou unidade sem conta válida): RECUSA — sem Chat, sem chamada ao Chatwoot', () => {
  const ctx = C.criarContextoChatwoot({ url: 'https://crm.exemplo.test', conta: 1, token: 'tk-do-ambiente' }, { fetch: (async () => { throw new Error('não podia chamar o Chatwoot'); }) as unknown as typeof fetch });
  assert.equal(W.chatDaCaixa(ctx, 999), null);
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, { ...DEMO, contaId: -1 } as never]);
  assert.equal(W.chatDaCaixa(ctx, 20), null, 'conta inválida: não cai na conta 1');
  assert.notEqual(W.chatDaCaixa(ctx, 3), null);
});
