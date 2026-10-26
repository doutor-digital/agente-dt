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

/** Situações em que a data que sobrou no cartão NÃO é consulta de pé (a franquia desmarcou, faltou, cancelou). */
const SITUACOES_SEM_CONSULTA = new Set(['desmarcado', 'cancelado', 'naocompareceu', 'faltou']);

function temTag(c: CartaoParaTrava, ...nomes: string[]): boolean {
  const alvos = new Set(nomes.map(normalizarNome));
  return (c._embedded?.tags ?? []).some((t) => alvos.has(normalizarNome(t.name ?? '')));
}

function comConsultaFutura(c: CartaoParaTrava, agoraEpoch: number): boolean {
  const data = epochDoValor(valorDoCampo(c.custom_fields_values, CAMPOS_SYNC.DATA_CONSULTA));
  if (data === null || data <= agoraEpoch) return false;
  const situacao = normalizarNome(String(valorDoCampo(c.custom_fields_values, CAMPOS_SYNC.SITUACAO) ?? ''));
  return !SITUACOES_SEM_CONSULTA.has(situacao);
}

function pagou(c: CartaoParaTrava): boolean {
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

/** `null` = o robô pode seguir com o PERDIDO; senão, o motivo de o cartão ficar onde está. */
export function travaDaPerdaAutomatica(cartao: CartaoParaTrava, agoraEpoch: number): TravaDaPerda | null {
  if (comConsultaFutura(cartao, agoraEpoch)) return { motivo: 'consulta futura no cartão' };
  if (pagou(cartao)) return { motivo: 'pagou o antecipado' };
  const t = temperatura(cartao);
  if (t) return { motivo: t };
  return null;
}

/**
 * A Sofia pede `fechar_lead({ status: 'lost' })`: a trava vale para ela também (a IA decide por conta, mas é automático:
 * ninguém da equipe mandou). Devolve o texto da recusa para ela, ou `null` se pode seguir. Não conseguiu ler o cartão =
 * segue como sempre foi (o Kommo fora do ar derruba o `setLeadStatus` logo depois).
 */
export async function recusaDaPerdaDaSofia(
  kommo: Pick<KommoClient, 'getLead'>,
  leadId: number,
  agoraEpoch: number = Math.floor(Date.now() / 1000),
): Promise<{ motivo: MotivoDaTrava; texto: string } | null> {
  let cartao: CartaoParaTrava;
  try {
    cartao = await kommo.getLead(leadId);
  } catch {
    return null;
  }
  const trava = travaDaPerdaAutomatica(cartao, agoraEpoch);
  if (!trava) return null;
  return {
    motivo: trava.motivo,
    texto: `este lead está com «${trava.motivo}» — a Sofia não fecha como perdido quem tem consulta futura, pagou ou está Quente/Morno. Deixe o cartão onde está; se o paciente desistiu de verdade, a equipe decide.`,
  };
}
