import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { SpineService } from './spine.service.js';
import { createKommoClient } from './kommo.service.js';
import type { Unit } from '@prisma/client';

const { AGENDADO, CONFIRMADO, NAO_COMPARECEU, ATENDIDO } = SpineService.SPINE_STATUS;

export interface SessionStats {
  linked: boolean;
  proximaSessao: string | null;
  ultimaSessaoMarcada: string | null;
  compareceuUltima: boolean | null;
  faltasEmSessao: number;
  sessoesRealizadas: number;
}

const VAZIO: SessionStats = {
  linked: false,
  proximaSessao: null,
  ultimaSessaoMarcada: null,
  compareceuUltima: null,
  faltasEmSessao: 0,
  sessoesRealizadas: 0,
};

export async function computeSessionStats(
  unit: Unit,
  kommoLeadId: number,
  idClientOverride?: number | null,
): Promise<SessionStats> {
  let idClient = idClientOverride && idClientOverride > 0 ? idClientOverride : null;

  if (!idClient) {
    const link = await prisma.spineLeadLink.findUnique({
      where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId } },
    });
    idClient = link?.spineIdClient ?? null;
  }

  if (!idClient) {
    const fieldId = (unit.pipelineIntents as Record<string, number> | null)?.spine_client_field_id;
    if (fieldId) {
      try {
        const lead = await createKommoClient(unit).getLead(kommoLeadId);
        const cfv = (lead as { custom_fields_values?: Array<{ field_id: number; values?: Array<{ value?: unknown }> }> })
          .custom_fields_values;
        const raw = cfv?.find((f) => f.field_id === fieldId)?.values?.[0]?.value;
        const n = Number(raw);
        if (Number.isInteger(n) && n > 0) idClient = n;
      } catch (err) {
        logger.warn({ err: String(err), kommoLeadId, unit: unit.slug }, 'session-stats: falha lendo campo idClient no Kommo');
      }
    }
  }

  if (!idClient) return { ...VAZIO };

  const r = await SpineService.getClient(unit, idClient);
  if (!r.ok || !r.data?.client) {
    logger.warn(
      { unit: unit.slug, kommoLeadId, idClient, erro: r.ok ? 'sem cliente' : r.error },
      'session-stats: falha ao ler paciente na franquia',
    );
    return { ...VAZIO, linked: true };
  }

  const schedules = r.data.client.schedules.filter((s) => s.dateAttendanceUtc);
  const agora = Date.now();

  const passados = schedules
    .filter((s) => Date.parse(s.dateAttendanceUtc as string) <= agora)
    .sort((a, b) => Date.parse(b.dateAttendanceUtc as string) - Date.parse(a.dateAttendanceUtc as string));
  const futuros = schedules
    .filter((s) => Date.parse(s.dateAttendanceUtc as string) > agora)
    .sort((a, b) => Date.parse(a.dateAttendanceUtc as string) - Date.parse(b.dateAttendanceUtc as string));

  const proxima = futuros.find((s) => s.idStatus === AGENDADO || s.idStatus === CONFIRMADO) ?? null;
  const ultima = passados[0] ?? null;

  const compareceuUltima =
    ultima == null
      ? null
      : ultima.idStatus === ATENDIDO
        ? true
        : ultima.idStatus === NAO_COMPARECEU
          ? false
          : null;

  return {
    linked: true,
    proximaSessao: proxima?.dateAttendanceLocal ?? null,
    ultimaSessaoMarcada: ultima?.dateAttendanceLocal ?? null,
    compareceuUltima,
    faltasEmSessao: schedules.filter((s) => s.idStatus === NAO_COMPARECEU).length,
    sessoesRealizadas: schedules.filter((s) => s.idStatus === ATENDIDO).length,
  };
}
