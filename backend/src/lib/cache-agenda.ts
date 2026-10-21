/**
 * CACHE CURTO DA BUSCA DE HORÁRIOS (decisão do João, 21/10/2026).
 *
 * Cada `consultar_horarios` lista os horários do dia na franquia e SONDA até 4 deles: marca um agendamento de teste com
 * o paciente de sondagem e cancela em seguida, porque a API não enxerga bloqueio (agenda-tools.ts,
 * `horariosQueAFranquiaAceita`). É lento, pesa na franquia e, quando um cancelamento falha, sobra agendamento
 * fantasma. Conversas diferentes da mesma unidade repetiam a mesma busca minutos depois.
 *
 * AS REGRAS:
 *  - Vale por pouco tempo: CACHE_AGENDA_MIN, padrão 10 min (de 1 a 60).
 *  - A chave é unidade + DIA + turno pedido + a ASSINATURA da configuração da agenda (horário, almoço, dias, duração
 *    da sessão, janela por dia, profissional por turno — Taubaté manda o idStaff pelo horário — e fuso). Mudou a
 *    configuração, a chave muda e o guardado deixa de servir sozinho.
 *  - Fica numa TABELA do Postgres (`agenda_cache_dias`): há mais de uma cópia do servidor, e cache na memória de uma
 *    não serve para a outra. Não há Redis no stack.
 *  - Só guarda dia CONFIRMADO pela sondagem com pelo menos um horário. Erro da franquia, lista vazia e dia em que a
 *    sondagem recusou tudo nunca entram: a sondagem conta como "recusado" qualquer falha (um 500 também), então
 *    "nenhum aceito" pode ser a franquia fora do ar.
 *  - Na LEITURA sai o horário que já passou, no relógio da unidade (a mesma regra da grade, `buildAgenda`). Se não
 *    sobrar horário confirmado, é como se não houvesse nada guardado.
 *  - APAGA o dia quando a Sofia marca, remarca ou cancela, quando uma marcação falha (horário ocupado na grade ou
 *    recusado pela franquia) e quando a recepção bloqueia ou libera horário pela tela. Sem saber o dia, apaga a
 *    unidade toda.
 *
 * POR QUE A MARCA DE APAGADO. A busca de um dia leva segundos (até 8 idas à franquia). Se outra conversa marcar
 * nesse meio-tempo, o "apagar" chega ANTES de a busca gravar — e a busca gravaria um dia já velho. Por isso apagar
 * também grava uma marca com a hora; toda entrada consultada antes da marca mais nova do dia (ou da unidade) não
 * vale. A hora gravada na entrada é a do INÍCIO da busca, não a do fim.
 *
 * A HORA DA CONSULTA. O PR #104 carimba no resultado da ferramenta quando a agenda foi consultada, e o grafo
 * reconsulta quando a consulta tem mais de 3 h (horario-oferecido.ts). Vindo do cache, o carimbo é a hora em que a
 * FRANQUIA foi consultada (`consultadoEm` da entrada), não agora — senão a janela de 3 h se enganaria.
 *
 * A CHAVE `cache-agenda` (CACHE_AGENDA_SLUGS) nasce em "só no papel" na rede toda: a Sofia sempre consulta a
 * franquia, e o código só calcula se TERIA usado o cache — no log (uma linha "cache-agenda: …" por busca), no rastro
 * da execução e na lista da tela de Automações ("confere" = o cache teria acertado; "diverge" = teria oferecido
 * horário que a franquia já não aceita; "pularia" = não havia nada guardado que valesse). Ligada, usa o cache.
 * Desligada, nem lê nem grava (apagar continua valendo, para não sobrar entrada velha se alguém religar).
 */
import { createHash } from 'node:crypto';
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { registrarSimulacao, type Simulacao } from './so-no-papel.js';

export const AUTOMACAO_CACHE_AGENDA = 'cache-agenda';
export const VALIDADE_PADRAO_MIN = 10;
const VALIDADE_MAXIMA_MIN = 60;
/** `chave` da linha que marca "apagado a partir daqui". */
export const MARCA_APAGADO = '!apagado';
/** `dia` da marca que apaga a unidade toda (quando não se sabe o dia). */
export const UNIDADE_TODA = '*';
/** Entrada escrita por uma cópia com o relógio adiantado mais que isto não é confiável. */
const FOLGA_DE_RELOGIO_MS = 60_000;
/** Linha mais velha que isto já não serve para nada (a validade máxima é 60 min) e é varrida. */
const GUARDAR_POR_MS = 24 * 3600_000;
const VARRER_A_CADA_MS = 30 * 60_000;

export type Turno = 'manha' | 'tarde';

export function estadoDoCacheDaAgenda(slug: string, env: NodeJS.ProcessEnv = process.env): Estado {
  return estadoDaAutomacao(slug, AUTOMACAO_CACHE_AGENDA, env.CACHE_AGENDA_SLUGS);
}

/** Validade da entrada, em ms: CACHE_AGENDA_MIN (1 a 60), padrão 10 min. */
export function validadeDoCacheMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CACHE_AGENDA_MIN);
  const min = Number.isFinite(n) && n > 0 ? Math.min(VALIDADE_MAXIMA_MIN, Math.max(1, n)) : VALIDADE_PADRAO_MIN;
  return Math.round(min * 60_000);
}

/** O que a busca de UM dia produziu: a grade livre e o que a sondagem confirmou. Horas "HH:MM". */
export interface DiaConsultado {
  /** Livres na grade, todos os turnos. */
  todosLivres: string[];
  /** Livres no turno pedido. */
  livres: string[];
  /** Confirmados pela sondagem — o que a Sofia oferece. */
  oferecer: string[];
  recusados: string[];
  sondados: string[];
}

export interface EntradaDoCache extends DiaConsultado {
  /** Quando a franquia foi consultada (início da busca do dia). É a hora do carimbo do #104. */
  consultadoEm: Date;
}

type ConfigDaAgenda = Partial<
  Pick<
    Unit,
    | 'spineAgendaStart'
    | 'spineAgendaEnd'
    | 'spineLunchStart'
    | 'spineLunchEnd'
    | 'spineAgendaDays'
    | 'spineSlotMinutes'
    | 'spineDayHours'
    | 'spineStaffPorTurno'
    | 'spineTimezone'
  >
>;

/** PURA: o que na configuração da unidade muda o resultado da busca, resumido num hash curto. */
export function assinaturaDaAgenda(u: ConfigDaAgenda): string {
  const cfg = [
    u.spineAgendaStart ?? null,
    u.spineAgendaEnd ?? null,
    u.spineLunchStart ?? null,
    u.spineLunchEnd ?? null,
    [...(u.spineAgendaDays ?? [])].sort((a, b) => a - b),
    u.spineSlotMinutes ?? null,
    u.spineDayHours ?? null,
    u.spineStaffPorTurno ?? null,
    u.spineTimezone ?? null,
  ];
  return createHash('sha1').update(JSON.stringify(cfg)).digest('hex').slice(0, 12);
}

/** PURA: a `chave` da entrada — turno pedido ("dia" quando não pediu) + assinatura da configuração. */
export function chaveDoDia(turno: Turno | undefined, assinatura: string): string {
  return `${turno ?? 'dia'}:${assinatura}`;
}

export interface LinhaDoCache {
  dia: string;
  chave: string;
  resultado: unknown;
  consultadoEm: Date;
}

const ehListaDeHoras = (v: unknown): v is string[] => Array.isArray(v) && v.every((h) => typeof h === 'string' && /^\d{2}:\d{2}$/.test(h));

function lerResultado(v: unknown): DiaConsultado | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const campos = ['todosLivres', 'livres', 'oferecer', 'recusados', 'sondados'] as const;
  if (!campos.every((c) => ehListaDeHoras(o[c]))) return null;
  return {
    todosLivres: o.todosLivres as string[],
    livres: o.livres as string[],
    oferecer: o.oferecer as string[],
    recusados: o.recusados as string[],
    sondados: o.sondados as string[],
  };
}

export type PorQueNaoVale = 'sem_entrada' | 'vencida' | 'apagada' | 'ilegivel' | 'tudo_passou' | 'erro_ao_ler';

/**
 * PURA: das linhas lidas (a entrada do dia e as marcas do dia e da unidade), a entrada que ainda vale. Vale quem
 * tem até `validadeMs` de idade e foi consultada DEPOIS da marca de apagado mais nova.
 */
export function entradaQueVale(
  linhas: readonly LinhaDoCache[],
  dia: string,
  chave: string,
  agora: Date,
  validadeMs: number,
): { entrada: EntradaDoCache; idadeMs: number } | { entrada: null; motivo: PorQueNaoVale } {
  const e = linhas.find((l) => l.dia === dia && l.chave === chave);
  if (!e) return { entrada: null, motivo: 'sem_entrada' };
  const idadeMs = agora.getTime() - e.consultadoEm.getTime();
  if (idadeMs > validadeMs || idadeMs < -FOLGA_DE_RELOGIO_MS) return { entrada: null, motivo: 'vencida' };
  const apagada = linhas.some(
    (l) => l.chave === MARCA_APAGADO && (l.dia === dia || l.dia === UNIDADE_TODA) && l.consultadoEm.getTime() >= e.consultadoEm.getTime(),
  );
  if (apagada) return { entrada: null, motivo: 'apagada' };
  const r = lerResultado(e.resultado);
  if (!r) return { entrada: null, motivo: 'ilegivel' };
  return { entrada: { ...r, consultadoEm: e.consultadoEm }, idadeMs: Math.max(0, idadeMs) };
}

/**
 * PURA: tira o que já passou no relógio local da unidade ("AAAA-MM-DDTHH:MM[:SS]"). Mesma regra da grade
 * (`AgendaService.buildAgenda`): o horário vale enquanto "dia + hora" for DEPOIS de agora.
 */
export function semHorarioVencido<T extends DiaConsultado>(dia: string, d: T, agoraLocal: string): T {
  const agora = agoraLocal.length === 16 ? `${agoraLocal}:00` : agoraLocal;
  const vale = (h: string) => `${dia}T${h}:00` > agora;
  return {
    ...d,
    todosLivres: d.todosLivres.filter(vale),
    livres: d.livres.filter(vale),
    oferecer: d.oferecer.filter(vale),
    recusados: d.recusados.filter(vale),
    sondados: d.sondados.filter(vale),
  };
}

/** PURA: guarda só dia confirmado pela sondagem com pelo menos um horário — nunca erro nem lista vazia. */
export function vaiProCache(verificado: boolean, d: Pick<DiaConsultado, 'oferecer'>): boolean {
  return verificado && d.oferecer.length > 0;
}

/** O que a franquia disse agora sobre o mesmo dia (só no papel: comparar com o que o cache teria oferecido). */
export interface Fresco {
  livres: string[];
  recusados: string[];
  oferecer: string[];
}

/**
 * PURA: o que o cache teria oferecido e a franquia agora NÃO aceita — saiu da grade livre, ou a sondagem recusou.
 * Horário ainda livre na grade que a sondagem de agora não sorteou não conta: nada diz que ele está ocupado.
 */
export function oferecidosQueNaoValem(doCache: readonly string[], fresco: Fresco): string[] {
  return doCache.filter((h) => !fresco.livres.includes(h) || fresco.recusados.includes(h));
}

// ── onde as linhas moram ──────────────────────────────────────────────────────────────────────────

export interface DepositoDoCache {
  /** A entrada (dia, chave) e as marcas de apagado do dia e da unidade toda. */
  ler(unitId: string, dia: string, chave: string): Promise<LinhaDoCache[]>;
  gravar(unitId: string, dia: string, chave: string, resultado: DiaConsultado, consultadoEm: Date): Promise<void>;
  /** Apaga as entradas do dia (ou da unidade, com `UNIDADE_TODA`) e sobe a marca para `em` (nunca desce). */
  apagar(unitId: string, dia: string, em: Date): Promise<void>;
  varrer(antesDe: Date): Promise<void>;
}

const codigoDoErro = (err: unknown) => (err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined);

export const depositoNoBanco: DepositoDoCache = {
  ler: (unitId, dia, chave) =>
    prisma.agendaCacheDia.findMany({
      where: { unitId, dia: { in: [dia, UNIDADE_TODA] }, chave: { in: [chave, MARCA_APAGADO] } },
      select: { dia: true, chave: true, resultado: true, consultadoEm: true },
    }),
  gravar: async (unitId, dia, chave, resultado, consultadoEm) => {
    const r = { ...resultado };
    await prisma.agendaCacheDia.upsert({
      where: { unitId_dia_chave: { unitId, dia, chave } },
      create: { unitId, dia, chave, resultado: r, consultadoEm },
      update: { resultado: r, consultadoEm },
    });
  },
  apagar: async (unitId, dia, em) => {
    await prisma.agendaCacheDia.deleteMany({
      where: { unitId, chave: { not: MARCA_APAGADO }, ...(dia === UNIDADE_TODA ? {} : { dia }) },
    });
    // A marca só sobe: dois "apagar" quase juntos, gravados fora de ordem, não podem deixá-la mais velha.
    const subir = () =>
      prisma.agendaCacheDia.updateMany({
        where: { unitId, dia, chave: MARCA_APAGADO, consultadoEm: { lt: em } },
        data: { consultadoEm: em },
      });
    if ((await subir()).count > 0) return;
    try {
      await prisma.agendaCacheDia.create({ data: { unitId, dia, chave: MARCA_APAGADO, consultadoEm: em } });
    } catch (err) {
      if (codigoDoErro(err) !== 'P2002') throw err;
      await subir(); // outra cópia criou a marca no meio-tempo
    }
  },
  varrer: async (antesDe) => {
    await prisma.agendaCacheDia.deleteMany({ where: { consultadoEm: { lt: antesDe } } });
  },
};

/** O mesmo contrato do banco, na memória — para os testes e para ler como referência. */
export function depositoNaMemoria(): DepositoDoCache & { linhas: LinhaDoCache[] } {
  const linhas: LinhaDoCache[] = [];
  const achar = (dia: string, chave: string) => linhas.find((l) => l.dia === dia && l.chave === chave);
  return {
    linhas,
    ler: async (_unitId, dia, chave) =>
      linhas.filter((l) => (l.dia === dia || l.dia === UNIDADE_TODA) && (l.chave === chave || l.chave === MARCA_APAGADO)).map((l) => ({ ...l })),
    gravar: async (_unitId, dia, chave, resultado, consultadoEm) => {
      const l = achar(dia, chave);
      if (l) Object.assign(l, { resultado: { ...resultado }, consultadoEm });
      else linhas.push({ dia, chave, resultado: { ...resultado }, consultadoEm });
    },
    apagar: async (_unitId, dia, em) => {
      for (let i = linhas.length - 1; i >= 0; i--) {
        if (linhas[i].chave !== MARCA_APAGADO && (dia === UNIDADE_TODA || linhas[i].dia === dia)) linhas.splice(i, 1);
      }
      const m = achar(dia, MARCA_APAGADO);
      if (!m) linhas.push({ dia, chave: MARCA_APAGADO, resultado: null, consultadoEm: em });
      else if (m.consultadoEm < em) m.consultadoEm = em;
    },
    varrer: async (antesDe) => {
      for (let i = linhas.length - 1; i >= 0; i--) if (linhas[i].consultadoEm < antesDe) linhas.splice(i, 1);
    },
  };
}

export interface DepsDoCache {
  deposito: DepositoDoCache;
  agora: () => Date;
  env: NodeJS.ProcessEnv;
  registrar: (unit: { id: string; slug: string }, automacao: string, s: Simulacao) => void;
}

const DEPS_PADRAO: DepsDoCache = {
  deposito: depositoNoBanco,
  agora: () => new Date(),
  env: process.env,
  registrar: registrarSimulacao,
};
let depsAtuais: DepsDoCache = DEPS_PADRAO;

/** Só para teste: troca o banco, o relógio, o ambiente e o registro da tela. Sem argumento, volta ao padrão. */
export function _depsDoCacheParaTeste(over?: Partial<DepsDoCache>): void {
  depsAtuais = over ? { ...DEPS_PADRAO, ...over } : DEPS_PADRAO;
}

let ultimaVarrida = 0;

type UnidadeDoCache = Pick<Unit, 'id' | 'slug'> & ConfigDaAgenda;

// ── leitura ───────────────────────────────────────────────────────────────────────────────────────

export interface LeituraDoCache {
  modo: Estado;
  dia: string;
  /** 'hit' = havia o dia guardado, válido, com horário que ainda não passou. */
  teria: 'hit' | 'miss';
  motivo: PorQueNaoVale | null;
  /** A entrada já sem o que passou; só com 'hit'. */
  entrada: EntradaDoCache | null;
  idadeMin: number | null;
  /** Usar a entrada no lugar da franquia: só com a chave LIGADA. */
  usar: boolean;
}

/** Desligada, não lê nada (null). Nunca lança: banco fora do ar é "miss", e a busca vai à franquia como sempre. */
export async function lerDoCache(
  unit: UnidadeDoCache,
  dia: string,
  turno: Turno | undefined,
  agoraLocal: string,
): Promise<LeituraDoCache | null> {
  const deps = depsAtuais;
  const modo = estadoDoCacheDaAgenda(unit.slug, deps.env);
  if (modo === 'desligado') return null;
  const miss = (motivo: PorQueNaoVale): LeituraDoCache => ({ modo, dia, teria: 'miss', motivo, entrada: null, idadeMin: null, usar: false });
  const chave = chaveDoDia(turno, assinaturaDaAgenda(unit));
  let linhas: LinhaDoCache[];
  try {
    linhas = await deps.deposito.ler(unit.id, dia, chave);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, dia }, 'cache-agenda: não li o cache — vai à franquia');
    return miss('erro_ao_ler');
  }
  const v = entradaQueVale(linhas, dia, chave, deps.agora(), validadeDoCacheMs(deps.env));
  if (!v.entrada) return miss(v.motivo);
  const entrada = semHorarioVencido(dia, v.entrada, agoraLocal);
  if (entrada.oferecer.length === 0) return miss('tudo_passou');
  return {
    modo,
    dia,
    teria: 'hit',
    motivo: null,
    entrada,
    idadeMin: Math.round(v.idadeMs / 6_000) / 10,
    usar: modo === 'ligado',
  };
}

// ── gravação e apagamento ─────────────────────────────────────────────────────────────────────────

/** Guarda o dia (só confirmado, com horário). `consultadoEm` = início da busca. Nunca lança. */
export async function guardarNoCache(
  unit: UnidadeDoCache,
  dia: string,
  turno: Turno | undefined,
  d: DiaConsultado,
  verificado: boolean,
  consultadoEm: Date,
): Promise<boolean> {
  const deps = depsAtuais;
  if (estadoDoCacheDaAgenda(unit.slug, deps.env) === 'desligado') return false;
  if (!vaiProCache(verificado, d)) return false;
  const resultado: DiaConsultado = {
    todosLivres: [...d.todosLivres],
    livres: [...d.livres],
    oferecer: [...d.oferecer],
    recusados: [...d.recusados],
    sondados: [...d.sondados],
  };
  try {
    await deps.deposito.gravar(unit.id, dia, chaveDoDia(turno, assinaturaDaAgenda(unit)), resultado, consultadoEm);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, dia }, 'cache-agenda: não gravei o dia (segue sem cache)');
    return false;
  }
  const agora = deps.agora().getTime();
  if (agora - ultimaVarrida > VARRER_A_CADA_MS) {
    ultimaVarrida = agora;
    await deps.deposito.varrer(new Date(agora - GUARDAR_POR_MS)).catch(() => undefined);
  }
  return true;
}

/**
 * Apaga o dia de `quando` ("AAAA-MM-DD…"; sem dia, a unidade toda). Vale em qualquer estado da chave — apagar
 * nunca faz mal, e entrada velha não pode sobrar para quando alguém ligar. Nunca lança.
 */
export async function apagarDoCache(unit: { id: string; slug?: string }, quando: string | null | undefined, porque: string): Promise<void> {
  const deps = depsAtuais;
  const dia = /^\d{4}-\d{2}-\d{2}/.exec(quando ?? '')?.[0] ?? UNIDADE_TODA;
  try {
    await deps.deposito.apagar(unit.id, dia, deps.agora());
    logger.info({ unit: unit.slug ?? unit.id, dia, porque }, 'cache-agenda: apaguei');
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug ?? unit.id, dia, porque }, 'cache-agenda: não apaguei o dia');
  }
}

// ── a medida, uma por busca ───────────────────────────────────────────────────────────────────────

export interface MedidaDoCache {
  modo: Estado;
  teria: 'hit' | 'miss';
  usou: boolean;
  dia: string | null;
  idadeMin: number | null;
  motivo: PorQueNaoVale | null;
  /** Só no papel: o que o cache teria oferecido e a franquia agora não aceita. */
  naoValem: string[] | null;
}

const rotuloDoDia = (dia: string, turno: Turno | undefined) => {
  const [, m, d] = dia.split('-');
  return `horários de ${d}/${m}${turno ? ` (${turno === 'manha' ? 'manhã' : 'tarde'})` : ''}`;
};

/**
 * Acompanha UMA busca (`consultar_horarios`) dia a dia: lê o cache antes de cada dia, guarda o que a franquia
 * confirmou, e no fim registra uma linha só — "hit" ou "miss" — no log e, em "só no papel", na tela.
 *
 * Em "só no papel" a busca vai à franquia em todo dia, e o cache é lido até o PRIMEIRO dia que ele responderia: é
 * ali que a Sofia, com a chave ligada, teria parado. O que a franquia disser desse dia é comparado com o guardado.
 */
export function medidorDoCache(unit: UnidadeDoCache, ctx: { leadId?: number; turno?: Turno }) {
  const deps = depsAtuais;
  const modo = estadoDoCacheDaAgenda(unit.slug, deps.env);
  let acerto: { leitura: LeituraDoCache; fresco?: Fresco | null } | null = null;
  const motivoDoDia = new Map<string, PorQueNaoVale>();
  let fechado = false;

  return {
    modo,
    /** Antes de buscar o dia. `null` = desligada, ou já houve acerto nesta busca. */
    async ler(dia: string, agoraLocal: string): Promise<LeituraDoCache | null> {
      if (modo === 'desligado' || acerto) return null;
      const l = await lerDoCache(unit, dia, ctx.turno, agoraLocal);
      if (l?.teria === 'hit') acerto = { leitura: l };
      else if (l?.motivo) motivoDoDia.set(dia, l.motivo);
      return l;
    },
    /** O que a franquia disse do dia (null = não respondeu). Só importa para o dia do acerto, em "só no papel". */
    franquia(dia: string, fresco: Fresco | null): void {
      if (acerto && acerto.leitura.dia === dia && acerto.fresco === undefined) acerto.fresco = fresco;
    },
    guardar(dia: string, d: DiaConsultado, verificado: boolean, consultadoEm: Date): Promise<boolean> {
      if (modo === 'desligado') return Promise.resolve(false);
      return guardarNoCache(unit, dia, ctx.turno, d, verificado, consultadoEm);
    },
    /** O que vai no payload do rastro do dia. */
    rastro(l: LeituraDoCache | null) {
      return l ? { modo: l.modo, teria: l.teria, motivo: l.motivo, idadeMin: l.idadeMin, usou: l.usar } : { modo };
    },
    /** Fecha a medida: uma linha de log e, só no papel, uma na tela. `diaOferecido` = o dia que a busca devolveu. */
    fim(diaOferecido: string | null): MedidaDoCache | null {
      if (modo === 'desligado' || fechado) return null;
      fechado = true;
      const a = acerto as { leitura: LeituraDoCache; fresco?: Fresco | null } | null;
      const naoValem = a && modo === 'seco' && a.fresco ? oferecidosQueNaoValem(a.leitura.entrada?.oferecer ?? [], a.fresco) : null;
      const medida: MedidaDoCache = a
        ? { modo, teria: 'hit', usou: a.leitura.usar, dia: a.leitura.dia, idadeMin: a.leitura.idadeMin, motivo: null, naoValem }
        : { modo, teria: 'miss', usou: false, dia: diaOferecido, idadeMin: null, motivo: (diaOferecido && motivoDoDia.get(diaOferecido)) || 'sem_entrada', naoValem: null };
      logger.info(
        { unit: unit.slug, leadId: ctx.leadId ?? null, turno: ctx.turno ?? null, ...medida },
        medida.teria === 'hit'
          ? `cache-agenda: hit${medida.usou ? ' (usado)' : ' (só no papel)'}`
          : `cache-agenda: miss${modo === 'seco' ? ' (só no papel)' : ''}`,
      );
      if (modo === 'seco' && ctx.leadId) registrarNoPapel(unit, ctx.leadId, ctx.turno, medida, a);
      return medida;
    },
  };
}

function registrarNoPapel(
  unit: UnidadeDoCache,
  leadId: number,
  turno: Turno | undefined,
  m: MedidaDoCache,
  acerto: { leitura: LeituraDoCache; fresco?: Fresco | null } | null,
): void {
  const deps = depsAtuais;
  const dia = m.dia;
  if (!dia) {
    deps.registrar(unit, AUTOMACAO_CACHE_AGENDA, {
      leadId,
      acao: 'pularia',
      alvo: 'horários (sem vaga)',
      motivo: 'a busca não achou vaga — não havia busca guardada que valesse; foi à franquia',
    });
    return;
  }
  if (m.teria === 'miss' || !acerto?.leitura.entrada) {
    deps.registrar(unit, AUTOMACAO_CACHE_AGENDA, {
      leadId,
      acao: 'pularia',
      alvo: rotuloDoDia(dia, turno),
      motivo: `não havia busca guardada que valesse (${m.motivo ?? 'sem_entrada'}) — teria ido à franquia`,
    });
    return;
  }
  const doCache = acerto.leitura.entrada.oferecer.join(', ');
  const agora = acerto.fresco ? acerto.fresco.oferecer.join(', ') || 'nenhum confirmado' : 'a franquia não respondeu';
  const diverge = (m.naoValem ?? []).length > 0;
  deps.registrar(unit, AUTOMACAO_CACHE_AGENDA, {
    leadId,
    acao: diverge ? 'diverge' : 'confere',
    alvo: rotuloDoDia(dia, turno),
    valor: doCache,
    noCartao: agora,
    motivo: diverge
      ? `teria usado a busca de há ${m.idadeMin} min — ${(m.naoValem ?? []).join(', ')} já não está livre na franquia`
      : `teria usado a busca de há ${m.idadeMin} min sem ir à franquia`,
  });
}
