/**
 * O relógio do Joaoof. Roda só no líder (`server.ts`, junto dos outros workers). Nasce DESLIGADO: `JOAOOF_LIGADO=seco|ligado` liga,
 * e mudar a chave vale no próximo reinício (como as demais chaves globais).
 */
import { logger } from '../lib/logger.js';
import { modoDoJoaoof, valorDoModoReconhecido } from './config.js';
import { passoDoJoaoof, type DepsPasso } from './passo.js';
import { depsDoPasso, loteReal, telegramDoJoaoofConfigurado } from './producao.js';

const PASSO_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let rodando = false;

/** `lote`: a triagem dos grupos (padrão: a real); o teste passa outro. */
export function startJoaoofWorker(lote: DepsPasso['lote'] = loteReal()): void {
  if (timer) return;
  const raw = process.env.JOAOOF_LIGADO;
  if (!valorDoModoReconhecido(raw)) logger.warn({ valor: raw }, 'joaoof: JOAOOF_LIGADO com valor desconhecido — tratado como desligado. Use desligado, seco ou ligado');
  const modo = modoDoJoaoof(raw);
  if (modo === 'desligado') {
    logger.info('joaoof: desligado (JOAOOF_LIGADO) — worker não iniciado');
    return;
  }
  const deps = depsDoPasso(lote);
  timer = setInterval(() => {
    if (rodando) return;
    rodando = true;
    void passoDoJoaoof(deps)
      .catch((err) => logger.error({ err: String(err) }, 'joaoof: passo falhou'))
      .finally(() => {
        rodando = false;
      });
  }, PASSO_MS);
  timer.unref?.();
  logger.info({ modo, passoMs: PASSO_MS, telegram: telegramDoJoaoofConfigurado() }, 'joaoof: worker ligado');
}

export function stopJoaoofWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
