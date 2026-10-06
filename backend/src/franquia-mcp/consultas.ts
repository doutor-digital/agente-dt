/**
 * A lógica de cada ferramenta, sem nada de MCP: recebe argumentos já validados pelo zod e
 * devolve o objeto que vira a resposta. Separado do registro pra ser testado direto.
 */
import { ErroSpine } from './cliente.js';
import { type Contexto, type Cotas, comCache, conferirTamanho, porUnidade, resolverUnidades } from './contexto.js';
import type { Unidade } from './unidade.js';
import { diaLocal, normalizarItem } from './normalizar.js';
import { lerPagina, lerTudo } from './paginar.js';
import { OrcamentoEsgotado, TTL } from './ritmo.js';
import { ErroDeEntrada, type Fatia, LINHAS_POR_PAGINA, fatiarPeriodo, somarDias, validarData, validarTexto } from './travas.js';

type Alvo = string | string[];

export interface Saida {
  /** registros devolvidos por unidade. Padrão: 50 com uma unidade, 0 (só totais) com várias */
  maxItens?: number;
  /** campo pra contar os registros (ex. `statusName`); `"dia"` agrupa pelo dia local da data da consulta */
  agruparPor?: string;
}

const MAX_ITENS_PADRAO_UMA = 50;

function idDe(item: unknown, campoId: string | undefined): string | null {
  if (!campoId || !item || typeof item !== 'object') return null;
  const v = (item as Record<string, unknown>)[campoId];
  return v === undefined || v === null || v === '' ? null : String(v);
}

function contar(itens: unknown[], campo: string, chaveDe: (item: unknown) => unknown): Record<string, number> {
  const contagem: Record<string, number> = {};
  for (const item of itens) {
    const v = chaveDe(item);
    const chave = v === undefined || v === null || v === '' ? '(vazio)' : String(v);
    contagem[chave] = (contagem[chave] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(contagem).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

interface Lista {
  itens: unknown[];
  truncado: boolean;
  motivoTruncado?: string;
  semData?: number;
  totalInformado?: number | null;
}

/** Monta a saída de uma unidade: total, agrupamento e a fatia de itens pedida. */
function formatarLista(lista: Lista, saida: Saida, padraoItens: number, campoData?: string, fuso?: string) {
  const max = saida.maxItens ?? padraoItens;
  const r: Record<string, unknown> = { total: lista.itens.length };
  if (lista.totalInformado !== undefined) r.totalInformadoPelaFranquia = lista.totalInformado;
  if (lista.truncado) {
    r.truncado = true;
    r.aviso = `INCOMPLETO: ${lista.motivoTruncado ?? 'leitura interrompida'}. O total é um mínimo.`;
  }
  if (lista.semData) r.semData = lista.semData;
  if (saida.agruparPor) {
    const campo = saida.agruparPor;
    r.agrupado = contar(lista.itens, campo, (item) =>
      campo === 'dia' && campoData && fuso
        ? diaLocal((item as Record<string, unknown>)[campoData], fuso)
        : (item as Record<string, unknown>)?.[campo],
    );
  }
  r.itens = lista.itens.slice(0, max);
  if (lista.itens.length > max) r.itensOmitidos = lista.itens.length - max;
  return r;
}

/** Soma os totais (e agrupamentos) das unidades `ok`, dizendo quem ficou de fora. */
function totalDaRede(porUnidadeRes: Record<string, Record<string, unknown>>) {
  let total = 0;
  const agrupado: Record<string, number> = {};
  const somadas: string[] = [];
  const fora: string[] = [];
  const incompletas: string[] = [];
  for (const [slug, r] of Object.entries(porUnidadeRes)) {
    if (!r.ok) {
      fora.push(slug);
      continue;
    }
    somadas.push(slug);
    if (r.truncado) incompletas.push(slug);
    total += Number(r.total) || 0;
    for (const [k, v] of Object.entries((r.agrupado as Record<string, number>) ?? {})) agrupado[k] = (agrupado[k] ?? 0) + v;
  }
  const rede: Record<string, unknown> = { total, unidadesSomadas: somadas };
  if (Object.keys(agrupado).length) rede.agrupado = Object.fromEntries(Object.entries(agrupado).sort((a, b) => b[1] - a[1]));
  if (fora.length) rede.unidadesForaDoTotal = fora;
  if (incompletas.length) rede.unidadesIncompletas = incompletas;
  return rede;
}

function envelope(unidades: Unidade[], cotas: Cotas | null, porUnidadeRes: Record<string, Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  const r: Record<string, unknown> = { consultadoEm: new Date().toISOString(), ...extra };
  if (cotas) r.requisicoesFeitas = cotas.usadas;
  if (unidades.length > 1) r.rede = totalDaRede(porUnidadeRes);
  r.porUnidade = porUnidadeRes;
  return r;
}

function chaveCache(ferramenta: string, slug: string, args: object): string {
  return `${ferramenta}|${slug}|${JSON.stringify(args)}`;
}

// ───────────────────────── buscas com período ─────────────────────────

interface BuscaComPeriodo {
  ferramenta: string;
  caminho: string;
  /** campo de data de cada registro, usado pro corte pelo dia local */
  campoData: string;
  /** campo de id, usado pra não contar duas vezes o mesmo registro */
  campoId: string;
  /** nomes dos campos de período no corpo da requisição */
  campoInicio: string;
  campoFim: string;
}

/**
 * Lê um período de qualquer tamanho:
 *  1. quebra em fatias de até 90 dias (§9.3);
 *  2. pede cada fatia com o fim 2 dias depois. A agenda trata o fim como exclusivo, e não sabemos se
 *     a franquia corta pelo dia UTC ou pelo local (consulta às 22h de SP já é o dia seguinte em UTC);
 *  3. guarda só o que cai DENTRO da fatia pelo dia local da unidade. As sobras do item 2 são
 *     descartadas, e por isso duas fatias nunca contam o mesmo registro;
 *  4. tira repetidos pelo id, por garantia.
 */
async function lerPeriodo(
  b: BuscaComPeriodo,
  u: Unidade,
  chamar: (corpo: object) => Promise<unknown>,
  tetoPaginas: number,
  fatias: Fatia[] | null,
  filtros: Record<string, unknown>,
): Promise<Lista> {
  const itens: unknown[] = [];
  const vistos = new Set<string>();
  let truncado = false;
  let motivoTruncado: string | undefined;
  let semData = 0;

  for (const [i, fatia] of (fatias ?? [null]).entries()) {
    const periodo = fatia ? { [b.campoInicio]: fatia.inicio, [b.campoFim]: somarDias(fatia.fim, 2) } : {};
    let lidos;
    try {
      lidos = await lerTudo((page) => chamar({ ...filtros, ...periodo, pagination: { page, rowsPerPage: LINHAS_POR_PAGINA } }), tetoPaginas, LINHAS_POR_PAGINA);
    } catch (e) {
      if (e instanceof OrcamentoEsgotado && i > 0) {
        truncado = true;
        motivoTruncado = `${e.message}; leu até ${fatias?.[i - 1]?.fim}`;
        break;
      }
      throw e;
    }
    if (lidos.truncado) {
      truncado = true;
      motivoTruncado = lidos.motivoTruncado;
    }
    for (const bruto of lidos.itens) {
      const item = normalizarItem(bruto, u.fuso) as Record<string, unknown>;
      const dia = diaLocal(item?.[b.campoData], u.fuso);
      if (fatia && dia !== null && (dia < fatia.inicio || dia > fatia.fim)) continue;
      if (dia === null) {
        // sem data não dá pra saber de que fatia é: fica só a da 1ª, senão conta N vezes
        if (i > 0) continue;
        semData++;
      }
      const id = idDe(item, b.campoId);
      if (id !== null) {
        if (vistos.has(id)) continue;
        vistos.add(id);
      }
      itens.push(item);
    }
    if (truncado) break;
  }
  return { itens, truncado, motivoTruncado, semData };
}

async function buscarComPeriodo(
  ctx: Contexto,
  b: BuscaComPeriodo,
  args: { unidade: Alvo; inicio?: string; fim?: string } & Saida,
  filtros: Record<string, unknown>,
) {
  if ((args.inicio === undefined) !== (args.fim === undefined)) {
    throw new ErroDeEntrada('informe inicio E fim, ou nenhum dos dois');
  }
  const fatias = args.inicio && args.fim ? fatiarPeriodo(args.inicio, args.fim) : null;
  const unidades = resolverUnidades(ctx, args.unidade);
  const cotas = conferirTamanho(ctx, unidades.length, fatias?.length ?? 1);
  const padrao = unidades.length === 1 ? MAX_ITENS_PADRAO_UMA : 0;

  const res = await porUnidade(ctx, unidades, async (u, cliente) => {
    const orcamento = cotas.nova();
    const { valor, doCache } = await comCache(ctx, chaveCache(b.ferramenta, u.slug, { i: args.inicio, f: args.fim, filtros }), TTL.busca, () =>
      lerPeriodo(b, u, (corpo) => cliente.chamar('POST', b.caminho, corpo, orcamento), ctx.tetoPaginas, fatias, filtros),
    );
    return { ...formatarLista(valor, args, padrao, b.campoData, u.fuso), ...(doCache ? { doCache: true } : {}) };
  });
  return envelope(unidades, cotas, res, args.inicio ? { periodo: { inicio: args.inicio, fim: args.fim } } : {});
}

function semIndefinidos(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

export function buscarAgendamentos(
  ctx: Contexto,
  args: { unidade: Alvo; inicio: string; fim: string; nome?: string; idCategory?: number } & Saida,
) {
  return buscarComPeriodo(
    ctx,
    { ferramenta: 'agendamentos', caminho: '/api/schedules/search', campoData: 'dateAttendance', campoId: 'idSchedule', campoInicio: 'initialDate', campoFim: 'endDate' },
    args,
    semIndefinidos({ name: validarTexto(args.nome, 'nome'), idCategory: args.idCategory }),
  );
}

export function buscarTratamentos(
  ctx: Contexto,
  args: { unidade: Alvo; inicio: string; fim: string; nome?: string; idStatus?: number; idCategory?: number; idStaff?: number } & Saida,
) {
  return buscarComPeriodo(
    ctx,
    // filtros na RAIZ do corpo: dentro de `filters` a franquia ignora em silêncio (medido pelo agente)
    { ferramenta: 'tratamentos', caminho: '/api/treatments/search', campoData: 'created', campoId: 'idTreatment', campoInicio: 'initialCreatedDate', campoFim: 'endCreatedDate' },
    args,
    semIndefinidos({ name: validarTexto(args.nome, 'nome'), idStatus: args.idStatus, idCategory: args.idCategory, idStaff: args.idStaff }),
  );
}

export function buscarLeads(
  ctx: Contexto,
  args: { unidade: Alvo; inicio?: string; fim?: string; nome?: string; idSource?: number; idCategory?: number } & Saida,
) {
  return buscarComPeriodo(
    ctx,
    { ferramenta: 'leads', caminho: '/api/leads/search', campoData: 'created', campoId: 'idLead', campoInicio: 'initialDate', campoFim: 'endDate' },
    args,
    semIndefinidos({ name: validarTexto(args.nome, 'nome'), idSource: args.idSource, idCategory: args.idCategory }),
  );
}

// ───────────────────────── pacientes ─────────────────────────

export async function buscarPacientes(
  ctx: Contexto,
  args: { unidade: Alvo; nome?: string; idClient?: number; idStatus?: number; criadosDesde?: string } & Saida,
) {
  const filtros = semIndefinidos({ name: validarTexto(args.nome, 'nome'), idClient: args.idClient, idStatus: args.idStatus });
  if (args.criadosDesde !== undefined) validarData(args.criadosDesde, 'criadosDesde');
  const unidades = resolverUnidades(ctx, args.unidade);
  const cotas = conferirTamanho(ctx, unidades.length, 1);
  const padrao = unidades.length === 1 ? MAX_ITENS_PADRAO_UMA : 0;

  const res = await porUnidade(ctx, unidades, async (u, cliente) => {
    const orcamento = cotas.nova();
    // A franquia ordena por criação, mais novo primeiro (§6): com `criadosDesde`, a leitura para na
    // primeira página que já passou da data — o cadastro inteiro de uma unidade grande não cabe no teto.
    const antigo = (item: unknown) => {
      const dia = diaLocal((item as Record<string, unknown>)?.created, u.fuso);
      return !!args.criadosDesde && dia !== null && dia < args.criadosDesde;
    };
    const chave = chaveCache('pacientes', u.slug, { ...filtros, desde: args.criadosDesde });
    const { valor, doCache } = await comCache(ctx, chave, TTL.busca, async (): Promise<Lista> => {
      const lidos = await lerTudo(
        (page) => cliente.chamar('POST', '/api/clients/search', { ...filtros, pagination: { page, rowsPerPage: LINHAS_POR_PAGINA } }, orcamento),
        ctx.tetoPaginas,
        LINHAS_POR_PAGINA,
        args.criadosDesde ? (pagina) => pagina.length > 0 && antigo(pagina[pagina.length - 1]) : undefined,
      );
      return { ...lidos, itens: lidos.itens.filter((i) => !antigo(i)).map((i) => normalizarItem(i, u.fuso)) };
    });
    return { ...formatarLista(valor, args, padrao, 'created', u.fuso), ...(doCache ? { doCache: true } : {}) };
  });
  return envelope(unidades, cotas, res);
}

export async function pacientePorId(ctx: Contexto, args: { unidade: string; idClient: number }) {
  // o mesmo idClient existe em unidades diferentes, como pacientes diferentes: "todas" aqui seria chute
  const unidades = resolverUnidades(ctx, args.unidade);
  const u = unidades[0];
  if (unidades.length !== 1 || !u || args.unidade.trim().toLowerCase() === 'todas') {
    throw new ErroDeEntrada('paciente_por_id lê UMA unidade: o idClient é da unidade, não da rede');
  }
  const cliente = ctx.clientes.get(u.slug);
  const { valor } = await comCache(ctx, chaveCache('paciente', u.slug, { id: args.idClient }), TTL.busca, async () => {
    const resposta = (await cliente?.chamar('GET', `/api/clients/${args.idClient}`)) as Record<string, unknown> | undefined;
    // real: { data: { data: {...} } }; guia: { data: {...} }; não encontrado: { success: false, data: null }
    const meio = resposta?.data as Record<string, unknown> | null | undefined;
    const ficha = meio && typeof meio === 'object' && 'data' in meio ? meio.data : meio;
    if (!ficha || typeof ficha !== 'object') throw new ErroSpine(`paciente ${args.idClient} não encontrado em ${u.slug}`, 404);
    return { paciente: normalizarItem(ficha, u.fuso) as object };
  });
  return { consultadoEm: new Date().toISOString(), unidade: u.slug, ...valor };
}

// ───────────────────────── BI ─────────────────────────

interface FormatoBi {
  ferramenta: string;
  caminho: string;
  lista: string;
  nome: string;
}

export const BI = {
  leadsPorOrigem: { ferramenta: 'bi-origem', caminho: '/api/bi/leads/sources', lista: 'sources', nome: 'sourceName' },
  pacientesPorGenero: { ferramenta: 'bi-genero', caminho: '/api/bi/clients/gender', lista: 'genders', nome: 'genderName' },
  tratamentosPorCategoria: { ferramenta: 'bi-categoria', caminho: '/api/bi/treatments/categories', lista: 'categories', nome: 'categoryName' },
} satisfies Record<string, FormatoBi>;

/** O `data` do BI: `{ data: { sources, total } }` (guia) ou um nível a mais (como as buscas reais). */
function corpoBi(resposta: unknown, f: FormatoBi): Record<string, unknown> {
  const meio = (resposta as Record<string, unknown> | null)?.data as Record<string, unknown> | undefined;
  for (const candidato of [meio, meio?.data as Record<string, unknown> | undefined]) {
    if (candidato && Array.isArray(candidato[f.lista])) return candidato;
  }
  throw new ErroSpine(`a franquia respondeu o BI sem a lista "${f.lista}" — formato desconhecido`);
}

/**
 * BI por período: uma chamada por fatia de 90 dias, somando por nome. A idade média (gênero) é
 * ponderada pelo total de cada fatia, porque média de médias erra.
 */
export async function bi(ctx: Contexto, f: FormatoBi, args: { unidade: Alvo; inicio: string; fim: string }) {
  validarData(args.inicio, 'inicio');
  validarData(args.fim, 'fim');
  const fatias = fatiarPeriodo(args.inicio, args.fim);
  const unidades = resolverUnidades(ctx, args.unidade);
  const cotas = conferirTamanho(ctx, unidades.length, fatias.length);

  const res = await porUnidade(ctx, unidades, async (u, cliente) => {
    const orcamento = cotas.nova();
    const { valor, doCache } = await comCache(ctx, chaveCache(f.ferramenta, u.slug, { i: args.inicio, f: args.fim }), TTL.bi, async () => {
      const grupos: Record<string, number> = {};
      let total = 0;
      let somaIdade = 0;
      let pesoIdade = 0;
      for (const fatia of fatias) {
        const corpo = corpoBi(
          await cliente.chamar('POST', f.caminho, { initialDate: fatia.inicio, endDate: fatia.fim }, orcamento),
          f,
        );
        let totalFatia = 0;
        for (const g of corpo[f.lista] as Array<Record<string, unknown>>) {
          const nome = String(g[f.nome] ?? g.gender ?? '(sem nome)');
          const n = Number(g.total) || 0;
          grupos[nome] = (grupos[nome] ?? 0) + n;
          totalFatia += n;
        }
        const totalInformado = Number(corpo.total);
        const t = Number.isFinite(totalInformado) ? totalInformado : totalFatia;
        total += t;
        const idade = Number(corpo.averageAge);
        if (Number.isFinite(idade) && t > 0) {
          somaIdade += idade * t;
          pesoIdade += t;
        }
      }
      const r: Record<string, unknown> = {
        total,
        agrupado: Object.fromEntries(Object.entries(grupos).sort((a, b) => b[1] - a[1])),
        fatias: fatias.length,
      };
      if (pesoIdade > 0) r.idadeMedia = Math.round((somaIdade / pesoIdade) * 10) / 10;
      if (fatias.length > 1) {
        // NÃO VERIFICADO na API real (o BI dá 403 na maioria dos tokens): o guia não diz se o endDate
        // do BI é incluso. Se for exclusivo, o último dia de cada fatia fica de fora; não dá pra
        // compensar como nas buscas, porque o BI já vem somado e não tem como cortar a sobra.
        r.aviso = `período somado em ${fatias.length} fatias; se o fim do BI for exclusivo na franquia, ${fatias.length - 1} dia(s) de fronteira podem faltar`;
      }
      return r;
    });
    return { ...valor, ...(doCache ? { doCache: true } : {}) };
  });
  return envelope(unidades, cotas, res, { periodo: { inicio: args.inicio, fim: args.fim } });
}

// ───────────────────────── dados gerais e conexão ─────────────────────────

export const LISTAS_GERAIS = [
  'accounts',
  'accounts-payable/categories',
  'accounts-payable/status',
  'forms-payments',
  'leads/categories',
  'professions',
  'providers',
  'schedules/categories',
  'sources',
  'treatments/categories',
  'treatments/degrees',
  'treatments/locals',
  'treatments/status',
  'treatments/types',
] as const;

export async function dadosGerais(ctx: Contexto, args: { unidade: Alvo; lista: (typeof LISTAS_GERAIS)[number] }) {
  const unidades = resolverUnidades(ctx, args.unidade);
  const cotas = conferirTamanho(ctx, unidades.length, 1);
  const res = await porUnidade(ctx, unidades, async (u, cliente) => {
    const orcamento = cotas.nova();
    const { valor, doCache } = await comCache(ctx, chaveCache('geral', u.slug, { l: args.lista }), TTL.dadosGerais, async () => {
      const resposta = await cliente.chamar('GET', `/api/general/${args.lista}`, undefined, orcamento);
      const { itens } = lerPagina(resposta);
      return { total: itens.length, itens };
    });
    return { ...valor, ...(doCache ? { doCache: true } : {}) };
  });
  // dados gerais são cadastro, não contagem: somar entre unidades não significa nada
  return { consultadoEm: new Date().toISOString(), lista: args.lista, porUnidade: res };
}

export function listarUnidades(ctx: Contexto) {
  return {
    unidades: [...ctx.unidades.values()].map((u) => ({ slug: u.slug, nome: u.nome, fuso: u.fuso, baseUrl: u.baseUrl })),
  };
}

/**
 * Testa o token de cada unidade com a busca mínima do guia (§4: clients/search, 1 linha) e lê a
 * versão da API. Mostra também quantas chamadas este MCP já fez desde que subiu.
 */
export async function checarConexao(ctx: Contexto, args: { unidade: Alvo }) {
  const unidades = resolverUnidades(ctx, args.unidade);
  const cotas = conferirTamanho(ctx, unidades.length, 1);
  const versoes: Record<string, string> = {};
  const orcamentoVersao = cotas.nova();
  for (const baseUrl of new Set(unidades.map((u) => u.baseUrl))) {
    const u = unidades.find((x) => x.baseUrl === baseUrl) as Unidade;
    try {
      const v = (await ctx.clientes.get(u.slug)?.chamar('GET', '/version', undefined, orcamentoVersao)) as { version?: unknown };
      versoes[baseUrl] = String(v?.version ?? '?');
    } catch (e) {
      versoes[baseUrl] = `erro: ${(e as Error).message}`;
    }
  }
  const res = await porUnidade(ctx, unidades, async (_u, cliente) => {
    const orcamento = cotas.nova();
    const resposta = await cliente.chamar('POST', '/api/clients/search', { pagination: { page: 1, rowsPerPage: 1 } }, orcamento);
    return { token: 'ok', pacientesNaFranquia: lerPagina(resposta).total };
  });
  return { consultadoEm: new Date().toISOString(), versaoDaApi: versoes, porUnidade: res, consumoDesteMcp: ctx.contador.resumo() };
}
