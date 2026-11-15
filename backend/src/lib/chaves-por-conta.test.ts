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

/** Os pedaços de PRIMEIRO nível de um objeto literal `{ a: 1, b, ...c, d: { x: 1 } }` (corta nas vírgulas fora de {}, [] e ()). */
export function pedacosDoObjeto(corpo: string): string[] {
  const miolo = corpo.trim().replace(/^\{/, '').replace(/\}$/, '');
  const l: string[] = [];
  let d = 0;
  let atual = '';
  for (const c of miolo) {
    if ('{[('.includes(c)) d++;
    else if ('}])'.includes(c)) d--;
    if (c === ',' && d === 0) {
      l.push(atual.trim());
      atual = '';
    } else atual += c;
  }
  if (atual.trim()) l.push(atual.trim());
  return l.filter(Boolean);
}

const NOMES_DE_CHAVE = new Set(['leadId', 'kommoLeadId', 'conversa', 'conversaId', 'conversationId']);
/** Nas tabelas com cuid de Conversation, `conversationId` é o cuid (já da unidade) — mas `kommoLeadId`/`leadId` nelas continuam sendo chave que exige escopo. */
const SEM_CUID = new Set(['leadId', 'kommoLeadId', 'conversa', 'conversaId']);
const ESCOPOS = new Set(['unitId', 'unitSlug', 'clinica', 'caixa', 'conta']);
/** Único spread aceito como escopo: o helper conhecido, chamado direto (nunca dentro de condicional). */
const SPREAD_CONHECIDO = /^\.\.\.filtroDeCaixas\(/;

/** O nome da CHAVE de um pedaço (`caixa: x` → caixa; `caixa` → caixa); spread e o resto → null. O VALOR nunca é nome. */
const nomeDaChave = (p: string): string | null => (p.startsWith('...') ? null : (/^([A-Za-z_]\w*)\s*(?::|$)/.exec(p)?.[1] ?? null));

/**
 * O objeto tem escopo? O escopo só vale como CHAVE de primeiro nível (`caixa: x`, `{ caixa, … }`, `unitId_kommoLeadId: {…}`) ou como o spread do helper
 * `...filtroDeCaixas(…)`. A palavra `conta`/`caixa` num VALOR (`conversaId: x.conta`) não conta; spread condicional (`...(c ? { caixa: c } : {})`) não conta:
 * a caixa opcional que some quando falta é exatamente o furo que o #351 fechou.
 */
export function temEscopo(corpo: string): boolean {
  for (const p of pedacosDoObjeto(corpo)) {
    if (p.startsWith('...')) {
      if (SPREAD_CONHECIDO.test(p)) return true;
      continue;
    }
    const chave = nomeDaChave(p);
    if (chave && (ESCOPOS.has(chave) || chave.startsWith('unitId_'))) return true;
  }
  return false;
}

/** Os `{...}` de um valor (um objeto, ou os de uma lista `[{…}, {…}]`). */
function objetosDoValor(valor: string): string[] {
  const l: string[] = [];
  for (let i = 0; i < valor.length; i++) {
    if (valor[i] === '{') {
      const o = corpoBalanceado(valor, i);
      if (!o) break;
      l.push(o);
      i += o.length - 1;
    }
  }
  return l;
}

/**
 * Algum objeto do `where` usa uma chave de lead/conversa SEM escopo nele nem em quem o contém? (`conversation: { unitId, leadId }` e
 * `where: { unitId, OR: [{ leadId }] }` estão escopados; `{ id: conversationId }` não usa a chave: conversationId ali é VALOR.)
 */
export function usaChaveSemEscopo(corpo: string, herdado = false, chaves: ReadonlySet<string> = NOMES_DE_CHAVE): boolean {
  const tem = herdado || temEscopo(corpo);
  for (const p of pedacosDoObjeto(corpo)) {
    const chave = nomeDaChave(p);
    if (chave && chaves.has(chave) && !tem) return true;
    const dois = p.indexOf(':');
    if (dois < 0 || p.startsWith('...')) continue;
    for (const filho of objetosDoValor(p.slice(dois + 1))) if (usaChaveSemEscopo(filho, tem, chaves)) return true;
  }
  return false;
}

/**
 * As consultas por chave de lead/conversa SEM escopo que o texto de um arquivo tem (`arquivo` só para a mensagem).
 * Devolve `{ tabela, linha, corpo }` de cada uma.
 */
/** Tabelas cuja «chave de conversa» é o cuid de `Conversation` (que já é da unidade), não o id do Chatwoot: revisadas e liberadas POR TABELA. */
export const TABELAS_COM_CUID = new Set(['message', 'conversationEvaluation', 'conversationOutcome']);

/** `prisma.tabela.op(` ou `tx.tabela.op(` — com espaço e quebra de linha entre as partes — e `aggregate` além das demais. */
export const CHAMADA_AO_BANCO = /\b(?:prisma|tx)\s*\.\s*(\w+)\s*\.\s*(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|update|updateMany|delete|deleteMany|count|upsert|groupBy|aggregate)\s*\(/g;

export function consultasPorChave(codigo: string): Array<{ tabela: string; linha: number; corpo: string; semEscopo: boolean }> {
  const achadas: Array<{ tabela: string; linha: number; corpo: string; semEscopo: boolean }> = [];
  for (const m of codigo.matchAll(new RegExp(CHAMADA_AO_BANCO.source, 'g'))) {
    const fim = m.index! + m[0].length;
    const w = codigo.indexOf('where:', fim);
    if (w < 0 || w > fim + 600) continue;
    const corpo = corpoBalanceado(codigo, codigo.indexOf('{', w));
    const chaves = TABELAS_COM_CUID.has(m[1]!) ? SEM_CUID : NOMES_DE_CHAVE;
    if (!pedacosComChave(corpo, chaves)) continue;
    achadas.push({ tabela: m[1]!, linha: codigo.slice(0, m.index).split('\n').length, corpo: corpo.slice(0, 90), semEscopo: usaChaveSemEscopo(corpo, false, chaves) });
  }
  return achadas;
}

/** Quantas chamadas `prisma.<tabela>.<op>(` / `tx.<tabela>.<op>(` o texto tem (com ou sem `where`): o denominador do teste de sanidade. */
export const totalDeChamadasAoBanco = (codigo: string): number => [...codigo.matchAll(new RegExp(CHAMADA_AO_BANCO.source, 'g'))].length;

/** O `where` usa alguma chave de lead/conversa (em qualquer nível)? */
function pedacosComChave(corpo: string, chaves: ReadonlySet<string> = NOMES_DE_CHAVE): boolean {
  return pedacosDoObjeto(corpo).some((p) => {
    const chave = nomeDaChave(p);
    if (chave && chaves.has(chave)) return true;
    const dois = p.indexOf(':');
    return dois >= 0 && !p.startsWith('...') && objetosDoValor(p.slice(dois + 1)).some((o) => pedacosComChave(o, chaves));
  });
}

/** Só as SEM escopo. */
export const consultasSemEscopo = (codigo: string) => consultasPorChave(codigo).filter((c) => c.semEscopo);

/**
 * Consultas sem escopo REVISADAS, uma a uma: arquivo + tabela + motivo. Liberar o arquivo inteiro deixaria passar a consulta nova de OUTRA tabela
 * escrita nele depois; liberar por tabela não. Cada entrada vale para as consultas daquela tabela naquele arquivo.
 */
const REVISADAS: Array<{ arquivo: RegExp; tabela: string; motivo: string }> = [
  { arquivo: /lib\/prometeu-sem-marcar-worker\.ts$/, tabela: 'conversation', motivo: 'de propósito entre unidades da MESMA conta do Kommo (o resgate promete e passa para a comercial); a chave do agrupamento é conta|lead, não só o lead' },
  { arquivo: /lib\/disparo-worker\.ts$/, tabela: 'disparoDestinatario', motivo: 'disparo do Kommo, sem relação com o Chatwoot' },
];

/** As consultas sem escopo de UM arquivo que a lista de revisadas NÃO libera (a liberação é por arquivo E tabela). */
export function soltasDoArquivo(arquivo: string, codigo: string): string[] {
  return consultasPorChave(codigo)
    .filter((c) => c.semEscopo && !REVISADAS.some((r) => r.arquivo.test(arquivo) && r.tabela === c.tabela))
    .map((c) => `${arquivo}:${c.linha} prisma.${c.tabela} ${c.corpo}`);
}

function soltasDoCodigo(): { achadas: number; chamadas: number; soltas: string[] } {
  const raiz = fileURLToPath(new URL('..', import.meta.url));
  let achadas = 0;
  let chamadas = 0;
  const soltas: string[] = [];
  for (const arq of arquivosDeCodigo(raiz)) {
    const t = readFileSync(arq, 'utf8');
    chamadas += totalDeChamadasAoBanco(t);
    achadas += consultasPorChave(t).length;
    soltas.push(...soltasDoArquivo(arq.slice(raiz.length), t));
  }
  return { achadas, chamadas, soltas };
}

test('o código não consulta tabela por chave de lead/conversa SEM escopo (unidade, clínica, caixa ou conta como CHAVE do where)', () => {
  const { achadas, chamadas, soltas } = soltasDoCodigo();
  assert.ok(achadas > 30, `a varredura achou só ${achadas} consultas por chave de lead/conversa: o regex quebrou?`);
  // o denominador conta TUDO (espaço/quebra de linha entre as partes, tx.<tabela>, aggregate): 884 chamadas com o regex antigo + as ~72 que ele não via
  assert.ok(chamadas >= 940, `a varredura viu só ${chamadas} chamadas ao banco: o regex voltou a perder as multilinha/tx/aggregate?`);
  assert.deepEqual(soltas, [], 'consulta por chave de lead/conversa sem escopo: a conversa 5 de uma clínica colidiria com a da outra');
  // cada exceção revisada ainda existe (não vira lixo)
  const raiz = fileURLToPath(new URL('..', import.meta.url));
  for (const r of REVISADAS) {
    const existe = arquivosDeCodigo(raiz).some((a) => r.arquivo.test(a) && consultasSemEscopo(readFileSync(a, 'utf8')).some((c) => c.tabela === r.tabela));
    assert.ok(existe, `exceção revisada que não existe mais: ${r.arquivo} / ${r.tabela}`);
  }
});

test('SONDAS do revisor: spread condicional, «conta» como VALOR e consulta sem escopo — as três são pegas', () => {
  const sondas = {
    condicional: "prisma.chatwootReguaDisparo.findMany({ where: { ...(c !== undefined ? { caixa: c } : {}), conversationId: 5 } })",
    contaComoValor: 'prisma.funilTarefa.findMany({ where: { conversaId: x.conta } })',
    semEscopo: 'prisma.sofiaMensagem.findMany({ where: { conversa: 5 } })',
  };
  for (const [nome, codigo] of Object.entries(sondas)) assert.equal(consultasSemEscopo(codigo).length, 1, `sonda «${nome}» passou despercebida`);
});

test('a varredura ACEITA o que tem escopo de verdade (chave, atalho, helper conhecido, chave composta) e rejeita o resto', () => {
  const ok = [
    'prisma.t.findMany({ where: { caixa: 3, conversationId: 5 } })',
    'prisma.t.findMany({ where: { caixa, conversationId: 5 } })',
    'prisma.t.findMany({ where: { unitId: u.id, kommoLeadId: 5 } })',
    'prisma.t.findUnique({ where: { unitId_kommoLeadId: { unitId: u.id, kommoLeadId: 5 } } })',
    'prisma.t.findMany({ where: { ...filtroDeCaixas(a.c), conversationId: 5 } })',
    "prisma.t.findMany({ where: { unitSlug: slug, conversa } })",
    'prisma.t.findMany({ where: { clinica, leadId: String(l) } })',
  ];
  for (const c of ok) assert.equal(consultasSemEscopo(c).length, 0, c);
  const ruim = [
    'prisma.t.findMany({ where: { ...(x ? { caixa: 1 } : {}), conversationId: 5 } })',
    'prisma.t.findMany({ where: { ...outraCoisa, conversationId: 5 } })',
    'prisma.t.findMany({ where: { ...(filtroDeCaixas(a.c) ? {} : {}), conversationId: 5 } })',
    'prisma.t.findMany({ where: { conversationId: caixa } })',
    'prisma.t.findMany({ where: { OR: [{ caixa: 3 }], conversationId: 5 } })',
    'prisma.t.findMany({ where: { id: 3, kommoLeadId: 5 } })',
  ];
  for (const c of ruim) assert.equal(consultasSemEscopo(c).length, 1, c);
});

test('exceção revisada vale para ARQUIVO + TABELA: com um arquivo que está DE FATO na lista, a consulta nova de outra tabela é pega (quebra se a liberação voltar a ser por arquivo)', () => {
  const raiz = fileURLToPath(new URL('..', import.meta.url));
  const alvo = REVISADAS[0]!; // uma exceção real da lista
  const arquivo = arquivosDeCodigo(raiz).find((a) => alvo.arquivo.test(a));
  assert.ok(arquivo, `o arquivo da exceção «${alvo.arquivo}» não existe`);
  const rel = arquivo!.slice(raiz.length);
  const real = readFileSync(arquivo!, 'utf8');
  assert.deepEqual(soltasDoArquivo(rel, real), [], 'o arquivo, como está, passa (a exceção da tabela dele vale)');
  const comNova = `${real}\nexport const zz = () => prisma.sofiaMensagem.findMany({ where: { conversa: 5 } });\n`;
  const pegas = soltasDoArquivo(rel, comNova);
  assert.equal(pegas.length, 1, 'consulta nova de OUTRA tabela no arquivo liberado tem de ser pega');
  assert.match(pegas[0]!, /sofiaMensagem/);
  // e a MESMA tabela da exceção, no mesmo arquivo, continua liberada
  const mesma = `${real}\nexport const zz = () => prisma.${alvo.tabela}.findMany({ where: { conversa: 5 } });\n`;
  assert.deepEqual(soltasDoArquivo(rel, mesma), []);
});

test('a varredura enxerga chamada com espaço/quebra de linha, tx.<tabela> e aggregate', () => {
  const casos = [
    'prisma\n  .sofiaMensagem\n  .findMany({ where: { conversa: 5 } })',
    'prisma . sofiaMensagem . findMany ( { where: { conversa: 5 } } )',
    'await tx.sofiaMensagem.findMany({ where: { conversa: 5 } })',
    'tx\n.funilTarefa\n.aggregate({ _count: true, where: { conversaId: 5 } })',
    'prisma.funilTarefa.aggregate({ where: { conversaId: 5 } })',
  ];
  for (const c of casos) {
    assert.equal(totalDeChamadasAoBanco(c), 1, c);
    assert.equal(consultasSemEscopo(c).length, 1, `não pegou: ${c}`);
  }
  assert.equal(consultasSemEscopo('tx.funilTarefa.aggregate({ where: { conta: 1, conversaId: 5 } })').length, 0);
});

test('conversationOutcome (e as tabelas de cuid): conversationId é o cuid, mas `kommoLeadId` nelas EXIGE escopo', () => {
  assert.equal(consultasSemEscopo('prisma.conversationOutcome.findMany({ where: { conversationId: x } })').length, 0);
  assert.equal(consultasSemEscopo('prisma.conversationOutcome.findMany({ where: { kommoLeadId: 5 } })').length, 1);
  assert.equal(consultasSemEscopo('prisma.conversationOutcome.findMany({ where: { unitId, kommoLeadId: 5 } })').length, 0);
  assert.equal(consultasSemEscopo('prisma.message.findMany({ where: { conversationId: c.id } })').length, 0);
});

/**
 * LIMITE REGISTRADO: a varredura é por TEXTO. Ela não vê o VALOR em tempo de execução — `where: { caixa: x }` com `x === undefined` o Prisma trata como
 * «sem filtro» (o furo que o #351 fechou com `caixa` obrigatório no tipo). Por isso, além da varredura, NENHUMA assinatura do código pode declarar `caixa?:`
 * (opcional) — exceto o retorno do helper `filtroDeCaixas`, que devolve `{}` de propósito para a conta do ambiente quando não há clínica de conta própria.
 */
test('nenhuma assinatura declara `caixa?:` opcional (o escopo com valor undefined some sem erro); só o helper filtroDeCaixas', () => {
  const raiz = fileURLToPath(new URL('..', import.meta.url));
  const achadas: string[] = [];
  for (const arq of arquivosDeCodigo(raiz)) {
    const t = readFileSync(arq, 'utf8');
    for (const m of t.matchAll(/\bcaixa\s*\?\s*:/g)) achadas.push(`${arq.slice(raiz.length)}:${t.slice(0, m.index).split('\n').length}`);
    for (const m of t.matchAll(/\bcaixa\s*:\s*undefined\b/g)) achadas.push(`${arq.slice(raiz.length)}:${t.slice(0, m.index).split('\n').length} (caixa: undefined)`);
  }
  assert.deepEqual(achadas.filter((x) => !/lib\/conta-da-requisicao\.ts/.test(x)), [], 'caixa opcional em assinatura: torne obrigatória no tipo');
});
