/**
 * "A Sofia não tira o cartão do funil TRATAMENTO" (decisão 2 do João, 16/10/2026).
 *
 * Quem está no funil TRATAMENTO é paciente em tratamento (ou de alta, ou cancelado). Se ele escreve, a Sofia pode
 * conversar — mas não decide etapa: não leva o cartão pro COMERCIAL (AGENDADO, EM QUALIFICAÇÃO, o handoff…), não troca
 * de funil e não fecha o tratamento (ALTA ou TRATAMENTO CANCELADO são 142/143 desse funil). Quem tira o cartão de lá é a
 * franquia (o sincronizador, ex.: ALTA → RETORNO PÓS-TRATAMENTO quando o paciente volta) ou a equipe.
 *
 * Atrás da chave `casamento-jornada`: desligado = como sempre; só no papel = deixa mover e registra na tela que recusaria.
 */
import type { Unit } from '@prisma/client';
import type { KommoClient } from '../services/kommo.service.js';
import { normalizarNome } from './kommo-schema.js';
import { ID_AUTOMACAO, estadoCasamentoJornada } from './casamento-jornada.js';
import { registrarSimulacao } from './so-no-papel.js';
import { logger } from './logger.js';

export type DestinoDaSofia =
  | { tipo: 'etapa'; statusId: number; pipelineId?: number | null }
  | { tipo: 'funil'; pipelineId: number }
  | { tipo: 'fechar'; ganho: boolean };

const GANHO = 142;
const PERDIDO = 143;

/** PURA: o pedido da IA tira o cartão do funil TRATAMENTO (ou fecha o tratamento)? */
export function tiraDoTratamento(p: { pipelineAtual: number | null | undefined; tratamentoId: number | null; statusDoTratamento: number[]; destino: DestinoDaSofia }): boolean {
  if (!p.tratamentoId || p.pipelineAtual !== p.tratamentoId) return false;
  const d = p.destino;
  if (d.tipo === 'fechar') return true;
  if (d.tipo === 'funil') return d.pipelineId !== p.tratamentoId;
  if (d.pipelineId && d.pipelineId !== p.tratamentoId) return true;
  if (d.statusId === GANHO || d.statusId === PERDIDO) return true;
  return !p.statusDoTratamento.includes(d.statusId);
}

export const MOTIVO_RECUSA =
  'este cartão está no funil TRATAMENTO e a Sofia não tira o paciente de lá (regra de 16/10). Converse normalmente, ' +
  'mas não mova o cartão: quem muda a etapa é a franquia ou a equipe. Se ele quer marcar consulta, siga o fluxo de ' +
  'agendamento sem mover a etapa.';

const cacheFunil = new Map<string, { em: number; tratamentoId: number | null; status: number[] }>();
const CACHE_FUNIL_MS = 10 * 60_000;

async function funilTratamento(unit: Pick<Unit, 'id'>, kommo: KommoClient): Promise<{ tratamentoId: number | null; status: number[] }> {
  const c = cacheFunil.get(unit.id);
  if (c && Date.now() - c.em < CACHE_FUNIL_MS) return c;
  const pipes = await kommo.listPipelines();
  const t = pipes.find((p) => normalizarNome(p.name) === normalizarNome('TRATAMENTO')) ?? null;
  const out = { em: Date.now(), tratamentoId: t?.id ?? null, status: (t?.statuses ?? []).map((s) => s.id) };
  cacheFunil.set(unit.id, out);
  return out;
}

/**
 * Devolve o texto de recusa (para a ferramenta devolver à IA) ou `null` quando pode mover. Falha ao ler o Kommo não
 * trava a Sofia: segue o comportamento de sempre e fica no log.
 */
export async function recusaDoFunilTratamento(
  unit: Pick<Unit, 'id' | 'slug'> | null | undefined,
  kommo: KommoClient,
  leadId: number,
  destino: DestinoDaSofia,
): Promise<string | null> {
  if (!unit || !Number.isInteger(leadId) || leadId <= 0) return null;
  const estado = estadoCasamentoJornada(unit.slug);
  if (estado === 'desligado') return null;
  try {
    const [lead, funil] = await Promise.all([kommo.getLead(leadId), funilTratamento(unit, kommo)]);
    if (!tiraDoTratamento({ pipelineAtual: lead.pipeline_id, tratamentoId: funil.tratamentoId, statusDoTratamento: funil.status, destino })) return null;
    if (estado === 'seco') {
      registrarSimulacao(unit, ID_AUTOMACAO, { leadId, acao: 'pularia', alvo: 'Sofia tirando o cartão do TRATAMENTO', valor: destino, motivo: 'a Sofia não tira cartão do funil TRATAMENTO (regra de 16/10)' });
      return null;
    }
    logger.info({ unit: unit.slug, leadId, destino }, 'guarda-funil-tratamento: a Sofia tentou tirar o cartão do TRATAMENTO — recusado');
    return MOTIVO_RECUSA;
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'guarda-funil-tratamento: não consegui conferir o funil — segue como sempre');
    return null;
  }
}
