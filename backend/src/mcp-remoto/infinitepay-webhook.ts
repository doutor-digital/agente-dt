/**
 * O aviso (webhook) da InfinitePay: ela avisa o conector quando um link CRIADO POR ELE é pago, liquidado, estornado, cancelado ou falha.
 *
 * O webhook da InfinitePay NÃO tem assinatura, então a desconfiança é de duas camadas:
 *   1. o endereço de cada link carrega uma assinatura NOSSA (HMAC da unidade + order_nsu com um segredo derivado do servidor): quem não conhece o
 *      endereço não consegue avisar nada, e o endereço de um link não serve a outro. Assinatura errada = 404 e conta no limite por IP;
 *   2. o corpo NUNCA é confiado para dar um link como pago: o conector confirma no `/payment_check` (slug + transaction_nsu + order_nsu) e confere o
 *      valor com o do link. Só então o status vira `pago`. Aviso que não se confirma só fica registrado e vai para o Telegram do João.
 * Estorno e cancelamento não têm como ser confirmados pela API (o /payment_check só diz se pagou), então valem pela camada 1 e SEMPRE avisam o João.
 *
 * Responde 200 quando tratou (inclusive quando o aviso não se confirmou: repetir não ajuda), 503 quando a confirmação falhou por indisponibilidade
 * (a InfinitePay tenta de novo) e 404 para assinatura errada ou link desconhecido. O corpo recebido nunca vai para o log.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { dinheiro } from './asaas-limites.js';
import type { ContextoInfinitepay } from './infinitepay.js';
import { reais } from './infinitepay.js';
import type { ArmazemDeEscrita } from './infinitepay-escrita.js';
import { ipDoCliente, JanelaDeContagem } from './limites.js';

export const ROTA_WEBHOOK_INFINITEPAY = '/infinitepay/webhook/:unidade/:orderNsu/:assinatura';

export function assinaturaDoAviso(segredo: string, unidade: string, orderNsu: string): string {
  return createHmac('sha256', segredo).update(`${unidade}|${orderNsu}`).digest('hex').slice(0, 32);
}

export function urlDoAviso(origem: string, segredo: string, unidade: string, orderNsu: string): string {
  return `${origem.replace(/\/+$/, '')}/infinitepay/webhook/${encodeURIComponent(unidade)}/${encodeURIComponent(orderNsu)}/${assinaturaDoAviso(segredo, unidade, orderNsu)}`;
}

function assinaturaBoa(segredo: string, unidade: string, orderNsu: string, recebida: string): boolean {
  const certa = Buffer.from(assinaturaDoAviso(segredo, unidade, orderNsu));
  const veio = Buffer.from(recebida);
  return certa.length === veio.length && timingSafeEqual(certa, veio);
}

export interface DepsDoAviso {
  ctx: ContextoInfinitepay;
  armazem: ArmazemDeEscrita;
  segredo: string;
  alertar: (texto: string) => Promise<boolean>;
  log?: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
}

export interface RespostaDoAviso {
  http: 200 | 404 | 503;
  resultado: string;
}

const texto = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const inteiro = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);

/** O nome do evento, se o corpo trouxer (a documentação só mostra o corpo do `paid`, sem o campo): minúsculo, ou undefined. */
function eventoDoCorpo(c: Record<string, unknown>): string | undefined {
  return (texto(c.event, 40) ?? texto(c.type, 40) ?? texto(c.event_type, 40))?.toLowerCase();
}

export async function processarAviso(deps: DepsDoAviso, p: { unidade: string; orderNsu: string; assinatura: string }, corpoBruto: unknown): Promise<RespostaDoAviso> {
  if (!assinaturaBoa(deps.segredo, p.unidade, p.orderNsu, p.assinatura)) return { http: 404, resultado: 'assinatura' };
  const conta = deps.ctx.contas.get(p.unidade);
  if (!conta) return { http: 404, resultado: 'unidade sem InfinitePay' };
  const link = await deps.armazem.porOrderNsu(p.unidade, p.orderNsu);
  if (!link || link.status === 'falhou') return { http: 404, resultado: 'link desconhecido' };
  const corpo = corpoBruto && typeof corpoBruto === 'object' && !Array.isArray(corpoBruto) ? (corpoBruto as Record<string, unknown>) : {};
  const doCorpo = texto(corpo.order_nsu, 100);
  if (doCorpo && doCorpo !== p.orderNsu) return { http: 404, resultado: 'order_nsu do corpo não é o do endereço' };
  const evento = eventoDoCorpo(corpo) ?? 'paid';
  const quem = `${conta.nome} · ${p.orderNsu} · ${dinheiro(link.valorCentavos / 100)}`;

  if (evento === 'refunded') {
    const r = await deps.armazem.aplicarEvento(p.unidade, p.orderNsu, { evento, paraStatus: 'estornado', deStatus: ['intencao', 'criado', 'pago'] });
    void deps.alertar(`↩️ InfinitePay avisou um ESTORNO (${quem}). ${r.mudou ? 'Marquei o link como estornado.' : 'O link já estava marcado.'} Confira no app da InfinitePay.`).catch(() => false);
    return { http: 200, resultado: 'estornado' };
  }
  if (evento === 'canceled') {
    const r = await deps.armazem.aplicarEvento(p.unidade, p.orderNsu, { evento, paraStatus: 'cancelado', deStatus: ['intencao', 'criado'] });
    void deps.alertar(`🚫 InfinitePay avisou um link CANCELADO (${quem}). ${r.mudou ? 'Marquei como cancelado.' : 'Nada mudou (já estava pago ou marcado).'}`).catch(() => false);
    return { http: 200, resultado: 'cancelado' };
  }
  if (evento !== 'paid' && evento !== 'settled') {
    // created, payment_failed ou evento que não conhecemos: só fica registrado
    await deps.armazem.aplicarEvento(p.unidade, p.orderNsu, { evento });
    return { http: 200, resultado: `registrado:${evento}` };
  }

  // paid e settled: só valem depois do /payment_check
  const slug = texto(corpo.invoice_slug, 120) ?? texto(corpo.slug, 120);
  const transacao = texto(corpo.transaction_nsu, 120);
  if (!slug || !transacao) {
    await deps.armazem.aplicarEvento(p.unidade, p.orderNsu, { evento: `${evento}:sem_codigos` });
    void deps.alertar(`⚠️ InfinitePay avisou pagamento sem invoice_slug/transaction_nsu (${quem}); não dá para confirmar. Veja no app.`).catch(() => false);
    return { http: 200, resultado: 'sem códigos para confirmar' };
  }
  let lido;
  try {
    lido = await conta.fonte.consultar({ orderNsu: p.orderNsu, transactionNsu: transacao, slug });
  } catch (e) {
    deps.log?.warn({ unidade: p.unidade, orderNsu: p.orderNsu, erro: e instanceof Error ? e.message : String(e) }, 'infinitepay: não consegui confirmar o aviso (a InfinitePay tenta de novo)');
    return { http: 503, resultado: 'confirmação indisponível' };
  }
  if (!lido.pago) {
    await deps.armazem.aplicarEvento(p.unidade, p.orderNsu, { evento: `${evento}:nao_confirmado` });
    void deps.alertar(`⚠️ InfinitePay avisou pagamento que o /payment_check NÃO confirmou (${quem}). Não marquei como pago. Confira no app.`).catch(() => false);
    return { http: 200, resultado: 'não confirmado' };
  }
  if (lido.valorCentavos !== undefined && lido.valorCentavos !== link.valorCentavos) {
    await deps.armazem.aplicarEvento(p.unidade, p.orderNsu, { evento: `${evento}:valor_diferente` });
    void deps.alertar(`⚠️ InfinitePay confirmou pagamento de ${dinheiro(lido.valorCentavos / 100)} num link de ${dinheiro(link.valorCentavos / 100)} (${quem}). Não marquei como pago. Confira no app.`).catch(() => false);
    return { http: 200, resultado: 'valor diferente' };
  }
  const recibo = texto(corpo.receipt_url, 500);
  const pagamento = {
    invoiceSlug: slug,
    transactionNsu: transacao,
    ...(lido.forma ? { forma: lido.forma } : {}),
    ...(lido.parcelas !== undefined ? { parcelas: lido.parcelas } : {}),
    ...(lido.valorPagoCentavos !== undefined ? { valorPagoCentavos: lido.valorPagoCentavos } : inteiro(corpo.paid_amount) !== undefined ? { valorPagoCentavos: inteiro(corpo.paid_amount)! } : {}),
    ...(recibo && /^https:\/\//.test(recibo) ? { reciboUrl: recibo } : {}),
  };
  // o pagamento primeiro (settled sem paid anterior também confirma e marca); a liquidação só se acrescenta ao que já está pago
  const pago = await deps.armazem.aplicarEvento(p.unidade, p.orderNsu, { evento: 'paid', paraStatus: 'pago', deStatus: ['intencao', 'criado'], pagamento });
  if (pago.mudou) deps.log?.info({ unidade: p.unidade, orderNsu: p.orderNsu, valor: reais(link.valorCentavos) }, 'infinitepay: pagamento confirmado');
  if (evento === 'settled') {
    await deps.armazem.aplicarEvento(p.unidade, p.orderNsu, { evento, liquidado: true });
  }
  return { http: 200, resultado: pago.mudou ? 'pago' : evento === 'settled' ? 'liquidado' : 'já estava pago' };
}

/** A rota pública. O corpo já vem lido pelo `express.json` geral (1 MB). Não devolve nada além de {ok}: quem sonda não aprende o que existe. */
export function montarRotaDoWebhookInfinitepay(app: Express, deps: DepsDoAviso, o: { tentativasPorIp?: JanelaDeContagem } = {}): void {
  const erros = o.tentativasPorIp ?? new JanelaDeContagem(30, 10 * 60_000);
  app.post(ROTA_WEBHOOK_INFINITEPAY, (req: Request, res: Response) => {
    void (async () => {
      const ip = ipDoCliente(req);
      if (erros.excedido(ip, Date.now())) {
        res.status(429).set('Retry-After', '600').json({ ok: false });
        return;
      }
      try {
        const r = await processarAviso(deps, { unidade: String(req.params.unidade), orderNsu: String(req.params.orderNsu), assinatura: String(req.params.assinatura) }, req.body);
        if (r.resultado === 'assinatura') erros.registrar(ip, Date.now());
        res.status(r.http).json({ ok: r.http === 200 });
      } catch (e) {
        deps.log?.warn({ erro: e instanceof Error ? e.message : String(e) }, 'infinitepay: aviso com falha (a InfinitePay tenta de novo)');
        res.status(503).json({ ok: false });
      }
    })();
  });
}
