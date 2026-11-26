/**
 * InfinitePay (Checkout Integrado) — o cliente HTTP do conector. A API é pequena de propósito: DUAS rotas, as duas POST, e nada mais
 * (documentação oficial: infinitepay.io/checkout-documentacao; "a API tem apenas criação de links e consulta de status"):
 *   - POST /links           cria um link de pagamento (escrita em conta real; só a criação de link, em outro arquivo, usa);
 *   - POST /payment_check   consulta o status de UM pagamento já conhecido (slug + transaction_nsu + order_nsu).
 * Não existe rota de saldo, extrato, vendas, recebíveis, lista de links, cancelamento nem estorno. Este cliente não tem como chamar outra rota.
 *
 * A chave (`inchk_…`) vai no cabeçalho `X-Api-Key` e SÓ lá: nunca em URL, log, erro ou resposta. Ela vem do ambiente do servidor, uma por unidade:
 *   INFINITEPAY_CHAVE_<UNIDADE>   (obrigatória; ex. INFINITEPAY_CHAVE_ACAILANDIA)
 *   INFINITEPAY_HANDLE_<UNIDADE>  (opcional: a InfiniteTag da conta, sem o "$"; com a chave ela não é necessária)
 * <UNIDADE> é o slug em maiúsculas com "_" no lugar de "-" (DOUTOR_HERNIA_ACAILANDIA) ou o final dele, desde que só UMA unidade termine assim.
 * Nome que não acha unidade, ou acha mais de uma, é IGNORADO (e vai no log): nunca se adivinha a quem a chave pertence.
 */
import { finalDaChave } from './cofre.js';

export const INFINITEPAY_API = 'https://api.checkout.infinitepay.io';
const AGENTE = 'DoutorDigital-Conector/1.0';
const FORMATO_DA_CHAVE = /^inchk_[A-Za-z0-9_-]{16,}$/;

export class ErroInfinitepay extends Error {
  constructor(msg: string, readonly status: number | null = null) {
    super(tirarChave(msg));
  }
}

/** Defesa em profundidade: nenhuma mensagem sai com um pedaço de chave, mesmo que algum dia um erro a repita. */
export function tirarChave(texto: string): string {
  return texto.replace(/inchk_[A-Za-z0-9_-]+/g, 'inchk_…');
}

export interface ContaInfinitepayConfig {
  slug: string;
  nome: string;
  chave: string;
  handle?: string;
}

export interface LeituraDoAmbiente {
  contas: Map<string, ContaInfinitepayConfig>;
  /** variáveis que não viraram conta, com o motivo (nunca o valor): vão para o log */
  ignoradas: Array<{ variavel: string; motivo: string }>;
}

const sufixoDe = (variavel: string, prefixo: string) => variavel.slice(prefixo.length).toLowerCase().replace(/_/g, '-');

/** Acha a unidade do sufixo: o slug inteiro, ou o final dele quando só uma unidade termina assim. Ambíguo ou desconhecido = undefined. */
function unidadeDoSufixo<U extends { slug: string }>(sufixo: string, unidades: ReadonlyArray<U>): U | { motivo: string } {
  const exata = unidades.find((u) => u.slug === sufixo);
  if (exata) return exata;
  const pelofim = unidades.filter((u) => u.slug.endsWith(`-${sufixo}`));
  if (pelofim.length === 1) return pelofim[0]!;
  return { motivo: pelofim.length > 1 ? `ambígua: ${pelofim.map((u) => u.slug).join(', ')}` : 'nenhuma unidade com esse nome' };
}

/**
 * `unidades` deve trazer TODAS as unidades (ativas e inativas): o sufixo é resolvido entre todas e só depois a inativa é descartada. Assim a chave de uma unidade
 * desativada (ex.: um cancelamento) nunca é entregue a outra unidade ativa cujo slug termine igual.
 */
export function lerContasDoAmbiente(unidades: ReadonlyArray<{ slug: string; nome: string; ativa?: boolean }>, e: NodeJS.ProcessEnv = process.env): LeituraDoAmbiente {
  const contas = new Map<string, ContaInfinitepayConfig>();
  const ignoradas: LeituraDoAmbiente['ignoradas'] = [];
  const P_CHAVE = 'INFINITEPAY_CHAVE_';
  const P_HANDLE = 'INFINITEPAY_HANDLE_';
  const donasDaChave = new Map<string, string>();
  for (const variavel of Object.keys(e).sort()) {
    if (!variavel.startsWith(P_CHAVE)) continue;
    const chave = (e[variavel] ?? '').trim();
    if (!chave) continue; // variável vazia = sem conta, sem barulho
    if (!FORMATO_DA_CHAVE.test(chave)) {
      ignoradas.push({ variavel, motivo: 'a chave não tem o formato inchk_…' });
      continue;
    }
    const sufixo = sufixoDe(variavel, P_CHAVE);
    const u = unidadeDoSufixo(sufixo, unidades);
    if ('motivo' in u) {
      ignoradas.push({ variavel, motivo: u.motivo });
      continue;
    }
    if (u.ativa === false) {
      ignoradas.push({ variavel, motivo: `a unidade ${u.slug} está inativa` });
      continue;
    }
    if (contas.has(u.slug)) {
      ignoradas.push({ variavel, motivo: `a unidade ${u.slug} já tem uma chave (outra variável)` });
      continue;
    }
    // a mesma chave em duas unidades = a mesma conta da InfinitePay: teto, trava e limite por hora são POR UNIDADE, então dividir a chave multiplicaria os tetos
    const dona = donasDaChave.get(chave);
    if (dona) {
      ignoradas.push({ variavel, motivo: `a mesma chave já está ligada à unidade ${dona}: uma chave, uma unidade` });
      continue;
    }
    donasDaChave.set(chave, u.slug);
    contas.set(u.slug, { slug: u.slug, nome: u.nome, chave });
  }
  // a InfiniteTag (opcional) é resolvida pelo MESMO caminho da chave: o sufixo pode ser diferente (chave ..._ACAILANDIA, handle ..._DOUTOR_HERNIA_ACAILANDIA)
  for (const variavel of Object.keys(e).sort()) {
    if (!variavel.startsWith(P_HANDLE)) continue;
    const handle = (e[variavel] ?? '').trim().replace(/^\$/, '');
    if (!handle) continue;
    const u = unidadeDoSufixo(sufixoDe(variavel, P_HANDLE), unidades);
    if ('motivo' in u) {
      ignoradas.push({ variavel, motivo: u.motivo });
      continue;
    }
    const conta = contas.get(u.slug);
    if (!conta) {
      ignoradas.push({ variavel, motivo: `a unidade ${u.slug} não tem chave (INFINITEPAY_CHAVE_…) ligada` });
      continue;
    }
    if (conta.handle) ignoradas.push({ variavel, motivo: `a unidade ${u.slug} já tem uma InfiniteTag (outra variável)` });
    else conta.handle = handle;
  }
  return { contas, ignoradas };
}

export { finalDaChave };

// ----------------------------------------------------------------- chamadas

type Fetcher = typeof fetch;

export interface OpcoesDeChamada {
  fetcher?: Fetcher;
  timeoutMs?: number;
}

/** O que `/payment_check` devolve, em centavos como a API manda. */
export interface PagamentoConsultado {
  /** `success` da API: false = a InfinitePay não achou/ não reconheceu o pedido (não é erro) */
  sucesso: boolean;
  pago: boolean;
  valorCentavos?: number;
  valorPagoCentavos?: number;
  parcelas?: number;
  forma?: string;
}

export interface PedidoDeConsulta {
  orderNsu: string;
  transactionNsu: string;
  /** o código da fatura (`slug` na URL de retorno, `invoice_slug` no webhook) */
  slug: string;
  /** a InfiniteTag; opcional com a chave */
  handle?: string;
}

async function chamar(chave: string, caminho: '/payment_check' | '/links', corpo: unknown, o: OpcoesDeChamada): Promise<{ status: number; json: Record<string, unknown> }> {
  const f = o.fetcher ?? fetch;
  let r: Response;
  try {
    r = await f(`${INFINITEPAY_API}${caminho}`, {
      method: 'POST',
      headers: { 'X-Api-Key': chave, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': AGENTE },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    });
  } catch (e) {
    const nome = e instanceof Error ? e.name : '';
    throw new ErroInfinitepay(nome === 'TimeoutError' || nome === 'AbortError' ? 'a InfinitePay não respondeu a tempo' : 'não consegui falar com a InfinitePay (rede)');
  }
  const texto = await r.text().catch(() => '');
  let json: Record<string, unknown> = {};
  try {
    const j = JSON.parse(texto) as unknown;
    if (j && typeof j === 'object' && !Array.isArray(j)) json = j as Record<string, unknown>;
  } catch {
    // corpo que não é JSON: segue só com o status
  }
  return { status: r.status, json };
}

function falhaDoStatus(status: number, json: Record<string, unknown>): ErroInfinitepay {
  const msg = typeof json.message === 'string' ? ` (${json.message.slice(0, 120)})` : '';
  if (status === 403) return new ErroInfinitepay(`a InfinitePay recusou a chave (403)${msg}: chave revogada, ou a InfiniteTag configurada é de outra conta`, 403);
  if (status === 401) return new ErroInfinitepay(`a InfinitePay não reconheceu a chave (401)${msg}`, 401);
  if (status === 404) return new ErroInfinitepay(`a InfinitePay respondeu 404${msg}: a chave não foi enviada ou a rota mudou`, 404);
  if (status === 429) return new ErroInfinitepay('a InfinitePay pediu para ir mais devagar (429); tente de novo em instantes', 429);
  return new ErroInfinitepay(`a InfinitePay respondeu ${status}${msg}`, status);
}

/** Um 200 que não é o JSON da InfinitePay (página de um proxy, CDN fora do ar) não prova nada: nunca vira "chave ativa" nem "não pago". */
function conferirFormato(status: number, json: Record<string, unknown>): void {
  if (typeof json.success !== 'boolean') throw new ErroInfinitepay('a InfinitePay respondeu em formato inesperado (sem o campo success): pode ser um proxy ou uma mudança na API', status);
}

const inteiro = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);

/**
 * Consulta o status de UM pagamento. Quando algo não bate, a API responde 200 com success:false ou paid:false, sem erro: isso volta como
 * `pago: false`, nunca como exceção. `paid: true` só vem quando slug, transaction_nsu e order_nsu batem.
 */
export async function consultarPagamento(chave: string, p: PedidoDeConsulta, o: OpcoesDeChamada = {}): Promise<PagamentoConsultado> {
  const corpo = { ...(p.handle ? { handle: p.handle } : {}), order_nsu: p.orderNsu, transaction_nsu: p.transactionNsu, slug: p.slug };
  const { status, json } = await chamar(chave, '/payment_check', corpo, o);
  if (status < 200 || status >= 300) throw falhaDoStatus(status, json);
  conferirFormato(status, json);
  return {
    sucesso: json.success === true,
    pago: json.success === true && json.paid === true,
    ...(inteiro(json.amount) !== undefined ? { valorCentavos: inteiro(json.amount) } : {}),
    ...(inteiro(json.paid_amount) !== undefined ? { valorPagoCentavos: inteiro(json.paid_amount) } : {}),
    ...(inteiro(json.installments) !== undefined ? { parcelas: inteiro(json.installments) } : {}),
    ...(typeof json.capture_method === 'string' ? { forma: json.capture_method } : {}),
  };
}

/**
 * Prova que a chave existe e está ativa SEM criar nada nem tocar em pagamento real: consulta um pagamento inventado.
 * Medido em 26/11/2026: chave boa → 200 {success:false}; chave inventada → 403; sem chave → 404.
 */
export async function testarChave(chave: string, o: OpcoesDeChamada = {}): Promise<void> {
  const r = await chamar(chave, '/payment_check', { order_nsu: 'dd-teste-leitura', transaction_nsu: '00000000-0000-0000-0000-000000000000', slug: 'inexistente' }, o);
  if (r.status < 200 || r.status >= 300) throw falhaDoStatus(r.status, r.json);
  conferirFormato(r.status, r.json);
}

// ----------------------------------------------------------------- criação de link (ESCRITA em conta real)

export interface PedidoDeLink {
  orderNsu: string;
  itens: Array<{ quantidade: number; precoCentavos: number; descricao: string }>;
  /** o webhook do link: a InfinitePay avisa aqui; a URL carrega a assinatura nossa, porque o webhook dela não tem assinatura */
  webhookUrl?: string;
  eventos?: string[];
  /** ISO 8601 com fuso, no futuro e dentro de um ano (limite da InfinitePay) */
  validoAte?: string;
  /** padrão true: o link aceita UM pagamento e depois bloqueia */
  pagamentoUnico?: boolean;
  /** padrão true; false = só cartão (o cartão não dá para desligar) */
  pix?: boolean;
  /** até quantas parcelas o vendedor absorve as taxas (0 a 12; padrão 0: o comprador paga as taxas do parcelamento) */
  parcelasSemTaxa?: number;
  handle?: string;
}

export const EVENTOS_DO_WEBHOOK = ['paid', 'settled', 'refunded', 'canceled', 'payment_failed'] as const;

/** A primeira URL https que a resposta traz (no topo ou dentro de `data`): o formato exato da resposta de /links não vem na documentação. */
function urlDaResposta(json: Record<string, unknown>): string | undefined {
  const candidatos: unknown[] = [json.url, json.checkout_url, json.link, json.payment_url, json.checkoutUrl];
  const dentro = json.data;
  if (dentro && typeof dentro === 'object' && !Array.isArray(dentro)) {
    const d = dentro as Record<string, unknown>;
    candidatos.push(d.url, d.checkout_url, d.link, d.payment_url);
  }
  return candidatos.find((v): v is string => typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v));
}

/**
 * POST /links. Só `criarLinkNaInfinitepay` chama esta rota, e só o código de escrita do conector (com portão, tetos e aviso) chama esta função.
 * Resposta sem URL = erro com o aviso de que o link PODE existir (a API não deixa buscar link por order_nsu).
 */
export async function criarLinkNaInfinitepay(chave: string, p: PedidoDeLink, o: OpcoesDeChamada = {}): Promise<{ url: string; slug?: string }> {
  const corpo = {
    ...(p.handle ? { handle: p.handle } : {}),
    order_nsu: p.orderNsu,
    items: p.itens.map((i) => ({ quantity: i.quantidade, price: i.precoCentavos, description: i.descricao })),
    ...(p.webhookUrl ? { webhook: { url: p.webhookUrl, events: p.eventos ?? [...EVENTOS_DO_WEBHOOK] } } : {}),
    options: {
      ...(p.validoAte ? { valid_until: p.validoAte } : {}),
      single_payment: p.pagamentoUnico ?? true,
      payment_methods_enabled: p.pix === false ? ['credit_card'] : ['credit_card', 'pix'],
      assured_installments: p.parcelasSemTaxa ?? 0,
    },
  };
  const { status, json } = await chamar(chave, '/links', corpo, o);
  if (status < 200 || status >= 300) throw falhaDoStatus(status, json);
  const url = urlDaResposta(json);
  if (!url) throw new ErroInfinitepay('a InfinitePay respondeu sem a URL do link. O link PODE ter sido criado: confira no app da InfinitePay antes de repetir.', status);
  return { url, ...(typeof json.slug === 'string' ? { slug: json.slug } : {}) };
}
