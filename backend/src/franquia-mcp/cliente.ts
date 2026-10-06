/**
 * Uma chamada à franquia, do jeito que o guia pede (§12): Bearer no header, timeout de 30 s,
 * retentativa com espera crescente só no que é transitório, e log de status e latência.
 *
 * SÓ LEITURA, por construção: o cliente recusa qualquer caminho fora da lista abaixo antes
 * de abrir conexão. Não existe método pra criar, cancelar ou confirmar nada.
 */
import { randomUUID } from 'node:crypto';
import type { Unidade } from './unidade.js';
import { type Contador, type Dormir, type Orcamento, type Ritmo, dormir } from './ritmo.js';

const LEITURAS: Array<{ metodo: 'GET' | 'POST'; caminho: RegExp }> = [
  { metodo: 'GET', caminho: /^\/(check|version)$/ },
  { metodo: 'GET', caminho: /^\/api\/clients\/\d+$/ },
  { metodo: 'GET', caminho: /^\/api\/general\/[a-z/-]+$/ },
  { metodo: 'POST', caminho: /^\/api\/(clients|leads|schedules|treatments)\/search$/ },
  { metodo: 'POST', caminho: /^\/api\/bi\/(leads\/sources|clients\/gender|treatments\/categories)$/ },
];

export function ehLeitura(metodo: string, caminho: string): boolean {
  return LEITURAS.some((l) => l.metodo === metodo && l.caminho.test(caminho));
}

export class ErroSpine extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly transitorio = false,
  ) {
    super(message);
  }
}

export interface OpcoesCliente {
  ritmo: Ritmo;
  contador: Contador;
  fetch?: typeof fetch;
  timeoutMs?: number;
  tentativas?: number;
  esperaBaseMs?: number;
  dormir?: Dormir;
  log?: (linha: string) => void;
}

/** O stdout é o canal do MCP: log vai SEMPRE pro stderr. */
const logPadrao = (linha: string) => process.stderr.write(`${linha}\n`);

function mensagemDoCorpo(corpo: unknown): string | undefined {
  if (!corpo || typeof corpo !== 'object') return undefined;
  const c = corpo as { error?: unknown; errors?: unknown; message?: unknown };
  if (Array.isArray(c.errors) && c.errors.length) return c.errors.map(String).join('; ');
  if (typeof c.error === 'string') return c.error;
  if (typeof c.message === 'string') return c.message;
  return undefined;
}

function erroPorStatus(status: number, corpo: unknown, modulo: string): ErroSpine {
  const detalhe = mensagemDoCorpo(corpo);
  switch (status) {
    case 400:
      return new ErroSpine(`400: a franquia recusou os parâmetros${detalhe ? ` (${detalhe})` : ''}`, 400);
    case 401:
      return new ErroSpine('401: token inválido, ausente ou expirado — peça outro ao suporte da franquia', 401);
    case 403:
      return new ErroSpine(`403: o token desta unidade não tem permissão pra ${modulo}`, 403);
    case 404:
      return new ErroSpine(`404: não encontrado${detalhe ? ` (${detalhe})` : ''}`, 404);
    case 429:
      // NÃO repete: é a franquia pedindo pra parar, e o token é o mesmo do agente e do dashboard
      return new ErroSpine('429: a franquia pediu pra diminuir o ritmo — tente de novo mais tarde', 429);
    default:
      return new ErroSpine(`${status}: erro na franquia${detalhe ? ` (${detalhe})` : ''}`, status, status >= 500);
  }
}

/** `/api/bi/leads/sources` → `bi/leads`; usado só pra explicar o 403. */
function moduloDe(caminho: string): string {
  const partes = caminho.replace(/^\/api\//, '').split('/');
  return partes[0] === 'bi' ? `BI (${partes.slice(1).join('/')})` : (partes[0] ?? caminho);
}

export class ClienteSpine {
  private fetch: typeof fetch;
  private timeoutMs: number;
  private tentativas: number;
  private esperaBaseMs: number;
  private dormir: Dormir;
  private log: (linha: string) => void;

  constructor(
    readonly unidade: Unidade,
    private op: OpcoesCliente,
  ) {
    this.fetch = op.fetch ?? globalThis.fetch;
    this.timeoutMs = op.timeoutMs ?? 30_000;
    this.tentativas = Math.max(1, op.tentativas ?? 3);
    this.esperaBaseMs = op.esperaBaseMs ?? 1_000;
    this.dormir = op.dormir ?? dormir;
    this.log = op.log ?? logPadrao;
  }

  /**
   * GET ou POST de leitura. Cada tentativa gasta 1 do orçamento e passa pela fila do token.
   * Repete só em 5xx, timeout e falha de rede. 400/401/403/404 e 429 voltam na hora.
   */
  async chamar<T = unknown>(metodo: 'GET' | 'POST', caminho: string, corpo?: unknown, orcamento?: Orcamento): Promise<T> {
    if (!ehLeitura(metodo, caminho)) {
      throw new ErroSpine(`recusado: ${metodo} ${caminho} não é uma leitura permitida neste MCP`);
    }

    let ultimoErro: ErroSpine | undefined;
    for (let tentativa = 1; tentativa <= this.tentativas; tentativa++) {
      if (tentativa > 1) await this.dormir(this.esperaBaseMs * 2 ** (tentativa - 2));
      orcamento?.gastar();
      try {
        return await this.op.ritmo.vez(this.unidade.token, () => this.umaVez<T>(metodo, caminho, corpo));
      } catch (e) {
        if (!(e instanceof ErroSpine) || !e.transitorio) throw e;
        ultimoErro = e;
      }
    }
    throw new ErroSpine(
      `${ultimoErro?.message ?? 'falha'} — desisti depois de ${this.tentativas} tentativas`,
      ultimoErro?.status,
      true,
    );
  }

  private async umaVez<T>(metodo: 'GET' | 'POST', caminho: string, corpo?: unknown): Promise<T> {
    const { slug } = this.unidade;
    const requestId = randomUUID();
    const inicio = Date.now();
    const registrar = (status: number | string, ok: boolean) => {
      this.op.contador.registrar(slug, metodo, caminho, ok);
      this.log(`[spine] ${slug} ${metodo} ${caminho} ${status} ${Date.now() - inicio}ms id=${requestId}`);
    };

    let resposta: Response;
    try {
      resposta = await this.fetch(`${this.unidade.baseUrl}${caminho}`, {
        method: metodo,
        headers: {
          Authorization: `Bearer ${this.unidade.token}`,
          'Content-Type': 'application/json',
          'X-Request-Id': requestId,
        },
        body: metodo === 'POST' ? JSON.stringify(corpo ?? {}) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const nome = (e as Error)?.name;
      const tempo = nome === 'TimeoutError' || nome === 'AbortError';
      registrar(tempo ? 'timeout' : 'rede', false);
      throw new ErroSpine(
        tempo ? `sem resposta em ${Math.round(this.timeoutMs / 1000)} s` : 'falha de rede ao falar com a franquia',
        undefined,
        true,
      );
    }

    let texto: string;
    try {
      texto = await resposta.text();
    } catch (e) {
      // o timeout também corta o corpo no meio: é a mesma falha transitória de antes de ele chegar
      const tempo = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
      registrar(tempo ? 'timeout' : 'rede', false);
      throw new ErroSpine(tempo ? `resposta incompleta em ${Math.round(this.timeoutMs / 1000)} s` : 'a conexão caiu no meio da resposta', undefined, true);
    }
    let json: unknown;
    try {
      json = texto ? JSON.parse(texto) : undefined;
    } catch {
      json = undefined;
    }

    registrar(resposta.status, resposta.ok);
    if (!resposta.ok) throw erroPorStatus(resposta.status, json, moduloDe(caminho));
    if (json === undefined) throw new ErroSpine(`${resposta.status}: a franquia respondeu sem JSON`, resposta.status);
    return json as T;
  }
}
