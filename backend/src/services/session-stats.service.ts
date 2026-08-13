// ============================================================================
// session-stats.service.ts — deriva os campos de SESSÃO (tratamento) a partir
// do histórico de agendamentos da franquia (Spine).
//
// A API da franquia NÃO tem um "plano de tratamento" — só o histórico de
// agendamentos (/api/clients/{id} traz `schedules` embutidos). Destes dá pra
// derivar, com segurança:
//   - proximaSessao        → próximo agendamento futuro (AGENDADO/CONFIRMADO)
//   - ultimaSessaoMarcada  → agendamento passado mais recente
//   - compareceuUltima     → status do último passado (ATENDIDO=sim / NÃO=não)
//   - faltasEmSessao       → contagem de NÃO COMPARECEU
//   - sessoesRealizadas    → contagem de ATENDIDO
//
// NÃO derivável daqui (vem do plano clínico, não da agenda): sessões PREVISTAS,
// data prevista de término, observações de sessão. Esses ficam nulos.
//
// Usado pelo endpoint /integrations/:unitSlug/session-stats/:leadId, que o n8n
// consulta pra depois dar PATCH nos campos do Kommo (backend lê, n8n escreve).
// ============================================================================

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { SpineService } from './spine.service.js';
import { createKommoClient } from './kommo.service.js';
import type { Unit } from '@prisma/client';

const { AGENDADO, CONFIRMADO, NAO_COMPARECEU, ATENDIDO } = SpineService.SPINE_STATUS;

export interface SessionStats {
  /** Achou o vínculo lead→paciente na franquia? Se false, todo o resto é nulo. */
  linked: boolean;
  /** "AAAA-MM-DDTHH:mm" no fuso da clínica, ou null. */
  proximaSessao: string | null;
  ultimaSessaoMarcada: string | null;
  /** true=compareceu, false=faltou, null=sem sessão passada legível. */
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

/**
 * Calcula as estatísticas de sessão de um lead a partir da franquia.
 * NÃO escreve no Kommo — só devolve os números (quem escreve é o n8n).
 */
export async function computeSessionStats(
  unit: Unit,
  kommoLeadId: number,
  idClientOverride?: number | null,
): Promise<SessionStats> {
  // 0) Se quem chama já sabe o idClient (ex: n8n leu o campo na listagem de
  //    leads), usa direto — evita QUALQUER chamada ao Kommo aqui. Sem isso, a
  //    sincronização em massa fazia 1 getLead por lead e o nginx do Kommo
  //    bloqueava o IP (403) na rajada.
  let idClient = idClientOverride && idClientOverride > 0 ? idClientOverride : null;

  // 1) Vínculo que a NOSSA IA criou ao agendar.
  if (!idClient) {
    const link = await prisma.spineLeadLink.findUnique({
      where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId } },
    });
    idClient = link?.spineIdClient ?? null;
  }

  // 2) Fallback (só p/ chamadas SEM idClient): campo customizado no Kommo com o
  //    idClient da franquia. Faz 1 getLead — use com parcimônia (rate-limit).
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

  // Passados e futuros, ordenados por data.
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
