/**
 * A parte "análise" do relatório das 18h: o que a chefe pediu além do placar do dia (30/09/2026) —
 * leads quentes e qualificados, quem agendou e faltou, a principal objeção e o pagamento antecipado.
 *
 * Tudo aqui sai dos CAMPOS DO CARTÃO no Kommo, numa janela de 7 dias. Por quê cada escolha:
 *
 * - **7 dias, não o dia.** Num dia só a amostra de objeção ou de falta é de 0, 1, 2 casos: não dá
 *   para dizer "a principal objeção" com isso. O placar do dia continua vindo da franquia.
 * - **Pagamento antecipado só existe no Kommo.** A franquia não guarda. Por isso o cruzamento
 *   "pagou antes × compareceu" usa a `✓ Situação da consulta` do cartão, que o sincronizador copia
 *   da franquia. Em unidade sem o sincronizador ligado, essa situação é digitada pela equipe.
 * - **Dois campos de antecipado, dois significados** (medido na Serra, 30/09): `¤ Pagamento
 *   antecipado` é o paciente DIZER que vai pagar; `✓ Consulta pg antecipado` é o comprovante. Lá as 6
 *   consultas com "vai pagar = Sim" tinham "comprovante = Não" e todas foram desmarcadas. Somar os
 *   dois como se fossem a mesma coisa esconderia exatamente isso. "Pagou" aqui = comprovante.
 * - **Cobertura sempre ao lado do número.** Na Serra o motivo do não agendamento estava vazio em
 *   131 de 132 leads. "Principal objeção: Sem interesse (1)" sem dizer "registrado em 1 de 132"
 *   seria mentir por omissão.
 *
 * O Kommo não filtra por campo personalizado (`filter[custom_fields_values]` dá 400), então
 * "consulta nos últimos 7 dias" = cartão mexido nos últimos 7 dias + data da consulta dentro da
 * janela. Cartão com consulta na janela e que ninguém tocou em 7 dias fica de fora — é raro, porque
 * o sincronizador mexe no cartão quando a situação muda.
 */

/** Nomes por conta. O id muda de conta para conta; o nome (sem os símbolos) não. Mais de um = variações vistas. */
export const CAMPOS_ANALISE = {
  qualificacao: ['★ Qualificação (Quente/Morno/Frio)', '★ Qualificação'],
  motivoNaoAgendamento: ['⊘ Motivo do não agendamento'],
  dataConsulta: ['◷ Data da Consulta'],
  situacao: ['✓ Situação da consulta'],
  pgComprovante: ['✓ Consulta pg antecipado'],
  pgIntencao: ['¤ Pagamento antecipado'],
  motivoFalta: ['⊘ Motivo do no-show'],
  motivoNaoFechamento: ['⊘ Motivo de não fechamento do tratamento', '⊘ Motivo de não fechamento'],
  fechouTratamento: ['✓ Fechou tratamento'],
} as const;

export type ChaveCampo = keyof typeof CAMPOS_ANALISE;

export interface LeadDoKommo {
  id: number;
  created_at?: number;
  updated_at?: number;
  custom_fields_values?: Array<{ field_id: number; values?: Array<{ value?: unknown }> | null }> | null;
}

/** Nome do campo → id nesta conta (é o `campoPorNome` do `esquemaDaUnidade`). */
export type AchaCampo = (nome: string) => number | null;

export type Ranking = Array<[string, number]>;

/** `base` = quantos casos DEVERIAM ter o motivo (quem não agendou, quem faltou, quem não fechou). */
export interface Motivos { registradas: number; base: number; ranking: Ranking }

export interface AnaliseUnidade {
  leads: { total: number; quente: number; morno: number; frio: number; semQualificacao: number };
  objecoes: Motivos;
  consultas: { total: number; atendidas: number; faltas: number; desmarcadas: number; abertas: number; semSituacao: number };
  antecipado: {
    comprovante: number;
    disseQueIaPagar: number;
    pagou: { atendidas: number; faltas: number };
    naoPagou: { atendidas: number; faltas: number };
  };
  faltas: Motivos;
  naoFechou: Motivos;
  /** campos que esta conta não tem — o número correspondente sai zero por falta de campo, não de caso */
  camposAusentes: string[];
  /** a lista do Kommo bateu no teto de páginas: os números são um piso, não o total */
  truncado: boolean;
}

const sem = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function idsDosCampos(acha: AchaCampo): { ids: Record<ChaveCampo, number | null>; ausentes: string[] } {
  const ids = {} as Record<ChaveCampo, number | null>;
  const ausentes: string[] = [];
  for (const chave of Object.keys(CAMPOS_ANALISE) as ChaveCampo[]) {
    const nomes = CAMPOS_ANALISE[chave];
    let id: number | null = null;
    for (const n of nomes) {
      id = acha(n);
      if (id) break;
    }
    ids[chave] = id;
    if (!id) ausentes.push(nomes[0]);
  }
  return { ids, ausentes };
}

function valor(lead: LeadDoKommo, fieldId: number | null): unknown {
  if (!fieldId) return null;
  const v = lead.custom_fields_values?.find((f) => f.field_id === fieldId)?.values?.[0]?.value;
  return v === undefined || v === '' ? null : v;
}

function texto(lead: LeadDoKommo, fieldId: number | null): string | null {
  const v = valor(lead, fieldId);
  return typeof v === 'string' ? v.trim() || null : null;
}

/** Campo de data do Kommo vem como epoch em segundos (número ou texto de dígitos). */
function epoch(lead: LeadDoKommo, fieldId: number | null): number | null {
  const v = valor(lead, fieldId);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d{9,}$/.test(v)) return Number(v);
  return null;
}

const ehSim = (v: string | null) => v !== null && sem(v) === 'sim';

function ranking(valores: Array<string | null>, max = 99): Motivos {
  const cont = new Map<string, number>();
  let registradas = 0;
  for (const v of valores) {
    if (!v) continue;
    registradas++;
    cont.set(v, (cont.get(v) ?? 0) + 1);
  }
  const r = [...cont.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR')).slice(0, max);
  return { registradas, base: valores.length, ranking: r };
}

export interface EntradaAnalise {
  /** leads CRIADOS na janela */
  criados: LeadDoKommo[];
  /** leads MEXIDOS na janela (contém os criados) — de onde saem as consultas */
  mexidos: LeadDoKommo[];
  acha: AchaCampo;
  /** janela da consulta, epoch em segundos, inclusiva */
  deUnix: number;
  ateUnix: number;
  truncado: boolean;
}

export function analisar(e: EntradaAnalise): AnaliseUnidade {
  const { ids, ausentes } = idsDosCampos(e.acha);

  // ── leads e qualificação ──
  const leads = { total: 0, quente: 0, morno: 0, frio: 0, semQualificacao: 0 };
  for (const l of e.criados) {
    leads.total++;
    const q = sem(texto(l, ids.qualificacao) ?? '');
    if (q.startsWith('quente')) leads.quente++;
    else if (q.startsWith('morno')) leads.morno++;
    else if (q.startsWith('frio')) leads.frio++;
    else leads.semQualificacao++;
  }
  // base da objeção = quem NÃO agendou (sem data de consulta). Quem agendou não tem objeção a registrar,
  // e contá-lo faria a cobertura parecer pior do que é.
  const objecoes = ranking(e.criados.filter((l) => epoch(l, ids.dataConsulta) === null).map((l) => texto(l, ids.motivoNaoAgendamento)));

  // ── consultas da janela ──
  const vistos = new Set<number>();
  const consultas = e.mexidos.filter((l) => {
    if (vistos.has(l.id)) return false;
    vistos.add(l.id);
    const d = epoch(l, ids.dataConsulta);
    return d !== null && d >= e.deUnix && d <= e.ateUnix;
  });

  const c = { total: consultas.length, atendidas: 0, faltas: 0, desmarcadas: 0, abertas: 0, semSituacao: 0 };
  const antecipado = { comprovante: 0, disseQueIaPagar: 0, pagou: { atendidas: 0, faltas: 0 }, naoPagou: { atendidas: 0, faltas: 0 } };
  const motivosFalta: Array<string | null> = [];
  const motivosNaoFechou: Array<string | null> = [];

  for (const l of consultas) {
    const sit = sem(texto(l, ids.situacao) ?? '');
    const pagou = ehSim(texto(l, ids.pgComprovante));
    if (pagou) antecipado.comprovante++;
    if (ehSim(texto(l, ids.pgIntencao))) antecipado.disseQueIaPagar++;
    const grupo = pagou ? antecipado.pagou : antecipado.naoPagou;

    if (sit === 'atendido') {
      c.atendidas++;
      grupo.atendidas++;
      // só quem NÃO fechou tem motivo de não fechar
      if (!ehSim(texto(l, ids.fechouTratamento))) motivosNaoFechou.push(texto(l, ids.motivoNaoFechamento));
    } else if (sit === 'nao compareceu') {
      c.faltas++;
      grupo.faltas++;
      motivosFalta.push(texto(l, ids.motivoFalta));
    } else if (sit === 'desmarcado' || sit === 'remarcado') c.desmarcadas++;
    else if (sit === 'agendado' || sit === 'confirmado') c.abertas++;
    else c.semSituacao++;
  }

  return {
    leads,
    objecoes,
    consultas: c,
    antecipado,
    faltas: ranking(motivosFalta),
    naoFechou: ranking(motivosNaoFechou),
    camposAusentes: ausentes,
    truncado: e.truncado,
  };
}

/* ───────────── soma da rede ───────────── */

function somarRanking(listas: Ranking[], max = 99): Ranking {
  const cont = new Map<string, number>();
  for (const r of listas) for (const [k, n] of r) cont.set(k, (cont.get(k) ?? 0) + n);
  return [...cont.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR')).slice(0, max);
}

/** Soma a rede. Os rankings guardam todos os motivos; quem mostra corta no top 3. */
export function somarAnalises(as: AnaliseUnidade[]): AnaliseUnidade {
  const t: AnaliseUnidade = {
    leads: { total: 0, quente: 0, morno: 0, frio: 0, semQualificacao: 0 },
    objecoes: { registradas: 0, base: 0, ranking: [] },
    consultas: { total: 0, atendidas: 0, faltas: 0, desmarcadas: 0, abertas: 0, semSituacao: 0 },
    antecipado: { comprovante: 0, disseQueIaPagar: 0, pagou: { atendidas: 0, faltas: 0 }, naoPagou: { atendidas: 0, faltas: 0 } },
    faltas: { registradas: 0, base: 0, ranking: [] },
    naoFechou: { registradas: 0, base: 0, ranking: [] },
    camposAusentes: [],
    truncado: as.some((a) => a.truncado),
  };
  for (const a of as) {
    for (const k of Object.keys(t.leads) as Array<keyof AnaliseUnidade['leads']>) t.leads[k] += a.leads[k];
    for (const k of Object.keys(t.consultas) as Array<keyof AnaliseUnidade['consultas']>) t.consultas[k] += a.consultas[k];
    t.antecipado.comprovante += a.antecipado.comprovante;
    t.antecipado.disseQueIaPagar += a.antecipado.disseQueIaPagar;
    t.antecipado.pagou.atendidas += a.antecipado.pagou.atendidas;
    t.antecipado.pagou.faltas += a.antecipado.pagou.faltas;
    t.antecipado.naoPagou.atendidas += a.antecipado.naoPagou.atendidas;
    t.antecipado.naoPagou.faltas += a.antecipado.naoPagou.faltas;
    for (const k of ['objecoes', 'faltas', 'naoFechou'] as const) {
      t[k].registradas += a[k].registradas;
      t[k].base += a[k].base;
    }
  }
  t.objecoes.ranking = somarRanking(as.map((a) => a.objecoes.ranking));
  t.faltas.ranking = somarRanking(as.map((a) => a.faltas.ranking));
  t.naoFechou.ranking = somarRanking(as.map((a) => a.naoFechou.ranking));
  return t;
}
