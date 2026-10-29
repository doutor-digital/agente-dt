/**
 * Leitura da API do Tramitação Inteligente (processos, publicações, clientes e atividades de escritório de
 * advocacia) com a chave do escritório. SÓ GET, e só nas rotas da lista abaixo: a mesma chave também cria,
 * edita e apaga cliente, processo, atividade e envelope de assinatura — este cliente não tem como.
 *
 * Duas portas ficam fechadas de propósito, porque seriam leitura que gasta ou expõe mais do que o conector deve:
 *  - `/documentos/{id}/conteudo` e `/arquivo` (texto e arquivo do documento: só metadados saem, pela lista);
 *  - `mostrar_meu_inss_pass` (a API devolve a senha do Meu INSS do cliente em texto aberto se pedirem).
 *
 * Autenticação: `Authorization: Bearer <chave>`. A API devolve 402 quando o plano do escritório não inclui a API
 * (e a mensagem diz qual plano) e 429 quando passa do ritmo; o 402 não se repete, o 429 respeita o Retry-After.
 * Documentação: <base>/docs.json.
 */
import { dormir } from '../../franquia-mcp/ritmo.js';
import { esperaPedida, JanelaDeRitmo } from './convenia.js';

export const TRAMITACAO_API = process.env.TRAMITACAO_API_URL || 'https://planilha.tramitacaointeligente.com.br/api';
const AGENTE = 'DoutorDigital-Conector/1.0';

export class ErroTramitacao extends Error {
  constructor(msg: string, readonly status: number | null, readonly motivo: string | null = null) {
    super(msg);
  }
}

type Fetcher = typeof fetch;
type Valor = string | number | boolean | undefined | Array<string | number>;
const janelas = new Map<string, JanelaDeRitmo>();

/** id interno (só dígitos) ou número CNJ com ou sem máscara */
const PROCESSO = String.raw`(?:\d+|\d[\d.\-]{12,28}\d)`;
const LEITURA_PERMITIDA = [
  /^\/v1\/processos$/,
  new RegExp(`^/v1/processos/${PROCESSO}$`),
  new RegExp(`^/v1/processos/${PROCESSO}/(?:partes|movimentacoes|documentos)$`),
  /^\/v1\/publicacoes$/,
  /^\/v1\/clientes$/,
  /^\/v1\/atividades$/,
];
const PARAMETROS_PROIBIDOS = new Set(['mostrar_meu_inss_pass']);

interface CorpoDeErro {
  error?: unknown;
  message?: unknown;
  reason?: unknown;
}

function lerErro(texto: string): CorpoDeErro {
  try {
    const j = JSON.parse(texto) as unknown;
    return j && typeof j === 'object' ? (j as CorpoDeErro) : {};
  } catch {
    return {};
  }
}

const curto = (v: unknown, n = 240): string => (typeof v === 'string' ? v.slice(0, n) : '');

/**
 * GET na Tramitação. `contaId` separa o ritmo de cada chave; `caminho` começa com "/v1/…". A mensagem de erro
 * usa só `message`/`reason`/`error` da resposta (textos fixos da API), nunca o corpo inteiro: ele pode trazer
 * o e-mail do usuário e dados do plano.
 */
export async function tramitacaoGet<T = unknown>(
  contaId: string,
  chave: string,
  caminho: string,
  query: Record<string, Valor> = {},
  fetcher: Fetcher = fetch,
): Promise<T> {
  if (!LEITURA_PERMITIDA.some((r) => r.test(caminho))) throw new ErroTramitacao(`rota ${caminho.slice(0, 80)} fora da lista de leitura do conector`, null);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (PARAMETROS_PROIBIDOS.has(k.toLowerCase())) throw new ErroTramitacao(`parâmetro ${k} não permitido: o conector nunca pede senha`, null);
    if (v === undefined || v === '') continue;
    if (Array.isArray(v)) for (const x of v) q.append(k.endsWith('[]') ? k : `${k}[]`, String(x));
    else q.append(k, String(v));
  }
  const url = `${TRAMITACAO_API}${caminho}${q.size ? `?${q.toString()}` : ''}`;
  let janela = janelas.get(contaId);
  if (!janela) janelas.set(contaId, (janela = new JanelaDeRitmo(40, 60_000)));
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    await janela.vez();
    let resp: Response;
    try {
      resp = await fetcher(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${chave}`, 'User-Agent': AGENTE, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (tentativa < 3) {
        await dormir(1000 * (tentativa + 1));
        continue;
      }
      throw new ErroTramitacao(`sem resposta da Tramitação em ${caminho}: ${String(err).slice(0, 200)}`, null);
    }
    if ((resp.status === 429 || resp.status >= 500) && tentativa < 3) {
      await resp.body?.cancel();
      await dormir(resp.status === 429 ? esperaPedida(resp, tentativa) : 1500 * (tentativa + 1));
      continue;
    }
    const texto = await resp.text();
    if (resp.status === 401) throw new ErroTramitacao('a Tramitação recusou a chave (401): chave errada ou removida — gere outra em Configurações → Chaves de API', 401);
    if (resp.status === 402) {
      const e = lerErro(texto);
      const motivo = curto(e.reason, 80) || null;
      throw new ErroTramitacao(
        `a Tramitação respondeu 402: o plano do escritório não inclui a API ou esta operação${motivo ? ` (${motivo})` : ''}${curto(e.message) ? ` — ${curto(e.message)}` : ''}`,
        402,
        motivo,
      );
    }
    if (resp.status === 429) throw new ErroTramitacao('a Tramitação limitou as chamadas (429) e não liberou depois de 4 tentativas: espere um pouco e tente de novo', 429);
    if (!resp.ok) {
      const e = lerErro(texto);
      throw new ErroTramitacao(`Tramitação ${resp.status} em ${caminho}: ${curto(e.error) || curto(e.message) || (resp.status === 404 ? 'não encontrado' : 'erro sem detalhe')}`, resp.status);
    }
    if (!texto) return null as T;
    try {
      return JSON.parse(texto) as T;
    } catch {
      throw new ErroTramitacao(`Tramitação ${resp.status} em ${caminho}: resposta que não é JSON (${texto.slice(0, 120)})`, resp.status);
    }
  }
  throw new ErroTramitacao(`Tramitação não respondeu em ${caminho} depois de 4 tentativas`, 429);
}

/** Prova a chave com a leitura mais barata: 1 processo e o total. O rótulo do painel é só a contagem. */
export async function testarChaveTramitacao(chave: string, fetcher: Fetcher = fetch): Promise<string> {
  const r = await tramitacaoGet<{ pagination?: { count?: number } }>('teste', chave, '/v1/processos', { per_page: 1 }, fetcher);
  const total = Number(r?.pagination?.count);
  return `Tramitação Inteligente${Number.isFinite(total) ? ` · ${total} processos` : ''}`;
}
