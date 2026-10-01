/**
 * Relatório MENSAL da rede — a parte da FRANQUIA e do CUSTO DE WHATSAPP.
 *
 * Existe porque o relatório mensal de CRM (Kommo + Meta Ads) precisava de dois dados que só a produção
 * enxerga: a agenda/tratamentos da franquia (a API só responde ao IP da VPS) e o custo de mensagens da Meta
 * (tabelas `whatsapp_cost_daily` / `whatsapp_template_daily`, no banco de produção).
 *
 * Tudo aqui é PURO (recebe listas, devolve números) para ser testado sem rede. Quem busca é o controller.
 *
 * Decisões que valem lembrar:
 *  - Avaliação = categoria exatamente "AVALIAÇÃO". REAVALIAÇÃO não conta (a regex /avalia/ já inflou
 *    o comparecimento de 120 para 131 em 21/09/2026).
 *  - Comparecimento = atendidas ÷ (atendidas + faltas). Desmarcada e remarcada não entram: a clínica
 *    liberou o horário, o paciente não "faltou".
 *  - "Fechou depois da avaliação" casa por NOME normalizado (a agenda não traz o id do paciente),
 *    então é uma estimativa: homônimos e nome escrito diferente erram para menos ou para mais.
 *  - Aderência usa a MESMA regra do painel da unidade e do worker de aderência (`contarSumindo`): ali
 *    DESMARCADO conta como falta e REMARCADO não. Já o comparecimento da agenda NÃO conta desmarcada. As duas
 *    medidas respondem a perguntas diferentes (paciente sumindo × aproveitamento da agenda) e por isso
 *    os números não são comparáveis entre si.
 *  - Datas de tratamento (`created`, UTC) são convertidas para o dia da CLÍNICA antes de comparar com o mês.
 *  - Receita = soma de `price` > 0 dos tratamentos CRIADOS no mês. Onde a clínica lança preço 0,00
 *    (Serra, Imperatriz, Balsas, Marabá, Açailândia em 23/09/2026) a receita sai zerada — e o relatório
 *    diz quantos tratamentos vieram sem preço, em vez de fingir que o ticket é zero.
 */
import type { SpineSchedule, SpineTreatment } from '../services/spine.service.js';
import { contarSumindo } from '../services/painel-unidade.service.js';
import { instanteNoFuso } from '../services/spine.service.js';
import { normalizar } from './franquia-sync.js';

const MES = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function mesValido(v: unknown): v is string {
  return typeof v === 'string' && MES.test(v);
}

export function somarDias(aaaammdd: string, n: number): string {
  return new Date(Date.parse(`${aaaammdd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** 1º e último dia do mês (AAAA-MM-DD). */
export function intervaloDoMes(mes: string): { de: string; ate: string; dias: number } {
  const m = MES.exec(mes);
  if (!m) throw new Error('mes_invalido');
  const ano = Number(m[1]);
  const mm = Number(m[2]);
  const ultimo = new Date(Date.UTC(ano, mm, 0)).getUTCDate();
  const p = (n: number) => String(n).padStart(2, '0');
  return { de: `${m[1]}-${m[2]}-01`, ate: `${m[1]}-${m[2]}-${p(ultimo)}`, dias: ultimo };
}

/** Quebra [de, ate] em janelas de até `max` dias — a rota de agenda recusa janela maior que 30. */
export function janelas(de: string, ate: string, max = 30): Array<{ de: string; ate: string }> {
  const out: Array<{ de: string; ate: string }> = [];
  let ini = de;
  while (ini <= ate) {
    const fim = somarDias(ini, max - 1);
    out.push({ de: ini, ate: fim < ate ? fim : ate });
    ini = somarDias(fim, 1);
  }
  return out;
}

const SITUACAO = {
  atendido: 'atendido',
  falta: 'nao comparec', // "não compareceu"
  desmarcado: 'desmarcado',
  remarcado: 'remarcado',
} as const;

function situacao(s: SpineSchedule): 'atendido' | 'falta' | 'desmarcado' | 'remarcado' | 'aberto' {
  const n = normalizar(s.statusName);
  if (n.startsWith(SITUACAO.atendido)) return 'atendido';
  if (n.startsWith(SITUACAO.falta)) return 'falta';
  if (n.startsWith(SITUACAO.desmarcado)) return 'desmarcado';
  if (n.startsWith(SITUACAO.remarcado)) return 'remarcado';
  return 'aberto'; // AGENDADO / CONFIRMADO / sem status
}

type Tipo = 'avaliacao' | 'sessao' | 'retorno' | 'outra';
function tipoDe(s: SpineSchedule): Tipo {
  const n = normalizar(s.categoryName);
  if (n === 'avaliacao') return 'avaliacao';
  if (n === 'sessao') return 'sessao';
  if (n.startsWith('retorno')) return 'retorno';
  return 'outra';
}

export interface ContagemAgenda {
  marcadas: number;
  atendidas: number;
  faltas: number;
  desmarcadas: number;
  remarcadas: number;
  abertas: number;
  /** atendidas ÷ (atendidas + faltas); null sem base */
  taxaComparecimento: number | null;
}

function zera(): ContagemAgenda {
  return { marcadas: 0, atendidas: 0, faltas: 0, desmarcadas: 0, remarcadas: 0, abertas: 0, taxaComparecimento: null };
}

export interface ResumoAgenda {
  linhas: number;
  pacientesDistintos: number;
  avaliacoes: ContagemAgenda;
  sessoes: ContagemAgenda;
  retornos: ContagemAgenda;
  outras: ContagemAgenda;
  /** categoria da franquia → quantidade, para o que não coube nas quatro de cima */
  porCategoria: Record<string, number>;
}

function acumula(c: ContagemAgenda, sit: ReturnType<typeof situacao>) {
  c.marcadas++;
  if (sit === 'atendido') c.atendidas++;
  else if (sit === 'falta') c.faltas++;
  else if (sit === 'desmarcado') c.desmarcadas++;
  else if (sit === 'remarcado') c.remarcadas++;
  else c.abertas++;
}

function fecha(c: ContagemAgenda) {
  const base = c.atendidas + c.faltas;
  c.taxaComparecimento = base ? c.atendidas / base : null;
}

/** Agenda do mês. `schedules` já vem filtrada pelo dia (dayLocal dentro do mês). */
export function resumirAgenda(schedules: SpineSchedule[]): ResumoAgenda {
  const out: ResumoAgenda = {
    linhas: schedules.length,
    pacientesDistintos: 0,
    avaliacoes: zera(),
    sessoes: zera(),
    retornos: zera(),
    outras: zera(),
    porCategoria: {},
  };
  const pacientes = new Set<string>();
  for (const s of schedules) {
    if (s.clientName) pacientes.add(normalizar(s.clientName));
    const t = tipoDe(s);
    const alvo = t === 'avaliacao' ? out.avaliacoes : t === 'sessao' ? out.sessoes : t === 'retorno' ? out.retornos : out.outras;
    acumula(alvo, situacao(s));
    const cat = (s.categoryName ?? '(sem categoria)').trim() || '(sem categoria)';
    out.porCategoria[cat] = (out.porCategoria[cat] ?? 0) + 1;
  }
  out.pacientesDistintos = pacientes.size;
  for (const c of [out.avaliacoes, out.sessoes, out.retornos, out.outras]) fecha(c);
  return out;
}

export interface ResumoTratamentos {
  criadosNoMes: number;
  comPreco: number;
  semPreco: number;
  /** soma de price > 0 */
  receita: number;
  /** receita ÷ comPreco; null se nenhum veio com preço */
  ticketMedio: number | null;
  porPlano: Array<{ plano: string; quantidade: number; receita: number }>;
  porLocal: Array<{ local: string; quantidade: number }>;
  porStatus: Array<{ status: string; quantidade: number }>;
}

const TZ_PADRAO = 'America/Sao_Paulo';

/** Dia (AAAA-MM-DD) na clínica. Tratamento criado às 22h locais de 30/09 chega como 01/10 em UTC. */
function diaLocal(iso: string | null, tz: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : instanteNoFuso(d, tz).slice(0, 10);
}

function ranking<T extends { quantidade: number }>(m: Map<string, T>): T[] {
  return [...m.values()].sort((a, b) => b.quantidade - a.quantidade);
}

export function resumirTratamentos(trats: SpineTreatment[], de: string, ate: string, tz: string = TZ_PADRAO): ResumoTratamentos {
  const doMes = trats.filter((t) => {
    const d = diaLocal(t.created, tz);
    return d !== null && d >= de && d <= ate;
  });
  const plano = new Map<string, { plano: string; quantidade: number; receita: number }>();
  const local = new Map<string, { local: string; quantidade: number }>();
  const status = new Map<string, { status: string; quantidade: number }>();
  let receita = 0;
  let comPreco = 0;
  for (const t of doMes) {
    const preco = Number(t.price ?? 0);
    const tem = Number.isFinite(preco) && preco > 0;
    if (tem) {
      receita += preco;
      comPreco++;
    }
    const p = (t.category ?? '(sem plano)').trim() || '(sem plano)';
    const pe = plano.get(p) ?? { plano: p, quantidade: 0, receita: 0 };
    pe.quantidade++;
    if (tem) pe.receita += preco;
    plano.set(p, pe);
    const l = (t.local ?? '(sem região)').trim() || '(sem região)';
    const le = local.get(l) ?? { local: l, quantidade: 0 };
    le.quantidade++;
    local.set(l, le);
    const s = (t.statusName ?? '(sem status)').trim() || '(sem status)';
    const se = status.get(s) ?? { status: s, quantidade: 0 };
    se.quantidade++;
    status.set(s, se);
  }
  return {
    criadosNoMes: doMes.length,
    comPreco,
    semPreco: doMes.length - comPreco,
    receita: Math.round(receita * 100) / 100,
    ticketMedio: comPreco ? Math.round((receita / comPreco) * 100) / 100 : null,
    porPlano: ranking(plano),
    porLocal: ranking(local),
    porStatus: ranking(status),
  };
}

export interface FechamentoPosAvaliacao {
  /** pacientes distintos com avaliação ATENDIDA no mês */
  avaliados: number;
  /** destes, quantos abriram tratamento na franquia em/após a avaliação (até o corte) */
  fecharam: number;
  taxa: number | null;
  /** sem tratamento até o corte */
  semTratamento: number;
  aviso: string;
}

/** Casa avaliação atendida × tratamento por NOME normalizado. Estimativa — ver cabeçalho do arquivo. */
export function fechamentoPosAvaliacao(schedulesDoMes: SpineSchedule[], tratamentos: SpineTreatment[], tz: string = TZ_PADRAO): FechamentoPosAvaliacao {
  const primeira = new Map<string, string>();
  for (const s of schedulesDoMes) {
    if (tipoDe(s) !== 'avaliacao' || situacao(s) !== 'atendido' || !s.clientName || !s.dayLocal) continue;
    const k = normalizar(s.clientName);
    const atual = primeira.get(k);
    if (!atual || s.dayLocal < atual) primeira.set(k, s.dayLocal);
  }
  // guarda só o tratamento MAIS RECENTE de cada nome: basta saber se existe um em/depois da avaliação
  const ultimoTrat = new Map<string, string>();
  for (const t of tratamentos) {
    const d = diaLocal(t.created, tz);
    if (!t.clientName || !d) continue;
    const k = normalizar(t.clientName);
    const atual = ultimoTrat.get(k);
    if (!atual || d > atual) ultimoTrat.set(k, d);
  }
  let fecharam = 0;
  for (const [nome, dia] of primeira) {
    const u = ultimoTrat.get(nome);
    if (u !== undefined && u >= dia) fecharam++;
  }
  const avaliados = primeira.size;
  return {
    avaliados,
    fecharam,
    taxa: avaliados ? fecharam / avaliados : null,
    semTratamento: avaliados - fecharam,
    aviso: 'estimativa: casa por nome do paciente (a agenda não traz o id); homônimo e grafia diferente erram',
  };
}

export interface Aderencia {
  /** pacientes em tratamento com 2+ sessões seguidas sem comparecer (hoje = fim do mês ou hoje) */
  comDuasFaltas: number;
  comTresFaltas: number;
  comCincoFaltas: number;
  /** os dez mais graves, sem telefone: nome, faltas, sessões feitas */
  piores: Array<{ nome: string; faltasSeguidas: number; feitas: number; total: number }>;
}

/**
 * `contarSumindo` (compartilhado com o painel) compara a categoria com o texto exato "SESSÃO" e agrupa
 * por nome cru. Aqui normalizamos antes, para "Sessão"/"SESSAO" e grafias do mesmo nome não escaparem.
 */
function canonicalizarSessoes(sessoes: SpineSchedule[]): SpineSchedule[] {
  const nomePorChave = new Map<string, string>();
  const out: SpineSchedule[] = [];
  for (const s of sessoes) {
    if (tipoDe(s) !== 'sessao' || !s.clientName) continue;
    const k = normalizar(s.clientName);
    if (!nomePorChave.has(k)) nomePorChave.set(k, s.clientName);
    out.push({ ...s, categoryName: 'SESSÃO', clientName: nomePorChave.get(k) as string });
  }
  return out;
}

export function medirAderencia(sessoes: SpineSchedule[], ateISO: string): Aderencia {
  const sumindo = contarSumindo(canonicalizarSessoes(sessoes), ateISO, 2);
  return {
    comDuasFaltas: sumindo.length,
    comTresFaltas: sumindo.filter((s) => s.faltasSeguidas >= 3).length,
    comCincoFaltas: sumindo.filter((s) => s.faltasSeguidas >= 5).length,
    piores: [...sumindo]
      .sort((a, b) => b.faltasSeguidas - a.faltasSeguidas)
      .slice(0, 10)
      .map((s) => ({ nome: s.nome, faltasSeguidas: s.faltasSeguidas, feitas: s.feitas, total: s.total })),
  };
}

// ── custo de mensagens (Meta) ─────────────────────────────────────────────────────────────────────

export interface LinhaCusto {
  pricingCategory: string;
  pricingType: string;
  volume: number;
  costUsd: number | string | { toString(): string };
}
export interface LinhaTemplate {
  templateName: string | null;
  templateId: string;
  sent: number;
  delivered: number;
  read: number;
  clicked: number;
  costUsd: number | string | { toString(): string };
}

export interface ResumoWhatsapp {
  mensagens: number;
  gratis: number;
  pagas: number;
  usd: number;
  /** só se `cambio` veio na chamada */
  brl: number | null;
  usdPorMensagemPaga: number | null;
  porCategoria: Array<{ categoria: string; mensagens: number; usd: number }>;
  templates: { enviados: number; entregues: number; lidos: number; cliques: number; usd: number };
  topTemplates: Array<{ nome: string; enviados: number; entregues: number; lidos: number; cliques: number; usd: number }>;
}

const num = (v: LinhaCusto['costUsd']) => {
  const n = typeof v === 'number' ? v : Number(v.toString());
  return Number.isFinite(n) ? n : 0;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

export function resumirWhatsapp(custos: LinhaCusto[], templates: LinhaTemplate[], cambio: number | null): ResumoWhatsapp {
  const cat = new Map<string, { categoria: string; mensagens: number; usd: number }>();
  let mensagens = 0;
  let gratis = 0;
  let usd = 0;
  for (const c of custos) {
    const v = Number(c.volume) || 0;
    const u = num(c.costUsd);
    mensagens += v;
    usd += u;
    if (/^FREE/i.test(c.pricingType)) gratis += v;
    const k = c.pricingCategory || '(sem categoria)';
    const e = cat.get(k) ?? { categoria: k, mensagens: 0, usd: 0 };
    e.mensagens += v;
    e.usd += u;
    cat.set(k, e);
  }
  const porNome = new Map<string, ResumoWhatsapp['topTemplates'][number]>();
  const tot = { enviados: 0, entregues: 0, lidos: 0, cliques: 0, usd: 0 };
  for (const t of templates) {
    const nome = t.templateName || t.templateId;
    const e = porNome.get(nome) ?? { nome, enviados: 0, entregues: 0, lidos: 0, cliques: 0, usd: 0 };
    const sent = Number(t.sent) || 0;
    const delivered = Number(t.delivered) || 0;
    const read = Number(t.read) || 0;
    const clicked = Number(t.clicked) || 0;
    e.enviados += sent;
    e.entregues += delivered;
    e.lidos += read;
    e.cliques += clicked;
    e.usd += num(t.costUsd);
    porNome.set(nome, e);
    tot.enviados += sent;
    tot.entregues += delivered;
    tot.lidos += read;
    tot.cliques += clicked;
    tot.usd += num(t.costUsd);
  }
  const pagas = mensagens - gratis;
  return {
    mensagens,
    gratis,
    pagas,
    usd: r2(usd),
    brl: cambio ? r2(usd * cambio) : null,
    usdPorMensagemPaga: pagas ? Math.round((usd / pagas) * 10000) / 10000 : null,
    porCategoria: [...cat.values()].map((c) => ({ ...c, usd: r2(c.usd) })).sort((a, b) => b.usd - a.usd),
    templates: { ...tot, usd: r2(tot.usd) },
    topTemplates: [...porNome.values()].sort((a, b) => b.enviados - a.enviados).slice(0, 10).map((t) => ({ ...t, usd: r2(t.usd) })),
  };
}

// ── custo da IA (Anthropic) ───────────────────────────────────────────────────────────────────────

/**
 * Preço de lista do Sonnet 5 em US$ por MILHÃO de tokens (09/09/2026: entrada 2, saída 10, leitura de cache 0,20,
 * gravação de cache 5 min 2,50 e 1 h 4,00). Recalculamos pelo uso (`response_body.llmOutput.usage`) em vez de
 * confiar em `llm_calls.cost_usd`: o follow-up gravava o modelo errado e o custo errado até a v1.80.0.
 */
export const PRECO_POR_MILHAO = { entrada: 2, saida: 10, cacheLeitura: 0.2, cache5m: 2.5, cache1h: 4 } as const;

export interface UsoIa {
  chamadas: number;
  registradoUsd: number;
  entrada: number;
  saida: number;
  cacheLeitura: number;
  cache5m: number;
  cache1h: number;
}

export function custoListaUsd(u: Pick<UsoIa, 'entrada' | 'saida' | 'cacheLeitura' | 'cache5m' | 'cache1h'>): number {
  const p = PRECO_POR_MILHAO;
  return (u.entrada * p.entrada + u.saida * p.saida + u.cacheLeitura * p.cacheLeitura + u.cache5m * p.cache5m + u.cache1h * p.cache1h) / 1_000_000;
}

export interface ResumoIa {
  chamadas: number;
  /** o que `llm_calls.cost_usd` soma (pode estar errado em chamadas antigas) */
  registradoUsd: number;
  /** recalculado pelos tokens, a preço de lista — é o número a usar */
  listaUsd: number;
  listaBrl: number | null;
  tokens: { entrada: number; saida: number; cacheLeitura: number; cacheGravado: number };
}

export function resumirIa(uso: UsoIa, cambio: number | null): ResumoIa {
  const lista = custoListaUsd(uso);
  return {
    chamadas: uso.chamadas,
    registradoUsd: r2(uso.registradoUsd),
    listaUsd: r2(lista),
    listaBrl: cambio ? r2(lista * cambio) : null,
    tokens: { entrada: uso.entrada, saida: uso.saida, cacheLeitura: uso.cacheLeitura, cacheGravado: uso.cache5m + uso.cache1h },
  };
}
