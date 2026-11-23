/**
 * Nota fiscal de serviço (NFS-e) do Asaas no conector — a LEITURA: listar as notas de uma clínica, ver uma nota completa e saber se a
 * clínica tem dado fiscal cadastrado (e quais serviços municipais ela pode usar). Mesma regra de acesso das outras leituras `asaas_*`:
 * só GET, só nas clínicas com a chave do Asaas no painel de integrações. Emitir e cancelar estão em `asaas-notas-escrita.ts`, em
 * DOIS passos (preparar → confirmar).
 *
 * Campos e filtros conferidos na documentação oficial (docs.asaas.com, 23/11/2026): GET /v3/invoices (filtros `effectiveDate[Ge]`,
 * `effectiveDate[Le]`, `payment`, `customer`, `status`, `externalReference`), GET /v3/invoices/{id}, GET /v3/fiscalInfo/ (404 = a conta
 * não tem informações fiscais), GET /v3/fiscalInfo/services (400 "não está habilitado" = prefeitura sem lista / Portal Nacional) e
 * GET /v3/fiscalInfo/municipalOptions (`supportsCancellation`).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada, validarData } from '../franquia-mcp/travas.js';
import { mascararDoc } from './asaas-limites.js';
import { paginar, resolverContasAsaas, type ContaAsaas, type ContextoAsaas } from './asaas.js';
import { executar } from './ferramenta.js';

export const STATUS_NOTA: Record<string, string> = {
  SCHEDULED: 'agendada (ainda não emitida)',
  SYNCHRONIZED: 'enviada à prefeitura',
  AUTHORIZED: 'emitida',
  PROCESSING_CANCELLATION: 'cancelamento em processamento (a prefeitura ainda vai responder)',
  CANCELED: 'cancelada',
  CANCELLATION_DENIED: 'cancelamento NEGADO pela prefeitura (a nota continua valendo)',
  ERROR: 'erro na emissão',
};
/** Os status do filtro da listagem: os da referência da API mais SYNCHRONIZED ("enviada à prefeitura"), que o guia de notas lista e a nota assume enquanto espera a autorização. */
export const STATUS_DO_FILTRO = ['SCHEDULED', 'SYNCHRONIZED', 'AUTHORIZED', 'PROCESSING_CANCELLATION', 'CANCELED', 'CANCELLATION_DENIED', 'ERROR'] as const;
/**
 * A nota ainda vale (ou vai valer) para o fisco? Tudo que não é CANCELED nem ERROR: agendada, enviada, emitida, cancelando e cancelamento NEGADO
 * (a nota continua valendo). Lista invertida de propósito: um status que o Asaas criar amanhã conta como ativo, e o aviso de nota repetida não some.
 */
export const notaVale = (status: string | undefined): boolean => status !== 'CANCELED' && status !== 'ERROR';

export interface NotaAsaas {
  id: string;
  status?: string;
  statusDescription?: string | null;
  customer?: string;
  payment?: string | null;
  installment?: string | null;
  value?: number;
  deductions?: number;
  effectiveDate?: string;
  serviceDescription?: string | null;
  observations?: string | null;
  externalReference?: string | null;
  number?: string | null;
  rpsSerie?: string | null;
  rpsNumber?: string | null;
  validationCode?: string | null;
  pdfUrl?: string | null;
  xmlUrl?: string | null;
  municipalServiceId?: string | null;
  municipalServiceCode?: string | null;
  municipalServiceName?: string | null;
  estimatedTaxesDescription?: string | null;
  taxes?: Record<string, unknown> | null;
}

const reais = (n: number) => Math.round(n * 100) / 100;
const httpStatus = (e: unknown) => (e as { status?: number | null })?.status;
export const ID_NOTA = /^inv_[A-Za-z0-9]{6,40}$/;

export function idDaNota(v: unknown): string {
  const id = String(v ?? '').trim();
  if (!ID_NOTA.test(id)) throw new ErroDeEntrada('notaId inválido (esperado algo como inv_000000000232; veja o id em asaas_notas)');
  return id;
}

export function umaContaDeNota(ctx: ContextoAsaas, unidade: string): ContaAsaas {
  if (unidade.trim().toLowerCase() === 'todas' || /[,;]/.test(unidade)) throw new ErroDeEntrada('informe UMA clínica: nota fiscal é de uma conta só');
  return resolverContasAsaas(ctx, unidade)[0]!;
}

// ----------------------------------------------------------------- dados fiscais e serviços municipais

export const SEM_DADO_FISCAL =
  'Esta clínica AINDA NÃO tem informações fiscais cadastradas no Asaas (o Asaas respondeu "não existe"), então não dá para emitir nota. ' +
  'Quem cadastra é a clínica, no painel do Asaas (Configurações > Informações fiscais: inscrição municipal, regime, acesso à prefeitura). Este conector não cadastra dado fiscal. Nada foi feito.';

export interface DadosFiscais {
  simplesNacional: boolean | null;
  regimeEspecial: string | null;
  cnae: string | null;
  itemDaListaDeServico: string | null;
  inscricaoMunicipalCadastrada: boolean;
  cidadePadraoDaPrestacao: string | null;
  regimeDeApuracaoPortalNacional: string | null;
  acessoDaPrefeitura: { certificado: boolean; senha: boolean; token: boolean };
}

/** `null` = o Asaas respondeu 404: a conta não tem informações fiscais. Usuário, e-mail e inscrição municipal NÃO saem daqui. */
export async function lerDadosFiscais(c: ContaAsaas): Promise<DadosFiscais | null> {
  let x: Record<string, any> | null;
  try {
    // o endereço é o da documentação oficial, com a barra no fim
    x = await c.fonte.get<Record<string, any>>('/fiscalInfo/');
  } catch (e) {
    if (httpStatus(e) === 404) return null;
    throw e;
  }
  if (!x || typeof x !== 'object') return null;
  return {
    simplesNacional: typeof x.simplesNacional === 'boolean' ? x.simplesNacional : null,
    regimeEspecial: x.specialTaxRegime ? String(x.specialTaxRegime) : null,
    cnae: x.cnae ? String(x.cnae) : null,
    itemDaListaDeServico: x.serviceListItem ? String(x.serviceListItem) : null,
    inscricaoMunicipalCadastrada: !!x.municipalInscription,
    cidadePadraoDaPrestacao: x.serviceProvisionCityDefaultType ? String(x.serviceProvisionCityDefaultType) : null,
    regimeDeApuracaoPortalNacional: x.nationalPortalTaxCalculationRegime ? String(x.nationalPortalTaxCalculationRegime) : null,
    acessoDaPrefeitura: { certificado: x.certificateSent === true, senha: x.passwordSent === true, token: x.accessTokenSent === true },
  };
}

export interface ServicoMunicipal {
  id: string;
  descricao: string;
  /** alíquota de ISS (%) cadastrada na prefeitura para este serviço */
  iss: number | null;
}

/** O código do serviço está no começo da descrição: "4.01 - Medicina e biomedicina". */
export const codigoDoServico = (descricao: string) => descricao.match(/^\s*(\d+(?:\.\d+)*)\s*-/)?.[1] ?? null;

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();

function paraServico(x: { id?: unknown; description?: unknown; issTax?: unknown }): ServicoMunicipal {
  return { id: String(x.id), descricao: String(x.description ?? ''), iss: typeof x.issTax === 'number' ? x.issTax : null };
}

export const SEM_LISTA_DE_SERVICOS =
  'A prefeitura (ou o Portal Nacional) desta conta não oferece a lista de serviços municipais pela API. Para emitir, informe o CÓDIGO do serviço (ex. 4.01), que vem da prefeitura ou da contabilidade.';

export type ListaDeServicos = { disponivel: true; servicos: ServicoMunicipal[]; total: number | null; truncado: boolean } | { disponivel: false; motivo: string };

/** Uma página (até 100) de serviços municipais, com filtro opcional pelo nome. 400 do Asaas = sem lista (prefeitura / Portal Nacional). */
export async function listarServicos(c: ContaAsaas, busca?: string, limite = 100): Promise<ListaDeServicos> {
  try {
    const r = await c.fonte.get<{ data?: Array<{ id?: unknown; description?: unknown; issTax?: unknown }>; hasMore?: boolean; totalCount?: number }>('/fiscalInfo/services', {
      ...(busca?.trim() ? { description: busca.trim() } : {}),
      offset: 0,
      limit: Math.min(100, limite),
    });
    return { disponivel: true, servicos: (r?.data ?? []).map(paraServico), total: typeof r?.totalCount === 'number' ? r.totalCount : null, truncado: !!r?.hasMore };
  } catch (e) {
    // o Asaas responde 400 "O código de serviços municipais não está habilitado para esta conta" quando não há lista; outro 400 (parâmetro ruim) é erro de verdade
    if (httpStatus(e) === 400 && /habilitad|dispon[ií]vel|indispon/i.test(e instanceof Error ? e.message : '')) return { disponivel: false, motivo: SEM_LISTA_DE_SERVICOS };
    throw e;
  }
}

/** A prefeitura aceita cancelar a nota pela integração? `null` = não deu para saber (a leitura falhou). */
export async function prefeituraCancelaPelaApi(c: ContaAsaas): Promise<boolean | null> {
  try {
    const r = await c.fonte.get<{ supportsCancellation?: boolean }>('/fiscalInfo/municipalOptions');
    return typeof r?.supportsCancellation === 'boolean' ? r.supportsCancellation : null;
  } catch (e) {
    if (httpStatus(e) === 401) throw e;
    return null;
  }
}

/**
 * O serviço pedido (id, código ou parte do nome) → UM serviço da lista da prefeitura. Nenhum ou vários: recusa e mostra as opções, nunca escolhe.
 * `null` quando a prefeitura não tem lista (aí o código vai à mão, em `municipalServiceCode`).
 */
export async function acharServicoMunicipal(ctx: ContextoAsaas, c: ContaAsaas, pedido: string): Promise<ServicoMunicipal | null> {
  const p = pedido.trim();
  if (!p) throw new ErroDeEntrada('informe o serviço municipal (id, código ou parte do nome; veja asaas_dados_fiscais)');
  const porNome = await listarServicos(c, p);
  if (!porNome.disponivel) return null;
  const certos = (xs: ServicoMunicipal[]) => {
    const exatos = xs.filter((s) => s.id === p || codigoDoServico(s.descricao) === p);
    if (exatos.length === 1) return exatos;
    const lista = exatos.length ? exatos : xs.filter((s) => norm(s.descricao).includes(norm(p)));
    return lista;
  };
  let achados = certos(porNome.servicos);
  // o id numérico não aparece na descrição: o filtro por nome não acha; varre a lista inteira (com teto)
  if (!achados.length && /^\d+$/.test(p)) {
    const todos = await paginar<{ id?: unknown; description?: unknown; issTax?: unknown }>(ctx, c, '/fiscalInfo/services', {});
    achados = certos(todos.itens.map(paraServico));
  }
  if (achados.length === 1) return achados[0]!;
  const opcoes = (achados.length ? achados : (await listarServicos(c, undefined, 25).then((r) => (r.disponivel ? r.servicos : [])))).slice(0, 25).map((s) => `${s.id}: ${s.descricao}`).join(' | ');
  throw new ErroDeEntrada(`serviço municipal "${p}" ${achados.length > 1 ? 'é ambíguo (vários servem)' : 'não existe na lista desta prefeitura'}. Opções: ${opcoes || '(a lista veio vazia)'}. Nada foi preparado.`);
}

export async function asaasDadosFiscais(ctx: ContextoAsaas, a: { unidade: string; servico?: string; maxServicos?: number }) {
  const c = umaContaDeNota(ctx, a.unidade);
  const dados = await lerDadosFiscais(c);
  if (!dados) return { unidade: c.slug, dadosFiscaisCadastrados: false, podeEmitirNota: false, motivo: SEM_DADO_FISCAL };
  const lista = await listarServicos(c, a.servico, a.maxServicos ?? 50);
  const cancela = await prefeituraCancelaPelaApi(c);
  const semAcesso = !dados.acessoDaPrefeitura.certificado && !dados.acessoDaPrefeitura.senha && !dados.acessoDaPrefeitura.token;
  return {
    unidade: c.slug,
    dadosFiscaisCadastrados: true,
    // "pode emitir" aqui é só o que o Asaas deixa ver: a prefeitura é quem aceita a nota de fato
    podeEmitirNota: true,
    ...(semAcesso ? { atencao: 'nenhum acesso à prefeitura (certificado, senha ou token) consta como enviado: o Asaas pode recusar a emissão. Confira no painel do Asaas.' } : {}),
    dados,
    prefeituraAceitaCancelarPelaIntegracao: cancela,
    servicosMunicipais: lista.disponivel
      ? { disponivel: true, total: lista.total, haMais: lista.truncado, servicos: lista.servicos.map((s) => ({ id: s.id, descricao: s.descricao, issPercentual: s.iss })) }
      : { disponivel: false, motivo: lista.motivo },
  };
}

// ----------------------------------------------------------------- notas

const FILTROS_DA_LISTA = ['inicio', 'fim', 'status', 'cobrancaId', 'clienteId', 'referencia'] as const;

/** O nome de cada tomador (cliente do Asaas), uma leitura por cliente e no máximo `teto`, em lotes de 6 (o ritmo da conta é do `asaasGet`); quem falhar fica sem nome. */
async function nomesDosClientes(c: ContaAsaas, ids: string[], teto = 30): Promise<Map<string, string | null>> {
  const nomes = new Map<string, string | null>();
  const unicos = [...new Set(ids.filter(Boolean))].slice(0, teto);
  for (let i = 0; i < unicos.length; i += 6) {
    await Promise.all(
      unicos.slice(i, i + 6).map(async (id) => {
        try {
          nomes.set(id, (await c.fonte.get<{ name?: string }>(`/customers/${id}`))?.name ?? null);
        } catch (e) {
          if (httpStatus(e) === 401) throw e;
          nomes.set(id, null);
        }
      }),
    );
  }
  return nomes;
}

const curto = (t: string | null | undefined, max: number) => (t && t.length > max ? `${t.slice(0, max - 1)}…` : (t ?? null));

export function mostrarNota(n: NotaAsaas, tomador: string | null | undefined, completa: boolean) {
  const status = STATUS_NOTA[n.status ?? ''] ?? n.status ?? null;
  return {
    id: n.id,
    numero: n.number ?? null,
    status,
    statusDoAsaas: n.status ?? null,
    ...(n.statusDescription ? { motivoDoStatus: n.statusDescription } : {}),
    valor: n.value ?? null,
    deducoes: n.deductions ?? 0,
    dataDeEmissao: n.effectiveDate ?? null,
    tomador: { id: n.customer ?? null, nome: tomador ?? null },
    cobranca: n.payment ?? null,
    parcelamento: n.installment ?? null,
    referencia: n.externalReference ?? null,
    descricao: completa ? (n.serviceDescription ?? null) : curto(n.serviceDescription, 120),
    servico: { id: n.municipalServiceId ?? null, codigo: n.municipalServiceCode ?? null, nome: n.municipalServiceName ?? null },
    pdf: n.pdfUrl ?? null,
    xml: n.xmlUrl ?? null,
    ...(completa
      ? {
          observacoes: n.observations ?? null,
          rps: { serie: n.rpsSerie ?? null, numero: n.rpsNumber ?? null },
          codigoDeVerificacao: n.validationCode ?? null,
          impostos: n.taxes ?? null,
          impostosEstimados: n.estimatedTaxesDescription ?? null,
        }
      : {}),
  };
}

export async function asaasNotas(
  ctx: ContextoAsaas,
  a: { unidade: string; inicio?: string; fim?: string; status?: string; cobrancaId?: string; clienteId?: string; referencia?: string; maxItens?: number },
) {
  const c = umaContaDeNota(ctx, a.unidade);
  if (!FILTROS_DA_LISTA.some((k) => a[k] !== undefined && a[k] !== '')) {
    throw new ErroDeEntrada('informe pelo menos um filtro: período (inicio/fim, pela data de emissão), status, cobrancaId, clienteId ou referencia');
  }
  if (a.inicio) validarData(a.inicio, 'inicio');
  if (a.fim) validarData(a.fim, 'fim');
  if (a.inicio && a.fim && a.fim < a.inicio) throw new ErroDeEntrada('fim antes do início');
  if (a.status && !(STATUS_DO_FILTRO as readonly string[]).includes(a.status)) throw new ErroDeEntrada(`status "${a.status}" não existe: use ${STATUS_DO_FILTRO.join(', ')}`);
  if (a.cobrancaId && !/^pay_[A-Za-z0-9]{6,40}$/.test(a.cobrancaId.trim())) throw new ErroDeEntrada('cobrancaId inválido (esperado algo como pay_080225913252)');
  if (a.clienteId && !/^cus_[A-Za-z0-9]{6,40}$/.test(a.clienteId.trim())) throw new ErroDeEntrada('clienteId inválido (esperado algo como cus_000005401844)');
  const q = {
    ...(a.inicio ? { 'effectiveDate[Ge]': a.inicio } : {}),
    ...(a.fim ? { 'effectiveDate[Le]': a.fim } : {}),
    ...(a.status ? { status: a.status } : {}),
    ...(a.cobrancaId ? { payment: a.cobrancaId.trim() } : {}),
    ...(a.clienteId ? { customer: a.clienteId.trim() } : {}),
    ...(a.referencia ? { externalReference: a.referencia.trim() } : {}),
  };
  // nota muda de status sozinha (a prefeitura responde depois): leitura sem cache
  const lidas = await paginar<NotaAsaas>(ctx, c, '/invoices', q);
  const truncado = lidas.truncado;
  // o período também é conferido aqui: se o Asaas ignorasse o filtro de data, o total não pode sair de outro mês
  const itens = lidas.itens.filter((n) => !n.effectiveDate || ((!a.inicio || n.effectiveDate >= a.inicio) && (!a.fim || n.effectiveDate <= a.fim)));
  const max = a.maxItens ?? 30;
  const mostradas = itens.slice(0, max);
  const nomes = await nomesDosClientes(c, mostradas.map((n) => n.customer ?? ''));
  const porStatus: Record<string, { quantidade: number; valor: number }> = {};
  for (const n of itens) {
    const o = (porStatus[STATUS_NOTA[n.status ?? ''] ?? n.status ?? '(sem status)'] ??= { quantidade: 0, valor: 0 });
    o.quantidade += 1;
    o.valor = reais(o.valor + (Number(n.value) || 0));
  }
  return {
    unidade: c.slug,
    filtros: a.maxItens === undefined ? { ...q } : { ...q, maxItens: a.maxItens },
    notas: itens.length,
    valor: reais(itens.reduce((s, n) => s + (Number(n.value) || 0), 0)),
    porStatus,
    truncado,
    ...(itens.length === 0 ? { aviso: 'nenhuma nota com esses filtros. Se a clínica nunca emitiu, veja asaas_dados_fiscais para saber se ela pode emitir.' } : {}),
    itens: mostradas.map((n) => mostrarNota(n, nomes.get(n.customer ?? ''), false)),
  };
}

export async function asaasNota(ctx: ContextoAsaas, a: { unidade: string; notaId: string }) {
  const c = umaContaDeNota(ctx, a.unidade);
  const id = idDaNota(a.notaId);
  let n: NotaAsaas | null;
  try {
    n = await c.fonte.get<NotaAsaas>(`/invoices/${id}`);
  } catch (e) {
    if (httpStatus(e) === 404) throw new ErroDeEntrada(`a nota ${id} não existe nesta conta do Asaas`);
    throw e;
  }
  if (!n?.id) throw new ErroDeEntrada(`a nota ${id} não existe nesta conta do Asaas`);
  let tomador: { id: string; nome: string | null; documento: string | null } | null = null;
  if (n.customer) {
    try {
      const x = await c.fonte.get<{ name?: string; cpfCnpj?: string }>(`/customers/${n.customer}`);
      tomador = { id: n.customer, nome: x?.name ?? null, documento: x?.cpfCnpj ? mascararDoc(x.cpfCnpj) : null };
    } catch (e) {
      if (httpStatus(e) === 401) throw e;
      tomador = { id: n.customer, nome: null, documento: null };
    }
  }
  const m = mostrarNota(n, tomador?.nome, true);
  return { unidade: c.slug, nota: { ...m, tomador: tomador ?? m.tomador } };
}

// ----------------------------------------------------------------- ferramentas (leitura)

const umaUnidade = z.string().min(1).describe('UMA clínica: slug ou nome curto ("serra")');
const data = (o: string) => z.string().optional().describe(`${o}, AAAA-MM-DD`);

/** As três leituras de nota fiscal. Ligadas para quem tem o Asaas, como as outras `asaas_*` de leitura. */
export function registrarLeituraNotasAsaas(server: McpServer, ctx: ContextoAsaas, auditar?: Auditar): void {
  server.registerTool(
    'asaas_notas',
    {
      title: 'Notas fiscais de serviço (Asaas)',
      description:
        'Notas fiscais de serviço (NFS-e) do Asaas de UMA clínica, com filtro por período (data de EMISSÃO), status, cobrança (pay_…), cliente (cus_…) ou referência. ' +
        'Devolve número, status em português, valor, data, tomador, descrição curta e os links do PDF e do XML quando a nota já foi emitida; mais o total por status. ' +
        'É preciso ao menos um filtro. Status: SCHEDULED (agendada), SYNCHRONIZED (enviada à prefeitura), AUTHORIZED (emitida), PROCESSING_CANCELLATION, CANCELED, CANCELLATION_DENIED, ERROR. ' +
        'Para saber se a clínica PODE emitir, use asaas_dados_fiscais. Só leitura: emitir e cancelar são asaas_preparar_nota → asaas_confirmar_nota.',
      inputSchema: {
        unidade: umaUnidade,
        inicio: data('início do período de emissão'),
        fim: data('fim do período de emissão'),
        status: z.enum(STATUS_DO_FILTRO).optional(),
        cobrancaId: z.string().optional().describe('notas desta cobrança (pay_…)'),
        clienteId: z.string().optional().describe('notas deste cliente/tomador (cus_…)'),
        referencia: z.string().optional().describe('externalReference da nota'),
        maxItens: z.number().int().min(0).max(100).optional().describe('notas detalhadas na resposta (padrão 30); o total e o resumo por status contam todas'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executar('asaas_notas', args, auditar, () => asaasNotas(ctx, args)),
  );
  server.registerTool(
    'asaas_nota',
    {
      title: 'Uma nota fiscal (Asaas)',
      description:
        'Uma nota fiscal de serviço pelo id (inv_…), completa: número, status e o motivo (se deu erro), valor, deduções, data, tomador, serviço municipal, descrição, observações, ' +
        'impostos e retenções, RPS, código de verificação e os links do PDF e do XML. Use para conferir o resultado depois de emitir ou cancelar.',
      inputSchema: { unidade: umaUnidade, notaId: z.string().min(4).describe('inv_…') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executar('asaas_nota', args, auditar, () => asaasNota(ctx, args)),
  );
  server.registerTool(
    'asaas_dados_fiscais',
    {
      title: 'Dados fiscais e serviços municipais (Asaas)',
      description:
        'Diz se a clínica TEM informações fiscais cadastradas no Asaas (sem elas não emite nota): regime (Simples Nacional), CNAE, cidade da prestação, se há acesso à prefeitura, ' +
        'se a prefeitura aceita cancelar pela integração, e a lista de serviços municipais (id, descrição e alíquota de ISS) que a clínica pode usar na nota. "servico" filtra a lista pelo nome. ' +
        'Se a prefeitura não tem lista (Portal Nacional), avisa: aí o código do serviço é informado à mão. Não mostra usuário nem senha da prefeitura. Consulte antes de asaas_preparar_nota.',
      inputSchema: { unidade: umaUnidade, servico: z.string().optional().describe('parte do nome ou código do serviço, para filtrar a lista'), maxServicos: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executar('asaas_dados_fiscais', args, auditar, () => asaasDadosFiscais(ctx, args)),
  );
}
