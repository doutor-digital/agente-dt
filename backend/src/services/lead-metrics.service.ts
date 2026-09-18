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
import { createKommoClient, type KommoClient, type KommoFieldType } from './kommo.service.js';
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

export type StatusConversa = 'Aguardando lead' | 'Respondendo' | 'Sem resposta' | 'Encerrada';

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
  // A IA acabou de responder: a bola está com o paciente.
  await grava(CAMPOS_DIGITAL.STATUS_CONVERSA, 'select', 'Aguardando lead');

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
    await gravarCampoDigital(unit, kommo, leadId, CAMPOS_DIGITAL.STATUS_CONVERSA, 'select', 'Respondendo');
    if (motivo) await gravarCampoDigital(unit, kommo, leadId, CAMPOS_DIGITAL.MOTIVO_HANDOFF, 'select', motivo);
  } catch (err) {
    logger.warn({ err: String(err), leadId, unit: unit.slug }, 'lead-metrics: falha ao carimbar humano assumiu');
  }
}

/** Escada de follow-up acabou sem o paciente voltar. */
export async function carimbarSemResposta(unit: Unit, leadId: number): Promise<void> {
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) return;
  try {
    const kommo = createKommoClient(unit as KommoUnit);
    await gravarCampoDigital(unit, kommo, leadId, CAMPOS_DIGITAL.STATUS_CONVERSA, 'select', 'Sem resposta');
  } catch (err) {
    logger.warn({ err: String(err), leadId, unit: unit.slug }, 'lead-metrics: falha ao carimbar sem resposta');
  }
}
