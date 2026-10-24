/**
 * Bloco DIGITAL do cartão — métricas que a IA preenche sozinha, por API.
 *
 * Até 18/09/2026 os campos eram achados por ID chumbado da Imperatriz (2443015…),
 * então em toda outra unidade o PATCH batia num campo inexistente e era engolido:
 * só a Imperatriz tinha métrica. Agora o campo é achado pelo NOME na conta da
 * unidade (esquema em cache 30 min); se a conta não tem o campo, pula em silêncio.
 * Nome igual em todas as contas Doutor Hérnia (cartão replicado da Imperatriz) e
 * no laboratório do cartão enxuto.
 */
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { esquemaDaUnidade } from '../lib/kommo-schema.js';
import { carimboEtapaLiberado } from '../lib/carimbo-etapa.js';
import { createKommoClient, type KommoClient, type KommoFieldType } from './kommo.service.js';
import { cartaoEncerrado, decidirStatusConversa, type OrigemDoStatus, type StatusAutomatico, type StatusConversa } from '../lib/status-conversa.js';
import type { Unit } from '@prisma/client';

export const CAMPOS_DIGITAL = {
  PRIMEIRO_CONTATO: '◷ Data do primeiro contato',
  DATA_1A_RESPOSTA: '◷ Data/hora da 1ª resposta',
  TEMPO_1A_RESPOSTA: '# Tempo até 1ª resposta (min)',
  NUM_MENSAGENS: '# Nº de mensagens trocadas',
  TEMPO_AGENDAMENTO: '# Tempo até agendamento (h)',
  FEITO_POR: '⬢ Agendamento feito por',
  ASSUMIDO_HUMANO: '✓ Atendimento assumido por humano',
  MOTIVO_HANDOFF: '⬢ Motivo do handoff',
  STATUS_CONVERSA: '⬢ Status da conversa',
  DATA_QUALIFICACAO: '◷ Data da qualificação',
} as const;

export type { StatusConversa };

type KommoUnit = Parameters<typeof createKommoClient>[0];

/**
 * Grava um campo do DIGITAL pelo nome. Devolve false quando a conta não tem o campo
 * (não é erro: contas fora do padrão simplesmente não têm o bloco).
 */
export async function gravarCampoDigital(
  unit: Unit,
  kommo: KommoClient,
  leadId: number,
  nome: string,
  tipo: KommoFieldType,
  valor: string | number,
): Promise<boolean> {
  const esquema = await esquemaDaUnidade(unit, kommo);
  const id = esquema.campoPorNome(nome);
  if (id === null) return false;
  await kommo.setLeadCustomFieldValue(leadId, id, tipo, valor);
  return true;
}

/**
 * O ÚNICO caminho de escrita de "⬢ Status da conversa" para quem não é o carimbo de etapa (IA, handoff, follow-up).
 * Lê o cartão e, se ele está numa etapa que encerra a conversa (GANHO / PERDIDO), NÃO grava: o "Encerrada" do carimbo
 * de etapa vale (ver lib/status-conversa.ts). Devolve true só quando gravou.
 *
 * SÓ ONDE O CARIMBO DE ETAPA É O DONO: em unidade com `carimbo-etapa` desligada ninguém grava "Encerrada", e recusar
 * a escrita deixaria o cartão fechado com um valor velho. Ali handoff e follow-up gravam como sempre gravaram, sem
 * leitura extra; só o turno da IA mantém a guarda de 142/143 que já tinha.
 *
 * Cartão que não deu para ler: grava, como sempre gravou (e avisa no log). O campo é informativo, mas "Sem resposta"
 * é o sinal que o parados-worker lê para mandar o lead a PERDIDO — perdê-lo por um 429 deixaria o lead parado para
 * sempre, e um "Encerrada" sobrescrito é só cosmético.
 *
 * NÃO cobre a corrida em que a equipe move o cartão para PERDIDO entre a leitura e a gravação.
 */
export async function gravarStatusConversa(
  unit: Unit,
  kommo: KommoClient,
  leadId: number,
  novo: StatusAutomatico,
  origem: OrigemDoStatus,
): Promise<boolean> {
  const carimboEDono = carimboEtapaLiberado(unit.slug);
  if (carimboEDono || origem === 'turno-da-ia') {
    let leituraFalhou: unknown = null;
    const cartao = await kommo.getLead(leadId).catch((err: unknown) => {
      leituraFalhou = err;
      return null;
    });
    if (!cartao) {
      logger.warn(
        { unit: unit.slug, leadId, tentou: novo, origem, err: String(leituraFalhou) },
        'status-conversa: não consegui ler o cartão — gravei sem conferir a etapa',
      );
    } else {
      const esquema = await esquemaDaUnidade(unit, kommo);
      const nomeDaEtapa = esquema.nomeDoStatus(cartao.pipeline_id, cartao.status_id)?.status ?? null;
      // Sem o carimbo como dono, vale só a guarda antiga por id (142/143 em qualquer funil), que é o que o turno da IA já tinha.
      const decisao = decidirStatusConversa(novo, cartaoEncerrado(cartao, carimboEDono ? nomeDaEtapa : null));
      if (!decisao.gravar) {
        logger.info(
          { unit: unit.slug, leadId, tentou: novo, origem, etapa: nomeDaEtapa ?? cartao.status_id },
          `status-conversa: não gravei — ${decisao.motivo}`,
        );
        return false;
      }
    }
  }
  return gravarCampoDigital(unit, kommo, leadId, CAMPOS_DIGITAL.STATUS_CONVERSA, 'select', novo);
}

/** Esvazia um campo do bloco DIGITAL pelo nome (false se a conta não tem o campo). */
export async function limparCampoDigital(
  unit: Unit,
  kommo: KommoClient,
  leadId: number,
  nome: string,
): Promise<boolean> {
  const esquema = await esquemaDaUnidade(unit, kommo);
  const id = esquema.campoPorNome(nome);
  if (id === null) return false;
  await kommo.clearLeadCustomField(leadId, id);
  return true;
}

export function scheduleLeadMetrics(unit: Unit, leadId: number): void {
  void atualizarMetricasDeTurno(unit, leadId).catch((err) => {
    logger.warn({ err: String(err), leadId, unit: unit.slug }, 'lead-metrics: falha ao atualizar (ignorada)');
  });
}

async function atualizarMetricasDeTurno(unit: Unit, leadId: number): Promise<void> {
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) return;
  const conv = await prisma.conversation.findUnique({
    where: { unitId_leadId: { unitId: unit.id, leadId: String(leadId) } },
    select: { id: true },
  });
  if (!conv) return;

  const msgs = await prisma.message.findMany({
    where: { conversationId: conv.id },
    orderBy: { createdAt: 'asc' },
    select: { role: true, createdAt: true },
  });
  if (msgs.length === 0) return;

  const kommo = createKommoClient(unit as KommoUnit);
  const grava = (nome: string, tipo: KommoFieldType, valor: string | number) =>
    gravarCampoDigital(unit, kommo, leadId, nome, tipo, valor);

  await grava(CAMPOS_DIGITAL.NUM_MENSAGENS, 'numeric', msgs.length);
  // A IA acabou de responder: a bola está com o paciente — a não ser que o cartão tenha sido
  // fechado neste mesmo turno (fechar_lead → GANHO/PERDIDO), aí o "Encerrada" do carimbo de
  // etapa vale e não pode ser sobrescrito (gravarStatusConversa decide).
  await gravarStatusConversa(unit, kommo, leadId, 'Aguardando lead', 'turno-da-ia');

  const assistants = msgs.filter((m) => m.role === 'assistant');
  if (assistants.length === 1) {
    const primeiraResposta = assistants[0].createdAt;
    const primeiroContato = msgs.find((m) => m.role === 'user')?.createdAt ?? msgs[0].createdAt;
    await grava(CAMPOS_DIGITAL.PRIMEIRO_CONTATO, 'date', primeiroContato.toISOString());
    await grava(CAMPOS_DIGITAL.DATA_1A_RESPOSTA, 'date', primeiraResposta.toISOString());
    const min = Math.max(0, Math.round((primeiraResposta.getTime() - primeiroContato.getTime()) / 60_000));
    await grava(CAMPOS_DIGITAL.TEMPO_1A_RESPOSTA, 'numeric', min);
  }
}

export async function registrarTempoAteAgendamento(
  unit: Unit,
  kommo: ReturnType<typeof createKommoClient>,
  leadId: number,
): Promise<void> {
  try {
    const conv = await prisma.conversation.findUnique({
      where: { unitId_leadId: { unitId: unit.id, leadId: String(leadId) } },
      select: { id: true },
    });
    if (!conv) return;
    const primeiro = await prisma.message.findFirst({
      where: { conversationId: conv.id, role: 'user' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    if (!primeiro) return;
    const horas = Math.max(0, Math.round((Date.now() - primeiro.createdAt.getTime()) / 3_600_000));
    await gravarCampoDigital(unit, kommo, leadId, CAMPOS_DIGITAL.TEMPO_AGENDAMENTO, 'numeric', horas);
  } catch (err) {
    logger.warn({ err: String(err), leadId }, 'lead-metrics: falha no tempo até agendamento');
  }
}

/**
 * Um humano assumiu a conversa (a IA pausou pelo `pausar_ia` ou a SDR respondeu
 * pelo Kommo e a IA se auto-pausou). Marca quem está com a bola e, quando a IA
 * soube dizer, o motivo. Nunca derruba quem chamou.
 */
export async function carimbarHumanoAssumiu(
  unit: Unit,
  kommo: KommoClient,
  leadId: number,
  motivo: string | null = null,
): Promise<void> {
  try {
    await gravarCampoDigital(unit, kommo, leadId, CAMPOS_DIGITAL.ASSUMIDO_HUMANO, 'select', 'Sim');
    await gravarStatusConversa(unit, kommo, leadId, 'Respondendo', 'humano-assumiu');
    if (motivo) await gravarCampoDigital(unit, kommo, leadId, CAMPOS_DIGITAL.MOTIVO_HANDOFF, 'select', motivo);
  } catch (err) {
    logger.warn({ err: String(err), leadId, unit: unit.slug }, 'lead-metrics: falha ao carimbar humano assumiu');
  }
}

/** Escada de follow-up acabou sem o paciente voltar. */
export async function carimbarSemResposta(unit: Unit, leadId: number, cliente?: KommoClient): Promise<void> {
  if (!cliente && (!unit.kommoSubdomain || !unit.kommoAccessToken)) return;
  try {
    const kommo = cliente ?? createKommoClient(unit as KommoUnit);
    await gravarStatusConversa(unit, kommo, leadId, 'Sem resposta', 'follow-up-sem-resposta');
  } catch (err) {
    logger.warn({ err: String(err), leadId, unit: unit.slug }, 'lead-metrics: falha ao carimbar sem resposta');
  }
}
