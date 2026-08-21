import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import { ehIntocavel } from './follow-up-presets.js';
import { carimbarContato } from '../services/lead-memory.service.js';

const SWEEP_MS = 60_000;

interface Degrau {
  aposMin: number;
  intencao: string;
}

const JANELA_WHATSAPP_MIN = 23 * 60;

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

function dentroDoHorario(unit: {
  spineAgendaStart: string | null;
  spineAgendaEnd: string | null;
  spineTimezone: string | null;
  spineAgendaDays: number[];
}): boolean {
  const { minutos, diaSemana } = agoraLocal(unit.spineTimezone ?? 'America/Sao_Paulo');
  const dias = unit.spineAgendaDays?.length ? unit.spineAgendaDays : [1, 2, 3, 4, 5];
  if (!dias.includes(diaSemana)) return false;
  const abre = Math.max(paraMinutos(unit.spineAgendaStart) ?? 8 * 60, 8 * 60);
  const fecha = Math.min(paraMinutos(unit.spineAgendaEnd) ?? 20 * 60, 20 * 60);
  return minutos >= abre && minutos < fecha;
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const unidades = await prisma.unit.findMany({ where: { followUpEnabled: true } });
    for (const unit of unidades) {
      if (!dentroDoHorario(unit)) continue;

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
        if (!estado) continue;

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

        const paradoMin = (Date.now() - conv.lastMessageAt.getTime()) / 60_000;

        let alvo = -1;
        for (let i = conv.followUpStep; i < ESCADA_DA_REGRA.length; i++) {
          if (paradoMin >= ESCADA_DA_REGRA[i].aposMin) alvo = i;
        }
        if (alvo < 0) continue;
        const proximo = ESCADA_DA_REGRA[alvo];

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
        if (!ultima || ultima.role !== 'assistant') continue;

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
  indice: number,
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
    await kommo.sendChatReply({ leadId, text: texto, chatId: null, talkId: null, contactId: null });

    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        followUpStep: indice + 1,
        followUpLastAt: new Date(),
        ...(indice + 1 >= totalDegraus ? { followUpStoppedReason: 'escada concluída' } : {}),
      },
    });

    await prisma.message.create({
      data: {
        conversationId: conv.id,
        role: 'assistant',
        content: texto,
        meta: { followUp: indice + 1 },
      },
    });

    if (indice + 1 >= totalDegraus) {
      carimbarContato(unit.id, leadId, { desfecho: 'sumiu' });
    }

    logger.info(
      { unit: unit.slug, leadId, degrau: indice + 1, pulados: indice - conv.followUpStep },
      'follow-up: reengajamento enviado',
    );
  } catch (err) {
    logger.warn(
      { err: String(err), unit: unit.slug, leadId },
      'follow-up: falha ao enviar reengajamento',
    );
  }
}

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
