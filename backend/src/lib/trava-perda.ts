/**
 * Trava da perda AUTOMÁTICA (item 5 da lista da Suzanne, 25/10/2026; decisão do João, 26/10).
 *
 * Quem tem consulta futura, quem pagou e quem está Quente ou Morno nunca vai para PERDIDO por um
 * ROBÔ nosso — o worker de parados (todas as regras e os estoques), a máquina da franquia e a Sofia
 * (`fechar_lead`). PERDIDO que a equipe põe na mão não passa por aqui, e o robô nativo do Kommo
 * ("24 h sem resposta") também não: esse é configuração da conta, não código (ver o PR).
 *
 * Só olha o CARTÃO, sem chamar ninguém: é a mesma leitura que o sincronizador da franquia já espelha
 * lá (◷ Data da Consulta, ✓ Situação da consulta), e é barata o bastante para rodar antes de gastar
 * a cota de avaliações caras do worker. A conferência fresca na franquia (consulta futura, tratamento
 * em andamento) continua nos lugares onde já existia; esta trava é a rede por baixo.
 *
 * NÃO inclui "mensagem do paciente nas últimas 72 h": o João não decidiu. Medido em produção, ela
 * seguraria TODO PERDIDO do robô de 24 h (o robô dispara 24 h depois da última mensagem, logo ela
 * sempre está dentro de 72 h). Fica de fora até ele escolher outra janela.
 *
 * Na dúvida segura: o erro caro é perder quem ia consultar; o barato é o cartão ficar onde está.
 */
import type { KommoClient } from '../services/kommo.service.js';
import { logger } from './logger.js';
import { normalizarNome } from './kommo-schema.js';
import { pagouOAntecipado } from './follow-up-worker.js';
import { CAMPOS_SYNC } from './franquia-sync.js';
import { epochDoValor, valorDoCampo, type CampoDoCartao } from './ponte-fila.js';
import { qualificacaoDoCartao } from './ponte-painel.js';

/** O que o cartão precisa mostrar: os campos e as etiquetas, como o Kommo devolve. */
export interface CartaoParaTrava {
  custom_fields_values?: ReadonlyArray<CampoDoCartao> | null;
  _embedded?: { tags?: ReadonlyArray<{ name?: string | null }> | null } | null;
}

export type MotivoDaTrava = 'consulta futura no cartão' | 'pagou o antecipado' | 'Quente' | 'Morno';

export interface TravaDaPerda {
  motivo: MotivoDaTrava;
}

/**
 * Situações em que a data do cartão É uma consulta de pé: ainda sem situação gravada, Agendado, Confirmado ou Remarcado.
 * Remarcado (41) NÃO é consulta morta: desde o #113 a franquia muda a data no próprio registro e põe 41, e o sincronizador grava
 * a data NOVA com essa situação — o paciente vem naquela data (mesma regra de `agenda-reconcile.service.ts` e `widget-agenda.ts`).
 * Desmarcado, Não compareceu e Atendido quer dizer que a data que sobrou no cartão já não é uma consulta futura viva.
 */
const SITUACOES_COM_CONSULTA_DE_PE = new Set(['', 'agendado', 'confirmado', 'remarcado']);

/** Já passou pela consulta (compareceu ou faltou): daí em diante o pagamento antecipado não segura mais o cartão. */
const SITUACOES_DEPOIS_DA_CONSULTA = new Set(['atendido', 'naocompareceu']);

function temTag(c: CartaoParaTrava, ...nomes: string[]): boolean {
  const alvos = new Set(nomes.map(normalizarNome));
  return (c._embedded?.tags ?? []).some((t) => alvos.has(normalizarNome(t.name ?? '')));
}

function comConsultaFutura(c: CartaoParaTrava, agoraEpoch: number): boolean {
  const data = epochDoValor(valorDoCampo(c.custom_fields_values, CAMPOS_SYNC.DATA_CONSULTA));
  if (data === null || data <= agoraEpoch) return false;
  const situacao = normalizarNome(String(valorDoCampo(c.custom_fields_values, CAMPOS_SYNC.SITUACAO) ?? ''));
  return SITUACOES_COM_CONSULTA_DE_PE.has(situacao);
}

/**
 * Pagou o antecipado E ainda não teve a consulta. O que o João quer proteger é quem pagou e VAI: depois que a consulta
 * aconteceu (Atendido) ou o paciente faltou (Não compareceu) valem as regras normais (45 dias sem fechar, atendido sem
 * tratamento…) — senão o «pagou» nunca venceria e o cartão ficaria aberto para sempre. (Interpretação a confirmar com o João.)
 */
function pagou(c: CartaoParaTrava): boolean {
  const situacao = normalizarNome(String(valorDoCampo(c.custom_fields_values, CAMPOS_SYNC.SITUACAO) ?? ''));
  if (SITUACOES_DEPOIS_DA_CONSULTA.has(situacao)) return false;
  // `pagouOAntecipado` só aceita "✓ Consulta pg antecipado" (o campo da forma escolhida não prova pagamento);
  // a etiqueta "$ · Pagou antecipado" é a marca que o robô do comprovante põe.
  if (pagouOAntecipado(c.custom_fields_values as Parameters<typeof pagouOAntecipado>[0])) return true;
  return temTag(c, '$ · Pagou antecipado');
}

function temperatura(c: CartaoParaTrava): 'Quente' | 'Morno' | null {
  const campo = qualificacaoDoCartao([], c.custom_fields_values as Parameters<typeof qualificacaoDoCartao>[1]);
  const n = normalizarNome(campo ?? '');
  if (n === 'quente' || temTag(c, 'Quente')) return 'Quente';
  if (n === 'morno' || temTag(c, 'Morno')) return 'Morno';
  return null;
}

/**
 * `null` = o robô pode seguir com o PERDIDO; senão, o motivo de o cartão ficar onde está.
 * `semTemperatura`: só consulta e pagamento seguram (usado pela Sofia, ver `recusaDaPerdaDaSofia`).
 * `semConsulta`: a franquia (fonte de verdade) disse que a consulta do cartão não existe mais.
 */
export function travaDaPerdaAutomatica(cartao: CartaoParaTrava, agoraEpoch: number, opcoes: { semTemperatura?: boolean; semConsulta?: boolean } = {}): TravaDaPerda | null {
  if (!opcoes.semConsulta && comConsultaFutura(cartao, agoraEpoch)) return { motivo: 'consulta futura no cartão' };
  if (pagou(cartao)) return { motivo: 'pagou o antecipado' };
  if (opcoes.semTemperatura) return null;
  const t = temperatura(cartao);
  if (t) return { motivo: t };
  return null;
}

/** O que a franquia sabe do paciente agora (é `franquiaDoPaciente` do worker de parados; injetado para não criar ciclo de import). */
export type ConsultaNaFranquia = (nomeDoCartao: string | null) => Promise<{ conhecido: boolean; consultaFutura: boolean }>;

export interface RecusaDaSofia {
  motivo: MotivoDaTrava | 'cartão ilegível';
  texto: string;
  /** o paciente quer fechar e a trava segurou: a equipe precisa saber (nota/tarefa no cartão). Falha de leitura não avisa. */
  avisarEquipe: boolean;
}

/**
 * A Sofia pede `fechar_lead({ status: 'lost' })` (ou `mover_funil` para o 143 do COMERCIAL). Consulta futura e pagamento
 * seguram também a ela: quem tem consulta ou pagou não some por decisão da IA — desistência dessa pessoa é a equipe que
 * registra. Quente/Morno NÃO seguram a Sofia (ainda): ela só fecha quando o paciente recusa com todas as letras, e travar isso
 * deixaria quem disse "não me chame" na régua de follow-up; 13 dos 25 fechamentos dela em 8 dias eram Quente/Morno, o João
 * decide. Não conseguiu ler o cartão = recusa: fechar às cegas é o erro caro, esperar a próxima mensagem não custa nada.
 * O 143 do funil TRATAMENTO é TRATAMENTO CANCELADO, não PERDIDO: esse não passa por aqui.
 *
 * Consulta no cartão: a FRANQUIA decide. `cancelar_consulta` cancela lá e não atualiza o cartão, então logo depois o cartão ainda
 * diz Agendado com data futura; se a franquia conhece o paciente e não tem consulta futura, essa data é sobra e não segura.
 * Franquia fora do ar, ou paciente que ela não acha: segura (não dá para provar que a consulta morreu).
 */
export async function recusaDaPerdaDaSofia(
  kommo: Pick<KommoClient, 'getLead' | 'listPipelines'>,
  leadId: number,
  opcoes: { agoraEpoch?: number; pipelineDestino?: number; consultaNaFranquia?: ConsultaNaFranquia } = {},
): Promise<RecusaDaSofia | null> {
  const agoraEpoch = opcoes.agoraEpoch ?? Math.floor(Date.now() / 1000);
  let cartao: CartaoParaTrava & { pipeline_id?: number; name?: string };
  try {
    cartao = await kommo.getLead(leadId);
  } catch (err) {
    logger.warn({ err: String(err), leadId }, 'trava-perda: não consegui ler o cartão para a Sofia fechar como perdido — recusei');
    return { motivo: 'cartão ilegível', avisarEquipe: false, texto: 'não consegui ler o cartão agora para conferir se ele tem consulta ou pagamento. Não feche às cegas: deixe o cartão onde está e tente de novo na próxima mensagem.' };
  }
  const pipelineAlvo = opcoes.pipelineDestino ?? cartao.pipeline_id;
  if (pipelineAlvo) {
    try {
      const funil = (await kommo.listPipelines()).find((p) => p.id === pipelineAlvo);
      if (funil && normalizarNome(funil.name) === normalizarNome('TRATAMENTO')) return null; // 143 ali é TRATAMENTO CANCELADO
    } catch (err) {
      logger.warn({ err: String(err), leadId }, 'trava-perda: não li os funis — tratei o 143 como PERDIDO');
    }
  }
  let trava = travaDaPerdaAutomatica(cartao, agoraEpoch, { semTemperatura: true });
  if (trava?.motivo === 'consulta futura no cartão' && opcoes.consultaNaFranquia) {
    try {
      const f = await opcoes.consultaNaFranquia(cartao.name ?? null);
      if (f.conhecido && !f.consultaFutura) {
        logger.info({ leadId }, 'trava-perda: o cartão diz consulta futura mas a franquia não tem — a data é sobra, não seguro');
        trava = travaDaPerdaAutomatica(cartao, agoraEpoch, { semTemperatura: true, semConsulta: true });
      }
    } catch (err) {
      logger.warn({ err: String(err), leadId }, 'trava-perda: a franquia não respondeu — segurei pela consulta do cartão');
    }
  }
  if (!trava) return null;
  return {
    motivo: trava.motivo,
    avisarEquipe: true,
    texto: `este lead está com «${trava.motivo}» — a Sofia não fecha como perdido quem tem consulta futura ou pagou. Deixe o cartão onde está; a equipe foi avisada por tarefa e registra a desistência, se for o caso.`,
  };
}
