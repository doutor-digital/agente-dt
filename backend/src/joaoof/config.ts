/**
 * Joaoof (27/11/2026) — o agente que trabalha pelo João. FASE 1: fala SÓ com o João, pelo Telegram.
 * Nada aqui manda mensagem a unidade, equipe ou paciente.
 *
 * Chaves (todas lidas na hora, para o teste poder injetar `env`):
 *   JOAOOF_LIGADO            desligado (padrão) | seco | ligado.
 *                            seco  = lê, raciocina, grava demanda e registra o aviso que mandaria, mas NÃO manda Telegram.
 *                            ligado = manda. Valor desconhecido = desligado (nunca liga por engano).
 *   JOAOOF_TETO_BRL          teto do mês em reais (padrão 300).
 *   JOAOOF_USD_BRL           câmbio do custo (padrão 5,8 — folga para cima; o gasto nunca é subestimado).
 *   JOAOOF_MODELO_BARATO     triagem em lote e respostas curtas (padrão claude-haiku-4-5).
 *   JOAOOF_MODELO_FORTE      só raciocínio difícil (padrão claude-sonnet-5).
 *   JOAOOF_ANTHROPIC_API_KEY chave do modelo; se ausente usa a ANTHROPIC_API_KEY do servidor (a mesma da rede) — nunca a de uma clínica.
 *   JOAOOF_TELEGRAM_TOKEN/_CHAT   bot próprio do Joaoof (opcional); sem eles usa o DD-Avisos.
 *   JOAOOF_TELEGRAM_SEGREDO       segredo do webhook (cabeçalho do Telegram).
 */
import { CHAT_JOAO_PADRAO, type CanalTelegram } from '../lib/telegram.js';

export type ModoJoaoof = 'desligado' | 'seco' | 'ligado';

export function modoDoJoaoof(valor: string | undefined | null): ModoJoaoof {
  const v = String(valor ?? '').trim().toLowerCase();
  if (v === 'ligado' || v === '1' || v === 'true' || v === 'sim') return 'ligado';
  if (v === 'seco') return 'seco';
  return 'desligado';
}

export function valorDoModoReconhecido(valor: string | undefined | null): boolean {
  const v = String(valor ?? '').trim().toLowerCase();
  return v === '' || ['ligado', '1', 'true', 'sim', 'seco', 'desligado', '0', 'false', 'nao', 'não'].includes(v);
}

/** O único chat que o Joaoof atende e para o qual escreve. */
export function chatDoJoao(env: NodeJS.ProcessEnv = process.env): string {
  // JOAOOF_TELEGRAM_CHAT só vale junto do token próprio (o id de um chat não serve para outro bot — mesma regra do `lib/telegram.ts`)
  const proprio = String(env.JOAOOF_TELEGRAM_TOKEN ?? '').trim() ? String(env.JOAOOF_TELEGRAM_CHAT ?? '').trim() : '';
  return String(proprio || env.TELEGRAM_CHAT_JOAO || env.TELEGRAM_CHAT_ID || CHAT_JOAO_PADRAO).trim();
}

/**
 * O bot do Joaoof é CONFIGURÁVEL: com `JOAOOF_TELEGRAM_TOKEN` (e, se quiser, `JOAOOF_TELEGRAM_CHAT`) ele fala por um bot só dele; sem eles o canal
 * `joaoof` cai no DD-Avisos (`TELEGRAM_BOT_TOKEN`), como todo canal sem token próprio. O João decide depois, sem mexer em código.
 */
export function canalDoJoaoof(): CanalTelegram {
  return 'joaoof';
}

/** Número ≥ `minimo`; vazio ou lixo cai no padrão. (O teto aceita 0: «não gaste nada».) */
function numero(v: string | undefined, padrao: number, minimo: number): number {
  if (String(v ?? '').trim() === '') return padrao;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n >= minimo ? n : padrao;
}

export interface OrcamentoConfig {
  tetoBrl: number;
  usdBrl: number;
  /** a partir daqui avisa (uma vez por mês); em 100% para */
  avisoEm: number;
}

export function orcamentoDoJoaoof(env: NodeJS.ProcessEnv = process.env): OrcamentoConfig {
  return { tetoBrl: numero(env.JOAOOF_TETO_BRL, 300, 0), usdBrl: numero(env.JOAOOF_USD_BRL, 5.8, 0.01), avisoEm: 0.8 };
}

export function modelosDoJoaoof(env: NodeJS.ProcessEnv = process.env): { barato: string; forte: string } {
  return {
    barato: String(env.JOAOOF_MODELO_BARATO ?? '').trim() || 'claude-haiku-4-5',
    forte: String(env.JOAOOF_MODELO_FORTE ?? '').trim() || 'claude-sonnet-5',
  };
}

/** Horas (Brasília/Tocantins, UTC−3) dos resumos. */
export const HORAS_DO_RESUMO = [8, 18] as const;
export const FUSO_DO_JOAO = 'America/Sao_Paulo';

/** Rótulo do gasto em `llm_calls.endpoint`: soma do mês = tudo que começa por isto. */
export const ROTULO_LLM = 'joaoof';
