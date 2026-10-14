/**
 * Credencial nunca vai para o log — nem para a saída do serviço, nem para `system_logs`.
 *
 * A redação por CAMINHO do pino (`err.config.headers.Authorization`, `err.request._header`) não basta: um
 * erro do axios carrega o mesmo cabeçalho em vários outros lugares. Medido em 14/10/2026 com um 401 real
 * do axios 1.x, o `Bearer` aparecia ainda em `err.response.request._header`, `err.request.res.req._header`,
 * `err.request._redirectable._currentRequest._header` e `err.request._redirectable._options.headers` —
 * e foi assim que o token do Kommo de Olímpia apareceu no log do `ddagent_agent`.
 *
 * Em vez de correr atrás de caminho, o erro HTTP vira um RESUMO antes de ser serializado: método, URL,
 * status, código, corpo da resposta (cortado) e a pilha. `config`, `request` e `response` — onde mora o
 * cabeçalho — não chegam ao log. De quebra, a linha de um 401 cai de ~12 KB para menos de 1 KB.
 * Texto solto com `Bearer …` e chave com nome de segredo (`authorization`, `token`…) também são mascarados.
 */

export const MASCARA = '[redigido]';

const PROFUNDIDADE_MAX = 6;
const CHAVES_MAX = 300;
const RESPOSTA_MAX = 1_000;

/** Nome de chave que guarda segredo, comparado sem caixa, hífen nem sublinhado. */
const CHAVES_SECRETAS = new Set([
  'authorization', 'proxyauthorization', 'cookie', 'setcookie', 'xapikey', 'apikey', 'accesstoken',
  'refreshtoken', 'token', 'spinetoken', 'kommoaccesstoken', 'password', 'senha', 'secret', 'clientsecret',
]);

function chaveSecreta(chave: string): boolean {
  return CHAVES_SECRETAS.has(chave.toLowerCase().replace(/[-_]/g, ''));
}

/**
 * `Bearer xxx`, `Basic xxx` e `?access_token=xxx` dentro de qualquer texto. A credencial tem 8+ caracteres —
 * o piso evita mascarar texto comum ("plano Basic mensal", "Bearer token" numa explicação).
 */
export function mascararTexto(s: string): string {
  return s
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASCARA}`)
    .replace(/([?&](?:access_token|token|apikey|api_key|key|secret|client_secret)=)[^&#\s"']*/gi, `$1${MASCARA}`);
}

type Obj = Record<string, unknown>;

const ehObjeto = (v: unknown): v is Obj => typeof v === 'object' && v !== null;

/**
 * Erro do axios: a bandeira oficial, ou um Error com o formato dele (config + request/response). Objeto simples
 * com `config` e `response` NÃO conta — pode ser o próprio objeto do log.
 */
export function ehErroHttp(v: unknown): v is Obj {
  return ehObjeto(v) && (v.isAxiosError === true || (v instanceof Error && 'config' in v && ('request' in v || 'response' in v)));
}

/** Resposta do axios solta (`{ err: e.response }`): config, status, headers e a requisição. */
function ehRespostaHttp(v: unknown): v is Obj {
  return ehObjeto(v) && !(v instanceof Error) && 'config' in v && 'status' in v && 'headers' in v && 'request' in v;
}

/** Requisição do Node (`ClientRequest`) ou o invólucro do follow-redirects: o `_header` é o cabeçalho cru. */
function ehRequisicaoNode(v: unknown): v is Obj {
  return ehObjeto(v) && (typeof v._header === 'string' || '_redirectable' in v || '_currentRequest' in v);
}

function texto(v: unknown, max: number): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  s = mascararTexto(s);
  return s.length > max ? `${s.slice(0, max)}…[cortado]` : s;
}

function urlDe(config: unknown): string | undefined {
  if (!ehObjeto(config)) return undefined;
  const url = typeof config.url === 'string' ? config.url : '';
  const base = typeof config.baseURL === 'string' ? config.baseURL.replace(/\/$/, '') : '';
  const junto = /^https?:\/\//i.test(url) || !base ? url : `${base}/${url.replace(/^\//, '')}`;
  return junto ? mascararTexto(junto) : undefined;
}

/**
 * Classe só para o pino escrever `"type":"ErroHttp"` (o serializador de erro dele usa o nome do construtor).
 * Não estende Error de propósito: assim `system_logs` guarda status, URL e resposta, não só a mensagem.
 */
class ErroHttp {
  [k: string]: unknown;
}

/** O que um erro HTTP precisa contar no log — e nada do que carrega a credencial. */
export function resumoDoErroHttp(e: Obj): ErroHttp {
  const config = ehObjeto(e.config) ? e.config : undefined;
  const response = ehObjeto(e.response) ? e.response : undefined;
  const out = new ErroHttp();
  const campos: Obj = {
    message: typeof e.message === 'string' ? mascararTexto(e.message) : 'erro HTTP',
    code: e.code,
    status: response?.status ?? e.status,
    method: typeof config?.method === 'string' ? config.method.toUpperCase() : undefined,
    url: urlDe(config),
    resposta: texto(response?.data, RESPOSTA_MAX),
    stack: typeof e.stack === 'string' ? mascararTexto(e.stack) : undefined,
  };
  for (const [k, v] of Object.entries(campos)) if (v !== undefined) out[k] = v;
  return out;
}

function resumoDaResposta(r: Obj): Obj {
  const out: Obj = { status: r.status, statusText: r.statusText, url: urlDe(r.config) };
  const config = ehObjeto(r.config) ? r.config : undefined;
  if (typeof config?.method === 'string') out.method = config.method.toUpperCase();
  const dados = texto(r.data, RESPOSTA_MAX);
  if (dados !== undefined) out.resposta = dados;
  return out;
}

function ehSimples(v: Obj): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Em andamento: o objeto é ancestral dele mesmo (ciclo). */
const EM_CURSO = Symbol('em-curso');

/**
 * Devolve uma versão do valor sem credencial. Não muda o original e devolve o MESMO objeto quando não há
 * nada a limpar — o caso comum (`{ unit, leadId, campo }`) não aloca nada. O mesmo objeto citado duas vezes
 * sai limpo nas duas (a lembrança é por objeto, não um "já vi, devolve como veio").
 */
export function limparParaLog(v: unknown, profundidade = 0, feitos: Map<object, unknown> = new Map()): unknown {
  if (typeof v === 'string') return mascararTexto(v);
  if (!ehObjeto(v)) return v;
  if (ehErroHttp(v)) return resumoDoErroHttp(v);
  if (ehRespostaHttp(v)) return resumoDaResposta(v);
  if (ehRequisicaoNode(v)) return '[requisição HTTP omitida]';
  if (feitos.has(v)) {
    const r = feitos.get(v);
    return r === EM_CURSO ? '[circular]' : r;
  }
  if (profundidade >= PROFUNDIDADE_MAX) return v;
  feitos.set(v, EM_CURSO);
  const r = limparObjeto(v, profundidade, feitos);
  feitos.set(v, r);
  return r;
}

function limparObjeto(v: Obj, profundidade: number, feitos: Map<object, unknown>): unknown {
  const filho = (x: unknown) => limparParaLog(x, profundidade + 1, feitos);
  // AxiosHeaders é classe: vira objeto simples para passar pela regra das chaves secretas
  const cabecalhos = (v as { constructor?: { name?: string } }).constructor?.name === 'AxiosHeaders' && typeof v.toJSON === 'function';
  const alvo = cabecalhos ? (((v.toJSON as () => Obj)()) ?? {}) : v;

  if (Array.isArray(alvo)) {
    if (alvo.length > CHAVES_MAX) return alvo;
    let mudou = false;
    const out = alvo.map((x) => {
      const y = filho(x);
      if (y !== x) mudou = true;
      return y;
    });
    return mudou ? out : alvo;
  }

  if (alvo instanceof Error) {
    // Erro comum fica como está (o serializador do pino cuida da causa e da pilha) — a não ser que leve
    // segredo na mensagem ou um erro HTTP pendurado numa propriedade (`e.original = erroDoAxios`).
    const limpas = Object.keys(alvo).map((k) => {
      const x = (alvo as unknown as Obj)[k];
      return [k, x, chaveSecreta(k) && x ? MASCARA : filho(x)] as const;
    });
    const msg = mascararTexto(alvo.message);
    const pilha = typeof alvo.stack === 'string' ? mascararTexto(alvo.stack) : alvo.stack;
    if (msg === alvo.message && pilha === alvo.stack && limpas.every(([, x, y]) => x === y)) return alvo;
    // cópia com o MESMO protótipo: o pino continua escrevendo o tipo certo (`"type":"KommoApiError"`)
    const copia = Object.create(Object.getPrototypeOf(alvo)) as Obj;
    const oculto = (k: string, valor: unknown) => Object.defineProperty(copia, k, { value: valor, enumerable: false, writable: true, configurable: true });
    oculto('message', msg);
    oculto('stack', pilha);
    if ('cause' in alvo) oculto('cause', filho((alvo as { cause?: unknown }).cause));
    for (const [k, , y] of limpas) copia[k] = y;
    return copia;
  }

  if (!cabecalhos && !ehSimples(alvo)) return alvo; // Date, Buffer, Map, Decimal…: o pino serializa como sempre
  const chaves = Object.keys(alvo);
  if (chaves.length > CHAVES_MAX) return alvo;
  let mudou = cabecalhos;
  const out: Obj = {};
  for (const k of chaves) {
    const x = alvo[k];
    const y = chaveSecreta(k) && x !== null && x !== undefined && x !== '' ? MASCARA : filho(x);
    if (y !== x) mudou = true;
    out[k] = y;
  }
  return mudou ? out : alvo;
}
