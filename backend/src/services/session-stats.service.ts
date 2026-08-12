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
export async function computeSessionStats(unit: Unit, kommoLeadId: number): Promise<SessionStats> {
  const link = await prisma.spineLeadLink.findUnique({
    where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId } },
  });
  if (!link?.spineIdClient) return { ...VAZIO };

  const r = await SpineService.getClient(unit, link.spineIdClient);
  if (!r.ok || !r.data?.client) {
    logger.warn(
      { unit: unit.slug, kommoLeadId, idClient: link.spineIdClient, erro: r.ok ? 'sem cliente' : r.error },
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
