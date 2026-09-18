/**
 * Carimbos por mudança de etapa (webhook `status_lead` do Kommo).
 *
 * Nasceu do cartão enxuto (laboratório `doutorherniakommo`, 17–18/09/2026): a API da
 * franquia nunca devolve `dateBegin`/`dateFinish` do tratamento, então "◷ Início do
 * tratamento" e "◷ Fim do tratamento" ficariam vazios pra sempre. O João decidiu que
 * a etapa é a verdade: entrou em EM TRATAMENTO → início; foi pra ALTA ou TRATAMENTO
 * CANCELADO → fim. As datas só entram se o campo estiver vazio (o sincronizador pode
 * ter gravado a data da 1ª sessão, que é melhor que "hoje").
 *
 * Aproveita o mesmo gatilho pra fechar o bloco DIGITAL: lead em GANHO / CONCLUÍDO ou
 * PERDIDO → "⬢ Status da conversa" = Encerrada.
 *
 * Só roda nas unidades listadas em `CARIMBO_ETAPA_SLUGS` (csv; `*` = todas). A conta
 * também precisa assinar `status_lead` no webhook do agente — a Imperatriz, por exemplo,
 * só assinava `add_message` em 18/09/2026, então nada disto disparava lá.
 */
import type { Unit } from '@prisma/client';
import { createKommoClient, type KommoLead } from '../services/kommo.service.js';
import { esquemaDaUnidade, normalizarNome } from './kommo-schema.js';
import { logger } from './logger.js';

export const CAMPOS_CARIMBO = {
  INICIO_TRAT: '◷ Início do tratamento',
  FIM_TRAT: '◷ Fim do tratamento',
  STATUS_CONVERSA: '⬢ Status da conversa',
} as const;

export interface CarimboEtapa {
  campo: string;
  tipo: 'date' | 'select';
  valor: string | number;
  /** true = não sobrescreve o que já está no cartão */
  soSeVazio: boolean;
  motivo: string;
}

const ETAPAS = {
  emTratamento: normalizarNome('EM TRATAMENTO'),
  alta: normalizarNome('ALTA'),
  cancelado: normalizarNome('TRATAMENTO CANCELADO'),
  perdido: normalizarNome('PERDIDO'),
};

/** Puro: dado o nome da etapa de destino, o que carimbar. */
export function carimbosDaEtapa(nomeEtapa: string, agoraEpoch: number): CarimboEtapa[] {
  const n = normalizarNome(nomeEtapa);
  if (!n) return [];
  if (n === ETAPAS.emTratamento) {
    return [{ campo: CAMPOS_CARIMBO.INICIO_TRAT, tipo: 'date', valor: agoraEpoch, soSeVazio: true, motivo: 'lead entrou em EM TRATAMENTO' }];
  }
  if (n === ETAPAS.alta || n === ETAPAS.cancelado) {
    return [{ campo: CAMPOS_CARIMBO.FIM_TRAT, tipo: 'date', valor: agoraEpoch, soSeVazio: true, motivo: `lead foi pra ${nomeEtapa.trim()}` }];
  }
  // "GANHO / CONCLUÍDO" e variações ("GANHO", "CONCLUÍDO") fecham a conversa; PERDIDO também.
  if (n === ETAPAS.perdido || n.startsWith('ganho') || n === 'concluido') {
    return [{ campo: CAMPOS_CARIMBO.STATUS_CONVERSA, tipo: 'select', valor: 'Encerrada', soSeVazio: false, motivo: `lead foi pra ${nomeEtapa.trim()}` }];
  }
  return [];
}

export function carimboEtapaLiberado(slug: string, raw: string | undefined = process.env.CARIMBO_ETAPA_SLUGS): boolean {
  const lista = (raw ?? '').replace(/^['"]|['"]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  if (lista.length === 0) return false;
  return lista.includes('*') || lista.includes(slug);
}

export interface EventoEtapa {
  id: number;
  status_id?: number;
  pipeline_id?: number;
}

function valorAtual(lead: KommoLead, fieldId: number): string | null {
  const cf = (lead.custom_fields_values ?? []).find((f) => f.field_id === fieldId);
  const v = cf?.values?.[0]?.value;
  return v === null || v === undefined || v === '' ? null : String(v);
}

/** Aplica os carimbos de cada evento de etapa. Falha em um lead não derruba os outros. */
export async function aplicarCarimbosDeEtapa(unit: Unit, eventos: EventoEtapa[]): Promise<number> {
  if (!carimboEtapaLiberado(unit.slug) || eventos.length === 0) return 0;
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) return 0;

  const kommo = createKommoClient(unit);
  const esquema = await esquemaDaUnidade(unit, kommo);
  const agora = Math.floor(Date.now() / 1000);
  let gravados = 0;

  for (const ev of eventos) {
    if (!ev.status_id || !ev.pipeline_id) continue;
    const nomes = esquema.nomeDoStatus(ev.pipeline_id, ev.status_id);
    if (!nomes) continue;
    const carimbos = carimbosDaEtapa(nomes.status, agora).filter((c) => esquema.campoPorNome(c.campo) !== null);
    if (carimbos.length === 0) continue;

    try {
      const lead = carimbos.some((c) => c.soSeVazio) ? await kommo.getLead(ev.id) : null;
      for (const c of carimbos) {
        const fieldId = esquema.campoPorNome(c.campo)!;
        if (c.soSeVazio && lead && valorAtual(lead, fieldId)) {
          logger.debug({ unit: unit.slug, leadId: ev.id, campo: c.campo }, 'carimbo-etapa: campo já preenchido, mantido');
          continue;
        }
        await kommo.setLeadCustomFieldValue(ev.id, fieldId, c.tipo, c.valor);
        gravados++;
        logger.info({ unit: unit.slug, leadId: ev.id, etapa: nomes.status, campo: c.campo, motivo: c.motivo }, 'carimbo-etapa: campo gravado');
      }
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId: ev.id, etapa: nomes.status }, 'carimbo-etapa: falha ao gravar (ignorada)');
    }
  }
  return gravados;
}
