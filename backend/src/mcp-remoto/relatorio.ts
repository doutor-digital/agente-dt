/**
 * `relatorio_funil`: franquia + Kommo + nosso banco numa resposta só, com o cruzamento feito em
 * CÓDIGO (funil.ts) — o Claude só narra. É a peça que faz os sistemas "conversarem".
 *
 * Por unidade e período:
 *  1. Kommo: leads criados no período, com origem;
 *  2. telefone de cada lead: o do CONTATO no Kommo (a fonte; pega quem nunca falou com a IA) e,
 *     na falta, o da conversa com a IA; mais o vínculo do sincronizador com a franquia;
 *  3. franquia: pacientes cadastrados desde 180 dias antes do período (WhatsApp), agenda e
 *     tratamentos do início do período até hoje;
 *  4. cruzarFunil → leads → viraram paciente → agendaram → compareceram → fecharam tratamento.
 * E, separado, o que a franquia registrou NO período, venha de onde vier (recepção, indicação…).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as franquia from '../franquia-mcp/consultas.js';
import type { Contexto } from '../franquia-mcp/contexto.js';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { diaLocal } from '../franquia-mcp/normalizar.js';
import { emParalelo } from '../franquia-mcp/ritmo.js';
import { ErroDeEntrada, validarData } from '../franquia-mcp/travas.js';
import { executar } from './ferramenta.js';
import { compareceu, cruzarFunil, type AgendamentoDaFranquia, type LeadDoFunil } from './funil.js';
import { type ContextoKommo, grupoDoLead, leadsDoPeriodo, telefonesDosLeads as telefonesDoKommo } from './kommo.js';
import { hojeNoFuso } from './tempo.js';
import { diasNoPeriodo, somarDias } from '../franquia-mcp/travas.js';
import { acharSlug } from './unidades.js';

/** Cada unidade lê pacientes + agenda + tratamentos da franquia: limite por chamada pra não pesar nela. */
export const MAX_UNIDADES_POR_RELATORIO = 4;
/** período de até ~3 meses, começando nos últimos 6: cada relatório lê a franquia do início até hoje */
export const MAX_DIAS_PERIODO = 92;
export const MAX_DIAS_ATRAS = 180;
/** pacientes cadastrados até esta antecedência do período entram no casamento (quem volta depois de anos fica de fora) */
const DIAS_DE_CADASTRO_ANTES = 180;
const TUDO = 1_000_000;

/** dia local de um item da franquia: o campo `…Local` quando houver hora; senão a data crua */
function diaDoItem(item: Res, campo: string): string {
  return String(item[`${campo}Local`] ?? item[campo] ?? '').slice(0, 10);
}

export interface DepsRelatorio {
  franquia: Contexto;
  kommo: ContextoKommo;
  /** telefone de cada lead pelas conversas com a IA (`slugs`: todos os slugs da franquia — principal, resgate…). Reserva do telefone do contato. */
  telefonesDosLeads(slugs: string[], leadIds: number[]): Promise<Map<number, string>>;
  /** idClient da franquia de cada lead, pelo vínculo do sincronizador */
  vinculosDosLeads(slugs: string[], leadIds: number[]): Promise<Map<number, number>>;
  agora?: () => Date;
}

type Res = Record<string, unknown>;

function itensDe(r: Res, slug: string): { itens: Res[]; truncado: boolean; erro?: string } {
  const u = (r.porUnidade as Record<string, Res>)[slug];
  if (!u?.ok) return { itens: [], truncado: false, erro: String(u?.erro ?? 'sem resposta') };
  return { itens: u.itens as Res[], truncado: !!u.truncado };
}

async function umaUnidade(deps: DepsRelatorio, slug: string, inicio: string, fim: string, agruparPor: string): Promise<Res> {
  const ku = deps.kommo.unidades.get(slug);
  const fu = deps.franquia.unidades.get(slug);
  if (!ku) throw new Error('unidade sem Kommo conectado: não há leads pra cruzar');
  const avisos: string[] = [];
  const hoje = hojeNoFuso(ku.fuso, deps.agora?.());

  // 1–2. Kommo + banco
  const { leads, truncado } = await leadsDoPeriodo(deps.kommo, ku, inicio, fim, 'created_at');
  if (truncado) avisos.push(`o Kommo tem mais de ${deps.kommo.maxPaginas * 250} leads no período: o funil considera só esses`);
  const ids = leads.map((l) => l.id);
  const [doKommo, daConversa, vinculos] = await Promise.all([
    telefonesDoKommo(deps.kommo, ku, leads).catch((e: unknown) => {
      avisos.push(`telefones dos contatos do Kommo não vieram (${e instanceof Error ? e.message : String(e)}): usei só o das conversas com a IA`);
      return new Map<number, string>();
    }),
    deps.telefonesDosLeads(ku.slugsDaFranquia, ids),
    deps.vinculosDosLeads(ku.slugsDaFranquia, ids),
  ]);
  const leadsDoFunil: LeadDoFunil[] = leads.map((l) => ({
    id: l.id,
    criadoEm: diaLocal(new Date((l.created_at ?? 0) * 1000).toISOString(), ku.fuso) ?? inicio,
    origem: grupoDoLead(l, agruparPor),
    telefones: [doKommo.get(l.id), daConversa.get(l.id)].filter((t): t is string => !!t),
    idClientVinculo: vinculos.get(l.id) ?? null,
  }));

  if (!fu) {
    avisos.push('unidade sem token da franquia: só os números do Kommo');
    return { leadsNoKommo: leads.length, avisos };
  }

  // 3. franquia — do início do período até hoje (quem virou lead em setembro pode ter consultado em outubro)
  const ate = hoje > fim ? hoje : fim;
  const [pac, ag, tr] = await Promise.all([
    franquia.buscarPacientes(deps.franquia, { unidade: slug, maxItens: TUDO, criadosDesde: somarDias(inicio, -DIAS_DE_CADASTRO_ANTES) }),
    franquia.buscarAgendamentos(deps.franquia, { unidade: slug, inicio, fim: ate, maxItens: TUDO }),
    franquia.buscarTratamentos(deps.franquia, { unidade: slug, inicio, fim: ate, maxItens: TUDO }),
  ]);
  const pacientes = itensDe(pac, slug);
  const agenda = itensDe(ag, slug);
  const tratamentos = itensDe(tr, slug);
  for (const [nome, x] of [['pacientes', pacientes], ['agenda', agenda], ['tratamentos', tratamentos]] as const) {
    if (x.erro) throw new Error(`franquia não respondeu (${nome}): ${x.erro}`);
    if (x.truncado) avisos.push(`a leitura de ${nome} da franquia veio incompleta: as etapas podem estar abaixo do real`);
  }

  const agendaDoFunil: AgendamentoDaFranquia[] = agenda.itens.map((a) => ({
    nomePaciente: String(a.clientName ?? ''),
    dia: diaDoItem(a, 'dateAttendance'),
    status: String(a.statusName ?? ''),
    idStatus: typeof a.idStatus === 'number' ? a.idStatus : null,
  }));
  const funil = cruzarFunil({
    leads: leadsDoFunil,
    pacientes: pacientes.itens.map((p) => ({
      idClient: Number(p.idClient),
      nome: String(p.name ?? ''),
      telefone: (p.whatsapp as string) ?? null,
      criadoEm: diaDoItem(p, 'created') || null,
    })),
    agenda: agendaDoFunil,
    tratamentos: tratamentos.itens.map((t) => ({
      idClient: typeof t.idClient === 'number' ? t.idClient : null,
      criado: diaDoItem(t, 'created'),
      preco: typeof t.price === 'number' ? t.price : null,
    })),
  });

  // o que a franquia registrou NO período, venha de onde vier
  const noPeriodo = agendaDoFunil.filter((a) => a.dia >= inicio && a.dia <= fim);
  const porStatus: Record<string, number> = {};
  for (const a of noPeriodo) porStatus[a.status || '(sem status)'] = (porStatus[a.status || '(sem status)'] ?? 0) + 1;
  const tratNoPeriodo = tratamentos.itens.filter((t) => {
    const d = diaDoItem(t, 'created');
    return d >= inicio && d <= fim;
  });
  if (funil.homonimosSemAgenda) avisos.push(`${funil.homonimosSemAgenda} paciente(s) com nome repetido no cadastro: a agenda deles não entrou (a agenda da franquia só tem o nome)`);

  return {
    funil,
    naFranquiaNoPeriodo: {
      agendamentos: noPeriodo.length,
      compareceram: noPeriodo.filter(compareceu).length,
      porStatus: Object.fromEntries(Object.entries(porStatus).sort((a, b) => b[1] - a[1])),
      tratamentosNovos: tratNoPeriodo.length,
      valorDosTratamentosNovos: Math.round(tratNoPeriodo.reduce((s, t) => s + (typeof t.price === 'number' ? t.price : 0), 0) * 100) / 100,
    },
    ...(avisos.length ? { avisos } : {}),
  };
}

const CAMPOS_SOMAVEIS = ['leads', 'viraramPaciente', 'agendaram', 'compareceram', 'fecharamTratamento', 'valorDosTratamentos'] as const;

export async function relatorioFunil(deps: DepsRelatorio, a: { unidade: string | string[]; inicio: string; fim: string; agruparPor?: string }) {
  validarData(a.inicio, 'inicio');
  validarData(a.fim, 'fim');
  if (a.inicio > a.fim) throw new ErroDeEntrada('inicio é depois do fim');
  if (diasNoPeriodo(a.inicio, a.fim) > MAX_DIAS_PERIODO) throw new ErroDeEntrada(`período de no máximo ${MAX_DIAS_PERIODO} dias por relatório (um trimestre); faça um por trimestre`);
  const hoje = hojeNoFuso('America/Sao_Paulo', deps.agora?.());
  if (a.inicio < somarDias(hoje, -MAX_DIAS_ATRAS)) {
    throw new ErroDeEntrada(`o relatório cruzado cobre os últimos ${MAX_DIAS_ATRAS} dias (a partir de ${somarDias(hoje, -MAX_DIAS_ATRAS)}): ele lê a franquia do início do período até hoje`);
  }
  const pedidos = Array.isArray(a.unidade) ? a.unidade : [a.unidade];
  const todosSlugs = new Set([...deps.kommo.unidades.keys(), ...deps.franquia.unidades.keys()]);
  if (pedidos.some((p) => p.trim().toLowerCase() === 'todas')) {
    throw new ErroDeEntrada(
      `o relatório cruzado lê bastante da franquia por unidade: peça até ${MAX_UNIDADES_POR_RELATORIO} por vez (chame de novo para as próximas). ` +
        `Unidades: ${[...todosSlugs].sort().join(', ')}`,
    );
  }
  const slugs = [...new Set(pedidos.map((p) => acharSlug(todosSlugs, p) ?? `?${p}`))];
  const desconhecidas = slugs.filter((s) => s.startsWith('?')).map((s) => s.slice(1));
  if (desconhecidas.length) throw new ErroDeEntrada(`unidade desconhecida ou ambígua: ${desconhecidas.join(', ')}. Válidas: ${[...todosSlugs].sort().join(', ')}`);
  if (slugs.length > MAX_UNIDADES_POR_RELATORIO) throw new ErroDeEntrada(`no máximo ${MAX_UNIDADES_POR_RELATORIO} unidades por chamada (pediu ${slugs.length})`);

  const pares = await emParalelo(slugs, 2, async (slug) => {
    try {
      return [slug, { ok: true, ...(await umaUnidade(deps, slug, a.inicio, a.fim, a.agruparPor ?? 'origem')) }] as const;
    } catch (e) {
      return [slug, { ok: false, erro: e instanceof Error ? e.message : String(e) }] as const;
    }
  });
  const porUnidade = Object.fromEntries(pares) as Record<string, Res>;

  const r: Res = {
    consultadoEm: new Date().toISOString(),
    periodo: { inicio: a.inicio, fim: a.fim },
    agrupadoPor: a.agruparPor ?? 'origem',
    comoLer:
      'funil = leads do Kommo criados no período e o que aconteceu com ELES na franquia (até hoje). "cobertura.semCasamento" são leads ' +
      'que não deu pra ligar a um paciente (sem telefone, ou telefone fora do cadastro): não quer dizer que não agendaram. ' +
      'naFranquiaNoPeriodo = tudo que a franquia registrou no período, inclusive quem não passou pelo Kommo.',
  };
  if (slugs.length > 1) {
    const ok = Object.entries(porUnidade).filter(([, v]) => v.ok && v.funil);
    const soma: Record<string, number> = {};
    for (const [, v] of ok) for (const c of CAMPOS_SOMAVEIS) soma[c] = (soma[c] ?? 0) + Number((v.funil as Record<string, number>)[c] ?? 0);
    r.rede = {
      ...soma,
      unidadesSomadas: ok.map(([k]) => k),
      ...(ok.length < slugs.length ? { unidadesForaDoTotal: Object.entries(porUnidade).filter(([, v]) => !v.ok || !v.funil).map(([k]) => k) } : {}),
    };
  }
  r.porUnidade = porUnidade;
  return r;
}

export function registrarRelatorio(server: McpServer, deps: DepsRelatorio, auditar?: Auditar): void {
  server.registerTool(
    'relatorio_funil',
    {
      title: 'Relatório cruzado: Kommo → franquia',
      description:
        'O funil cruzado de verdade, calculado em código: leads do Kommo criados no período → viraram paciente na franquia → agendaram → ' +
        'compareceram → fecharam tratamento (com valor), com taxas e COBERTURA do casamento (telefone ou vínculo). O detalhamento ' +
        '("porOrigem") é pela origem do lead, ou pelo que vier em agruparPor: "campanha", "conjunto" ou "anuncio" usam os campos que o ' +
        'rastreio de anúncios do WhatsApp grava no cartão ("Origem – Campanha"…) e casam com os nomes de campanha do Meta/Metricool. ' +
        'Traz também o que a franquia registrou no período (agendamentos por status, tratamentos novos). ' +
        `Até ${MAX_UNIDADES_POR_RELATORIO} unidades e ${MAX_DIAS_PERIODO} dias por chamada, nos últimos ${MAX_DIAS_ATRAS} dias; pra rede inteira, chame em lotes e some. ` +
        'Para alcance, cliques e gasto de anúncio, use o conector do Metricool e cruze com a "origem" daqui.',
      inputSchema: {
        unidade: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).describe('slug ou nome curto ("serra"), ou lista de até 4'),
        inicio: z.string().describe('início do período (criação do lead), AAAA-MM-DD'),
        fim: z.string().describe('fim do período, incluso, AAAA-MM-DD'),
        agruparPor: z
          .string()
          .optional()
          .describe('"origem" (padrão), "campanha", "conjunto", "anuncio", "plataforma", "utm_campaign" ou o nome de um campo do cartão'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executar('relatorio_funil', args, auditar, () => relatorioFunil(deps, args)),
  );
}
