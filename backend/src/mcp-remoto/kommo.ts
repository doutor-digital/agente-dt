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
import type { KommoLead, KommoPipeline } from '../services/kommo.service.js';
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
}

export interface UnidadeKommo {
  slug: string;
  nome: string;
  fuso: string;
  /** todos os slugs que usam esta conta (principal + resgate + …): o banco guarda vínculo e conversa por eles */
  slugsDaFranquia: string[];
  fonte: FonteKommo;
}

export interface ContextoKommo {
  unidades: Map<string, UnidadeKommo>;
  cache: Cache;
  paralelo: number;
  /** páginas de 250 leads por consulta */
  maxPaginas: number;
}

export function criarContextoKommo(unidades: Map<string, UnidadeKommo>, op: { paralelo?: number; maxPaginas?: number; agora?: () => number } = {}): ContextoKommo {
  return { unidades, cache: new Cache(op.agora), paralelo: op.paralelo ?? 2, maxPaginas: op.maxPaginas ?? 4 };
}

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
  const v = await fn();
  if (!(v as { truncado?: unknown })?.truncado) ctx.cache.guardar(chave, v, ttl);
  return v;
}

const HORA = 3_600_000;

/** `pipeline:status` → nomes. 142 e 143 são "ganho" e "perdido" em toda conta do Kommo. */
async function nomesDasEtapas(ctx: ContextoKommo, u: UnidadeKommo): Promise<Map<string, { funil: string; etapa: string }>> {
  return comCache(ctx, `funis|${u.slug}`, HORA, async () => {
    const m = new Map<string, { funil: string; etapa: string }>();
    for (const p of await u.fonte.funis()) for (const s of p.statuses) m.set(`${p.id}:${s.id}`, { funil: p.name, etapa: s.name });
    return m;
  });
}

async function nomesDosUsuarios(ctx: ContextoKommo, u: UnidadeKommo): Promise<Map<number, string>> {
  return comCache(ctx, `usuarios|${u.slug}`, HORA, async () => new Map((await u.fonte.usuarios()).map((x) => [x.id, x.name])));
}

export async function leadsDoPeriodo(
  ctx: ContextoKommo,
  u: UnidadeKommo,
  inicio: string,
  fim: string,
  campo: 'created_at' | 'updated_at' = 'created_at',
): Promise<{ leads: KommoLead[]; truncado: boolean }> {
  const de = epochDoDiaLocal(inicio, u.fuso);
  const ate = epochDoDiaLocal(fim, u.fuso, true);
  return comCache(ctx, `leads|${u.slug}|${campo}|${inicio}|${fim}`, TTL.busca, () => u.fonte.leadsNaJanela(campo, de, ate, ctx.maxPaginas));
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
  const chave = `tels|${u.slug}|${[...contatoDoLead.values()].sort((a, b) => a - b).join(',')}`;
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

/** Atalhos pros campos do rastreio de campanha (n8n `rastreio-campanhas`, "Origem – Campanha"…). */
const ATALHOS: Record<string, string> = {
  campanha: 'Origem – Campanha',
  conjunto: 'Origem – Conjunto',
  anuncio: 'Origem – Anúncio',
  plataforma: 'Origem – Plataforma',
  utm_source: 'Origem – utm_source',
  utm_campaign: 'Origem – utm_campaign',
};

/** Em que grupo o lead cai: `origem`, um atalho do rastreio (`campanha`, `anuncio`…) ou o nome de um campo. */
export function grupoDoLead(lead: KommoLead, por: string): string {
  const p = semMarcas(por);
  if (p === 'origem') return origemDoLead(lead);
  const campo = ATALHOS[p.replace(/ /g, '_')] ?? por;
  return campoChamado(lead, campo) || `(sem ${p})`;
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
      const alvo = semMarcas(ATALHOS[p.replace(/ /g, '_')] ?? por);
      const [, valor] = Object.entries(l.campos ?? {}).find(([k]) => semMarcas(k) === alvo) ?? [];
      return [valor || `(sem ${p})`];
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

// ── as consultas ──

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
    const [{ leads, truncado }, etapas, usuarios] = await Promise.all([
      leadsDoPeriodo(ctx, u, a.inicio, a.fim, a.data === 'atualizacao' ? 'updated_at' : 'created_at'),
      nomesDasEtapas(ctx, u),
      nomesDosUsuarios(ctx, u),
    ]);
    // agrupar por campo do cartão precisa dos campos; a resposta só os leva com comCampos
    const completos = leads.map((l) => legivel(l, u.fuso, etapas, usuarios, true));
    const itens = a.comCampos ? completos : leads.map((l) => legivel(l, u.fuso, etapas, usuarios, false));
    return {
      total: itens.length,
      ...(truncado ? { truncado: true, aviso: `INCOMPLETO: parou em ${ctx.maxPaginas * 250} leads. O total é um mínimo.` } : {}),
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
    };
  }
  r.porUnidade = res;
  return r;
}

export async function kommoFunis(ctx: ContextoKommo, a: { unidade: string | string[] }) {
  const us = resolverUnidadesKommo(ctx, a.unidade);
  const res = await porUnidade(ctx, us, async (u) => {
    const funis = await comCache(ctx, `funis-lista|${u.slug}`, HORA, () => u.fonte.funis());
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
  return { unidade: u.slug, lead: legivel(lead, u.fuso, etapas, usuarios) };
}

export async function kommoBuscarTelefone(ctx: ContextoKommo, a: { unidade: string; telefone: string }) {
  const u = umaUnidade(ctx, a.unidade);
  if (a.telefone.replace(/\D/g, '').length < 8) throw new ErroDeEntrada('telefone com menos de 8 dígitos');
  const [leads, etapas, usuarios] = await Promise.all([u.fonte.leadsPorTelefone(a.telefone), nomesDasEtapas(ctx, u), nomesDosUsuarios(ctx, u)]);
  return { unidade: u.slug, total: leads.length, leads: leads.map((l) => legivel(l, u.fuso, etapas, usuarios)) };
}

// ── registro no MCP ──

const unidade = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .describe('unidade: slug inteiro ou nome curto ("serra"), uma lista deles, ou "todas"');
const data = (o: string) => z.string().describe(`${o}, AAAA-MM-DD, no dia local da unidade`);

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
        '"truncado" = passou de 1.000 leads na unidade, o total é um mínimo. Os campos do cartão (queixa, resumo…) só vêm com comCampos=true.',
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
}
