/**
 * Erro da CONTA/CHAVE do Joaoof (saldo, limite de uso, chave) não é erro de conteúdo: nenhuma mensagem tem culpa, nenhuma é descartada,
 * e o João precisa saber em português claro o que fazer. Uma frase real de cada (26/11/2026):
 *   - «Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing…»
 *   - «You have reached your specified workspace API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.»
 *   - «401 invalid x-api-key» / «403 permission_error» / «JOAOOF_ANTHROPIC_API_KEY ausente…»
 */
import { ehErroDeSaldo } from '../lib/ops-alert.js';

export type ErroDeConta = 'saldo' | 'limite' | 'chave' | 'modelo';

export function classificarErroDeConta(msg: string | undefined | null): ErroDeConta | null {
  const m = String(msg ?? '').toLowerCase();
  if (!m) return null;
  if (m.includes('usage limit') || m.includes('spend limit') || m.includes('spending limit')) return 'limite';
  if (ehErroDeSaldo(m)) return 'saldo';
  if (/^\s*(401|403)\b|\b(?:status|http|code)\W{0,3}(401|403)\b|authentication_error|permission_error|invalid x-api-key|invalid api key|incorrect api key|api_key ausente|api key ausente/.test(m) || m.includes('joaoof_anthropic_api_key')) return 'chave';
  // modelo inexistente/sem acesso (JOAOOF_MODELO_BARATO/FORTE errado): 404 not_found_error, ou 422
  if (/^\s*(404|422)\b|not_found_error|model[^.]{0,40}(not found|does not exist|not available)/.test(m)) return 'modelo';
  return null;
}

export const ehErroDeConta = (msg: string | undefined | null): boolean => classificarErroDeConta(msg) !== null;

/** O aviso ao João: o que parou, por quê e o que fazer. Sem JSON cru, sem corte no meio. */
export function textoDoErroDeConta(msg: string | undefined | null): string {
  switch (classificarErroDeConta(msg)) {
    case 'saldo':
      return 'Joaoof parado: a chave da Anthropic (a mesma da rede) ficou SEM CRÉDITO. Recarregue o saldo em console.anthropic.com (Plans & Billing). As mensagens dos grupos ficam na fila e eu retomo sozinho quando voltar.';
    case 'limite':
      return 'Joaoof parado: a chave da Anthropic (a mesma da rede) bateu o LIMITE DE GASTO/USO do workspace. Suba o limite em console.anthropic.com (Limits) ou espere o período virar. As mensagens ficam na fila e eu retomo sozinho.';
    case 'chave':
      return 'Joaoof parado: a chave da Anthropic está AUSENTE ou INVÁLIDA (ANTHROPIC_API_KEY do servidor). Confira no console.anthropic.com e no .env do servidor. As mensagens ficam na fila.';
    case 'modelo':
      return 'Joaoof parado: o MODELO configurado não existe ou a chave não tem acesso a ele (JOAOOF_MODELO_BARATO / JOAOOF_MODELO_FORTE). Corrija o nome do modelo no servidor. As mensagens ficam na fila.';
    default:
      return 'Joaoof parado por um erro de conta do modelo. As mensagens ficam na fila.';
  }
}
