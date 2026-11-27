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
 * LIMITE POR MINUTO NÃO É SALDO. O 429 do Gemini por minuto traz as mesmas palavras ("RESOURCE_EXHAUSTED", "You exceeded
 * your current quota, please check your plan and billing details", "Quota exceeded for metric") mas passa em segundos
 * ("Please retry in 12s", quotaId "...PerMinute..."): abrir o circuito por 2 min por causa dele tiraria do ar uma chave
 * boa. Por isso:
 *  - frase DURA de saldo (conta zerada) é saldo sempre;
 *  - texto de cota/limite com sinal de por-minuto/retentativa NÃO é saldo, a menos que fale de cota por DIA;
 *  - 429 sem texto nenhum de saldo/cota é limite por minuto e NÃO cai aqui.
 */
import { ehErroDeSaldo } from '../lib/ops-alert.js';
import { mensagemDe, statusDe } from './chave-reserva.js';

/** Conta zerada: não depende de mais nada para ser saldo. */
const SALDO_DURO =
  /credit balance is too low|no credits? remaining|insufficient[_ ]credits?|out of credits|credit_balance_exhausted|billing_hard_limit|insufficient[_ ]quota|payment required|api usage limits?|usage limits? (?:have been|were) reached|prepayment credits|credits are depleted/i;

/** Sinais de limite que PASSA sozinho (por minuto, "tente de novo em Ns"). */
const LIMITE_PASSAGEIRO = /per[ _-]?minute|requests? per min|tokens? per min|\bTPM\b|\bRPM\b|retry in \d|retry[ _-]?delay|rate[ _-]?limit/i;
/** Cota por DIA: não passa em segundos. Ganha do sinal acima (a mensagem do Gemini cita as duas). */
const COTA_DO_DIA = /per[ _-]?day|\bdaily\b|requests? per day/i;

export function ehErroDeSaldoOuCota(err: unknown): boolean {
  if (err == null) return false;
  if (err instanceof Error && err.name === 'LlmTimeoutError') return false;

  if (statusDe(err) === 402) return true;

  const msg = mensagemDe(err);
  if (SALDO_DURO.test(msg)) return true;
  // O que sobra é texto de cota ambíguo (ehErroDeSaldo cobre "exceeded ... quota"): só vale se NÃO for limite passageiro.
  if (LIMITE_PASSAGEIRO.test(msg) && !COTA_DO_DIA.test(msg)) return false;
  return ehErroDeSaldo(msg);
}
