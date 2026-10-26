/**
 * «Pagou e desmarcou» não pode ficar travado para sempre (decisão do João, 26/10, depois do #128).
 *
 * A trava da perda automática segura quem pagou o antecipado. Se a consulta CAIU (Desmarcado, ou Remarcado com a data já
 * passada) e não há consulta de pé, o cartão não faz sentido parado. O robô então, na primeira vez que ia mandar esse cartão a
 * PERDIDO:
 *   1. NÃO manda a PERDIDO;
 *   2. abre UMA tarefa para o responsável do cartão: «Paciente pagou antecipado e desmarcou — remarcar ou combinar devolução»,
 *      com a data da consulta desmarcada;
 *   3. leva o cartão para EM ESPERA (se a conta tem a etapa; senão ele fica onde está);
 *   4. grava a marca (`card_alert`) — o «pagou» só deixa de segurar quando essa marca tem 7 dias. Daí em diante valem as regras
 *      normais da etapa (Quente/Morno ainda seguram, por decisão própria).
 *
 * No papel (modo seco) nada é escrito: registra «alertaria» (a tarefa) e «moveria» (EM ESPERA) para a tela.
 */
import type { Unit } from '@prisma/client';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import { logger } from './logger.js';
import { esquemaDaUnidade, normalizarNome } from './kommo-schema.js';
import { ETAPA } from './franquia-move.js';
import { avisoRecente, marcadoEm, marcarAviso } from './aviso-dedupe.js';
import { registrarSimulacao } from './so-no-papel.js';
import { levarParaEsperaComRetomada } from './sofia-fecha-quente-morno.js';
import { pagouEDesmarcou, travaDaPerdaAutomatica, type CartaoParaTrava, type MotivoDaTrava } from './trava-perda.js';

/** A marca no `card_alert`: existe = a tarefa já foi aberta (e quando). */
export const CHAVE_SEGUIMENTO_PAGOU = 'pagou-desmarcou-tarefa';
/** Quanto tempo depois da tarefa o «pagou» deixa de segurar. */
export const SEGUIMENTO_VENCE_EM_MS = 7 * 24 * 3600_000;

export interface VeredictoDaTrava {
  motivo: MotivoDaTrava;
  /** a tarefa ainda NÃO foi aberta: o portão tem de abri-la (e levar a EM ESPERA). Só vem em «pagou e desmarcou». */
  abrirSeguimento?: { consultaDesmarcadaEm: number | null };
}

/** A trava com a memória do seguimento: quem pagou e desmarcou tem tarefa aberta (segura 7 d) ou já venceu (solta). */
export async function veredictoDaTrava(unit: Pick<Unit, 'id'>, leadId: number, cartao: CartaoParaTrava, agoraEpoch: number): Promise<VeredictoDaTrava | null> {
  const trava = travaDaPerdaAutomatica(cartao, agoraEpoch);
  if (!trava) return null;
  if (trava.motivo !== 'pagou e desmarcou') return { motivo: trava.motivo };
  const marca = await marcadoEm(unit.id, leadId, CHAVE_SEGUIMENTO_PAGOU);
  if (!marca) return { motivo: trava.motivo, abrirSeguimento: pagouEDesmarcou(cartao, agoraEpoch) ?? { consultaDesmarcadaEm: null } };
  if (agoraEpoch * 1000 - marca.getTime() >= SEGUIMENTO_VENCE_EM_MS) {
    // a tarefa existe há 7 dias: o pagamento não segura mais (consulta futura ou Quente/Morno ainda podem)
    const resto = travaDaPerdaAutomatica(cartao, agoraEpoch, { pagouVenceu: true });
    return resto ? { motivo: resto.motivo } : null;
  }
  return { motivo: trava.motivo };
}

function dataParaTarefa(epoch: number | null, fuso: string): string {
  if (epoch === null) return 'data não registrada no cartão';
  try {
    return new Date(epoch * 1000).toLocaleString('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(epoch * 1000).toISOString();
  }
}

export function textoDaTarefaPagouDesmarcou(consultaDesmarcadaEm: number | null, fuso: string): string {
  return `Paciente pagou antecipado e desmarcou — remarcar ou combinar devolução. Consulta desmarcada: ${dataParaTarefa(consultaDesmarcadaEm, fuso)}.`;
}

/**
 * Faz o seguimento (modo ligado): tarefa → marca → EM ESPERA. A tarefa vem primeiro: se ela falhar, não há marca e a próxima
 * varredura tenta de novo (o cartão não é movido sem a SDR saber). Devolve se a tarefa foi aberta.
 */
export async function abrirSeguimentoDoPagou(
  unit: Unit,
  kommo: KommoClient,
  funis: { comercialId: number; idDe: (funil: 'COMERCIAL' | 'TRATAMENTO', etapa: string) => { pipelineId: number; statusId: number } | null },
  cartao: Pick<KommoLead, 'id' | 'responsible_user_id' | 'pipeline_id' | 'status_id'>,
  seguimento: { consultaDesmarcadaEm: number | null },
  etapaAtual: string,
): Promise<boolean> {
  const leadId = cartao.id;
  // defesa: outra varredura pode ter aberto agora há pouco
  if (await avisoRecente(unit.id, leadId, CHAVE_SEGUIMENTO_PAGOU, SEGUIMENTO_VENCE_EM_MS * 10)) return false;
  try {
    await kommo.createTask({
      leadId,
      text: textoDaTarefaPagouDesmarcou(seguimento.consultaDesmarcadaEm, unit.spineTimezone || 'America/Sao_Paulo'),
      completeAt: Math.floor(Date.now() / 1000) + 24 * 3600,
      responsibleUserId: cartao.responsible_user_id,
    });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'trava-perda: não consegui abrir a tarefa de «pagou e desmarcou» — tento na próxima varredura');
    return false;
  }
  await marcarAviso(unit.id, leadId, CHAVE_SEGUIMENTO_PAGOU);
  logger.info({ unit: unit.slug, leadId, de: etapaAtual }, 'trava-perda: pagou e desmarcou — tarefa aberta para a SDR; o «pagou» solta em 7 dias');
  // EM ESPERA do mesmo jeito que a Sofia: só se o cartão está no COMERCIAL, com «Motivo da espera» e «Retomar em» (+30 d) onde a conta tem os campos
  try {
    const esquema = await esquemaDaUnidade(unit, kommo);
    const r = await levarParaEsperaComRetomada({ unit, kommo, funis, esquema, cartao, agoraEpoch: Math.floor(Date.now() / 1000) });
    if (r.naEspera) logger.info({ unit: unit.slug, leadId, de: etapaAtual, retomada: r.retomada }, 'trava-perda: cartão em EM ESPERA (pagou e desmarcou)');
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'trava-perda: a tarefa foi aberta, mas não consegui levar o cartão para EM ESPERA');
  }
  return true;
}

/** Modo seco: o que o seguimento FARIA, para a tela do «só no papel». */
export function simularSeguimentoDoPagou(
  unit: Pick<Unit, 'id' | 'slug' | 'spineTimezone'>,
  funis: { comercialId?: number; idDe: (funil: 'COMERCIAL' | 'TRATAMENTO', etapa: string) => { pipelineId: number; statusId: number } | null } | null | undefined,
  leadId: number,
  seguimento: { consultaDesmarcadaEm: number | null },
  etapaAtual: string,
  automacao: string,
  pipelineDoCartao?: number,
): void {
  registrarSimulacao(unit, automacao, {
    leadId,
    acao: 'alertaria',
    alvo: 'tarefa: pagou e desmarcou',
    valor: textoDaTarefaPagouDesmarcou(seguimento.consultaDesmarcadaEm, unit.spineTimezone || 'America/Sao_Paulo'),
    motivo: 'pagou o antecipado, a consulta caiu e não há outra: a SDR remarca ou combina a devolução',
  });
  const espera = funis?.idDe('COMERCIAL', ETAPA.ESPERA);
  if (funis && espera && normalizarNome(etapaAtual) !== normalizarNome(ETAPA.ESPERA) && (pipelineDoCartao === undefined || pipelineDoCartao === funis.comercialId)) {
    registrarSimulacao(unit, automacao, { leadId, acao: 'moveria', alvo: ETAPA.ESPERA, deEtapa: etapaAtual, motivo: 'pagou e desmarcou: sai da trava eterna' });
  }
}
