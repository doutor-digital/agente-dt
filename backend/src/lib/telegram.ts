/**
 * Alerta no Telegram do João — o canal que sobrou depois que o WhatsApp dos alertas foi banido (06/10/2026).
 *
 * Mesmo bot da central de chamados (`chamados-dd/api/avisos.js`): o token vem de `TELEGRAM_BOT_TOKEN` no
 * `.env` do servidor e nunca é escrito no código. O destino padrão é o chat do João; quando os alertas
 * forem para os grupos das unidades (decisão de 16/10: "depois"), quem chama passa o `chat`.
 *
 * Regras de segurança:
 *  - a URL da API carrega o token, então NADA desta chamada vai para o log além do código HTTP e do tipo
 *    do erro — e mesmo isso passa por `semSegredo`;
 *  - sem token configurado, não manda e devolve false (quem chama decide se registra);
 *  - nunca lança: alerta que falha não pode derrubar o worker.
 */
import { logger } from './logger.js';

/** Chat do João no Telegram (o mesmo dos avisos da central de chamados). Não é segredo: sem o token não serve para nada. */
export const CHAT_JOAO_PADRAO = '7822226023';

/** O Telegram corta em 4096; folga para os acentos e o link. */
const TETO_TEXTO = 3500;

export interface ConfigTelegram {
  token: string;
  chat: string;
  api: string;
}

export function configTelegram(env: NodeJS.ProcessEnv = process.env): ConfigTelegram | null {
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) return null;
  return {
    token,
    chat: String(env.TELEGRAM_CHAT_JOAO || env.TELEGRAM_CHAT_ID || CHAT_JOAO_PADRAO).trim(),
    api: (env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, ''),
  };
}

export function telegramConfigurado(env: NodeJS.ProcessEnv = process.env): boolean {
  return configTelegram(env) !== null;
}

/** Troca o token por *** em qualquer texto que vá para o log. */
export function semSegredo(texto: string, token: string | null | undefined): string {
  const s = String(texto ?? '');
  return token && token.length >= 4 ? s.split(token).join('***') : s;
}

export interface OpcoesTelegram {
  /** Outro destino (grupo da unidade, no futuro). Padrão: o chat do João. */
  chat?: string;
  env?: NodeJS.ProcessEnv;
  /** Injetável para teste — o padrão é o `fetch` do Node. */
  fetch?: typeof fetch;
}

/** true = o Telegram aceitou; false = sem configuração ou falhou (já registrado, sem segredo). */
export async function enviarTelegram(texto: string, opcoes: OpcoesTelegram = {}): Promise<boolean> {
  const cfg = configTelegram(opcoes.env);
  if (!cfg) {
    logger.warn('telegram: sem TELEGRAM_BOT_TOKEN — alerta não enviado (só log)');
    return false;
  }
  const buscar = opcoes.fetch ?? globalThis.fetch;
  try {
    const r = await buscar(`${cfg.api}/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: opcoes.chat ?? cfg.chat,
        text: String(texto ?? '').slice(0, TETO_TEXTO),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      logger.warn({ status: r.status }, 'telegram: o Telegram recusou o alerta');
      return false;
    }
    return true;
  } catch (err) {
    const e = err as { name?: string; code?: string; cause?: { code?: string } } | null;
    const tipo = semSegredo(String(e?.cause?.code ?? e?.code ?? e?.name ?? 'erro'), cfg.token).slice(0, 60);
    logger.warn({ tipo }, 'telegram: falha de rede ao enviar o alerta');
    return false;
  }
}
