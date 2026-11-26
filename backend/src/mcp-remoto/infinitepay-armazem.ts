/** A tabela `infinitepay_links` (links de pagamento criados pelo conector) como o conector a lê. */
import type { ArmazemDeLinks, FiltroDeLinks, LinkGuardado } from './infinitepay.js';

/** O pedaço do cliente do Prisma que a leitura usa (facilita o teste sem banco). */
export interface LinhaDoLink {
  unitSlug: string;
  orderNsu: string;
  status: string;
  url: string | null;
  valorCentavos: number;
  descricao: string;
  validoAte: Date | null;
  criadoPor: string;
  createdAt: Date;
  invoiceSlug: string | null;
  transactionNsu: string | null;
  formaPagamento: string | null;
  parcelas: number | null;
  valorPagoCentavos: number | null;
  reciboUrl: string | null;
  pagoEm: Date | null;
  liquidadoEm: Date | null;
  ultimoEvento: string | null;
  erro: string | null;
}

export interface BancoDeLinks {
  infinitepayLink: {
    findMany(args: { where: Record<string, unknown>; orderBy: { createdAt: 'desc' }; take: number }): Promise<LinhaDoLink[]>;
    findUnique(args: { where: { unitSlug_orderNsu: { unitSlug: string; orderNsu: string } } }): Promise<LinhaDoLink | null>;
  };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function comoLinkGuardado(l: LinhaDoLink): LinkGuardado {
  return {
    orderNsu: l.orderNsu,
    unidade: l.unitSlug,
    status: l.status,
    url: l.url,
    valorCentavos: l.valorCentavos,
    descricao: l.descricao,
    validoAte: iso(l.validoAte),
    criadoPor: l.criadoPor,
    criadoEm: l.createdAt.toISOString(),
    invoiceSlug: l.invoiceSlug,
    transactionNsu: l.transactionNsu,
    formaPagamento: l.formaPagamento,
    parcelas: l.parcelas,
    valorPagoCentavos: l.valorPagoCentavos,
    reciboUrl: l.reciboUrl,
    pagoEm: iso(l.pagoEm),
    liquidadoEm: iso(l.liquidadoEm),
    ultimoEvento: l.ultimoEvento,
    erro: l.erro,
  };
}

export function armazemDeLinksPrisma(db: BancoDeLinks): ArmazemDeLinks {
  return {
    async listar(f: FiltroDeLinks) {
      const criado = { ...(f.de ? { gte: f.de } : {}), ...(f.ate ? { lte: f.ate } : {}) };
      const campo = f.campoData === 'pago' ? 'pagoEm' : 'createdAt';
      const linhas = await db.infinitepayLink.findMany({
        where: {
          unitSlug: f.unidade,
          ...(f.status ? { status: f.status } : {}),
          ...(f.orderNsu ? { orderNsu: f.orderNsu } : {}),
          ...(Object.keys(criado).length ? { [campo]: criado } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: f.limite,
      });
      return linhas.map(comoLinkGuardado);
    },
    async porOrderNsu(unidade, orderNsu) {
      const l = await db.infinitepayLink.findUnique({ where: { unitSlug_orderNsu: { unitSlug: unidade, orderNsu } } });
      return l ? comoLinkGuardado(l) : null;
    },
  };
}
