/**
 * Passo 6 — auditoria das chaves que carregam um id de conversa do Chatwoot. O id da conversa é POR CONTA: a conversa 5 da conta 1 e a 5 da conta 2
 * são conversas diferentes, e a chave sintética do sinal Pix (`BASE + conversa`) é a mesma nas duas. Isso só é seguro enquanto TODA tabela e TODA
 * leitura que usa essa chave carregar também a unidade (ou a clínica/caixa/conta). Este arquivo trava essa regra.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://x:y@127.0.0.1:1/z';
process.env.SESSION_JWT_SECRET ??= 'segredo-de-teste-com-mais-de-32-caracteres-ok';

const { leadDaConversaChatwoot, conversaDoLeadChatwoot } = await import('./chatwoot-lead.js');
const { acompanharRemarcacao } = await import('./sinal-pix.js');

const SCHEMA = readFileSync(fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url)), 'utf8');
const MODELOS = [...SCHEMA.matchAll(/^model (\w+) \{(.*?)^\}/gms)].map((m) => ({ nome: m[1]!, corpo: m[2]! }));
const GUARDA = /[lL]ead|[cC]onversa|[cC]onversation/;
const ESCOPO = new Set(['unitId', 'unitSlug', 'clinica', 'caixa', 'conta', 'unit']);

/**
 * Tabelas cuja «chave de conversa» NÃO é um id do Chatwoot: apontam para `Conversation.id` (cuid) ou são da Central do João. Revisadas uma a uma.
 * Entrou tabela nova com chave de lead/conversa e sem unidade? O teste quebra: ou ela ganha o escopo, ou é revisada e entra aqui com o motivo.
 */
const REVISADAS_SEM_ESCOPO: Record<string, string> = {
  Message: '`conversationId` é o cuid de `Conversation` (que tem unitId)',
  ConversationEvaluation: '`conversationId` é o cuid de `Conversation` (que tem unitId)',
  ConversationOutcome: '`conversationId` é o cuid de `Conversation`; a linha também tem unitId',
  CentralChamado: 'Central do João (WhatsApp pessoal): não tem relação com conta do Chatwoot',
};

test('toda tabela com chave de lead/conversa carrega a unidade (ou clínica, caixa, conta)', () => {
  const sem: string[] = [];
  for (const { nome, corpo } of MODELOS) {
    const campos = [...corpo.matchAll(/^\s+(\w+)\s+(?:Int|BigInt|String)\b/gm)].map((m) => m[1]!);
    if (!campos.some((c) => GUARDA.test(c))) continue;
    if (campos.some((c) => ESCOPO.has(c))) continue;
    if (nome in REVISADAS_SEM_ESCOPO) continue;
    sem.push(`${nome} (${campos.filter((c) => GUARDA.test(c)).join(', ')})`);
  }
  assert.deepEqual(sem, [], 'tabela com chave de conversa/lead SEM unidade: a conversa 5 de uma clínica colidiria com a da outra');
  // e a lista de revisadas não pode virar lixo: toda entrada existe no schema
  for (const nome of Object.keys(REVISADAS_SEM_ESCOPO)) assert.ok(MODELOS.some((m) => m.nome === nome), `${nome} não existe mais no schema`);
});

test('nenhuma chave ÚNICA de lead/conversa vale sem a unidade (a menos que seja o cuid de Conversation, revisado)', () => {
  const soltas: string[] = [];
  for (const { nome, corpo } of MODELOS) {
    for (const m of corpo.matchAll(/@@unique\(\[([^\]]*)\]/g)) {
      const cols = m[1]!.split(',').map((c) => c.trim());
      if (cols.some((c) => GUARDA.test(c)) && !cols.some((c) => ESCOPO.has(c)) && !(nome in REVISADAS_SEM_ESCOPO)) soltas.push(`${nome}: @@unique([${cols.join(', ')}])`);
    }
    for (const m of corpo.matchAll(/^\s+(\w+)\s+\S+.*@unique/gm)) {
      if (GUARDA.test(m[1]!) && !(nome in REVISADAS_SEM_ESCOPO)) soltas.push(`${nome}: ${m[1]} @unique`);
    }
  }
  assert.deepEqual(soltas, []);
});

test('o sinal Pix e o vínculo com a franquia são UNIQUE/indexados por clínica/unidade + lead (a chave sintética repete entre contas)', () => {
  const sinal = MODELOS.find((m) => m.nome === 'SinalPix')!.corpo;
  assert.match(sinal, /@@index\(\[clinica, leadId, status\]\)/);
  assert.match(sinal, /@@unique\(\[unitId, linkId\]\)/);
  const vinculo = MODELOS.find((m) => m.nome === 'SpineLeadLink')!.corpo;
  assert.match(vinculo, /@@unique\(\[unitId, kommoLeadId\]\)/);
  const conversa = MODELOS.find((m) => m.nome === 'Conversation')!.corpo;
  assert.match(conversa, /@@unique\(\[unitId, leadId\]\)/);
  const memoria = MODELOS.find((m) => m.nome === 'LeadMemory')!.corpo;
  assert.match(memoria, /@@unique\(\[unitId, leadId\]\)/);
});

test('a chave sintética da conversa 5 é a MESMA em qualquer conta — por isso o escopo é obrigatório', () => {
  assert.equal(leadDaConversaChatwoot(5), 2_000_000_005);
  assert.equal(conversaDoLeadChatwoot(leadDaConversaChatwoot(5)), 5);
});

test('remarcação do sinal: o pedido de uma clínica lê e mexe SÓ nas linhas dela, mesmo com a mesma chave sintética', async () => {
  const lead = leadDaConversaChatwoot(5);
  const agora = new Date('2026-11-15T12:00:00Z');
  const linhas = [
    { id: 'a1', clinica: 'doutor-hernia-parauapebas', leadId: String(lead), status: 'pendente', consultaEm: '2026-11-20T09:00', criadoEm: agora },
    { id: 'b1', clinica: 'clinica-demonstracao', leadId: String(lead), status: 'pendente', consultaEm: '2026-11-21T09:00', criadoEm: agora },
  ];
  const consultas: Array<Record<string, unknown>> = [];
  const mexidas: string[] = [];
  const banco = {
    findMany: async (a: { where: { clinica: string; leadId: string } }) => (consultas.push(a.where), linhas.filter((l) => l.clinica === a.where.clinica && l.leadId === a.where.leadId)),
    updateMany: async (a: { where: { id: string } }) => (mexidas.push(a.where.id), { count: 1 }),
    count: async () => 0,
    create: async () => { throw new Error('não usado'); },
    deleteMany: async () => ({ count: 0 }),
  };
  const n = await acompanharRemarcacao({ slug: 'clinica-demonstracao' }, lead, '2026-11-25T10:00', banco as never, agora);
  assert.equal(n, 1);
  assert.deepEqual(mexidas, ['b1'], 'a linha de Parauapebas com a MESMA chave não foi tocada');
  assert.equal(consultas[0]!.clinica, 'clinica-demonstracao');
});

// ── @id / @@id: a chave PRIMÁRIA também não pode ser só de lead/conversa ──────────────────────────────────────────

test('nenhuma chave PRIMÁRIA é só de lead/conversa (@id / @@id)', () => {
  const soltas: string[] = [];
  for (const { nome, corpo } of MODELOS) {
    for (const m of corpo.matchAll(/^\s+(\w+)\s+\S+.*@id\b/gm)) if (GUARDA.test(m[1]!) && !(nome in REVISADAS_SEM_ESCOPO)) soltas.push(`${nome}.${m[1]} @id`);
    for (const m of corpo.matchAll(/@@id\(\[([^\]]*)\]/g)) {
      const cols = m[1]!.split(',').map((c) => c.trim());
      if (cols.some((c) => GUARDA.test(c)) && !cols.some((c) => ESCOPO.has(c))) soltas.push(`${nome} @@id([${cols.join(', ')}])`);
    }
  }
  // `sofia_mensagem.message_id` é a chave primária: id de MENSAGEM do Chatwoot, que é global da instalação (não por conta)
  assert.deepEqual(soltas.filter((x) => !/^SofiaMensagem\./.test(x)), []);
});

// ── o código: nenhuma consulta por chave de lead/conversa sem unidade ──────────────────────────────────────────

function arquivosDeCodigo(dir: string): string[] {
  const l: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) l.push(...arquivosDeCodigo(p));
    else if (n.endsWith('.ts') && !n.endsWith('.test.ts')) l.push(p);
  }
  return l;
}
function corpoBalanceado(t: string, i: number): string {
  let d = 0;
  for (let j = i; j < t.length; j++) {
    if (t[j] === '{') d++;
    else if (t[j] === '}' && --d === 0) return t.slice(i, j + 1);
  }
  return '';
}
/**
 * Consultas que o varredor encontrou com chave de conversa/lead no `where` e sem unidade — todas revisadas: apontam para o cuid de `Conversation`
 * (que já é da unidade) ou são do disparo do Kommo (sem relação com o Chatwoot).
 */
const CONSULTAS_REVISADAS = [/conversation-judge\.service\.ts/, /webhook\.controller\.ts/, /prompts\.controller\.ts/, /agent\/follow-up\.ts/, /telefone-de-familiar\.ts/, /sem-resposta-worker\.ts/, /prometeu-sem-marcar-worker\.ts/, /disparo-worker\.ts/];

test('o código não consulta tabela por chave de lead/conversa SEM unidade (varredura do `where` de cada prisma.<tabela>.<consulta>)', () => {
  const raiz = fileURLToPath(new URL('..', import.meta.url));
  const chave = /\b(leadId|kommoLeadId|conversa|conversaId|conversationId)\b/;
  const escopo = /\b(unitId|unitSlug|clinica|caixa|conta|unit|id)\b\s*[:,}]|unitId_|\.\.\./;
  const chamada = /prisma\.(\w+)\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|update|updateMany|delete|deleteMany|count|upsert|groupBy)\(/g;
  const soltas: string[] = [];
  let achadas = 0;
  for (const arq of arquivosDeCodigo(raiz)) {
    const t = readFileSync(arq, 'utf8');
    for (const m of t.matchAll(chamada)) {
      const w = t.indexOf('where:', m.index! + m[0].length);
      if (w < 0 || w > m.index! + m[0].length + 600) continue;
      const corpo = corpoBalanceado(t, t.indexOf('{', w));
      if (!chave.test(corpo)) continue;
      achadas++;
      if (!escopo.test(corpo) && !CONSULTAS_REVISADAS.some((r) => r.test(arq))) soltas.push(`${arq.slice(raiz.length)}:${t.slice(0, m.index).split('\n').length} ${m[1]}.${m[2]} ${corpo.slice(0, 80)}`);
    }
  }
  assert.ok(achadas > 40, `a varredura achou só ${achadas} consultas: o regex quebrou?`);
  assert.deepEqual(soltas, [], 'consulta por chave de lead/conversa sem unidade/clínica/caixa/conta: a conversa 5 de uma clínica colidiria com a da outra');
});
