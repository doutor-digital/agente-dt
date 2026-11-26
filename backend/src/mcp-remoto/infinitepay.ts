/**
 * InfinitePay no conector — LEITURA. Uma conta por unidade (a chave vem do ambiente do servidor, ver `lib/integracoes/infinitepay.ts`).
 *
 * O que a InfinitePay deixa ler pela API (Checkout Integrado): o status de UM pagamento já conhecido. Só. Não há saldo, extrato, vendas, recebíveis
 * nem lista de links. Por isso as duas ferramentas daqui dizem, na resposta, o que NÃO enxergam:
 *   - `infinitepay_status_pagamento`: consulta um pagamento (slug + transaction_nsu + order_nsu, que vêm no webhook e na URL de retorno do link);
 *   - `infinitepay_links`: os links que o CONECTOR criou (tabela `infinitepay_links`) e o que o webhook contou deles. É um recorte, nunca o total
 *     da conta: venda de maquininha, Pix direto e link criado no app não aparecem aqui.
 *   - `infinitepay_contas`: quais unidades têm a InfinitePay ligada (e, a pedido, prova que a chave está ativa sem criar nada).
 * Nenhuma delas cria, cancela ou estorna coisa alguma.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada, validarData } from '../franquia-mcp/travas.js';
import { executar } from './ferramenta.js';
import { acharSlug } from './unidades.js';
import { consultarPagamento, criarLinkNaInfinitepay, finalDaChave, testarChave, type ContaInfinitepayConfig, type OpcoesDeChamada, type PagamentoConsultado, type PedidoDeConsulta, type PedidoDeLink } from '../lib/integracoes/infinitepay.js';

export const STATUS_DO_LINK = ['intencao', 'criado', 'falhou', 'pago', 'estornado', 'cancelado'] as const;
export type StatusDoLink = (typeof STATUS_DO_LINK)[number];

/** Um link como a tabela guarda (datas em ISO). */
export interface LinkGuardado {
  orderNsu: string;
  unidade: string;
  status: string;
  url: string | null;
  valorCentavos: number;
  descricao: string;
  validoAte: string | null;
  criadoPor: string;
  criadoEm: string;
  invoiceSlug: string | null;
  transactionNsu: string | null;
  formaPagamento: string | null;
  parcelas: number | null;
  valorPagoCentavos: number | null;
  reciboUrl: string | null;
  /** estorno/cancelamento avisado pela InfinitePay e NÃO confirmado pela API: o João confere no app */
  revisao: string | null;
  pagoEm: string | null;
  liquidadoEm: string | null;
  ultimoEvento: string | null;
  erro: string | null;
}

export interface FiltroDeLinks {
  unidade: string;
  /** início (inclusive) e fim (inclusive) em instantes UTC */
  de?: Date;
  ate?: Date;
  /** qual data o período filtra: a de criação do link (padrão) ou a do pagamento (um link criado em outubro e pago em novembro entra no mês de novembro) */
  campoData?: 'criado' | 'pago';
  status?: string;
  orderNsu?: string;
  limite: number;
}

export interface ArmazemDeLinks {
  listar(f: FiltroDeLinks): Promise<LinkGuardado[]>;
  porOrderNsu(unidade: string, orderNsu: string): Promise<LinkGuardado | null>;
}

export interface ContaInfinitepay {
  slug: string;
  nome: string;
  /** só os 4 últimos caracteres, nunca a chave */
  chaveFinal: string;
  temHandle: boolean;
  fonte: {
    consultar(p: Omit<PedidoDeConsulta, 'handle'>): Promise<PagamentoConsultado>;
    /** prova a chave sem criar nada; lança se estiver revogada */
    testar(): Promise<void>;
    /** a ESCRITA (POST /links): só o código de criação de link, com portão e tetos, chama. Ausente = a conta não cria link. */
    criarLink?(p: Omit<PedidoDeLink, 'handle'>): Promise<{ url: string; slug?: string }>;
  };
}

export interface ContextoInfinitepay {
  contas: Map<string, ContaInfinitepay>;
  links: ArmazemDeLinks;
  agora: () => number;
}

/** A conta do conector a partir da configuração do ambiente. A chave fica na closure das duas chamadas: a conta serializada ou logada não a mostra. */
export function contaInfinitepayDaConfig(c: ContaInfinitepayConfig, op: OpcoesDeChamada = {}): ContaInfinitepay {
  return {
    slug: c.slug,
    nome: c.nome,
    chaveFinal: finalDaChave(c.chave),
    temHandle: Boolean(c.handle),
    fonte: {
      consultar: (p) => consultarPagamento(c.chave, { ...p, ...(c.handle ? { handle: c.handle } : {}) }, op),
      testar: () => testarChave(c.chave, op),
      criarLink: (p) => criarLinkNaInfinitepay(c.chave, { ...p, ...(c.handle ? { handle: c.handle } : {}) }, op),
    },
  };
}

export function criarContextoInfinitepay(contas: Map<string, ContaInfinitepay>, links: ArmazemDeLinks, op: { agora?: () => number } = {}): ContextoInfinitepay {
  return { contas, links, agora: op.agora ?? Date.now };
}

export const FUSO = 'America/Sao_Paulo';
const MAX_LINKS = 200;
const MAX_LEITURA = 1000;

/** O que a API da InfinitePay não deixa ler: repetido nas respostas para ninguém tomar o recorte pelo total. */
export const LIMITES_DA_API =
  'A API da InfinitePay não lista vendas, Pix recebidos, saldo, extrato nem recebíveis, e não lista links. Só o status de um pagamento já conhecido, e o que o webhook contou dos links criados por este conector. Venda de maquininha, Pix direto e link criado no app não aparecem aqui.';

export function resolverContaInfinitepay(ctx: ContextoInfinitepay, alvo: string | undefined): ContaInfinitepay {
  if (ctx.contas.size === 0) throw new ErroDeEntrada('nenhuma unidade com a InfinitePay ligada ainda (a chave fica no ambiente do servidor: INFINITEPAY_CHAVE_<UNIDADE>).');
  const com = [...ctx.contas.keys()].join(', ');
  if (!alvo || !alvo.trim()) {
    if (ctx.contas.size === 1) return [...ctx.contas.values()][0]!;
    throw new ErroDeEntrada(`diga a unidade. Com InfinitePay: ${com}`);
  }
  const slug = acharSlug(ctx.contas.keys(), alvo);
  if (!slug) throw new ErroDeEntrada(`unidade sem InfinitePay, desconhecida ou ambígua: ${alvo}. Com InfinitePay: ${com}`);
  return ctx.contas.get(slug)!;
}

export const reais = (centavos: number | null | undefined): number | null => (centavos === null || centavos === undefined ? null : Math.round(centavos) / 100);

const reaisDoLink = (l: LinkGuardado) => ({
  orderNsu: l.orderNsu,
  status: l.status,
  valor: reais(l.valorCentavos),
  valorPago: reais(l.valorPagoCentavos),
  descricao: l.descricao,
  url: l.url,
  validoAte: l.validoAte,
  criadoEm: l.criadoEm,
  criadoPor: l.criadoPor,
  pagoEm: l.pagoEm,
  liquidadoEm: l.liquidadoEm,
  forma: l.formaPagamento,
  parcelas: l.parcelas,
  reciboUrl: l.reciboUrl,
  ultimoEvento: l.ultimoEvento,
  ...(l.revisao ? { revisao: l.revisao, confirmadoPelaApi: false } : {}),
  ...(l.status === 'cancelado' || l.status === 'estornado' ? { avisoDoStatus: 'status vindo de AVISO da InfinitePay, não confirmado pela API (o /payment_check só confirma pagamento)' } : {}),
  ...(l.erro ? { erro: l.erro } : {}),
});

// ----------------------------------------------------------------- ferramentas

export async function infinitepayContas(ctx: ContextoInfinitepay, a: { unidade?: string; testar?: boolean }) {
  // com `unidade`, só ela; sem, todas — e o teste de chave vai em PARALELO (uma chamada por unidade), para não somar os tempos limite
  const lista = a.unidade?.trim() ? [resolverContaInfinitepay(ctx, a.unidade)] : [...ctx.contas.values()];
  const contas = await Promise.all(
    lista.map(async (c) => {
      let chave: { ok: boolean; erro?: string } | undefined;
      if (a.testar) {
        try {
          await c.fonte.testar();
          chave = { ok: true };
        } catch (e) {
          chave = { ok: false, erro: e instanceof Error ? e.message : String(e) };
        }
      }
      return { unidade: c.slug, nome: c.nome, chaveFinal: c.chaveFinal, infiniteTagConfigurada: c.temHandle, ...(chave ? { chaveAtiva: chave } : {}) };
    }),
  );
  return { total: contas.length, contas, limitesDaApi: LIMITES_DA_API };
}

export async function infinitepayStatusPagamento(ctx: ContextoInfinitepay, a: { unidade?: string; orderNsu: string; transactionNsu: string; slug: string }) {
  const conta = resolverContaInfinitepay(ctx, a.unidade);
  const orderNsu = a.orderNsu.trim();
  const transactionNsu = a.transactionNsu.trim();
  const slug = a.slug.trim();
  if (!orderNsu || !transactionNsu || !slug) throw new ErroDeEntrada('preciso dos três: order_nsu, transaction_nsu e slug (o código da fatura). Só o order_nsu não basta.');
  const lido = await conta.fonte.consultar({ orderNsu, transactionNsu, slug });
  // erro do banco NÃO é "link que não é do conector": a resposta diz que não conseguiu olhar
  let leituraFalhou = false;
  const guardado = await ctx.links.porOrderNsu(conta.slug, orderNsu).catch(() => ((leituraFalhou = true), null));
  return {
    unidade: conta.slug,
    orderNsu,
    // `pago` só é true quando a InfinitePay confirma os três códigos juntos; success:false é "não achei", não é erro
    pago: lido.pago,
    reconhecido: lido.sucesso,
    ...(lido.valorCentavos !== undefined ? { valor: reais(lido.valorCentavos) } : {}),
    ...(lido.valorPagoCentavos !== undefined ? { valorPago: reais(lido.valorPagoCentavos) } : {}),
    ...(lido.parcelas !== undefined ? { parcelas: lido.parcelas } : {}),
    ...(lido.forma ? { forma: lido.forma } : {}),
    ...(lido.sucesso ? {} : { aviso: 'a InfinitePay não reconheceu essa combinação de códigos (order_nsu, transaction_nsu e slug precisam ser do MESMO pagamento). Isso não prova que não foi pago.' }),
    ...(lido.valorCentavos !== undefined && lido.valorPagoCentavos !== undefined && lido.valorPagoCentavos !== lido.valorCentavos
      ? { nota: 'valorPago difere de valor: em venda parcelada com taxas repassadas ao comprador é normal; não compare os dois.' }
      : {}),
    linkDoConector: guardado ? reaisDoLink(guardado) : null,
    ...(leituraFalhou ? { avisoDoRegistro: 'não consegui consultar o registro dos links do conector (o banco não respondeu): linkDoConector=null NÃO quer dizer que o link não foi criado por ele.' } : {}),
  };
}

/** AAAA-MM-DD (de verdade: 30/02 é recusado) → instante UTC do começo (ou do fim) desse dia no fuso da clínica (UTC-3, sem horário de verão desde 2019). */
function instanteDoDia(dia: string, fim: boolean, campo: string): Date {
  validarData(dia, campo);
  return new Date(`${dia}T${fim ? '23:59:59.999' : '00:00:00.000'}-03:00`);
}

export async function infinitepayLinks(
  ctx: ContextoInfinitepay,
  a: { unidade?: string; inicio?: string; fim?: string; campoData?: 'criado' | 'pago'; status?: string; orderNsu?: string; maxItens?: number },
) {
  const conta = resolverContaInfinitepay(ctx, a.unidade);
  if (a.status && !(STATUS_DO_LINK as readonly string[]).includes(a.status)) throw new ErroDeEntrada(`status desconhecido: ${a.status}. Valem: ${STATUS_DO_LINK.join(', ')}`);
  const de = a.inicio ? instanteDoDia(a.inicio, false, 'inicio') : undefined;
  const ate = a.fim ? instanteDoDia(a.fim, true, 'fim') : undefined;
  if (de && ate && de > ate) throw new ErroDeEntrada('o início vem depois do fim');
  const campoData = a.campoData ?? 'criado';
  const max = Math.min(Math.max(a.maxItens ?? 50, 0), MAX_LINKS);
  // lê UM a mais que o limite para saber se cortou; os totais valem para o que foi lido (até o teto de MAX_LEITURA + 1)
  const lidos = await ctx.links.listar({
    unidade: conta.slug, ...(de ? { de } : {}), ...(ate ? { ate } : {}), campoData, ...(a.status ? { status: a.status } : {}), ...(a.orderNsu ? { orderNsu: a.orderNsu.trim() } : {}), limite: MAX_LEITURA + 1,
  });
  const cortouLeitura = lidos.length > MAX_LEITURA;
  const todos = cortouLeitura ? lidos.slice(0, MAX_LEITURA) : lidos;
  const porStatus: Record<string, { quantidade: number; valor: number }> = {};
  let emitido = 0;
  let pago = 0;
  let estornado = 0;
  let emRevisao = 0;
  let estornadoNaoConfirmado = 0;
  for (const l of todos) {
    // nos pagos e estornados o valor do status é o PAGO (pode ser maior que o do link, com taxa repassada); nos demais, o do link
    const centavos = (l.status === 'pago' || l.status === 'estornado') && l.valorPagoCentavos !== null ? l.valorPagoCentavos : l.valorCentavos;
    const g = (porStatus[l.status] ??= { quantidade: 0, valor: 0 });
    g.quantidade += 1;
    g.valor = Math.round((g.valor + centavos / 100) * 100) / 100;
    if (l.status !== 'falhou' && l.status !== 'intencao') emitido += l.valorCentavos;
    // pago com ESTORNO avisado e não confirmado: o dinheiro não conta como pago (pode ter voltado) e entra no estornado, separado em `valorEstornadoNaoConfirmado`
    const estornoEmRevisao = l.status === 'pago' && Boolean(l.revisao?.startsWith('estorno'));
    if (l.status === 'pago' && !estornoEmRevisao) pago += centavos;
    if (l.status === 'estornado') estornado += centavos;
    if (estornoEmRevisao) estornadoNaoConfirmado += centavos;
    if (l.revisao) emRevisao += 1;
  }
  return {
    unidade: conta.slug,
    escopo: 'SÓ os links criados por este conector — não é o total de vendas da InfinitePay desta unidade',
    periodoPor: campoData === 'pago' ? 'data do PAGAMENTO' : 'data de CRIAÇÃO do link (um link criado antes e pago dentro do período só entra com campoData="pago")',
    resumo: {
      links: todos.length,
      /** valor dos links criados, INCLUINDO cancelados e estornados, sem os que a InfinitePay recusou */
      valorEmitido: reais(emitido),
      /** o que foi pago, sem os links com estorno avisado e ainda não confirmado (esses ficam em valorEstornadoNaoConfirmado) */
      valorPago: reais(pago),
      /** estornos que contam: os confirmados (status estornado) MAIS os avisados e ainda não confirmados pela API */
      valorEstornado: reais(estornado + estornadoNaoConfirmado),
      /** a parte de valorEstornado que é só aviso da InfinitePay, NÃO confirmado pela API: confira no app */
      valorEstornadoNaoConfirmado: reais(estornadoNaoConfirmado),
      /** links com estorno/cancelamento avisado e NÃO confirmado pela API (o status NÃO foi mudado) */
      emRevisao: emRevisao,
      porStatus,
    },
    itens: todos.slice(0, max).map(reaisDoLink),
    itensOmitidos: Math.max(todos.length - max, 0),
    ...(cortouLeitura ? { truncado: true, aviso: `mais de ${MAX_LEITURA} links no período: divida o período. Os totais estão INCOMPLETOS.` } : {}),
    ...(emRevisao > 0
      ? { revisaoPendente: `${emRevisao} link(s) com estorno ou cancelamento AVISADO pela InfinitePay e NÃO confirmado pela API (o /payment_check só vê pagamento). O status não foi mudado: confira no app e veja o campo revisao de cada um.` }
      : {}),
    ...(todos.some((l) => l.status === 'intencao')
      ? { atencao: 'há link em "intencao": o conector gravou o pedido e não chegou a registrar a resposta da InfinitePay (queda no meio). Confira no app da InfinitePay antes de refazer.' }
      : {}),
    limitesDaApi: LIMITES_DA_API,
  };
}

// ----------------------------------------------------------------- registro

const unidade = z.string().optional().describe('unidade do conector com InfinitePay (slug ou nome curto). Opcional quando só uma unidade tem. Veja listar_integracoes.');

export function registrarFerramentasInfinitepay(server: McpServer, ctx: ContextoInfinitepay, auditar?: Auditar): void {
  const ro = { readOnlyHint: true, openWorldHint: true };
  server.registerTool(
    'infinitepay_contas',
    {
      title: 'Unidades com InfinitePay',
      description:
        'Quais unidades do conector têm a InfinitePay (Checkout Integrado) ligada e os 4 últimos caracteres da chave. Com testar=true prova que a chave ' +
        'está ativa, sem criar nada. IMPORTANTE: a API da InfinitePay NÃO lista vendas, Pix, saldo, extrato nem recebíveis; só o status de um pagamento ' +
        'conhecido e os links que este conector criou.',
      inputSchema: {
        unidade,
        testar: z.boolean().optional().describe('true: confere na InfinitePay se a chave está ativa (consulta um pagamento inventado; não cria nada)'),
      },
      annotations: ro,
    },
    (args) => executar('infinitepay_contas', args, auditar, () => infinitepayContas(ctx, args)),
  );
  server.registerTool(
    'infinitepay_status_pagamento',
    {
      title: 'Status de um pagamento (InfinitePay)',
      description:
        'Consulta na InfinitePay se UM pagamento foi aprovado, com valor, valor pago, parcelas e forma (pix ou credit_card). Precisa dos três códigos do ' +
        'mesmo pagamento: order_nsu, transaction_nsu e slug (código da fatura), que chegam no webhook (invoice_slug) e na URL de retorno do link. Só o ' +
        'order_nsu não basta. Não lista nada: para ver os links criados pelo conector use infinitepay_links. Se o link foi criado por este conector, ' +
        'traz também o registro dele.',
      inputSchema: {
        unidade,
        orderNsu: z.string().describe('order_nsu do pedido'),
        transactionNsu: z.string().describe('transaction_nsu (UUID da transação)'),
        slug: z.string().describe('slug / invoice_slug: código da fatura na InfinitePay'),
      },
      annotations: ro,
    },
    (args) => executar('infinitepay_status_pagamento', args, auditar, () => infinitepayStatusPagamento(ctx, args)),
  );
  server.registerTool(
    'infinitepay_links',
    {
      title: 'Links de pagamento criados pelo conector (InfinitePay)',
      description:
        'Os links de pagamento que ESTE conector criou numa unidade, com status (criado, pago, estornado, cancelado…), valor, validade e quem criou, ' +
        'num período (datas AAAA-MM-DD, fuso de Brasília). É só o recorte do conector: NÃO é o total de vendas da unidade (maquininha, Pix direto e ' +
        'link feito no app não entram, a InfinitePay não deixa ler isso). Os totais valem só para esses links.',
      inputSchema: {
        unidade,
        inicio: z.string().optional().describe('primeiro dia, AAAA-MM-DD'),
        fim: z.string().optional().describe('último dia (incluso), AAAA-MM-DD'),
        campoData: z.enum(['criado', 'pago']).optional().describe('qual data o período filtra: criado (padrão) ou pago (a data do pagamento)'),
        status: z.enum(STATUS_DO_LINK).optional(),
        orderNsu: z.string().optional().describe('um pedido só'),
        maxItens: z.number().int().min(0).max(MAX_LINKS).optional().describe('quantos links listar (padrão 50; 0 = só os números)'),
      },
      annotations: ro,
    },
    (args) => executar('infinitepay_links', args, auditar, () => infinitepayLinks(ctx, args)),
  );
}
