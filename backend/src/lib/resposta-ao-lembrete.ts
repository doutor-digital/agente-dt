/**
 * RESPOSTA AOS LEMBRETES DO ROBÔ DO KOMMO — o paciente toca "Confirmar presença" ou "Preciso remarcar".
 *
 * Por que existe (auditoria da Açailândia, 16/10/2026): os modelos do Kommo (véspera e dia da consulta,
 * véspera e dia da sessão) saem com os botões "Confirmar presença / Preciso remarcar", mas o toque caía
 * no vazio. Em EM TRATAMENTO a Sofia não responde: 104 mensagens de 20 pacientes em 7 dias, a maioria
 * tocando "Confirmar presença", sem resposta nenhuma. Em AGENDADO a Sofia respondia "presença
 * confirmada" sem registrar nada na franquia, porque não enxerga a consulta que a recepção marcou.
 *
 * Decisão do João (16/10): "responde e confirma na franquia". É o MESMO caminho da resposta à véspera
 * do servidor (`confirmacao-d1.ts`): mesmo texto, mesmo `confirmarNaFranquia`, mesma tarefa quando a
 * franquia não aceita. O que muda é a prova de que a pergunta saiu. Lá, a marca gravada pelo servidor
 * ao perguntar; aqui, o horário que o próprio lembrete anunciou — o campo do cartão que dispara o
 * robô (◷ Data da Consulta ou ◷ Próxima sessão) — tem de estar nas próximas 30 h e bater com o
 * agendamento da franquia. Sem isso não se confirma nada na franquia.
 *
 * Conservador de propósito:
 *  - só o TOQUE no botão (ou o mesmo texto digitado) entra aqui. "sim", "ok", "1" soltos continuam com a
 *    Sofia: sem a pergunta do servidor armada não dá para saber a que o paciente diz sim;
 *  - agendamento que não bate exatamente com o horário do cartão: responde, mas NÃO confirma na franquia
 *    — abre tarefa para a equipe confirmar na agenda (o mesmo aviso de `confirmarNaFranquia`);
 *  - "só no papel": não responde nem escreve nada; registra na tela o que faria e devolve null, e a
 *    conversa segue exatamente como hoje.
 */
import type { Conversation, Unit } from '@prisma/client';
import { logger } from './logger.js';
import type { Estado } from './automacoes-estado.js';
import { AUTOMACAO_DO_LEMBRETE, estadoDoLembrete, type TipoLembrete } from './lembrete-chaves.js';
import { ehConsulta, normalizar } from './franquia-sync.js';
import { esquemaDaUnidade, type EsquemaKommo } from './kommo-schema.js';
import { avisoRecente, marcarAviso } from './aviso-dedupe.js';
import { registrarSimulacao, type Simulacao } from './so-no-papel.js';
import { fusoDaUnidade } from './fuso.js';
import { idClientDoLead } from './franquia-sync-worker.js';
import {
  DEPS_CONFIRMAR_PADRAO,
  confirmarNaFranquia,
  diaCurto,
  marcarSituacaoConfirmada,
  type DepsConfirmarNaFranquia,
  type RespostaD1,
  type ResultadoFranquia,
} from './confirmacao-d1.js';
import { consultaDoLead, type ConsultaReconciliada } from '../services/agenda-reconcile.service.js';
import {
  SPINE_STATUS,
  SpineService,
  instanteNoFuso,
  localParaUtcIso,
  type SpineSchedule,
} from '../services/spine.service.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';

export type { TipoLembrete } from './lembrete-chaves.js';

// ── o toque ───────────────────────────────────────────────────────────────────────────────────────

/** Rótulos dos botões dos modelos (normalizados: minúsculo, sem acento, sem pontuação nem emoji). */
const BOTOES_CONFIRMA = new Set([
  'confirmar presenca',
  'confirmar',
  'confirmo',
  'confirmo presenca',
  'confirmado',
  'confirmada',
  'presenca confirmada',
  'vou comparecer',
  'estarei la',
]);
const BOTOES_REMARCA = new Set([
  'preciso remarcar',
  'quero remarcar',
  'remarcar',
  'preciso reagendar',
  'quero reagendar',
  'reagendar',
]);

/** O texto é o de um botão de lembrete? Igualdade exata — "confirmar, mas posso chegar 14h?" vai para a Sofia. */
export function classificarBotaoDoLembrete(texto: string): RespostaD1 | null {
  const s = normalizar(texto);
  if (!s) return null;
  if (BOTOES_CONFIRMA.has(s)) return 'confirmou';
  if (BOTOES_REMARCA.has(s)) return 'remarcar';
  return null;
}

/**
 * Teste SÍNCRONO e barato: esta mensagem pode ser um toque de lembrete tratado em código? Serve para o
 * webhook responder 200 ao Kommo ANTES do trabalho pesado (o Kommo dá 2 s e reenvia quem passa disso).
 */
export function podeSerBotaoDoLembrete(slug: string, texto: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!classificarBotaoDoLembrete(texto)) return false;
  return estadoDoLembrete(slug, 'consulta', env) !== 'desligado' || estadoDoLembrete(slug, 'sessao', env) !== 'desligado';
}

// ── a qual lembrete o toque responde ──────────────────────────────────────────────────────────────

export const CAMPOS_DO_LEMBRETE = {
  CONSULTA: '◷ Data da Consulta',
  SESSAO: '◷ Próxima sessão',
  ID_TRATAMENTO: '⚙ idTreatment (franquia)',
  ID_CLIENTE: '⚙ idClient (franquia)',
} as const;

/** O robô manda 24 h antes (véspera) e 3 h antes (no dia); o toque chega depois. 30 h cobre a véspera com folga. */
export const JANELA_LEMBRETE_S = 30 * 3600;
/** Quem toca logo depois do horário (entrega atrasada, leu na porta da clínica) ainda conta. */
export const TOLERANCIA_DEPOIS_S = 30 * 60;
/** Horário do cartão × horário da franquia: até 5 min de diferença é o mesmo agendamento. */
export const MESMO_HORARIO_S = 5 * 60;

export interface DatasDoCartao {
  /** epoch (s) da ◷ Data da Consulta */
  consulta: number | null;
  /** epoch (s) da ◷ Próxima sessão */
  sessao: number | null;
  idTreatment: number | null;
  idClient: number | null;
}

function numeroPositivo(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** PURA: lê do cartão as datas que disparam os robôs e os ids da franquia. Campo que a conta não tem = null. */
export function datasDoCartao(
  lead: Pick<KommoLead, 'custom_fields_values'>,
  campoPorNome: EsquemaKommo['campoPorNome'],
): DatasDoCartao {
  const valor = (nome: string): unknown => {
    const id = campoPorNome(nome);
    if (id === null) return null;
    return (lead.custom_fields_values ?? []).find((f) => f.field_id === id)?.values?.[0]?.value ?? null;
  };
  const inteiro = (v: unknown): number | null => {
    const n = numeroPositivo(v);
    return n !== null && Number.isInteger(n) ? n : null;
  };
  return {
    consulta: numeroPositivo(valor(CAMPOS_DO_LEMBRETE.CONSULTA)),
    sessao: numeroPositivo(valor(CAMPOS_DO_LEMBRETE.SESSAO)),
    idTreatment: inteiro(valor(CAMPOS_DO_LEMBRETE.ID_TRATAMENTO)),
    idClient: inteiro(valor(CAMPOS_DO_LEMBRETE.ID_CLIENTE)),
  };
}

export interface LembreteAlvo {
  tipo: TipoLembrete;
  /** epoch (s) do horário que o lembrete anunciou (o campo do cartão) */
  quandoEpoch: number;
  estado: Estado;
}

/**
 * PURA: a qual lembrete este toque responde. Só conta o tipo cuja chave não está desligada e cujo
 * horário no cartão está nas próximas 30 h (ou passou há menos de 30 min). Os dois valendo: o mais
 * próximo, que é o último lembrete que saiu.
 */
export function qualLembrete(args: {
  datas: Pick<DatasDoCartao, 'consulta' | 'sessao'>;
  agoraEpoch: number;
  estados: Record<TipoLembrete, Estado>;
}): LembreteAlvo | null {
  const { datas, agoraEpoch, estados } = args;
  const candidatos: LembreteAlvo[] = [];
  for (const tipo of ['consulta', 'sessao'] as const) {
    const q = datas[tipo];
    const estado = estados[tipo];
    if (estado === 'desligado' || q === null) continue;
    if (q < agoraEpoch - TOLERANCIA_DEPOIS_S || q > agoraEpoch + JANELA_LEMBRETE_S) continue;
    candidatos.push({ tipo, quandoEpoch: q, estado });
  }
  candidatos.sort((a, b) => a.quandoEpoch - b.quandoEpoch);
  return candidatos[0] ?? null;
}

const epochDoAgendamento = (s: Pick<SpineSchedule, 'dateAttendanceUtc'>): number => {
  const ms = Date.parse(String(s.dateAttendanceUtc ?? ''));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
};

/**
 * PURA: entre os agendamentos do paciente, o que o lembrete anunciou.
 *
 * Tem de ser do tipo certo (avaliação/retorno × sessão), estar de pé (agendado ou confirmado) e cair
 * no MESMO horário do cartão (±5 min). Campo do cartão só com o dia (meia-noite): vale o único
 * agendamento daquele dia. Dois no mesmo horário, ou nenhum: null — não se confirma no escuro.
 */
export function escolherAgendamento(args: {
  schedules: SpineSchedule[];
  tipo: TipoLembrete;
  quandoEpoch: number;
  idTreatment: number | null;
  tz: string;
}): SpineSchedule | null {
  const { schedules, tipo, quandoEpoch, idTreatment, tz } = args;
  const vistos = new Set<number>();
  const vivos = schedules.filter((s) => {
    if (!s.idSchedule || vistos.has(s.idSchedule)) return false;
    if (!Number.isFinite(epochDoAgendamento(s))) return false;
    if (s.idStatus !== null && s.idStatus !== SPINE_STATUS.AGENDADO && s.idStatus !== SPINE_STATUS.CONFIRMADO) return false;
    if (tipo === 'consulta' ? !ehConsulta(s) : ehConsulta(s)) return false;
    if (tipo === 'sessao' && idTreatment && s.idTreatment !== null && s.idTreatment !== idTreatment) return false;
    vistos.add(s.idSchedule);
    return true;
  });

  const exatos = vivos.filter((s) => Math.abs(epochDoAgendamento(s) - quandoEpoch) <= MESMO_HORARIO_S);
  if (exatos.length === 1) return exatos[0];
  if (exatos.length > 1) return null;

  // Campo de data sem hora: o Kommo guarda meia-noite (no fuso da conta ou em UTC, conforme a conta).
  const dias = new Set<string>();
  const local = instanteNoFuso(new Date(quandoEpoch * 1000), tz);
  if (local.slice(11, 16) === '00:00') dias.add(local.slice(0, 10));
  const utc = new Date(quandoEpoch * 1000).toISOString();
  if (utc.slice(11, 16) === '00:00') dias.add(utc.slice(0, 10));
  if (dias.size === 0) return null;
  const doDia = vivos.filter((s) => s.dayLocal !== null && dias.has(s.dayLocal));
  return doDia.length === 1 ? doDia[0] : null;
}

/** O agendamento escolhido no formato que `confirmarNaFranquia` já entende. */
export function comoConsultaReconciliada(s: SpineSchedule): ConsultaReconciliada | null {
  if (!s.idSchedule || !s.dayLocal || !s.timeLocal) return null;
  const quando = `${s.dayLocal}T${s.timeLocal}`;
  return { idSchedule: s.idSchedule, quando, salvo: quando, estado: 'confirmada', mudou: false, especialista: null, idStatus: s.idStatus };
}

// ── textos ────────────────────────────────────────────────────────────────────────────────────────

function primeiroNome(nome: string | null | undefined): string {
  const p = (nome ?? '').trim().split(/\s+/)[0];
  return p ? `, ${p}` : '';
}

/** "quinta, 17/10 às 14:00" — ou vazio quando não se sabe o horário com certeza. */
function quandoPorExtenso(quando: string | null): string {
  if (!quando || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(quando)) return '';
  return ` ${diaCurto(quando)} às ${quando.slice(11, 16)}`;
}

export function textoRespostaAoLembrete(args: {
  tipo: TipoLembrete;
  resposta: RespostaD1;
  nome: string | null | undefined;
  /** "AAAA-MM-DDTHH:mm" local, ou null */
  quando: string | null;
}): string {
  const nome = primeiroNome(args.nome);
  const quando = quandoPorExtenso(args.quando);
  if (args.resposta === 'remarcar') {
    return `Sem problema${nome}! 🙏 Vou pedir para a equipe combinar um novo horário com você por aqui. Se preferir, me diga qual dia e período ficam melhores.`;
  }
  if (args.tipo === 'sessao') {
    return `Presença confirmada${nome}! 💙 Te esperamos na sua sessão${quando}. Qualquer coisa é só me chamar por aqui.`;
  }
  return `Confirmado${nome}! 💙 Te esperamos${quando}. Chegue uns 15 minutos antes, tá? Qualquer coisa é só me chamar por aqui.`;
}

export function textoTarefaRemarcar(args: {
  slug: string;
  tipo: TipoLembrete;
  nome: string | null | undefined;
  quando: string | null;
  texto: string;
}): string {
  const oQue = args.tipo === 'sessao' ? 'a sessão' : 'a consulta';
  const quando = args.quando ? ` de${quandoPorExtenso(args.quando)}` : '';
  return (
    `ALERTA · ${args.slug} · [Contato: ${args.nome ?? 'paciente'}] 🔁 Pediu para remarcar ${oQue}${quando} ` +
    `(tocou "${args.texto.trim().slice(0, 60)}" no lembrete). Combinar novo horário com o paciente.`
  );
}

// ── a franquia ────────────────────────────────────────────────────────────────────────────────────

/**
 * Os agendamentos do paciente deste cartão na franquia. null = a franquia não respondeu (não confundir
 * com "não tem"). Ordem: ⚙ idClient do cartão → vínculo da Sofia / telefone (`idClientDoLead`) → para
 * sessão, a agenda do dia pelo ⚙ idTreatment → para consulta, o agendamento que a Sofia marcou.
 */
/** O fuso com que a franquia calcula `dayLocal`/`timeLocal` (spine.service usa `spineTimezone`). */
export function fusoDaFranquia(unit: Pick<Unit, 'spineTimezone' | 'businessHoursTimezone'>): string {
  return unit.spineTimezone || fusoDaUnidade(unit);
}

export async function agendamentosDoPaciente(args: {
  unit: Unit;
  leadId: number;
  tipo: TipoLembrete;
  datas: DatasDoCartao;
  quandoEpoch: number;
  nomes: Array<string | null | undefined>;
  telefone: string | null | undefined;
}): Promise<SpineSchedule[] | null> {
  const { unit, leadId, tipo, datas, quandoEpoch, nomes, telefone } = args;
  if (!unit.spineEnabled || !unit.spineToken) return [];
  const tz = fusoDaFranquia(unit);

  const nome = [...new Set(nomes.map((n) => n?.trim()).filter(Boolean))].join(' / ') || null;
  const idClient =
    datas.idClient ??
    (await idClientDoLead(unit, leadId, nome, { fone: telefone, soPorTelefone: true, maxTermos: 5 }).catch(() => null));
  if (idClient) {
    const r = await SpineService.getClient(unit, idClient);
    if (!r.ok) return null;
    if (r.data?.client) return r.data.client.schedules;
  }

  if (tipo === 'sessao' && datas.idTreatment) {
    const dia = instanteNoFuso(new Date(quandoEpoch * 1000), tz).slice(0, 10);
    const r = await SpineService.searchSchedules(unit, { initialDate: dia, endDate: dia, rowsPerPage: 100 });
    if (!r.ok || !r.data) return null;
    return r.data.schedules.filter((s) => s.idTreatment === datas.idTreatment);
  }

  if (tipo === 'consulta') {
    const c = await consultaDoLead(unit, leadId).catch(() => null);
    if (c && c.estado === 'confirmada' && c.quando) {
      const utc = localParaUtcIso(`${c.quando}:00`, tz);
      return [
        {
          idSchedule: c.idSchedule,
          idTreatment: null,
          idStatus: c.idStatus ?? null,
          statusName: null,
          clientName: null,
          categoryName: 'Avaliação',
          physicalTherapist: null,
          dateAttendanceUtc: utc,
          dateAttendanceLocal: `${c.quando}:00`,
          dayLocal: c.quando.slice(0, 10),
          timeLocal: c.quando.slice(11, 16),
          isBusy: true,
          requiresManualValidation: false,
        },
      ];
    }
  }
  return [];
}

// ── o tratamento ──────────────────────────────────────────────────────────────────────────────────

export type KommoDoLembrete = Pick<
  KommoClient,
  'getLead' | 'sendChatReply' | 'createTask' | 'listLeadCustomFieldsTyped' | 'setLeadCustomFieldValue'
>;

/** O que o tratamento usa de fora — tudo injetável para teste. */
export interface DepsLembrete {
  agora: () => Date;
  esquema: (unit: Unit, kommo: KommoDoLembrete) => Promise<Pick<EsquemaKommo, 'campoPorNome'>>;
  agendamentos: typeof agendamentosDoPaciente;
  /** confirmSchedule / esquecerConsulta repassados a `confirmarNaFranquia`. */
  franquia: Pick<DepsConfirmarNaFranquia, 'confirmSchedule' | 'esquecerConsulta'>;
  jaTratado: (unitId: string, leadId: number, chave: string) => Promise<boolean>;
  marcarTratado: (unitId: string, leadId: number, chave: string) => Promise<void>;
  simular: (unit: Pick<Unit, 'id' | 'slug'>, automacao: string, s: Simulacao) => void;
}

/** O mesmo toque pela mesma consulta, de novo, dentro disto: não responde outra vez. */
export const JANELA_REPETICAO_LEMBRETE_MS = 48 * 3600_000;

export const DEPS_LEMBRETE_PADRAO: DepsLembrete = {
  agora: () => new Date(),
  // O esquema só usa a lista de campos e funis, que o cliente completo tem; o Pick é para o teste.
  esquema: (unit, kommo) => esquemaDaUnidade(unit, kommo as KommoClient),
  agendamentos: agendamentosDoPaciente,
  franquia: DEPS_CONFIRMAR_PADRAO,
  jaTratado: (unitId, leadId, chave) => avisoRecente(unitId, leadId, chave, JANELA_REPETICAO_LEMBRETE_MS),
  marcarTratado: (unitId, leadId, chave) => marcarAviso(unitId, leadId, chave),
  simular: registrarSimulacao,
};

/**
 * Dois toques quase juntos (duplo clique, ou o paciente toca de novo antes de a resposta chegar) passariam
 * os dois pela marca do banco antes de qualquer um gravar. A trava em memória fecha essa janela neste
 * processo; a marca do banco cobre o resto (reentrega, outro processo depois).
 */
const emAndamento = new Set<string>();

export interface ResultadoDoLembrete {
  resposta: RespostaD1 | 'repetida';
  tipo: TipoLembrete;
  /** O agendamento da franquia que o toque confirmou (ou ia confirmar). */
  idSchedule: number | null;
  /** Só no "confirmou": o que aconteceu na franquia. */
  franquia: ResultadoFranquia | null;
}

/**
 * Trata o toque num botão de lembrete do Kommo. null = não é caso deste tratamento (ou está só no
 * papel) e a mensagem segue para a Sofia como sempre. Erro ANTES de responder ao paciente sobe para o
 * chamador (que manda para a Sofia); depois da resposta, nada lança.
 */
export async function tratarBotaoDoLembrete(
  args: {
    unit: Unit;
    leadId: number;
    texto: string;
    conv: Pick<Conversation, 'contactName' | 'phone'>;
    kommo: KommoDoLembrete;
    env?: NodeJS.ProcessEnv;
  },
  deps: DepsLembrete = DEPS_LEMBRETE_PADRAO,
): Promise<ResultadoDoLembrete | null> {
  const { unit, leadId, texto, conv, kommo } = args;
  const env = args.env ?? process.env;
  const resposta = classificarBotaoDoLembrete(texto);
  if (!resposta) return null;
  const estados: Record<TipoLembrete, Estado> = {
    consulta: estadoDoLembrete(unit.slug, 'consulta', env),
    sessao: estadoDoLembrete(unit.slug, 'sessao', env),
  };
  if (estados.consulta === 'desligado' && estados.sessao === 'desligado') return null;

  const lead = await kommo.getLead(leadId);
  const esquema = await deps.esquema(unit, kommo);
  const datas = datasDoCartao(lead, esquema.campoPorNome);
  const agoraEpoch = Math.floor(deps.agora().getTime() / 1000);
  const alvo = qualLembrete({ datas, agoraEpoch, estados });
  const log = { unit: unit.slug, leadId, resposta };
  if (!alvo) {
    logger.info({ ...log, consulta: datas.consulta, sessao: datas.sessao }, 'lembrete: toque sem lembrete nas próximas 30 h — segue para a Sofia');
    return null;
  }

  const tz = fusoDaFranquia(unit);
  const automacao = AUTOMACAO_DO_LEMBRETE[alvo.tipo];
  const oQue: 'consulta' | 'sessão' = alvo.tipo === 'sessao' ? 'sessão' : 'consulta';
  const horarioDoCartao = instanteNoFuso(new Date(alvo.quandoEpoch * 1000), tz).slice(0, 16);
  const chave = `lembrete_${alvo.tipo}:${horarioDoCartao}:${resposta}`;
  const contexto = { unit, leadId, texto, conv, kommo, resposta, alvo, datas, lead, tz, automacao, oQue, horarioDoCartao, chave, log };
  if (alvo.estado !== 'ligado') return responderAoLembrete(contexto, deps);

  const repetida = (): ResultadoDoLembrete => {
    logger.info({ ...log, tipo: alvo.tipo, chave }, 'lembrete: o mesmo toque já foi respondido — sem repetir, sem Sofia');
    return { resposta: 'repetida', tipo: alvo.tipo, idSchedule: null, franquia: null };
  };
  // Confere e trava no MESMO passo síncrono — com um await no meio, o segundo toque passaria antes da trava.
  const trava = `${unit.id}:${leadId}:${chave}`;
  if (emAndamento.has(trava)) return repetida();
  emAndamento.add(trava);
  try {
    if (await deps.jaTratado(unit.id, leadId, chave)) return repetida();
    return await responderAoLembrete(contexto, deps);
  } finally {
    emAndamento.delete(trava);
  }
}

async function responderAoLembrete(
  a: {
    unit: Unit;
    leadId: number;
    texto: string;
    conv: Pick<Conversation, 'contactName' | 'phone'>;
    kommo: KommoDoLembrete;
    resposta: RespostaD1;
    alvo: LembreteAlvo;
    datas: DatasDoCartao;
    lead: Pick<KommoLead, 'name'>;
    tz: string;
    automacao: string;
    oQue: 'consulta' | 'sessão';
    horarioDoCartao: string;
    chave: string;
    log: Record<string, unknown>;
  },
  deps: DepsLembrete,
): Promise<ResultadoDoLembrete | null> {
  const { unit, leadId, texto, conv, kommo, resposta, alvo, datas, lead, tz, automacao, oQue, horarioDoCartao, chave, log } = a;

  const schedules = await deps
    .agendamentos({
      unit,
      leadId,
      tipo: alvo.tipo,
      datas,
      quandoEpoch: alvo.quandoEpoch,
      nomes: [lead.name, conv.contactName],
      telefone: conv.phone,
    })
    .catch((err) => {
      logger.warn({ ...log, err: String(err) }, 'lembrete: falha ao ler a agenda do paciente na franquia');
      return null;
    });
  const escolhido = schedules
    ? escolherAgendamento({ schedules, tipo: alvo.tipo, quandoEpoch: alvo.quandoEpoch, idTreatment: datas.idTreatment, tz })
    : null;
  const consulta = escolhido ? comoConsultaReconciliada(escolhido) : null;
  // O horário dito ao paciente: o da franquia quando bateu; senão o do cartão (é o que o lembrete mostrou),
  // a não ser que o campo só tenha o dia.
  const quandoDito = consulta?.quando ?? (horarioDoCartao.slice(11, 16) === '00:00' ? null : horarioDoCartao);

  if (alvo.estado === 'seco') {
    deps.simular(unit, automacao, {
      leadId,
      acao: resposta === 'confirmou' ? 'gravaria' : 'alertaria',
      alvo: resposta === 'confirmou' ? `${oQue} CONFIRMADA na franquia + resposta ao paciente` : `tarefa: pediu para remarcar a ${oQue}`,
      valor: consulta?.quando ?? horarioDoCartao,
      motivo: escolhido
        ? `agendamento ${escolhido.idSchedule} (${escolhido.statusName ?? escolhido.idStatus ?? 'status ?'})`
        : schedules === null
          ? 'a franquia não respondeu — responderia e abriria tarefa'
          : 'não achei o agendamento do horário do cartão na franquia — responderia e abriria tarefa',
    });
    logger.info({ ...log, tipo: alvo.tipo, idSchedule: escolhido?.idSchedule ?? null }, 'lembrete [seco]: responderia o toque em código (a Sofia segue)');
    return null;
  }

  if (resposta === 'remarcar') {
    await kommo
      .createTask({
        leadId,
        text: textoTarefaRemarcar({ slug: unit.slug, tipo: alvo.tipo, nome: conv.contactName, quando: quandoDito, texto }),
        completeAt: Math.floor(deps.agora().getTime() / 1000) + 30 * 60,
      })
      .catch((err) => logger.warn({ ...log, err: String(err) }, 'lembrete: falha ao abrir a tarefa de remarcação'));
  } else if (alvo.tipo === 'consulta') {
    await marcarSituacaoConfirmada(kommo, leadId).catch((err) => {
      logger.warn({ ...log, err: String(err) }, 'lembrete: não consegui marcar ✓ Situação da consulta = Confirmado');
      return false;
    });
  }

  await kommo.sendChatReply({
    leadId,
    text: textoRespostaAoLembrete({ tipo: alvo.tipo, resposta, nome: conv.contactName, quando: quandoDito }),
    chatId: null,
    talkId: null,
    contactId: null,
  });
  // A resposta já saiu: marca antes de falar com a franquia, que pode demorar ou falhar.
  await deps.marcarTratado(unit.id, leadId, chave).catch(() => undefined);

  let franquia: ResultadoFranquia | null = null;
  if (resposta === 'confirmou') {
    franquia = await confirmarNaFranquia(
      { unit, leadId, consulta, contactName: conv.contactName, kommo, oQue },
      // A prova de que o lembrete falou DESTE agendamento é o horário do cartão batendo com o da franquia.
      { ...deps.franquia, perguntou: async () => consulta !== null },
    );
  }
  logger.info(
    { ...log, tipo: alvo.tipo, idSchedule: escolhido?.idSchedule ?? null, franquia },
    'lembrete: toque respondido em código, sem Sofia',
  );
  return { resposta, tipo: alvo.tipo, idSchedule: escolhido?.idSchedule ?? null, franquia };
}
