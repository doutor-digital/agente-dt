// ============================================================================
// lead-stage.service.ts — A ETAPA REAL do lead, lida do Kommo.
//
// O PROBLEMA
// ----------
// A IA e seus workers tratam o banco DELA como se fosse a verdade completa. Nas
// unidades novas isso é perigoso: os MILHARES de leads migrados do sistema
// antigo têm estado real (já agendado, já em tratamento) que existe SÓ no Kommo
// — não no banco da IA. Foi assim que, em Parauapebas, a IA disse "não quero te
// deixar sem sua consulta" pra um paciente que JÁ estava agendado: ela não tinha
// como saber, porque o agendamento foi feito no sistema antigo, antes dela.
//
// A SOLUÇÃO
// ---------
// A fonte de verdade que funciona pro lead legado é a ETAPA do Kommo: a migração
// colocou os agendados em AGENDADO/Compareceu/Ganho e os pacientes em TRATAMENTO.
// Aqui a gente lê a etapa atual do lead e responde UMA pergunta:
//   "esse paciente JÁ agendou ou já é paciente?" (→ não tratar como novo)
//
// Conservador de propósito: só devolve `jaAgendadoOuPaciente=true` quando há
// certeza (etapa agendada+ no comercial, ganho, ou pipeline de tratamento).
// Na dúvida, devolve false — nunca atrapalha um lead de verdade novo.
//
// Cache: pipelines por unidade (mudam raro) e a etapa por lead (curto), pra não
// bater no Kommo em todo turno da mesma conversa.
// ============================================================================

import type { Unit } from '@prisma/client';
import type { KommoPipeline } from './kommo.service.js';
import { createKommoClient } from './kommo.service.js';
import { logger } from '../lib/logger.js';

export interface EstadoEtapaLead {
  statusId: number;
  /** Nome da etapa no Kommo (ex.: "AGENDADO", "EM TRATAMENTO"). */
  nome: string;
  /** true = o lead JÁ agendou ou já é paciente — não tratar como contato novo. */
  jaAgendadoOuPaciente: boolean;
}

const ETAPA_TTL_MS = 90_000; // etapa do lead: cache curto por lead
const PIPE_TTL_MS = 10 * 60_000; // pipelines: mudam raramente

const pipeCache = new Map<string, { em: number; pipes: KommoPipeline[] }>();
const etapaCache = new Map<string, { em: number; valor: EstadoEtapaLead | null }>();

async function pipelinesDaUnidade(unit: Unit): Promise<KommoPipeline[]> {
  const hit = pipeCache.get(unit.id);
  if (hit && Date.now() - hit.em < PIPE_TTL_MS) return hit.pipes;
  const pipes = await createKommoClient(unit).listPipelines();
  pipeCache.set(unit.id, { em: Date.now(), pipes });
  return pipes;
}

/**
 * Classifica a etapa do lead. `type` 142 = Ganho e 143 = Perdido são IDs de
 * SISTEMA (iguais em toda conta). Perdido NÃO conta como "agendado" — quem trata
 * Perdido é a IA de resgate. Dentro do comercial, "agendado ou depois" é medido
 * pela posição (`sort`) contra a etapa AGENDADO (âncora).
 */
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

  // Perdido (sistema): resgate cuida; não é "já agendado".
  if (statusId === 143 || status?.type === 143) return semAgenda(false);
  // Ganho/Won (sistema): já fechou.
  if (statusId === 142 || status?.type === 142) return semAgenda(true);
  // Pipeline de TRATAMENTO: já é paciente.
  if (pipe && /tratamento/i.test(pipe.name || '')) return semAgenda(true);

  // Comercial: âncora = AGENDADO (scheduled_meeting configurado, ou nome ~ agendad*).
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

/**
 * A etapa atual do lead no Kommo, classificada. `null` = não consegui ler
 * (sem leadId, ou o Kommo falhou) — nesse caso o prompt segue sem o bloco, que é
 * o comportamento seguro (nunca bloqueia por engano).
 */
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
  } catch (err) {
    logger.warn(
      { err: String(err), unit: unit.slug, leadId },
      'estadoEtapaDoLead falhou — sem bloco de etapa no prompt',
    );
    valor = null;
  }

  if (etapaCache.size > 5000) etapaCache.clear(); // poda simples anti-vazamento
  etapaCache.set(key, { em: Date.now(), valor });
  return valor;
}
