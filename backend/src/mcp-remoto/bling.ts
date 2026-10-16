/**
 * Bling (ERP) no conector: pedidos de venda, contas a receber, notas e contatos das empresas com o Bling
 * conectado (hoje a HM Tecnologia), e o relatório de vendas que cruza os leads do Kommo com os pedidos.
 *
 * A fonte é injetada (`FonteBling`): em produção é o `blingGet` do agente (fila de 3 req/s por conta,
 * renovação do token); nos testes, um falso. Só leitura.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { KommoLead } from '../services/kommo.service.js';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { Cache, TTL } from '../franquia-mcp/ritmo.js';
import { ErroDeEntrada, validarData } from '../franquia-mcp/travas.js';
import { executar } from './ferramenta.js';
import { chaveTelefone } from './funil.js';
import { leadsDoPeriodo, origemDoLead, resolverUnidadesKommo, telefonesDosLeads, type ContextoKommo } from './kommo.js';
import { acharSlug } from './unidades.js';

export interface FonteBling {
  get<T>(caminho: string, query?: Record<string, string | number | undefined>): Promise<T>;
}

export interface ContaBling {
  slug: string;
  nome: string;
  fonte: FonteBling;
}

export interface ContextoBling {
  contas: Map<string, ContaBling>;
  cache: Cache;
  /** páginas de 100 por consulta (o Bling limita a conta a 3 req/s) */
  maxPaginas: number;
  /** contatos lidos um a um no relatório de vendas (para o telefone) */
  maxContatos: number;
}

export function criarContextoBling(contas: Map<string, ContaBling>, op: { maxPaginas?: number; maxContatos?: number; agora?: () => number } = {}): ContextoBling {
  return { contas, cache: new Cache(op.agora), maxPaginas: op.maxPaginas ?? 20, maxContatos: op.maxContatos ?? 200 };
}

export function resolverContaBling(ctx: ContextoBling, pedido: string): ContaBling {
  if (ctx.contas.size === 0) throw new ErroDeEntrada('nenhuma empresa com o Bling conectado agora (carregando). Tente em instantes.');
  const slug = acharSlug(ctx.contas.keys(), pedido);
  if (!slug) throw new ErroDeEntrada(`empresa sem Bling, desconhecida ou ambígua: ${pedido}. Com Bling: ${[...ctx.contas.keys()].join(', ')}`);
  return ctx.contas.get(slug) as ContaBling;
}

async function comCache<T>(ctx: ContextoBling, chave: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const g = ctx.cache.pegar<T>(chave);
  if (g !== undefined) return g;
  const v = await fn();
  if (!(v as { truncado?: unknown })?.truncado) ctx.cache.guardar(chave, v, ttl);
  return v;
}

/** Todas as páginas de uma listagem (100 por página), com teto: passou do teto, volta `truncado`. */
async function paginar<T>(ctx: ContextoBling, c: ContaBling, caminho: string, query: Record<string, string | number | undefined>): Promise<{ itens: T[]; truncado: boolean }> {
  const itens: T[] = [];
  for (let pagina = 1; pagina <= ctx.maxPaginas; pagina++) {
    const r = await c.fonte.get<{ data?: T[] }>(caminho, { ...query, pagina, limite: 100 });
    const lote = r?.data ?? [];
    itens.push(...lote);
    if (lote.length < 100) return { itens, truncado: false };
  }
  return { itens, truncado: true };
}

/** Situações padrão dos pedidos de venda no Bling; a conta pode ter situações próprias, lidas de /situacoes. */
const SITUACOES_PADRAO: Record<number, string> = {
  6: 'Em aberto', 9: 'Atendido', 12: 'Cancelado', 15: 'Em andamento', 18: 'Venda agenciada', 21: 'Em digitação', 24: 'Verificado',
};

async function nomesDasSituacoesDeVenda(ctx: ContextoBling, c: ContaBling): Promise<Map<number, string>> {
  return comCache(ctx, `situacoes|${c.slug}`, 6 * 3_600_000, async () => {
    const m = new Map<number, string>(Object.entries(SITUACOES_PADRAO).map(([k, v]) => [Number(k), v]));
    try {
      const mods = await c.fonte.get<{ data?: Array<{ id: number; nome?: string; descricao?: string }> }>('/situacoes/modulos');
      const vendas = (mods?.data ?? []).find((x) => /vendas/i.test(`${x.nome ?? ''} ${x.descricao ?? ''}`) && !/proposta|compra|pdv/i.test(`${x.nome ?? ''}`));
      if (vendas) {
        const r = await c.fonte.get<{ data?: Array<{ id: number; nome: string }> }>(`/situacoes/modulos/${vendas.id}`);
        for (const s of r?.data ?? []) if (s?.id && s?.nome) m.set(s.id, s.nome);
      }
    } catch {
      // sem a lista da conta, ficam os nomes padrão
    }
    return m;
  });
}

const SITUACAO_RECEBER: Record<number, string> = { 1: 'Em aberto', 2: 'Recebido', 3: 'Parcialmente recebido', 4: 'Devolvido', 5: 'Cancelado' };
const SITUACAO_NOTA: Record<number, string> = {
  1: 'Pendente', 2: 'Cancelada', 3: 'Aguardando recibo', 4: 'Rejeitada', 5: 'Autorizada', 6: 'Emitida DANFE', 7: 'Registrada',
  8: 'Aguardando protocolo', 9: 'Denegada', 10: 'Consulta situação', 11: 'Bloqueada',
};

const reais = (n: number) => Math.round(n * 100) / 100;

function somarPor<T>(itens: T[], chave: (x: T) => string, valor: (x: T) => number): Record<string, { quantidade: number; valor: number }> {
  const out: Record<string, { quantidade: number; valor: number }> = {};
  for (const x of itens) {
    const k = chave(x) || '(vazio)';
    const o = (out[k] ??= { quantidade: 0, valor: 0 });
    o.quantidade += 1;
    o.valor = reais(o.valor + valor(x));
  }
  return out;
}

function periodo(inicio: string, fim: string): void {
  validarData(inicio, 'inicio');
  validarData(fim, 'fim');
  if (fim < inicio) throw new ErroDeEntrada('fim antes do início');
}

// ----------------------------------------------------------------- pedidos de venda

export interface PedidoBling {
  id: number;
  numero: number;
  data: string;
  total: number;
  contato?: { id?: number; nome?: string; numeroDocumento?: string; tipoPessoa?: string };
  situacao?: { id?: number };
  loja?: { id?: number };
}

export async function pedidosDoPeriodo(ctx: ContextoBling, c: ContaBling, inicio: string, fim: string) {
  return comCache(ctx, `pedidos|${c.slug}|${inicio}|${fim}`, TTL.busca, () =>
    paginar<PedidoBling>(ctx, c, '/pedidos/vendas', { dataInicial: inicio, dataFinal: fim }),
  );
}

export async function blingPedidos(
  ctx: ContextoBling,
  a: { empresa: string; inicio: string; fim: string; agruparPor?: 'situacao' | 'dia' | 'mes' | 'cliente'; incluirCancelados?: boolean; maxItens?: number },
) {
  periodo(a.inicio, a.fim);
  const c = resolverContaBling(ctx, a.empresa);
  const [{ itens, truncado }, nomes] = await Promise.all([pedidosDoPeriodo(ctx, c, a.inicio, a.fim), nomesDasSituacoesDeVenda(ctx, c)]);
  const nomeDaSituacao = (p: PedidoBling) => nomes.get(p.situacao?.id ?? -1) ?? `situação ${p.situacao?.id ?? '?'}`;
  const valem = a.incluirCancelados ? itens : itens.filter((p) => !/cancelad/i.test(nomeDaSituacao(p)));
  const chave =
    a.agruparPor === 'dia' ? (p: PedidoBling) => p.data :
    a.agruparPor === 'mes' ? (p: PedidoBling) => p.data.slice(0, 7) :
    a.agruparPor === 'cliente' ? (p: PedidoBling) => p.contato?.nome ?? '' :
    nomeDaSituacao;
  return {
    empresa: c.slug,
    periodo: { inicio: a.inicio, fim: a.fim, data: 'data do pedido' },
    pedidos: valem.length,
    valorTotal: reais(valem.reduce((s, p) => s + (Number(p.total) || 0), 0)),
    cancelados: itens.length - itens.filter((p) => !/cancelad/i.test(nomeDaSituacao(p))).length,
    porSituacao: somarPor(itens, nomeDaSituacao, (p) => Number(p.total) || 0),
    ...(a.agruparPor && a.agruparPor !== 'situacao' ? { agrupado: somarPor(valem, chave, (p) => Number(p.total) || 0) } : {}),
    truncado,
    itens: valem.slice(0, a.maxItens ?? 30).map((p) => ({ numero: p.numero, data: p.data, total: p.total, situacao: nomeDaSituacao(p), cliente: p.contato?.nome ?? null })),
    itensOmitidos: Math.max(0, valem.length - (a.maxItens ?? 30)),
  };
}

// ----------------------------------------------------------------- contas a receber

interface ContaReceber {
  id: number;
  situacao: number;
  vencimento: string;
  valor: number;
  dataEmissao?: string;
  contato?: { nome?: string };
  origem?: { tipoOrigem?: string; numero?: string };
}

export async function blingContasReceber(
  ctx: ContextoBling,
  a: { empresa: string; inicio: string; fim: string; filtroData?: 'emissao' | 'vencimento' | 'recebimento'; maxItens?: number },
) {
  periodo(a.inicio, a.fim);
  const c = resolverContaBling(ctx, a.empresa);
  const tipo = { emissao: 'E', vencimento: 'V', recebimento: 'R' }[a.filtroData ?? 'vencimento'];
  const { itens, truncado } = await comCache(ctx, `receber|${c.slug}|${tipo}|${a.inicio}|${a.fim}`, TTL.busca, () =>
    paginar<ContaReceber>(ctx, c, '/contas/receber', { dataInicial: a.inicio, dataFinal: a.fim, tipoFiltroData: tipo }),
  );
  const nome = (x: ContaReceber) => SITUACAO_RECEBER[x.situacao] ?? `situação ${x.situacao}`;
  const hoje = new Date().toISOString().slice(0, 10);
  const vencidas = itens.filter((x) => x.situacao === 1 && x.vencimento < hoje);
  return {
    empresa: c.slug,
    periodo: { inicio: a.inicio, fim: a.fim, data: a.filtroData ?? 'vencimento' },
    contas: itens.length,
    porSituacao: somarPor(itens, nome, (x) => Number(x.valor) || 0),
    vencidasEmAberto: { quantidade: vencidas.length, valor: reais(vencidas.reduce((s, x) => s + (Number(x.valor) || 0), 0)) },
    truncado,
    itens: itens.slice(0, a.maxItens ?? 30).map((x) => ({
      vencimento: x.vencimento, valor: x.valor, situacao: nome(x), cliente: x.contato?.nome ?? null,
      origem: x.origem?.tipoOrigem ? `${x.origem.tipoOrigem} ${x.origem.numero ?? ''}`.trim() : null,
    })),
    itensOmitidos: Math.max(0, itens.length - (a.maxItens ?? 30)),
  };
}

// ----------------------------------------------------------------- notas fiscais

interface NotaBling {
  id: number;
  numero?: string | number;
  situacao?: number;
  dataEmissao?: string;
  contato?: { nome?: string };
}

export async function blingNotas(ctx: ContextoBling, a: { empresa: string; inicio: string; fim: string; maxItens?: number }) {
  periodo(a.inicio, a.fim);
  const c = resolverContaBling(ctx, a.empresa);
  const q = { dataEmissaoInicial: `${a.inicio} 00:00:00`, dataEmissaoFinal: `${a.fim} 23:59:59` };
  const ler = (caminho: string) => comCache(ctx, `notas|${c.slug}|${caminho}|${a.inicio}|${a.fim}`, TTL.busca, () => paginar<NotaBling>(ctx, c, caminho, q));
  const [nfe, nfce] = await Promise.all([ler('/nfe'), ler('/nfce')]);
  const nome = (x: NotaBling) => SITUACAO_NOTA[x.situacao ?? -1] ?? `situação ${x.situacao ?? '?'}`;
  const resumo = (r: { itens: NotaBling[]; truncado: boolean }) => ({
    notas: r.itens.length,
    porSituacao: Object.fromEntries(Object.entries(somarPor(r.itens, nome, () => 0)).map(([k, v]) => [k, v.quantidade])),
    truncado: r.truncado,
    itens: r.itens.slice(0, a.maxItens ?? 20).map((x) => ({ numero: x.numero, emissao: x.dataEmissao, situacao: nome(x), cliente: x.contato?.nome ?? null })),
  });
  return { empresa: c.slug, periodo: { inicio: a.inicio, fim: a.fim, data: 'emissão' }, nfe: resumo(nfe), nfce: resumo(nfce) };
}

// ----------------------------------------------------------------- contatos

interface ContatoBling {
  id: number;
  nome?: string;
  numeroDocumento?: string;
  telefone?: string;
  celular?: string;
}

async function contato(ctx: ContextoBling, c: ContaBling, id: number): Promise<ContatoBling | null> {
  return comCache(ctx, `contato|${c.slug}|${id}`, 24 * 3_600_000, async () => {
    const r = await c.fonte.get<{ data?: ContatoBling }>(`/contatos/${id}`);
    return r?.data ?? null;
  });
}

export async function blingContato(ctx: ContextoBling, a: { empresa: string; busca: string }) {
  const c = resolverContaBling(ctx, a.empresa);
  if (a.busca.trim().length < 3) throw new ErroDeEntrada('busca com pelo menos 3 letras ou números');
  const r = await c.fonte.get<{ data?: ContatoBling[] }>('/contatos', { pesquisa: a.busca.trim(), limite: 20 });
  return {
    empresa: c.slug,
    contatos: (r?.data ?? []).map((x) => ({ id: x.id, nome: x.nome ?? null, documento: x.numeroDocumento ?? null, telefone: x.telefone || null, celular: x.celular || null })),
  };
}

// ----------------------------------------------------------------- relatório de vendas (Kommo × Bling)

/**
 * Pedidos do período que vieram de lead do Kommo, por telefone. Pura: recebe leads com telefone, pedidos e o
 * telefone do cliente de cada pedido. Um lead "comprou" quando algum pedido saiu para o mesmo telefone.
 */
export function cruzarVendas(e: {
  leads: Array<{ id: number; origem: string; telefone: string | null }>;
  pedidos: Array<{ numero: number; total: number; telefoneDoCliente: string | null }>;
}) {
  const leadPorTel = new Map<string, { id: number; origem: string }>();
  for (const l of e.leads) {
    const k = chaveTelefone(l.telefone);
    if (k && !leadPorTel.has(k)) leadPorTel.set(k, { id: l.id, origem: l.origem });
  }
  const compraram = new Set<number>();
  const porOrigem: Record<string, { leads: number; compraram: number; pedidos: number; valor: number }> = {};
  for (const l of e.leads) (porOrigem[l.origem] ??= { leads: 0, compraram: 0, pedidos: 0, valor: 0 }).leads += 1;
  let pedidosDeLead = 0;
  let valorDeLead = 0;
  let semTelefone = 0;
  for (const p of e.pedidos) {
    const k = chaveTelefone(p.telefoneDoCliente);
    if (!k) { semTelefone += 1; continue; }
    const l = leadPorTel.get(k);
    if (!l) continue;
    pedidosDeLead += 1;
    valorDeLead = reais(valorDeLead + (Number(p.total) || 0));
    const o = porOrigem[l.origem]!;
    o.pedidos += 1;
    o.valor = reais(o.valor + (Number(p.total) || 0));
    if (!compraram.has(l.id)) { compraram.add(l.id); o.compraram += 1; }
  }
  const valorTotal = reais(e.pedidos.reduce((s, p) => s + (Number(p.total) || 0), 0));
  return {
    leads: e.leads.length,
    leadsQueCompraram: compraram.size,
    conversao: e.leads.length ? Math.round((1000 * compraram.size) / e.leads.length) / 10 : null,
    pedidos: e.pedidos.length,
    valorTotal,
    pedidosDeLeadDoKommo: pedidosDeLead,
    valorDeLeadDoKommo: valorDeLead,
    pedidosSemTelefoneNoBling: semTelefone,
    porOrigem,
  };
}

export async function relatorioVendas(
  ctxBling: ContextoBling,
  ctxKommo: ContextoKommo,
  a: { empresa: string; inicio: string; fim: string; diasDepois?: number },
) {
  periodo(a.inicio, a.fim);
  const c = resolverContaBling(ctxBling, a.empresa);
  const [u] = resolverUnidadesKommo(ctxKommo, c.slug, 1);
  const dias = Math.min(Math.max(a.diasDepois ?? 30, 0), 90);
  const fimPedidos = new Date(Date.parse(`${a.fim}T12:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);
  const hoje = new Date().toISOString().slice(0, 10);
  const ate = fimPedidos > hoje ? hoje : fimPedidos;

  const [{ leads, truncado: leadsTruncado }, ped, nomes] = await Promise.all([
    leadsDoPeriodo(ctxKommo, u!, a.inicio, a.fim),
    pedidosDoPeriodo(ctxBling, c, a.inicio, ate),
    nomesDasSituacoesDeVenda(ctxBling, c),
  ]);
  const tels = await telefonesDosLeads(ctxKommo, u!, leads as KommoLead[]);
  const valem = ped.itens.filter((p) => !/cancelad/i.test(nomes.get(p.situacao?.id ?? -1) ?? ''));
  const idsContatos = [...new Set(valem.map((p) => p.contato?.id).filter((x): x is number => typeof x === 'number'))];
  const lidos = idsContatos.slice(0, ctxBling.maxContatos);
  const telDoContato = new Map<number, string | null>();
  for (const id of lidos) {
    const ct = await contato(ctxBling, c, id);
    telDoContato.set(id, ct?.celular || ct?.telefone || null);
  }
  const cruz = cruzarVendas({
    leads: leads.map((l) => ({ id: l.id, origem: origemDoLead(l as KommoLead), telefone: tels.get(l.id) ?? null })),
    pedidos: valem.map((p) => ({ numero: p.numero, total: Number(p.total) || 0, telefoneDoCliente: p.contato?.id != null ? telDoContato.get(p.contato.id) ?? null : null })),
  });
  return {
    empresa: c.slug,
    periodo: { leadsCriadosEntre: [a.inicio, a.fim], pedidosEntre: [a.inicio, ate], diasDepois: dias },
    ...cruz,
    observacoes: [
      'Cruzamento pelo telefone do contato do Kommo × celular/telefone do cliente no Bling. Pedido cancelado não conta.',
      ...(leadsTruncado ? ['leads do Kommo truncados: os totais de lead são um mínimo'] : []),
      ...(ped.truncado ? ['pedidos do Bling truncados: os totais de pedido são um mínimo'] : []),
      ...(idsContatos.length > lidos.length ? [`só ${lidos.length} de ${idsContatos.length} clientes tiveram o telefone lido (limite do Bling): encurte o período`] : []),
    ],
  };
}

// ----------------------------------------------------------------- ferramentas

const empresa = z.string().min(1).describe('empresa com o Bling conectado: slug ou nome curto ("hm"). Veja listar_integracoes.');
const data = (o: string) => z.string().describe(`${o}, AAAA-MM-DD`);

export function registrarFerramentasBling(server: McpServer, ctx: ContextoBling, kommo: ContextoKommo, auditar?: Auditar): void {
  server.registerTool(
    'bling_pedidos',
    {
      title: 'Pedidos de venda (Bling)',
      description:
        'Pedidos de venda do Bling no período (pela data do pedido): quantidade, valor, por situação e, se pedir, por dia/mês/cliente. ' +
        'Cancelados ficam fora do total (aparecem em porSituacao). Hoje: HM Tecnologia.',
      inputSchema: {
        empresa, inicio: data('início'), fim: data('fim'),
        agruparPor: z.enum(['situacao', 'dia', 'mes', 'cliente']).optional(),
        incluirCancelados: z.boolean().optional(),
        maxItens: z.number().int().min(0).max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executar('bling_pedidos', args, auditar, () => blingPedidos(ctx, args)),
  );
  server.registerTool(
    'bling_contas_receber',
    {
      title: 'Contas a receber (Bling)',
      description:
        'Contas a receber do Bling no período, filtradas por vencimento (padrão), emissão ou recebimento: totais por situação ' +
        '(em aberto, recebido, parcial, devolvido, cancelado) e o que está vencido em aberto.',
      inputSchema: {
        empresa, inicio: data('início'), fim: data('fim'),
        filtroData: z.enum(['emissao', 'vencimento', 'recebimento']).optional(),
        maxItens: z.number().int().min(0).max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executar('bling_contas_receber', args, auditar, () => blingContasReceber(ctx, args)),
  );
  server.registerTool(
    'bling_notas',
    {
      title: 'Notas fiscais (Bling)',
      description: 'NF-e e NFC-e emitidas no período (pela data de emissão), por situação (autorizada, cancelada, rejeitada…).',
      inputSchema: { empresa, inicio: data('início'), fim: data('fim'), maxItens: z.number().int().min(0).max(100).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executar('bling_notas', args, auditar, () => blingNotas(ctx, args)),
  );
  server.registerTool(
    'bling_contato',
    {
      title: 'Buscar cliente (Bling)',
      description: 'Busca clientes no Bling por nome, CPF/CNPJ ou telefone (mín. 3 caracteres).',
      inputSchema: { empresa, busca: z.string().min(3) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executar('bling_contato', args, auditar, () => blingContato(ctx, args)),
  );
  server.registerTool(
    'relatorio_vendas',
    {
      title: 'Leads do Kommo que viraram venda (Bling)',
      description:
        'Para empresas com Kommo + Bling (HM Tecnologia): dos leads criados no Kommo no período, quantos compraram e quanto, ' +
        'cruzando o telefone do lead com o do cliente dos pedidos do Bling (do início até `diasDepois` após o fim; padrão 30). ' +
        'Vem por origem do lead. Use este em vez de somar kommo_leads e bling_pedidos por conta própria.',
      inputSchema: { empresa, inicio: data('início dos leads'), fim: data('fim dos leads'), diasDepois: z.number().int().min(0).max(90).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executar('relatorio_vendas', args, auditar, () => relatorioVendas(ctx, kommo, args)),
  );
}
