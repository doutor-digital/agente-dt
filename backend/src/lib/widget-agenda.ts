/**
 * Ponte só-leitura pros widgets privados do Kommo (16/09/2026, pedido do João:
 * "Agenda da franquia dentro do cartão… a verdade que hoje só o sincronizador enxerga").
 *
 * Aqui fica a parte pura: a chave por unidade e o resumo da agenda do paciente a
 * partir dos agendamentos que a franquia devolve em `getClient`. A rota HTTP está
 * em `controllers/widget-franquia.controller.ts`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';
import { ehConsulta } from './franquia-sync.js';

/**
 * Chave do widget por unidade: HMAC do slug com o segredo de sessão. Não vai pro
 * banco (nada de migration) e não muda enquanto o segredo não mudar. O João digita
 * essa chave nas configurações do widget ao instalar em cada conta.
 */
export function chaveDoWidget(slug: string, segredo: string): string {
  return createHmac('sha256', segredo).update(`widget:${slug}`).digest('hex').slice(0, 24);
}

export function chaveConfere(slug: string, segredo: string, recebida: unknown): boolean {
  if (typeof recebida !== 'string') return false;
  const a = Buffer.from(chaveDoWidget(slug, segredo));
  const b = Buffer.from(recebida.trim().slice(0, 24).padEnd(24, ' '));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** "Sandra da Cruz 27/5/26" / "SANDRA MARIA 03/08/2026" → "Sandra da Cruz": o padrão da casa põe a data do 1º contato no nome. */
export function limparNome(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*$/g, '')
    .replace(/^lead\s*#?\d+$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Termos pra buscar o paciente na franquia, do mais específico pro mais largo, sem repetição:
 * título limpo, nome do contato limpo, "primeiro último" e só o primeiro nome. A busca da franquia é por
 * nome; quem decide é o telefone (8 últimos dígitos) — medido em 16/09 com um paciente em tratamento que a
 * busca por "Sandra da Cruz 27/5/26" não achava.
 */
export function termosDeBusca(titulo: string, nome: string): string[] {
  const t = limparNome(titulo), n = limparNome(nome);
  const partes = (s: string) => s.split(' ').filter(Boolean);
  const cand = [t, n];
  for (const s of [t, n]) {
    const p = partes(s);
    if (p.length >= 2) cand.push(`${p[0]} ${p[p.length - 1]}`);
    if (p.length >= 1) cand.push(p[0]);
  }
  return cand.map((c) => c.trim()).filter((c, i, a) => c.length >= 3 && a.indexOf(c) === i);
}

// ── "Números da unidade": janela do período e resumo da auditoria do dashboard ──
export type PeriodoWidget = 'hoje' | 'semana' | 'mes' | 'custom';

/** Janela explícita (`de`/`ate` em yyyy-mm-dd, até 92 dias) — o widget usa pra comparar com o período anterior. */
export function janelaExplicita(de: unknown, ate: unknown): { tipo: 'custom'; de: string; ate: string } | null {
  if (typeof de !== 'string' || typeof ate !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) return null;
  const a = Date.parse(`${de}T00:00:00Z`), b = Date.parse(`${ate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a || (b - a) / 86_400_000 > 92) return null;
  return { tipo: 'custom', de, ate };
}

function dataLocal(agora: Date, tz: string): { ano: number; mes: number; dia: number; diaSemana: number } {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(agora);
  const pega = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  const semana = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(pega('weekday'));
  return { ano: Number(pega('year')), mes: Number(pega('month')), dia: Number(pega('day')), diaSemana: semana < 0 ? 0 : semana };
}
function iso(ano: number, mes: number, dia: number): string {
  const d = new Date(Date.UTC(ano, mes - 1, dia));   // normaliza dia 0 / negativo (volta pro mês anterior)
  return d.toISOString().slice(0, 10);
}

/** Janela em datas locais (yyyy-mm-dd) do período pedido: hoje, semana (segunda→hoje) ou mês (dia 1→hoje). */
export function janelaDoPeriodo(periodo: string | undefined, agora: Date, tz: string): { tipo: PeriodoWidget; de: string; ate: string } {
  const { ano, mes, dia, diaSemana } = dataLocal(agora, tz);
  const hoje = iso(ano, mes, dia);
  if (periodo === 'semana') {
    const recuo = (diaSemana + 6) % 7;   // segunda = 0 dias de recuo
    return { tipo: 'semana', de: iso(ano, mes, dia - recuo), ate: hoje };
  }
  if (periodo === 'mes') return { tipo: 'mes', de: iso(ano, mes, 1), ate: hoje };
  return { tipo: 'hoje', de: hoje, ate: hoje };
}

const TITULOS_KPI: Record<string, string> = {
  agendamentos: 'Agendamentos',
  consultas: 'Consultas realizadas',
  tratamentos: 'Tratamentos fechados',
  receita: 'Receita (R$)',
  leads_qualificados: 'Leads qualificados',
  no_show: 'Faltas (no-show)',
};

export interface NumeroWidget {
  kpi: string;
  titulo: string;
  fonte: string;
  numero: number;
  conferencia: number | null;
  leitura: string | null;
  cobertura: { percentual: number; nota: string } | null;
  quebra: Array<{ rotulo: string; quantidade: number; valor: number | null }>;
  divergentes: Array<{ nome: string; motivo: string }>;
  maisDivergentes: number;   // quantos ficaram de fora do corte
}

/** Achata a resposta de `internal/audit/kpis` do dashboard no que o widget mostra (nomes, sem ids internos). */
export function resumirAuditoria(json: unknown, maxDivergentes = 30): { totalDivergencias: number; numeros: NumeroWidget[] } {
  const j = (json ?? {}) as { totalDivergencias?: number; blocos?: unknown[] };
  const blocos = Array.isArray(j.blocos) ? j.blocos : [];
  const numeros = blocos.map((raw) => {
    const b = raw as Record<string, unknown>;
    const div = Array.isArray(b.divergentes) ? (b.divergentes as Array<Record<string, unknown>>) : [];
    const cob = b.cobertura as Record<string, unknown> | null | undefined;
    const kpi = String(b.kpi ?? '');
    return {
      kpi,
      titulo: TITULOS_KPI[kpi] ?? kpi,
      fonte: String(b.fonte ?? ''),
      numero: Number(b.numero ?? 0),
      conferencia: typeof b.conferencia === 'number' ? b.conferencia : null,
      leitura: typeof b.leitura === 'string' ? b.leitura : null,
      cobertura: cob && typeof cob.percentual === 'number' ? { percentual: cob.percentual, nota: String(cob.nota ?? '') } : null,
      quebra: (Array.isArray(b.quebra) ? (b.quebra as Array<Record<string, unknown>>) : []).map((q) => ({
        rotulo: String(q.rotulo ?? ''), quantidade: Number(q.quantidade ?? 0), valor: typeof q.valor === 'number' ? q.valor : null,
      })),
      divergentes: div.slice(0, maxDivergentes).map((d) => ({ nome: String(d.nome ?? '(sem nome)'), motivo: String(d.motivo ?? '') })),
      maisDivergentes: Math.max(0, div.length - maxDivergentes),
    };
  });
  return { totalDivergencias: Number(j.totalDivergencias ?? numeros.reduce((s, n) => s + n.divergentes.length + n.maisDivergentes, 0)), numeros };
}

export interface ConsultaResumo {
  idSchedule: number | null;
  quando: string | null;        // ISO UTC
  dia: string | null;           // dd/mm local
  hora: string | null;          // HH:MM local
  categoria: string | null;
  status: string | null;        // nome que a franquia dá (AGENDADO, CONFIRMADO, ATENDIDO, NÃO COMPARECEU, DESMARCADO…)
  idStatus: number | null;
  fisioterapeuta: string | null;
  futura: boolean;
}

export interface ResumoAgenda {
  proximaConsulta: ConsultaResumo | null;      // avaliação/retorno futura ainda de pé (agendada ou confirmada)
  ultimaConsulta: ConsultaResumo | null;       // avaliação/retorno mais recente que já passou
  proximaSessao: ConsultaResumo | null;        // sessão futura de pé
  ultimaSessao: ConsultaResumo | null;         // sessão passada mais recente
  sessoes: { realizadas: number; faltas: number; futuras: number };
  consultas: ConsultaResumo[];                 // todas as avaliações/retornos, da mais nova pra mais velha (máx. 8)
  temConsultaFutura: boolean;                  // o que a GUARDA DA ETAPA usa: "tem consulta marcada"
}

const DE_PE = new Set<number>([SPINE_STATUS.AGENDADO, SPINE_STATUS.CONFIRMADO, SPINE_STATUS.REMARCADO]);

function paraResumo(s: SpineSchedule, agora: Date): ConsultaResumo {
  const t = s.dateAttendanceUtc ? Date.parse(s.dateAttendanceUtc) : NaN;
  const dia = s.dayLocal ? s.dayLocal.split('-').reverse().slice(0, 2).join('/') : null;   // yyyy-mm-dd → dd/mm
  return {
    idSchedule: s.idSchedule,
    quando: Number.isFinite(t) ? new Date(t).toISOString() : null,
    dia,
    hora: s.timeLocal ?? null,
    categoria: s.categoryName,
    status: s.statusName,
    idStatus: s.idStatus,
    fisioterapeuta: s.physicalTherapist,
    futura: Number.isFinite(t) && t > agora.getTime(),
  };
}

export function resumoDaAgenda(schedules: SpineSchedule[], agora: Date = new Date()): ResumoAgenda {
  const itens = schedules
    .filter((s) => s.dateAttendanceUtc && Number.isFinite(Date.parse(s.dateAttendanceUtc)))
    .map((s) => ({ s, r: paraResumo(s, agora) }))
    .sort((a, b) => Date.parse(b.r.quando!) - Date.parse(a.r.quando!));   // mais nova primeiro

  const consultas = itens.filter((x) => ehConsulta(x.s));
  const sessoes = itens.filter((x) => !ehConsulta(x.s));
  const dePe = (x: { r: ConsultaResumo }) => x.r.idStatus !== null && DE_PE.has(x.r.idStatus);

  const futurasConsultas = consultas.filter((x) => x.r.futura && dePe(x)).sort((a, b) => Date.parse(a.r.quando!) - Date.parse(b.r.quando!));
  const passadasConsultas = consultas.filter((x) => !x.r.futura);
  const futurasSessoes = sessoes.filter((x) => x.r.futura && dePe(x)).sort((a, b) => Date.parse(a.r.quando!) - Date.parse(b.r.quando!));
  const passadasSessoes = sessoes.filter((x) => !x.r.futura);

  return {
    proximaConsulta: futurasConsultas[0]?.r ?? null,
    ultimaConsulta: passadasConsultas[0]?.r ?? null,
    proximaSessao: futurasSessoes[0]?.r ?? null,
    ultimaSessao: passadasSessoes[0]?.r ?? null,
    sessoes: {
      realizadas: sessoes.filter((x) => x.r.idStatus === SPINE_STATUS.ATENDIDO).length,
      faltas: sessoes.filter((x) => x.r.idStatus === SPINE_STATUS.NAO_COMPARECEU).length,
      futuras: futurasSessoes.length,
    },
    consultas: consultas.slice(0, 8).map((x) => x.r),
    temConsultaFutura: futurasConsultas.length > 0,
  };
}
