/**
 * Focus NFe (https://doc.focusnfe.com.br) — o cliente HTTP do conector para a NFS-e NACIONAL (padrão nacional, rota `/v2/nfsen`).
 *
 * O que a documentação oficial diz (conferido em 26/11/2026) e que este cliente segue:
 *   - AUTENTICAÇÃO: HTTP Basic, o token da EMPRESA como usuário e a senha EM BRANCO (`Authorization: Basic base64("<token>:")`). Igual nos dois ambientes.
 *   - AMBIENTES: homologação `https://homologacao.focusnfe.com.br` (sem validade fiscal) e produção `https://api.focusnfe.com.br`; rotas com prefixo `/v2`.
 *     Cada ambiente tem o SEU token: o de um não vale no outro (a Focus responde 401).
 *   - EMITIR: `POST /v2/nfsen?ref=<referência>` com o DPS em JSON. 400/422 = recusada de imediato (nada foi emitido); 202 = aceita, processa em fila (ASSÍNCRONO).
 *   - CONSULTAR: `GET /v2/nfsen/<referência>` (status: processando_autorizacao, autorizado, negado, cancelado, erro_autorizacao). 404 = referência desconhecida.
 *   - CANCELAR: `DELETE /v2/nfsen/<referência>` com `{justificativa}`; SÍNCRONO; só nota "autorizado"; devolve `cancelado` ou `erro_cancelamento` com `erros`.
 *   - WEBHOOK (gatilho): `POST /v2/hooks` com `event: "nfsen"` (NFS-e Nacional AUTORIZADA); a notificação traz os mesmos dados da consulta. Sem assinatura (só o
 *     `authorization`/`authorization_header` que o cadastro do gatilho permite). Não há rota que LISTE notas da NFS-e Nacional.
 *   A referência (`ref`) é só letras e números, única por empresa; depois de autorizada (mesmo cancelada) não se reaproveita.
 *
 * O token vai SÓ no cabeçalho Authorization, vem do ambiente do servidor e nunca aparece em URL, log, erro nem resposta. A EMISSÃO (POST) e o CANCELAMENTO (DELETE) NUNCA
 * se repetem sozinhos (repetir pode emitir duas notas); só as leituras (GET) têm nova tentativa limitada.
 *
 * Ambiente do servidor, uma conta por unidade (<UNIDADE> = o slug em maiúsculas com "_", ou o final dele quando só uma unidade termina assim):
 *   FOCUS_NFE_UNIDADES                 lista de slugs que podem emitir (vazia ou ausente = TUDO desligado; "*" não vale)
 *   FOCUS_NFE_TOKEN_<UNIDADE>          o token da empresa NO AMBIENTE escolhido abaixo
 *   FOCUS_NFE_AMBIENTE_<UNIDADE>       homologacao (padrão) ou producao; qualquer outro valor deixa a conta de fora
 *   FOCUS_NFE_CNPJ_<UNIDADE>           CNPJ do prestador (14 dígitos)
 *   FOCUS_NFE_MUNICIPIO_<UNIDADE>      código IBGE (7 dígitos) do município do prestador
 *   FOCUS_NFE_SERIE_DPS_<UNIDADE>      série da DPS (1 a 49999, a faixa da API); sem ela só a HOMOLOGAÇÃO emite (série 1); produção exige a série escolhida
 *   FOCUS_NFE_NUMERO_INICIAL_<UNIDADE> primeiro número da DPS desta série (padrão 1); o conector segue daí em diante
 * Nome que não acha unidade, ou acha mais de uma, é IGNORADO (e vai no log, sem o valor): nunca se adivinha a quem o token pertence.
 */
import { unidadeDoSufixo, sufixoDe } from './infinitepay.js';

export const FOCUS_HOMOLOGACAO = 'https://homologacao.focusnfe.com.br';
export const FOCUS_PRODUCAO = 'https://api.focusnfe.com.br';
const AGENTE = 'DoutorDigital-Conector/1.0';
const FORMATO_DO_TOKEN = /^[A-Za-z0-9]{16,64}$/;
/** Referência inexistente usada só para provar o token (um GET que nunca cria nada): 404 = token aceito. */
const REFERENCIA_DE_PROVA = 'ddprovadotokeninexistente';

export type Ambiente = 'homologacao' | 'producao';
export const baseDoAmbiente = (a: Ambiente): string => (a === 'producao' ? FOCUS_PRODUCAO : FOCUS_HOMOLOGACAO);
export const rotuloDoAmbiente = (a: Ambiente): string => (a === 'producao' ? 'PRODUÇÃO' : 'HOMOLOGAÇÃO');

export class ErroFocus extends Error {
  constructor(
    msg: string,
    readonly status: number | null = null,
    /** o código do erro da Focus (ex. erro_validacao, nao_encontrado), quando veio */
    readonly codigo: string | null = null,
  ) {
    super(limparTexto(msg));
  }
}

/** Nenhum texto de erro sai com um pedaço de token ou com um documento inteiro, mesmo que a Focus os repita na mensagem. */
export function limparTexto(texto: string, token?: string): string {
  let t = texto;
  if (token) {
    t = t.split(token).join('[token]');
    t = t.split(Buffer.from(`${token}:`).toString('base64')).join('[token]');
  }
  return t.replace(/Basic\s+[A-Za-z0-9+/=]{12,}/g, 'Basic [token]').replace(/\d{11,14}/g, '[documento]');
}

/** Os 14 dígitos de um CNPJ válido de FORMATO (sem o cálculo dos dígitos: quem confere é a Focus); ou null. */
export function soCnpj(v: string | undefined): string | null {
  const d = (v ?? '').replace(/\D/g, '');
  return d.length === 14 ? d : null;
}

// ----------------------------------------------------------------- configuração do ambiente

export interface ContaFocusConfig {
  slug: string;
  nome: string;
  token: string;
  ambiente: Ambiente;
  /** CNPJ do prestador (14 dígitos), se configurado */
  cnpj?: string;
  /** código IBGE (7 dígitos) do município do prestador, se configurado */
  municipio?: string;
  serieDps?: number;
  numeroInicial: number;
}

export interface LeituraDoAmbiente {
  contas: Map<string, ContaFocusConfig>;
  ignoradas: Array<{ variavel: string; motivo: string }>;
}

/** Unidades que podem emitir. Ausente ou vazia = desligada em todas (falha fechada); "*" não vale. */
export function unidadesLigadasDaFocus(e: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (e.FOCUS_NFE_UNIDADES ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && !s.includes('*')),
  );
}

const P = { token: 'FOCUS_NFE_TOKEN_', ambiente: 'FOCUS_NFE_AMBIENTE_', cnpj: 'FOCUS_NFE_CNPJ_', municipio: 'FOCUS_NFE_MUNICIPIO_', serie: 'FOCUS_NFE_SERIE_DPS_', inicial: 'FOCUS_NFE_NUMERO_INICIAL_' } as const;

type Unidade = { slug: string; nome: string; ativa?: boolean };

/**
 * `unidades` deve trazer TODAS as unidades (ativas e inativas): o sufixo é resolvido entre todas e só depois a inativa é descartada, para o token de uma unidade
 * desativada nunca cair em outra cujo slug termine igual. Só vira conta a unidade que ESTÁ em FOCUS_NFE_UNIDADES.
 */
export function lerContasDoAmbiente(unidades: ReadonlyArray<Unidade>, e: NodeJS.ProcessEnv = process.env): LeituraDoAmbiente {
  const contas = new Map<string, ContaFocusConfig>();
  const ignoradas: LeituraDoAmbiente['ignoradas'] = [];
  const ligadas = unidadesLigadasDaFocus(e);
  const donasDoToken = new Map<string, string>();
  const resolver = (variavel: string, prefixo: string) => {
    const u = unidadeDoSufixo(sufixoDe(variavel, prefixo), unidades);
    if ('motivo' in u) {
      ignoradas.push({ variavel, motivo: u.motivo });
      return null;
    }
    return u;
  };
  const variaveis = Object.keys(e).sort();
  for (const variavel of variaveis.filter((v) => v.startsWith(P.token))) {
    const token = (e[variavel] ?? '').trim();
    if (!token) continue; // vazia = sem conta, sem barulho
    const u = resolver(variavel, P.token);
    if (!u) continue;
    if (!ligadas.has(u.slug)) {
      ignoradas.push({ variavel, motivo: `a unidade ${u.slug} não está em FOCUS_NFE_UNIDADES` });
      continue;
    }
    if (u.ativa === false) {
      ignoradas.push({ variavel, motivo: `a unidade ${u.slug} está inativa` });
      continue;
    }
    if (!FORMATO_DO_TOKEN.test(token)) {
      ignoradas.push({ variavel, motivo: 'o token não tem o formato esperado (letras e números)' });
      continue;
    }
    if (contas.has(u.slug)) {
      ignoradas.push({ variavel, motivo: `a unidade ${u.slug} já tem um token (outra variável)` });
      continue;
    }
    // um token = uma empresa: dividir o token entre unidades multiplicaria os tetos e misturaria as notas
    const dona = donasDoToken.get(token);
    if (dona) {
      ignoradas.push({ variavel, motivo: `o mesmo token já está ligado à unidade ${dona}: um token, uma unidade` });
      continue;
    }
    donasDoToken.set(token, u.slug);
    contas.set(u.slug, { slug: u.slug, nome: u.nome, token, ambiente: 'homologacao', numeroInicial: 1 });
  }
  // o resto é resolvido pelo MESMO caminho do token e só vale para quem tem token
  const descartar = new Set<string>();
  for (const [prefixo, aplicar] of [
    [P.ambiente, (c: ContaFocusConfig, v: string, variavel: string) => {
      if (v === 'homologacao' || v === 'producao') c.ambiente = v;
      else {
        // ambiente que não se entende NUNCA vira o padrão: a conta fica de fora (o padrão é homologação, mas só quando a variável não existe)
        ignoradas.push({ variavel, motivo: 'valor inválido: use homologacao ou producao; a conta ficou de fora' });
        descartar.add(c.slug);
      }
    }],
    [P.cnpj, (c: ContaFocusConfig, v: string, variavel: string) => {
      const d = soCnpj(v);
      if (d) c.cnpj = d;
      else ignoradas.push({ variavel, motivo: 'CNPJ inválido (esperados 14 dígitos); ignorado' });
    }],
    [P.municipio, (c: ContaFocusConfig, v: string, variavel: string) => {
      if (/^\d{7}$/.test(v)) c.municipio = v;
      else ignoradas.push({ variavel, motivo: 'código do município inválido (esperados 7 dígitos do IBGE); ignorado' });
    }],
    [P.serie, (c: ContaFocusConfig, v: string, variavel: string) => {
      const n = Number(v);
      if (/^\d{1,5}$/.test(v) && n >= 1 && n <= 49999) c.serieDps = n;
      else ignoradas.push({ variavel, motivo: 'série inválida (1 a 49999); ignorada' });
    }],
    [P.inicial, (c: ContaFocusConfig, v: string, variavel: string) => {
      const n = Number(v);
      if (/^\d{1,9}$/.test(v) && n >= 1) c.numeroInicial = n;
      else ignoradas.push({ variavel, motivo: 'número inicial inválido (inteiro a partir de 1); ignorado' });
    }],
  ] as const) {
    for (const variavel of variaveis.filter((v) => v.startsWith(prefixo))) {
      const valor = (e[variavel] ?? '').trim().toLowerCase();
      if (!valor) continue;
      const u = resolver(variavel, prefixo);
      if (!u) continue;
      const conta = contas.get(u.slug);
      if (!conta) {
        ignoradas.push({ variavel, motivo: `a unidade ${u.slug} não tem token (FOCUS_NFE_TOKEN_…) ligado` });
        continue;
      }
      aplicar(conta, valor, variavel);
    }
  }
  for (const slug of descartar) contas.delete(slug);
  return { contas, ignoradas };
}

// ----------------------------------------------------------------- chamadas

type Fetcher = typeof fetch;

export interface OpcoesDeChamada {
  fetcher?: Fetcher;
  timeoutMs?: number;
  /** espera entre as tentativas de LEITURA (testes passam 0) */
  esperaMs?: number;
  /** tentativas de leitura (padrão 3, no máximo 3); a emissão e o cancelamento SEMPRE têm uma só */
  tentativas?: number;
}

export interface CredencialFocus {
  token: string;
  ambiente: Ambiente;
}

interface Resposta {
  status: number;
  json: unknown;
  texto: string;
  cabecalhos: Headers;
  /** o token desta chamada: só para limpar o que a Focus repetir nas mensagens */
  token: string;
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const TRANSITORIOS = new Set([429, 500, 502, 503, 504]);

async function umaChamada(c: CredencialFocus, metodo: 'GET' | 'POST' | 'DELETE', caminho: string, corpo: unknown, o: OpcoesDeChamada): Promise<Resposta> {
  const f = o.fetcher ?? fetch;
  let r: Response;
  try {
    r = await f(`${baseDoAmbiente(c.ambiente)}${caminho}`, {
      method: metodo,
      headers: {
        Authorization: `Basic ${Buffer.from(`${c.token}:`).toString('base64')}`,
        Accept: 'application/json',
        'User-Agent': AGENTE,
        ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
      signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
    });
  } catch (e) {
    const nome = e instanceof Error ? e.name : '';
    throw new ErroFocus(nome === 'TimeoutError' || nome === 'AbortError' ? 'a Focus NFe não respondeu a tempo' : 'não consegui falar com a Focus NFe (rede)');
  }
  const texto = await r.text().catch(() => '');
  let json: unknown = null;
  try {
    json = JSON.parse(texto);
  } catch {
    // corpo que não é JSON (ex. "HTTP Basic: Access denied"): segue só com o status
  }
  return { status: r.status, json, texto: limparTexto(texto, c.token).slice(0, 300), cabecalhos: r.headers, token: c.token };
}

/** LEITURA: até 3 tentativas em falha de rede, timeout ou 429/5xx. Nunca usada para POST nem DELETE. */
async function ler(c: CredencialFocus, caminho: string, o: OpcoesDeChamada): Promise<Resposta> {
  const max = Math.min(3, Math.max(1, o.tentativas ?? 3));
  let ultimo: unknown;
  for (let i = 1; i <= max; i++) {
    try {
      const r = await umaChamada(c, 'GET', caminho, undefined, o);
      if (!TRANSITORIOS.has(r.status) || i === max) return r;
      ultimo = new ErroFocus(`a Focus NFe respondeu ${r.status}`, r.status);
    } catch (e) {
      ultimo = e;
      if (i === max) throw e;
    }
    await dormir((o.esperaMs ?? 400) * i);
  }
  throw ultimo instanceof Error ? ultimo : new ErroFocus('a Focus NFe não respondeu');
}

const objeto = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const txt = (v: unknown, max = 300): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** A mensagem da Focus sem token nem documento inteiro, mesmo que ela os repita. */
function mensagemLimpa(v: unknown, max: number, token: string): string | undefined {
  const t = txt(v, max);
  return t ? limparTexto(t, token) : undefined;
}

/** Falha de HTTP da Focus em português; o corpo `{codigo, mensagem}` entra (sem token nem documento). */
function falhaDoStatus(r: Resposta): ErroFocus {
  const j = objeto(r.json);
  const mensagem = mensagemLimpa(j.mensagem, 200, r.token);
  const codigo = txt(j.codigo, 60) ?? null;
  const detalhe = mensagem ? ` (${mensagem})` : '';
  if (r.status === 401 || r.status === 403) {
    return new ErroFocus(`a Focus NFe não reconheceu o token (${r.status}): token errado, revogado, ou é de OUTRO ambiente (homologação e produção têm tokens diferentes)`, r.status, codigo);
  }
  if (r.status === 404) return new ErroFocus(`a Focus NFe respondeu 404${detalhe}`, 404, codigo);
  if (r.status === 429) return new ErroFocus('a Focus NFe pediu para ir mais devagar (429); tente de novo em instantes', 429, codigo);
  return new ErroFocus(`a Focus NFe respondeu ${r.status}${detalhe}`, r.status, codigo);
}

export interface ErroDaNota {
  codigo?: string;
  mensagem?: string;
  correcao?: string;
}

/** A nota como a consulta da Focus devolve (campos documentados). */
export interface NotaFocus {
  status: string;
  ref?: string;
  numero?: string;
  codigoVerificacao?: string;
  dataEmissao?: string;
  urlConsulta?: string;
  urlDanfse?: string;
  caminhoXml?: string;
  caminhoXmlCancelamento?: string;
  erros?: ErroDaNota[];
}

function comoNota(j: unknown): NotaFocus {
  const o = objeto(j);
  const erros = Array.isArray(o.erros)
    ? o.erros.slice(0, 10).map((x) => {
        const e = objeto(x);
        return { ...(txt(e.codigo, 40) ? { codigo: txt(e.codigo, 40)! } : {}), ...(txt(e.mensagem, 300) ? { mensagem: limparTexto(txt(e.mensagem, 300)!) } : {}), ...(txt(e.correcao, 300) ? { correcao: limparTexto(txt(e.correcao, 300)!) } : {}) };
      })
    : undefined;
  const url = (v: unknown) => {
    const t = txt(v, 600);
    return t && /^https:\/\//.test(t) ? t : undefined;
  };
  return {
    status: txt(o.status, 40) ?? 'desconhecido',
    ...(txt(o.ref, 60) ? { ref: txt(o.ref, 60)! } : {}),
    ...(o.numero !== undefined && o.numero !== null && String(o.numero).trim() ? { numero: String(o.numero).slice(0, 40) } : {}),
    ...(txt(o.codigo_verificacao, 60) ? { codigoVerificacao: txt(o.codigo_verificacao, 60)! } : {}),
    ...(txt(o.data_emissao, 40) ? { dataEmissao: txt(o.data_emissao, 40)! } : {}),
    ...(url(o.url) ? { urlConsulta: url(o.url)! } : {}),
    ...(url(o.url_danfse) ? { urlDanfse: url(o.url_danfse)! } : {}),
    ...(txt(o.caminho_xml_nota_fiscal, 400) ? { caminhoXml: txt(o.caminho_xml_nota_fiscal, 400)! } : {}),
    ...(txt(o.caminho_xml_cancelamento, 400) ? { caminhoXmlCancelamento: txt(o.caminho_xml_cancelamento, 400)! } : {}),
    ...(erros?.length ? { erros } : {}),
  };
}

export const REFERENCIA_VALIDA = /^[A-Za-z0-9]{1,50}$/;
function referenciaOuErro(ref: string): string {
  if (!REFERENCIA_VALIDA.test(ref)) throw new ErroFocus('referência inválida: a Focus aceita só letras e números (até 50)');
  return ref;
}

/** Consulta uma nota. `null` = a Focus não conhece a referência (404). */
export async function consultarNota(c: CredencialFocus, ref: string, o: OpcoesDeChamada = {}): Promise<NotaFocus | null> {
  const r = await ler(c, `/v2/nfsen/${referenciaOuErro(ref)}`, o);
  if (r.status === 404) return null;
  if (r.status !== 200) throw falhaDoStatus(r);
  if (!r.json || typeof r.json !== 'object') throw new ErroFocus('a Focus NFe respondeu em formato inesperado (não é JSON): pode ser um proxy ou uma mudança na API', r.status);
  return comoNota(r.json);
}

export interface EmissaoAceita {
  status: string;
  protocolo?: string;
}

/**
 * EMITE (POST /v2/nfsen?ref=). UMA tentativa, nunca repetida aqui. Lança ErroFocus: `status` 400/401/403/404/422/429 = a Focus RECUSOU e nada foi emitido; qualquer
 * outro (rede, timeout, 5xx, resposta que não é a esperada) = resultado INCERTO (o chamador confere por consulta antes de dizer qualquer coisa).
 */
export async function emitirNota(c: CredencialFocus, ref: string, corpo: Record<string, unknown>, o: OpcoesDeChamada = {}): Promise<EmissaoAceita> {
  const r = await umaChamada(c, 'POST', `/v2/nfsen?ref=${referenciaOuErro(ref)}`, corpo, o);
  if (r.status === 202 || r.status === 200 || r.status === 201) {
    const j = objeto(r.json);
    const status = txt(j.status, 40);
    // aceita de verdade só com o status de fila ou de autorizada; resposta sem isso é INCERTA (um proxy devolvendo 200 não emitiu nada)
    if (!status || !['processando_autorizacao', 'autorizado'].includes(status)) throw new ErroFocus('a Focus NFe respondeu à emissão em formato inesperado', null);
    return { status, ...(txt(j.protocolo, 80) ? { protocolo: txt(j.protocolo, 80)! } : {}) };
  }
  throw falhaDaEmissao(r);
}

/** 400/422 trazem `{codigo, mensagem}`; a mensagem (ex. "O campo … é obrigatório") é o que a pessoa precisa para corrigir. */
function falhaDaEmissao(r: Resposta): ErroFocus {
  const j = objeto(r.json);
  const mensagem = mensagemLimpa(j.mensagem, 300, r.token);
  if ((r.status === 400 || r.status === 422) && mensagem) return new ErroFocus(`a Focus NFe recusou o pedido: ${mensagem}`, r.status, txt(j.codigo, 60) ?? null);
  return falhaDoStatus(r);
}

export interface CancelamentoFocus {
  status: string;
  erros?: ErroDaNota[];
}

/** CANCELA (DELETE /v2/nfsen/{ref}, síncrono). UMA tentativa. `erro_cancelamento` volta como resultado (não lança): a nota continua valendo. */
export async function cancelarNota(c: CredencialFocus, ref: string, justificativa: string, o: OpcoesDeChamada = {}): Promise<CancelamentoFocus> {
  const r = await umaChamada(c, 'DELETE', `/v2/nfsen/${referenciaOuErro(ref)}`, { justificativa }, o);
  if (r.status !== 200) throw falhaDoStatus(r);
  const n = comoNota(r.json);
  if (n.status !== 'cancelado' && n.status !== 'erro_cancelamento') throw new ErroFocus(`a Focus NFe respondeu ao cancelamento com um status inesperado (${n.status.slice(0, 30)})`, 200);
  return { status: n.status, ...(n.erros ? { erros: n.erros } : {}) };
}

/** Prova o token sem criar nada: um GET de referência inexistente (404 = token aceito). Lança se a Focus o recusar (401/403). */
export async function testarToken(c: CredencialFocus, o: OpcoesDeChamada = {}): Promise<void> {
  const r = await ler(c, `/v2/nfsen/${REFERENCIA_DE_PROVA}`, o);
  if (r.status === 401 || r.status === 403) throw falhaDoStatus(r);
  if (r.status !== 404 && r.status !== 200) throw falhaDoStatus(r);
}

export interface GatilhoFocus {
  event?: string;
  /** só se a URL é nossa: a URL inteira tem o segredo e nunca sai */
  cnpj?: string;
  url: string;
}

/** Os gatilhos (webhooks) cadastrados para este token. A URL volta inteira SÓ para o conector comparar; quem chama não a mostra. */
export async function listarGatilhos(c: CredencialFocus, o: OpcoesDeChamada = {}): Promise<GatilhoFocus[]> {
  const r = await ler(c, '/v2/hooks', o);
  if (r.status !== 200) throw falhaDoStatus(r);
  if (!Array.isArray(r.json)) throw new ErroFocus('a Focus NFe respondeu à lista de gatilhos em formato inesperado', r.status);
  return r.json.map((x) => {
    const g = objeto(x);
    return { ...(txt(g.event, 40) ? { event: txt(g.event, 40)! } : {}), ...(txt(g.cnpj, 20) ? { cnpj: txt(g.cnpj, 20)! } : {}), url: txt(g.url, 600) ?? '' };
  });
}

export interface CadastroPublico {
  razaoSocial?: string;
  situacao?: string;
  optanteSimples?: boolean;
  optanteMei?: boolean;
  cnaePrincipal?: string;
  codigoIbge?: string;
  municipio?: string;
}

/** O cadastro público do CNPJ que a Focus oferece (`GET /v2/cnpjs/{cnpj}`): razão social, situação, Simples e município. Nada de pessoa física. */
export async function consultarCnpj(c: CredencialFocus, cnpj: string, o: OpcoesDeChamada = {}): Promise<CadastroPublico | null> {
  const d = soCnpj(cnpj);
  if (!d) throw new ErroFocus('CNPJ inválido');
  const r = await ler(c, `/v2/cnpjs/${d}`, o);
  if (r.status === 404) return null;
  if (r.status !== 200) throw falhaDoStatus(r);
  const j = objeto(r.json);
  const e = objeto(j.endereco);
  return {
    ...(txt(j.razao_social, 150) ? { razaoSocial: txt(j.razao_social, 150)! } : {}),
    ...(txt(j.situacao_cadastral, 40) ? { situacao: txt(j.situacao_cadastral, 40)! } : {}),
    ...(typeof j.optante_simples_nacional === 'boolean' ? { optanteSimples: j.optante_simples_nacional } : {}),
    ...(typeof j.optante_mei === 'boolean' ? { optanteMei: j.optante_mei } : {}),
    ...(txt(j.cnae_principal, 20) ? { cnaePrincipal: txt(j.cnae_principal, 20)! } : {}),
    ...(e.codigo_ibge !== undefined && /^\d{7}$/.test(String(e.codigo_ibge)) ? { codigoIbge: String(e.codigo_ibge) } : {}),
    ...(txt(e.nome_municipio, 80) ? { municipio: txt(e.nome_municipio, 80)! } : {}),
  };
}

/** O cadastro da EMPRESA na Focus (`GET /v2/empresas?cnpj=`): só os campos que dizem se ela pode emitir. Lista vazia/negada = o token não enxerga o cadastro (a API de Empresas pode ser só do token principal). */
export interface EmpresaFocus {
  habilitaNfsenHomologacao?: boolean;
  habilitaNfsenProducao?: boolean;
  inscricaoMunicipal?: string;
  regimeTributario?: string;
  certificadoValidoAte?: string;
  serieNfsenHomologacao?: number;
  serieNfsenProducao?: number;
  proximoNumeroNfsenHomologacao?: number;
  proximoNumeroNfsenProducao?: number;
}

export async function consultarEmpresa(c: CredencialFocus, cnpj: string, o: OpcoesDeChamada = {}): Promise<EmpresaFocus | null> {
  const d = soCnpj(cnpj);
  if (!d) throw new ErroFocus('CNPJ inválido');
  const r = await ler(c, `/v2/empresas?cnpj=${d}`, o);
  // a API de Empresas só existe em produção (a homologação responde 404) e o token da empresa pode não a enxergar
  if (r.status === 404) return null;
  if (r.status !== 200) throw falhaDoStatus(r);
  const primeira = Array.isArray(r.json) ? objeto(r.json[0]) : null;
  if (!primeira || !Object.keys(primeira).length) return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
  return {
    ...(typeof primeira.habilita_nfsen_homologacao === 'boolean' ? { habilitaNfsenHomologacao: primeira.habilita_nfsen_homologacao } : {}),
    ...(typeof primeira.habilita_nfsen_producao === 'boolean' ? { habilitaNfsenProducao: primeira.habilita_nfsen_producao } : {}),
    ...(txt(primeira.inscricao_municipal, 30) ? { inscricaoMunicipal: txt(primeira.inscricao_municipal, 30)! } : {}),
    ...(primeira.regime_tributario !== undefined && primeira.regime_tributario !== null ? { regimeTributario: String(primeira.regime_tributario).slice(0, 10) } : {}),
    ...(txt(primeira.certificado_valido_ate, 40) ? { certificadoValidoAte: txt(primeira.certificado_valido_ate, 40)! } : {}),
    ...(n(primeira.serie_nfsen_homologacao) !== undefined ? { serieNfsenHomologacao: n(primeira.serie_nfsen_homologacao)! } : {}),
    ...(n(primeira.serie_nfsen_producao) !== undefined ? { serieNfsenProducao: n(primeira.serie_nfsen_producao)! } : {}),
    ...(n(primeira.proximo_numero_nfsen_homologacao) !== undefined ? { proximoNumeroNfsenHomologacao: n(primeira.proximo_numero_nfsen_homologacao)! } : {}),
    ...(n(primeira.proximo_numero_nfsen_producao) !== undefined ? { proximoNumeroNfsenProducao: n(primeira.proximo_numero_nfsen_producao)! } : {}),
  };
}
