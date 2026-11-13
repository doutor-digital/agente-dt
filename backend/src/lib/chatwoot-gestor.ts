/**
 * Telas «Oportunidades», «Marketing» e «Gestor» do Chatwoot (pedido do João, 13/11/2026; molde: painel da Lia). Aqui só a CONTA (pura,
 * sem rede nem banco): dadas as conversas que a pessoa enxerga (a listagem do Chatwoot, com o login dela) e, quando houver, o
 * que a Meta e a franquia disseram, devolve o que cada tela mostra. Quem fala com o Chatwoot, a Meta e a franquia é
 * `controllers/funil.controller.ts`. Nunca inventa número: faltou a fonte, o campo vai `null` e a tela explica por quê.
 *
 * Definições (também escritas nas telas):
 *  - Período: «Manhã» = das 18h de ontem até agora (Belém); «Fim do dia» = de hoje 00h até agora; «Semana» = últimos 7 dias
 *    (hoje incluso); «Quinzena» = 15 dias; «Mês» = do dia 1 até hoje.
 *  - Amanheceram: conversas criadas no período. Não interagiram: mesma regra da tela Hoje (`semInteracao`). Interagiram = o resto.
 *  - Agendaram / Fecharam (cartões do relatório): entraram em «Agendado» / «Fechou» no período (memória da régua).
 *  - Agendou / Fechou (linhas por anúncio e por campanha): o ESTADO ATUAL dos leads que chegaram no período (etapa de agendamento
 *    em diante / tratamento fechado). É a leitura por coorte: «dos leads desta semana, quantos já fecharam».
 *  - De qual campanha veio: a 1ª mensagem do paciente com `referral` da Meta (anúncio «Clique para o WhatsApp»; `source_id` = id do
 *    anúncio); sem ela, `campanha_codigo`/`campanha_nome` do contato; sem nenhum, «Sem campanha gravada».
 *  - Investido: gasto da conta de anúncios na Meta no período. Faturado: tratamentos criados no período na franquia (soma do preço,
 *    sem cancelados); sem franquia, soma do `valor_fechado` das conversas. Retorno = faturado ÷ investido. CAC = investido ÷ pacientes
 *    que fecharam. Custo por consulta = investido ÷ consultas agendadas (dos leads do período).
 */
import { createHash } from 'node:crypto';
import { DIA_MS, data10, diaEmBelem, nomeDe, semInteracao, somar, str, sim } from './chatwoot-hoje.js';

const UTC_MENOS_3 = 3 * 3600_000;
const HORA = 3600_000;

// ── quem pode ver Gestor e Marketing ────────────────────────────────────────────────────────────

/** O papel da pessoa NESTA conta do Chatwoot (`administrator` | `agent`); null se o perfil não tem a conta. */
export function papelNaConta(perfil: unknown, conta: number): string | null {
  const contas = Array.isArray((perfil as { accounts?: unknown } | null)?.accounts) ? ((perfil as { accounts: unknown[] }).accounts as Array<{ id?: unknown; role?: unknown }>) : [];
  const a = contas.find((x) => Number(x?.id) === conta);
  return a && typeof a.role === 'string' && a.role ? a.role : a ? 'agent' : null;
}

export function emailDoPerfil(perfil: unknown): string | null {
  const e = (perfil as { email?: unknown } | null)?.email;
  return typeof e === 'string' && e.includes('@') ? e.trim().toLowerCase().slice(0, 320) : null;
}

/** sha-256 do e-mail (minúsculo, sem espaços): o menu compara hash, o `menu.js` público nunca carrega e-mail de gestor. */
export function hashDoEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export function listaDeGestores(csv: string | undefined): string[] {
  return (csv ?? '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => x.includes('@'));
}

/** Administrador da conta, ou e-mail na lista de gestores (`CHATWOOT_GESTORES`). Qualquer outra coisa: não vê. */
export function podeVerGestao(papel: string | null | undefined, email: string | null | undefined, gestoresCsv: string | undefined): boolean {
  if (papel === 'administrator') return true;
  return !!email && listaDeGestores(gestoresCsv).includes(email.trim().toLowerCase());
}

// ── períodos ────────────────────────────────────────────────────────────────────────────────────

export const CHAVES_PERIODO = ['manha', 'fimdia', 'semana', 'quinzena', 'mes'] as const;
export type ChavePeriodo = (typeof CHAVES_PERIODO)[number];

export interface JanelaDoPeriodo {
  inicioMs: number;
  fimMs: number;
  /** primeiro e último dia (Belém), AAAA-MM-DD — o que a Meta e a franquia pedem */
  de: string;
  ate: string;
}

export interface Periodo extends JanelaDoPeriodo {
  chave: ChavePeriodo;
  rotulo: string;
  descricao: string;
  /** a janela de comparação (mesmo tamanho, logo antes) e como a tela a chama: «vs ontem», «vs mês anterior» */
  anterior: JanelaDoPeriodo;
  rotuloAnterior: string;
}

const meiaNoiteDeBelem = (dia: string) => Date.parse(`${dia}T03:00:00Z`);

export function resolverPeriodo(chaveBruta: unknown, agora: number): Periodo {
  const chave: ChavePeriodo = (CHAVES_PERIODO as readonly string[]).includes(String(chaveBruta)) ? (chaveBruta as ChavePeriodo) : 'semana';
  const hoje = diaEmBelem(agora);
  let inicioMs: number;
  let rotulo: string;
  let descricao: string;
  switch (chave) {
    case 'manha':
      inicioMs = meiaNoiteDeBelem(somar(hoje, -1)) + 18 * HORA;
      rotulo = 'Manhã';
      descricao = 'Da noite de ontem (18h) até agora';
      break;
    case 'fimdia':
      inicioMs = meiaNoiteDeBelem(hoje);
      rotulo = 'Fim do dia';
      descricao = 'De hoje, 0h, até agora';
      break;
    case 'quinzena':
      inicioMs = meiaNoiteDeBelem(somar(hoje, -14));
      rotulo = 'Quinzena';
      descricao = 'Os últimos 15 dias, hoje incluso';
      break;
    case 'mes':
      inicioMs = meiaNoiteDeBelem(`${hoje.slice(0, 8)}01`);
      rotulo = 'Mês';
      descricao = 'Do dia 1 do mês até hoje';
      break;
    default:
      inicioMs = meiaNoiteDeBelem(somar(hoje, -6));
      rotulo = 'Semana';
      descricao = 'Os últimos 7 dias, hoje incluso';
  }
  const janela = (i: number, f: number): JanelaDoPeriodo => ({ inicioMs: i, fimMs: f, de: diaEmBelem(i), ate: diaEmBelem(f) });
  let anterior: JanelaDoPeriodo;
  let rotuloAnterior: string;
  if (chave === 'mes') {
    // o mês até hoje contra o mesmo trecho do mês passado (dia 1 até o mesmo ponto), nunca invadindo o mês corrente
    const [a, m] = hoje.split('-').map(Number) as [number, number];
    const mesAnterior = m === 1 ? `${a - 1}-12-01` : `${a}-${String(m - 1).padStart(2, '0')}-01`;
    const i = meiaNoiteDeBelem(mesAnterior);
    anterior = janela(i, Math.min(i + (agora - inicioMs), inicioMs - 1));
    rotuloAnterior = 'vs mês anterior';
  } else {
    const dias = chave === 'quinzena' ? 15 : chave === 'semana' ? 7 : 1;
    // nunca sobrepõe a janela atual (a «Manhã» passa de 24 h quando agora é depois das 18h)
    anterior = janela(inicioMs - dias * DIA_MS, Math.min(agora - dias * DIA_MS, inicioMs - 1));
    rotuloAnterior = chave === 'quinzena' ? 'vs quinzena anterior' : chave === 'semana' ? 'vs semana anterior' : 'vs ontem';
  }
  return { chave, rotulo, descricao, inicioMs, fimMs: agora, de: diaEmBelem(inicioMs), ate: hoje, anterior, rotuloAnterior };
}

// ── valores e classificação da conversa ─────────────────────────────────────────────────────────

/** «R$ 2.620,00», «2.620», «2620,5», 2620 → número; lixo → 0. */
export function parseValor(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0;
  let t = str(v).replace(/R\$|\s/gi, '');
  if (!t) return 0;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const arred2 = (n: number) => Math.round(n * 100) / 100;
const etiquetasDe = (c: any): string[] => (Array.isArray(c?.labels) ? c.labels.map(String) : []);
const atributosDe = (c: any): Record<string, unknown> => (c?.custom_attributes && typeof c.custom_attributes === 'object' ? c.custom_attributes : {});
const contatoDe = (c: any): Record<string, unknown> => (c?.meta?.sender?.custom_attributes && typeof c.meta.sender.custom_attributes === 'object' ? c.meta.sender.custom_attributes : {});

export function telefoneDe(c: any): string | null {
  const t = str(c?.meta?.sender?.phone_number);
  return /^\+?\d{8,15}$/.test(t.replace(/[\s()-]/g, '')) ? t.replace(/[\s()-]/g, '') : null;
}

export type Qualificacao = 'Quente' | 'Morno' | 'Frio';
export function qualificacaoDe(c: any): Qualificacao | null {
  const q = str(atributosDe(c).qualificacao).toLowerCase();
  const et = etiquetasDe(c);
  if (q === 'quente' || (!q && et.includes('quente'))) return 'Quente';
  if (q === 'morno' || (!q && et.includes('morno'))) return 'Morno';
  if (q === 'frio' || (!q && et.includes('frio'))) return 'Frio';
  return null;
}

const ETAPAS_DE_AGENDAMENTO = new Set(['Agendado', 'Confirmado', 'Compareceu', 'Fechou', 'Pós-consulta']);
/** Já tem consulta marcada (etapa de agendamento em diante, ou data de consulta na conversa). */
export function agendouDe(c: any): boolean {
  const a = atributosDe(c);
  return ETAPAS_DE_AGENDAMENTO.has(str(a.etapa)) || !!data10(a.data_consulta);
}
export function fechouDe(c: any): boolean {
  const a = atributosDe(c);
  return sim(a.fechou_tratamento) || str(a.etapa) === 'Fechou';
}

// ── de qual campanha veio ───────────────────────────────────────────────────────────────────────

export interface Referral {
  /** id do anúncio na Meta (`source_id`) */
  anuncioId: string | null;
  tipo: string | null;
  url: string | null;
  titulo: string | null;
}

const curto = (v: unknown, n = 140) => {
  const t = str(v).replace(/\s+/g, ' ');
  return t ? t.slice(0, n) : null;
};

/**
 * A campanha pela PRIMEIRA mensagem recebida do paciente que traga o `referral` da Meta (Chatwoot 4.19, WhatsApp Cloud:
 * `content_attributes.referral`). `mensagens` = qualquer ordem. Só guarda o id do anúncio, o tipo, o link e o título — nada do texto.
 */
export function referralDasMensagens(mensagens: unknown[]): Referral | null {
  const recebidas = (Array.isArray(mensagens) ? mensagens : [])
    .filter((m: any) => m && Number(m.message_type) === 0)
    .sort((x: any, y: any) => Number(x.created_at) - Number(y.created_at) || Number(x.id) - Number(y.id));
  for (const m of recebidas as any[]) {
    const r = m?.content_attributes?.referral;
    if (!r || typeof r !== 'object') continue;
    const id = str(r.source_id ?? r.sourceId);
    const ref: Referral = {
      anuncioId: /^\d{5,30}$/.test(id) ? id : null,
      tipo: curto(r.source_type ?? r.sourceType, 20),
      url: curto(r.source_url ?? r.sourceUrl, 300),
      titulo: curto(r.headline, 120),
    };
    if (ref.anuncioId || ref.titulo || ref.url) return ref;
  }
  return null;
}

/** Uma linha do que a Meta gastou por anúncio no período. */
export interface LinhaAnuncio {
  anuncioId: string;
  anuncioNome: string;
  campanhaId: string;
  campanhaNome: string;
  gasto: number;
  /** o que a PRÓPRIA Meta conta para o anúncio no período (13/11/2026: o Marketing mostra o resultado da Meta, não só o do Chatwoot) */
  objetivo?: string | null;
  /** conversas iniciadas pelo anúncio (`onsite_conversion.messaging_conversation_started_7d`) */
  conversas?: number;
  /** leads como a Meta conta (`lead`: site pelo pixel, formulário ou lead marcado na conversa) */
  leadsMeta?: number;
  impressoes?: number;
  cliques?: number;
}

export interface LeadAnalisado {
  id: number;
  criadaEm: number;
  qual: Qualificacao | null;
  agendou: boolean;
  fechou: boolean;
  valor: number;
  anuncioId: string | null;
  titulo: string | null;
  codigo: string | null;
  campanhaNome: string | null;
}

export function leadDaConversa(c: any, ref: Referral | null): LeadAnalisado {
  const ct = contatoDe(c);
  return {
    id: Number(c.id),
    criadaEm: Number(c?.created_at) * 1000,
    qual: qualificacaoDe(c),
    agendou: agendouDe(c),
    fechou: fechouDe(c),
    valor: fechouDe(c) ? parseValor(atributosDe(c).valor_fechado) : 0,
    anuncioId: ref?.anuncioId ?? null,
    titulo: ref?.titulo ?? null,
    codigo: curto(ct.campanha_codigo, 40),
    campanhaNome: curto(ct.campanha_nome, 120),
  };
}

/** Conversa criada dentro da janela. */
export const criadaNaJanela = (c: any, p: JanelaDoPeriodo) => {
  const t = Number(c?.created_at) * 1000;
  return Number.isFinite(t) && t >= p.inicioMs && t <= p.fimMs;
};

// ── linhas por anúncio / por campanha ──────────────────────────────────────────────────────────

export interface LinhaCampanha {
  chave: string;
  /** código curto para a pessoa reconhecer (o do contato, ou o fim do id do anúncio) */
  codigo: string | null;
  titulo: string;
  leads: number;
  quentes: number;
  agendou: number;
  fechou: number;
  frios: number;
  /** % de leads frios (0–100); null se não há lead */
  pctFrio: number | null;
  /** soma do valor fechado nas conversas */
  faturado: number;
  /** só nas linhas por campanha: o que a Meta gastou; null = a Meta não disse */
  investido: number | null;
  cac: number | null;
}

function linhaVazia(chave: string, titulo: string, codigo: string | null, investido: number | null): LinhaCampanha {
  return { chave, codigo, titulo, leads: 0, quentes: 0, agendou: 0, fechou: 0, frios: 0, pctFrio: null, faturado: 0, investido, cac: null };
}

function somarLead(l: LinhaCampanha, lead: LeadAnalisado): void {
  l.leads++;
  if (lead.qual === 'Quente') l.quentes++;
  if (lead.qual === 'Frio') l.frios++;
  if (lead.agendou) l.agendou++;
  if (lead.fechou) l.fechou++;
  l.faturado += lead.valor;
}

function acabar(l: LinhaCampanha): LinhaCampanha {
  l.faturado = arred2(l.faturado);
  l.pctFrio = l.leads ? Math.round((l.frios * 100) / l.leads) : null;
  l.cac = l.investido !== null && l.fechou > 0 ? arred2(l.investido / l.fechou) : null;
  return l;
}

const fimDoId = (id: string) => id.slice(-5);
export const MAX_LINHAS_TABELA = 30;

/** «Rastreio das campanhas»: uma linha por ANÚNCIO (id do anúncio), mais a linha «Sem campanha gravada». */
export function linhasPorAnuncio(leads: LeadAnalisado[], anuncios: ReadonlyMap<string, LinhaAnuncio> | null): { linhas: LinhaCampanha[]; omitidas: number; semCampanha: LinhaCampanha } {
  const mapa = new Map<string, LinhaCampanha>();
  const sem = linhaVazia('sem', 'Sem campanha gravada', null, null);
  for (const lead of leads) {
    const chave = lead.anuncioId ? `ad:${lead.anuncioId}` : lead.codigo ? `cod:${lead.codigo}` : null;
    if (!chave) {
      somarLead(sem, lead);
      continue;
    }
    let l = mapa.get(chave);
    if (!l) {
      const meta = lead.anuncioId ? anuncios?.get(lead.anuncioId) : undefined;
      l = linhaVazia(chave, meta?.anuncioNome || lead.titulo || lead.campanhaNome || 'Anúncio sem título', lead.codigo || (lead.anuncioId ? `…${fimDoId(lead.anuncioId)}` : null), null);
      mapa.set(chave, l);
    }
    somarLead(l, lead);
  }
  const todas = [...mapa.values()].map(acabar).sort((x, y) => y.leads - x.leads || x.titulo.localeCompare(y.titulo, 'pt-BR'));
  return { linhas: todas.slice(0, MAX_LINHAS_TABELA), omitidas: Math.max(0, todas.length - MAX_LINHAS_TABELA), semCampanha: acabar(sem) };
}

/**
 * «Por campanha» do gestor: a campanha da Meta (quando o anúncio do lead está na lista do gasto), senão o próprio anúncio / código.
 * Campanha que gastou e não trouxe lead aparece (dinheiro gasto sem retorno é o que o gestor mais precisa ver).
 */
export function linhasPorCampanha(leads: LeadAnalisado[], gastos: readonly LinhaAnuncio[] | null): { linhas: LinhaCampanha[]; omitidas: number; semCampanha: LinhaCampanha } {
  const porAnuncio = new Map<string, LinhaAnuncio>();
  const mapa = new Map<string, LinhaCampanha>();
  for (const g of gastos ?? []) {
    porAnuncio.set(g.anuncioId, g);
    const chave = `camp:${g.campanhaId}`;
    const l = mapa.get(chave) ?? linhaVazia(chave, g.campanhaNome || `Campanha ${fimDoId(g.campanhaId)}`, `…${fimDoId(g.campanhaId)}`, 0);
    l.investido = (l.investido ?? 0) + g.gasto;
    mapa.set(chave, l);
  }
  const sem = linhaVazia('sem', 'Sem campanha gravada', null, null);
  for (const lead of leads) {
    const g = lead.anuncioId ? porAnuncio.get(lead.anuncioId) : undefined;
    const chave = g ? `camp:${g.campanhaId}` : lead.anuncioId ? `ad:${lead.anuncioId}` : lead.codigo ? `cod:${lead.codigo}` : null;
    if (!chave) {
      somarLead(sem, lead);
      continue;
    }
    let l = mapa.get(chave);
    if (!l) {
      l = linhaVazia(chave, lead.titulo || lead.campanhaNome || 'Anúncio sem título', lead.codigo || (lead.anuncioId ? `…${fimDoId(lead.anuncioId)}` : null), null);
      mapa.set(chave, l);
    }
    somarLead(l, lead);
  }
  for (const l of mapa.values()) if (l.investido !== null) l.investido = arred2(l.investido);
  const todas = [...mapa.values()].map(acabar).sort((x, y) => (y.investido ?? -1) - (x.investido ?? -1) || y.leads - x.leads || x.titulo.localeCompare(y.titulo, 'pt-BR'));
  return { linhas: todas.slice(0, MAX_LINHAS_TABELA), omitidas: Math.max(0, todas.length - MAX_LINHAS_TABELA), semCampanha: acabar(sem) };
}

// ── Marketing ───────────────────────────────────────────────────────────────────────────────────

export interface EntradaMarketing {
  conversas: any[];
  referrals: ReadonlyMap<number, Referral | null>;
  anuncios?: ReadonlyMap<string, LinhaAnuncio> | null;
  periodo: Periodo;
  /** conversas que entraram em «Agendado» dentro do período (memória da régua) */
  agendaramNoPeriodo: ReadonlySet<number>;
  /** o mesmo para a janela anterior; sem ele (a leitura foi cortada) não há comparação */
  agendaramNoPeriodoAnterior?: ReadonlySet<number> | null;
}

export interface RelatorioMarketing {
  periodo: Periodo;
  cartoes: Cartoes;
  /** o período anterior, para «↑ 12% vs ontem»; null = sem comparação confiável */
  anterior: Omit<Cartoes, 'pagaramAntecipado'> | null;
  qualificacao: { quente: number; morno: number; frio: number; semQualificacao: number };
  campanhas: LinhaCampanha[];
  campanhasOmitidas: number;
  semCampanha: LinhaCampanha;
  /** a linha de total (todos os leads do período) */
  total: LinhaCampanha;
  quemAgendou: Array<{ quem: string; agendamentos: number }>;
  faltaramOntem: number;
}

/** «Sofia», «Sofia (IA)», «sofia-ia» → Sofia; nome de pessoa fica como veio; vazio → «Sem registro». */
export function quemAgendouDe(v: unknown): string {
  const t = str(v).replace(/\s+/g, ' ').slice(0, 60);
  if (!t) return 'Sem registro';
  return /^sofia\b|^ia\b/i.test(t) ? 'Sofia' : t;
}

interface Cartoes {
  amanheceram: number;
  interagiram: number;
  naoInteragiram: number;
  agendaram: number;
  pagaramAntecipado: number;
}

function cartoesDa(conversas: any[], janela: JanelaDoPeriodo, agora: number, agendaram: ReadonlySet<number>): Cartoes {
  const coorte = conversas.filter((c) => criadaNaJanela(c, janela));
  const nao = coorte.filter((c) => semInteracao(c, agora)).length;
  const porId = new Set(conversas.map((c) => Number(c.id)));
  const pagaram = conversas.filter((c) => {
    if (!etiquetasDe(c).includes('pagou-antecipado')) return false;
    const t = Number(c?.last_activity_at ?? c?.timestamp) * 1000;
    return Number.isFinite(t) && t >= janela.inicioMs && t <= janela.fimMs;
  }).length;
  return {
    amanheceram: coorte.length,
    interagiram: coorte.length - nao,
    naoInteragiram: nao,
    // só conta o que a pessoa enxerga
    agendaram: [...agendaram].filter((id) => porId.has(id)).length,
    pagaramAntecipado: pagaram,
  };
}

export function montarMarketing(e: EntradaMarketing, agora: number): RelatorioMarketing {
  const coorte = e.conversas.filter((c) => criadaNaJanela(c, e.periodo));
  const q = { quente: 0, morno: 0, frio: 0, semQualificacao: 0 };
  const leads: LeadAnalisado[] = [];
  for (const c of coorte) {
    const lead = leadDaConversa(c, e.referrals.get(Number(c.id)) ?? null);
    leads.push(lead);
    if (lead.qual === 'Quente') q.quente++;
    else if (lead.qual === 'Morno') q.morno++;
    else if (lead.qual === 'Frio') q.frio++;
    else q.semQualificacao++;
  }
  const porId = new Map(e.conversas.map((c) => [Number(c.id), c] as const));
  const quem = new Map<string, number>();
  for (const id of e.agendaramNoPeriodo) {
    const c = porId.get(id);
    if (!c) continue;
    const nome = quemAgendouDe(atributosDe(c).quem_agendou);
    quem.set(nome, (quem.get(nome) ?? 0) + 1);
  }
  const ontem = somar(diaEmBelem(agora), -1);
  const faltaramOntem = e.conversas.filter((c) => str(atributosDe(c).situacao_consulta) === 'Não compareceu' && data10(atributosDe(c).data_consulta) === ontem).length;
  const por = linhasPorAnuncio(leads, e.anuncios ?? null);
  const cartoes = cartoesDa(e.conversas, e.periodo, agora, e.agendaramNoPeriodo);
  const ant = e.agendaramNoPeriodoAnterior ? cartoesDa(e.conversas, e.periodo.anterior, agora, e.agendaramNoPeriodoAnterior) : null;
  const total = linhaVazia('total', 'Total', null, null);
  for (const l of leads) somarLead(total, l);
  return {
    periodo: e.periodo,
    cartoes,
    // o «pagou antecipado» do período anterior não dá para reconstruir (a etiqueta e a atividade são do estado de hoje)
    anterior: ant ? { amanheceram: ant.amanheceram, interagiram: ant.interagiram, naoInteragiram: ant.naoInteragiram, agendaram: ant.agendaram } : null,
    qualificacao: q,
    campanhas: por.linhas,
    campanhasOmitidas: por.omitidas,
    semCampanha: por.semCampanha,
    total: acabar(total),
    quemAgendou: [...quem.entries()].map(([quemNome, agendamentos]) => ({ quem: quemNome, agendamentos })).sort((a, b) => b.agendamentos - a.agendamentos || a.quem.localeCompare(b.quem, 'pt-BR')),
    faltaramOntem,
  };
}

// ── Anúncios na Meta (Marketing) ────────────────────────────────────────────────────────────────

/**
 * O resultado das campanhas como a PRÓPRIA Meta conta (pedido do João, 13/11/2026: "o marketing puxando da API do Meta"). Não
 * depende de o lead estar no Chatwoot: em Parauapebas os anúncios levam para o 98442-0153, que ainda está no Kommo — sem isto o
 * Marketing mostrava só «Sem campanha gravada» e nenhum real investido.
 */
export interface ResultadoMeta {
  gasto: number;
  conversas: number;
  leads: number;
  impressoes: number;
  cliques: number;
  custoPorConversa: number | null;
  custoPorLead: number | null;
}
export interface CampanhaMeta extends ResultadoMeta {
  id: string;
  nome: string;
  objetivo: string | null;
  /** os WhatsApp para onde os conjuntos da campanha mandam (só dígitos) */
  destinos: string[];
  /** algum destino NÃO é número de caixa do Chatwoot: as conversas dela não aparecem aqui */
  foraDoChatwoot: boolean;
}
export interface AnunciosMeta {
  estado: EstadoDaFonte;
  motivo: string | null;
  moeda: string | null;
  total: ResultadoMeta;
  /** o período anterior do mesmo tamanho; null = a Meta não respondeu para ele */
  anterior: ResultadoMeta | null;
  campanhas: CampanhaMeta[];
  /** números de destino dos anúncios que não são caixa do Chatwoot (só dígitos) */
  numerosForaDoChatwoot: string[];
}

/** DDD + 8 últimos dígitos (o mesmo número com e sem o 9 dá a mesma chave); fora do Brasil, os 8 últimos. */
export function chaveDoNumero(n: string): string {
  const d = String(n ?? '').replace(/\D/g, '');
  return d.length >= 12 && d.startsWith('55') ? d.slice(2, 4) + d.slice(-8) : d.slice(-8);
}

function resultadoDe(l: ReadonlyArray<Pick<LinhaAnuncio, 'gasto' | 'conversas' | 'leadsMeta' | 'impressoes' | 'cliques'>>): ResultadoMeta {
  const r = { gasto: 0, conversas: 0, leads: 0, impressoes: 0, cliques: 0 };
  for (const x of l) {
    r.gasto += Number(x.gasto) || 0;
    r.conversas += x.conversas ?? 0;
    r.leads += x.leadsMeta ?? 0;
    r.impressoes += x.impressoes ?? 0;
    r.cliques += x.cliques ?? 0;
  }
  const gasto = arred2(r.gasto);
  return { ...r, gasto, custoPorConversa: r.conversas > 0 ? arred2(gasto / r.conversas) : null, custoPorLead: r.leads > 0 ? arred2(gasto / r.leads) : null };
}

export function montarAnunciosMeta(e: {
  investido: Investido;
  linhas: readonly LinhaAnuncio[];
  anterior: { investido: Investido; linhas: readonly LinhaAnuncio[] } | null;
  destinos: ReadonlyMap<string, readonly string[]> | null;
  numerosDoChatwoot: readonly string[];
}): AnunciosMeta {
  const doChatwoot = new Set(e.numerosDoChatwoot.map(chaveDoNumero).filter((k) => k.length >= 8));
  const porCampanha = new Map<string, LinhaAnuncio[]>();
  for (const l of e.linhas) porCampanha.set(l.campanhaId, [...(porCampanha.get(l.campanhaId) ?? []), l]);
  const fora = new Set<string>();
  const campanhas: CampanhaMeta[] = [...porCampanha.entries()].map(([id, ls]) => {
    const destinos = [...(e.destinos?.get(id) ?? [])];
    // só dá para afirmar «fora» quando a conta tem caixa de WhatsApp com número; sem isso, não acusa
    const foraDaqui = doChatwoot.size > 0 ? destinos.filter((n) => !doChatwoot.has(chaveDoNumero(n))) : [];
    for (const n of foraDaqui) fora.add(n);
    return { id, nome: ls[0]!.campanhaNome || `Campanha …${id.slice(-6)}`, objetivo: ls.find((x) => x.objetivo)?.objetivo ?? null, destinos, foraDoChatwoot: foraDaqui.length > 0, ...resultadoDe(ls) };
  });
  campanhas.sort((x, y) => y.gasto - x.gasto || y.conversas - x.conversas || x.nome.localeCompare(y.nome, 'pt-BR'));
  return {
    estado: e.investido.estado,
    motivo: e.investido.motivo,
    moeda: e.investido.moeda,
    total: resultadoDe(e.linhas),
    anterior: e.anterior && e.anterior.investido.estado === 'ok' ? resultadoDe(e.anterior.linhas) : null,
    campanhas,
    numerosForaDoChatwoot: [...fora],
  };
}

// ── Gestor ──────────────────────────────────────────────────────────────────────────────────────

export type EstadoDaFonte = 'ok' | 'conectar' | 'erro';
export interface Investido {
  estado: EstadoDaFonte;
  valor: number | null;
  moeda: string | null;
  /** por que não veio (erro) ou o que falta (conectar) */
  motivo: string | null;
  /** gasto por dia (AAAA-MM-DD), para o gráfico */
  porDia?: Record<string, number> | null;
}
export interface Faturado {
  valor: number | null;
  fonte: 'franquia' | 'conversas' | null;
  motivo: string | null;
  porDia?: Record<string, number> | null;
}

export interface Indicadores {
  retorno: number | null;
  cac: number | null;
  custoPorConsulta: number | null;
}

/** As três razões do gestor. Qualquer divisão sem base (sem investimento, ninguém fechou) vira null: a tela escreve «—» e explica. */
export function indicadores(investido: number | null, faturado: number | null, fecharam: number, agendaram: number): Indicadores {
  const base = investido !== null && investido > 0;
  return {
    retorno: base && faturado !== null ? Math.round((faturado / investido!) * 10) / 10 : null,
    cac: base && fecharam > 0 ? arred2(investido! / fecharam) : null,
    custoPorConsulta: base && agendaram > 0 ? arred2(investido! / agendaram) : null,
  };
}

export interface EntradaGestor {
  /** a mesma coisa para a janela anterior (só totais); sem ela não há comparação */
  anterior?: { investido: Investido; faturado: Faturado } | null;
  conversas: any[];
  referrals: ReadonlyMap<number, Referral | null>;
  gastos: readonly LinhaAnuncio[] | null;
  investido: Investido;
  faturadoFranquia: Faturado;
  periodo: Periodo;
}

export interface PainelGestor {
  periodo: Periodo;
  investido: Investido;
  faturado: Faturado;
  /** pacientes (dos leads do período) que já fecharam / já têm consulta */
  fecharam: number;
  agendaram: number;
  leads: number;
  indicadores: Indicadores;
  campanhas: LinhaCampanha[];
  campanhasOmitidas: number;
  semCampanha: LinhaCampanha;
  total: LinhaCampanha;
  /** soma do valor fechado nas conversas dos leads do período (a tabela usa esta) */
  faturadoDasConversas: number;
  /** o período anterior, para a variação de cada número; null = sem comparação confiável */
  anterior: { investido: number | null; faturado: number | null; indicadores: Indicadores } | null;
  /** um ponto por dia do período (só com 2 dias ou mais); `investido` null = a Meta não está ligada */
  serie: Array<{ dia: string; investido: number | null; faturado: number | null }>;
}

/** Todos os dias de `de` a `ate` (inclusive). */
export function diasDoPeriodo(de: string, ate: string): string[] {
  const dias: string[] = [];
  for (let d = de; d <= ate && dias.length < 40; d = somar(d, 1)) dias.push(d);
  return dias;
}

export function montarGestor(e: EntradaGestor): PainelGestor {
  const leads = e.conversas.filter((c) => criadaNaJanela(c, e.periodo)).map((c) => leadDaConversa(c, e.referrals.get(Number(c.id)) ?? null));
  const fecharam = leads.filter((l) => l.fechou).length;
  const agendaram = leads.filter((l) => l.agendou).length;
  const dasConversas = arred2(leads.reduce((t, l) => t + l.valor, 0));
  const faturado: Faturado = e.faturadoFranquia.valor !== null ? e.faturadoFranquia : { valor: dasConversas, fonte: 'conversas', motivo: e.faturadoFranquia.motivo };
  const por = linhasPorCampanha(leads, e.gastos);
  const invOk = e.investido.estado === 'ok' ? e.investido.valor : null;
  const total = linhaVazia('total', 'Total', null, invOk);
  for (const l of leads) somarLead(total, l);
  let anterior: PainelGestor['anterior'] = null;
  if (e.anterior) {
    const ant = e.conversas.filter((c) => criadaNaJanela(c, e.periodo.anterior)).map((c) => leadDaConversa(c, null));
    const invAnt = e.anterior.investido.estado === 'ok' ? e.anterior.investido.valor : null;
    const fatAnt = e.anterior.faturado.valor !== null ? e.anterior.faturado.valor : arred2(ant.reduce((t, l) => t + l.valor, 0));
    anterior = { investido: invAnt, faturado: fatAnt, indicadores: indicadores(invAnt, fatAnt, ant.filter((l) => l.fechou).length, ant.filter((l) => l.agendou).length) };
  }
  const dias = diasDoPeriodo(e.periodo.de, e.periodo.ate);
  const serie = dias.length > 1 ? dias.map((dia) => ({ dia, investido: e.investido.porDia ? e.investido.porDia[dia] ?? 0 : null, faturado: faturado.porDia ? faturado.porDia[dia] ?? 0 : null })) : [];
  return {
    periodo: e.periodo,
    investido: e.investido,
    faturado,
    fecharam,
    agendaram,
    leads: leads.length,
    indicadores: indicadores(invOk, faturado.valor, fecharam, agendaram),
    campanhas: por.linhas,
    campanhasOmitidas: por.omitidas,
    semCampanha: por.semCampanha,
    total: acabar(total),
    faturadoDasConversas: dasConversas,
    anterior,
    serie,
  };
}

/** Soma o preço dos tratamentos CRIADOS no período (dia local da unidade), sem cancelados. Sem preço não conta (e é dito). */
export function somarFaturado(
  tratamentos: ReadonlyArray<{ price: number | null; created: string | null; statusName: string | null }>,
  de: string,
  ate: string,
  diaLocal: (iso: string) => string | null,
): { valor: number; tratamentos: number; semPreco: number; porDia: Record<string, number> } {
  let valor = 0;
  let n = 0;
  let semPreco = 0;
  const porDia: Record<string, number> = {};
  for (const t of tratamentos) {
    const dia = t.created ? diaLocal(t.created) : null;
    if (!dia || dia < de || dia > ate) continue;
    if (/cancel/i.test(t.statusName ?? '')) continue;
    const preco = Number(t.price ?? 0);
    if (Number.isFinite(preco) && preco > 0) {
      valor += preco;
      n++;
      porDia[dia] = arred2((porDia[dia] ?? 0) + preco);
    } else semPreco++;
  }
  return { valor: arred2(valor), tratamentos: n, semPreco, porDia };
}

// ── Oportunidades ───────────────────────────────────────────────────────────────────────────────

export type Semaforo = 'Vermelho' | 'Amarelo' | 'Verde';
export interface Oportunidade {
  id: number;
  nome: string;
  telefone: string | null;
  detalhe: string;
  semaforo: Semaforo | null;
}
export interface Oportunidades {
  dia: string;
  naoFecharam: Oportunidade[];
  retorno60: Oportunidade[];
  verDepois: Oportunidade[];
  pagouAntecipado: Oportunidade[];
  /** quantos há de verdade em cada lista (as listas mostram só as primeiras) */
  totais: { naoFecharam: number; retorno60: number; verDepois: number; pagouAntecipado: number };
}
export const MAX_OPORTUNIDADES = 60;
const dm = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DIA_MS);

/** O semáforo que o contato já traz (`semaforo`), senão pelo tempo desde a consulta: 7+ dias vermelho, 3–6 amarelo, menos verde. */
export function semaforoDe(c: any, dia: string): Semaforo {
  const s = str(contatoDe(c).semaforo).toLowerCase();
  if (s.startsWith('verm') || s === 'red') return 'Vermelho';
  if (s.startsWith('amar') || s === 'yellow') return 'Amarelo';
  if (s.startsWith('verd') || s === 'green') return 'Verde';
  const consulta = data10(atributosDe(c).data_consulta);
  const ref = consulta || (Number(c?.last_activity_at) ? diaEmBelem(Number(c.last_activity_at) * 1000) : dia);
  const dias = diasEntre(ref, dia);
  return dias >= 7 ? 'Vermelho' : dias >= 3 ? 'Amarelo' : 'Verde';
}
const PESO_SEMAFORO: Record<Semaforo, number> = { Vermelho: 0, Amarelo: 1, Verde: 2 };

const ETAPAS_ENCERRADAS = new Set(['Compareceu', 'Fechou', 'Pós-consulta', 'Perdido', 'Frio']);
const SITUACOES_ENCERRADAS = new Set(['Atendido', 'Não compareceu', 'Desmarcado', 'Remarcado']);

export function montarOportunidades(conversas: any[], agora: number): Oportunidades {
  const dia = diaEmBelem(agora);
  const nao: Array<Oportunidade & { _k: number }> = [];
  const ret: Array<Oportunidade & { _k: string }> = [];
  const ver: Array<Oportunidade & { _k: string }> = [];
  const pag: Array<Oportunidade & { _k: string }> = [];
  for (const c of conversas) {
    if (c?.status === 'resolved' && !str(atributosDe(c).etapa)) continue;
    const a = atributosDe(c);
    const et = etiquetasDe(c);
    const etapa = str(a.etapa);
    const base = { id: Number(c.id), nome: nomeDe(c), telefone: telefoneDe(c) };
    const consulta = data10(a.data_consulta);

    if ((etapa === 'Compareceu' || etapa === 'Pós-consulta') && !fechouDe(c)) {
      const sem = semaforoDe(c, dia);
      const partes = [consulta ? `Consulta ${dm(consulta)}` : 'Sem data da consulta na conversa', etapa];
      const motivo = str(a.motivo_espera);
      if (motivo) partes.push(motivo);
      nao.push({ ...base, detalhe: partes.join(' · '), semaforo: sem, _k: PESO_SEMAFORO[sem] * 1e6 + (consulta ? Date.parse(consulta) / DIA_MS - 19000 : 0) });
    }
    const alta = data10(a.data_alta);
    if (alta && somar(alta, 60) <= dia) ret.push({ ...base, detalhe: `Alta em ${dm(alta)} · há ${diasEntre(alta, dia)} dias`, semaforo: null, _k: alta });
    const retomar = data10(a.retomar_em);
    if ((retomar && retomar <= dia) || et.includes('ficou-de-ver-depois')) {
      const partes = [str(a.motivo_espera) || 'Ficou de ver depois'];
      if (retomar) partes.push(`retomar em ${dm(retomar)}`);
      ver.push({ ...base, detalhe: partes.join(' · '), semaforo: null, _k: retomar || '9999' });
    }
    if (et.includes('pagou-antecipado') && !ETAPAS_ENCERRADAS.has(etapa) && !SITUACOES_ENCERRADAS.has(str(a.situacao_consulta)) && (!consulta || consulta >= dia)) {
      const hora = str(a.hora_consulta);
      pag.push({ ...base, detalhe: consulta ? `Sinal pago · consulta ${dm(consulta)}${hora ? ` às ${hora.slice(0, 5)}` : ''}` : 'Sinal pago · consulta sem data na conversa', semaforo: null, _k: consulta || '9999' });
    }
  }
  const limpa = <T extends Oportunidade>(l: Array<T & { _k?: unknown }>): Oportunidade[] =>
    l.slice(0, MAX_OPORTUNIDADES).map(({ id, nome, telefone, detalhe, semaforo }) => ({ id, nome, telefone, detalhe, semaforo }));
  nao.sort((x, y) => x._k - y._k);
  ret.sort((x, y) => (x._k < y._k ? 1 : x._k > y._k ? -1 : 0)); // alta mais recente primeiro (mais quente)
  ver.sort((x, y) => (x._k < y._k ? -1 : x._k > y._k ? 1 : 0));
  pag.sort((x, y) => (x._k < y._k ? -1 : x._k > y._k ? 1 : 0));
  return {
    dia,
    naoFecharam: limpa(nao),
    retorno60: limpa(ret),
    verDepois: limpa(ver),
    pagouAntecipado: limpa(pag),
    totais: { naoFecharam: nao.length, retorno60: ret.length, verDepois: ver.length, pagouAntecipado: pag.length },
  };
}

// ── conta do anúncio (envs) ─────────────────────────────────────────────────────────────────────

/** `doutor-hernia-parauapebas` → `PARAUAPEBAS` (o mesmo nome que o rastreio de campanhas usa em `META_ADS_TOKEN_<UNIDADE>`). */
export function sufixoDaUnidade(slug: string): string {
  return slug.replace(/^doutor-hernia-/, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export function credenciaisDeAnuncio(
  slug: string,
  env: Record<string, string | undefined>,
  /** o token de anúncios da unidade no banco (units.meta_access_token, de onde o rastreio copia para o n8n): vale quando não há env */
  tokenDaUnidade: string | null = null,
): { token: string; conta: string } | { falta: string[] } {
  const suf = sufixoDaUnidade(slug);
  const nomeToken = `META_ADS_TOKEN_${suf}`;
  const nomeConta = `META_ADS_CONTA_${suf}`;
  const token = ((env[nomeToken] ?? '').trim() || (tokenDaUnidade ?? '').trim());
  const conta = (env[nomeConta] ?? '').trim().replace(/^act_/i, '');
  const falta: string[] = [];
  if (!token) falta.push(nomeToken);
  if (!/^\d{5,25}$/.test(conta)) falta.push(nomeConta);
  return falta.length ? { falta } : { token, conta };
}

