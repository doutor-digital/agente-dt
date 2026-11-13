/**
 * O painel da Sofia na tela Agente do Chatwoot (pedido do João, 13/11/2026: "um dash da IA — quantas pessoas ela respondeu, quantas
 * agendou, informações importantes").
 *
 * Fontes:
 *  - RESPONDEU: `sofia_mensagem` — cada resposta pública que a Sofia mandou no Chatwoot, gravada na hora do envio. Pessoa = conversa.
 *    Conta a partir do deploy desta tela (13/11/2026).
 *  - MARCOU / PASSOU PARA A EQUIPE / PIX: `sofia_evento`, gravado onde acontece e na hora (consulta que a franquia aceitou; passagem à
 *    equipe que deu certo; Pix que SAIU para o paciente). Tentativa recusada não entra; desmarcar depois não apaga o que ela marcou.
 *  - % QUE MARCOU: marcações de conversas que ela respondeu no período ÷ pessoas respondidas (nunca passa de 100%).
 *  - À NOITE OU NO FIM DE SEMANA: respostas antes das 8h, a partir das 18h, sábado e domingo — no fuso da unidade.
 *  - AVALIAÇÕES: `sofia_avaliacao` (👍/👎 da equipe no balão).
 * Cada número vem com o período anterior do mesmo tamanho (hoje × ontem até a mesma hora; 7 × 7 dias antes; 30 × 30 antes).
 */
import { prisma } from './prisma.js';

export type Periodo = 'hoje' | '7' | '30';
const DIA_MS = 86_400_000;
const DIAS_NO_GRAFICO = 14;

export function lerPeriodo(v: unknown): Periodo {
  return v === 'hoje' || v === '30' ? v : '7';
}

export interface PartesLocais {
  /** AAAA-MM-DD no fuso */
  dia: string;
  hora: number;
  minuto: number;
  segundo: number;
  /** 0 = domingo … 6 = sábado */
  semana: number;
}

const SEMANA: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatos = new Map<string, Intl.DateTimeFormat>();

export function partesLocais(d: Date, fuso: string): PartesLocais {
  let f = formatos.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23' });
    formatos.set(fuso, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return { dia: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) % 24, minuto: Number(p.minute), segundo: Number(p.second), semana: SEMANA[p.weekday ?? 'Sun'] ?? 0 };
}

/** A janela do período e a do período anterior do mesmo tamanho. «Hoje» começa à meia-noite do fuso e compara com ontem até a mesma hora. */
export function janelas(agora: Date, periodo: Periodo, fuso: string): { inicio: Date; antesInicio: Date; antesFim: Date } {
  if (periodo === 'hoje') {
    const l = partesLocais(agora, fuso);
    const inicio = new Date(agora.getTime() - ((l.hora * 60 + l.minuto) * 60 + l.segundo) * 1000 - agora.getMilliseconds());
    return { inicio, antesInicio: new Date(inicio.getTime() - DIA_MS), antesFim: new Date(agora.getTime() - DIA_MS) };
  }
  const n = Number(periodo) * DIA_MS;
  return { inicio: new Date(agora.getTime() - n), antesInicio: new Date(agora.getTime() - 2 * n), antesFim: new Date(agora.getTime() - n) };
}

export function foraDoHorario(d: Date, fuso: string): boolean {
  const l = partesLocais(d, fuso);
  return l.semana === 0 || l.semana === 6 || l.hora < 8 || l.hora >= 18;
}

export interface RespostaDoPainel {
  conversa: number;
  criadoEm: Date;
}
export interface MarcadaDoPainel {
  conversa: number;
  nome: string | null;
  /** "AAAA-MM-DDTHH:mm" no fuso da clínica */
  agendadoPara: string | null;
  criadoEm: Date;
}
export interface AvaliacaoDoPainel {
  nota: string;
  criadoEm: Date;
}
export interface EventoDoPainel {
  conversa: number;
  tipo: string;
  criadoEm: Date;
}

export interface Par {
  agora: number;
  antes: number;
}

export interface Painel {
  periodo: Periodo;
  desde: string;
  respondidas: Par;
  respostas: number;
  marcadas: Par;
  /** marcadas de conversas respondidas no período ÷ pessoas respondidas, em % (null sem ninguém respondido) */
  conversao: { agora: number | null; antes: number | null };
  equipe: Par;
  pix: Par;
  foraDoHorario: { respostas: number; pct: number | null };
  avaliacoes: { boas: number; ruins: number; pct: number | null; pctAntes: number | null };
  porDia: Array<{ dia: string; respondidas: number; marcadas: number }>;
  ultimasMarcadas: MarcadaDoPainel[];
}

const pct = (a: number, b: number): number | null => (b > 0 ? Math.round((100 * a) / b) : null);

export function montarPainel(e: {
  respostas: readonly RespostaDoPainel[];
  marcadas: readonly MarcadaDoPainel[];
  avaliacoes: readonly AvaliacaoDoPainel[];
  eventos: readonly EventoDoPainel[];
  agora: Date;
  periodo: Periodo;
  fuso: string;
}): Painel {
  const j = janelas(e.agora, e.periodo, e.fuso);
  const t = e.agora.getTime();
  const noPeriodo = (d: Date) => d.getTime() >= j.inicio.getTime() && d.getTime() <= t;
  const noAnterior = (d: Date) => d.getTime() >= j.antesInicio.getTime() && d.getTime() < j.antesFim.getTime();
  const conjunto = (l: ReadonlyArray<{ conversa: number }>) => new Set(l.map((r) => r.conversa));

  const rAgora = e.respostas.filter((r) => noPeriodo(r.criadoEm));
  const rAntes = e.respostas.filter((r) => noAnterior(r.criadoEm));
  const mAgora = e.marcadas.filter((m) => noPeriodo(m.criadoEm));
  const mAntes = e.marcadas.filter((m) => noAnterior(m.criadoEm));
  const aAgora = e.avaliacoes.filter((a) => noPeriodo(a.criadoEm));
  const aAntes = e.avaliacoes.filter((a) => noAnterior(a.criadoEm));
  const quemAgora = conjunto(rAgora);
  const quemAntes = conjunto(rAntes);
  const respondidas = { agora: quemAgora.size, antes: quemAntes.size };
  const marcadas = { agora: mAgora.length, antes: mAntes.length };
  // a conversão só conta consulta de quem ela respondeu no período: o vínculo da franquia tem histórico e a contagem de respostas
  // começou em 13/11 — sem isso o número passava de 100% na primeira semana
  const marcouDeQuem = (l: MarcadaDoPainel[], quem: Set<number>) => l.filter((m) => quem.has(m.conversa)).length;
  const eventos = (tipo: string, filtro: (d: Date) => boolean) => conjunto(e.eventos.filter((x) => x.tipo === tipo && filtro(x.criadoEm))).size;
  const fora = rAgora.filter((r) => foraDoHorario(r.criadoEm, e.fuso)).length;
  const boas = aAgora.filter((a) => a.nota === 'boa').length;
  const ruins = aAgora.filter((a) => a.nota === 'ruim').length;

  // gráfico: os últimos 14 dias no fuso da unidade (pessoas respondidas e consultas marcadas em cada dia)
  const hoje = partesLocais(e.agora, e.fuso).dia;
  const dias: string[] = [];
  for (let i = DIAS_NO_GRAFICO - 1; i >= 0; i--) dias.push(partesLocais(new Date(t - i * DIA_MS), e.fuso).dia);
  if (dias[dias.length - 1] !== hoje) dias.push(hoje);
  const porDiaR = new Map<string, Set<number>>();
  for (const r of e.respostas) {
    const d = partesLocais(r.criadoEm, e.fuso).dia;
    if (!porDiaR.has(d)) porDiaR.set(d, new Set());
    porDiaR.get(d)!.add(r.conversa);
  }
  const porDiaM = new Map<string, number>();
  for (const m of e.marcadas) {
    const d = partesLocais(m.criadoEm, e.fuso).dia;
    porDiaM.set(d, (porDiaM.get(d) ?? 0) + 1);
  }

  return {
    periodo: e.periodo,
    desde: j.inicio.toISOString(),
    respondidas,
    respostas: rAgora.length,
    marcadas,
    conversao: { agora: pct(marcouDeQuem(mAgora, quemAgora), respondidas.agora), antes: pct(marcouDeQuem(mAntes, quemAntes), respondidas.antes) },
    equipe: { agora: eventos('equipe', noPeriodo), antes: eventos('equipe', noAnterior) },
    pix: { agora: eventos('pix', noPeriodo), antes: eventos('pix', noAnterior) },
    foraDoHorario: { respostas: fora, pct: pct(fora, rAgora.length) },
    avaliacoes: { boas, ruins, pct: pct(boas, boas + ruins), pctAntes: pct(aAntes.filter((a) => a.nota === 'boa').length, aAntes.length) },
    porDia: [...new Set(dias)].map((dia) => ({ dia, respondidas: porDiaR.get(dia)?.size ?? 0, marcadas: porDiaM.get(dia) ?? 0 })),
    ultimasMarcadas: [...mAgora].sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime()).slice(0, 10),
  };
}

/** Lê o que o painel precisa (o maior entre o período anterior e os 14 dias do gráfico) e monta. */
export async function painelDaUnidade(unit: { id: string; slug: string; spineTimezone: string | null }, periodo: Periodo, agora = new Date()): Promise<Painel> {
  const fuso = unit.spineTimezone ?? 'America/Sao_Paulo';
  const j = janelas(agora, periodo, fuso);
  const desde = new Date(Math.min(j.antesInicio.getTime(), agora.getTime() - (DIAS_NO_GRAFICO + 1) * DIA_MS));
  const [respostas, avaliacoes, eventos] = await Promise.all([
    prisma.sofiaMensagem.findMany({ where: { unitSlug: unit.slug, criadoEm: { gte: desde } }, select: { conversa: true, criadoEm: true } }),
    prisma.sofiaAvaliacao.findMany({ where: { unitSlug: unit.slug, criadoEm: { gte: desde } }, select: { nota: true, criadoEm: true } }),
    prisma.sofiaEvento.findMany({ where: { unitSlug: unit.slug, criadoEm: { gte: desde } }, select: { conversa: true, tipo: true, nome: true, detalhe: true, criadoEm: true } }),
  ]);
  return montarPainel({
    respostas,
    marcadas: eventos.filter((e) => e.tipo === 'marcou').map((e) => ({ conversa: e.conversa, nome: e.nome, agendadoPara: e.detalhe, criadoEm: e.criadoEm })),
    avaliacoes,
    eventos,
    agora,
    periodo,
    fuso,
  });
}
