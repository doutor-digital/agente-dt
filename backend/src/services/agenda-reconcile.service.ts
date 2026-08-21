import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { SpineService } from './spine.service.js';

export type EstadoConsulta = 'confirmada' | 'cancelada' | 'nao_confirmada';

export interface ConsultaReconciliada {
  idSchedule: number;
  quando: string | null;
  salvo: string | null;
  estado: EstadoConsulta;
  mudou: boolean;
  especialista: string | null;
}

const JANELA_DIAS = 90;

const TTL_MS = 60_000;
const MAX_ENTRADAS = 5_000;
const cache = new Map<string, { em: number; valor: ConsultaReconciliada | null }>();

function chave(unitId: string, kommoLeadId: number): string {
  return `${unitId}:${kommoLeadId}`;
}

function podar(): void {
  if (cache.size < MAX_ENTRADAS) return;
  const agora = Date.now();
  for (const [k, v] of cache) if (agora - v.em >= TTL_MS) cache.delete(k);
  if (cache.size >= MAX_ENTRADAS) {
    const sobrando = cache.size - Math.floor(MAX_ENTRADAS / 2);
    let i = 0;
    for (const k of cache.keys()) {
      if (i++ >= sobrando) break;
      cache.delete(k);
    }
  }
}

export function esqueceConsulta(unitId: string, kommoLeadId: number): void {
  cache.delete(chave(unitId, kommoLeadId));
}

function hojeNaClinica(unit: Unit): string {
  return SpineService.instanteNoFuso(new Date(), unit.spineTimezone || 'America/Sao_Paulo').slice(0, 10);
}

function somarDias(dia: string, n: number): string {
  const t = Date.parse(`${dia}T00:00:00Z`);
  if (Number.isNaN(t)) return dia;
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

interface Achado {
  dia: string | null;
  hora: string | null;
  idStatus: number | null;
  especialista: string | null;
}

async function pelosAgendamentosDoPaciente(
  unit: Unit,
  idClient: number,
  idSchedule: number,
): Promise<Achado | null> {
  const r = await SpineService.getClient(unit, idClient);
  if (!r.ok || !r.data?.client) return null;
  const s = r.data.client.schedules.find((x) => x.idSchedule === idSchedule);
  if (!s) return null;
  return {
    dia: s.dayLocal,
    hora: s.timeLocal,
    idStatus: s.idStatus,
    especialista: s.physicalTherapist?.trim() || null,
  };
}

async function procurar(
  unit: Unit,
  idSchedule: number,
  de: string,
  ate: string,
): Promise<Achado | null> {
  const r = await SpineService.searchSchedules(unit, {
    initialDate: de,
    endDate: ate,
    rowsPerPage: 100,
  });
  if (!r.ok || !r.data) return null;
  const achado = r.data.schedules.find((s) => s.idSchedule === idSchedule);
  if (!achado) return null;
  return {
    dia: achado.dayLocal,
    hora: achado.timeLocal,
    idStatus: achado.idStatus,
    especialista: achado.physicalTherapist?.trim() || null,
  };
}

export async function consultaDoLead(
  unit: Unit,
  kommoLeadId: number | undefined,
): Promise<ConsultaReconciliada | null> {
  if (!kommoLeadId || !Number.isFinite(kommoLeadId)) return null;

  const k = chave(unit.id, kommoLeadId);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.em < TTL_MS) return hit.valor;

  const valor = await reconciliar(unit, kommoLeadId);
  podar();
  cache.set(k, { em: Date.now(), valor });
  return valor;
}

async function reconciliar(unit: Unit, kommoLeadId: number): Promise<ConsultaReconciliada | null> {
  const link = await prisma.spineLeadLink.findFirst({
    where: { unitId: unit.id, kommoLeadId },
  });
  if (!link?.spineIdSchedule) return null;

  const base: ConsultaReconciliada = {
    idSchedule: link.spineIdSchedule,
    quando: link.agendadoPara,
    salvo: link.agendadoPara,
    estado: 'nao_confirmada',
    mudou: false,
    especialista: null,
  };

  if (!unit.spineEnabled || !unit.spineToken) return base;

  try {

    const dia = link.agendadoPara?.slice(0, 10) ?? null;
    let achado = dia ? await procurar(unit, link.spineIdSchedule, dia, dia) : null;

    if (!achado) {
      const hoje = hojeNaClinica(unit);
      achado = await procurar(unit, link.spineIdSchedule, hoje, somarDias(hoje, JANELA_DIAS));
    }

    if (!achado && link.spineIdClient) {
      achado = await pelosAgendamentosDoPaciente(unit, link.spineIdClient, link.spineIdSchedule);
    }

    if (!achado) {
      logger.warn(
        { unit: unit.slug, kommoLeadId, idSchedule: link.spineIdSchedule, salvo: link.agendadoPara },
        'agenda: consulta não encontrada na franquia — horário não confirmado',
      );
      return base;
    }

    if (achado.idStatus === SpineService.SPINE_STATUS.DESMARCADO) {
      await prisma.spineLeadLink
        .update({ where: { id: link.id }, data: { spineIdSchedule: null, agendadoPara: null } })
        .catch(() => undefined);
      logger.warn(
        { unit: unit.slug, kommoLeadId, idSchedule: link.spineIdSchedule, salvo: link.agendadoPara },
        'agenda: consulta desmarcada na franquia — vínculo limpo',
      );
      return { ...base, estado: 'cancelada', quando: null, mudou: true, especialista: achado.especialista };
    }

    if (!achado.dia || !achado.hora) return base;

    const agora = `${achado.dia}T${achado.hora}`;
    const mudou = agora !== link.agendadoPara;

    if (mudou) {
      await prisma.spineLeadLink
        .update({ where: { id: link.id }, data: { agendadoPara: agora } })
        .catch(() => undefined);
      logger.warn(
        { unit: unit.slug, kommoLeadId, idSchedule: link.spineIdSchedule, de: link.agendadoPara, para: agora },
        'agenda: a franquia remarcou — horário local atualizado',
      );
    }

    return {
      ...base,
      quando: agora,
      estado: 'confirmada',
      mudou,
      especialista: achado.especialista,
    };
  } catch (err) {
    logger.warn(
      { err: String(err), unit: unit.slug, kommoLeadId },
      'agenda: falha ao conferir consulta na franquia',
    );
    return base;
  }
}

export function porExtenso(quando: string | null | undefined): string {
  if (!quando) return 'a consulta marcada';
  const [dia, hora] = quando.split('T');
  const [a, m, d] = dia.split('-');
  if (!a || !m || !d) return quando;
  return `${d}/${m}/${a}${hora ? ` às ${hora}` : ''}`;
}

export const AgendaReconcileService = {
  consultaDoLead,
  esqueceConsulta,
  porExtenso,
};
