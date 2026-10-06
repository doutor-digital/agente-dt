import type { Conversation, Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { normalizarNome } from './kommo-schema.js';
import type { KommoClient } from '../services/kommo.service.js';
import { consultaDoLead, esqueceConsulta, type ConsultaReconciliada } from '../services/agenda-reconcile.service.js';
import { SpineService, SPINE_STATUS } from '../services/spine.service.js';
import { avisoRecente } from './aviso-dedupe.js';

export type RespostaD1 = 'confirmou' | 'remarcar';

export const JANELA_RESPOSTA_D1_MS = 48 * 3600_000;

export function classificarRespostaD1(texto: string): RespostaD1 | null {
  const s = texto.trim().toLowerCase().replace(/[!.…]+$/g, '');
  if (!s) return null;
  const negativo = /\bn[aã]o\b|remarc|reagend|cancel|desmarc|outro (dia|hor[aá]rio)|imprevisto/.test(s);
  if (/^2\b/.test(s) || negativo) return 'remarcar';
  if (/^[✅👍]/u.test(s)) return 'confirmou';
  if (/^(1|ok|okay|sim|confirmo|confirmado|confirmada|confirma|confirmar|estarei|vou sim|pode confirmar|isso)\b/.test(s) || /\bconfirm/.test(s)) {
    return 'confirmou';
  }
  return null;
}

export type Toque = 'd1' | 'd2';

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
  return toque === 'd1' ? 'confirmacao_d1' : 'reforco_d2';
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
  const primeiro = (args.nome ?? '').trim().split(/\s+/)[0];
  const oi = primeiro ? `Oi, ${primeiro}!` : 'Oi!';
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

async function marcarSituacaoConfirmada(kommo: KommoClient, leadId: number): Promise<boolean> {
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

/** Status em que a consulta já terminou — nunca vira "confirmado". */
const STATUS_ENCERRADOS: readonly number[] = [
  SPINE_STATUS.ATENDIDO,
  SPINE_STATUS.DESMARCADO,
  SPINE_STATUS.NAO_COMPARECEU,
  SPINE_STATUS.REMARCADO,
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

/** A pergunta saiu para este horário, na véspera OU no reforço de dois dias? */
async function perguntouSobre(unitId: string, leadId: number, quando: string): Promise<boolean> {
  const marcas = await Promise.all(
    (['d1', 'd2'] as const).map((t) =>
      avisoRecente(unitId, leadId, chaveDaConfirmacao(t, quando), JANELA_RESPOSTA_D1_MS + 48 * 3600_000),
    ),
  );
  return marcas.some(Boolean);
}

const DEPS_PADRAO: DepsConfirmarNaFranquia = {
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
}): string {
  const quando = args.quando ? ` de ${diaCurto(args.quando)} às ${args.quando.slice(11, 16)}` : '';
  const ag = args.idSchedule ? ` (agendamento ${args.idSchedule})` : '';
  return (
    `ALERTA · ${args.slug} · [Contato: ${args.nome ?? 'paciente'}] ⚠️ Paciente CONFIRMOU pelo WhatsApp a consulta${quando}${ag}, ` +
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
  },
  deps: DepsConfirmarNaFranquia = DEPS_PADRAO,
): Promise<ResultadoFranquia> {
  const { unit, leadId, consulta, contactName, kommo } = args;
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
      if (decisao.avisarEquipe) await alertar(decisao.motivo.replace(/_/g, ' '));
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

export async function tratarRespostaD1(args: {
  unit: Unit;
  leadId: number;
  texto: string;
  conv: Conversation;
  kommo: KommoClient;
}): Promise<RespostaD1 | null> {
  const { unit, leadId, texto, conv, kommo } = args;
  if (!conv.confirmacaoD1EnviadaEm || conv.confirmacaoD1Resposta) return null;
  if (Date.now() - conv.confirmacaoD1EnviadaEm.getTime() > JANELA_RESPOSTA_D1_MS) return null;
  const resposta = classificarRespostaD1(texto);
  if (!resposta) return null;

  const consulta = await consultaDoLead(unit, leadId).catch(() => null);
  const hora = consulta?.quando ? consulta.quando.slice(11, 16) : null;
  const quandoCurto = consulta?.quando ? diaCurto(consulta.quando) : null;
  const primeiro = (conv.contactName ?? '').trim().split(/\s+/)[0];
  const nome = primeiro ? `, ${primeiro}` : '';

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
    await kommo
      .createTask({
        leadId,
        text:
          `ALERTA · ${unit.slug} · [Contato: ${conv.contactName ?? 'paciente'}] 🔁 Pediu para remarcar a consulta de amanhã` +
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
