import type { Conversation, Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { normalizarNome } from './kommo-schema.js';
import type { KommoClient } from '../services/kommo.service.js';
import { consultaDoLead, esqueceConsulta, type ConsultaReconciliada } from '../services/agenda-reconcile.service.js';
import { SpineService, SPINE_STATUS } from '../services/spine.service.js';
import { avisoRecente } from './aviso-dedupe.js';
import { nomeApresentavel, saudacao, vocativo } from './nome-apresentavel.js';
import { automacaoLigada } from './automacoes-estado.js';
import { ID_CONFIRMACAO_DIA_UTIL } from './confirmacao-unidade.js';
import { ID_REMARCAR_OFERTA, oferecerNovoHorario, semInteresse, textoTarefaRemarcarComOferta } from './remarcar-oferta.js';
import { faltasLigadas } from './confirmacao-manha.js';
import { registrarSimulacao } from './so-no-papel.js';

export type RespostaD1 = 'confirmou' | 'remarcar';

export const JANELA_RESPOSTA_D1_MS = 48 * 3600_000;

/**
 * Na unidade com a confirmação no DIA ÚTIL ANTERIOR (automação `confirmacao-dia-util`), a pergunta sai até 5 dias antes da
 * consulta (sexta antes do Carnaval → quarta). Com as 48 h da rede, o "confirmado" de segunda à pergunta de quinta ia para a
 * IA sem contexto, e a franquia não recebia o CONFIRMADO (revisão do sênior, PR #394). Só ali a janela vai a 6 dias: na rede,
 * um "sim" solto dias depois da véspera não pode virar confirmação.
 */
export const JANELA_RESPOSTA_DIA_UTIL_MS = 6 * 24 * 3600_000;

/**
 * Com a janela longa (dia útil anterior), só é resposta se a consulta AINDA está de pé e no futuro. O texto de Petrópolis diz
 * "confirme em até 12 horas… caso contrário, ele será liberado": se a equipe liberou o horário (desmarcado → `cancelada`, sem
 * `quando`) e o paciente responde "Confirmado" dias depois, responder "Te esperamos" mandaria a pessoa para um horário que já é de
 * outro (revisão do sênior, PR #394). Sem consulta, franquia fora, desmarcada ou já passada = conversa solta, segue com a Sofia.
 */
export function respostaDentroDaJanelaLonga(
  consulta: Pick<ConsultaReconciliada, 'estado' | 'quando'> | null | undefined,
  agoraLocal: string,
): boolean {
  if (!consulta || consulta.estado !== 'confirmada' || !consulta.quando) return false;
  return consulta.quando.slice(0, 16) > agoraLocal.slice(0, 16);
}
export function janelaDaResposta(slug: string): number {
  return automacaoLigada(slug, ID_CONFIRMACAO_DIA_UTIL, process.env.CONFIRMACAO_DIA_UTIL_SLUGS) ? JANELA_RESPOSTA_DIA_UTIL_MS : JANELA_RESPOSTA_D1_MS;
}

/**
 * `comConsigo`: «consigo (vir) (sim)» conta como confirmação. SÓ com as faltas ligadas na unidade (`faltasLigadas`): na rede sem chave o «consigo»
 * segue indo para a Sofia, como no main — em 30 dias houve 39 «consigo», vários respondendo a um horário NOVO que a Sofia propôs.
 */
export function classificarRespostaD1(texto: string, comConsigo = false): RespostaD1 | null {
  const s = texto.trim().toLowerCase().replace(/[!.…]+$/g, '');
  if (!s) return null;
  const negativo = /\bn[aã]o\b|remarc|reagend|cancel|desmarc|outro (dia|hor[aá]rio)|imprevisto/.test(s);
  if (/^2\b/.test(s) || negativo) return 'remarcar';
  if (/^[✅👍]/u.test(s)) return 'confirmou';
  if (comConsigo && /^consigo( vir)?( sim)?$/.test(s)) return 'confirmou';
  if (/^(1|ok|okay|sim|confirmo|confirmado|confirmada|confirma|confirmar|estarei|vou sim|pode confirmar|isso)\b/.test(s) || /\bconfirm/.test(s)) {
    return 'confirmou';
  }
  return null;
}

/** d0 = a manhã da própria consulta (chave `confirmacao-manha`); d1 = véspera; d2 = reforço de dois dias. */
export type Toque = 'd0' | 'd1' | 'd2';

/**
 * A marca de "já perguntei" carrega a CONSULTA, não só o lead.
 *
 * Antes a chave era só `confirmacao_d1`, e isso errava dos dois lados. Calava demais: consulta
 * remarcada de quinta para sexta caía dentro da janela de 36 h da pergunta antiga, e o paciente
 * do horário novo não recebia confirmação nenhuma. E calava de menos: qualquer varredura que
 * entregasse a mensagem sem conseguir gravar a marca fazia a mesma pergunta sair de novo horas
 * depois. Foi o que a Luciana levou na Serra em 23/09/2026 — respondeu "1" às 14h13, recebeu a
 * mesma pergunta às 18h59, respondeu "1" outra vez, escreveu "Outra vez ?" e encerrou a conversa
 * com "Vou bloquear".
 *
 * Com o horário na chave, perguntar duas vezes pela mesma consulta é impossível, e remarcar gera
 * chave nova — a pergunta volta a sair, que é o certo.
 */
export function prefixoDoToque(toque: Toque): string {
  return toque === 'd0' ? 'confirmacao_d0' : toque === 'd1' ? 'confirmacao_d1' : 'reforco_d2';
}

export function chaveDaConfirmacao(toque: Toque, quando: string): string {
  // `quando` vem sempre como "AAAA-MM-DDTHH:mm" (schema.prisma) — o corte é só defesa contra
  // segundos que a franquia às vezes acrescenta.
  return `${prefixoDoToque(toque)}:${quando.slice(0, 16)}`;
}

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

export function textoConfirmacaoD1(args: {
  nome: string | null | undefined;
  quando: string;
  especialista: string | null | undefined;
  endereco: string | null | undefined;
  /** 'd1' = véspera ("sua consulta de amanhã"); 'd2' = reforço dois dias antes. */
  antecedencia?: 'd1' | 'd2';
}): string {
  const dt = new Date(args.quando.length <= 16 ? `${args.quando}:00` : args.quando);
  const valida = !Number.isNaN(dt.getTime());
  const diaSem = valida ? DIAS[dt.getDay()] : '';
  const dia = valida ? `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}` : args.quando.slice(0, 10);
  const hora = valida ? `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}` : args.quando.slice(11, 16);
  // Nome só se for apresentável ("Oi, tricolor!", "Oi, ,!" não saem) — ver nome-apresentavel.ts.
  const oi = saudacao(args.nome, 'Oi');
  const quem = args.especialista ? ` com ${args.especialista}` : '';
  const onde = args.endereco ? `\n📍 ${args.endereco}` : '';
  const quando = args.antecedencia === 'd2' ? '' : 'de amanhã, ';
  return (
    `${oi} Passando para confirmar sua consulta ${quando}${diaSem ? diaSem + ', ' : ''}${dia} às ${hora}${quem}.${onde}\n\n` +
    'Responda *1* para confirmar ou *2* se precisar remarcar. 😊'
  );
}

/** "quinta, 24/09" — o dia da semana sai da própria data, nunca de cálculo do modelo. */
export function diaCurto(quando: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(quando)) return quando.slice(0, 10);
  const dt = new Date(quando.length <= 16 ? `${quando}:00` : quando);
  if (Number.isNaN(dt.getTime())) return quando.slice(0, 10);
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  return `${DIAS[dt.getDay()]}, ${dd}/${mm}`;
}

/** Rótulos dos botões da véspera — o classificador acima reconhece os dois. */
export const BOTOES_D1 = ['Confirmo', 'Preciso remarcar'];

/** Texto livre só chega no WhatsApp se o paciente escreveu nas últimas 24 h. Folga de 1 h. */
export const JANELA_WHATSAPP_MS = 23 * 3600_000;

export function janelaAberta(msgs: Array<{ direcao: 'entrada' | 'saida'; em: Date }>, agora: Date = new Date()): boolean {
  let ultimaEntrada: Date | null = null;
  for (const m of msgs) if (m.direcao === 'entrada' && (!ultimaEntrada || m.em > ultimaEntrada)) ultimaEntrada = m.em;
  return !!ultimaEntrada && agora.getTime() - ultimaEntrada.getTime() < JANELA_WHATSAPP_MS;
}

export interface ContextoDeChat {
  chatId: string;
  talkId: number | null;
  contactId: number | null;
  authorId: string;
  accountId: number | null;
}

/** Ids do chat (amojo) guardados na última mensagem do paciente — para mandar com botões. */
export async function contextoDeChatDoLead(unitId: string, leadId: number): Promise<ContextoDeChat | null> {
  const conv = await prisma.conversation.findFirst({ where: { unitId, leadId: String(leadId) }, orderBy: { lastMessageAt: 'desc' }, select: { id: true } });
  if (!conv) return null;
  const msgs = await prisma.message.findMany({
    where: { conversationId: conv.id, role: 'user' },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { meta: true },
  });
  for (const m of msgs) {
    const meta = (m.meta ?? {}) as Record<string, unknown>;
    const chatId = typeof meta.chatId === 'string' ? meta.chatId : null;
    const authorId = typeof meta.authorId === 'string' ? meta.authorId : null;
    if (!chatId || !authorId) continue;
    return {
      chatId,
      authorId,
      talkId: meta.talkId != null && Number.isFinite(Number(meta.talkId)) ? Number(meta.talkId) : null,
      contactId: meta.contactId != null && Number.isFinite(Number(meta.contactId)) ? Number(meta.contactId) : null,
      accountId: meta.accountId != null && Number.isFinite(Number(meta.accountId)) ? Number(meta.accountId) : null,
    };
  }
  return null;
}

export function textoAlertaSemJanela(args: { slug: string; nome: string | null | undefined; quando: string }): string {
  const hora = args.quando.slice(11, 16);
  return (
    `ALERTA · ${args.slug} · [Contato: ${args.nome ?? 'paciente'}] 📅 Consulta amanhã às ${hora} SEM confirmação: ` +
    'o paciente está há mais de 24 h sem escrever e o WhatsApp não aceita mensagem livre. Confirmar por telefone ou template.'
  );
}

export async function marcarSituacaoConfirmada(
  kommo: Pick<KommoClient, 'listLeadCustomFieldsTyped' | 'setLeadCustomFieldValue'>,
  leadId: number,
): Promise<boolean> {
  const campos = await kommo.listLeadCustomFieldsTyped();
  const alvo = normalizarNome('✓ Situação da consulta');
  const campo = campos.find((c) => normalizarNome(c.name) === alvo);
  if (!campo) return false;
  const enums = (campo.enums ?? []) as Array<{ id: number; value: string }>;
  const opcao = enums.find((e) => normalizarNome(e.value) === normalizarNome('Confirmado'));
  if (!opcao) return false;
  await kommo.setLeadCustomFieldValue(leadId, campo.id, 'select', opcao.value, enums);
  return true;
}

/**
 * CONFIRMAR NA FRANQUIA, NÃO SÓ NO KOMMO.
 *
 * Até 06/10/2026 o "1" do paciente só carimbava «✓ Situação da consulta» = Confirmado no cartão.
 * Na franquia o agendamento continuava AGENDADO, e o sincronizador (a franquia vence) voltava o
 * campo para "Agendado" na varredura seguinte. Caso visto ao vivo na Açailândia: confirmou às
 * 10:43, o cartão voltou às 10:51 (lead 28088906, agendamento 3738045).
 *
 * Agora a confirmação também vai para a franquia (PATCH /api/schedules/confirm → status 38), que
 * é a mesma chamada da ferramenta `confirmar_presenca` da IA. Com isso o sincronizador lê 38 e
 * escreve "Confirmado" — os dois lados concordam.
 */
export type MotivoSemConfirmarNaFranquia =
  /** Unidade sem franquia ligada (spineEnabled false ou sem token). */
  | 'sem_franquia'
  /** Lead sem consulta vinculada (ou a leitura falhou). */
  | 'sem_consulta'
  /** A franquia não devolveu a consulta agora: não dá para conferir o status. */
  | 'nao_verificada'
  /** Já está CONFIRMADO (38) na franquia — nada a fazer. */
  | 'ja_confirmada'
  /** Atendida, desmarcada, falta ou remarcada: confirmar presença aqui seria escrever mentira. */
  | 'encerrada'
  /** A consulta de agora não é a que foi perguntada (remarcaram entre a pergunta e a resposta). */
  | 'outra_consulta';

export type DecisaoFranquia =
  | { acao: 'confirmar'; idSchedule: number }
  | { acao: 'pular'; motivo: MotivoSemConfirmarNaFranquia; avisarEquipe: boolean };

/**
 * Status em que a consulta já terminou — nunca vira "confirmado".
 *
 * REMARCADO (41) NÃO está aqui: a franquia muda a data no próprio registro e põe 41, e o paciente vem naquela data.
 * Bebedouro, 22/10/2026: 1 REMARCADO em 445 agendamentos dos 30 dias passados (viram ATENDIDO/falta quando a data
 * chega) contra 36 em 329 dos 30 dias seguintes. Contar como encerrada deixava sem confirmar na franquia quem
 * clicou "Confirmar presença" numa consulta remarcada. Remarcar DEPOIS da pergunta continua barrado pela chave
 * por horário (`perguntouEstaConsulta`).
 */
const STATUS_ENCERRADOS: readonly number[] = [
  SPINE_STATUS.ATENDIDO,
  SPINE_STATUS.DESMARCADO,
  SPINE_STATUS.NAO_COMPARECEU,
];

/**
 * Decide, sem efeito colateral, se a confirmação do paciente deve ir para a franquia.
 *
 * `avisarEquipe` = o paciente acha que confirmou, mas a franquia vai ficar sem a confirmação: a
 * equipe precisa confirmar na mão, senão o sincronizador desfaz o "Confirmado" do cartão.
 */
export function decidirConfirmacaoNaFranquia(args: {
  franquiaLigada: boolean;
  consulta: Pick<ConsultaReconciliada, 'idSchedule' | 'estado' | 'quando' | 'idStatus'> | null;
  /** A pergunta (D-1 ou D-2) saiu para ESTE horário? Vem da chave por consulta (v1.139.0). */
  perguntouEstaConsulta: boolean;
}): DecisaoFranquia {
  const { franquiaLigada, consulta, perguntouEstaConsulta } = args;
  if (!franquiaLigada) return { acao: 'pular', motivo: 'sem_franquia', avisarEquipe: false };
  if (!consulta) return { acao: 'pular', motivo: 'sem_consulta', avisarEquipe: true };
  if (consulta.estado === 'cancelada') return { acao: 'pular', motivo: 'encerrada', avisarEquipe: false };
  if (consulta.estado !== 'confirmada' || !consulta.quando) {
    return { acao: 'pular', motivo: 'nao_verificada', avisarEquipe: true };
  }
  const status = consulta.idStatus ?? null;
  if (status === SPINE_STATUS.CONFIRMADO) return { acao: 'pular', motivo: 'ja_confirmada', avisarEquipe: false };
  if (status !== null && STATUS_ENCERRADOS.includes(status)) {
    return { acao: 'pular', motivo: 'encerrada', avisarEquipe: false };
  }
  if (!perguntouEstaConsulta) return { acao: 'pular', motivo: 'outra_consulta', avisarEquipe: true };
  return { acao: 'confirmar', idSchedule: consulta.idSchedule };
}

export type ResultadoFranquia = 'confirmada' | 'falhou' | MotivoSemConfirmarNaFranquia;

/** O que `confirmarNaFranquia` usa de fora — injetável para teste. */
export interface DepsConfirmarNaFranquia {
  confirmSchedule: (unit: Unit, idSchedule: number) => Promise<{ ok: boolean; error?: string }>;
  perguntou: (unitId: string, leadId: number, quando: string) => Promise<boolean>;
  esquecerConsulta: (unitId: string, leadId: number) => void;
}

/** A pergunta saiu para este horário, na manhã da consulta, na véspera OU no reforço de dois dias? */
async function perguntouSobre(unitId: string, leadId: number, quando: string): Promise<boolean> {
  const marcas = await Promise.all(
    (['d0', 'd1', 'd2'] as const).map((t) =>
      // a chave carrega o horário da consulta: janela longa não confunde consultas, e cobre a pergunta do dia útil anterior
      avisoRecente(unitId, leadId, chaveDaConfirmacao(t, quando), JANELA_RESPOSTA_DIA_UTIL_MS + 48 * 3600_000),
    ),
  );
  return marcas.some(Boolean);
}

export const DEPS_CONFIRMAR_PADRAO: DepsConfirmarNaFranquia = {
  confirmSchedule: (unit, idSchedule) => SpineService.confirmSchedule(unit, idSchedule),
  perguntou: perguntouSobre,
  esquecerConsulta: (unitId, leadId) => esqueceConsulta(unitId, leadId),
};

export function textoAlertaConfirmacaoSemFranquia(args: {
  slug: string;
  nome: string | null | undefined;
  quando: string | null | undefined;
  idSchedule: number | null | undefined;
  motivo: string;
  /** O que foi confirmado — a véspera fala de consulta; o lembrete do tratamento, de sessão. */
  oQue?: 'consulta' | 'sessão';
}): string {
  const quando = args.quando ? ` de ${diaCurto(args.quando)} às ${args.quando.slice(11, 16)}` : '';
  const ag = args.idSchedule ? ` (agendamento ${args.idSchedule})` : '';
  return (
    `ALERTA · ${args.slug} · [Contato: ${args.nome ?? 'paciente'}] ⚠️ Paciente CONFIRMOU pelo WhatsApp a ${args.oQue ?? 'consulta'}${quando}${ag}, ` +
    `mas não consegui confirmar na franquia (${args.motivo}). Confirme na agenda da franquia — senão o sincronizador volta a Situação para "Agendado".`
  );
}

/**
 * Confirma na franquia a consulta que o paciente acabou de confirmar no WhatsApp.
 *
 * Nunca lança: falha aqui não pode derrubar a resposta ao paciente nem o carimbo no Kommo. Quando
 * a franquia fica sem a confirmação e alguém precisa agir, abre a tarefa de ALERTA no cartão.
 */
export async function confirmarNaFranquia(
  args: {
    unit: Unit;
    leadId: number;
    consulta: ConsultaReconciliada | null;
    contactName: string | null | undefined;
    kommo: Pick<KommoClient, 'createTask'>;
    /** Padrão 'consulta'. Só muda o texto da tarefa de alerta. */
    oQue?: 'consulta' | 'sessão';
  },
  deps: DepsConfirmarNaFranquia = DEPS_CONFIRMAR_PADRAO,
): Promise<ResultadoFranquia> {
  const { unit, leadId, consulta, contactName, kommo, oQue } = args;
  const log = { unit: unit.slug, leadId, idSchedule: consulta?.idSchedule ?? null, quando: consulta?.quando ?? null };

  const alertar = async (motivo: string) => {
    await kommo
      .createTask({
        leadId,
        text: textoAlertaConfirmacaoSemFranquia({
          slug: unit.slug,
          nome: contactName,
          quando: consulta?.quando,
          idSchedule: consulta?.idSchedule,
          motivo,
          oQue,
        }),
        completeAt: Math.floor(Date.now() / 1000) + 30 * 60,
      })
      .catch((err) => logger.warn({ ...log, err: String(err) }, 'confirmação D-1: falha ao abrir tarefa de alerta da franquia'));
  };

  try {
    const franquiaLigada = !!unit.spineEnabled && !!unit.spineToken;
    const perguntouEstaConsulta =
      franquiaLigada && consulta?.quando ? await deps.perguntou(unit.id, leadId, consulta.quando) : false;
    const decisao = decidirConfirmacaoNaFranquia({ franquiaLigada, consulta, perguntouEstaConsulta });

    if (decisao.acao === 'pular') {
      logger.info({ ...log, motivo: decisao.motivo, idStatus: consulta?.idStatus ?? null }, 'confirmação D-1: não confirmei na franquia');
      if (decisao.avisarEquipe) {
        const motivo = decisao.motivo.replace(/_/g, ' ');
        await alertar(oQue === 'sessão' ? motivo.replace('consulta', 'sessão') : motivo);
      }
      return decisao.motivo;
    }

    const r = await deps.confirmSchedule(unit, decisao.idSchedule);
    if (!r.ok) {
      logger.warn({ ...log, erro: r.error }, 'confirmação D-1: a franquia recusou a confirmação');
      await alertar(r.error ? `erro da franquia: ${String(r.error).slice(0, 120)}` : 'erro da franquia');
      return 'falhou';
    }
    deps.esquecerConsulta(unit.id, leadId);
    logger.info(log, 'confirmação D-1: consulta confirmada na franquia');
    return 'confirmada';
  } catch (err) {
    logger.warn({ ...log, err: String(err) }, 'confirmação D-1: erro ao confirmar na franquia');
    await alertar('erro inesperado');
    return 'falhou';
  }
}

/**
 * REENTREGA DO KOMMO: o mesmo "1" chegando de novo, minutos depois.
 *
 * Caso de 06/10/2026 (Açailândia, lead 28088906): o paciente respondeu "1" às 10:43, a confirmação
 * foi tratada em código, e às 11:06 a Sofia mandou "Não entendi muito bem — você quis dizer alguma
 * coisa sobre a consulta…?" sem nenhuma mensagem nova no chat. O contador de mensagens provou que
 * entrou mais uma mensagem do paciente às ~11:05. Como `confirmacaoD1Resposta` já estava
 * preenchido, a repetição não era mais "resposta à véspera" e caía na IA, que não tinha contexto.
 *
 * O Kommo reenvia o webhook que não respondeu em 2 s (5 min, +15, +15, +1 h). Além de responder
 * cedo e de segurar o id da mensagem por mais tempo (dedup-cache), aqui fica a última defesa: a
 * MESMA resposta, idêntica, repetida pouco depois de já ter sido tratada, não vai para a IA.
 */
export const JANELA_REPETICAO_D1_MS = 2 * 3600_000;

function normalizarResposta(texto: string): string {
  return texto.trim().toLowerCase().replace(/[!.…\s]+$/g, '').replace(/\s+/g, ' ');
}

/**
 * A mensagem é a repetição exata de uma resposta à véspera que já foi tratada?
 *
 * Exige as três coisas: a véspera já foi respondida (confirmou/remarcar), o texto novo tem o mesmo
 * sentido dessa resposta, e existe mensagem ANTERIOR do paciente com o mesmo texto, depois da
 * pergunta e há menos de `JANELA_REPETICAO_D1_MS`. Qualquer texto diferente ("qual o endereço?",
 * "1, mas posso chegar 13h30?") segue para a IA normalmente.
 */
export function ehRepeticaoDaRespostaD1(args: {
  conv: Pick<Conversation, 'confirmacaoD1EnviadaEm' | 'confirmacaoD1Resposta'>;
  texto: string;
  /** Mensagens do PACIENTE anteriores a esta (sem a atual). */
  anteriores: Array<{ content: string; createdAt: Date }>;
  agora?: Date;
  comConsigo?: boolean;
  /**
   * Quando falamos (Sofia, recepção) pela última vez, SEM contar a frase de espera. `null` = nunca; `undefined` = não sei. Com a conversa em
   * `oferta_sofia`, só é repetição o que chega SEM fala nossa depois da mensagem anterior do paciente: pedido → oferta → o mesmo texto é a
   * resposta dele à Sofia e vai para ela.
   */
  ultimaFalaNossaEm?: Date | null;
}): boolean {
  const { conv, texto, anteriores } = args;
  const agora = args.agora ?? new Date();
  const ja = conv.confirmacaoD1Resposta;
  const ofertaFeita = ja === RESPOSTA_OFERTA_SOFIA;
  if (!conv.confirmacaoD1EnviadaEm || (ja !== 'confirmou' && ja !== 'remarcar' && !ofertaFeita)) return false;
  const cls = classificarRespostaD1(texto, args.comConsigo);
  if (ofertaFeita) {
    // Reentrega do Kommo do MESMO pedido que gerou a oferta não gera 2ª oferta. Só isso: no meio da negociação, o paciente que escreve «não»,
    // «não dá», «não posso» (ou de novo o mesmo texto) está RESPONDENDO à Sofia e precisa de resposta. Conta como repetição quando o texto é
    // igual ao pedido que gerou a oferta (o 1º «remarcar» depois da pergunta) E igual à mensagem imediatamente anterior do paciente.
    // «1»/«2» soltos são a ESCOLHA do horário, nunca repetição.
    const alvoOferta = normalizarResposta(texto);
    if (cls !== 'remarcar' || !alvoOferta || /^\d$/.test(alvoOferta)) return false;
    const desdeOferta = conv.confirmacaoD1EnviadaEm.getTime();
    const doPeriodo = args.anteriores
      .filter((m) => m.createdAt.getTime() >= desdeOferta)
      .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
    const ultima = doPeriodo[0];
    if (args.ultimaFalaNossaEm === undefined) return false;
    if (args.ultimaFalaNossaEm && ultima && args.ultimaFalaNossaEm.getTime() > ultima.createdAt.getTime()) return false;
    const pedido = [...doPeriodo].reverse().find((m) => classificarRespostaD1(m.content, args.comConsigo) === 'remarcar');
    return (
      !!ultima &&
      !!pedido &&
      agora.getTime() - ultima.createdAt.getTime() <= JANELA_REPETICAO_D1_MS &&
      normalizarResposta(ultima.content) === alvoOferta &&
      normalizarResposta(pedido.content) === alvoOferta
    );
  }
  if (cls !== ja) return false;
  const alvo = normalizarResposta(texto);
  if (!alvo) return false;
  const desde = conv.confirmacaoD1EnviadaEm.getTime();
  return anteriores.some(
    (m) =>
      m.createdAt.getTime() >= desde &&
      agora.getTime() - m.createdAt.getTime() <= JANELA_REPETICAO_D1_MS &&
      normalizarResposta(m.content) === alvo,
  );
}

/**
 * Teste barato e SÍNCRONO: esta mensagem pode ser tratada pela confirmação de véspera (resposta
 * nova ou repetição)? Serve para o webhook responder 200 ao Kommo ANTES do trabalho pesado — o
 * Kommo dá 2 s e reenvia quem passa disso.
 */
export function podeSerRespostaD1(
  conv: Pick<Conversation, 'confirmacaoD1EnviadaEm' | 'confirmacaoD1Resposta'>,
  texto: string,
  agora: Date = new Date(),
  janelaMs: number = JANELA_RESPOSTA_D1_MS,
  comConsigo = false,
): boolean {
  if (!conv.confirmacaoD1EnviadaEm) return false;
  const idade = agora.getTime() - conv.confirmacaoD1EnviadaEm.getTime();
  if (idade > janelaMs + JANELA_REPETICAO_D1_MS) return false;
  const resposta = classificarRespostaD1(texto, comConsigo);
  if (!resposta) return false;
  if (!conv.confirmacaoD1Resposta) return idade <= janelaMs;
  return conv.confirmacaoD1Resposta === resposta;
}

/**
 * `remarcar_sofia`: o paciente pediu para remarcar e a chave `remarcar-oferta` está LIGADA — a conversa segue com a Sofia, que oferece 2
 * horários reais (o webhook NÃO pula a IA). Fica gravado `oferta_sofia` na conversa, e não `remarcar`: "2" ou "1" digitado depois é a
 * ESCOLHA de um horário, não uma nova resposta à véspera (com `remarcar` o "2" viraria "repetição" e a Sofia nunca o leria).
 */
export type ResultadoRespostaD1 = RespostaD1 | 'repetida' | 'remarcar_sofia';
export const RESPOSTA_OFERTA_SOFIA = 'oferta_sofia';

/**
 * A última fala NOSSA na conversa é a pergunta de confirmação (a que gravou `confirmacaoD1EnviadaEm`)? Sem fala depois dela, ou com a fala marcada
 * `confirmacao_*`, sim. Qualquer outra fala depois (a Sofia oferecendo horários, a recepção) = o paciente está respondendo a ELA.
 */
export function ultimaFalaFoiAPergunta(ultima: { createdAt: Date; meta: unknown } | null, enviadaEm: Date): boolean {
  if (!ultima || ultima.createdAt.getTime() < enviadaEm.getTime()) return true;
  const origem = (ultima.meta as { origem?: unknown } | null)?.origem;
  return typeof origem === 'string' && origem.startsWith('confirmacao_');
}

export async function tratarRespostaD1(args: {
  unit: Unit;
  leadId: number;
  texto: string;
  conv: Conversation;
  kommo: KommoClient;
  /** Trace desta mensagem: a mensagem atual já foi gravada com ele e não conta como "anterior". */
  traceId?: string;
  /** Só para teste: a consulta que a franquia devolve (o padrão é `consultaDoLead`). */
  consultaDoLead?: typeof consultaDoLead;
}): Promise<ResultadoRespostaD1 | null> {
  const { unit, leadId, texto, conv, kommo, traceId } = args;
  const lerConsulta = args.consultaDoLead ?? consultaDoLead;
  if (conv.confirmacaoD1Resposta && traceId && conv.confirmacaoD1EnviadaEm) {
    const anteriores = await prisma.message.findMany({
      where: {
        conversationId: conv.id,
        role: 'user',
        OR: [{ traceId: null }, { traceId: { not: traceId } }],
        createdAt: { gte: conv.confirmacaoD1EnviadaEm },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { content: true, createdAt: true },
    });
    // a última fala NOSSA que não seja a frase de espera (que sai junto do pedido e não conta como resposta da Sofia); erro de leitura = «falamos»
    let ultimaFalaNossaEm: Date | null | undefined = undefined;
    if (conv.confirmacaoD1Resposta === RESPOSTA_OFERTA_SOFIA) {
      ultimaFalaNossaEm = await prisma.message
        .findMany({ where: { conversationId: conv.id, role: 'assistant' }, orderBy: { createdAt: 'desc' }, take: 5, select: { createdAt: true, meta: true } })
        .then((ms) => ms.find((m) => (m.meta as { origem?: unknown } | null)?.origem !== 'remarcar_oferta_espera')?.createdAt ?? null)
        .catch(() => new Date());
    }
    if (ehRepeticaoDaRespostaD1({ conv, texto, anteriores, comConsigo: faltasLigadas(unit.slug), ultimaFalaNossaEm })) {
      logger.info({ unit: unit.slug, leadId, resposta: conv.confirmacaoD1Resposta }, 'confirmação D-1: repetição da resposta já tratada — sem IA');
      return 'repetida';
    }
    return null;
  }
  if (!conv.confirmacaoD1EnviadaEm || conv.confirmacaoD1Resposta) return null;
  if (Date.now() - conv.confirmacaoD1EnviadaEm.getTime() > janelaDaResposta(unit.slug)) return null;
  // «consigo» só confirma com as faltas ligadas (na rede sem chave segue indo para a Sofia, como antes)
  const faltas = faltasLigadas(unit.slug);
  const resposta = classificarRespostaD1(texto, faltas);
  if (!resposta) return null;

  const consulta = await lerConsulta(unit, leadId).catch(() => null);
  const agoraLocal = SpineService.instanteNoFuso(new Date(), unit.spineTimezone || 'America/Sao_Paulo').slice(0, 16);
  // A consulta está de pé e no futuro? Janela longa do dia útil anterior (6 dias) FECHA no horário da consulta: depois dela, "ok" ou "não,
  // obrigada" é conversa solta, não resposta à pergunta (revisão do sênior, PR #394). Na rede (48 h) nada muda.
  const consultaDePe = respostaDentroDaJanelaLonga(consulta, agoraLocal);
  if (janelaDaResposta(unit.slug) > JANELA_RESPOSTA_D1_MS && !consultaDePe) return null;

  // FALTAS LIGADAS (manhã OU oferta de horários): a Sofia fala em opções ("1) quinta  2) sexta") e a pergunta da manhã é rearmada para quem está
  // conversando. Duas travas, SÓ sobre o que poderia CONFIRMAR presença que o paciente não deu:
  //  - «confirmou» com a consulta que não está de pé e no futuro (já passou, franquia sem resposta): um "ok" às 18h não vira CONFIRMADO numa falta;
  //  - «confirmou» — e também o «1»/«2» solto, que pode ser a escolha de um horário — depois de uma fala nossa que NÃO foi a pergunta: é conversa
  //    com a Sofia. Texto digitado passa pela trava, inclusive «Confirmo»: o webhook não distingue o toque no botão de quem digita.
  // Se não der para ler a conversa, FALHA FECHADO: não confirma, a mensagem segue com a Sofia.
  // «Preciso remarcar» (palavras) NUNCA é bloqueado: sem consulta ou sem franquia o main abria tarefa e respondia, e continua assim.
  if (faltas && (resposta === 'confirmou' || /^\d$/.test(texto.trim()))) {
    if (resposta === 'confirmou' && !consultaDePe) return null;
    try {
      const ultima = await prisma.message.findFirst({
        where: { conversationId: conv.id, role: 'assistant' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, meta: true },
      });
      if (!ultimaFalaFoiAPergunta(ultima, conv.confirmacaoD1EnviadaEm)) return null;
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'confirmação D-1: não consegui ler a última fala — não confirmo, segue com a Sofia');
      return null;
    }
  }
  const hora = consulta?.quando ? consulta.quando.slice(11, 16) : null;
  const quandoCurto = consulta?.quando ? diaCurto(consulta.quando) : null;
  // O nome sai do título do cartão (o que a Sofia gravou); sem ele, do perfil do WhatsApp só se parecer nome
  // próprio. A conversa guarda só o perfil ("Meu Único Amigo É Deus", "tricolor") — ver nome-apresentavel.ts.
  const titulo = await kommo
    .getLead(leadId)
    .then((l) => l?.name ?? null)
    .catch(() => null);
  const nome = vocativo(nomeApresentavel(titulo, conv.contactName));

  if (resposta === 'confirmou') {
    const marcou = await marcarSituacaoConfirmada(kommo, leadId).catch((err) => {
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'confirmação D-1: não consegui marcar Situação = Confirmado');
      return false;
    });
    await kommo.sendChatReply({
      leadId,
      // Sem "amanhã": a mesma pergunta sai também dois dias antes (reforço D-2).
      text: `Confirmado${nome}! 💙 Te esperamos${quandoCurto ? ` ${quandoCurto}` : ''}${hora ? ` às ${hora}` : ''}. Chegue uns 15 minutos antes, tá? Qualquer coisa é só me chamar por aqui.`,
      chatId: null,
      talkId: null,
      contactId: null,
    });
    logger.info({ unit: unit.slug, leadId, situacaoMarcada: marcou }, 'confirmação D-1: paciente confirmou');
    // Em segundo plano: a resposta ao Kommo (webhook) tem prazo de 2 s, e a chamada à franquia não
    // pode atrasá-la. confirmarNaFranquia nunca lança e avisa a equipe quando não conseguir.
    void confirmarNaFranquia({ unit, leadId, consulta, contactName: conv.contactName, kommo });
  } else {
    const oferta = oferecerNovoHorario(unit.slug);
    // Sem consulta de pé (já passou, franquia sem resposta) não há o que remarcar: segue o caminho do main (resposta pronta + tarefa)
    // «Não quero mais, pode cancelar» NÃO é pedido de remarcar: sem oferta e sem frase de espera, segue o caminho do main
    const querOferta = consultaDePe && !semInteresse(texto);
    if (oferta === 'ligado' && querOferta) {
      // Grava o estado ANTES de tudo: o Kommo reentrega o webhook e o paciente toca de novo, e sem a marca cada toque abriria outra tarefa.
      await prisma.conversation
        .update({ where: { id: conv.id }, data: { confirmacaoD1Resposta: RESPOSTA_OFERTA_SOFIA } })
        .catch((err) => logger.warn({ err: String(err), unit: unit.slug, leadId }, 'confirmação D-1: não gravei oferta_sofia'));
      // A Sofia responde esta mesma mensagem com 2 horários de `consultar_horarios`; a consulta atual SEGUE de pé até ele escolher.
      // A frase curta abaixo sai SEMPRE, na frente: se a Sofia estiver calada nesta etapa, em pausa ou fora do horário, o paciente não fica no vazio
      // (antes ele recebia a resposta pronta). A tarefa (prazo de 1 h) é a rede de segurança da equipe.
      const espera = `Sem problema${nome}! 🙏 Já vou ver os horários mais próximos para você. Se preferir, me diga qual dia e período ficam melhores.`;
      // a frase pode falhar (Kommo fora): a tarefa abaixo abre DE QUALQUER JEITO — é a única rede de segurança
      const falou = await kommo
        .sendChatReply({ leadId, text: espera, chatId: null, talkId: null, contactId: null })
        // `lead_note` = o Kommo recusou o chat e a frase virou NOTA interna: o paciente NÃO a recebeu, então não a guardo como dita
        .then((r) => (r as { via?: string } | undefined)?.via !== 'lead_note')
        .catch((err) => {
          logger.warn({ err: String(err), unit: unit.slug, leadId }, 'confirmação D-1: a frase de espera falhou — a tarefa abre mesmo assim');
          return false;
        });
      if (falou) await prisma.message
        .create({ data: { conversationId: conv.id, role: 'assistant', content: espera, meta: { origem: 'remarcar_oferta_espera' } } })
        .catch(() => undefined);
      await kommo
        .createTask({
          leadId,
          text: textoTarefaRemarcarComOferta({ slug: unit.slug, nome: conv.contactName, quando: consulta?.quando ?? null, texto }),
          completeAt: Math.floor(Date.now() / 1000) + 3600,
        })
        .catch((err) => logger.warn({ err: String(err), unit: unit.slug, leadId }, 'confirmação D-1: falha ao abrir tarefa de remarcação'));
      logger.info({ unit: unit.slug, leadId }, 'confirmação D-1: paciente pediu para remarcar — a Sofia oferece 2 horários');
      return 'remarcar_sofia';
    }
    if (oferta === 'seco' && querOferta) {
      registrarSimulacao(unit, ID_REMARCAR_OFERTA, {
        leadId,
        acao: 'mandaria',
        alvo: 'oferta de 2 horários',
        valor: `A Sofia responderia com 2 horários reais em vez de «vou pedir para a equipe» (paciente: "${texto.slice(0, 80)}")`,
        deEtapa: null,
      });
    }
    await kommo
      .createTask({
        leadId,
        text:
          `ALERTA · ${unit.slug} · [Contato: ${conv.contactName ?? 'paciente'}] 🔁 Pediu para remarcar a consulta de ${quandoCurto ?? 'amanhã'}` +
          `${hora ? ` (${hora})` : ''}: "${texto.slice(0, 120)}". Combinar novo horário com o paciente.`,
        completeAt: Math.floor(Date.now() / 1000) + 30 * 60,
      })
      .catch((err) => logger.warn({ err: String(err), unit: unit.slug, leadId }, 'confirmação D-1: falha ao abrir tarefa de remarcação'));
    await kommo.sendChatReply({
      leadId,
      text: `Sem problema${nome}! 🙏 Vou pedir para a equipe combinar um novo horário com você por aqui. Se preferir, me diga qual dia e período ficam melhores.`,
      chatId: null,
      talkId: null,
      contactId: null,
    });
    logger.info({ unit: unit.slug, leadId }, 'confirmação D-1: paciente pediu para remarcar');
  }

  await prisma.conversation
    .update({ where: { id: conv.id }, data: { confirmacaoD1Resposta: resposta } })
    .catch(() => undefined);
  return resposta;
}
