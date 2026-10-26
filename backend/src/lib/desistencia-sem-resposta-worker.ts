/**
 * "Se ele não responder à oferta de novo horário, vira tarefa para a equipe" (decisão do João, 26/10/2026).
 *
 * Antes isto morava no follow-up (régua): só rodava com a régua ligada na unidade, dentro do horário comercial e na janela de
 * 24 h do WhatsApp — e a oferta das 20h30 de uma sexta nunca era olhada. Aqui é um relógio próprio: a Sofia deixa a marca
 * `desistencia_oferta` quando vai oferecer horário (desistencia-acao.ts); a cada 10 min este worker olha as marcas de 2 h a
 * 3 dias atrás e, se o paciente não escreveu NADA depois da marca, abre a tarefa. Independe de regra, de horário e de janela.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import { abrirTarefaDaDesistencia } from './desistencia-da-consulta.js';
import { MARCA_OFERTA } from './desistencia-acao.js';

const SWEEP_MS = 10 * 60_000;
export const ESPERA_DA_OFERTA_MS = 2 * 3600_000;
export const VALIDADE_DA_MARCA_MS = 3 * 24 * 3600_000;

let timer: NodeJS.Timeout | null = null;
let rodando = false;
/** Marcas já olhadas (unidade:lead:hora da marca): uma marca que não vira tarefa (sem consulta) não relê o cartão a cada 10 min. */
const olhadas = new Set<string>();

/** Pura: esta marca já pode virar "não respondeu"? Velha o bastante, nova o bastante, e ele não escreveu depois dela. */
export function marcaVenceuSemResposta(marca: Date, agora: Date, mensagensDoPacienteDepois: number): boolean {
  const idade = agora.getTime() - marca.getTime();
  return idade >= ESPERA_DA_OFERTA_MS && idade <= VALIDADE_DA_MARCA_MS && mensagensDoPacienteDepois === 0;
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const agora = new Date();
    const marcas = await prisma.cardAlert.findMany({
      where: {
        ruleKey: MARCA_OFERTA,
        createdAt: { lte: new Date(agora.getTime() - ESPERA_DA_OFERTA_MS), gte: new Date(agora.getTime() - VALIDADE_DA_MARCA_MS) },
      },
      take: 200,
      orderBy: { createdAt: 'asc' },
    });
    for (const m of marcas) {
      const id = `${m.unitId}:${m.leadId}:${m.createdAt.getTime()}`;
      if (olhadas.has(id)) continue;
      try {
        const conv = await prisma.conversation.findUnique({ where: { unitId_leadId: { unitId: m.unitId, leadId: m.leadId } }, select: { id: true } });
        if (!conv) { olhadas.add(id); continue; }
        const depois = await prisma.message.count({ where: { conversationId: conv.id, role: 'user', createdAt: { gt: m.createdAt } } });
        if (!marcaVenceuSemResposta(m.createdAt, agora, depois)) { if (depois > 0) olhadas.add(id); continue; }
        const unit = await prisma.unit.findUnique({ where: { id: m.unitId } });
        if (!unit) { olhadas.add(id); continue; }
        // o que ele escreveu ANTES da marca (a desistência), para o texto da tarefa e para o detector
        const fala = await prisma.message.findFirst({ where: { conversationId: conv.id, role: 'user', createdAt: { lte: m.createdAt } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
        const r = await abrirTarefaDaDesistencia({
          unit,
          leadId: Number(m.leadId),
          texto: fala?.content ?? '',
          motivo: 'sem_resposta',
          nome: null,
          kommo: () => createKommoClient(unit),
        });
        if (r !== 'falhou') {
          if (olhadas.size > 5000) olhadas.clear();
          olhadas.add(id);
        }
      } catch (err) {
        logger.warn({ err: String(err), unitId: m.unitId, leadId: m.leadId }, 'desistência sem resposta: falha na marca (segue)');
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'desistência sem resposta: varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startDesistenciaSemRespostaWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info('desistência sem resposta: worker iniciado (tarefa se ele não responde à oferta em 2 h)');
}

export function stopDesistenciaSemRespostaWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
