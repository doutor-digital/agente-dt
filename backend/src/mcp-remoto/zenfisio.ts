/**
 * ZenFisio (gestão da clínica de fisioterapia do Instituto Trauma) no conector — fatia 1: unidades e AGENDA. Só leitura.
 *
 * A conta do ZenFisio entra pelo painel de integrações como uma "chave" JSON (ver `lib/integracoes/zenfisio.ts`) numa unidade do
 * conector; dentro do ZenFisio a clínica é uma ENTIDADE (`entityId`) e toda leitura vai em /entity/{entityId}/...
 *
 * Leitura ao vivo com cache, como o Tiquetaque, e não um espelho noturno: o Instituto Trauma usa o ZenFisio desde out/2026, o volume
 * cabe com folga em 60 req/min. A agenda pagina de 25 em 25: com o teto padrão de 40 páginas, 1.000 agendamentos por chamada — passou
 * disso, a resposta sai com `truncado` e o período deve ser dividido.
 *
 * Dado pessoal: a agenda traz o NOME do paciente (é a agenda da clínica). O `comment` do agendamento NÃO sai: é texto livre da
 * recepção e pode carregar queixa, diagnóstico ou telefone. Áudio do atendimento também não. CPF, diagnóstico e dados bancários
 * ficam na ficha do paciente, que esta fatia não lê.
 *
 * Bloqueios de horário (`block_schedules`/`blocking_reason`) não são consulta: saem da contagem por padrão e aparecem só em
 * `bloqueiosIgnorados`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { Cache } from '../franquia-mcp/ritmo.js';
import { ErroDeEntrada, diasNoPeriodo, validarData } from '../franquia-mcp/travas.js';
import { normalizar } from './convenia.js';
import { executar } from './ferramenta.js';
import { acharSlug } from './unidades.js';

export interface FonteZenfisio {
  /** GET relativo a /api/v1 */
  get<T>(caminho: string, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
  /** a unidade do ZenFisio desta conta (da chave, ou descoberta em /units) */
  entityId(): Promise<number>;
}

export interface ContaZenfisio {
  slug: string;
  nome: string;
  fonte: FonteZenfisio;
}

export interface ContextoZenfisio {
  contas: Map<string, ContaZenfisio>;
  cache: Cache;
  /** páginas de 25 por chamada de ferramenta */
  maxPaginas: number;
  agora: () => number;
}

export function criarContextoZenfisio(
  contas: Map<string, ContaZenfisio>,
  op: { maxPaginas?: number; agora?: () => number } = {},
): ContextoZenfisio {
  const agora = op.agora ?? Date.now;
  return { contas, cache: new Cache(agora, 500), maxPaginas: op.maxPaginas ?? 40, agora };
}

/** agenda: até ~3 meses por chamada */
export const MAX_DIAS_AGENDA = 93;
const FUSO = 'America/Sao_Paulo';
const TTL_AGENDA = 5 * 60_000; // muda a cada atendimento marcado como Atendido/Faltou
const TTL_UNIDADES = 6 * 3_600_000;

export function resolverContaZenfisio(ctx: ContextoZenfisio, alvo: string | undefined): ContaZenfisio {
  if (ctx.contas.size === 0) throw new ErroDeEntrada('nenhuma unidade com o ZenFisio ligado ainda (cadastre a chave no painel de integrações).');
  const com = [...ctx.contas.keys()].join(', ');
  if (!alvo || !alvo.trim()) {
    if (ctx.contas.size === 1) return [...ctx.contas.values()][0]!;
    throw new ErroDeEntrada(`diga a unidade. Com ZenFisio: ${com}`);
  }
  const slug = acharSlug(ctx.contas.keys(), alvo);
  if (!slug) throw new ErroDeEntrada(`unidade sem ZenFisio, desconhecida ou ambígua: ${alvo}. Com ZenFisio: ${com}`);
  return ctx.contas.get(slug)!;
}

/** Hoje no fuso da clínica, AAAA-MM-DD. */
export function hojeNoFuso(agora: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(agora));
}

// ----------------------------------------------------------------- formato bruto (só o que lemos)

/** Um agendamento como /entity/{id}/appointments devolve. */
export interface AgendamentoBruto {
  id: number;
  date?: string | null; // "2026-11-06 00:00:00"
  start?: string | null; // "09:00:00"
  end?: string | null;
  contact_id?: number | null;
  contact_name?: string | null;
  user_id?: number | null;
  user_name?: string | null;
  status_id?: number | null;
  status_name?: string | null;
  agreement_name?: string | null;
  procedure_name?: string | null;
  room_name?: string | null;
  appointment_package_id?: number | null;
  appointment_package_name?: string | null;
  confirmed?: number | boolean | null;
  repetition?: string | null;
  block_schedules?: number | boolean | null;
  blocking_reason?: string | null;
  professional_archived?: number | boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
  [outro: string]: unknown;
}

interface PaginaLaravel<T> {
  current_page?: number;
  last_page?: number;
  total?: number;
  data?: T[] | null;
}

export interface Agendamento {
  id: number;
  data: string | null;
  inicio: string | null;
  fim: string | null;
  minutos: number | null;
  status: string;
  statusId: number | null;
  confirmado: boolean;
  profissional: string | null;
  profissionalId: number | null;
  profissionalArquivado: boolean;
  paciente: string | null;
  pacienteId: number | null;
  convenio: string | null;
  procedimento: string | null;
  sala: string | null;
  pacote: string | null;
  pacoteId: number | null;
  recorrente: boolean;
  criadoEm: string | null;
  alteradoEm: string | null;
}

const hhmm = (h: string | null | undefined) => (typeof h === 'string' && /^\d{2}:\d{2}/.test(h) ? h.slice(0, 5) : null);
const sim = (v: unknown) => v === true || v === 1 || v === '1';

function minutosEntre(ini: string | null, fim: string | null): number | null {
  if (!ini || !fim) return null;
  const [h1, m1] = ini.split(':').map(Number);
  const [h2, m2] = fim.split(':').map(Number);
  const d = (h2! * 60 + m2!) - (h1! * 60 + m1!);
  return Number.isFinite(d) && d >= 0 ? d : null;
}

export function ehBloqueio(a: AgendamentoBruto): boolean {
  return sim(a.block_schedules) || (typeof a.blocking_reason === 'string' && a.blocking_reason.trim() !== '');
}

/** Só os campos da agenda; `comment`, áudio e o resto ficam de fora (ver cabeçalho). */
export function agendamentoNormalizado(a: AgendamentoBruto): Agendamento {
  const inicio = hhmm(a.start);
  const fim = hhmm(a.end);
  return {
    id: a.id,
    data: typeof a.date === 'string' ? a.date.slice(0, 10) : null,
    inicio,
    fim,
    minutos: minutosEntre(inicio, fim),
    status: (a.status_name ?? '').trim() || 'sem status',
    statusId: a.status_id ?? null,
    confirmado: sim(a.confirmed),
    profissional: a.user_name ?? null,
    profissionalId: a.user_id ?? null,
    profissionalArquivado: sim(a.professional_archived),
    paciente: a.contact_name ?? null,
    pacienteId: a.contact_id ?? null,
    convenio: a.agreement_name ?? null,
    procedimento: a.procedure_name ?? null,
    sala: a.room_name ?? null,
    pacote: a.appointment_package_name ?? null,
    pacoteId: a.appointment_package_id ?? null,
    recorrente: typeof a.repetition === 'string' && a.repetition !== '',
    criadoEm: a.created_at ?? null,
    alteradoEm: a.updated_at ?? null,
  };
}

const statusChave = (s: string) => normalizar(s).trim();

/**
 * Desfecho de um agendamento pelo nome do status. Medido no Instituto Trauma (06/11/2026): Atendido, Faltou, "Faltou (com aviso
 * prévio)", "Faltou (sem aviso prévio)", Cancelado, "Não atendido" e Agendado. Todo status que COMEÇA com "faltou" é falta (a 1ª
 * versão só contava "Faltou" puro e dava 6,9% onde o certo era 27,7%). Cancelado e Não atendido não são falta: têm contagem própria.
 * Status desconhecido cai em "outro" e aparece no resumo, para nunca sumir da conta sem aviso.
 */
export type Desfecho = 'atendido' | 'falta' | 'cancelado' | 'naoAtendido' | 'emAberto' | 'outro';
export function desfecho(status: string): Desfecho {
  const s = statusChave(status);
  if (/^(atendido|compareceu|realizado)\b/.test(s)) return 'atendido';
  if (/^(faltou|falta)\b/.test(s) || s === 'nao compareceu') return 'falta';
  if (/^(cancelad|desmarcad)/.test(s)) return 'cancelado';
  if (/^nao atendid/.test(s)) return 'naoAtendido';
  if (/^(agendad|confirmad|aguardando|em atendimento|sem status)/.test(s)) return 'emAberto';
  return 'outro';
}
/** "com aviso" / "sem aviso" dentro do status de falta. */
function tipoDeFalta(status: string): 'comAviso' | 'semAviso' | 'semDetalhe' {
  const s = statusChave(status);
  if (s.includes('sem aviso')) return 'semAviso';
  if (s.includes('com aviso')) return 'comAviso';
  return 'semDetalhe';
}

/** Lê as páginas da agenda do período, até o teto. */
async function lerAgenda(
  ctx: ContextoZenfisio,
  conta: ContaZenfisio,
  inicio: string,
  fim: string,
  ocultarArquivados: boolean,
): Promise<{ itens: AgendamentoBruto[]; total: number | null; truncado: boolean; paginas: number }> {
  const chave = `zf:agenda:${conta.slug}:${inicio}:${fim}:${ocultarArquivados}`;
  const guardado = ctx.cache.pegar<{ itens: AgendamentoBruto[]; total: number | null; truncado: boolean; paginas: number }>(chave);
  if (guardado) return guardado;
  const entity = await conta.fonte.entityId();
  const itens: AgendamentoBruto[] = [];
  let total: number | null = null;
  let ultima = 1;
  let pagina = 1;
  for (; pagina <= ctx.maxPaginas; pagina++) {
    const resp = await conta.fonte.get<PaginaLaravel<AgendamentoBruto>>(`/entity/${entity}/appointments`, {
      start_date: inicio,
      end_date: fim,
      page: pagina,
      hide_archived_professionals: ocultarArquivados ? 'true' : undefined,
    });
    if (!resp || typeof resp !== 'object' || !Array.isArray(resp.data)) {
      throw new Error('o ZenFisio devolveu a agenda num formato desconhecido (sem "data"): não dá para afirmar que está vazia');
    }
    itens.push(...resp.data);
    if (typeof resp.total === 'number') total = resp.total;
    ultima = typeof resp.last_page === 'number' && resp.last_page > 0 ? resp.last_page : pagina;
    if (pagina >= ultima || resp.data.length === 0) break;
  }
  const truncado = pagina > ctx.maxPaginas || (pagina === ctx.maxPaginas && ultima > pagina);
  const out = { itens, total, truncado, paginas: Math.min(pagina, ctx.maxPaginas) };
  if (!truncado) ctx.cache.guardar(chave, out, TTL_AGENDA); // leitura incompleta não vai para o cache
  return out;
}

export interface ArgsAgenda {
  unidade?: string;
  inicio: string;
  fim: string;
  profissional?: string;
  status?: string;
  paciente?: string;
  comPacote?: boolean;
  pacote?: string;
  ocultarArquivados?: boolean;
  incluirBloqueios?: boolean;
  agruparPor?: 'status' | 'profissional' | 'dia' | 'convenio' | 'procedimento' | 'pacote' | 'mes';
  maxItens?: number;
}

function contar<T>(itens: T[], chave: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of itens) {
    const k = chave(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/** Desfechos do que já aconteceu (dias até hoje) e a taxa de falta = faltas ÷ (atendidos + faltas). */
function comparecimento(itens: Agendamento[], hoje: string) {
  const passados = itens.filter((a) => a.data !== null && a.data <= hoje);
  const de = (d: Desfecho) => passados.filter((a) => desfecho(a.status) === d);
  const atendidos = de('atendido').length;
  const faltasLista = de('falta');
  const faltas = faltasLista.length;
  const base = atendidos + faltas;
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
  const outros = de('outro');
  return {
    atendidos,
    faltas,
    faltasPorTipo: {
      comAviso: faltasLista.filter((a) => tipoDeFalta(a.status) === 'comAviso').length,
      semAviso: faltasLista.filter((a) => tipoDeFalta(a.status) === 'semAviso').length,
      semDetalhe: faltasLista.filter((a) => tipoDeFalta(a.status) === 'semDetalhe').length,
    },
    cancelados: de('cancelado').length,
    naoAtendidos: de('naoAtendido').length,
    taxaDeFalta: pct(faltas, base),
    // dia passado ainda Agendado/Confirmado: a recepção não fechou o status
    passadosSemDesfecho: de('emAberto').length,
    ...(outros.length ? { outrosStatus: contar(outros, (x) => x.status) } : {}),
    regra:
      'taxaDeFalta = faltas ÷ (atendidos + faltas), em %, só de dias até hoje; falta = todo status que começa com "Faltou". ' +
      'Cancelado e Não atendido ficam fora da taxa e têm contagem própria. passadosSemDesfecho = dia passado ainda Agendado/Confirmado.',
  };
}

export async function zenfisioAgenda(ctx: ContextoZenfisio, a: ArgsAgenda) {
  validarData(a.inicio, 'inicio');
  validarData(a.fim, 'fim');
  if (a.inicio > a.fim) throw new ErroDeEntrada('inicio depois de fim');
  const dias = diasNoPeriodo(a.inicio, a.fim);
  if (dias > MAX_DIAS_AGENDA) throw new ErroDeEntrada(`peça até ${MAX_DIAS_AGENDA} dias por chamada (pediu ${dias}); divida o período`);
  const conta = resolverContaZenfisio(ctx, a.unidade);
  const lido = await lerAgenda(ctx, conta, a.inicio, a.fim, a.ocultarArquivados ?? false);

  const bloqueios = lido.itens.filter(ehBloqueio);
  const brutos = a.incluirBloqueios ? lido.itens : lido.itens.filter((x) => !ehBloqueio(x));
  let itens = brutos.map(agendamentoNormalizado);
  // a API filtra pela data mas pode devolver a borda: corta no período pedido
  itens = itens.filter((x) => x.data === null || (x.data >= a.inicio && x.data <= a.fim));

  const casa = (valor: string | null, pedido: string | undefined) => !pedido || (valor !== null && normalizar(valor).includes(normalizar(pedido)));
  itens = itens.filter(
    (x) =>
      casa(x.profissional, a.profissional) &&
      casa(x.paciente, a.paciente) &&
      casa(x.pacote, a.pacote) &&
      (!a.status || statusChave(x.status) === statusChave(a.status) || statusChave(x.status).includes(statusChave(a.status))) &&
      (a.comPacote === undefined || (x.pacoteId !== null) === a.comPacote),
  );
  itens.sort((x, y) => `${x.data ?? ''} ${x.inicio ?? ''}`.localeCompare(`${y.data ?? ''} ${y.inicio ?? ''}`) || x.id - y.id);

  const hoje = hojeNoFuso(ctx.agora());
  const resumo = {
    agendamentos: itens.length,
    pacientesDiferentes: new Set(itens.map((x) => x.pacienteId ?? x.paciente)).size,
    porStatus: contar(itens, (x) => x.status),
    comPacote: itens.filter((x) => x.pacoteId !== null).length,
    ...comparecimento(itens, hoje),
  };

  const grupo: Record<NonNullable<ArgsAgenda['agruparPor']>, (x: Agendamento) => string> = {
    status: (x) => x.status,
    profissional: (x) => x.profissional ?? 'sem profissional',
    dia: (x) => x.data ?? 'sem data',
    mes: (x) => (x.data ?? 'sem data').slice(0, 7),
    convenio: (x) => x.convenio ?? 'sem convênio',
    procedimento: (x) => x.procedimento ?? 'sem procedimento',
    pacote: (x) => x.pacote ?? 'sem pacote',
  };
  let grupos: unknown;
  if (a.agruparPor) {
    const porChave = new Map<string, Agendamento[]>();
    for (const x of itens) {
      const k = grupo[a.agruparPor](x);
      porChave.set(k, [...(porChave.get(k) ?? []), x]);
    }
    grupos = [...porChave]
      .map(([chave, lista]) => ({
        [a.agruparPor!]: chave,
        agendamentos: lista.length,
        porStatus: contar(lista, (x) => x.status),
        minutosAtendidos: lista.filter((x) => desfecho(x.status) === 'atendido').reduce((s, x) => s + (x.minutos ?? 0), 0),
        ...(() => {
          const c = comparecimento(lista, hoje);
          return { atendidos: c.atendidos, faltas: c.faltas, cancelados: c.cancelados, naoAtendidos: c.naoAtendidos, taxaDeFalta: c.taxaDeFalta };
        })(),
      }))
      .sort((p, q) => q.agendamentos - p.agendamentos);
  }

  const max = a.maxItens ?? (a.agruparPor ? 0 : 200);
  return {
    unidade: conta.slug,
    periodo: { inicio: a.inicio, fim: a.fim, dias },
    resumo,
    ...(grupos ? { grupos } : {}),
    itens: itens.slice(0, max),
    itensOmitidos: Math.max(itens.length - max, 0),
    bloqueiosIgnorados: a.incluirBloqueios ? 0 : bloqueios.length,
    ...(lido.truncado
      ? { truncado: true, aviso: `a agenda passou de ${ctx.maxPaginas * 25} registros e foi cortada: divida o período. Os números acima estão INCOMPLETOS.` }
      : {}),
    lidoDaApi: { paginas: lido.paginas, totalInformado: lido.total },
  };
}

export async function zenfisioUnidades(ctx: ContextoZenfisio) {
  if (ctx.contas.size === 0) throw new ErroDeEntrada('nenhuma unidade com o ZenFisio ligado ainda (cadastre a chave no painel de integrações).');
  const out = [];
  for (const conta of ctx.contas.values()) {
    const chave = `zf:unidades:${conta.slug}`;
    let lido = ctx.cache.pegar<{ entityId: number; unidades: Array<{ id: number; nome: string | null; principal: boolean }> }>(chave);
    if (!lido) {
      try {
        const entityId = await conta.fonte.entityId();
        const unidades = await conta.fonte.get<Array<{ id: number; name?: string | null; is_main_entity?: number | null }>>('/units');
        lido = {
          entityId,
          unidades: (Array.isArray(unidades) ? unidades : []).map((u) => ({ id: Number(u.id), nome: u.name ?? null, principal: sim(u.is_main_entity) })),
        };
        ctx.cache.guardar(chave, lido, TTL_UNIDADES);
      } catch (e) {
        out.push({ unidade: conta.slug, nome: conta.nome, ok: false, erro: e instanceof Error ? e.message : String(e) });
        continue;
      }
    }
    out.push({ unidade: conta.slug, nome: conta.nome, ok: true, entityIdUsado: lido.entityId, unidadesDaConta: lido.unidades });
  }
  return { contas: out };
}

// ----------------------------------------------------------------- registro

const unidade = z
  .string()
  .optional()
  .describe('unidade do conector com ZenFisio (slug ou nome curto). Opcional quando só uma unidade tem ZenFisio. Veja listar_integracoes.');
const data = (o: string) => z.string().describe(`${o}, AAAA-MM-DD`);

export function registrarFerramentasZenfisio(server: McpServer, ctx: ContextoZenfisio, auditar?: Auditar): void {
  const ro = { readOnlyHint: true, openWorldHint: true };
  server.registerTool(
    'zenfisio_unidades',
    {
      title: 'Unidades com ZenFisio',
      description:
        'Quais unidades do conector têm o ZenFisio (gestão de clínica de fisioterapia, ex. Instituto Trauma) ligado, o entityId usado e as ' +
        'unidades que existem dentro da conta do ZenFisio. Use para conferir a conexão.',
      inputSchema: {},
      annotations: ro,
    },
    (args) => executar('zenfisio_unidades', args, auditar, () => zenfisioUnidades(ctx)),
  );
  server.registerTool(
    'zenfisio_agenda',
    {
      title: 'Agenda da clínica (ZenFisio)',
      description:
        'Agendamentos do ZenFisio num período (pela DATA DA CONSULTA, até 93 dias por chamada): paciente, profissional, horário, status ' +
        '(Agendado, Atendido, Faltou com/sem aviso, Cancelado, Não atendido…), convênio, procedimento, sala e pacote de tratamento. O resumo traz contagem por status, atendidos, ' +
        'faltas (todo status "Faltou…", separado em com aviso, sem aviso e sem detalhe), cancelados, não atendidos, taxa de falta (faltas ÷ (atendidos + faltas), só de dias até hoje) e agendamentos de dias passados ainda em aberto. ' +
        'Use agruparPor="profissional" para ocupação e falta por profissional, "dia"/"mes" para evolução. Bloqueios de horário não contam. ' +
        'Traz o NOME do paciente; o comentário livre do agendamento não sai. A consulta fica registrada na auditoria.',
      inputSchema: {
        unidade,
        inicio: data('primeiro dia'),
        fim: data('último dia (incluso)'),
        profissional: z.string().optional().describe('parte do nome do profissional'),
        status: z.string().optional().describe('status do agendamento, ex. "Faltou", "Atendido", "Agendado"'),
        paciente: z.string().optional().describe('parte do nome do paciente'),
        comPacote: z.boolean().optional().describe('true: só sessões de pacote de tratamento; false: só avulsas'),
        pacote: z.string().optional().describe('parte do nome do pacote'),
        ocultarArquivados: z.boolean().optional().describe('esconde agendamentos de profissionais arquivados'),
        incluirBloqueios: z.boolean().optional().describe('inclui os bloqueios de horário (padrão: não)'),
        agruparPor: z.enum(['status', 'profissional', 'dia', 'mes', 'convenio', 'procedimento', 'pacote']).optional(),
        maxItens: z.number().int().min(0).max(1000).optional().describe('quantos agendamentos listar (padrão 200; 0 com agruparPor = só os números)'),
      },
      annotations: ro,
    },
    (args) => executar('zenfisio_agenda', args, auditar, () => zenfisioAgenda(ctx, args as ArgsAgenda)),
  );
}
