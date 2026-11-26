/**
 * O evento «link da InfinitePay PAGO»: o ponto de encontro entre quem CONFIRMA o pagamento (o aviso assinado da InfinitePay, que só vira `pago` depois do
 * `/payment_check` com o valor conferido: mcp-remoto/infinitepay-webhook.ts) e quem reage a ele (a baixa do sinal no cartão, a nota fiscal automática…).
 *
 * Contrato (Lei de Hyrum: quem escuta passa a depender disto):
 *  - dispara UMA vez por link, na transição para `pago` (a reentrega do mesmo aviso não repete);
 *  - dispara só com pagamento CONFIRMADO; nunca por aviso que o `/payment_check` não provou;
 *  - o evento NÃO carrega dado pessoal (nome, telefone, CPF): quem precisa dele busca no cartão/cadastro pelo `leadId` (ver `sinalDoLink` em sinal-infinitepay.ts);
 *  - um ouvinte que lança não derruba o aviso (a InfinitePay já recebeu o 200) nem os outros ouvintes: o erro vai para o log, sem o evento dentro.
 */
import { logger } from './logger.js';

export interface LinkPago {
  /** o slug da unidade dona da conta InfinitePay */
  unidade: string;
  /** a referência do pedido (order_nsu), única por unidade */
  orderNsu: string;
  /** o valor do LINK (o que o `/payment_check` confirmou ser igual) */
  valorCentavos: number;
  descricao: string;
  invoiceSlug?: string;
  transactionNsu?: string;
  forma?: string;
  parcelas?: number;
  valorPagoCentavos?: number;
  reciboUrl?: string;
  pagoEm: Date;
}

export type OuvinteDeLinkPago = (e: LinkPago) => Promise<void> | void;

const ouvintes = new Set<OuvinteDeLinkPago>();

/** Escuta os links pagos. Devolve a função que para de escutar. O mesmo ouvinte registrado duas vezes conta uma só. */
export function aoLinkPago(ouvinte: OuvinteDeLinkPago): () => void {
  ouvintes.add(ouvinte);
  return () => void ouvintes.delete(ouvinte);
}

/** Avisa todos os ouvintes, um depois do outro. Nunca lança. */
export async function emitirLinkPago(e: LinkPago): Promise<void> {
  for (const o of [...ouvintes]) {
    try {
      await o(e);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), unidade: e.unidade, orderNsu: e.orderNsu }, 'link-pago: um ouvinte falhou (a baixa tenta de novo na próxima varredura)');
    }
  }
}
