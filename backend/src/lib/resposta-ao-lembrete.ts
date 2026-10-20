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
 * do servidor (`confirmacao-d1.ts`): mesmo `confirmarNaFranquia`, mesma tarefa quando a franquia não
 * aceita. O que muda é a prova de que a pergunta saiu. Lá, a marca gravada pelo servidor ao perguntar.
 * Aqui, TRÊS coisas juntas (revisão de 16/10):
 *   1. a ÚLTIMA mensagem que saiu na conversa oficial foi um LEMBRETE de robô — não fala da SDR, não fala
 *      da Sofia (as falas dela estão no nosso banco), saiu há menos de 30 h e fala de consulta OU de
 *      sessão. É ela que diz de qual agendamento o paciente fala: escolher pela data mais próxima
 *      confirmava a sessão das 18h quando o toque era na véspera do retorno das 10h de amanhã;
 *   2. o campo do cartão daquele tipo (◷ Data da Consulta ou ◷ Próxima sessão) nas próximas 30 h;
 *   3. o agendamento da franquia no mesmo horário (±5 min) — e, quando o lembrete traz a hora, a mesma hora.
 * Falta 2 ou 3, ou o lembrete não diz o tipo: responde e abre tarefa, sem confirmar nada na franquia.
 * Falta 1 (o "Confirmado" digitado respondendo outra pergunta da SDR): não é com este tratamento — segue
 * para a Sofia, como sempre.
 *
 * Repetição do toque nunca fica sem resposta: "Já está confirmado ✅". Só o toque duplo no mesmo instante
 * (a primeira resposta ainda saindo) fica calado.
 *
 * "Só no papel": não responde nem escreve nada; registra na tela o que faria e devolve null, e a conversa
 * segue exatamente como hoje.
 */
import type { Conversation, Unit } from '@prisma/client';
import { prisma } from './prisma.js';
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
import { mensagensOficiais, type MensagemOficial } from '../services/kommo-talks.service.js';
import { addMessage } from '../services/conversations.service.js';

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


// ── as datas do cartão ────────────────────────────────────────────────────────────────────────────

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

// ── a prova: a última fala que saiu foi um lembrete ───────────────────────────────────────────────

/** Tipo do lembrete pelo texto do modelo. null = não parece lembrete; 'incerto' = lembrete, mas não diz de quê. */
export function lembreteDaMensagem(texto: string): TipoLembrete | 'incerto' | null {
  const s = normalizar(texto);
  if (!s) return null;
  const pareceLembrete = /\b(amanha|hoje|confirm\w*|presenca|marcad[ao]|agendad[ao]|lembr\w*)\b/.test(s);
  if (!pareceLembrete) return null;
  const sessao = /\bsess(ao|oes)\b/.test(s);
  const consulta = /\b(consulta|avaliacao|retorno)\b/.test(s);
  if (sessao && !consulta) return 'sessao';
  if (consulta && !sessao) return 'consulta';
  return 'incerto';
}

/** A hora que o lembrete anunciou ("14:30", "14h30", "às 9h") → "HH:MM". Sem hora, ou com duas diferentes: null. */
export function horaDaMensagem(texto: string): string | null {
  const t = String(texto ?? '').toLowerCase();
  const horas = new Set<string>();
  for (const m of t.matchAll(/\b([01]?\d|2[0-3])\s*(?::|h)\s*([0-5]\d)\b/g)) horas.add(`${m[1].padStart(2, '0')}:${m[2]}`);
  for (const m of t.matchAll(/\b([01]?\d|2[0-3])\s*h(?![0-9a-z])/g)) horas.add(`${m[1].padStart(2, '0')}:00`);
  return horas.size === 1 ? [...horas][0] : null;
}

export interface ProvaDoLembrete {
  tipo: TipoLembrete | 'incerto';
  hora: string | null;
  /** id da mensagem do lembrete na conversa oficial (chave da resposta "incerto") */
  mensagemId: string;
  em: Date;
}

/** A fala da Sofia no nosso banco contém este texto? (o Kommo pode partir a fala longa em pedaços) */
function ehFalaDaSofia(texto: string, falasDaSofia: readonly string[]): boolean {
  const alvo = normalizar(texto).slice(0, 60);
  if (alvo.length < 8) return false;
  return falasDaSofia.some((f) => normalizar(f).includes(alvo));
}

/**
 * PURA: a última mensagem que SAIU na conversa foi um lembrete de robô? null = não há prova (não é
 * resposta a lembrete — segue para a Sofia).
 */
export function provaDoLembrete(args: {
  msgs: ReadonlyArray<Pick<MensagemOficial, 'id' | 'direcao' | 'autor' | 'texto' | 'em'>>;
  agora: Date;
  falasDaSofia: readonly string[];
}): ProvaDoLembrete | null {
  const saidas = args.msgs
    .filter((m) => m.direcao === 'saida' && m.em.getTime() <= args.agora.getTime())
    .sort((a, b) => a.em.getTime() - b.em.getTime());
  const ultima = saidas[saidas.length - 1];
  if (!ultima) return null;
  if (args.agora.getTime() - ultima.em.getTime() > JANELA_LEMBRETE_S * 1000) return null;
  if (ultima.autor === 'equipe') return null; // a SDR falou por último: o "confirmado" é com ela
  if (ehFalaDaSofia(ultima.texto, args.falasDaSofia)) return null; // a Sofia falou por último
  const tipo = lembreteDaMensagem(ultima.texto);
  if (!tipo) return null;
  return { tipo, hora: horaDaMensagem(ultima.texto), mensagemId: ultima.id, em: ultima.em };
}

export type AlvoDoLembrete =
  | { tipo: TipoLembrete; quandoEpoch: number; estado: Estado; hora: string | null }
  | { tipo: 'incerto'; estado: Estado; motivo: string };

/**
 * PURA: com a prova na mão, de qual agendamento o paciente fala. null = a chave daquele tipo está
 * desligada (segue para a Sofia). 'incerto' = é resposta a lembrete, mas não dá para dizer qual agendamento.
 */
export function alvoDoLembrete(args: {
  prova: ProvaDoLembrete;
  datas: Pick<DatasDoCartao, 'consulta' | 'sessao'>;
  agoraEpoch: number;
  estados: Record<TipoLembrete, Estado>;
}): AlvoDoLembrete | null {
  const { prova, datas, agoraEpoch, estados } = args;
  if (prova.tipo === 'incerto') {
    const estado: Estado | null =
      estados.consulta === 'ligado' || estados.sessao === 'ligado'
        ? 'ligado'
        : estados.consulta === 'seco' || estados.sessao === 'seco'
          ? 'seco'
          : null;
    return estado ? { tipo: 'incerto', estado, motivo: 'o lembrete não diz se é consulta ou sessão' } : null;
  }
  const estado = estados[prova.tipo];
  if (estado === 'desligado') return null;
  const q = datas[prova.tipo];
  const nome = prova.tipo === 'sessao' ? '◷ Próxima sessão' : '◷ Data da Consulta';
  if (q === null) return { tipo: 'incerto', estado, motivo: `${nome} vazia no cartão` };
  if (q < agoraEpoch - TOLERANCIA_DEPOIS_S || q > agoraEpoch + JANELA_LEMBRETE_S) {
    return { tipo: 'incerto', estado, motivo: `${nome} fora das próximas 30 h` };
  }
  return { tipo: prova.tipo, quandoEpoch: q, estado, hora: prova.hora };
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


// ── textos da repetição e do "não deu para saber" ─────────────────────────────────────────────────

/** O mesmo toque de novo: nunca fica sem resposta. */
export function textoRepeticao(args: {
  resposta: RespostaD1;
  tipo: TipoLembrete | 'incerto';
  nome: string | null | undefined;
  /** "AAAA-MM-DDTHH:mm" local, ou null */
  quando: string | null;
}): string {
  const nome = primeiroNome(args.nome);
  if (args.resposta === 'remarcar') {
    return `Já pedi para a equipe combinar um novo horário com você${nome} 🙏 Eles te chamam por aqui.`;
  }
  if (args.tipo === 'incerto') return `Já recebemos sua confirmação${nome}! ✅ Qualquer coisa é só me chamar por aqui.`;
  const onde = args.tipo === 'sessao' ? ' na sua sessão' : '';
  return `Já está confirmado${nome}! ✅ Te esperamos${onde}${quandoPorExtenso(args.quando)}. Qualquer coisa é só me chamar por aqui.`;
}

export function textoConfirmacaoIncerta(nome: string | null | undefined): string {
  return `Recebi sua confirmação${primeiroNome(nome)}! 💙 A equipe já registra na agenda. Qualquer coisa é só me chamar por aqui.`;
}

export function textoTarefaIncerta(args: {
  slug: string;
  nome: string | null | undefined;
  resposta: RespostaD1;
  motivo: string;
  texto: string;
}): string {
  const fazer = args.resposta === 'confirmou' ? 'Confirme na agenda da franquia.' : 'Combinar novo horário com o paciente.';
  return (
    `ALERTA · ${args.slug} · [Contato: ${args.nome ?? 'paciente'}] ⚠️ O paciente tocou "${args.texto.trim().slice(0, 60)}" num lembrete, ` +
    `mas não deu para saber com certeza de qual agendamento (${args.motivo}). Nada foi registrado na franquia. ${fazer}`
  );
}

// ── o tratamento ──────────────────────────────────────────────────────────────────────────────────

export type KommoDoLembrete = Pick<
  KommoClient,
  'getLead' | 'sendChatReply' | 'createTask' | 'listLeadCustomFieldsTyped' | 'setLeadCustomFieldValue'
>;

/** O último toque que este tratamento respondeu para o lead (lido da marca em `card_alert`). */
export interface TratadoAntes {
  tipo: TipoLembrete | 'incerto';
  /** horário do cartão ("AAAA-MM-DDTHH:mm") ou, no "incerto", o id da mensagem do lembrete */
  ref: string;
  resposta: RespostaD1;
  em: Date;
}

const PREFIXO_MARCA = 'lembrete_';

export function chaveDoToque(tipo: TipoLembrete | 'incerto', ref: string, resposta: RespostaD1): string {
  return `${PREFIXO_MARCA}${tipo}:${ref}:${resposta}`;
}

export function lerChaveDoToque(chave: string, em: Date): TratadoAntes | null {
  const m = /^lembrete_(consulta|sessao|incerto):(.+):(confirmou|remarcar)$/.exec(chave);
  return m ? { tipo: m[1] as TratadoAntes['tipo'], ref: m[2], resposta: m[3] as RespostaD1, em } : null;
}

/** O que o tratamento usa de fora — tudo injetável para teste. */
export interface DepsLembrete {
  agora: () => Date;
  esquema: (unit: Unit, kommo: KommoDoLembrete) => Promise<Pick<EsquemaKommo, 'campoPorNome'>>;
  /** A conversa oficial do Kommo. null = não consegui ler (aí não há prova: segue para a Sofia). */
  oficiais: (unit: Unit, kommo: KommoDoLembrete, leadId: number) => Promise<MensagemOficial[] | null>;
  /** O que a Sofia (e este tratamento) disse ao paciente desde `desde` — para não confundir fala com lembrete. */
  falasDaSofia: (unitId: string, leadId: number, desde: Date) => Promise<string[]>;
  agendamentos: typeof agendamentosDoPaciente;
  /** confirmSchedule / esquecerConsulta repassados a `confirmarNaFranquia`. */
  franquia: Pick<DepsConfirmarNaFranquia, 'confirmSchedule' | 'esquecerConsulta'>;
  jaTratado: (unitId: string, leadId: number, chave: string) => Promise<boolean>;
  ultimoTratado: (unitId: string, leadId: number) => Promise<TratadoAntes | null>;
  marcarTratado: (unitId: string, leadId: number, chave: string) => Promise<void>;
  /** Grava a resposta no histórico (a Sofia enxerga no próximo turno; o alerta de "sem resposta" também). */
  registrarResposta: (conversationId: string | null, texto: string) => Promise<void>;
  simular: (unit: Pick<Unit, 'id' | 'slug'>, automacao: string, s: Simulacao) => void;
}

/** O mesmo toque pela mesma consulta, de novo, dentro disto: responde "já está confirmado", sem refazer nada. */
export const JANELA_REPETICAO_LEMBRETE_MS = 48 * 3600_000;

export const DEPS_LEMBRETE_PADRAO: DepsLembrete = {
  agora: () => new Date(),
  // O esquema só usa a lista de campos e funis, que o cliente completo tem; o Pick é para o teste.
  esquema: (unit, kommo) => esquemaDaUnidade(unit, kommo as KommoClient),
  oficiais: (_unit, kommo, leadId) => mensagensOficiais(kommo as KommoClient, leadId, 15).catch(() => null),
  falasDaSofia: async (unitId, leadId, desde) => {
    try {
      const conv = await prisma.conversation.findFirst({
        where: { unitId, leadId: String(leadId) },
        orderBy: { lastMessageAt: 'desc' },
        select: { id: true },
      });
      if (!conv) return [];
      const msgs = await prisma.message.findMany({
        where: { conversationId: conv.id, role: 'assistant', createdAt: { gte: desde } },
        orderBy: { createdAt: 'desc' },
        take: 40,
        select: { content: true },
      });
      return msgs.map((m) => m.content);
    } catch {
      return [];
    }
  },
  agendamentos: agendamentosDoPaciente,
  franquia: DEPS_CONFIRMAR_PADRAO,
  jaTratado: (unitId, leadId, chave) => avisoRecente(unitId, leadId, chave, JANELA_REPETICAO_LEMBRETE_MS),
  ultimoTratado: async (unitId, leadId) => {
    try {
      const r = await prisma.cardAlert.findFirst({
        where: {
          unitId,
          leadId: String(leadId),
          ruleKey: { startsWith: PREFIXO_MARCA },
          createdAt: { gte: new Date(Date.now() - JANELA_REPETICAO_LEMBRETE_MS) },
        },
        orderBy: { createdAt: 'desc' },
        select: { ruleKey: true, createdAt: true },
      });
      return r ? lerChaveDoToque(r.ruleKey, r.createdAt) : null;
    } catch {
      return null;
    }
  },
  marcarTratado: (unitId, leadId, chave) => marcarAviso(unitId, leadId, chave),
  registrarResposta: async (conversationId, texto) => {
    if (!conversationId) return;
    await addMessage({ conversationId, role: 'assistant', content: texto, meta: { origem: 'lembrete_kommo' } }).catch(() => undefined);
  },
  simular: registrarSimulacao,
};

/**
 * Dois toques quase juntos (duplo clique, ou o paciente toca de novo antes de a resposta chegar) passariam
 * os dois pela marca do banco antes de qualquer um gravar. A trava em memória fecha essa janela neste
 * processo — e só ela fica calada, porque a primeira resposta já está saindo.
 */
const emAndamento = new Set<string>();

export interface ResultadoDoLembrete {
  resposta: RespostaD1 | 'repetida';
  tipo: TipoLembrete | 'incerto';
  /** O agendamento da franquia que o toque confirmou (ou ia confirmar). */
  idSchedule: number | null;
  /** Só no "confirmou" de um tipo certo: o que aconteceu na franquia. */
  franquia: ResultadoFranquia | null;
  /** No "incerto": por que não deu para saber. */
  motivo?: string;
}

function ultimaSaida(msgs: readonly MensagemOficial[]): MensagemOficial | null {
  let ultima: MensagemOficial | null = null;
  for (const m of msgs) if (m.direcao === 'saida' && (!ultima || m.em > ultima.em)) ultima = m;
  return ultima;
}

interface Contexto {
  unit: Unit;
  leadId: number;
  texto: string;
  conv: Pick<Conversation, 'id' | 'contactName' | 'phone'>;
  kommo: KommoDoLembrete;
  resposta: RespostaD1;
  log: Record<string, unknown>;
}

async function responderRepeticao(
  c: Contexto,
  deps: DepsLembrete,
  tipo: TipoLembrete | 'incerto',
  ref: string | null,
): Promise<ResultadoDoLembrete> {
  const quando = tipo !== 'incerto' && ref && ref.slice(11, 16) !== '00:00' ? ref : null;
  const texto = textoRepeticao({ resposta: c.resposta, tipo, nome: c.conv.contactName, quando });
  await c.kommo.sendChatReply({ leadId: c.leadId, text: texto, chatId: null, talkId: null, contactId: null });
  await deps.registrarResposta(c.conv.id ?? null, texto);
  logger.info({ ...c.log, tipo }, 'lembrete: o mesmo toque de novo — respondido "já está", sem refazer nada');
  return { resposta: 'repetida', tipo, idSchedule: null, franquia: null };
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
    conv: Pick<Conversation, 'id' | 'contactName' | 'phone'>;
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
  const c: Contexto = { unit, leadId, texto, conv, kommo, resposta, log: { unit: unit.slug, leadId, resposta } };

  const agora = deps.agora();
  const msgs = await deps.oficiais(unit, kommo, leadId);
  if (!msgs) {
    logger.info(c.log, 'lembrete: não li a conversa oficial — sem prova do lembrete, segue para a Sofia');
    return null;
  }

  const falas = await deps.falasDaSofia(unit.id, leadId, new Date(agora.getTime() - (JANELA_LEMBRETE_S + 3600) * 1000));
  const antes = await deps.ultimoTratado(unit.id, leadId);
  const ultima = ultimaSaida(msgs);
  // A última fala é a NOSSA resposta a um lembrete (gravada no histórico, depois da marca): o contexto é o mesmo
  // lembrete. Mesmo toque → "já está"; toque diferente (confirmou e depois "preciso remarcar") → trata de novo.
  const nossaRespostaPorUltimo =
    !!antes && !!ultima && ultima.em.getTime() >= antes.em.getTime() - 60_000 && ehFalaDaSofia(ultima.texto, falas);
  let prova: ProvaDoLembrete | null;
  if (antes && ultima && nossaRespostaPorUltimo) {
    const estadoAntes: Estado =
      antes.tipo === 'incerto' ? (estados.consulta === 'ligado' || estados.sessao === 'ligado' ? 'ligado' : 'seco') : estados[antes.tipo];
    if (estadoAntes !== 'ligado') return null;
    if (antes.resposta === resposta) return responderRepeticao(c, deps, antes.tipo, antes.ref);
    prova = { tipo: antes.tipo, hora: null, mensagemId: antes.tipo === 'incerto' ? antes.ref : ultima.id, em: ultima.em };
  } else {
    prova = provaDoLembrete({ msgs, agora, falasDaSofia: falas });
  }
  if (!prova) {
    logger.info(c.log, 'lembrete: a última fala não foi um lembrete do robô — segue para a Sofia');
    return null;
  }

  const lead = await kommo.getLead(leadId);
  const esquema = await deps.esquema(unit, kommo);
  const datas = datasDoCartao(lead, esquema.campoPorNome);
  const agoraEpoch = Math.floor(agora.getTime() / 1000);
  let alvo = alvoDoLembrete({ prova, datas, agoraEpoch, estados });
  if (!alvo) return null;

  const tz = fusoDaFranquia(unit);
  let escolhido: SpineSchedule | null = null;
  let schedules: SpineSchedule[] | null = null;
  let horarioDoCartao: string | null = null;
  if (alvo.tipo !== 'incerto') {
    const tipo = alvo.tipo;
    horarioDoCartao = instanteNoFuso(new Date(alvo.quandoEpoch * 1000), tz).slice(0, 16);
    schedules = await deps
      .agendamentos({ unit, leadId, tipo, datas, quandoEpoch: alvo.quandoEpoch, nomes: [lead.name, conv.contactName], telefone: conv.phone })
      .catch((err) => {
        logger.warn({ ...c.log, err: String(err) }, 'lembrete: falha ao ler a agenda do paciente na franquia');
        return null;
      });
    escolhido = schedules ? escolherAgendamento({ schedules, tipo, quandoEpoch: alvo.quandoEpoch, idTreatment: datas.idTreatment, tz }) : null;
    // A hora escrita no lembrete tem de ser a do agendamento (ou a do cartão, quando a franquia não achou).
    const horaReferencia = escolhido?.timeLocal ?? (horarioDoCartao.slice(11, 16) === '00:00' ? null : horarioDoCartao.slice(11, 16));
    if (alvo.hora && horaReferencia && alvo.hora !== horaReferencia) {
      alvo = { tipo: 'incerto', estado: alvo.estado, motivo: `o lembrete diz ${alvo.hora} e a agenda diz ${horaReferencia}` };
      escolhido = null;
    }
  }

  const automacao = alvo.tipo === 'incerto' ? AUTOMACAO_DO_LEMBRETE.consulta : AUTOMACAO_DO_LEMBRETE[alvo.tipo];
  const ref = alvo.tipo === 'incerto' ? prova.mensagemId : (horarioDoCartao as string);
  const chave = chaveDoToque(alvo.tipo, ref, resposta);

  if (alvo.estado === 'seco') {
    const oQue = alvo.tipo === 'sessao' ? 'sessão' : alvo.tipo === 'consulta' ? 'consulta' : 'agendamento';
    deps.simular(unit, automacao, {
      leadId,
      acao: resposta === 'confirmou' && alvo.tipo !== 'incerto' ? 'gravaria' : 'alertaria',
      alvo:
        alvo.tipo === 'incerto'
          ? 'resposta ao paciente + tarefa (não daria para saber qual agendamento)'
          : resposta === 'confirmou'
            ? `${oQue} CONFIRMADA na franquia + resposta ao paciente`
            : `tarefa: pediu para remarcar a ${oQue}`,
      valor: escolhido ? `${escolhido.dayLocal}T${escolhido.timeLocal}` : (horarioDoCartao ?? prova.em.toISOString()),
      motivo:
        alvo.tipo === 'incerto'
          ? alvo.motivo
          : escolhido
            ? `agendamento ${escolhido.idSchedule} (${escolhido.statusName ?? escolhido.idStatus ?? 'status ?'})`
            : schedules === null
              ? 'a franquia não respondeu — responderia e abriria tarefa'
              : 'não achei o agendamento do horário do cartão na franquia — responderia e abriria tarefa',
    });
    logger.info({ ...c.log, tipo: alvo.tipo, idSchedule: escolhido?.idSchedule ?? null }, 'lembrete [seco]: responderia o toque em código (a Sofia segue)');
    return null;
  }

  // Confere e trava no MESMO passo síncrono — com um await no meio, o segundo toque passaria antes da trava.
  const trava = `${unit.id}:${leadId}:${chave}`;
  if (emAndamento.has(trava)) {
    logger.info({ ...c.log, chave }, 'lembrete: toque duplo no mesmo instante — a primeira resposta já está saindo');
    return { resposta: 'repetida', tipo: alvo.tipo, idSchedule: null, franquia: null };
  }
  emAndamento.add(trava);
  try {
    if (await deps.jaTratado(unit.id, leadId, chave)) return await responderRepeticao(c, deps, alvo.tipo, ref);
    if (alvo.tipo === 'incerto') return await responderIncerto(c, deps, alvo.motivo, chave);
    return await responderAoLembrete(c, deps, { tipo: alvo.tipo, horarioDoCartao: horarioDoCartao as string, escolhido, schedules, chave });
  } finally {
    emAndamento.delete(trava);
  }
}

/** É resposta a lembrete, mas não dá para dizer de qual agendamento: responde e abre tarefa; nada na franquia. */
async function responderIncerto(c: Contexto, deps: DepsLembrete, motivo: string, chave: string): Promise<ResultadoDoLembrete> {
  const { unit, leadId, texto, conv, kommo, resposta } = c;
  await kommo
    .createTask({
      leadId,
      text: textoTarefaIncerta({ slug: unit.slug, nome: conv.contactName, resposta, motivo, texto }),
      completeAt: Math.floor(deps.agora().getTime() / 1000) + 30 * 60,
    })
    .catch((err) => logger.warn({ ...c.log, err: String(err) }, 'lembrete: falha ao abrir a tarefa do toque incerto'));
  const resp =
    resposta === 'confirmou'
      ? textoConfirmacaoIncerta(conv.contactName)
      : textoRespostaAoLembrete({ tipo: 'consulta', resposta, nome: conv.contactName, quando: null });
  await kommo.sendChatReply({ leadId, text: resp, chatId: null, talkId: null, contactId: null });
  await deps.marcarTratado(unit.id, leadId, chave).catch(() => undefined);
  await deps.registrarResposta(conv.id ?? null, resp);
  logger.info({ ...c.log, motivo }, 'lembrete: toque sem agendamento certo — respondido e tarefa aberta, nada na franquia');
  return { resposta, tipo: 'incerto', idSchedule: null, franquia: null, motivo };
}

async function responderAoLembrete(
  c: Contexto,
  deps: DepsLembrete,
  a: { tipo: TipoLembrete; horarioDoCartao: string; escolhido: SpineSchedule | null; schedules: SpineSchedule[] | null; chave: string },
): Promise<ResultadoDoLembrete> {
  const { unit, leadId, texto, conv, kommo, resposta } = c;
  const { tipo, horarioDoCartao, escolhido, chave } = a;
  const oQue: 'consulta' | 'sessão' = tipo === 'sessao' ? 'sessão' : 'consulta';
  const consulta = escolhido ? comoConsultaReconciliada(escolhido) : null;
  // O horário dito ao paciente: o da franquia quando bateu; senão o do cartão (é o que o lembrete mostrou),
  // a não ser que o campo só tenha o dia.
  const quandoDito = consulta?.quando ?? (horarioDoCartao.slice(11, 16) === '00:00' ? null : horarioDoCartao);

  if (resposta === 'remarcar') {
    await kommo
      .createTask({
        leadId,
        text: textoTarefaRemarcar({ slug: unit.slug, tipo, nome: conv.contactName, quando: quandoDito, texto }),
        completeAt: Math.floor(deps.agora().getTime() / 1000) + 30 * 60,
      })
      .catch((err) => logger.warn({ ...c.log, err: String(err) }, 'lembrete: falha ao abrir a tarefa de remarcação'));
  } else if (tipo === 'consulta') {
    await marcarSituacaoConfirmada(kommo, leadId).catch((err) => {
      logger.warn({ ...c.log, err: String(err) }, 'lembrete: não consegui marcar ✓ Situação da consulta = Confirmado');
      return false;
    });
  }

  const resp = textoRespostaAoLembrete({ tipo, resposta, nome: conv.contactName, quando: quandoDito });
  await kommo.sendChatReply({ leadId, text: resp, chatId: null, talkId: null, contactId: null });
  // A resposta já saiu: marca antes de falar com a franquia, que pode demorar ou falhar.
  await deps.marcarTratado(unit.id, leadId, chave).catch(() => undefined);
  await deps.registrarResposta(conv.id ?? null, resp);

  let franquia: ResultadoFranquia | null = null;
  if (resposta === 'confirmou') {
    franquia = await confirmarNaFranquia(
      { unit, leadId, consulta, contactName: conv.contactName, kommo, oQue },
      // A prova de que o lembrete falou DESTE agendamento: a última fala foi o lembrete daquele tipo e o
      // horário do cartão bateu com o da franquia (escolherAgendamento).
      { ...deps.franquia, perguntou: async () => consulta !== null },
    );
  }
  logger.info({ ...c.log, tipo, idSchedule: escolhido?.idSchedule ?? null, franquia }, 'lembrete: toque respondido em código, sem Sofia');
  return { resposta, tipo, idSchedule: escolhido?.idSchedule ?? null, franquia };
}
