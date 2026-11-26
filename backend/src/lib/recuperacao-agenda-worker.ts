/**
 * Lista diária de RECUPERAÇÃO — o worker (26/11/2026). A decisão é de `recuperacao-agenda.ts` (puro); aqui se lê a franquia e o cartão
 * do Kommo, grava quem entrou na lista (para medir o retorno) e manda o texto para o grupo da recepção.
 *
 * Chave `recuperacao-agenda` (RECUPERACAO_AGENDA_SLUGS). NASCE DESLIGADA. Estados:
 *  - desligado: não faz nada (nem o histórico da agenda);
 *  - «só no papel» (seco): lê, monta a lista e GRAVA quem entraria (modo «seco») — não manda nada e não escreve em paciente, cartão ou
 *    etapa. As linhas do seco são o grupo de comparação da medição (`recuperacao_agenda` no conector);
 *  - ligado: manda o texto no grupo da unidade. Só com destino em RECUPERACAO_DESTINOS (JSON {"<slug>": "<id>@g.us"}); sem destino,
 *    não manda e não grava nada (senão a lista daquele dia ficaria «já enviada» sem ter saído).
 *
 * Quando: dias da agenda da unidade, sem feriado, entre 8h e 12h na hora da unidade; no máximo uma lista por unidade por dia (teto de
 * pacientes por dia: RECUPERACAO_MAX_POR_DIA, padrão 15). Cada AGENDAMENTO entra uma vez, e cada PACIENTE uma vez a cada 14 dias.
 *
 * A saída do cartão (o que a agenda não diz): etiqueta de não contatar, «✓ Opt-out WhatsApp», motivo de perda «morto» («Sem interesse»,
 * «Outra cidade»… — `motivos-mortos.ts`, nos dois campos ⊘ e no motivo nativo do Kommo), consulta futura ou ◷ Retomar em no cartão e
 * cartão já em GANHO. Na dúvida NÃO entra: se o cartão não puder ser lido, o paciente fica para outra rodada (nunca vira ligação para
 * quem disse que não quer).
 *
 * O link do cartão só vai quando o telefone confirmou que o cartão é do paciente (`leadConfirmado`). Sem prova, vai «sem cartão
 * achado: procure pelo nome» — um link errado levaria a recepção ao cartão de outra pessoa. NADA é gravado no cartão nem na franquia.
 *
 * Privacidade: o nome só existe em memória para montar o primeiro nome do texto. No banco vai um hash; no log, só contagens.
 *
 * Kommo dividido (Petrópolis × Caxias) fica fora desta versão: o cartão achado pode ser da outra unidade.
 */
import type { Unit } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { estadoDaRecuperacao, ID_RECUPERACAO, registrarMudancasDaAgenda, chaveDoPaciente, lancamentosDosDesmarques, segredoDoHistorico, avisarSemSegredo, apagadores } from './agenda-historico.js';
import type { Estado } from './automacoes-estado.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { SPINE_STATUS, SpineService, somarDias, type SpineSchedule, type SpineTreatment } from '../services/spine.service.js';
import { contaDoKommo, grupoDaUnidade, type GrupoDoCrm } from './crm-compartilhado.js';
import { ondeTemSync, resolverPaciente, type EntradaDoCacheDeLead } from './franquia-sync-worker.js';
import { porQueNaoTocar, type MotivosNativos } from './rotina-nucleo.js';
import { enviarPelaEvolutionComResultado, type ResultadoDoEnvio } from './alerta-whatsapp.js';
import { registrarSimulacao } from './so-no-papel.js';
import { dataLocalISO, ehFeriadoNacional } from './feriados.js';
import { partesNoFuso } from './fuso.js';
import { linkDoCartao } from './aviso-clinica-agendamento.js';
import {
  DIAS_DA_LISTA, MAXIMO_POR_DIA, candidatosDaLista, nomeParaOTexto, pacienteEmTratamento, partesDaLista,
  type Candidato, type ItemDoTexto, type MotivoDeSaida,
} from './recuperacao-agenda.js';

const PRIMEIRA_MS = 4 * 60_000;
const INTERVALO_MS = 10 * 60_000;
const PAUSA_ENTRE_CARTOES_MS = 300;
/** A lista sai a partir das 8h e só até o meio-dia (hora da unidade): depois disso o dia de ligar já foi. */
export const LISTA_ABRE_MIN = 8 * 60;
export const LISTA_FECHA_MIN = 12 * 60;
/** A agenda lida: de 14 dias atrás até o horizonte do sincronizador (o mesmo que a medição usa para reconhecer «marcação nova»). */
const DIAS_PARA_FRENTE = 45;
/** Cartões conferidos por lista: o teto do dia vezes isto, mais uma folga — quem sai pelo cartão não pode fazer a rodada varrer a unidade inteira. */
const CONFERENCIAS_POR_VAGA = 3;
const TENTATIVAS_POR_DIA = 3;
/** Rodadas por dia (uma a cada 10 min) antes de desistir do dia: a franquia fora do ar ou a Evolution recusando não pode martelar até as 12h. */
const RODADAS_MAXIMAS_POR_DIA = 6;
/** Item «enviando» há mais que isto: o processo caiu no meio (deploy, queda) — vira «incerto». */
const PRESO_ENVIANDO_MS = 30 * 60_000;
/** Cartão no Kommo que já fechou como GANHO (o paciente fechou o tratamento). */
const ETAPA_GANHO = 142;

export interface Limites {
  maximoPorDia: number;
  dias: number;
}

/** `RECUPERACAO_MAX_POR_DIA` (padrão 15, de 1 a 50) e `RECUPERACAO_DIAS` (padrão 14, de 1 a 30). */
export function limitesDaLista(env: Partial<NodeJS.ProcessEnv> = process.env): Limites {
  const num = (v: string | undefined, padrao: number, min: number, max: number): number => {
    const n = Number(String(v ?? '').replace(/^['"]|['"]$/g, '').trim());
    return Number.isInteger(n) && n >= min && n <= max ? n : padrao;
  };
  return { maximoPorDia: num(env.RECUPERACAO_MAX_POR_DIA, MAXIMO_POR_DIA, 1, 50), dias: num(env.RECUPERACAO_DIAS, DIAS_DA_LISTA, 1, 30) };
}

/** O destino (grupo ou número) da unidade, ou null. JSON `{"<slug>": "<id>@g.us"}`; vazio ou malformado = ninguém recebe. */
export function destinoDaRecuperacao(slug: string, raw: string | undefined = process.env.RECUPERACAO_DESTINOS): string | null {
  if (!raw?.trim()) return null;
  try {
    const mapa = JSON.parse(raw.trim().replace(/^'|'$/g, '')) as Record<string, unknown>;
    const d = mapa?.[slug];
    return typeof d === 'string' && d.trim() ? d.trim() : null;
  } catch {
    logger.warn(`${ID_RECUPERACAO}: RECUPERACAO_DESTINOS não é JSON válido — sem destino`);
    return null;
  }
}

/** A Evolution que envia: a própria (RECUPERACAO_EVOLUTION_*) ou a do aviso à recepção (a mesma instância dos grupos), com a chave dos alertas. */
export function configDaEvolutionDaRecuperacao(env: Partial<NodeJS.ProcessEnv>): { url: string; header: string; valor: string } | null {
  const url = env.RECUPERACAO_EVOLUTION_URL || env.AVISO_CLINICA_AGENDAMENTO_EVOLUTION_URL;
  const header = env.RECUPERACAO_EVOLUTION_HEADER || env.AVISO_CLINICA_AGENDAMENTO_EVOLUTION_HEADER || env.EVOLUTION_ALERT_HEADER;
  const valor = env.RECUPERACAO_EVOLUTION_VALUE || env.AVISO_CLINICA_AGENDAMENTO_EVOLUTION_VALUE || env.EVOLUTION_ALERT_VALUE;
  return url && header && valor ? { url, header, valor } : null;
}

/**
 * O fuso da AGENDA da franquia: o mesmo em que a franquia dá o dia de cada consulta (`dayLocal`) e em que `dentroDoHorario` olha dia da
 * semana e feriado. Não o `businessHoursTimezone`: «hoje», o dia da consulta e a hora da lista têm de sair do mesmo relógio.
 */
const fusoDaAgenda = (unit: Pick<Unit, 'spineTimezone'>): string => unit.spineTimezone || 'America/Sao_Paulo';

const DIA_DA_SEMANA: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Hoje é dia de agenda desta unidade (dias da semana configurados, padrão segunda a sexta) e não é feriado nacional? */
export function ehDiaDeAgenda(unit: Pick<Unit, 'spineTimezone' | 'spineAgendaDays'>, agora: Date): boolean {
  const tz = fusoDaAgenda(unit);
  if (ehFeriadoNacional(dataLocalISO(agora, tz))) return false;
  const dia = DIA_DA_SEMANA[new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(agora)];
  const dias = unit.spineAgendaDays?.length ? unit.spineAgendaDays : [1, 2, 3, 4, 5];
  return dia !== undefined && dias.includes(dia);
}

/**
 * É hora da lista? Dia de agenda da unidade, sem feriado nacional, entre 8h e 12h na hora da agenda. A janela é da LISTA (a recepção liga
 * de manhã), não do horário de atendimento da clínica: uma unidade que só atende à tarde recebe a lista de manhã do mesmo jeito.
 */
export function horaDaLista(unit: Pick<Unit, 'spineTimezone' | 'spineAgendaDays'>, agora: Date): boolean {
  if (!ehDiaDeAgenda(unit, agora)) return false;
  const p = partesNoFuso(agora, fusoDaAgenda(unit));
  const min = p.hora * 60 + p.min;
  return min >= LISTA_ABRE_MIN && min < LISTA_FECHA_MIN;
}

// ── o cartão ──────────────────────────────────────────────────────────────────────────────────

/**
 * Por que o CARTÃO tira o paciente da lista, ou null. O que já está pronto na casa (`porQueNaoTocar`): etiqueta de não contatar,
 * opt-out, motivo de perda morto (campo ⊘ e motivo nativo), ◷ Retomar em, consulta futura no cartão. Mais: cartão em GANHO.
 * `motivosNativos === null` = a lista de motivos do Kommo não pôde ser lida: com `loss_reason_id` no cartão, na dúvida sai.
 */
export function porQueOCartaoTira(lead: KommoLead, o: { agoraEpoch: number; tz: string; motivosNativos: MotivosNativos | null }): string | null {
  const r = porQueNaoTocar(lead, { agora: o.agoraEpoch, tz: o.tz, pausarIaFieldId: null, conferirMotivoMorto: true, motivosNativos: o.motivosNativos });
  if (r) return r.codigo;
  if (lead.status_id === ETAPA_GANHO) return 'ganho';
  return null;
}

// ── o armazém dos itens da lista ──────────────────────────────────────────────────────────────

export interface ItemParaGravar {
  unitId: string;
  idSchedule: number;
  pacienteChave: string;
  categoria: string | null;
  tipo: string;
  inicioEm: Date;
  modificadoEm: Date | null;
  modo: 'seco' | 'ligado';
  dia: string;
  kommoLeadId: number | null;
  envio: string;
}

export interface ArmazemDaLista {
  /** quantos itens a unidade já tem neste dia e modo (os que não ficaram pendentes) */
  contarDoDia(unitId: string, modo: string, dia: string): Promise<number>;
  /** os agendamentos que ficaram «pendente» hoje (a Evolution recusou e nada saiu) */
  pendentesDoDia(unitId: string, modo: string, dia: string): Promise<number[]>;
  /** quem já foi listado desde `desde` (menos o que ficou pendente): por agendamento e por paciente */
  jaListados(unitId: string, modo: string, desde: Date): Promise<Array<{ idSchedule: number; pacienteChave: string }>>;
  /** grava um item; false = já existia (outro processo ou rodada) */
  reivindicar(item: ItemParaGravar): Promise<boolean>;
  concluir(unitId: string, idSchedule: number, modo: string, envio: string): Promise<void>;
  /** itens que ficaram «enviando» (o processo caiu entre gravar e mandar) viram «incerto»: não se repete, e a medição os conta à parte */
  soltarPresos(unitId: string, antesDe: Date): Promise<number>;
}

export const armazemDaLista: ArmazemDaLista = {
  async contarDoDia(unitId, modo, dia) {
    return prisma.agendaRecuperacaoItem.count({ where: { unitId, modo, dia, NOT: { envio: { in: ['pendente', 'sem_destino'] } } } });
  },
  async pendentesDoDia(unitId, modo, dia) {
    return (await prisma.agendaRecuperacaoItem.findMany({ where: { unitId, modo, dia, envio: 'pendente' }, select: { idSchedule: true } })).map((i) => i.idSchedule);
  },
  async jaListados(unitId, modo, desde) {
    return prisma.agendaRecuperacaoItem.findMany({
      where: { unitId, modo, listadoEm: { gte: desde }, NOT: { envio: { in: ['pendente', 'sem_destino'] } } },
      select: { idSchedule: true, pacienteChave: true },
    });
  },
  async reivindicar(item) {
    try {
      await prisma.agendaRecuperacaoItem.create({ data: item });
      return true;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      // já existe: só vale de novo se ficou PENDENTE (a Evolution recusou e nada saiu)
      const r = await prisma.agendaRecuperacaoItem.updateMany({
        where: { unitId: item.unitId, idSchedule: item.idSchedule, modo: item.modo, envio: 'pendente' },
        data: { envio: item.envio, dia: item.dia, kommoLeadId: item.kommoLeadId, listadoEm: new Date() },
      });
      return r.count === 1;
    }
  },
  async concluir(unitId, idSchedule, modo, envio) {
    await prisma.agendaRecuperacaoItem.updateMany({ where: { unitId, idSchedule, modo }, data: { envio } });
  },
  async soltarPresos(unitId, antesDe) {
    return (await prisma.agendaRecuperacaoItem.updateMany({ where: { unitId, envio: 'enviando', listadoEm: { lt: antesDe } }, data: { envio: 'incerto' } })).count;
  },
};

// a purga da retenção (AGENDA_HISTORICO_RETENCAO_DIAS, de `agenda-historico.ts`) apaga também a lista que passou do prazo
apagadores.push({ nome: 'itens', apagar: async (corte) => (await prisma.agendaRecuperacaoItem.deleteMany({ where: { listadoEm: { lt: corte } } })).count });

// ── a rodada de uma unidade ───────────────────────────────────────────────────────────────────

export interface ResumoDaLista {
  unit: string;
  modo: Estado;
  dia: string;
  /** porque não rodou (ou parou no meio) */
  motivo?: string;
  candidatos: number;
  saidasDaAgenda: Record<MotivoDeSaida, number>;
  saidasDoCartao: Record<string, number>;
  /** cartão que não pôde ser lido: o paciente fica para outra rodada */
  incertos: number;
  jaListados: number;
  listados: number;
  semCartao: number;
  restantes: number;
  mensagens: number;
}

export interface DepsDaLista {
  agora?: Date;
  estado?: Estado;
  env?: Partial<NodeJS.ProcessEnv>;
  /** ignora a hora da lista (só o teste e o «rodar agora» do console) */
  ignorarHorario?: boolean;
  grupo?: GrupoDoCrm | null;
  buscarAgenda?: (de: string, ate: string) => Promise<{ ok: boolean; erro?: string; agendamentos: SpineSchedule[]; truncada?: boolean }>;
  buscarTratamentos?: () => Promise<{ ok: boolean; erro?: string; tratamentos: SpineTreatment[]; truncada?: boolean }>;
  registrar?: typeof registrarMudancasDaAgenda;
  /** a hora em que cada desmarque foi lançado (do histórico); sem isto lê do banco */
  lancamentos?: (ids: number[]) => Promise<Map<number, Date>>;
  kommo?: Pick<KommoClient, 'getLead' | 'listLossReasons'>;
  resolver?: (nome: string, idsSchedule: number[]) => Promise<{ leadId: number | null; leadConfirmado: boolean }>;
  armazem?: ArmazemDaLista;
  enviar?: (a: { url: string; header: string; valor: string; numero: string; texto: string }) => Promise<ResultadoDoEnvio>;
  simular?: typeof registrarSimulacao;
  pausaMs?: number;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cacheDoCartao = new Map<string, EntradaDoCacheDeLead>();
/** `slug|dia` → tentativas feitas; a rodada que terminou sem incertos fecha o dia. */
const tentativasDoDia = new Map<string, number>();
const diaFechado = new Set<string>();
const avisadas = new Set<string>();
/**
 * Quem o CARTÃO já tirou da lista («não quero mais», opt-out, GANHO…): lembrado por algumas horas, para o mesmo paciente não gastar uma das
 * conferências de cada rodada e empurrar os elegíveis mais antigos para fora do teto. `unidade|idSchedule` → quando.
 */
const saiuPeloCartao = new Map<string, number>();
const LEMBRAR_SAIDA_MS = 12 * 3600_000;
/** Teto duro de leituras do Kommo por rodada (saídas pelo cartão incluídas): a lista nunca varre a unidade inteira. */
const LEITURAS_MAXIMAS_POR_RODADA = 150;

/** Conta uma rodada do dia; passou do teto, o dia fecha (volta amanhã, com o que sobrou). */
function contarRodada(chaveDoDia: string): number {
  const n = (tentativasDoDia.get(chaveDoDia) ?? 0) + 1;
  tentativasDoDia.set(chaveDoDia, n);
  if (n >= RODADAS_MAXIMAS_POR_DIA) diaFechado.add(chaveDoDia);
  return n;
}

function avisarUmaVez(chave: string, msg: string): void {
  if (avisadas.has(chave)) return;
  avisadas.add(chave);
  logger.warn(msg);
}

export function _limparMemoriaDaRecuperacao(): void {
  cacheDoCartao.clear();
  tentativasDoDia.clear();
  diaFechado.clear();
  avisadas.clear();
  saiuPeloCartao.clear();
}

const semSaidas = (): Record<MotivoDeSaida, number> => ({ voltou: 0, 'em-tratamento': 0, 'sem-chave': 0, repetido: 0 });

/**
 * Uma lista de uma unidade. Nunca lança. Devolve só contagens (nunca nome nem telefone).
 */
export async function listarRecuperacao(unit: Unit, deps: DepsDaLista = {}): Promise<ResumoDaLista> {
  const agora = deps.agora ?? new Date();
  const env = deps.env ?? process.env;
  const tz = fusoDaAgenda(unit);
  const hoje = dataLocalISO(agora, tz);
  const modo = deps.estado ?? estadoDaRecuperacao(unit.slug, env.RECUPERACAO_AGENDA_SLUGS);
  const r: ResumoDaLista = {
    unit: unit.slug, modo, dia: hoje, candidatos: 0, saidasDaAgenda: semSaidas(), saidasDoCartao: {}, incertos: 0, jaListados: 0, listados: 0, semCartao: 0, restantes: 0, mensagens: 0,
  };
  try {
    return await rodada(unit, deps, { agora, env, tz, hoje, modo }, r);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, `${ID_RECUPERACAO}: a lista de hoje falhou — tento de novo na próxima rodada`);
    r.motivo = 'falhou';
    return r;
  }
}

async function rodada(
  unit: Unit,
  deps: DepsDaLista,
  ctx: { agora: Date; env: Partial<NodeJS.ProcessEnv>; tz: string; hoje: string; modo: Estado },
  r: ResumoDaLista,
): Promise<ResumoDaLista> {
  const { agora, env, tz, hoje, modo } = ctx;
  if (modo === 'desligado') return { ...r, motivo: 'desligado' };
  if (!deps.ignorarHorario && !horaDaLista(unit, agora)) return { ...r, motivo: 'fora-do-horario' };
  // a chave do paciente é um HMAC com segredo: sem ele não há lista (falha fechado, com o motivo no log)
  if (!segredoDoHistorico()) {
    avisarSemSegredo();
    return { ...r, motivo: 'sem-segredo' };
  }
  const chaveDoDia = `${unit.slug}|${hoje}|${modo}`;
  if (!deps.ignorarHorario && diaFechado.has(chaveDoDia)) return { ...r, motivo: 'ja-fez-hoje' };
  if (!deps.buscarAgenda && (!unit.spineEnabled || !unit.spineToken)) return { ...r, motivo: 'sem-franquia' };

  const grupo = deps.grupo !== undefined ? deps.grupo : await grupoDaUnidade(unit.id);
  if (grupo) {
    avisarUmaVez(`${unit.slug}|dividido`, `${ID_RECUPERACAO}: ${unit.slug} divide o Kommo com outra unidade — a lista ainda não cobre esse caso, pulei`);
    return { ...r, motivo: 'kommo-dividido' };
  }

  // sem Kommo na unidade não há como conferir o cartão («não quero mais»): nem gasta chamada na franquia
  if (!deps.kommo && !deps.resolver) {
    const conta = await contaDoKommo(unit);
    if (!conta.kommoAccessToken) {
      avisarUmaVez(`${unit.slug}|kommo`, `${ID_RECUPERACAO}: a unidade não tem Kommo — não dá para conferir o cartão (quem disse «não quero mais»), sem lista`);
      diaFechado.add(chaveDoDia);
      return { ...r, motivo: 'sem-kommo' };
    }
  }
  const limites = limitesDaLista(env);
  const modoDaLinha = modo === 'ligado' ? 'ligado' : 'seco';
  const armazem = deps.armazem ?? armazemDaLista;

  // ligado sem para onde mandar: não gasta chamada nenhuma e NÃO grava ninguém como listado (senão o dia ficaria «feito» sem ter saído)
  let destino: string | null = null;
  let cfg: { url: string; header: string; valor: string } | null = null;
  if (modo === 'ligado') {
    destino = destinoDaRecuperacao(unit.slug, env.RECUPERACAO_DESTINOS);
    cfg = configDaEvolutionDaRecuperacao(env);
    if (!destino) {
      avisarUmaVez(`${unit.slug}|destino`, `${ID_RECUPERACAO}: ligada, mas a unidade não tem destino em RECUPERACAO_DESTINOS — não mando`);
      return { ...r, motivo: 'sem-destino' };
    }
    if (!cfg) {
      avisarUmaVez(`${unit.slug}|config`, `${ID_RECUPERACAO}: ligada, mas sem RECUPERACAO_EVOLUTION_URL (ou AVISO_CLINICA_AGENDAMENTO_EVOLUTION_URL) e a chave da Evolution — não mando`);
      return { ...r, motivo: 'sem-config' };
    }
  }

  await armazem.soltarPresos(unit.id, new Date(agora.getTime() - PRESO_ENVIANDO_MS));
  // UMA lista por unidade por dia, mesmo se o servidor reiniciar entre 8h e 12h (a memória do dia some no deploy; o banco não): quem já saiu hoje fecha o dia.
  // A exceção é o que ficou «pendente» (a Evolution recusou): só ISSO volta, sem juntar candidato novo.
  const feitosHoje = await armazem.contarDoDia(unit.id, modoDaLinha, hoje);
  const pendentesHoje = feitosHoje > 0 ? new Set(await armazem.pendentesDoDia(unit.id, modoDaLinha, hoje)) : null;
  if (feitosHoje > 0 && pendentesHoje!.size === 0) {
    diaFechado.add(chaveDoDia);
    return { ...r, motivo: 'ja-fez-hoje' };
  }
  const vagas = limites.maximoPorDia - feitosHoje;
  if (vagas <= 0) {
    diaFechado.add(chaveDoDia);
    return { ...r, motivo: 'teto-do-dia' };
  }

  // 1. a agenda da franquia (de 14 dias atrás ao horizonte do sincronizador). Sem ela inteira não se decide nada: lista incompleta lista gente que já voltou.
  const de = somarDias(hoje, -limites.dias);
  const ate = somarDias(hoje, DIAS_PARA_FRENTE);
  const ag = deps.buscarAgenda
    ? await deps.buscarAgenda(de, ate)
    : await SpineService.searchSchedules(unit, { initialDate: de, endDate: ate, rowsPerPage: 100 }).then((x) => ({ ok: x.ok, erro: x.error, agendamentos: x.data?.schedules ?? [], truncada: x.data?.truncada }));
  if (!ag.ok || ag.truncada) {
    logger.warn({ unit: unit.slug, erro: ag.erro, truncada: ag.truncada }, `${ID_RECUPERACAO}: agenda ${ag.truncada ? 'incompleta' : 'indisponível'} — sem lista nesta rodada`);
    contarRodada(chaveDoDia);
    return { ...r, motivo: 'agenda-indisponivel' };
  }
  // a mesma leitura alimenta o histórico e pega a baixa que a recepção deu dias depois (unidade que sai antes daqui — sem Kommo, dividida — só tem o
  // do sincronizador, de −3 dias); quem chama nunca falha por isso
  await (deps.registrar ?? registrarMudancasDaAgenda)(unit, ag.agendamentos, { truncada: ag.truncada, estado: modo });

  // 2. quem está em tratamento (aberto) na franquia
  const tr = deps.buscarTratamentos ? await deps.buscarTratamentos() : await SpineService.searchTreatments(unit).then((x) => ({ ok: x.ok, erro: x.error, tratamentos: x.data?.treatments ?? [], truncada: x.data?.truncada }));
  if (!tr.ok || tr.truncada) {
    logger.warn({ unit: unit.slug, erro: tr.erro, truncada: tr.truncada }, `${ID_RECUPERACAO}: tratamentos indisponíveis — sem lista nesta rodada (não dá para saber quem está em tratamento)`);
    contarRodada(chaveDoDia);
    return { ...r, motivo: 'tratamentos-indisponiveis' };
  }
  const emTratamento = new Set<string>();
  for (const t of tr.tratamentos) {
    const chave = chaveDoPaciente(unit.id, t.clientName);
    if (chave && pacienteEmTratamento(t.statusName)) emTratamento.add(chave);
  }

  // 3. quem entra pela agenda, menos quem já foi listado
  // «Desmarcou depois do horário» pede a hora em que o desmarque foi LANÇADO. O `modified` da franquia é a ÚLTIMA alteração do registro (uma
  // edição de observação, dias depois, o empurraria para «provável falta»): vale a hora que o histórico guardou quando o status virou DESMARCADO.
  const desmarcados = ag.agendamentos.filter((s) => s.idStatus === SPINE_STATUS.DESMARCADO && typeof s.idSchedule === 'number').map((s) => s.idSchedule as number);
  let lancamentos = new Map<number, Date>();
  try {
    lancamentos = await (deps.lancamentos ?? ((ids: number[]) => lancamentosDosDesmarques(unit.id, ids)))(desmarcados);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, `${ID_RECUPERACAO}: não li a hora dos desmarques no histórico — vale a última alteração da franquia`);
  }
  const { candidatos, saidas } = candidatosDaLista({ unitId: unit.id, agendamentos: ag.agendamentos, emTratamento, hoje, agora, dias: limites.dias, lancamentos });
  const listados = await armazem.jaListados(unit.id, modoDaLinha, new Date(agora.getTime() - limites.dias * 86_400_000));
  const idsListados = new Set(listados.map((l) => l.idSchedule));
  const chavesListadas = new Set(listados.map((l) => l.pacienteChave));
  const novos = candidatos.filter((c) => !idsListados.has(c.idSchedule) && !chavesListadas.has(c.pacienteChave) && (!pendentesHoje || pendentesHoje.has(c.idSchedule)));
  r.candidatos = novos.length;
  r.saidasDaAgenda = saidas;
  r.jaListados = candidatos.length - novos.length;

  // 4. o cartão do Kommo: quem disse «não quero mais» e o link
  const aprovados: Array<{ c: Candidato; leadId: number | null; confirmado: boolean }> = [];
  if (novos.length > 0) {
    let kommo: Pick<KommoClient, 'getLead' | 'listLossReasons'> | undefined = deps.kommo;
    let cliente: KommoClient | null = null;
    if (!kommo) {
      cliente = createKommoClient(await contaDoKommo(unit));
      kommo = cliente;
    }
    const leitor = kommo;
    let motivosNativos: MotivosNativos | null = null;
    try {
      motivosNativos = new Map((await leitor.listLossReasons()).map((m) => [m.id, m.name] as const));
    } catch {
      motivosNativos = null; // `porQueOCartaoTira` trata: com `loss_reason_id` no cartão, na dúvida sai
    }
    const resolver = deps.resolver ?? (async (nome: string, ids: number[]) => resolverPaciente(unit, cliente!, nome, null, ids, cacheDoCartao));
    const pausa = deps.pausaMs ?? PAUSA_ENTRE_CARTOES_MS;
    let conferidos = 0;
    let leituras = 0;
    let percorridos = 0;
    for (const c of novos) {
      if (aprovados.length >= vagas || conferidos >= vagas * CONFERENCIAS_POR_VAGA + 10 || leituras >= LEITURAS_MAXIMAS_POR_RODADA) break;
      percorridos++;
      const lembrada = saiuPeloCartao.get(`${unit.id}|${c.idSchedule}`);
      if (lembrada !== undefined && agora.getTime() - lembrada < LEMBRAR_SAIDA_MS) {
        r.saidasDoCartao.lembrado = (r.saidasDoCartao.lembrado ?? 0) + 1; // já saiu pelo cartão: nem lê de novo, nem gasta conferência
        continue;
      }
      leituras++;
      try {
        const achado = await resolver(c.nome, [c.idSchedule]);
        let leadId: number | null = null;
        if (achado.leadId) {
          const lead = await leitor.getLead(achado.leadId);
          // cartão apagado: o GET devolve vazio — é como não ter cartão
          if (lead && typeof lead === 'object' && lead.id) {
            const porque = porQueOCartaoTira(lead, { agoraEpoch: Math.floor(agora.getTime() / 1000), tz, motivosNativos });
            if (porque) {
              r.saidasDoCartao[porque] = (r.saidasDoCartao[porque] ?? 0) + 1;
              saiuPeloCartao.set(`${unit.id}|${c.idSchedule}`, agora.getTime());
              continue; // quem o cartão tira não gasta conferência: os elegíveis mais antigos ainda chegam
            }
            leadId = lead.id;
          }
        }
        conferidos++;
        aprovados.push({ c, leadId, confirmado: !!achado.leadConfirmado });
      } catch (err) {
        // 429, timeout, Kommo fora: na dúvida o paciente NÃO entra hoje (pode ter dito que não quer) e a próxima rodada tenta de novo
        conferidos++;
        r.incertos++;
        logger.warn({ err: String(err), unit: unit.slug }, `${ID_RECUPERACAO}: não consegui conferir um cartão — esse paciente fica para a próxima rodada`);
      }
      if (pausa) await dormir(pausa);
    }
    r.restantes = Math.max(0, novos.length - percorridos);
  }

  // 5. grava quem entrou e manda
  const itens: Array<{ c: Candidato; leadId: number | null; link: string | null }> = [];
  for (const a of aprovados) {
    const gravar: ItemParaGravar = {
      unitId: unit.id,
      idSchedule: a.c.idSchedule,
      pacienteChave: a.c.pacienteChave,
      categoria: a.c.categoria,
      tipo: a.c.tipo,
      inicioEm: a.c.inicio,
      modificadoEm: a.c.modificadoEm,
      modo: modoDaLinha,
      dia: hoje,
      // o cartão só fica ligado ao item quando o telefone o confirmou
      kommoLeadId: a.confirmado ? a.leadId : null,
      envio: modo === 'ligado' ? 'enviando' : 'simulado',
    };
    if (!(await armazem.reivindicar(gravar))) continue; // outra rodada já pegou
    itens.push({ c: a.c, leadId: a.confirmado ? a.leadId : null, link: a.confirmado ? linkDoCartao(unit, a.leadId ?? undefined) : null });
  }
  r.listados = itens.length;
  r.semCartao = itens.filter((i) => !i.link).length;

  let desfecho = 'simulado';
  if (modo === 'seco') {
    const simular = deps.simular ?? registrarSimulacao;
    for (const i of itens) {
      if (i.leadId) simular(unit, ID_RECUPERACAO, { leadId: i.leadId, acao: 'mandaria', alvo: `recuperacao:${i.c.idSchedule}`, valor: `avaliação de ${i.c.dia} ${i.c.hora} — ${i.c.tipo}`, motivo: destinoDaRecuperacao(unit.slug, env.RECUPERACAO_DESTINOS) ? 'para o grupo da unidade' : 'SEM destino em RECUPERACAO_DESTINOS: ligada, não sairia' });
    }
    logger.info({ unit: unit.slug, ...resumoParaLog(r) }, `${ID_RECUPERACAO}: lista simulada (só no papel) — nada foi enviado`);
  } else if (itens.length > 0 && destino && cfg) {
    const partes = partesDaLista({
      hoje,
      restantes: r.restantes,
      dias: limites.dias,
      itens: itens.map<ItemDoTexto>((i) => ({ nome: nomeParaOTexto(i.c.nome), dia: i.c.dia, hora: i.c.hora, tipo: i.c.tipo, link: i.link })),
    });
    const enviar = deps.enviar ?? ((a) => enviarPelaEvolutionComResultado(a));
    // O desfecho vale PARA QUEM ESTAVA NA MENSAGEM: uma continuação que não saiu não pode marcar como «enviado» quem ficou nela.
    // Depois de uma falha as partes seguintes nem são tentadas (a ordem da lista importa) e seus itens ficam pendentes.
    let falhou = false;
    const desfechos: string[] = [];
    for (const p of partes) {
      let d: string;
      if (falhou) d = 'pendente';
      else {
        const res = await enviar({ ...cfg, numero: destino, texto: p.texto });
        if (res === 'ok') {
          r.mensagens++;
          d = 'enviado';
        } else {
          falhou = true;
          d = res === 'recusado' ? 'pendente' : 'incerto';
          logger.warn({ unit: unit.slug, parte: partes.indexOf(p) + 1, de: partes.length, resultado: res }, `${ID_RECUPERACAO}: uma parte da lista não saiu`);
        }
      }
      for (let k = p.de; k < p.ate; k++) {
        await armazem.concluir(unit.id, itens[k].c.idSchedule, 'ligado', d);
        desfechos.push(d);
      }
    }
    desfecho = desfechos.includes('pendente') ? 'pendente' : desfechos.includes('incerto') ? 'incerto' : 'enviado';
    logger.info({ unit: unit.slug, desfecho, partes: partes.length, ...resumoParaLog(r) }, `${ID_RECUPERACAO}: lista ${desfecho === 'enviado' ? 'enviada' : desfecho === 'pendente' ? 'NÃO saiu inteira (o que ficou volta na próxima rodada)' : 'sem resposta (pode ter saído; não repito)'}`);
  }

  // Memória do dia: fecha quando a rodada terminou sem cartão incerto (ou depois de algumas tentativas) e a lista não ficou recusada — recusada volta na
  // próxima rodada, até o teto de rodadas do dia. O que vale entre reinícios é o banco (no início da rodada): saiu lista hoje = o dia está fechado, e os
  // `incertos` (Kommo fora) esperam o dia seguinte, em vez de virar uma 2ª mensagem.
  const tentativas = contarRodada(chaveDoDia);
  if ((r.incertos === 0 || tentativas >= TENTATIVAS_POR_DIA) && desfecho !== 'pendente') diaFechado.add(chaveDoDia);
  return r;
}

const resumoParaLog = (r: ResumoDaLista) => ({
  candidatos: r.candidatos, saidasDaAgenda: r.saidasDaAgenda, saidasDoCartao: r.saidasDoCartao, incertos: r.incertos, listados: r.listados, semCartao: r.semCartao, restantes: r.restantes,
});

// ── o relógio ──────────────────────────────────────────────────────────────────────────────────

let primeira: NodeJS.Timeout | null = null;
let timer: NodeJS.Timeout | null = null;
let rodando = false;

async function varrerTodas(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const units = await prisma.unit.findMany({ where: await ondeTemSync() });
    for (const u of units) {
      if (estadoDaRecuperacao(u.slug) === 'desligado') continue;
      await listarRecuperacao(u);
    }
  } catch (err) {
    logger.error({ err: String(err) }, `${ID_RECUPERACAO}: a rodada falhou antes de varrer`);
  } finally {
    rodando = false;
  }
}

export function startRecuperacaoAgendaWorker(): void {
  if (timer || primeira) return;
  logger.info({ slugs: process.env.RECUPERACAO_AGENDA_SLUGS || '(vazio = só o que a tela ligar)' }, `${ID_RECUPERACAO}: worker iniciado`);
  primeira = setTimeout(() => void varrerTodas(), PRIMEIRA_MS);
  primeira.unref();
  timer = setInterval(() => void varrerTodas(), INTERVALO_MS);
  timer.unref();
}

export function stopRecuperacaoAgendaWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}
