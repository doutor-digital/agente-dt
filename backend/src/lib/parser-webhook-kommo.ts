/**
 * Parser do corpo do webhook do KOMMO, com folga só nessa rota.
 *
 * O Kommo manda o webhook em form-urlencoded, e cada campo do cartão vira vários parâmetros
 * (`leads[status][0][custom_fields][3][values][0][value]=…`). O parser geral do servidor
 * (`express.urlencoded`, body-parser 2.2.2) para em 1000 parâmetros e devolve 413 ANTES do handler —
 * medido em 16/10/2026: 16 cartões com 30 campos já estouram. Com o evento `status_lead` (mudança de
 * etapa) chegando, uma movimentação em lote (a franquia movendo, a SDR arrastando vários) estourava, e
 * webhook que falha seguidas vezes o Kommo DESLIGA.
 *
 * Por isso este parser monta ANTES do geral e só nos caminhos do webhook do Kommo (`/api/webhooks/:slug/kommo`
 * e o antigo, sem unidade, `/api/webhooks/kommo`) — o resto do servidor continua com o limite de sempre. O body-parser marca o corpo como lido, e o parser geral
 * logo depois não lê de novo.
 */
import express, { type RequestHandler } from 'express';

/** Os caminhos do webhook do Kommo (os mesmos de `api.routes.ts`, com o prefixo `/api` do servidor). */
export const ROTA_WEBHOOK_KOMMO = ['/api/webhooks/:unitSlug/kommo', '/api/webhooks/kommo'];

/** ~50 cartões com 100 campos cada. Acima disso o Kommo divide o envio. */
export const LIMITE_PARAMETROS_KOMMO = 50_000;
export const LIMITE_BYTES_KOMMO = '5mb';

export function parserDoWebhookKommo(): RequestHandler {
  return express.urlencoded({ extended: true, limit: LIMITE_BYTES_KOMMO, parameterLimit: LIMITE_PARAMETROS_KOMMO });
}
