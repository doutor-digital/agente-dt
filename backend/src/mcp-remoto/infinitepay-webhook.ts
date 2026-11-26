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
 * Responde 200 quando tratou, 503 quando a confirmação não pôde ser feita ou ainda não mostra o pagamento (a InfinitePay tenta de novo) e 404 para assinatura errada ou link desconhecido. O corpo recebido nunca vai para o log.
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

/**
 * O evento, se o corpo trouxer (a documentação só mostra o corpo do `paid`, sem o campo). O nome é lido pelo SENTIDO, não pela grafia exata: "payment.paid",
 * "invoice.refunded" e "REFUNDED" são o mesmo que "paid" e "refunded". Nome que não se reconhece volta como `desconhecido:<nome>` e AVISA o João (nunca some em silêncio).
 */
export function eventoDoCorpo(c: Record<string, unknown>): string | undefined {
  const bruto = (texto(c.event, 60) ?? texto(c.type, 60) ?? texto(c.event_type, 60))?.toLowerCase();
  if (!bruto) return undefined;
  if (/refund|estorn/.test(bruto)) return 'refunded';
  if (/cancel/.test(bruto)) return 'canceled';
  if (/settl|liquid/.test(bruto)) return 'settled';
  if (/fail|negad|denied/.test(bruto)) return 'payment_failed';
  if (/created|criad/.test(bruto)) return 'created';
  if (/paid|approved|aprovad|pago/.test(bruto)) return 'paid';
  return `desconhecido:${bruto.replace(/[^a-z0-9_.:-]/g, '').slice(0, 40)}`;
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
  // o que o link tinha ANTES deste aviso (o armazém pode devolver o mesmo objeto que depois atualiza)
  const eventoAnterior = link.ultimoEvento;

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
    // created e payment_failed só ficam registrados; evento que não conhecemos também, mas avisa o João (pode ser um pagamento ou estorno com outro nome)
    await deps.armazem.aplicarEvento(p.unidade, p.orderNsu, { evento });
    if (evento.startsWith('desconhecido:')) void deps.alertar(`⚠️ InfinitePay mandou um aviso com evento que o conector não conhece (${evento.slice(13)}) para ${quem}. Registrei e não mudei nada: confira no app.`).catch(() => false);
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
    // pode ser só a consulta chegando antes do pagamento aparecer: responde 503 para a InfinitePay TENTAR DE NOVO, e avisa o João uma vez só (não a cada tentativa)
    const marca = `${evento}:nao_confirmado`;
    await deps.armazem.aplicarEvento(p.unidade, p.orderNsu, { evento: marca });
    if (eventoAnterior !== marca) void deps.alertar(`⚠️ InfinitePay avisou pagamento que o /payment_check ainda NÃO confirma (${quem}). Não marquei como pago; a InfinitePay tenta de novo. Se não resolver, confira no app.`).catch(() => false);
    return { http: 503, resultado: 'não confirmado' };
  }
  // o valor É conferido: sem `amount` na confirmação (formato novo?) não dá para provar que é o valor do link, e então NÃO se marca pago
  if (lido.valorCentavos === undefined || lido.valorCentavos !== link.valorCentavos) {
    await deps.armazem.aplicarEvento(p.unidade, p.orderNsu, { evento: `${evento}:valor_diferente` });
    void deps.alertar(
      lido.valorCentavos === undefined
        ? `⚠️ InfinitePay confirmou pagamento SEM o valor (${quem}). Não consigo conferir com o link e não marquei como pago. Confira no app.`
        : `⚠️ InfinitePay confirmou pagamento de ${dinheiro(lido.valorCentavos / 100)} num link de ${dinheiro(link.valorCentavos / 100)} (${quem}). Não marquei como pago. Confira no app.`,
    ).catch(() => false);
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
