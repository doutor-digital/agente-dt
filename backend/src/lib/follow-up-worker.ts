// ============================================================================
// follow-up-worker.ts — Reengaja quem parou de responder.
//
// POR QUE ISTO EXISTE
// -------------------
// `followUpEnabled` e o texto no prompt já existiam há tempos — a IA chegava a
// prometer "te chamo depois". Só que ninguém chamava: não havia worker nenhum.
// Era uma promessa que o sistema nunca cumpriu.
//
// A ESCADA VEM DA TELA, POR ETAPA DO FUNIL
// -----------------------------------------
// Quem decide os degraus é FollowUpRule, configurada na tela de Follow-up: uma
// escada para EM QUALIFICAÇÃO, outra para AGENDADO, outra por motivo de perda.
// Sem regra ligada, ninguém recebe nada — mesmo com a chave geral ligada.
//
// A ESCADA CABE NA JANELA DE 24 HORAS, e isso não é detalhe
// ----------------------------------------------------------
// O WhatsApp só permite mensagem livre dentro de 24h desde a última mensagem
// DO PACIENTE. Passou disso, só template aprovado pela Meta — outro produto,
// que custa por envio e não aceita texto escrito na hora. Uma escada que
// terminasse em 72h simplesmente não seria entregue.
//
// Por isso o último degrau é em 20h: última chance antes de a porta fechar, e
// por isso ele é o de despedida.
//
// Os intervalos crescem porque a razão do silêncio muda. Aos 5 minutos quase
// sempre é distração — a pessoa largou o celular no meio da conversa e volta.
// Depois de horas, distração já não explica: ou ela decidiu não seguir, ou algo
// travou. Insistir no mesmo ritmo aí vira perseguição, e paciente perseguido
// não só não volta como conta pros outros.
//
// UM CÉREBRO SÓ DECIDE QUANDO FALAR
// ---------------------------------
// O Salesbot é o CANAL (o PATCH no campo dispara a entrega), nunca um segundo
// motor de follow-up. Se o Kommo também tivesse um temporizador mirando o
// mesmo lead, os dois disparariam sem se ver — e mensagem duplicada no
// WhatsApp não tem desfazer. Este arquivo é o único lugar que decide o quando.
//
// QUANDO NÃO MANDA
// ----------------
//   - fora do horário comercial da unidade (mensagem às 3h queima o contato)
//   - se o paciente respondeu (a escada zera: quem voltou não sumiu)
//   - se já marcou consulta, ou pediu pra parar, ou a escada acabou
//
// Estado no BANCO, não em memória: diferente dos outros sweepers daqui, perder
// isto num restart faria a escada recomeçar e o paciente receber tudo de novo.
// ============================================================================

import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import { ehIntocavel } from './follow-up-presets.js';

/** Varredura a cada minuto: o primeiro degrau é de 5 min e precisa de resolução. */
const SWEEP_MS = 60_000;

/**
 * Degraus em minutos desde a última mensagem nossa sem resposta.
 * `intencao` vira instrução pro modelo — não é o texto final. Texto fixo em
 * cinco degraus soa exatamente como o que é.
 */
interface Degrau {
  aposMin: number;
  intencao: string;
}

// A escada NÃO mora mais aqui. Cada etapa do funil tem a sua, configurada na
// tela de Follow-up e guardada em FollowUpRule; os modelos prontos estão em
// follow-up-presets.ts.
//
// Uma escada fixa neste arquivo continuaria compilando e nunca seria usada —
// código morto que PARECE configuração é pior que código morto comum: quem
// vier depois ajusta os minutos aqui, testa, e não entende por que nada muda.

/**
 * Teto absoluto. Passou disto, a janela do WhatsApp fechou e mensagem livre não
 * chega — mandar seria gastar chamada de modelo pra produzir silêncio.
 */
const JANELA_WHATSAPP_MIN = 23 * 60;

/**
 * ETAPA DE CADA LEAD, EM LOTE E COM CACHE.
 *
 * A regra a aplicar depende de onde o lead está no funil, e essa informação
 * mora no Kommo. Consultar lead a lead seriam 40 chamadas por varredura, a cada
 * minuto — inviável.
 *
 * Então busca em lote os leads MEXIDOS nos últimos dias (updated_at, não
 * created_at: um lead antigo movido pra PERDIDO hoje precisa aparecer) e
 * guarda por 3 minutos. O degrau mais fino é de 5 minutos, então 3 de cache
 * não atrasa nada perceptível e derruba as chamadas de ~2400/h para ~20/h.
 */
interface EstadoDoLead {
  statusId: number | null;
  lossReasonId: number | null;
}
const CACHE_ETAPAS_MS = 3 * 60_000;
const cacheEtapas = new Map<string, { em: number; mapa: Map<number, EstadoDoLead> }>();

async function etapasDosLeads(unit: {
  id: string;
  slug: string;
}): Promise<Map<number, EstadoDoLead>> {
  const cached = cacheEtapas.get(unit.id);
  if (cached && Date.now() - cached.em < CACHE_ETAPAS_MS) return cached.mapa;

  const mapa = new Map<number, EstadoDoLead>();
  try {
    const completa = await prisma.unit.findUnique({ where: { id: unit.id } });
    if (!completa) return mapa;
    const kommo = createKommoClient(completa);
    const desde = Math.floor(Date.now() / 1000) - 3 * 86_400;
    for (const l of await kommo.listLeadsAtualizadosDesde(desde)) {
      mapa.set(l.id, {
        statusId: l.status_id ?? null,
        lossReasonId: l.loss_reason_id ?? null,
      });
    }
    cacheEtapas.set(unit.id, { em: Date.now(), mapa });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'follow-up: não consegui ler as etapas');
  }
  return mapa;
}

/**
 * A regra que vale para este lead: primeiro a específica do motivo de perda,
 * senão a da etapa. Sem regra ligada, ninguém recebe nada — é o comportamento
 * certo, porque a tela é quem decide, não o código.
 */
function regraPara(
  regras: Array<{ statusId: number; lossReasonId: number | null; steps: unknown }>,
  estado: EstadoDoLead,
): Degrau[] | null {
  if (estado.statusId == null) return null;
  const doMotivo = regras.find(
    (r) => r.statusId === estado.statusId && r.lossReasonId === estado.lossReasonId,
  );
  const daEtapa = regras.find((r) => r.statusId === estado.statusId && r.lossReasonId === null);
  const escolhida = doMotivo ?? daEtapa;
  if (!escolhida) return null;
  const passos = escolhida.steps as Degrau[];
  return Array.isArray(passos) && passos.length > 0 ? passos : null;
}

let timer: NodeJS.Timeout | null = null;
let rodando = false;

/** "agora" no relógio da clínica. */
function agoraLocal(tz: string): { minutos: number; diaSemana: number } {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(p.find((x) => x.type === 'hour')?.value ?? 0);
  const m = Number(p.find((x) => x.type === 'minute')?.value ?? 0);
  const dias: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minutos: h * 60 + m,
    diaSemana: dias[p.find((x) => x.type === 'weekday')?.value ?? 'Mon'] ?? 1,
  };
}

function paraMinutos(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

/**
 * Mensagem fora do horário em que a clínica atende não é reengajamento, é
 * incômodo — e às 3h da manhã queima o contato de vez. Quem cair fora da janela
 * espera: o degrau não é perdido, só adiado.
 */
function dentroDoHorario(unit: {
  spineAgendaStart: string | null;
  spineAgendaEnd: string | null;
  spineTimezone: string | null;
  spineAgendaDays: number[];
}): boolean {
  const { minutos, diaSemana } = agoraLocal(unit.spineTimezone ?? 'America/Sao_Paulo');
  const dias = unit.spineAgendaDays?.length ? unit.spineAgendaDays : [1, 2, 3, 4, 5];
  if (!dias.includes(diaSemana)) return false;
  // Janela deliberadamente mais estreita que a da agenda: 08:00 é cedo o
  // bastante pra não parecer madrugada, e parar às 20:00 evita o horário em que
  // mensagem comercial mais irrita.
  const abre = Math.max(paraMinutos(unit.spineAgendaStart) ?? 8 * 60, 8 * 60);
  const fecha = Math.min(paraMinutos(unit.spineAgendaEnd) ?? 20 * 60, 20 * 60);
  return minutos >= abre && minutos < fecha;
}

async function varrer(): Promise<void> {
  if (rodando) return; // a varredura de 1min pode encavalar
  rodando = true;
  try {
    const unidades = await prisma.unit.findMany({ where: { followUpEnabled: true } });
    for (const unit of unidades) {
      if (!dentroDoHorario(unit)) continue;

      // Sem regra ligada, a unidade não reengaja ninguém — mesmo com a chave
      // geral ligada. Quem manda é a tela.
      const regras = await prisma.followUpRule.findMany({
        where: { unitId: unit.id, enabled: true },
      });
      if (regras.length === 0) continue;

      const etapas = await etapasDosLeads(unit);

      const candidatas = await prisma.conversation.findMany({
        where: {
          unitId: unit.id,
          followUpStoppedReason: null,
          convertedAt: null,
        },
        orderBy: { lastMessageAt: 'asc' },
        take: 60,
      });

      for (const conv of candidatas) {
        const estado = etapas.get(Number(conv.leadId));
        // Lead que não veio no lote (mexido há mais de 3 dias) não é candidato:
        // a janela de 24h já teria fechado de qualquer jeito.
        if (!estado) continue;

        // Motivo intocável vence QUALQUER regra ligada. A trava está aqui e no
        // controller: nem por engano, nem por regra antiga salva antes desta
        // lista existir, alguém recebe cobrança tendo dito que não pode pagar.
        if (ehIntocavel(estado.lossReasonId)) {
          await prisma.conversation
            .update({
              where: { id: conv.id },
              data: { followUpStoppedReason: 'motivo de perda não recebe follow-up' },
            })
            .catch(() => undefined);
          continue;
        }

        const ESCADA_DA_REGRA = regraPara(regras, estado);
        if (!ESCADA_DA_REGRA) continue;
        if (conv.followUpStep >= ESCADA_DA_REGRA.length) continue;

        // A referência é a ÚLTIMA mensagem da conversa, não o último follow-up:
        // se o paciente respondeu, lastMessageAt andou e o silêncio recomeça.
        const paradoMin = (Date.now() - conv.lastMessageAt.getTime()) / 60_000;

        // A ESCADA É FUNÇÃO DO SILÊNCIO, NÃO UMA FILA.
        //
        // Pegar sempre o próximo degrau não enviado parece natural e produz
        // dois defeitos, os dois medidos antes de isto entrar no ar:
        //
        // 1. RAJADA. Uma conversa parada há 11h com degrau 0 tem TODOS os
        //    degraus vencidos. A varredura manda o 1º; um minuto depois o 2º
        //    também está vencido e vai; depois o 3º, 4º, 5º. Cinco mensagens
        //    em cinco minutos — e no WhatsApp isso não se desfaz.
        // 2. TOM ERRADO. Quem sumiu há 11 horas receberia "toque leve, como
        //    quem continua a conversa", escrito para 5 minutos de silêncio.
        //
        // Então escolhemos o ÚLTIMO degrau já vencido: 11h de silêncio recebe
        // a mensagem de 6h, que é a escrita para esse tempo. Os degraus
        // pulados são dados como enviados, porque o momento deles passou.
        let alvo = -1;
        for (let i = conv.followUpStep; i < ESCADA_DA_REGRA.length; i++) {
          if (paradoMin >= ESCADA_DA_REGRA[i].aposMin) alvo = i;
        }
        if (alvo < 0) continue;
        const proximo = ESCADA_DA_REGRA[alvo];

        // ESPAÇAMENTO MÍNIMO desde o último reengajamento. Segunda trava contra
        // rajada: mesmo escolhendo o degrau certo, dois envios seguidos com um
        // minuto de intervalo seriam agressivos. Usa o intervalo natural entre
        // o degrau anterior e este.
        if (conv.followUpLastAt) {
          const desdeUltimo = (Date.now() - conv.followUpLastAt.getTime()) / 60_000;
          const intervaloNatural =
            alvo > 0 ? ESCADA_DA_REGRA[alvo].aposMin - ESCADA_DA_REGRA[alvo - 1].aposMin : 5;
          if (desdeUltimo < intervaloNatural) continue;
        }

        if (paradoMin > JANELA_WHATSAPP_MIN) {
          await prisma.conversation
            .update({
              where: { id: conv.id },
              data: { followUpStoppedReason: 'janela de 24h do WhatsApp fechou' },
            })
            .catch(() => undefined);
          continue;
        }

        const ultima = await prisma.message.findFirst({
          where: { conversationId: conv.id },
          orderBy: { createdAt: 'desc' },
          select: { role: true },
        });
        // Se a última fala é do PACIENTE, não é hora de reengajar — é hora de
        // responder, e disso cuida o webhook. Reengajar aqui atropelaria a
        // resposta que está sendo gerada.
        if (!ultima || ultima.role !== 'assistant') continue;

        // Consulta marcada encerra o assunto. Sem isto, quem já agendou
        // continuaria recebendo "ainda está aí?" — o caminho mais curto entre
        // reengajar e virar spam.
        const temConsulta = await prisma.spineLeadLink.findFirst({
          where: { unitId: unit.id, kommoLeadId: Number(conv.leadId), spineIdSchedule: { not: null } },
          select: { id: true },
        });
        if (temConsulta) {
          await prisma.conversation
            .update({ where: { id: conv.id }, data: { followUpStoppedReason: 'consulta marcada' } })
            .catch(() => undefined);
          continue;
        }

        await enviarDegrau(unit, conv, proximo, alvo, ESCADA_DA_REGRA.length);
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'follow-up: varredura falhou');
  } finally {
    rodando = false;
  }
}

async function enviarDegrau(
  unit: { id: string; slug: string },
  conv: { id: string; leadId: string; followUpStep: number },
  degrau: Degrau,
  /** Índice do degrau escolhido — pode ter pulado os que venceram juntos. */
  indice: number,
  /** Tamanho da escada DESTA regra: cada etapa do funil tem a sua. */
  totalDegraus: number,
): Promise<void> {
  const leadId = Number(conv.leadId);
  if (!Number.isFinite(leadId)) return;

  try {
    const { runAgentFollowUp } = await import('../agent/follow-up.js');
    const texto = await runAgentFollowUp({
      unitId: unit.id,
      leadId,
      conversationId: conv.id,
      intencao: degrau.intencao,
      ultimoDegrau: indice === totalDegraus - 1,
    });
    if (!texto) return;

    const unitCompleta = await prisma.unit.findUnique({ where: { id: unit.id } });
    if (!unitCompleta) return;
    const kommo = createKommoClient(unitCompleta);
    // chatId/talkId/contactId nulos de propósito: o caminho do Salesbot é um
    // PATCH no campo "Resposta IA", e é o Digital Pipeline do Kommo que
    // entrega. Os outros dois são fallback e não se aplicam aqui.
    await kommo.sendChatReply({ leadId, text: texto, chatId: null, talkId: null, contactId: null });

    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        // indice + 1, não step + 1: os degraus pulados contam como enviados,
        // senão a rajada volta pela porta dos fundos na varredura seguinte.
        followUpStep: indice + 1,
        followUpLastAt: new Date(),
        ...(indice + 1 >= totalDegraus ? { followUpStoppedReason: 'escada concluída' } : {}),
      },
    });

    // NÃO mexe em lastMessageAt: ele marca o silêncio do paciente, e é o que
    // faz o próximo degrau contar do momento certo. Atualizar aqui reiniciaria
    // o relógio a cada follow-up e a escada nunca avançaria.
    await prisma.message.create({
      data: {
        conversationId: conv.id,
        role: 'assistant',
        content: texto,
        meta: { followUp: indice + 1 },
      },
    });

    logger.info(
      { unit: unit.slug, leadId, degrau: indice + 1, pulados: indice - conv.followUpStep },
      'follow-up: reengajamento enviado',
    );
  } catch (err) {
    logger.warn(
      { err: String(err), unit: unit.slug, leadId },
      'follow-up: falha ao enviar reengajamento',
    );
    // Não incrementa o degrau: falha de rede não pode consumir uma etapa da
    // escada. Na próxima varredura tenta de novo.
  }
}

/** Corta o reengajamento de vez. */
export async function pararFollowUp(
  unitId: string,
  leadId: string | number,
  motivo: string,
): Promise<void> {
  await prisma.conversation
    .updateMany({
      where: { unitId, leadId: String(leadId) },
      data: { followUpStoppedReason: motivo },
    })
    .catch(() => undefined);
}

/** Zera a escada — o paciente voltou a falar, então não é mais quem sumiu. */
export async function reiniciarFollowUp(unitId: string, leadId: string | number): Promise<void> {
  await prisma.conversation
    .updateMany({
      where: { unitId, leadId: String(leadId), followUpStep: { gt: 0 } },
      data: { followUpStep: 0, followUpLastAt: null },
    })
    .catch(() => undefined);
}

export function startFollowUpWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info('follow-up: worker iniciado — escadas vêm das regras por etapa');
}

export function stopFollowUpWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
