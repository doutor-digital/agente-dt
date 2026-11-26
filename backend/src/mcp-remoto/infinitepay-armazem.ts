/** A tabela `infinitepay_links` (links de pagamento criados pelo conector) como o conector a lê. */
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import type { ArmazemDeLinks, FiltroDeLinks, LinkGuardado } from './infinitepay.js';
import { FALHA_DO_BANCO_INFINITEPAY, LIMITES_INFINITEPAY, LivroDeLinks, type ArmazemDeEscrita, type EventoDoLink, type ItemDoLivro, type PedidoDeReserva, type ResultadoDaCriacao } from './infinitepay-escrita.js';

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
  revisao: string | null;
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
    revisao: l.revisao,
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

// ----------------------------------------------------------------- escrita (criação de link e eventos do webhook)

/** O pedaço do cliente do Prisma que a escrita usa, dentro e fora da transação. */
export interface TabelaDeEscrita {
  findMany(args: { where: Record<string, unknown>; select?: Record<string, boolean>; orderBy?: Record<string, string>; take?: number }): Promise<unknown[]>;
  findUnique(args: { where: { unitSlug_orderNsu: { unitSlug: string; orderNsu: string } } }): Promise<LinhaDoLink | null>;
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

export interface BancoDeEscrita extends BancoDeLinks {
  infinitepayLink: TabelaDeEscrita & BancoDeLinks['infinitepayLink'];
  $transaction<T>(fn: (tx: { $executeRaw(consulta: TemplateStringsArray, ...valores: unknown[]): Promise<number>; infinitepayLink: TabelaDeEscrita }) => Promise<T>, opcoes?: { timeout?: number; maxWait?: number }): Promise<T>;
}

type LinhaDoLivro = { valorCentavos: number; status: string; createdAt: Date; chaveDuplicata: string | null; orderNsu: string; url: string | null };

const SELECIONA_LIVRO = { valorCentavos: true, status: true, createdAt: true, chaveDuplicata: true, orderNsu: true, url: true };

async function lerLivro(t: Pick<TabelaDeEscrita, 'findMany'>, unidade: string, agora: number): Promise<LivroDeLinks> {
  const linhas = (await t.findMany({
    where: { unitSlug: unidade, createdAt: { gte: new Date(agora - LIMITES_INFINITEPAY.janelaLivroMs) } },
    select: SELECIONA_LIVRO,
  })) as LinhaDoLivro[];
  const itens: ItemDoLivro[] = linhas.map((l) => ({ valorCentavos: l.valorCentavos, status: l.status, em: l.createdAt.getTime(), chave: l.chaveDuplicata, orderNsu: l.orderNsu, url: l.url }));
  return new LivroDeLinks(itens);
}

const ehDuplicata = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';

/**
 * O armazém de produção. `reservar` roda numa TRANSAÇÃO que pega `pg_advisory_xact_lock` da unidade, lê os links das últimas 36 h, deixa a conferência
 * recusar e grava a intenção, tudo antes de soltar a trava (no fim da transação): duas instâncias do servidor nunca passam as duas pelo mesmo saldo do
 * teto. Se o banco não responde, nada sai.
 */
export function armazemDeEscritaPrisma(db: BancoDeEscrita): ArmazemDeEscrita {
  const leitura = armazemDeLinksPrisma(db);
  return {
    ...leitura,
    async ler(unidade, agora) {
      try {
        return await lerLivro(db.infinitepayLink, unidade, agora);
      } catch {
        throw new ErroDeEntrada(FALHA_DO_BANCO_INFINITEPAY);
      }
    },
    async reservar(p: PedidoDeReserva) {
      try {
        await db.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`infinitepay-dinheiro:${p.unidade}`}::text, 0))`;
            p.conferir(await lerLivro(tx.infinitepayLink, p.unidade, p.agora));
            const dados = { valorCentavos: p.valorCentavos, descricao: p.descricao, validoAte: p.validoAte, criadoPor: p.criadoPor, chaveDuplicata: p.chave };
            // a referência de um link que a InfinitePay RECUSOU (falhou) pode ser usada de novo: nada existe lá; a linha volta a ser uma intenção, com os dados novos
            const reaproveitada = await tx.infinitepayLink.updateMany({
              where: { unitSlug: p.unidade, orderNsu: p.orderNsu, status: 'falhou' },
              data: { ...dados, status: 'intencao', url: null, erro: null, createdAt: new Date(p.agora) },
            });
            if (reaproveitada.count === 0) await tx.infinitepayLink.create({ data: { unitSlug: p.unidade, orderNsu: p.orderNsu, status: 'intencao', ...dados } });
          },
          { timeout: 15_000, maxWait: 15_000 },
        );
      } catch (e) {
        if (e instanceof ErroDeEntrada) throw e;
        if (ehDuplicata(e)) throw new ErroDeEntrada(`a referência ${p.orderNsu} já foi usada nesta unidade. Use outra, ou veja o link em infinitepay_links. Nada foi criado.`);
        throw new ErroDeEntrada(FALHA_DO_BANCO_INFINITEPAY);
      }
    },
    async resolver(unidade, orderNsu, r: ResultadoDaCriacao) {
      const data =
        r.status === 'criado'
          ? { status: 'criado', url: r.url, erro: null, ...(r.invoiceSlug ? { invoiceSlug: r.invoiceSlug } : {}) }
          : { status: r.status, erro: r.erro };
      // só resolve o que ainda é intenção: um aviso de pagamento que chegou antes da resposta nunca é desfeito por ela
      await db.infinitepayLink.updateMany({ where: { unitSlug: unidade, orderNsu, status: 'intencao' }, data });
    },
    async aplicarEvento(unidade, orderNsu, e: EventoDoLink) {
      const agora = new Date();
      const registro = { ultimoEvento: e.evento, ultimoEventoEm: agora, ...(e.revisao ? { revisao: e.revisao } : {}) };
      let mudou = false;
      const alvo = { unitSlug: unidade, orderNsu };
      if (e.paraStatus) {
        const p = e.pagamento ?? {};
        const r = await db.infinitepayLink.updateMany({
          where: { ...alvo, ...(e.deStatus ? { status: { in: e.deStatus } } : {}) },
          data: {
            ...registro,
            status: e.paraStatus,
            ...(e.paraStatus === 'pago' ? { pagoEm: agora } : {}),
            ...(p.invoiceSlug ? { invoiceSlug: p.invoiceSlug } : {}),
            ...(p.transactionNsu ? { transactionNsu: p.transactionNsu } : {}),
            ...(p.forma ? { formaPagamento: p.forma } : {}),
            ...(p.parcelas !== undefined ? { parcelas: p.parcelas } : {}),
            ...(p.valorPagoCentavos !== undefined ? { valorPagoCentavos: p.valorPagoCentavos } : {}),
            ...(p.reciboUrl ? { reciboUrl: p.reciboUrl } : {}),
          },
        });
        mudou = r.count > 0;
      } else if (e.liquidado) {
        const r = await db.infinitepayLink.updateMany({ where: { ...alvo, status: 'pago', liquidadoEm: null }, data: { ...registro, liquidadoEm: agora } });
        mudou = r.count > 0;
      }
      if (!mudou) await db.infinitepayLink.updateMany({ where: alvo, data: registro });
      const l = await db.infinitepayLink.findUnique({ where: { unitSlug_orderNsu: alvo as { unitSlug: string; orderNsu: string } } });
      return { mudou, atual: l ? comoLinkGuardado(l) : null };
    },
  };
}
