/**
 * Pluggy (Open Finance) — o cliente HTTP do conector, SÓ LEITURA, para a conta pessoal "Meu Pluggy" (até 5 conexões do mesmo titular, dados sincronizados
 * 1 vez por dia). Documentação: docs.pluggy.ai/en/docs/guides/meu-pluggy-personal-use e meu.pluggy.ai/api-guide.
 *
 * Rotas usadas (todas GET, menos o /auth que só troca credencial por chave):
 *   - POST /auth                  {clientId, clientSecret} -> {apiKey}  (a chave vale 2 h; fica em memória até perto de vencer)
 *   - GET  /items/{id}            status da conexão, última sincronização, validade do consentimento
 *   - GET  /accounts?itemId=      contas do item
 *   - GET  /v2/transactions?accountId=&dateFrom=&dateTo=&after=   lançamentos, paginação por cursor
 * `GET /transactions` (por página) está marcado como obsoleto na documentação e SAI DO AR em 31/12/2026; por isso usamos a /v2.
 * `GET /items` (listagem) responde 403 no Meu Pluggy: os ids dos itens vêm da configuração (`PLUGGY_ITENS`), nunca de listagem.
 *
 * O segredo (`clientSecret`) e a `apiKey` NUNCA vão para log, erro, Telegram nem resposta de ferramenta: toda mensagem de erro passa por `tirarSegredos`,
 * que apaga os formatos conhecidos (pluggy_sk_…, whsec_…, JWT) e o valor exato que este cliente conhece.
 *
 * Variáveis de ambiente:
 *   PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET   as credenciais da aplicação (Dashboard da Pluggy)
 *   PLUGGY_ITENS="<empresa>:<itemId>[:<apelido>],..."   <empresa> é o slug da empresa/unidade do conector (ex. doutor-digital). Empresa desconhecida,
 *   item repetido, texto malformado: IGNORADO e vai para o log (sem o id inteiro); nunca se adivinha de quem é o item.
 */

export const PLUGGY_API = 'https://api.pluggy.ai';
const AGENTE = 'DoutorDigital-Conector/1.0';

// ----------------------------------------------------------------- segredos

const PADROES_DE_SEGREDO: ReadonlyArray<readonly [RegExp, string]> = [
  [/pluggy_sk_[A-Za-z0-9_-]+/g, 'pluggy_sk_…'],
  [/whsec_[A-Za-z0-9+/=_-]+/g, 'whsec_…'],
  // a apiKey da Pluggy é um JWT (eyJ….….…)
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[chave-da-api]'],
];

/**
 * Defesa em profundidade: nenhuma mensagem sai com segredo, mesmo que algum dia um erro o repita. `conhecidos` são os valores exatos que o
 * chamador tem em mãos (o clientSecret, a apiKey atual): saem mesmo quando não têm o formato dos padrões.
 */
export function tirarSegredos(texto: string, conhecidos: ReadonlyArray<string | undefined> = []): string {
  let t = String(texto ?? '');
  for (const s of conhecidos) if (s && s.length >= 6) t = t.split(s).join('[segredo]');
  for (const [re, troca] of PADROES_DE_SEGREDO) t = t.replace(re, troca);
  return t;
}

export class ErroPluggy extends Error {
  constructor(msg: string, readonly status: number | null = null, conhecidos: ReadonlyArray<string | undefined> = []) {
    super(tirarSegredos(msg, conhecidos));
  }
}

/** O id do item como aparece em log e mensagem: só o final. O id inteiro não é segredo sozinho, mas com a chave dá acesso à conta. */
export const itemMascarado = (itemId: string): string => `…${String(itemId).replace(/[^A-Za-z0-9]/g, '').slice(-6)}`;

/** `1234567-8` -> `•••5678`. Número de conta nunca sai inteiro. */
export function numeroMascarado(numero: string | null | undefined): string | null {
  if (!numero) return null;
  const fim = String(numero).replace(/[^A-Za-z0-9]/g, '').slice(-4);
  return fim ? `•••${fim}` : null;
}

// ----------------------------------------------------------------- configuração

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;
/** Sem espaço, aspas nem vírgula/dois-pontos: o valor precisa carregar no bash (`. ./.env`) E no env_file do docker. */
const APELIDO = /^[A-Za-z0-9_.-]{1,40}$/;

export interface EntradaDoAmbiente {
  empresa: string;
  itemId: string;
  apelido?: string;
}

export interface LeituraDosItens {
  entradas: EntradaDoAmbiente[];
  /** o que não virou entrada, com o motivo (nunca o texto inteiro): vai para o log */
  ignoradas: Array<{ posicao: number; item?: string; motivo: string }>;
}

/**
 * Lê `PLUGGY_ITENS` (só a forma do texto; quem confere a empresa é `resolverEmpresas`). Entrada malformada é IGNORADA. O mesmo item na mesma empresa
 * é lido uma vez só; o mesmo item em duas empresas diferentes é ambíguo e NENHUMA das duas vale (não se adivinha de quem é a conta).
 */
export function lerItensDoAmbiente(bruto: string | undefined): LeituraDosItens {
  const entradas: EntradaDoAmbiente[] = [];
  const ignoradas: LeituraDosItens['ignoradas'] = [];
  const texto = (bruto ?? '').trim();
  if (!texto) return { entradas, ignoradas };
  texto.split(',').forEach((cru, i) => {
    const parte = cru.trim();
    if (!parte) return;
    const campos = parte.split(':').map((c) => c.trim());
    if (campos.length < 2 || campos.length > 3) return void ignoradas.push({ posicao: i + 1, motivo: 'formato esperado empresa:itemId[:apelido]' });
    const [empresaCrua, itemId, apelido] = campos as [string, string, string | undefined];
    if (!UUID.test(itemId)) return void ignoradas.push({ posicao: i + 1, motivo: 'o itemId não tem formato de UUID' });
    const empresa = empresaCrua.toLowerCase();
    if (!SLUG.test(empresa)) return void ignoradas.push({ posicao: i + 1, item: itemMascarado(itemId), motivo: 'empresa com formato inválido' });
    if (apelido !== undefined && !APELIDO.test(apelido)) return void ignoradas.push({ posicao: i + 1, item: itemMascarado(itemId), motivo: 'apelido inválido (use só letras, números, _ . -; até 40)' });
    entradas.push({ empresa, itemId: itemId.toLowerCase(), ...(apelido ? { apelido } : {}) });
  });
  // repetido na mesma empresa: fica o primeiro; em empresas diferentes: ambíguo, nenhum
  const empresasDoItem = new Map<string, Set<string>>();
  for (const e of entradas) (empresasDoItem.get(e.itemId) ?? empresasDoItem.set(e.itemId, new Set()).get(e.itemId)!).add(e.empresa);
  const vistos = new Set<string>();
  const finais: EntradaDoAmbiente[] = [];
  entradas.forEach((e, i) => {
    if ((empresasDoItem.get(e.itemId)?.size ?? 0) > 1) return void ignoradas.push({ posicao: i + 1, item: itemMascarado(e.itemId), motivo: 'o mesmo item aparece em mais de uma empresa: ambíguo, ignorado' });
    const chave = `${e.empresa}:${e.itemId}`;
    if (vistos.has(chave)) return void ignoradas.push({ posicao: i + 1, item: itemMascarado(e.itemId), motivo: 'item repetido na mesma empresa' });
    vistos.add(chave);
    finais.push(e);
  });
  return { entradas: finais, ignoradas };
}

export interface ItemConfigurado extends EntradaDoAmbiente {
  nomeDaEmpresa: string;
}

/** Confere a empresa contra as unidades do conector (slug EXATO e ativa). Desconhecida ou inativa é ignorada, nunca aproximada. */
export function resolverEmpresas(
  entradas: ReadonlyArray<EntradaDoAmbiente>,
  unidades: ReadonlyArray<{ slug: string; nome: string; ativa?: boolean }>,
): { itens: ItemConfigurado[]; ignoradas: Array<{ item: string; motivo: string }> } {
  const itens: ItemConfigurado[] = [];
  const ignoradas: Array<{ item: string; motivo: string }> = [];
  for (const e of entradas) {
    const u = unidades.find((x) => x.slug === e.empresa);
    if (!u) ignoradas.push({ item: itemMascarado(e.itemId), motivo: `nenhuma empresa/unidade com o slug "${e.empresa}"` });
    else if (u.ativa === false) ignoradas.push({ item: itemMascarado(e.itemId), motivo: `a empresa ${u.slug} está inativa` });
    else itens.push({ ...e, nomeDaEmpresa: u.nome });
  }
  return { itens, ignoradas };
}

export interface CredenciaisPluggy {
  clientId: string;
  clientSecret: string;
}

export function lerCredenciais(e: NodeJS.ProcessEnv = process.env): CredenciaisPluggy | null {
  const clientId = (e.PLUGGY_CLIENT_ID ?? '').trim();
  const clientSecret = (e.PLUGGY_CLIENT_SECRET ?? '').trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

// ----------------------------------------------------------------- modelos (já normalizados)

export interface ItemPluggy {
  id: string;
  banco: string | null;
  /** UPDATED, UPDATING, LOGIN_ERROR, OUTDATED, WAITING_USER_INPUT… como a Pluggy manda */
  status: string | null;
  statusDaSincronizacao: string | null;
  /** última sincronização do item (ISO); o Meu Pluggy atualiza a cada 24 h */
  atualizadoEm: string | null;
  consentimentoExpiraEm: string | null;
  /** só o código do erro (USER_AUTHORIZATION_EXPIRED…), nunca a mensagem livre */
  erroCodigo: string | null;
}

export interface ContaPluggy {
  id: string;
  tipo: string | null;
  subtipo: string | null;
  nome: string | null;
  numero: string | null;
  saldo: number | null;
  moeda: string;
  limiteDisponivel?: number;
  limiteTotal?: number;
}

export interface LancamentoPluggy {
  id: string;
  /** AAAA-MM-DD, como o banco lançou */
  data: string;
  descricao: string;
  /** como a Pluggy manda: negativo = saiu, positivo = entrou */
  valor: number;
  tipo: 'entrada' | 'saida';
  categoria: string | null;
  status: string | null;
  pagador?: string;
  recebedor?: string;
  motivo?: string;
}

export interface TransacoesLidas {
  lancamentos: LancamentoPluggy[];
  /** parou antes do fim (teto de páginas ou cursor repetido): os totais ficam INCOMPLETOS */
  truncado: boolean;
}

/** O que as ferramentas usam. O cliente HTTP abaixo e os falsos dos testes cumprem esta interface. */
export interface FontePluggy {
  item(itemId: string): Promise<ItemPluggy>;
  contas(itemId: string): Promise<ContaPluggy[]>;
  transacoes(contaId: string, de: string, ate: string): Promise<TransacoesLidas>;
  /** prova o clientId/clientSecret com uma chave nova, sem ler dado nenhum */
  testar(): Promise<void>;
  /** esquece o que guardou desse item (o webhook avisou que mudou) */
  invalidarItem(itemId: string): void;
}

// ----------------------------------------------------------------- cliente HTTP

export interface OpcoesDoCliente {
  fetcher?: typeof fetch;
  agora?: () => number;
  /** espera entre tentativas; os testes trocam por uma que não espera */
  esperar?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** tentativas EXTRAS em 429, 5xx e falha de rede (padrão 2: no máximo 3 chamadas) */
  retentativas?: number;
  /** a chave vale 2 h; é renovada com esta folga (padrão 5 min) */
  margemMs?: number;
  /** quanto item e contas ficam guardados (padrão 10 min; o dado muda 1 vez por dia) */
  cacheMs?: number;
  /** páginas de lançamentos por conta (padrão 40 × 500) */
  maxPaginas?: number;
}

const DUAS_HORAS = 2 * 60 * 60_000;
const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const numero = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** "2026-11-01T00:00:00.000Z" -> "2026-11-01" */
const soAData = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const objeto = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Os códigos que a documentação lista para recusa de credencial; só o CÓDIGO sai, nunca texto livre do corpo. */
const CODIGOS_CONHECIDOS = /^[A-Z][A-Z_]{2,48}$/;

function falhaDoStatus(status: number, json: Record<string, unknown> | null, conhecidos: ReadonlyArray<string | undefined>, noAuth: boolean): ErroPluggy {
  const cod = typeof json?.codeDescription === 'string' && CODIGOS_CONHECIDOS.test(json.codeDescription) ? ` [${json.codeDescription}]` : '';
  if (noAuth && status === 401) return new ErroPluggy(`a Pluggy recusou o clientId/clientSecret (401)${cod}: confira as credenciais da aplicação (o secret vence em 180 dias)`, 401, conhecidos);
  if (noAuth && status === 403) return new ErroPluggy(`a Pluggy recusou a chamada (403)${cod}: se for CLIENT_IP_NOT_ALLOWED, o IP do servidor não está na lista da aplicação`, 403, conhecidos);
  if (status === 401) return new ErroPluggy('a Pluggy não aceitou a chave de acesso (401), mesmo renovada', 401, conhecidos);
  if (status === 403) return new ErroPluggy(`a Pluggy recusou a leitura (403)${cod}: para o Meu Pluggy, a listagem de itens não existe; use o id do item`, 403, conhecidos);
  if (status === 404) return new ErroPluggy('a Pluggy não achou o recurso (404): item ou conta que não existe nesta aplicação', 404, conhecidos);
  if (status === 429) return new ErroPluggy('a Pluggy pediu para ir mais devagar (429); tente de novo em instantes', 429, conhecidos);
  return new ErroPluggy(`a Pluggy respondeu ${status}${cod}`, status, conhecidos);
}

export function criarClientePluggy(cred: CredenciaisPluggy, op: OpcoesDoCliente = {}): FontePluggy {
  const f = op.fetcher ?? fetch;
  const agora = op.agora ?? Date.now;
  const esperar = op.esperar ?? dormir;
  const timeoutMs = op.timeoutMs ?? 12_000;
  const retentativas = op.retentativas ?? 2;
  const margemMs = op.margemMs ?? 5 * 60_000;
  const cacheMs = op.cacheMs ?? 10 * 60_000;
  const maxPaginas = op.maxPaginas ?? 40;

  let chave: { valor: string; venceEm: number } | null = null;
  let autenticando: Promise<string> | null = null;
  const conhecidos = (): Array<string | undefined> => [cred.clientSecret, chave?.valor];

  /** UMA chamada ao /auth por vez (o limite é 360/min, mas ninguém precisa de duas chaves ao mesmo tempo). */
  async function obterChave(forcar = false): Promise<string> {
    if (!forcar && chave && agora() < chave.venceEm - margemMs) return chave.valor;
    if (autenticando) return autenticando;
    autenticando = (async () => {
      try {
        const r = await pedir('POST', '/auth', { corpo: { clientId: cred.clientId, clientSecret: cred.clientSecret }, semChave: true });
        if (r.status < 200 || r.status >= 300) throw falhaDoStatus(r.status, r.json, conhecidos(), true);
        const apiKey = texto(r.json?.apiKey);
        if (!apiKey) throw new ErroPluggy('a Pluggy respondeu ao /auth sem a chave (formato inesperado)', r.status, conhecidos());
        chave = { valor: apiKey, venceEm: agora() + DUAS_HORAS };
        return apiKey;
      } finally {
        autenticando = null;
      }
    })();
    return autenticando;
  }

  interface Pedido {
    corpo?: unknown;
    query?: Record<string, string>;
    semChave?: boolean;
    chave?: string;
  }

  /** Uma chamada com tempo limite e nova tentativa SÓ em 429, 5xx e falha de rede. */
  async function pedir(metodo: 'GET' | 'POST', caminho: string, p: Pedido): Promise<{ status: number; json: Record<string, unknown> | null }> {
    const url = new URL(`${PLUGGY_API}${caminho}`);
    for (const [k, v] of Object.entries(p.query ?? {})) url.searchParams.set(k, v);
    const cabecalhos: Record<string, string> = { Accept: 'application/json', 'User-Agent': AGENTE };
    if (p.corpo !== undefined) cabecalhos['Content-Type'] = 'application/json';
    if (!p.semChave && p.chave) cabecalhos['X-API-KEY'] = p.chave;
    for (let tentativa = 0; ; tentativa++) {
      let r: Response;
      try {
        r = await f(url.toString(), { method: metodo, headers: cabecalhos, ...(p.corpo !== undefined ? { body: JSON.stringify(p.corpo) } : {}), signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        if (tentativa < retentativas) {
          await esperar(500 * 2 ** tentativa);
          continue;
        }
        const nome = e instanceof Error ? e.name : '';
        throw new ErroPluggy(nome === 'TimeoutError' || nome === 'AbortError' ? 'a Pluggy não respondeu a tempo' : 'não consegui falar com a Pluggy (rede)', null, conhecidos());
      }
      if ((r.status === 429 || r.status >= 500) && tentativa < retentativas) {
        // 429: a Pluggy diz em RateLimit-Reset quantos segundos faltam; espera isso, no máximo 10 s (o Retry-After é sempre 60)
        const reset = Number(r.headers.get('RateLimit-Reset'));
        await esperar(r.status === 429 ? Math.min(Number.isFinite(reset) && reset > 0 ? reset * 1000 : 1000, 10_000) : 500 * 2 ** tentativa);
        continue;
      }
      const corpoTexto = await r.text().catch(() => '');
      let json: Record<string, unknown> | null = null;
      try {
        json = objeto(JSON.parse(corpoTexto));
      } catch {
        // corpo que não é JSON: segue só com o status
      }
      return { status: r.status, json };
    }
  }

  /** GET autenticado. 401 com chave guardada = a chave pode ter sido revogada: renova UMA vez e repete. */
  async function ler(caminho: string, query?: Record<string, string>): Promise<Record<string, unknown>> {
    for (let renovou = false; ; renovou = true) {
      const k = await obterChave(renovou);
      const r = await pedir('GET', caminho, { ...(query ? { query } : {}), chave: k });
      if (r.status === 401 && !renovou) {
        chave = null;
        continue;
      }
      if (r.status < 200 || r.status >= 300) throw falhaDoStatus(r.status, r.json, conhecidos(), false);
      if (!r.json) throw new ErroPluggy('a Pluggy respondeu em formato inesperado (não é JSON): pode ser um proxy ou uma mudança na API', r.status, conhecidos());
      return r.json;
    }
  }

  const cacheItem = new Map<string, { ate: number; v: ItemPluggy }>();
  const cacheContas = new Map<string, { ate: number; v: ContaPluggy[] }>();

  function lerItem(id: string, j: Record<string, unknown>): ItemPluggy {
    const erro = objeto(j.error);
    return {
      id,
      banco: texto(objeto(j.connector)?.name),
      status: texto(j.status),
      statusDaSincronizacao: texto(j.executionStatus),
      atualizadoEm: texto(j.lastUpdatedAt) ?? texto(j.updatedAt),
      consentimentoExpiraEm: texto(j.consentExpiresAt),
      erroCodigo: typeof erro?.code === 'string' && CODIGOS_CONHECIDOS.test(erro.code) ? erro.code : null,
    };
  }

  function lerConta(j: Record<string, unknown>): ContaPluggy | null {
    const id = texto(j.id);
    if (!id) return null;
    const credito = objeto(j.creditData);
    const disp = numero(credito?.availableCreditLimit);
    const total = numero(credito?.creditLimit);
    return {
      id,
      tipo: texto(j.type),
      subtipo: texto(j.subtype),
      nome: texto(j.name) ?? texto(j.marketingName),
      numero: texto(j.number),
      saldo: numero(j.balance),
      moeda: texto(j.currencyCode) ?? 'BRL',
      ...(disp !== null ? { limiteDisponivel: disp } : {}),
      ...(total !== null ? { limiteTotal: total } : {}),
    };
  }

  function lerLancamento(j: Record<string, unknown>): LancamentoPluggy | null {
    const id = texto(j.id);
    const data = soAData(j.date);
    const valor = numero(j.amount);
    if (!id || !data || valor === null) return null;
    // `type` manda (CREDIT = entrou, DEBIT = saiu); sem ele vale o sinal do valor
    const t = texto(j.type)?.toUpperCase();
    const tipo: LancamentoPluggy['tipo'] = t === 'CREDIT' ? 'entrada' : t === 'DEBIT' ? 'saida' : valor < 0 ? 'saida' : 'entrada';
    const pd = objeto(j.paymentData);
    const pagador = texto(objeto(pd?.payer)?.name);
    const recebedor = texto(objeto(pd?.receiver)?.name);
    const motivo = texto(pd?.reason);
    return {
      id,
      data,
      descricao: texto(j.description) ?? texto(j.descriptionRaw) ?? '',
      valor,
      tipo,
      categoria: texto(j.category),
      status: texto(j.status),
      ...(pagador ? { pagador } : {}),
      ...(recebedor ? { recebedor } : {}),
      ...(motivo ? { motivo } : {}),
    };
  }

  return {
    async item(itemId) {
      const guardado = cacheItem.get(itemId);
      if (guardado && guardado.ate > agora()) return guardado.v;
      const v = lerItem(itemId, await ler(`/items/${encodeURIComponent(itemId)}`));
      cacheItem.set(itemId, { ate: agora() + cacheMs, v });
      return v;
    },
    async contas(itemId) {
      const guardado = cacheContas.get(itemId);
      if (guardado && guardado.ate > agora()) return guardado.v;
      const j = await ler('/accounts', { itemId, pageSize: '500' });
      if (!Array.isArray(j.results)) throw new ErroPluggy('a Pluggy respondeu às contas em formato inesperado (sem results)', 200, conhecidos());
      const v = j.results.map((c) => lerConta(objeto(c) ?? {})).filter((c): c is ContaPluggy => c !== null);
      cacheContas.set(itemId, { ate: agora() + cacheMs, v });
      return v;
    },
    async transacoes(contaId, de, ate) {
      const lancamentos: LancamentoPluggy[] = [];
      let depois: string | null = null;
      const cursores = new Set<string>();
      for (let pagina = 1; pagina <= maxPaginas; pagina++) {
        const query: Record<string, string> = { accountId: contaId, dateFrom: de, dateTo: ate, ...(depois ? { after: depois } : {}) };
        const j = await ler('/v2/transactions', query);
        if (!Array.isArray(j.results)) throw new ErroPluggy('a Pluggy respondeu aos lançamentos em formato inesperado (sem results)', 200, conhecidos());
        for (const t of j.results) {
          const l = lerLancamento(objeto(t) ?? {});
          if (l) lancamentos.push(l);
        }
        // `next` vem como query string pronta ("?accountId=…&after=…"); só o valor de `after` (já decodificado) volta no pedido
        const proximo = typeof j.next === 'string' && j.next ? new URLSearchParams(j.next.replace(/^\?/, '')).get('after') : null;
        if (!proximo) return { lancamentos, truncado: false };
        if (cursores.has(proximo)) return { lancamentos, truncado: true };
        cursores.add(proximo);
        depois = proximo;
      }
      return { lancamentos, truncado: true };
    },
    async testar() {
      await obterChave(true);
    },
    invalidarItem(itemId) {
      cacheItem.delete(itemId);
      cacheContas.delete(itemId);
    },
  };
}

let compartilhado: { chave: string; cliente: FontePluggy } | null = null;
/**
 * O cliente único do processo (a chave de 2 h e o cache vivem nele): o conector e o webhook usam o MESMO. Sem credenciais no ambiente, null.
 * Se as credenciais mudarem (testes), cria outro.
 */
export function clienteCompartilhado(e: NodeJS.ProcessEnv = process.env): FontePluggy | null {
  const cred = lerCredenciais(e);
  if (!cred) return null;
  const id = `${cred.clientId}\u0000${cred.clientSecret}`;
  if (!compartilhado || compartilhado.chave !== id) compartilhado = { chave: id, cliente: criarClientePluggy(cred) };
  return compartilhado.cliente;
}
