/**
 * "A conta deste provedor está sem saldo/cota" — erro que NÃO passa com o tempo.
 *
 * 26/11/2026, 18h: o crédito da Anthropic acabou e o da OpenAI (o plano B) também. Foram ~15 h
 * com 0 resposta boa na rede toda, porque esperar não ressuscita saldo. Quem recebe este erro
 * deve pular NA HORA para o próximo provedor (sem esperar o tempo limite) e abrir o disjuntor
 * daquele provedor, para as mensagens seguintes nem tentarem.
 *
 * As frases reais de cada provedor:
 *  - Anthropic: `400 … "Your credit balance is too low to access the Anthropic API"` (ou "reached
 *    your specified API usage limits")
 *  - OpenAI:    `429 You have no credits remaining …` / `429 … insufficient_quota`
 *  - Google:    `429 … RESOURCE_EXHAUSTED … You exceeded your current quota …`
 *  - 402 Payment Required, de qualquer um.
 *
 * Reaproveita `ehErroDeSaldo` (lib/ops-alert.ts, usado pelo aviso de saldo e pelo áudio) e
 * ACRESCENTA o que ele não cobria sozinho. Não mexe nele: quem já o usa segue igual.
 *
 * 429 SEM texto de saldo/cota é limite por minuto — passageiro, tratado pelo circuito/retentativa,
 * e NÃO cai aqui.
 */
import { ehErroDeSaldo } from '../lib/ops-alert.js';
import { mensagemDe, statusDe } from './chave-reserva.js';

const SALDO_EXTRA =
  /no credits? remaining|insufficient[_ ]credits?|out of credits|credit[_ ]balance|credit_balance_exhausted|billing_hard_limit|api usage limits?|usage limits? (?:have been|were) reached|resource_exhausted|exceeded your current quota/i;

export function ehErroDeSaldoOuCota(err: unknown): boolean {
  if (err == null) return false;
  if (err instanceof Error && err.name === 'LlmTimeoutError') return false;

  if (statusDe(err) === 402) return true;

  const msg = mensagemDe(err);
  if (ehErroDeSaldo(msg)) return true;
  return SALDO_EXTRA.test(msg);
}
