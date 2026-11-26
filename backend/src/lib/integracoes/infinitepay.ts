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
function unidadeDoSufixo(sufixo: string, unidades: ReadonlyArray<{ slug: string; nome: string }>): { slug: string; nome: string } | { motivo: string } {
  const exata = unidades.find((u) => u.slug === sufixo);
  if (exata) return exata;
  const pelofim = unidades.filter((u) => u.slug.endsWith(`-${sufixo}`));
  if (pelofim.length === 1) return pelofim[0]!;
  return { motivo: pelofim.length > 1 ? `ambígua: ${pelofim.map((u) => u.slug).join(', ')}` : 'nenhuma unidade com esse nome' };
}

export function lerContasDoAmbiente(unidades: ReadonlyArray<{ slug: string; nome: string }>, e: NodeJS.ProcessEnv = process.env): LeituraDoAmbiente {
  const contas = new Map<string, ContaInfinitepayConfig>();
  const ignoradas: LeituraDoAmbiente['ignoradas'] = [];
  const P_CHAVE = 'INFINITEPAY_CHAVE_';
  const P_HANDLE = 'INFINITEPAY_HANDLE_';
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
    if (contas.has(u.slug)) {
      ignoradas.push({ variavel, motivo: `a unidade ${u.slug} já tem uma chave (outra variável)` });
      continue;
    }
    const handle = (e[`${P_HANDLE}${variavel.slice(P_CHAVE.length)}`] ?? '').trim().replace(/^\$/, '');
    contas.set(u.slug, { slug: u.slug, nome: u.nome, chave, ...(handle ? { handle } : {}) });
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

const inteiro = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);

/**
 * Consulta o status de UM pagamento. Quando algo não bate, a API responde 200 com success:false ou paid:false, sem erro: isso volta como
 * `pago: false`, nunca como exceção. `paid: true` só vem quando slug, transaction_nsu e order_nsu batem.
 */
export async function consultarPagamento(chave: string, p: PedidoDeConsulta, o: OpcoesDeChamada = {}): Promise<PagamentoConsultado> {
  const corpo = { ...(p.handle ? { handle: p.handle } : {}), order_nsu: p.orderNsu, transaction_nsu: p.transactionNsu, slug: p.slug };
  const { status, json } = await chamar(chave, '/payment_check', corpo, o);
  if (status < 200 || status >= 300) throw falhaDoStatus(status, json);
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
}
