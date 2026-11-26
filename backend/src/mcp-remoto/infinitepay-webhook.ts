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
  /** relógio (testes); padrão Date.now */
  agora?: () => number;
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
  // `event` manda; `type` e `event_type` são nomes genéricos (podem ser a forma de pagamento): só valem se parecem um evento
  const pareceEvento = (v: string | undefined) => (v && /paid|settl|refund|cancel|fail|creat|approv|estorn|liquid|pago|aprovad|criad|negad/i.test(v) ? v : undefined);
  const bruto = (texto(c.event, 60) ?? pareceEvento(texto(c.type, 60)) ?? pareceEvento(texto(c.event_type, 60)))?.toLowerCase();
  if (!bruto) return undefined;
  // estorno/cancelamento que FALHOU, está pendente ou é parcial não é estorno nem cancelamento: não muda o link, mas avisa o João (desconhecido)
  if (/refund|estorn|cancel/.test(bruto) && /fail|reject|deny|denied|negad|pend|parcial|partial|erro|error/.test(bruto)) return `desconhecido:${bruto.replace(/[^a-z0-9_.:-]/g, '').slice(0, 40)}`;
  if (/refund|estorn/.test(bruto)) return 'refunded';
  if (/cancel/.test(bruto)) return 'canceled';
  if (/settl|liquid/.test(bruto)) return 'settled';
  if (/fail|negad|denied/.test(bruto)) return 'payment_failed';
  if (/created|criad/.test(bruto)) return 'created';
  if (/paid|approved|aprovad|pago/.test(bruto)) return 'paid';
  return `desconhecido:${bruto.replace(/[^a-z0-9_.:-]/g, '').slice(0, 40)}`;
}

/** Um aviso ao João por unidade a cada 15 minutos: a InfinitePay repete a entrega e o Telegram não pode virar enxurrada. */
const JANELA_DO_ALERTA_MS = 15 * 60_000;
const ultimoAlertaDeUnidade = new WeakMap<DepsDoAviso, Map<string, number>>();

function alertaDeUnidadeAusente(deps: DepsDoAviso, unidade: string, orderNsu: string): void {
  const agora = (deps.agora ?? Date.now)();
  let m = ultimoAlertaDeUnidade.get(deps);
  if (!m) ultimoAlertaDeUnidade.set(deps, (m = new Map()));
  const antes = m.get(unidade);
  if (antes !== undefined && agora - antes < JANELA_DO_ALERTA_MS) return;
  m.set(unidade, agora);
  void deps.alertar(
    `⚠️ InfinitePay mandou um aviso de pagamento (${orderNsu}) para a unidade ${unidade}, mas o conector não tem essa unidade carregada agora (carga inicial, banco fora do ar, unidade inativada ou chave renomeada). Respondi 503: a InfinitePay tenta de novo. Se continuar, confira INFINITEPAY_CHAVE_* e o banco.`,
  ).catch(() => false);
}

export async function processarAviso(deps: DepsDoAviso, p: { unidade: string; orderNsu: string; assinatura: string }, corpoBruto: unknown): Promise<RespostaDoAviso> {
  if (!assinaturaBoa(deps.segredo, p.unidade, p.orderNsu, p.assinatura)) return { http: 404, resultado: 'assinatura' };
  const conta = deps.ctx.contas.get(p.unidade);
  if (!conta) {
    // a assinatura é NOSSA (este link foi criado por este conector): não ter a unidade carregada não é "aviso de ninguém", é falha nossa. 503 faz a InfinitePay repetir
    // (um 404 a faria desistir e o pagamento ficaria "criado" para sempre) e o João é avisado.
    alertaDeUnidadeAusente(deps, p.unidade, p.orderNsu);
    return { http: 503, resultado: 'unidade sem InfinitePay carregada' };
  }
  const link = await deps.armazem.porOrderNsu(p.unidade, p.orderNsu);
  if (!link || link.status === 'falhou') return { http: 404, resultado: 'link desconhecido' };
  const corpo = corpoBruto && typeof corpoBruto === 'object' && !Array.isArray(corpoBruto) ? (corpoBruto as Record<string, unknown>) : {};
  const doCorpo = texto(corpo.order_nsu, 100);
  if (doCorpo && doCorpo !== p.orderNsu) return { http: 404, resultado: 'order_nsu do corpo não é o do endereço' };
  const evento = eventoDoCorpo(corpo) ?? 'paid';
  const quem = `${conta.nome} · ${p.orderNsu} · ${dinheiro(link.valorCentavos / 100)}`;
  // o que o link tinha ANTES deste aviso (o armazém pode devolver o mesmo objeto que depois atualiza)
  const eventoAnterior = link.ultimoEvento;

  // Estorno e cancelamento chegam só pelo aviso: a API NÃO os confirma (o /payment_check só diz se pagou). Por isso NUNCA desfazem um link já confirmado como pago:
  // o link fica `pago` e ganha uma marca de REVISÃO (visível em infinitepay_links) e um alerta ao João, que confere no app.
  const marca = (o: string) => `${o} avisado pela InfinitePay em ${new Date((deps.agora ?? Date.now)()).toISOString()}, NÃO confirmado pela API (o /payment_check só confirma pagamento): confira no app`;
  if (evento === 'refunded') {
    // estorno não muda o status (nem de `pago`, nem de link ainda não pago): só marca para revisão
    await deps.armazem.aplicarEvento(p.unidade, p.orderNsu, { evento, revisao: marca('estorno') });
    void deps.alertar(`↩️ InfinitePay avisou um ESTORNO (${quem}). NÃO confirmado pela API: não mudei o status (${link.status}); o link ficou marcado para revisão. Confira no app da InfinitePay.`).catch(() => false);
    return { http: 200, resultado: 'estorno marcado para revisão' };
  }
  if (evento === 'canceled') {
    // cancelamento de um link que ainda não foi pago vale como cancelado (sem pagamento a proteger); sobre um `pago` só marca para revisão
    const antesDoPagamento = link.status === 'intencao' || link.status === 'criado';
    await deps.armazem.aplicarEvento(p.unidade, p.orderNsu, { evento, revisao: marca('cancelamento'), ...(antesDoPagamento ? { paraStatus: 'cancelado' as const, deStatus: ['intencao', 'criado'] } : {}) });
    void deps.alertar(`🚫 InfinitePay avisou um link CANCELADO (${quem}). NÃO confirmado pela API. ${antesDoPagamento ? 'Marquei como cancelado (ainda não estava pago).' : `NÃO sobrescrevi o status (${link.status}): o link ficou marcado para revisão.`} Confira no app.`).catch(() => false);
    return { http: 200, resultado: antesDoPagamento ? 'cancelado' : 'cancelamento marcado para revisão' };
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
  // o dinheiro entrou mas o link está em outro estado (cancelado ou estornado por um aviso que chegou antes, fora de ordem): ninguém pode ficar sem saber
  if (!pago.mudou && link.status !== 'pago' && link.status !== 'intencao' && link.status !== 'criado') {
    void deps.alertar(`⚠️ InfinitePay CONFIRMOU o pagamento de ${quem}, mas o link está como "${link.status}" (um aviso de ${link.status === 'estornado' ? 'estorno' : 'cancelamento'} chegou antes ou fora de ordem). Não mudei o status. Confira no app.`).catch(() => false);
    return { http: 200, resultado: `pagamento confirmado com o link em ${link.status}` };
  }
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
