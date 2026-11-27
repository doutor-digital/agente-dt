/**
 * Histórico das MUDANÇAS de status da agenda da franquia (26/11/2026) — a base da lista de recuperação e da medição do retorno.
 *
 * Por que existe: a franquia só devolve o ESTADO ATUAL de cada agendamento (e só o último `modified`). Quando um agendamento vira
 * DESMARCADO, ou NÃO COMPARECEU, ou volta a AGENDADO, o estado de antes se perde — e sem ele não dá para saber quando o paciente
 * desmarcou, nem se voltou a marcar DEPOIS de a recepção ter sido avisada. A cópia do Dash (`spine_schedule_snapshot`) só olha 7 dias
 * para trás, sobrescreve e não guarda o futuro.
 *
 * Como: a varredura que o sincronizador JÁ faz da agenda da franquia (de −3 a +45 dias, a cada 15 min) entrega a lista aqui. Nenhuma
 * chamada nova à franquia. Compara cada agendamento com o ÚLTIMO evento que gravamos e só acrescenta uma linha quando o status ou o
 * horário mudou (ou na primeira vez que o vemos). Só acrescenta; nunca regrava nem apaga.
 *
 * Um escritor só: quem grava é esta função, e a lista diária (`recuperacao-agenda-worker.ts`) a chama com a MESMA leitura (de −14 a
 * +30) para pegar a baixa que a recepção deu dias depois. As duas leem da franquia pelo mesmo caminho e comparam com o que está
 * gravado, então não há dois valores brigando: o mesmo agendamento visto pelas duas dá o mesmo estado e nenhuma linha nova.
 *
 * Privacidade: nenhum nome nem telefone é gravado. O paciente é um HMAC com segredo da unidade + nome normalizado (`chaveDoPaciente`); sem o segredo nada é gravado. A agenda da
 * franquia só traz o nome, então homônimos têm a mesma chave (a mesma limitação do estudo de 26/11).
 *
 * Chave `recuperacao-agenda` (RECUPERACAO_AGENDA_SLUGS): DESLIGADA não grava nada (o comportamento é o de antes). «Só no papel» e ligada
 * gravam o histórico — é observação, não toca em paciente, cartão nem etapa.
 */
import { createHmac } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { nomeDaFranquia } from './franquia-sync.js';
import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';

export const ID_RECUPERACAO = 'recuperacao-agenda';

export function estadoDaRecuperacao(slug: string, raw: string | undefined = process.env.RECUPERACAO_AGENDA_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID_RECUPERACAO, raw);
}

/** O segredo da chave do paciente (`AGENDA_HISTORICO_SEGREDO`, 32+ caracteres), ou null. NUNCA girar: girar troca a chave de todo mundo e quebra o histórico e a medição. */
export function segredoDoHistorico(env: Partial<NodeJS.ProcessEnv> = process.env): string | null {
  const v = (env.AGENDA_HISTORICO_SEGREDO ?? '').trim();
  return v.length >= 32 ? v : null;
}

/**
 * Quem é o paciente SEM guardar o nome: HMAC-SHA-256 (chave = `AGENDA_HISTORICO_SEGREDO`) da unidade + nome normalizado (sem acento, caixa nem o
 * prefixo «IA-» / «N-» que a franquia põe em quem nasceu pela IA), 32 caracteres. Sem o segredo o banco não permite reverter a chave com uma lista
 * de nomes (nome brasileiro é espaço pequeno; um hash simples cairia). FALHA FECHADO: sem segredo (ou sem nome) não há chave, e quem precisa dela
 * (histórico, lista) não grava nada.
 */
export function chaveDoPaciente(unitId: string, nome: string | null | undefined, segredo: string | null = segredoDoHistorico()): string | null {
  const n = nomeDaFranquia(nome);
  if (!n || !segredo) return null;
  return createHmac('sha256', segredo).update(`${unitId}|${n}`).digest('hex').slice(0, 32);
}

/** O que sabemos do último evento de um agendamento. */
export interface EstadoVisto {
  paraStatus: number | null;
  inicioMs: number;
}

export interface NovoEvento {
  unitId: string;
  idSchedule: number;
  pacienteChave: string;
  categoria: string | null;
  deStatus: number | null;
  paraStatus: number | null;
  inicioEm: Date;
  inicioAnteriorEm: Date | null;
  modificadoEm: Date | null;
}

export type ItemDoHistorico = Pick<
  SpineSchedule,
  'idSchedule' | 'idStatus' | 'clientName' | 'categoryName' | 'dateAttendanceUtc' | 'modifiedUtc'
>;

/**
 * `modified` da franquia como instante. Sem designador de fuso vale UTC (sem isso o Node leria como hora do servidor). Conferido nos dados
 * (26/11/2026, cópia da agenda do Dash): de 13.707 sessões atendidas, só 7 têm `modified` mais de 3 h ANTES da consulta — se fosse a hora
 * local lida como UTC, a baixa dada depois da sessão apareceria deslocada 3 h para trás em massa.
 */
export function instanteDaFranquia(bruto: string | null | undefined): Date | null {
  const s = String(bruto ?? '').trim();
  if (!s) return null;
  const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}Z`);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * PURO. O que mudou desde o último evento gravado. Um agendamento sem id, sem nome ou sem horário não entra (não há como seguir).
 * `ultimos` = o último estado gravado por idSchedule; sem entrada = nunca visto (evento com `deStatus` nulo).
 */
export function eventosDaVarredura(unitId: string, agendamentos: ReadonlyArray<ItemDoHistorico>, ultimos: ReadonlyMap<number, EstadoVisto>): NovoEvento[] {
  const out: NovoEvento[] = [];
  const vistos = new Set<number>();
  for (const s of agendamentos) {
    const id = s.idSchedule;
    if (typeof id !== 'number' || vistos.has(id)) continue; // a paginação da franquia pode repetir um registro
    vistos.add(id);
    const inicio = instanteDaFranquia(s.dateAttendanceUtc);
    const chave = chaveDoPaciente(unitId, s.clientName);
    if (!inicio || !chave) continue;
    const antes = ultimos.get(id);
    const status = typeof s.idStatus === 'number' ? s.idStatus : null;
    const mudouHora = antes !== undefined && antes.inicioMs !== inicio.getTime();
    if (antes !== undefined && antes.paraStatus === status && !mudouHora) continue;
    out.push({
      unitId,
      idSchedule: id,
      pacienteChave: chave,
      categoria: s.categoryName?.trim() || null,
      deStatus: antes ? antes.paraStatus : null,
      paraStatus: status,
      inicioEm: inicio,
      inicioAnteriorEm: mudouHora ? new Date(antes!.inicioMs) : null,
      modificadoEm: instanteDaFranquia(s.modifiedUtc),
    });
  }
  return out;
}

export interface ArmazemDoHistorico {
  /** O último estado gravado de cada um destes agendamentos. */
  ultimos(unitId: string, ids: number[]): Promise<Map<number, EstadoVisto>>;
  gravar(eventos: NovoEvento[]): Promise<number>;
}

const LOTE = 1000;

export const armazemDoHistorico: ArmazemDoHistorico = {
  async ultimos(unitId, ids) {
    const out = new Map<number, EstadoVisto>();
    for (let i = 0; i < ids.length; i += LOTE) {
      const lote = ids.slice(i, i + LOTE);
      const linhas = await prisma.$queryRaw<Array<{ id_schedule: number; para_status: number | null; inicio_em: Date }>>(Prisma.sql`
        SELECT DISTINCT ON ("id_schedule") "id_schedule", "para_status", "inicio_em"
        FROM "agenda_status_eventos"
        WHERE "unit_id" = ${unitId} AND "id_schedule" IN (${Prisma.join(lote)})
        ORDER BY "id_schedule", "visto_em" DESC, "id" DESC`);
      for (const l of linhas) out.set(l.id_schedule, { paraStatus: l.para_status, inicioMs: l.inicio_em.getTime() });
    }
    return out;
  },
  async gravar(eventos) {
    let n = 0;
    for (let i = 0; i < eventos.length; i += LOTE) {
      n += (await prisma.agendaStatusEvento.createMany({ data: eventos.slice(i, i + LOTE) })).count;
    }
    return n;
  },
};

export interface ResultadoDoRegistro {
  /** linhas acrescentadas */
  registrados: number;
  /** porque não registrou nada (desligado, lista incompleta, falha) */
  motivo?: 'desligado' | 'incompleta' | 'falhou' | 'em-curso' | 'sem-segredo';
}

let avisouSemSegredo = false;
/** Avisa UMA vez por processo: a chave ligada sem o segredo não grava nada (falha fechado) e o log precisa dizer por quê. */
export function avisarSemSegredo(): void {
  if (avisouSemSegredo) return;
  avisouSemSegredo = true;
  logger.warn(`${ID_RECUPERACAO}: a chave está em «só no papel» ou ligada, mas AGENDA_HISTORICO_SEGREDO não existe (32+ caracteres) — não gravo histórico nem lista (a chave do paciente exige o segredo)`);
}
export const _esquecerAvisoSemSegredo = (): void => { avisouSemSegredo = false; };

/** Uma gravação por unidade de cada vez: duas leituras ao mesmo tempo veriam o mesmo «último» e gravariam a mesma mudança duas vezes. */
const emCurso = new Set<string>();

/**
 * Registra o que mudou. NUNCA lança (o sincronizador segue igual se o banco falhar). `truncada` = a franquia tinha mais páginas que o
 * teto: com a lista incompleta o que falta não é «mudou», é «não veio», e nada é registrado.
 */
export async function registrarMudancasDaAgenda(
  unit: { id: string; slug: string },
  agendamentos: ReadonlyArray<ItemDoHistorico>,
  opts: { truncada?: boolean; estado?: Estado; armazem?: ArmazemDoHistorico } = {},
): Promise<ResultadoDoRegistro> {
  const estado = opts.estado ?? estadoDaRecuperacao(unit.slug);
  if (estado === 'desligado') return { registrados: 0, motivo: 'desligado' };
  if (!segredoDoHistorico()) {
    avisarSemSegredo();
    return { registrados: 0, motivo: 'sem-segredo' };
  }
  if (opts.truncada) {
    logger.warn({ unit: unit.slug }, `${ID_RECUPERACAO}: a franquia tinha mais páginas que o teto — lista incompleta, não registrei a agenda desta varredura`);
    return { registrados: 0, motivo: 'incompleta' };
  }
  if (emCurso.has(unit.id)) return { registrados: 0, motivo: 'em-curso' };
  emCurso.add(unit.id);
  try {
    const armazem = opts.armazem ?? armazemDoHistorico;
    const ids = [...new Set(agendamentos.map((a) => a.idSchedule).filter((x): x is number => typeof x === 'number'))];
    if (ids.length === 0) return { registrados: 0 };
    const eventos = eventosDaVarredura(unit.id, agendamentos, await armazem.ultimos(unit.id, ids));
    if (eventos.length === 0) return { registrados: 0 };
    const registrados = await armazem.gravar(eventos);
    logger.info({ unit: unit.slug, registrados, lidos: ids.length }, `${ID_RECUPERACAO}: mudanças da agenda registradas`);
    return { registrados };
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, `${ID_RECUPERACAO}: não consegui registrar as mudanças da agenda — o sincronizador segue`);
    return { registrados: 0, motivo: 'falhou' };
  } finally {
    emCurso.delete(unit.id);
  }
}

/**
 * Quando cada desmarque foi LANÇADO, segundo o histórico: o `modificadoEm` do evento em que vimos o agendamento ENTRAR em DESMARCADO (o mais recente,
 * se foi desmarcado, reativado e desmarcado de novo). O `modified` da franquia sozinho é a ÚLTIMA alteração do registro: uma edição qualquer depois da
 * hora da consulta o empurraria para «desmarcou depois do horário» sem ter sido assim. A 1ª observação (`de_status` nulo) NÃO vale: nela o `modified`
 * é só a última alteração de um registro que já estava desmarcado. Sem transição observada, o agendamento fica fora do mapa e vale o `modified`.
 */
export async function lancamentosDosDesmarques(unitId: string, ids: number[]): Promise<Map<number, Date>> {
  const out = new Map<number, Date>();
  for (let i = 0; i < ids.length; i += LOTE) {
    const lote = ids.slice(i, i + LOTE);
    const linhas = await prisma.$queryRaw<Array<{ id_schedule: number; modificado_em: Date | null }>>(Prisma.sql`
      SELECT DISTINCT ON ("id_schedule") "id_schedule", "modificado_em"
      FROM "agenda_status_eventos"
      WHERE "unit_id" = ${unitId} AND "para_status" = ${SPINE_STATUS.DESMARCADO} AND "de_status" IS NOT NULL AND "de_status" <> ${SPINE_STATUS.DESMARCADO}
        AND "id_schedule" IN (${Prisma.join(lote)})
      ORDER BY "id_schedule", "visto_em" DESC, "id" DESC`);
    for (const l of linhas) if (l.modificado_em) out.set(l.id_schedule, l.modificado_em);
  }
  return out;
}

// ── retenção ───────────────────────────────────────────────────────────────────────────────────

/**
 * O prazo mínimo da retenção. A medição olha até 90 dias depois de a lista sair (e a lista olha 14 dias para trás): com menos que isto a purga
 * apagaria o paciente antes de a janela fechar e a medição ficaria vazia ou torta. 120 = 90 + 14 + folga.
 */
export const RETENCAO_MINIMA_DIAS = 120;

/** `AGENDA_HISTORICO_RETENCAO_DIAS`: vazio = nunca apaga (o comportamento de sempre). Valor que não é inteiro de 120 em diante é ignorado e avisado (um «1» por engano apagaria quase tudo). */
export function retencaoDoHistoricoDias(env: Partial<NodeJS.ProcessEnv> = process.env): number | null {
  const bruto = (env.AGENDA_HISTORICO_RETENCAO_DIAS ?? '').replace(/^['"]|['"]$/g, '').trim();
  if (!bruto) return null;
  const n = Number(bruto);
  if (Number.isInteger(n) && n >= RETENCAO_MINIMA_DIAS) return n;
  logger.warn({ valor: bruto }, `${ID_RECUPERACAO}: AGENDA_HISTORICO_RETENCAO_DIAS inválido (inteiro de 120 em diante) — não apago nada`);
  return null;
}

/**
 * O que a purga apaga. Eventos: só os de agendamentos cuja CONSULTA já passou do corte (`inicioEm`), não pela hora em que os vimos: um agendamento
 * marcado com 40 dias de antecedência, sem mudança, tem um único evento velho e AINDA está na varredura; apagá-lo faria a varredura gravar uma «1ª vez
 * visto» falsa (que a medição leria como agendamento novo). Com o prazo mínimo de 120 dias, o que passou do corte está fora da varredura (de −14 a +45).
 * Cada parte do módulo acrescenta a sua tabela.
 */
export const apagadores: Array<{ nome: string; apagar: (corte: Date) => Promise<number> }> = [
  { nome: 'eventos', apagar: async (corte) => (await prisma.agendaStatusEvento.deleteMany({ where: { inicioEm: { lt: corte } } })).count },
];

/** Apaga o que passou da retenção. Sem a variável, não faz nada. Nunca lança. */
export async function purgarHistorico(agora: Date = new Date(), deps: { retencaoDias?: number | null; apagadores?: typeof apagadores } = {}): Promise<Record<string, number> | null> {
  const dias = deps.retencaoDias !== undefined ? deps.retencaoDias : retencaoDoHistoricoDias();
  if (dias === null) return null;
  const corte = new Date(agora.getTime() - dias * 86_400_000);
  const apagados: Record<string, number> = {};
  for (const a of deps.apagadores ?? apagadores) {
    try {
      apagados[a.nome] = await a.apagar(corte);
    } catch (err) {
      logger.warn({ err: String(err), tabela: a.nome }, `${ID_RECUPERACAO}: a purga não conseguiu apagar`);
    }
  }
  logger.info({ retencaoDias: dias, corte: corte.toISOString(), apagados }, `${ID_RECUPERACAO}: purga da retenção feita`);
  return apagados;
}

let ultimaPurga = '';
let timerDaPurga: NodeJS.Timeout | null = null;
let primeiraPurga: NodeJS.Timeout | null = null;

/** Uma vez por dia (UTC), de 6 em 6 horas confere. Sem `AGENDA_HISTORICO_RETENCAO_DIAS` não faz nada. Purga que falhou em alguma tabela tenta de novo no próximo ciclo. */
export function iniciarPurgaDoHistorico(): void {
  if (timerDaPurga) return;
  const tick = () => {
    const hoje = new Date().toISOString().slice(0, 10);
    if (ultimaPurga === hoje || retencaoDoHistoricoDias() === null) return;
    ultimaPurga = hoje;
    void purgarHistorico().then((r) => {
      if (r === null || Object.keys(r).length < apagadores.length) ultimaPurga = '';
    });
  };
  timerDaPurga = setInterval(tick, 6 * 3600_000);
  timerDaPurga.unref();
  primeiraPurga = setTimeout(tick, 10 * 60_000);
  primeiraPurga.unref();
}

export function pararPurgaDoHistorico(): void {
  if (timerDaPurga) clearInterval(timerDaPurga);
  if (primeiraPurga) clearTimeout(primeiraPurga);
  timerDaPurga = null;
  primeiraPurga = null;
}
