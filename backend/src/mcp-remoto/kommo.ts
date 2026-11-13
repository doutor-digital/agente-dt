/**
 * Kommo no conector: só leitura, uma conta por franquia, o mesmo parâmetro `unidade` da franquia.
 * A fonte é injetada (`FonteKommo`): em produção é o KommoClient do agente; nos testes, um falso.
 *
 * CUIDADO COM A SOFIA: o limitador do Kommo é UM só pro processo (uma chamada a cada 180 ms, todas
 * as contas). Cada chamada daqui entra na mesma fila das respostas dela. Por isso: no máximo
 * MAX_UNIDADES_KOMMO contas por chamada, 4 páginas (1.000 leads) por conta, telefones em lote e cache.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { eh403DeEscopo, type ConversaNaEntrada, type KommoLead, type KommoPipeline, type NotaKommo } from '../services/kommo.service.js';
import { TETO_HISTORICO, type MensagemOficial } from '../services/kommo-talks-normalizar.js';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { instanteNoFuso } from '../franquia-mcp/normalizar.js';
import { Cache, emParalelo, TTL } from '../franquia-mcp/ritmo.js';
import { ErroDeEntrada, validarData } from '../franquia-mcp/travas.js';
import { executar } from './ferramenta.js';
import { epochDoDiaLocal } from './tempo.js';
import { acharSlug } from './unidades.js';

export interface FonteKommo {
  /** leads com os ids dos contatos (`_embedded.contacts`) */
  leadsNaJanela(campo: 'created_at' | 'updated_at', de: number, ate: number, maxPaginas: number): Promise<{ leads: KommoLead[]; truncado: boolean }>;
  telefonesDosContatos(ids: number[]): Promise<Map<number, string>>;
  funis(): Promise<KommoPipeline[]>;
  lead(id: number): Promise<KommoLead>;
  leadsPorTelefone(telefone: string): Promise<KommoLead[]>;
  usuarios(): Promise<Array<{ id: number; name: string }>>;
  /** histórico de mensagens do lead (rota oficial talks/messages); opcional para as fontes de teste antigas */
  conversa?(leadId: number, limite: number, periodo?: { desde?: number; ate?: number }): Promise<{ mensagens: MensagemOficial[]; conversas: number; total?: number; truncado?: boolean }>;
  /** notas do cartão, das mais recentes; opcional para as fontes de teste antigas */
  notas?(leadId: number, limite: number, periodo?: { desde?: number; ate?: number }): Promise<{ notas: NotaKommo[]; truncado: boolean }>;
  /**
   * as conversas da caixa «Leads de entrada» (unsorted) criadas entre `de` e `ate` (epoch s), do mais novo ao mais velho;
   * `truncado` = parou no teto de páginas antes de chegar ao início da janela. Só leitura; opcional para as fontes de teste antigas
   */
  entrada?(de: number, ate: number, maxPaginas: number): Promise<{ itens: ConversaNaEntrada[]; truncado: boolean }>;
  /** subdomínio da conta no Kommo (monta o link do cartão); opcional */
  subdominio?: string;
}

/**
 * Conta do Kommo dividida entre unidades (Petrópolis e Caxias, tabela `unit_crm_compartilhado`): quem é de quem
 * é o campo «⌂ Unidade de atendimento». Cada unidade só vê os cartões com o seu rótulo; cartão vazio (ou com um
 * valor que ninguém usa) não é de nenhuma — não entra em soma nenhuma, só no aviso.
 */
export interface DivisaoDoKommo {
  /** o texto da opção desta unidade no campo */
  rotulo: string;
  /** todas as unidades que dividem a conta, esta inclusa */
  membros: Array<{ slug: string; rotulo: string }>;
}

export interface UnidadeKommo {
  slug: string;
  nome: string;
  fuso: string;
  /** todos os slugs que usam esta conta (principal + resgate + …): o banco guarda vínculo e conversa por eles */
  slugsDaFranquia: string[];
  fonte: FonteKommo;
  /** o slug da dona da conta, quando a unidade usa o Kommo de outra (as irmãs leem a mesma janela de leads) */
  conta?: string;
  divisao?: DivisaoDoKommo;
}

export interface ContextoKommo {
  unidades: Map<string, UnidadeKommo>;
  cache: Cache;
  paralelo: number;
  /** páginas de 250 leads por consulta */
  maxPaginas: number;
  /** leituras em andamento: duas unidades da mesma conta pedindo junto esperam a mesma */
  emAndamento: Map<string, Promise<unknown>>;
}

export function criarContextoKommo(unidades: Map<string, UnidadeKommo>, op: { paralelo?: number; maxPaginas?: number; agora?: () => number } = {}): ContextoKommo {
  return { unidades, cache: new Cache(op.agora), paralelo: op.paralelo ?? 2, maxPaginas: op.maxPaginas ?? 4, emAndamento: new Map() };
}

/** A chave de cache da CONTA do Kommo: as unidades que dividem uma conta leem funis, usuários e leads uma vez só. */
const contaDe = (u: UnidadeKommo) => u.conta ?? u.slug;

export const MAX_UNIDADES_KOMMO = 4;

export function resolverUnidadesKommo(ctx: ContextoKommo, alvo: string | string[], max = Infinity): UnidadeKommo[] {
  if (ctx.unidades.size === 0) throw new ErroDeEntrada('nenhuma conta do Kommo disponível agora (carregando). Tente em instantes.');
  const pedidos = Array.isArray(alvo) ? alvo : [alvo];
  if (pedidos.some((p) => p.trim().toLowerCase() === 'todas')) {
    if (ctx.unidades.size > max) {
      throw new ErroDeEntrada(
        `o Kommo divide a fila de chamadas com o atendimento da Sofia: peça até ${max} unidades por vez (chame de novo para as próximas). ` +
          `Com Kommo: ${[...ctx.unidades.keys()].join(', ')}`,
      );
    }
    return [...ctx.unidades.values()];
  }
  const achadas = new Map<string, UnidadeKommo>();
  const faltam: string[] = [];
  for (const p of pedidos) {
    const slug = acharSlug(ctx.unidades.keys(), p);
    if (slug) achadas.set(slug, ctx.unidades.get(slug) as UnidadeKommo);
    else faltam.push(p);
  }
  if (faltam.length) {
    throw new ErroDeEntrada(`unidade sem Kommo, desconhecida ou ambígua: ${faltam.join(', ')}. Com Kommo: ${[...ctx.unidades.keys()].join(', ')}`);
  }
  if (achadas.size > max) throw new ErroDeEntrada(`no máximo ${max} unidades por chamada (pediu ${achadas.size})`);
  return [...achadas.values()];
}

// ── leitura com cache ──

/** Leitura incompleta (`truncado`) não entra no cache: senão vira a resposta por 10 minutos. */
async function comCache<T>(ctx: ContextoKommo, chave: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const g = ctx.cache.pegar<T>(chave);
  if (g !== undefined) return g;
  const andando = ctx.emAndamento.get(chave);
  if (andando) return andando as Promise<T>;
  const p = fn()
    .then((v) => {
      if (!(v as { truncado?: unknown })?.truncado) ctx.cache.guardar(chave, v, ttl);
      return v;
    })
    .finally(() => ctx.emAndamento.delete(chave));
  ctx.emAndamento.set(chave, p);
  return p;
}

const HORA = 3_600_000;

/** `pipeline:status` → nomes. 142 e 143 são "ganho" e "perdido" em toda conta do Kommo. */
async function nomesDasEtapas(ctx: ContextoKommo, u: UnidadeKommo): Promise<Map<string, { funil: string; etapa: string }>> {
  return comCache(ctx, `funis|${contaDe(u)}`, HORA, async () => {
    const m = new Map<string, { funil: string; etapa: string }>();
    for (const p of await u.fonte.funis()) for (const s of p.statuses) m.set(`${p.id}:${s.id}`, { funil: p.name, etapa: s.name });
    return m;
  });
}

async function nomesDosUsuarios(ctx: ContextoKommo, u: UnidadeKommo): Promise<Map<number, string>> {
  return comCache(ctx, `usuarios|${contaDe(u)}`, HORA, async () => new Map((await u.fonte.usuarios()).map((x) => [x.id, x.name])));
}

/**
 * Os leads do período. Conta dividida: só os desta unidade, e `semUnidade` conta os que não são de ninguém.
 * A janela crua vai pro cache pela CONTA: Petrópolis e Caxias não baixam os mesmos 1.000 leads duas vezes.
 */
export async function leadsDoPeriodo(
  ctx: ContextoKommo,
  u: UnidadeKommo,
  inicio: string,
  fim: string,
  campo: 'created_at' | 'updated_at' = 'created_at',
): Promise<{ leads: KommoLead[]; truncado: boolean; semUnidade?: number }> {
  const de = epochDoDiaLocal(inicio, u.fuso);
  const ate = epochDoDiaLocal(fim, u.fuso, true);
  // pelo instante, não pelo dia: duas unidades da conta em fusos diferentes não trocam de janela
  const bruto = await comCache(ctx, `leads|${contaDe(u)}|${campo}|${de}|${ate}`, TTL.busca, () => u.fonte.leadsNaJanela(campo, de, ate, ctx.maxPaginas));
  if (!u.divisao) return bruto;
  const donos = bruto.leads.map((l) => donoDoCartao(u, l).tipo);
  return {
    leads: bruto.leads.filter((_, i) => donos[i] === 'desta'),
    truncado: bruto.truncado,
    semUnidade: donos.filter((d) => d === 'ninguem').length,
  };
}

// ── conta dividida (Petrópolis × Caxias) ──

const CAMPO_UNIDADE_DE_ATENDIMENTO = 'Unidade de atendimento';

/** O texto do «⌂ Unidade de atendimento» do cartão; vazio = null. */
export function rotuloDoCartao(lead: KommoLead): string | null {
  return campoChamado(lead, CAMPO_UNIDADE_DE_ATENDIMENTO) || null;
}

export type DonoDoCartao = { tipo: 'desta' } | { tipo: 'outra'; slug: string; rotulo: string } | { tipo: 'ninguem'; valor: string | null };

/** De quem é o cartão, do ponto de vista de `u`. Conta de uma unidade só: sempre dela. */
export function donoDoCartao(u: UnidadeKommo, lead: KommoLead): DonoDoCartao {
  if (!u.divisao) return { tipo: 'desta' };
  const valor = rotuloDoCartao(lead);
  const m = valor ? u.divisao.membros.find((x) => semMarcas(x.rotulo) === semMarcas(valor)) : undefined;
  if (!m) return { tipo: 'ninguem', valor };
  return m.slug === u.slug ? { tipo: 'desta' } : { tipo: 'outra', slug: m.slug, rotulo: m.rotulo };
}

function rotulosDaDivisao(d: DivisaoDoKommo): string {
  const r = d.membros.map((m) => m.rotulo);
  return r.length <= 1 ? r.join('') : `${r.slice(0, -1).join(', ')} e ${r[r.length - 1]}`;
}

/** O aviso de toda resposta de lista numa conta dividida: o que entrou e quantos ficaram sem dono. */
export function avisoDaDivisao(u: UnidadeKommo, semUnidade: number): string {
  const d = u.divisao!;
  const base = `Um Kommo só para ${rotulosDaDivisao(d)}: aqui entram só os cartões com ⌂ Unidade de atendimento = ${d.rotulo}.`;
  return semUnidade
    ? `${base} ${semUnidade} cartão(ões) do período não são de nenhuma unidade (campo vazio ou com valor que ninguém usa) e não entram ` +
        'em soma nenhuma: a SDR precisa escolher. É o MESMO número em todas as unidades da conta — não some.'
    : base;
}

/** Por que o cartão não é de ninguém: campo vazio, ou um valor que nenhuma unidade da conta usa. */
export function motivoSemDono(u: UnidadeKommo, valor: string | null): string {
  const quem = rotulosDaDivisao(u.divisao!);
  return valor
    ? `o ⌂ Unidade de atendimento do cartão está "${valor}", que não é nenhuma das unidades da conta (${quem}): não é de nenhuma até a SDR corrigir`
    : `cartão sem ⌂ Unidade de atendimento (${quem}): não é de nenhuma unidade até a SDR escolher`;
}

/**
 * Um cartão pedido pela unidade errada é recusado (diz qual pedir); sem unidade, vem com o aviso.
 * Devolve os campos que a resposta leva quando a conta é dividida.
 */
export function conferirDono(u: UnidadeKommo, lead: KommoLead): { unidadeDeAtendimento?: string | null; avisoUnidade?: string } {
  if (!u.divisao) return {};
  const d = donoDoCartao(u, lead);
  if (d.tipo === 'outra') {
    throw new ErroDeEntrada(`o cartão ${lead.id} é de ${d.rotulo} (⌂ Unidade de atendimento): peça com unidade="${d.slug}"`);
  }
  if (d.tipo === 'ninguem') return { unidadeDeAtendimento: d.valor, avisoUnidade: motivoSemDono(u, d.valor) };
  return { unidadeDeAtendimento: u.divisao.rotulo };
}

/**
 * Telefone de cada lead pelo CONTATO do Kommo (a fonte), em lote. Pega quem nunca falou com a IA
 * (ligação, recepção, formulário) — o telefone da conversa sozinho deixava esses de fora do funil.
 */
export async function telefonesDosLeads(ctx: ContextoKommo, u: UnidadeKommo, leads: KommoLead[]): Promise<Map<number, string>> {
  const contatoDoLead = new Map<number, number>();
  for (const l of leads) {
    const cs = l._embedded?.contacts ?? [];
    const principal = cs.find((c) => c.is_main) ?? cs[0];
    if (principal) contatoDoLead.set(l.id, principal.id);
  }
  const chave = `tels|${contaDe(u)}|${[...contatoDoLead.values()].sort((a, b) => a - b).join(',')}`;
  const porContato = await comCache(ctx, chave, TTL.busca, () => u.fonte.telefonesDosContatos([...contatoDoLead.values()]));
  const m = new Map<number, string>();
  for (const [lead, contato] of contatoDoLead) {
    const tel = porContato.get(contato);
    if (tel) m.set(lead, tel);
  }
  return m;
}

// ── o lead do jeito que o relatório lê ──

function semMarcas(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function valorDoCampo(c: NonNullable<KommoLead['custom_fields_values']>[number]): string {
  return c.values.map((v) => String(v.value ?? '')).filter(Boolean).join(', ');
}

/** Valor do campo cujo nome, sem acento/símbolo, é EXATAMENTE `nome` ("⚑ Origem" = "origem"). */
function campoChamado(lead: KommoLead, nome: string): string {
  const alvo = semMarcas(nome);
  const c = (lead.custom_fields_values ?? []).find((f) => semMarcas(f.field_name ?? '') === alvo);
  return c ? valorDoCampo(c) : '';
}

/**
 * O campo "Origem" (qualquer grafia: "⚑ Origem", "ORIGEM") ou etiqueta ORIGEM_*; senão "(sem origem)".
 * Nome EXATO, não "contém": o rastreio de campanha grava 15 campos "Origem – Campanha", "Origem – URL"…
 * e o "contém" pegava a URL do post como se fosse a origem (Marabá, 06/10: "70 origens" de fb.me).
 */
export function origemDoLead(lead: KommoLead): string {
  const doCampo = campoChamado(lead, 'origem');
  if (doCampo) return doCampo;
  const tag = (lead._embedded?.tags ?? []).find((t) => /^origem[\s_-]/i.test(t.name));
  if (tag) return tag.name.replace(/^origem[\s_-]+/i, '').replace(/_/g, ' ');
  return '(sem origem)';
}

/**
 * Atalhos pros campos do rastreio de anúncios do WhatsApp (n8n `rastreio-campanhas`). Os nomes REAIS
 * nas contas da Doutor Hérnia têm o prefixo "⌂" (lidos num cartão de Açailândia em 06/10/2026); o
 * README do rastreio ainda fala "Origem – Campanha", então os dois entram, nessa ordem.
 * `anuncio` é o ID do anúncio no Meta: é ele que liga o lead ao gasto (Meta/Metricool). Campanha e
 * conjunto ficam VAZIOS em anúncio feito a partir de post (o Meta não devolve campanha pra post).
 */
const ATALHOS: Record<string, string[]> = {
  campanha: ['⌂ Campanha', 'Origem – Campanha'],
  conjunto: ['⌂ Conjunto', 'Origem – Conjunto'],
  anuncio: ['⌂ ID do anúncio', 'Origem – ID do anúncio'],
  titulo_do_anuncio: ['⌂ Título do anúncio', 'Origem – Headline'],
  plataforma: ['⌂ Plataforma de origem', 'Origem – Plataforma'],
  url: ['⌂ URL de origem do clique', 'Origem – URL'],
};

function candidatos(por: string): string[] {
  const p = semMarcas(por).replace(/ /g, '_');
  return ATALHOS[p] ?? [por];
}

/** Em que grupo o lead cai: `origem`, um atalho do rastreio (`campanha`, `anuncio`…) ou o nome de um campo. */
export function grupoDoLead(lead: KommoLead, por: string): string {
  const p = semMarcas(por);
  if (p === 'origem') return origemDoLead(lead);
  for (const nome of candidatos(por)) {
    const v = campoChamado(lead, nome);
    if (v) return v;
  }
  return `(sem ${p})`;
}

export function situacaoDoLead(lead: KommoLead): 'ganho' | 'perdido' | 'aberto' {
  return lead.status_id === 142 ? 'ganho' : lead.status_id === 143 ? 'perdido' : 'aberto';
}

function legivel(lead: KommoLead, fuso: string, etapas: Map<string, { funil: string; etapa: string }>, usuarios: Map<number, string>, comCampos = true) {
  const e = etapas.get(`${lead.pipeline_id}:${lead.status_id}`);
  const quando = (s?: number) => (s ? instanteNoFuso(new Date(s * 1000), fuso) : null);
  const responsavel = (lead as KommoLead & { responsible_user_id?: number }).responsible_user_id;
  return {
    id: lead.id,
    nome: lead.name,
    funil: e?.funil ?? String(lead.pipeline_id),
    etapa: e?.etapa ?? String(lead.status_id),
    situacao: situacaoDoLead(lead),
    origem: origemDoLead(lead),
    valor: lead.price ?? null,
    criado: quando(lead.created_at),
    atualizado: quando(lead.updated_at),
    responsavel: responsavel ? (usuarios.get(responsavel) ?? String(responsavel)) : null,
    tags: (lead._embedded?.tags ?? []).map((t) => t.name),
    // os campos do cartão têm queixa, resumo da IA, às vezes CPF: só vão quando pedidos
    ...(comCampos ? { campos: Object.fromEntries((lead.custom_fields_values ?? []).map((c) => [c.field_name ?? String(c.field_id), valorDoCampo(c)])) } : {}),
  };
}

type Legivel = ReturnType<typeof legivel>;

function chaveDeAgrupamento(l: Legivel, por: string): string[] {
  switch (por) {
    case 'etapa':
      return [`${l.funil} › ${l.etapa}`];
    case 'funil':
      return [l.funil];
    case 'situacao':
      return [l.situacao];
    case 'origem':
      return [l.origem];
    case 'responsavel':
      return [l.responsavel ?? '(sem responsável)'];
    case 'dia':
      return [l.criado?.slice(0, 10) ?? '(sem data)'];
    case 'tag':
      return l.tags.length ? l.tags : ['(sem tag)'];
    default: {
      // atalho do rastreio ("campanha", "anuncio"…) ou nome de campo personalizado, em qualquer grafia
      const p = semMarcas(por);
      for (const nome of candidatos(por)) {
        const alvo = semMarcas(nome);
        const [, valor] = Object.entries(l.campos ?? {}).find(([k]) => semMarcas(k) === alvo) ?? [];
        if (valor) return [valor];
      }
      return [`(sem ${p})`];
    }
  }
}

function contar(itens: Legivel[], por: string): Record<string, number> {
  const m: Record<string, number> = {};
  for (const l of itens) for (const k of chaveDeAgrupamento(l, por)) m[k] = (m[k] ?? 0) + 1;
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

async function porUnidade<T>(ctx: ContextoKommo, us: UnidadeKommo[], fn: (u: UnidadeKommo) => Promise<T>) {
  const pares = await emParalelo(us, ctx.paralelo, async (u) => {
    try {
      return [u.slug, { ok: true, ...(await fn(u)) }] as const;
    } catch (e) {
      return [u.slug, { ok: false, erro: e instanceof Error ? e.message : String(e) }] as const;
    }
  });
  return Object.fromEntries(pares) as Record<string, Record<string, unknown>>;
}

/**
 * Os sem unidade de uma conta dividida aparecem iguais em cada unidade dela: na rede entram UMA vez por conta
 * (o maior número, se as unidades leram janelas diferentes).
 */
function semUnidadeDaRede(us: UnidadeKommo[], res: Record<string, Record<string, unknown>>): { semUnidade?: number } {
  const porConta = new Map<string, number>();
  for (const u of us) {
    const v = res[u.slug];
    if (!u.divisao || !v?.ok) continue;
    porConta.set(contaDe(u), Math.max(porConta.get(contaDe(u)) ?? 0, Number(v.semUnidade ?? 0)));
  }
  return porConta.size ? { semUnidade: [...porConta.values()].reduce((s, n) => s + n, 0) } : {};
}

// ── as consultas ──

/** A soma da caixa de entrada na rede: só das unidades que a leram; se alguma não leu (conta dividida, erro, sem a leitura), o número é um mínimo e o aviso vem sempre. */
function naEntradaDaRede(ok: Array<Record<string, unknown>>): Record<string, unknown> {
  if (!ok.some((v) => 'naEntrada' in v)) return {};
  const lidas = ok.filter((v) => typeof v.naEntrada === 'number');
  const semLeitura = ok.length - lidas.length;
  return {
    ...(lidas.length ? { naEntrada: lidas.reduce((s, v) => s + Number(v.naEntrada), 0) } : { naEntrada: null }),
    ...(semLeitura || lidas.some((v) => v.naEntradaTruncado) ? { naEntradaIncompleta: true } : {}),
    avisoEntrada:
      'naEntrada = conversas na caixa «Leads de entrada», NÃO aceitas, que não entram em total: veja kommo_entrada.' +
      (semLeitura ? ` ${semLeitura} unidade(s) não tiveram a caixa lida, então esse número é um mínimo.` : ''),
  };
}

export async function kommoLeads(
  ctx: ContextoKommo,
  a: { unidade: string | string[]; inicio: string; fim: string; data?: 'criacao' | 'atualizacao'; agruparPor?: string; maxItens?: number; comCampos?: boolean },
) {
  validarData(a.inicio, 'inicio');
  validarData(a.fim, 'fim');
  if (a.inicio > a.fim) throw new ErroDeEntrada('inicio é depois do fim');
  const us = resolverUnidadesKommo(ctx, a.unidade, MAX_UNIDADES_KOMMO);
  const max = a.maxItens ?? (us.length === 1 ? 30 : 0);
  const res = await porUnidade(ctx, us, async (u) => {
    const [{ leads, truncado, semUnidade }, etapas, usuarios, entrada] = await Promise.all([
      leadsDoPeriodo(ctx, u, a.inicio, a.fim, a.data === 'atualizacao' ? 'updated_at' : 'created_at'),
      nomesDasEtapas(ctx, u),
      nomesDosUsuarios(ctx, u),
      // a caixa de entrada só tem data de entrada: com data="atualizacao" a conta não casa com o período e fica de fora
      a.data === 'atualizacao' ? Promise.resolve({}) : naEntradaDaUnidade(ctx, u, a.inicio, a.fim),
    ]);
    // agrupar por campo do cartão precisa dos campos; a resposta só os leva com comCampos
    const completos = leads.map((l) => legivel(l, u.fuso, etapas, usuarios, true));
    const itens = a.comCampos ? completos : leads.map((l) => legivel(l, u.fuso, etapas, usuarios, false));
    return {
      total: itens.length,
      ...entrada,
      ...(truncado ? { truncado: true, aviso: `INCOMPLETO: parou em ${ctx.maxPaginas * 250} leads. O total é um mínimo.` } : {}),
      ...(u.divisao ? { semUnidade: semUnidade ?? 0, avisoUnidade: avisoDaDivisao(u, semUnidade ?? 0) } : {}),
      porSituacao: contar(completos, 'situacao'),
      ...(a.agruparPor ? { agrupado: contar(completos, a.agruparPor) } : {}),
      itens: itens.slice(0, max),
      ...(itens.length > max ? { itensOmitidos: itens.length - max } : {}),
    };
  });
  const r: Record<string, unknown> = { consultadoEm: new Date().toISOString(), periodo: { inicio: a.inicio, fim: a.fim, data: a.data ?? 'criacao' } };
  if (us.length > 1) {
    const ok = Object.entries(res).filter(([, v]) => v.ok);
    const agrupado: Record<string, number> = {};
    for (const [, v] of ok) for (const [k, n] of Object.entries((v.agrupado as Record<string, number>) ?? {})) agrupado[k] = (agrupado[k] ?? 0) + n;
    r.rede = {
      total: ok.reduce((s, [, v]) => s + Number(v.total), 0),
      unidadesSomadas: ok.map(([k]) => k),
      ...(Object.keys(agrupado).length ? { agrupado: Object.fromEntries(Object.entries(agrupado).sort((x, y) => y[1] - x[1])) } : {}),
      ...(ok.length < us.length ? { unidadesForaDoTotal: Object.entries(res).filter(([, v]) => !v.ok).map(([k]) => k) } : {}),
      ...(ok.some(([, v]) => v.truncado) ? { unidadesIncompletas: ok.filter(([, v]) => v.truncado).map(([k]) => k) } : {}),
      ...semUnidadeDaRede(us, res),
      ...naEntradaDaRede(ok.map(([, v]) => v)),
    };
  }
  r.porUnidade = res;
  return r;
}

// ── a caixa «Leads de entrada» (unsorted) ──

const AGRUPAMENTOS_DA_ENTRADA = ['dia', 'mes', 'origem', 'canal', 'funil'] as const;

/**
 * 403 na caixa de entrada: a rota pede token de administrador (a mesma razão pela qual o robô da entrada lê sem o freio global).
 * Em português e dizendo de quem é o conserto, não "Request failed with status code 403".
 */
export function explicar403DaEntrada(e: unknown, unidade: string): unknown {
  const status = e instanceof Error && e.name === 'KommoApiError' ? (e as { status?: number }).status : undefined;
  if (status !== 403) return e;
  return new Error(
    `O Kommo de ${unidade} recusou a leitura da caixa «Leads de entrada» (403): essa rota pede um token de administrador da conta. ` +
      'Não é erro do seu pedido e repetir não adianta; quem resolve é o João, gerando um token novo. O resto do Kommo (kommo_leads, kommo_lead…) segue funcionando. ' +
      `[Kommo: ${(e as Error).message}]`,
    { cause: e },
  );
}

/**
 * As conversas da entrada no período (dia local da unidade, pela data em que ENTRARAM). Conta dividida é recusada: a conversa
 * ainda não tem «⌂ Unidade de atendimento», então a caixa não se separa por unidade e mostrá-la entregaria pacientes da irmã.
 * A janela vai pro cache pela CONTA (kommo_leads e kommo_entrada leem a mesma, uma vez só).
 */
export async function entradaDoPeriodo(ctx: ContextoKommo, u: UnidadeKommo, inicio: string, fim: string): Promise<{ itens: ConversaNaEntrada[]; truncado: boolean }> {
  if (!u.fonte.entrada) throw new ErroDeEntrada('esta conta do Kommo não tem a leitura da caixa de entrada ligada');
  if (u.divisao) {
    throw new ErroDeEntrada(
      `${u.slug} divide o Kommo com outra unidade (${rotulosDaDivisao(u.divisao)}) e a caixa «Leads de entrada» é da conta inteira: ` +
        'a conversa ainda não tem «⌂ Unidade de atendimento», então não dá para separar o que é desta unidade.',
    );
  }
  const de = epochDoDiaLocal(inicio, u.fuso);
  const ate = epochDoDiaLocal(fim, u.fuso, true);
  const ler = u.fonte.entrada.bind(u.fonte);
  const bruto = await comCache(ctx, `entrada|${contaDe(u)}|${de}|${ate}`, TTL.busca, () => ler(de, ate, ctx.maxPaginas).catch((e: unknown) => { throw explicar403DaEntrada(e, u.slug); }));
  return { itens: [...bruto.itens].sort((a, b) => b.criadoEm - a.criadoEm), truncado: bruto.truncado };
}

function linkDoCartao(u: UnidadeKommo, leadId: number | null): string | null {
  const sub = u.fonte.subdominio?.trim();
  return sub && leadId ? `https://${sub}.kommo.com/leads/detail/${leadId}` : null;
}

async function nomesDosFunis(ctx: ContextoKommo, u: UnidadeKommo): Promise<Map<number, string>> {
  try {
    const funis = await comCache(ctx, `funis-lista|${contaDe(u)}`, HORA, () => u.fonte.funis());
    return new Map(funis.map((f) => [f.id, f.name]));
  } catch {
    return new Map(); // sem os nomes, o funil sai pelo id
  }
}

type ItemDaEntrada = ReturnType<typeof itemDaEntrada>;

function itemDaEntrada(c: ConversaNaEntrada, u: UnidadeKommo, funis: Map<number, string>) {
  return {
    leadId: c.leadId,
    contatoId: c.contatoId,
    nome: c.nome,
    telefone: c.telefone,
    canal: c.canal,
    origem: c.origem,
    // chats (WhatsApp…), forms, sip, mail: em formulário ou e-mail o «telefone» pode ser outra coisa
    categoria: c.categoria || null,
    recebidoEm: instanteNoFuso(new Date(c.criadoEm * 1000), u.fuso),
    funil: c.pipelineId ? (funis.get(c.pipelineId) ?? String(c.pipelineId)) : '(sem funil)',
    link: linkDoCartao(u, c.leadId),
  };
}

function grupoDaEntrada(i: ItemDaEntrada, por: (typeof AGRUPAMENTOS_DA_ENTRADA)[number]): string {
  switch (por) {
    case 'dia':
      return i.recebidoEm.slice(0, 10);
    case 'mes':
      return i.recebidoEm.slice(0, 7);
    case 'origem':
      return i.origem ?? '(sem origem)';
    case 'canal':
      return i.canal ?? '(sem canal)';
    case 'funil':
      return i.funil;
  }
}

function agruparEntrada(por: string): (typeof AGRUPAMENTOS_DA_ENTRADA)[number] {
  const achado = AGRUPAMENTOS_DA_ENTRADA.find((g) => g === por.trim().toLowerCase());
  if (!achado) throw new ErroDeEntrada(`agruparPor "${por}" não existe na entrada. Use: ${AGRUPAMENTOS_DA_ENTRADA.join(', ')}`);
  return achado;
}

export async function kommoEntrada(
  ctx: ContextoKommo,
  a: { unidade: string | string[]; inicio: string; fim: string; agruparPor?: string; maxItens?: number; pular?: number },
) {
  validarData(a.inicio, 'inicio');
  validarData(a.fim, 'fim');
  if (a.inicio > a.fim) throw new ErroDeEntrada('inicio é depois do fim');
  const por = a.agruparPor ? agruparEntrada(a.agruparPor) : undefined;
  const us = resolverUnidadesKommo(ctx, a.unidade, MAX_UNIDADES_KOMMO);
  const max = a.maxItens ?? (us.length === 1 ? 30 : 0);
  const pular = a.pular ?? 0;
  const res = await porUnidade(ctx, us, async (u) => {
    const [{ itens: brutos, truncado }, funis] = await Promise.all([entradaDoPeriodo(ctx, u, a.inicio, a.fim), nomesDosFunis(ctx, u)]);
    const itens = brutos.map((c) => itemDaEntrada(c, u, funis));
    let agrupado: Record<string, number> | undefined;
    if (por) {
      const m: Record<string, number> = {};
      for (const i of itens) m[grupoDaEntrada(i, por)] = (m[grupoDaEntrada(i, por)] ?? 0) + 1;
      const pares = Object.entries(m);
      // dia e mês em ordem de calendário; o resto, do maior para o menor
      pares.sort(por === 'dia' || por === 'mes' ? (x, y) => x[0].localeCompare(y[0]) : (x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
      agrupado = Object.fromEntries(pares);
    }
    const mostrados = itens.slice(pular, pular + max);
    const omitidos = itens.length - pular - mostrados.length;
    return {
      total: itens.length,
      ...(truncado
        ? {
            truncado: true,
            aviso: `INCOMPLETO: o Kommo não filtra a caixa por data; li do mais novo para o mais velho e parei em ${ctx.maxPaginas * 250} conversas sem chegar ao início do período. O total é um mínimo e o que falta é o mais antigo.`,
          }
        : {}),
      ...(agrupado ? { agrupado } : {}),
      itens: mostrados,
      ...(omitidos > 0 ? { itensOmitidos: omitidos } : {}),
    };
  });
  const r: Record<string, unknown> = {
    consultadoEm: new Date().toISOString(),
    periodo: { inicio: a.inicio, fim: a.fim, data: 'entrada na caixa' },
    aviso:
      'São conversas NÃO aceitas da caixa «Leads de entrada» do Kommo: ninguém as aceitou, então NÃO aparecem em kommo_leads (nem no funil). ' +
      'Cada uma já tem um cartão provisório (leadId) e um contato. Telefone e nome são dado de paciente: use só para acompanhar o atendimento.',
  };
  if (us.length > 1) {
    const ok = Object.entries(res).filter(([, v]) => v.ok);
    const agrupado: Record<string, number> = {};
    for (const [, v] of ok) for (const [k, n] of Object.entries((v.agrupado as Record<string, number>) ?? {})) agrupado[k] = (agrupado[k] ?? 0) + n;
    r.rede = {
      total: ok.reduce((s, [, v]) => s + Number(v.total), 0),
      unidadesSomadas: ok.map(([k]) => k),
      ...(Object.keys(agrupado).length
        ? { agrupado: Object.fromEntries(Object.entries(agrupado).sort(por === 'dia' || por === 'mes' ? (x, y) => x[0].localeCompare(y[0]) : (x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))) }
        : {}),
      ...(ok.length < us.length ? { unidadesForaDoTotal: Object.entries(res).filter(([, v]) => !v.ok).map(([k]) => k) } : {}),
      ...(ok.some(([, v]) => v.truncado) ? { unidadesIncompletas: ok.filter(([, v]) => v.truncado).map(([k]) => k) } : {}),
    };
  }
  r.porUnidade = res;
  return r;
}

/**
 * O que `kommo_leads` acrescenta por unidade: quantas conversas estão na caixa de entrada no período. Nunca derruba o `kommo_leads`:
 * se a caixa não puder ser lida, diz isso em vez de calar (calar parece «não tem nada na entrada»).
 */
async function naEntradaDaUnidade(ctx: ContextoKommo, u: UnidadeKommo, inicio: string, fim: string): Promise<Record<string, unknown>> {
  if (!u.fonte.entrada) return {};
  if (u.divisao) {
    return { naEntrada: null, avisoEntrada: 'Conta dividida entre unidades: a caixa «Leads de entrada» é da conta toda e não se separa por unidade, então não foi contada.' };
  }
  // o RESULTADO é que vai pro cache (leitura truncada ou com erro também): senão cada kommo_leads refaria até 4 páginas que falham ou que não terminam
  const chave = `na-entrada|${contaDe(u)}|${inicio}|${fim}`;
  const guardado = ctx.cache.pegar<Record<string, unknown>>(chave);
  if (guardado !== undefined) return guardado;
  let r: Record<string, unknown>;
  let ttl: number = TTL.busca;
  try {
    const { itens, truncado } = await entradaDoPeriodo(ctx, u, inicio, fim);
    const n = itens.length;
    r = {
      naEntrada: n,
      ...(truncado ? { naEntradaTruncado: true } : {}),
      ...(n || truncado
        ? {
            avisoEntrada:
              `${truncado ? 'No mínimo ' : ''}${n} conversa(s) do período estão na caixa «Leads de entrada», NÃO aceitas: não entram em total nem em itens acima. ` +
              'Lead que ninguém aceitou continua sendo lead — use kommo_entrada para listá-las antes de concluir que «quase não entra lead».',
          }
        : {}),
    };
  } catch (e) {
    ttl = 60_000; // erro passageiro não pode valer 10 minutos
    r = {
      naEntrada: null,
      avisoEntrada: 'Não consegui ler a caixa «Leads de entrada» agora: o total acima NÃO inclui as conversas não aceitas (veja naEntradaErro).',
      naEntradaErro: e instanceof Error ? e.message : String(e),
    };
  }
  ctx.cache.guardar(chave, r, ttl);
  return r;
}

export async function kommoFunis(ctx: ContextoKommo, a: { unidade: string | string[] }) {
  const us = resolverUnidadesKommo(ctx, a.unidade);
  const res = await porUnidade(ctx, us, async (u) => {
    const funis = await comCache(ctx, `funis-lista|${contaDe(u)}`, HORA, () => u.fonte.funis());
    return { funis: funis.filter((f) => !f.is_archive).map((f) => ({ id: f.id, nome: f.name, principal: !!f.is_main, etapas: f.statuses.map((s) => ({ id: s.id, nome: s.name })) })) };
  });
  return { porUnidade: res };
}

function umaUnidade(ctx: ContextoKommo, unidade: string): UnidadeKommo {
  const us = resolverUnidadesKommo(ctx, unidade);
  if (us.length !== 1 || unidade.trim().toLowerCase() === 'todas') throw new ErroDeEntrada('informe UMA unidade');
  return us[0] as UnidadeKommo;
}

export async function kommoLead(ctx: ContextoKommo, a: { unidade: string; leadId: number }) {
  const u = umaUnidade(ctx, a.unidade);
  const [lead, etapas, usuarios] = await Promise.all([u.fonte.lead(a.leadId), nomesDasEtapas(ctx, u), nomesDosUsuarios(ctx, u)]);
  return { unidade: u.slug, ...conferirDono(u, lead), lead: legivel(lead, u.fuso, etapas, usuarios) };
}

export async function kommoBuscarTelefone(ctx: ContextoKommo, a: { unidade: string; telefone: string }) {
  const u = umaUnidade(ctx, a.unidade);
  if (a.telefone.replace(/\D/g, '').length < 8) throw new ErroDeEntrada('telefone com menos de 8 dígitos');
  const [todos, etapas, usuarios] = await Promise.all([u.fonte.leadsPorTelefone(a.telefone), nomesDasEtapas(ctx, u), nomesDosUsuarios(ctx, u)]);
  // conta dividida: os da outra unidade saem da lista (a resposta diz quantos e onde pedir); os sem dono ficam, avisados
  const daOutra = new Map<string, number>();
  const leads: Array<{ lead: KommoLead; semDono?: string }> = [];
  for (const l of todos) {
    const d = donoDoCartao(u, l);
    if (d.tipo === 'outra') daOutra.set(d.slug, (daOutra.get(d.slug) ?? 0) + 1);
    else leads.push({ lead: l, ...(d.tipo === 'ninguem' ? { semDono: motivoSemDono(u, d.valor) } : {}) });
  }
  return {
    unidade: u.slug,
    total: leads.length,
    ...(daOutra.size ? { deOutraUnidade: Object.fromEntries(daOutra), avisoOutraUnidade: `há cartões deste telefone em outra unidade: peça com unidade=${[...daOutra.keys()].join(' ou ')}` } : {}),
    leads: leads.map(({ lead: l, semDono }) => ({
      ...legivel(l, u.fuso, etapas, usuarios),
      ...(u.divisao ? { unidadeDeAtendimento: rotuloDoCartao(l) } : {}),
      ...(semDono ? { avisoUnidade: semDono } : {}),
    })),
  };
}

// ── registro no MCP ──

const unidade = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .describe('unidade: slug inteiro ou nome curto ("serra"), uma lista deles, ou "todas"');
const data = (o: string) => z.string().describe(`${o}, AAAA-MM-DD, no dia local da unidade`);

function quandoLocal(d: Date, fuso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
}

const ANEXO: Record<string, string> = { voice: 'áudio', audio: 'áudio', picture: 'imagem', image: 'imagem', video: 'vídeo', file: 'arquivo', document: 'documento', sticker: 'figurinha', location: 'localização', contact: 'contato' };

/**
 * 403 do Kommo na leitura da conversa. Só o corpo do erro separa as duas causas (mesma regra do freio em `kommo.service`):
 * - "Invalid scope": o token da conta não tem a permissão de chats. Medido em out/2026, 243 das 249 falhas de 14 dias (Parauapebas 144,
 *   Imperatriz 99); repetir não adianta, o conserto é um token novo da conta e é do João. O cartão (kommo_lead) abre nessas contas.
 * - sem a marca: pode ser bloqueio por excesso de chamadas ou cartão sem acesso. As outras 6 falhas (Serra, Açailândia) são assim, e
 *   as duas contas leem conversas normalmente com o mesmo token (637 e 682 leituras ok), então aqui NÃO se culpa o token.
 * A exceção original segue em `cause`, e o status e a rota vão no fim do texto, que é o que a auditoria grava.
 */
export function explicar403DaConversa(e: unknown, unidade: string): unknown {
  const status = e instanceof Error && e.name === 'KommoApiError' ? (e as { status?: number }).status : undefined;
  if (status !== 403) return e;
  const detalhe = `[Kommo: ${(e as Error).message}]`;
  const texto = eh403DeEscopo((e as { responseBody?: unknown }).responseBody)
    ? `O Kommo de ${unidade} recusou a leitura da conversa (403): o token dessa conta não tem a permissão de conversas (chats). ` +
      'Não é erro do seu pedido e repetir não adianta; quem resolve é o João, gerando um token novo da conta com a permissão de conversas. ' +
      'Enquanto isso o cartão abre (kommo_lead), mas as mensagens do WhatsApp não vêm por aqui.'
    : `O Kommo de ${unidade} recusou a leitura da conversa (403) e o conector não identificou a causa: o corpo da resposta não diz que falta permissão, ` +
      'então pode ser bloqueio temporário por excesso de chamadas ou um cartão sem acesso.';
  return new Error(`${texto} ${detalhe}`, { cause: e });
}

/**
 * A conversa de UM lead, como o WhatsApp a vê: cada mensagem marcada como paciente, Sofia ou equipe.
 * É conversa de saúde — por isso um lead por chamada, nunca a unidade inteira; cada consulta fica no
 * registro do conector com o usuário que pediu.
 */
export async function kommoConversa(ctx: ContextoKommo, a: { unidade: string; leadId: number; limite?: number; todas?: boolean; inicio?: string; fim?: string }) {
  const [u] = resolverUnidadesKommo(ctx, a.unidade, 1);
  if (!u!.fonte.conversa) throw new ErroDeEntrada('esta conta do Kommo não tem a leitura de conversa ligada');
  if (a.inicio) validarData(a.inicio, 'inicio');
  if (a.fim) validarData(a.fim, 'fim');
  if (a.inicio && a.fim && a.fim < a.inicio) throw new ErroDeEntrada('fim antes do início');
  const comPeriodo = !!(a.inicio || a.fim);
  // "todas" e período trazem até o teto; sem eles, as 30 mais recentes (ou o limite pedido)
  const limite = Math.min(Math.max(a.todas || (comPeriodo && a.limite == null) ? TETO_HISTORICO : a.limite ?? 30, 1), TETO_HISTORICO);
  const periodo = {
    ...(a.inicio ? { desde: epochDoDiaLocal(a.inicio, u!.fuso) } : {}),
    ...(a.fim ? { ate: epochDoDiaLocal(a.fim, u!.fuso, true) } : {}),
  };
  const lerConversa = u!.fonte.conversa.bind(u!.fonte);
  // 403 do Kommo na conversa: em português e dizendo de quem é o conserto, não "Request failed with status code 403"
  const conversa: typeof lerConversa = (...args) => lerConversa(...args).catch((e: unknown) => { throw explicar403DaConversa(e, u!.slug); });
  let lead: KommoLead;
  let conv: Awaited<ReturnType<typeof conversa>>;
  let dono: ReturnType<typeof conferirDono> = {};
  if (u!.divisao) {
    // conta dividida: o cartão primeiro — a conversa de um paciente da outra unidade nem é baixada
    lead = await u!.fonte.lead(a.leadId);
    dono = conferirDono(u!, lead);
    conv = await conversa(a.leadId, limite, periodo);
  } else {
    [lead, conv] = await Promise.all([u!.fonte.lead(a.leadId), conversa(a.leadId, limite, periodo)]);
  }
  // os nomes vêm do mesmo cache do resto (a chave `funis|` guarda o mapa pipeline:etapa → nome)
  let etapa: string | number = lead.status_id;
  try {
    etapa = (await nomesDasEtapas(ctx, u!)).get(`${lead.pipeline_id}:${lead.status_id}`)?.etapa ?? lead.status_id;
  } catch {
    // sem os nomes, a etapa sai pelo id
  }
  return {
    unidade: u!.slug,
    ...dono,
    lead: { id: lead.id, nome: lead.name, etapa, situacao: situacaoDoLead(lead) },
    conversas: conv.conversas,
    ...(comPeriodo ? { periodo: { inicio: a.inicio ?? null, fim: a.fim ?? null } } : {}),
    mostrando: conv.mensagens.length,
    ...(conv.truncado
      ? { ficaramDeFora: `há mensagens mais antigas que não vieram (vieram as ${conv.mensagens.length} mais recentes); peça todas=true (até ${TETO_HISTORICO}) ou um período (inicio/fim)` }
      : {}),
    mensagens: conv.mensagens.map((m) => ({
      quando: quandoLocal(m.em, u!.fuso),
      quem: m.autor,
      // o Kommo marca todo robô igual: a transmissão e a Sofia só se separam pelo nome de quem enviou
      ...(m.autor !== 'paciente' && m.autorNome ? { remetente: m.autorNome } : {}),
      texto: m.texto || (m.anexo ? `[${ANEXO[m.anexo.tipo] ?? m.anexo.tipo}]` : '[mensagem vazia]'),
      ...(m.texto && m.anexo ? { anexo: ANEXO[m.anexo.tipo] ?? m.anexo.tipo } : {}),
    })),
    aviso: 'Conversa de saúde de paciente: use só para acompanhar o atendimento. Esta consulta ficou registrada com o seu usuário.',
  };
}

const TIPO_DA_NOTA: Record<string, string> = {
  common: 'nota',
  service_message: 'aviso de integração',
  extended_service_message: 'aviso de integração',
  call_in: 'ligação recebida',
  call_out: 'ligação feita',
  sms_in: 'SMS recebido',
  sms_out: 'SMS enviado',
  attachment: 'anexo',
  geolocation: 'localização',
};

const ENTIDADE: Record<string, string> = { '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'", '&#039;': "'", '&nbsp;': ' ' };

/** O Kommo devolve o texto da nota com HTML escapado (`&quot;Preciso remarcar&quot;`). */
export function textoDaNota(n: NotaKommo): string {
  const p = n.params ?? {};
  const texto = (p.text ?? '').replace(/&(quot|amp|lt|gt|#0?39|nbsp);/g, (e) => ENTIDADE[e] ?? e).trim();
  if (texto) return texto;
  if (p.original_name) return `[anexo: ${p.original_name}]`;
  if (p.phone) return `[${p.phone}${p.duration ? `, ${p.duration} s` : ''}]`;
  return '[sem texto]';
}

export const TETO_NOTAS = 500;

/**
 * As notas internas de UM cartão — resumo para a SDR, avisos dos robôs, anotações da equipe —, das mais recentes.
 * Como a conversa, é dado de saúde: um cartão por chamada, e a consulta fica no registro do conector.
 */
export async function kommoNotas(ctx: ContextoKommo, a: { unidade: string; leadId: number; limite?: number; inicio?: string; fim?: string }) {
  const [u] = resolverUnidadesKommo(ctx, a.unidade, 1);
  if (!u!.fonte.notas) throw new ErroDeEntrada('esta conta do Kommo não tem a leitura de notas ligada');
  if (a.inicio) validarData(a.inicio, 'inicio');
  if (a.fim) validarData(a.fim, 'fim');
  if (a.inicio && a.fim && a.fim < a.inicio) throw new ErroDeEntrada('fim antes do início');
  const comPeriodo = !!(a.inicio || a.fim);
  const limite = Math.min(Math.max(a.limite ?? (comPeriodo ? TETO_NOTAS : 30), 1), TETO_NOTAS);
  const periodo = {
    ...(a.inicio ? { desde: epochDoDiaLocal(a.inicio, u!.fuso) } : {}),
    ...(a.fim ? { ate: epochDoDiaLocal(a.fim, u!.fuso, true) } : {}),
  };
  // conta dividida: o cartão primeiro — as notas de um paciente da outra unidade nem são baixadas
  const lead = await u!.fonte.lead(a.leadId);
  const dono = u!.divisao ? conferirDono(u!, lead) : {};
  const [lidas, usuarios] = await Promise.all([
    u!.fonte.notas(a.leadId, limite, periodo),
    nomesDosUsuarios(ctx, u!).catch(() => new Map<number, string>()),
  ]);
  return {
    unidade: u!.slug,
    ...dono,
    lead: { id: lead.id, nome: lead.name, situacao: situacaoDoLead(lead) },
    ...(comPeriodo ? { periodo: { inicio: a.inicio ?? null, fim: a.fim ?? null } } : {}),
    mostrando: lidas.notas.length,
    ...(lidas.truncado ? { ficaramDeFora: `há notas mais antigas que não vieram; peça um limite maior (até ${TETO_NOTAS}) ou um período (inicio/fim)` } : {}),
    notas: lidas.notas.map((n) => ({
      quando: quandoLocal(new Date(n.created_at * 1000), u!.fuso),
      tipo: TIPO_DA_NOTA[n.note_type] ?? n.note_type,
      autor: n.created_by ? usuarios.get(n.created_by) ?? `usuário ${n.created_by}` : 'robô/integração',
      texto: textoDaNota(n),
    })),
    aviso: 'Notas de cartão de paciente: use só para acompanhar o atendimento. Esta consulta ficou registrada com o seu usuário.',
  };
}

export function registrarFerramentasKommo(server: McpServer, ctx: ContextoKommo, auditar?: Auditar): void {
  const ro = { readOnlyHint: true, openWorldHint: true };
  server.registerTool(
    'kommo_leads',
    {
      title: 'Kommo: leads do período',
      description:
        'Leads do CRM Kommo (o comercial da unidade) criados — ou mexidos, com data="atualizacao" — no período. Cada lead vem com ' +
        'funil, etapa, situação (aberto/ganho/perdido), origem, responsável, etiquetas e campos. Use agruparPor pra contar: ' +
        '"etapa", "funil", "situacao", "origem", "responsavel", "tag", "dia" ou o nome de um campo do cartão. ' +
        `Até ${MAX_UNIDADES_KOMMO} unidades por chamada (o Kommo divide a fila com o atendimento da Sofia). "rede" soma só as que responderam. ` +
        '"truncado" = passou de 1.000 leads na unidade, o total é um mínimo. Os campos do cartão (queixa, resumo…) só vêm com comCampos=true. ' +
        '"naEntrada" = conversas do período paradas na caixa «Leads de entrada», NÃO aceitas: não entram no total — veja kommo_entrada.',
      inputSchema: {
        unidade,
        inicio: data('início do período'),
        fim: data('fim do período, incluso'),
        data: z.enum(['criacao', 'atualizacao']).optional().describe('qual data filtra (padrão: criacao)'),
        agruparPor: z.string().optional(),
        maxItens: z.number().int().min(0).max(100).optional().describe('leads devolvidos por unidade (padrão 30 com uma unidade, 0 com várias)'),
        comCampos: z.boolean().optional().describe('inclui os campos do cartão em cada lead (padrão: não)'),
      },
      annotations: ro,
    },
    (args) => executar('kommo_leads', args, auditar, () => kommoLeads(ctx, args)),
  );
  server.registerTool(
    'kommo_entrada',
    {
      title: 'Kommo: caixa «Leads de entrada» (conversas não aceitas)',
      description:
        'As conversas que estão na caixa «Leads de entrada» do Kommo (unsorted) e NINGUÉM aceitou ainda. Elas NÃO aparecem em kommo_leads ' +
        '(a API de leads não devolve os não aceitos): numa conta com a entrada parada, kommo_leads mostra poucos leads e esta ferramenta mostra o resto. ' +
        'Só leitura: nada é aceito, recusado ou movido. Período pela data em que a conversa ENTROU na caixa (dia local da unidade). ' +
        'Cada item: leadId (o cartão provisório da conversa), contatoId, nome, telefone, canal (whatsapp, waba…), origem (nome da fonte no Kommo, ex. o WhatsApp conectado), ' +
        'recebidoEm (hora local), funil e link do cartão. agruparPor: "dia", "mes", "origem", "canal" ou "funil". ' +
        'O texto das mensagens não vem aqui: para ler a conversa de um item use kommo_conversa com o leadId (e kommo_lead / kommo_notas no mesmo número); ' +
        'esses três leem pelo número do cartão — se o Kommo recusar um cartão ainda não aceito, o nome, o telefone e a data desta lista são o que há. ' +
        `Até ${MAX_UNIDADES_KOMMO} unidades por chamada (o Kommo divide a fila com a Sofia); "rede" soma só as que responderam. ` +
        `O Kommo não filtra a caixa por data: a leitura vai do mais novo ao mais velho e "truncado" = parou em ${250 * 4} conversas antes do início do período (o total é um mínimo). ` +
        'Contas divididas entre duas unidades (Petrópolis/Caxias) são recusadas: a caixa é da conta toda. maxItens (padrão 30 com uma unidade, 0 com várias) e pular paginam a lista.',
      inputSchema: {
        unidade,
        inicio: data('início do período'),
        fim: data('fim do período, incluso'),
        agruparPor: z.enum(AGRUPAMENTOS_DA_ENTRADA).optional().describe('conta por dia, mes, origem, canal ou funil'),
        maxItens: z.number().int().min(0).max(100).optional().describe('conversas devolvidas por unidade (padrão 30 com uma unidade, 0 com várias)'),
        pular: z.number().int().min(0).optional().describe('quantas conversas pular antes de listar (para ver a próxima página)'),
      },
      annotations: ro,
    },
    (args) => executar('kommo_entrada', args, auditar, () => kommoEntrada(ctx, args)),
  );
  server.registerTool(
    'kommo_funis',
    {
      title: 'Kommo: funis e etapas',
      description: 'Os funis do Kommo da unidade e as etapas de cada um (nomes e ids). Use pra entender os nomes que aparecem em kommo_leads.',
      inputSchema: { unidade },
      annotations: ro,
    },
    (args) => executar('kommo_funis', args, auditar, () => kommoFunis(ctx, args)),
  );
  server.registerTool(
    'kommo_lead',
    {
      title: 'Kommo: um cartão',
      description: 'Um cartão (lead) do Kommo pelo id, com etapa, origem, responsável, etiquetas e campos. UMA unidade.',
      inputSchema: { unidade: z.string().min(1), leadId: z.number().int().positive() },
      annotations: ro,
    },
    (args) => executar('kommo_lead', args, auditar, () => kommoLead(ctx, args)),
  );
  server.registerTool(
    'kommo_buscar_telefone',
    {
      title: 'Kommo: cartões de um telefone',
      description: 'Os cartões do Kommo ligados a um telefone (com ou sem DDI/máscara). UMA unidade. Serve pra achar o cartão de um paciente da franquia.',
      inputSchema: { unidade: z.string().min(1), telefone: z.string().min(8) },
      annotations: ro,
    },
    (args) => executar('kommo_buscar_telefone', args, auditar, () => kommoBuscarTelefone(ctx, args)),
  );
  server.registerTool(
    'kommo_conversa',
    {
      title: 'Conversa do lead (WhatsApp no Kommo)',
      description:
        'As mensagens de UM lead (unidade + número do cartão), juntando todas as conversas dele no Kommo, em ordem, cada uma ' +
        'marcada como paciente, sofia (robôs: Sofia, transmissões, régua) ou equipe, com o nome de quem enviou. Áudio/imagem aparecem como [áudio]/[imagem]. ' +
        'Padrão: as 30 mais recentes; todas=true traz o histórico inteiro (até 500); inicio/fim filtram um período. ' +
        'Um lead por chamada: é conversa de saúde, e cada consulta fica registrada com o usuário. Para achar o número do cartão, use ' +
        'kommo_buscar_telefone ou kommo_leads.',
      inputSchema: {
        unidade: z.string().min(1).describe('UMA unidade: slug ou nome curto ("serra")'),
        leadId: z.number().int().positive().describe('número do cartão (lead) no Kommo'),
        limite: z.number().int().min(1).max(500).optional().describe('quantas mensagens, das mais recentes (padrão 30, máx. 500)'),
        todas: z.boolean().optional().describe('o histórico inteiro do lead, até 500 mensagens; avisa se ficou algo de fora'),
        inicio: z.string().optional().describe('só mensagens a partir deste dia, AAAA-MM-DD (dia local da unidade)'),
        fim: z.string().optional().describe('só mensagens até este dia, AAAA-MM-DD'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executar('kommo_conversa', args, auditar, () => kommoConversa(ctx, args)),
  );
  server.registerTool(
    'kommo_notas',
    {
      title: 'Notas internas do cartão (Kommo)',
      description:
        'As notas internas de UM lead (unidade + número do cartão), das mais recentes: resumo da Sofia para a SDR, avisos dos ' +
        'robôs (sinal de alerta, paciente insistiu com a IA pausada, franquia…), anotações da equipe e registros de ligação. ' +
        'Cada nota vem com quando, tipo, autor (nome do usuário, ou "robô/integração") e texto. ' +
        `Padrão: as 30 mais recentes; limite até ${TETO_NOTAS}; inicio/fim filtram um período. Um lead por chamada — é dado de saúde, ` +
        'e cada consulta fica registrada com o usuário. Para achar o número do cartão, use kommo_buscar_telefone ou kommo_leads.',
      inputSchema: {
        unidade: z.string().min(1).describe('UMA unidade: slug ou nome curto ("serra")'),
        leadId: z.number().int().positive().describe('número do cartão (lead) no Kommo'),
        limite: z.number().int().min(1).max(TETO_NOTAS).optional().describe(`quantas notas, das mais recentes (padrão 30, máx. ${TETO_NOTAS})`),
        inicio: z.string().optional().describe('só notas a partir deste dia, AAAA-MM-DD (dia local da unidade)'),
        fim: z.string().optional().describe('só notas até este dia, AAAA-MM-DD'),
      },
      annotations: ro,
    },
    (args) => executar('kommo_notas', args, auditar, () => kommoNotas(ctx, args)),
  );
}
