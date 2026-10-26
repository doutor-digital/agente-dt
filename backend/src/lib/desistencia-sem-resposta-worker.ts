/**
 * "Se ele não responder à oferta de novo horário, vira tarefa para a equipe" (decisão do João, 26/10/2026) — e a rede de segurança da
 * recusa: a Sofia já disse que a equipe cancela, então a tarefa de CANCELAR NA FRANQUIA não pode se perder.
 *
 * Antes isto morava no follow-up (régua): só rodava com a régua ligada na unidade, dentro do horário comercial e na janela de
 * 24 h do WhatsApp. Aqui é um relógio próprio, só no líder dos workers e só para unidade com a automação LIGADA:
 *  1. oferta sem resposta: a marca `desistencia_oferta:<consulta>` tem entre 2 h e 3 dias e ele NÃO escreveu depois dela; a consulta
 *     de hoje ainda é a da marca (se foi remarcada, não há o que avisar) → abre a tarefa "não respondeu";
 *  2. recusa sem tarefa: a marca `recusou_remarcar:<consulta>` existe e nenhuma tarefa CANCELAR/CONFERIR saiu depois dela (o Kommo
 *     falhou) → refaz. Só desiste se ele VOLTOU ATRÁS de verdade ("consegui, vou sim", "confirmo") — "ok, obrigada" não desfaz nada.
 *  Depois de MAX_TENTATIVAS falhas seguidas numa marca, log de erro + Telegram ao João: a Sofia prometeu e ninguém cancela.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import { abrirTarefaDaDesistencia, agirNaDesistencia, estadoDaDesistencia, MARCA_OFERTA, MARCA_RECUSOU } from './desistencia-acao.js';
import { pareceDesistenciaDaConsulta } from './desistencia-frases.js';
import { voltouAtrasDeVerdade } from './vespera-segura.js';
import { marcadoEm } from './aviso-dedupe.js';
import { enviarTelegram } from './telegram.js';

const SWEEP_MS = 10 * 60_000;
export const ESPERA_DA_OFERTA_MS = 2 * 3600_000;
export const VALIDADE_DA_MARCA_MS = 3 * 24 * 3600_000;
export const MAX_TENTATIVAS = 12;
const PAGINA = 200;
const MAX_PAGINAS = 5;

let timer: NodeJS.Timeout | null = null;
let rodando = false;
/** Marcas já olhadas (unidade:lead:hora da marca): uma marca que não vira tarefa (sem consulta) não relê o cartão a cada 10 min. */
const olhadas = new Set<string>();
const tentativas = new Map<string, number>();

/** Pura: esta marca já pode virar "não respondeu"? Velha o bastante, nova o bastante, e ele não escreveu depois dela. */
export function marcaVenceuSemResposta(marca: Date, agora: Date, mensagensDoPacienteDepois: number): boolean {
  const idade = agora.getTime() - marca.getTime();
  return idade >= ESPERA_DA_OFERTA_MS && idade <= VALIDADE_DA_MARCA_MS && mensagensDoPacienteDepois === 0;
}

/** Pura: depois de tantas falhas seguidas, avisa o João. */
export function deveAvisarOJoao(falhasSeguidas: number): boolean {
  return falhasSeguidas === MAX_TENTATIVAS;
}

async function registrarFalha(id: string, descricao: string): Promise<void> {
  const n = (tentativas.get(id) ?? 0) + 1;
  tentativas.set(id, n);
  if (tentativas.size > 5000) tentativas.clear();
  if (n >= MAX_TENTATIVAS) {
    olhadas.add(id);
    if (deveAvisarOJoao(n)) {
      logger.error({ id }, `desistência: ${descricao} — desisti depois de ${MAX_TENTATIVAS} tentativas`);
      await enviarTelegram(`⚠️ Desistência da consulta: ${descricao}. Tentei ${MAX_TENTATIVAS} vezes e o Kommo não aceitou. A Sofia JÁ disse ao paciente que a equipe cancela — alguém precisa abrir a tarefa à mão. (${id})`).catch(() => false);
    }
  }
}

/** A desistência que causou a marca: a mais recente, até a hora dela, que o detector reconhece (o paciente pode ter escrito mais de uma mensagem). */
async function falaDeDesistencia(conversationId: string, ate: Date): Promise<string> {
  const falas = await prisma.message.findMany({ where: { conversationId, role: 'user', createdAt: { lte: ate } }, orderBy: { createdAt: 'desc' }, take: 6, select: { content: true } });
  return falas.find((f) => pareceDesistenciaDaConsulta(f.content))?.content ?? '';
}

/** Todas as marcas do tipo na janela, em páginas (as mais antigas travadas não escondem as novas). */
async function marcasDaJanela(prefixo: string, de: Date, ate: Date) {
  const todas: Array<{ id: string; unitId: string; leadId: string; ruleKey: string; createdAt: Date }> = [];
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const lote = await prisma.cardAlert.findMany({
      where: { ruleKey: { startsWith: `${prefixo}:` }, createdAt: { gte: de, lte: ate } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: pagina * PAGINA,
      take: PAGINA,
    });
    todas.push(...lote);
    if (lote.length < PAGINA) break;
  }
  return todas;
}

/** `<prefixo>:<consulta>` → a consulta ("AAAA-MM-DDTHH:mm" ou "?"). */
const consultaDaChave = (ruleKey: string): string => ruleKey.slice(ruleKey.indexOf(':') + 1);

async function refazerTarefasQueFalharam(agora: Date): Promise<void> {
  const marcas = await marcasDaJanela(MARCA_RECUSOU, new Date(agora.getTime() - VALIDADE_DA_MARCA_MS), new Date(agora.getTime() - 10 * 60_000));
  for (const m of marcas) {
    const id = `recusa:${m.unitId}:${m.leadId}:${m.createdAt.getTime()}`;
    if (olhadas.has(id)) continue;
    try {
      const [c, q] = await Promise.all([
        marcadoEm(m.unitId, m.leadId, 'desistencia_tarefa:cancelar'),
        marcadoEm(m.unitId, m.leadId, 'desistencia_tarefa:conferir'),
      ]);
      if ((c && c >= m.createdAt) || (q && q >= m.createdAt)) { olhadas.add(id); continue; }
      const [unit, conv] = await Promise.all([
        prisma.unit.findUnique({ where: { id: m.unitId } }),
        prisma.conversation.findUnique({ where: { unitId_leadId: { unitId: m.unitId, leadId: m.leadId } }, select: { id: true } }),
      ]);
      if (!unit || !conv) { olhadas.add(id); continue; }
      if (estadoDaDesistencia(unit.slug) !== 'ligado') continue;
      // Só volta atrás de verdade desfaz a recusa. Qualquer outra fala ("ok, obrigada") não: a Sofia prometeu e a véspera está calada.
      const depois = await prisma.message.findMany({ where: { conversationId: conv.id, role: 'user', createdAt: { gt: m.createdAt } }, select: { content: true }, take: 20 });
      if (voltouAtrasDeVerdade(depois.map((d) => d.content))) { olhadas.add(id); continue; }
      const r = await agirNaDesistencia({ unit, leadId: Number(m.leadId), acao: 'recusou', trecho: await falaDeDesistencia(conv.id, m.createdAt), kommo: () => createKommoClient(unit), refazendo: true });
      if (r === 'falhou') await registrarFalha(id, `refazer a tarefa de CANCELAR NA FRANQUIA (unidade ${unit.slug}, cartão ${m.leadId})`);
      else olhadas.add(id);
    } catch (err) {
      logger.warn({ err: String(err), unitId: m.unitId, leadId: m.leadId }, 'desistência: refazer a tarefa de cancelar falhou (segue)');
    }
  }
}

async function avisarOfertasSemResposta(agora: Date): Promise<void> {
  const marcas = await marcasDaJanela(MARCA_OFERTA, new Date(agora.getTime() - VALIDADE_DA_MARCA_MS), new Date(agora.getTime() - ESPERA_DA_OFERTA_MS));
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
      const r = await abrirTarefaDaDesistencia({
        unit,
        leadId: Number(m.leadId),
        texto: await falaDeDesistencia(conv.id, m.createdAt),
        motivo: 'sem_resposta',
        nome: null,
        kommo: () => createKommoClient(unit),
        consultaDaMarca: consultaDaChave(m.ruleKey),
      });
      if (r === 'falhou') await registrarFalha(id, `tarefa "não respondeu à oferta" (unidade ${unit.slug}, cartão ${m.leadId})`);
      else {
        if (olhadas.size > 5000) olhadas.clear();
        olhadas.add(id);
      }
    } catch (err) {
      logger.warn({ err: String(err), unitId: m.unitId, leadId: m.leadId }, 'desistência sem resposta: falha na marca (segue)');
    }
  }
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const agora = new Date();
    await refazerTarefasQueFalharam(agora);
    await avisarOfertasSemResposta(agora);
  } catch (err) {
    logger.warn({ err: String(err) }, 'desistência sem resposta: varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startDesistenciaSemRespostaWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info('desistência sem resposta: worker iniciado (tarefa se ele não responde à oferta em 2 h; refaz a de cancelar que falhou)');
}

export function stopDesistenciaSemRespostaWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
