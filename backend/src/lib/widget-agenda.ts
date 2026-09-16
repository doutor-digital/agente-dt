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
