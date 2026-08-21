import type { Unit } from '@prisma/client';
import type { KommoLead, KommoPipeline } from './kommo.service.js';
import { createKommoClient } from './kommo.service.js';
import { logger } from '../lib/logger.js';

export interface EstadoEtapaLead {
  statusId: number;
  nome: string;
  jaAgendadoOuPaciente: boolean;
}

const ETAPA_TTL_MS = 90_000;
const PIPE_TTL_MS = 10 * 60_000;

const pipeCache = new Map<string, { em: number; pipes: KommoPipeline[] }>();
const etapaCache = new Map<string, { em: number; valor: EstadoEtapaLead | null }>();

async function pipelinesDaUnidade(unit: Unit): Promise<KommoPipeline[]> {
  const hit = pipeCache.get(unit.id);
  if (hit && Date.now() - hit.em < PIPE_TTL_MS) return hit.pipes;
  const pipes = await createKommoClient(unit).listPipelines();
  pipeCache.set(unit.id, { em: Date.now(), pipes });
  return pipes;
}

function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function temConsultaMarcadaNoCampo(lead: KommoLead): boolean {
  const campos = lead.custom_fields_values ?? [];
  const limiar = Math.floor(Date.now() / 1000) - 24 * 3600;
  for (const f of campos) {
    const nome = normalizar(f.field_name ?? '');
    const ehCampoDeConsulta =
      nome.includes('data') && (nome.includes('consulta') || nome.includes('agendamento'));
    if (!ehCampoDeConsulta) continue;
    const raw = f.values?.[0]?.value;
    const ts = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(ts) && ts >= limiar) return true;
  }
  return false;
}

function classificar(
  unit: Unit,
  pipes: KommoPipeline[],
  pipelineId: number | undefined,
  statusId: number,
): EstadoEtapaLead {
  const pipe =
    pipes.find((p) => p.id === pipelineId) ??
    pipes.find((p) => p.statuses?.some((s) => s.id === statusId));
  const status = pipe?.statuses?.find((s) => s.id === statusId);
  const nome = status?.name?.trim() || `etapa ${statusId}`;
  const semAgenda = (v: boolean): EstadoEtapaLead => ({ statusId, nome, jaAgendadoOuPaciente: v });

  if (statusId === 143 || status?.type === 143) return semAgenda(false);
  if (statusId === 142 || status?.type === 142) return semAgenda(true);
  if (pipe && /tratamento/i.test(pipe.name || '')) return semAgenda(true);

  const intents = unit.pipelineIntents as Record<string, unknown> | null;
  const anchorId = Number(intents?.scheduled_meeting) || null;
  let anchorSort: number | null = null;
  if (pipe?.statuses) {
    const anchor =
      pipe.statuses.find((s) => s.id === anchorId) ??
      pipe.statuses.find((s) => /^\s*agendad/i.test(s.name || ''));
    anchorSort = anchor?.sort ?? null;
  }
  const leadSort = status?.sort ?? null;
  const jaAgendado = anchorSort != null && leadSort != null && leadSort >= anchorSort;
  return semAgenda(jaAgendado);
}

export async function estadoEtapaDoLead(
  unit: Unit,
  leadId: number | undefined,
): Promise<EstadoEtapaLead | null> {
  if (!leadId || !Number.isFinite(leadId)) return null;

  const key = `${unit.id}:${leadId}`;
  const hit = etapaCache.get(key);
  if (hit && Date.now() - hit.em < ETAPA_TTL_MS) return hit.valor;

  let valor: EstadoEtapaLead | null = null;
  try {
    const lead = await createKommoClient(unit).getLead(leadId);
    if (lead?.status_id) {
      const pipes = await pipelinesDaUnidade(unit);
      valor = classificar(unit, pipes, lead.pipeline_id, lead.status_id);
    }
    if (lead && temConsultaMarcadaNoCampo(lead)) {
      valor = valor
        ? { ...valor, jaAgendadoOuPaciente: true }
        : { statusId: lead.status_id ?? 0, nome: 'com consulta marcada', jaAgendadoOuPaciente: true };
    }
  } catch (err) {
    logger.warn(
      { err: String(err), unit: unit.slug, leadId },
      'estadoEtapaDoLead falhou — sem bloco de etapa no prompt',
    );
    valor = null;
  }

  if (etapaCache.size > 5000) etapaCache.clear();
  etapaCache.set(key, { em: Date.now(), valor });
  return valor;
}
