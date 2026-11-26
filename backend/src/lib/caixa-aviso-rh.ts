/**
 * Avisa a função do RH (o Caixa) quando um link que o CAIXA pediu é pago. Escuta o evento `aoLinkPago` (lib/link-pago.ts: UMA vez por link, só com pagamento confirmado).
 *
 * O que sai: JSON sem dado pessoal (nada de nome, telefone ou CPF) — unidade, a referência de origem do Caixa, o order_nsu e o NSU da transação, valores, forma, parcelas e o instante. SEM o recibo: o recibo da InfinitePay mostra nome e CPF de quem pagou; a equipe o vê no app da InfinitePay.
 * A assinatura: `x-dd-assinatura` = HMAC-SHA256 hex de `<x-dd-timestamp>.<corpo>` com CAIXA_RH_WEBHOOK_SEGREDO (32+); o RH recusa carimbo com mais de 5 minutos e repetição.
 * Só os links de origem `cx-…` (os que o Caixa pediu); os links do conector e da Sofia passam sem que nada saia. NÃO depende de CAIXA_LINK_UNIDADES (essa lista fecha só a CRIAÇÃO): um link já enviado ao paciente é avisado mesmo se a unidade saiu da lista.
 *
 * Falha: tenta de novo (esperas 0, 2 s, 10 s, 60 s); 4xx (menos 408/429) não repete (é configuração); no fim avisa o João. Nada se perde de verdade: o RH PUXA o status
 * do link quando alguém abre o lançamento (`GET /interno/caixa/status`), e a criação do lançamento é idempotente pelo link.
 */
import { createHmac } from 'node:crypto';
import type { ArmazemDeEscrita } from '../mcp-remoto/infinitepay-escrita.js';
import type { LinkPago, OuvinteDeLinkPago } from './link-pago.js';

export const PREFIXO_ORIGEM_CAIXA = 'cx-';
export const SEGREDO_MINIMO_RH = 32;

export function assinaturaParaORh(segredo: string, timestamp: string, corpo: string): string {
  return createHmac('sha256', segredo).update(`${timestamp}.${corpo}`).digest('hex');
}

export interface ConfigAvisoRh {
  url: string;
  segredo: string;
}

/** A configuração do ambiente: URL http(s) válida e segredo de 32+ caracteres. Qualquer coisa fora disso = sem aviso (null). */
export function configAvisoRhDoAmbiente(e: NodeJS.ProcessEnv = process.env): ConfigAvisoRh | null {
  const segredo = e.CAIXA_RH_WEBHOOK_SEGREDO?.trim();
  const bruta = e.CAIXA_RH_WEBHOOK_URL?.trim();
  if (!bruta || !segredo || segredo.length < SEGREDO_MINIMO_RH) return null;
  try {
    const u = new URL(bruta);
    // https sempre; http só para dentro da máquina/da rede do Docker (nome sem ponto, localhost): o corpo leva valores, forma e o carimbo da assinatura
    const interno = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || !u.hostname.includes('.');
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && interno)) return null;
    return { url: u.toString(), segredo };
  } catch {
    return null;
  }
}

export interface DepsAvisoRh {
  config: ConfigAvisoRh;
  armazem: Pick<ArmazemDeEscrita, 'porOrderNsu'>;
  alertar: (texto: string) => Promise<boolean>;
  fetchFn?: typeof fetch;
  agora?: () => number;
  /** esperas antes de cada tentativa, em ms (a primeira é 0) */
  esperas?: number[];
  dorme?: (ms: number) => Promise<void>;
  log?: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
  /** só para teste: true = o ouvinte espera o envio (e as repetições) terminar. Em produção NÃO espera (ver abaixo). */
  esperar?: boolean;
}

const ESPERAS_PADRAO = [0, 2_000, 10_000, 60_000];
const dormePadrao = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function corpoDoAviso(e: LinkPago, origemRef: string): string {
  return JSON.stringify({
    evento: 'link_pago',
    unidade: e.unidade,
    origem_ref: origemRef,
    order_nsu: e.orderNsu,
    valor_centavos: e.valorCentavos,
    transaction_nsu: e.transactionNsu ?? null,
    valor_pago_centavos: e.valorPagoCentavos ?? null,
    forma: e.forma ?? null,
    parcelas: e.parcelas ?? null,
    pago_em: e.pagoEm.toISOString(),
  });
}

export function ouvinteDoCaixa(d: DepsAvisoRh): OuvinteDeLinkPago {
  const esperas = d.esperas ?? ESPERAS_PADRAO;
  const dorme = d.dorme ?? dormePadrao;
  const f = d.fetchFn ?? fetch;
  const agora = d.agora ?? Date.now;
  return async (e) => {
    const link = await d.armazem.porOrderNsu(e.unidade, e.orderNsu);
    const origemRef = link?.origemRef;
    if (!origemRef || !origemRef.startsWith(PREFIXO_ORIGEM_CAIXA)) return;
    const corpo = corpoDoAviso(e, origemRef);
    // NÃO espera o RH: `emitirLinkPago` chama os ouvintes em fila e uma queda do RH seguraria (por ~2 min) a baixa do sinal e o resto. O envio e as repetições seguem em segundo plano.
    const envio = enviar(e, corpo);
    if (d.esperar) await envio;
    else void envio.catch(() => undefined);
  };

  async function enviar(e: LinkPago, corpo: string): Promise<void> {
    let ultimo = '';
    for (const espera of esperas) {
      if (espera > 0) await dorme(espera);
      const ts = String(Math.floor(agora() / 1000));
      try {
        const r = await f(d.config.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dd-timestamp': ts, 'x-dd-assinatura': assinaturaParaORh(d.config.segredo, ts, corpo) },
          body: corpo,
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        });
        if (r.ok) {
          d.log?.info({ unidade: e.unidade, orderNsu: e.orderNsu }, 'caixa: RH avisado do link pago');
          return;
        }
        ultimo = `HTTP ${r.status}`;
        if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) break;
      } catch (err) {
        ultimo = err instanceof Error ? err.name : 'erro';
      }
    }
    d.log?.warn({ unidade: e.unidade, orderNsu: e.orderNsu, motivo: ultimo }, 'caixa: não consegui avisar o RH do link pago');
    void d.alertar(`⚠️ Caixa: o link ${e.orderNsu} (${e.unidade}) foi PAGO, mas não consegui avisar o RH (${ultimo}). O lançamento entra quando alguém abrir o pedido no Caixa; se não entrar, confira CAIXA_RH_WEBHOOK_URL.`).catch(() => false);
  }
}
