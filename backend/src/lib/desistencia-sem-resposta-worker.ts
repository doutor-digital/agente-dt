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
import { agirNaDesistencia, estadoDaDesistencia, MARCA_OFERTA, MARCA_RECUSOU } from './desistencia-acao.js';
import { pareceDesistenciaDaConsulta } from './desistencia-frases.js';
import { marcadoEm } from './aviso-dedupe.js';

const SWEEP_MS = 10 * 60_000;
export const ESPERA_DA_OFERTA_MS = 2 * 3600_000;
export const VALIDADE_DA_MARCA_MS = 3 * 24 * 3600_000;

let timer: NodeJS.Timeout | null = null;
let rodando = false;
/** Marcas já olhadas (unidade:lead:hora da marca): uma marca que não vira tarefa (sem consulta) não relê o cartão a cada 10 min. */
const olhadas = new Set<string>();
/** Tentativas que falharam por marca: depois de MAX_TENTATIVAS (Kommo fora, lead apagado) desiste — não relê a marca por 3 dias. */
const tentativas = new Map<string, number>();
export const MAX_TENTATIVAS = 12;
function falhou(id: string): void {
  const n = (tentativas.get(id) ?? 0) + 1;
  tentativas.set(id, n);
  if (n >= MAX_TENTATIVAS) olhadas.add(id);
  if (tentativas.size > 5000) tentativas.clear();
}

/** Pura: esta marca já pode virar "não respondeu"? Velha o bastante, nova o bastante, e ele não escreveu depois dela. */
export function marcaVenceuSemResposta(marca: Date, agora: Date, mensagensDoPacienteDepois: number): boolean {
  const idade = agora.getTime() - marca.getTime();
  return idade >= ESPERA_DA_OFERTA_MS && idade <= VALIDADE_DA_MARCA_MS && mensagensDoPacienteDepois === 0;
}

/** A desistência que causou a marca: a mais recente, até a hora dela, que o detector reconhece (o paciente pode ter escrito mais de uma mensagem). */
async function falaDeDesistencia(conversationId: string, ate: Date): Promise<string> {
  const falas = await prisma.message.findMany({ where: { conversationId, role: 'user', createdAt: { lte: ate } }, orderBy: { createdAt: 'desc' }, take: 6, select: { content: true } });
  return falas.find((f) => pareceDesistenciaDaConsulta(f.content))?.content ?? '';
}

/**
 * A recusa já parou a nossa véspera (marca `recusou_remarcar`), mas a tarefa de cancelar pode ter falhado (Kommo fora) — e a Sofia
 * já disse ao paciente que a equipe cancela. Sem tarefa feita depois da marca, tenta de novo.
 */
async function refazerTarefasQueFalharam(agora: Date): Promise<void> {
  const marcas = await prisma.cardAlert.findMany({
    where: { ruleKey: MARCA_RECUSOU, createdAt: { lte: new Date(agora.getTime() - 10 * 60_000), gte: new Date(agora.getTime() - VALIDADE_DA_MARCA_MS) } },
    take: 200,
    orderBy: { createdAt: 'asc' },
  });
  for (const m of marcas) {
    const id = `recusa:${m.unitId}:${m.leadId}:${m.createdAt.getTime()}`;
    if (olhadas.has(id)) continue;
    try {
      const [c, q] = await Promise.all([
        marcadoEm(m.unitId, m.leadId, 'desistencia_tarefa:cancelar'),
        marcadoEm(m.unitId, m.leadId, 'desistencia_tarefa:conferir'),
      ]);
      if ((c && c >= m.createdAt) || (q && q >= m.createdAt)) { olhadas.add(id); continue; }
      const unitConv = await Promise.all([
        prisma.unit.findUnique({ where: { id: m.unitId } }),
        prisma.conversation.findUnique({ where: { unitId_leadId: { unitId: m.unitId, leadId: m.leadId } }, select: { id: true } }),
      ]);
      const [unit, conv] = unitConv;
      if (!unit || !conv) { olhadas.add(id); continue; }
      if (estadoDaDesistencia(unit.slug) !== 'ligado') continue;
      // ele escreveu depois da recusa (pode ter voltado atrás, "consegui, vou sim"): não abre a tarefa de cancelar com a fala velha
      const depois = await prisma.message.count({ where: { conversationId: conv.id, role: 'user', createdAt: { gt: m.createdAt } } });
      if (depois > 0) { olhadas.add(id); continue; }
      const r = await agirNaDesistencia({ unit, leadId: Number(m.leadId), acao: 'recusou', trecho: await falaDeDesistencia(conv.id, m.createdAt), kommo: () => createKommoClient(unit), refazendo: true });
      if (r !== 'falhou') olhadas.add(id);
      else falhou(id);
    } catch (err) {
      logger.warn({ err: String(err), unitId: m.unitId, leadId: m.leadId }, 'desistência: refazer a tarefa de cancelar falhou (segue)');
    }
  }
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const agora = new Date();
    await refazerTarefasQueFalharam(agora);
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
        // só a automação LIGADA abre tarefa (em seco nem existe marca; se a chave voltou ao papel, espera)
        if (estadoDaDesistencia(unit.slug) !== 'ligado') continue;
        // já fiz a tarefa PARA ESTA oferta (a marca de dedupe é do banco: sobrevive a deploy e a reinício)
        const feita = await marcadoEm(m.unitId, m.leadId, 'desistencia_tarefa:sem_resposta');
        if (feita && feita >= m.createdAt) { olhadas.add(id); continue; }
        const fala = await falaDeDesistencia(conv.id, m.createdAt);
        const r = await abrirTarefaDaDesistencia({
          unit,
          leadId: Number(m.leadId),
          texto: fala,
          motivo: 'sem_resposta',
          nome: null,
          kommo: () => createKommoClient(unit),
        });
        if (r !== 'falhou') {
          if (olhadas.size > 5000) olhadas.clear();
          olhadas.add(id);
        } else falhou(id);
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
