// ============================================================================
// sla-alert-worker.ts — SLA de RESPOSTA HUMANA pós-pausa.
//
// O PROBLEMA
// ----------
// A IA passa o lead pra um humano (pausar_ia → handoffAt). A secretária pode
// demorar a pegar. Um lead esperando 5 min sem ninguém responder é lead
// esfriando. Queremos AVISAR os SDRs no WhatsApp quando isso acontece — mas SÓ
// quando ninguém respondeu de verdade.
//
// POR QUE NÃO DÁ PRA FAZER NO SALESBOT DO KOMMO
// ---------------------------------------------
// O Salesbot não enxerga a resposta OUTGOING do atendente. Ele só sabe "passou
// X min" → dispararia alarme falso toda vez que a menina respondesse dentro do
// prazo. O backend SABE: quando o humano responde, o webhook zera o `handoffAt`
// (webhook.controller). Logo, `handoffAt` ainda preenchido após 5 min =
// NINGUÉM respondeu. É o gatilho exato, sem falso alarme.
//
// COMO O ALERTA CHEGA NO WHATSAPP
// -------------------------------
// Cria uma TAREFA no Kommo cujo texto começa com `ALERTA · <slug> · ...`. O
// webhook nativo do Kommo (add_task) dispara o n8n → Evolution → grupo dos SDRs,
// mencionando a unidade do slug. Ver project_sdr_whatsapp_alerts (memória).
//
// GUARDAS
// -------
//   - opt-in por unidade + limiar configurável em `pipelineIntents.sla_alert_minutes`
//     (número de minutos; ausente/0 = desligado). Sem migration na Unit.
//   - só dentro do horário comercial (não pinga o grupo às 3h)
//   - idempotência via `Conversation.slaAlertAt` (1 alerta por handoff; reseta no
//     próximo pausar_ia)
//
// Estado no BANCO (`handoffAt`, `slaAlertAt`): sobrevive a restart e vale pra
// todas as réplicas ao mesmo tempo.
// ============================================================================

import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';

const SWEEP_MS = 60_000; // 1 min — mais fino que o degrau de 5, pra precisão
const DEFAULT_MIN = 5; // fallback quando a config vem como `true`/vazia
// Janela de frescor: só alerta handoff que cruzou o limiar HÁ POUCO. Sem isso,
// ao LIGAR o SLA numa unidade, todos os handoffs velhos parados (handoffAt nunca
// zerado) disparariam alerta de uma vez — envio em massa. Com o teto, só entra
// lead novo (handoff recente), nunca backfill retroativo.
const MAX_ATRASO_MIN = 30;

let timer: NodeJS.Timeout | null = null;
let rodando = false;

/** Minutos de espera configurados pra unidade, ou null se desligado. */
function limiarMin(unit: Unit): number | null {
  const cfg = (unit.pipelineIntents as Record<string, unknown> | null)?.sla_alert_minutes;
  if (cfg === true) return DEFAULT_MIN;
  const n = Number(cfg);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "agora" no relógio da clínica: minutos do dia + dia da semana (0=dom). */
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

/** Só alerta em dia/horário de atendimento (08:00–20:00 por padrão). */
function dentroDoHorario(unit: Unit): boolean {
  const { minutos, diaSemana } = agoraLocal(unit.spineTimezone ?? 'America/Sao_Paulo');
  const dias = unit.spineAgendaDays?.length ? unit.spineAgendaDays : [1, 2, 3, 4, 5];
  if (!dias.includes(diaSemana)) return false;
  const abre = Math.max(paraMinutos(unit.spineAgendaStart) ?? 8 * 60, 8 * 60);
  const fecha = Math.min(paraMinutos(unit.spineAgendaEnd) ?? 20 * 60, 20 * 60);
  return minutos >= abre && minutos < fecha;
}

/** "5 min", "1h30", "2h" — a partir de ms de espera. */
function humanizarEspera(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r ? `${h}h${String(r).padStart(2, '0')}` : `${h}h`;
}

async function alertarUnidade(unit: Unit): Promise<void> {
  const min = limiarMin(unit);
  if (!min) return;
  if (!dentroDoHorario(unit)) return;

  const agora = Date.now();
  const teto = new Date(agora - min * 60_000); // já cruzou o limiar (>= min atrás)
  const piso = new Date(agora - (min + MAX_ATRASO_MIN) * 60_000); // mas é FRESCO (não backfill de handoff velho)
  const candidatas = await prisma.conversation.findMany({
    where: {
      unitId: unit.id,
      // handoff entre [min, min+MAX_ATRASO] atrás: passou do limiar mas não é
      // antigo. handoffAt ainda preenchido = humano NÃO respondeu (o webhook
      // zera quando ele responde). Fora dessa janela = velho, ignora.
      handoffAt: { not: null, lte: teto, gte: piso },
      slaAlertAt: null, // ainda não alertamos este handoff
      convertedAt: null,
    },
    orderBy: { handoffAt: 'asc' },
    take: 40,
  });
  if (candidatas.length === 0) return;

  const kommo = createKommoClient(unit);
  const filtroEtapas = unit.slaAlertStatusIds ?? [];

  for (const conv of candidatas) {
    const leadId = Number(conv.leadId);
    if (!Number.isFinite(leadId)) {
      // leadId inválido nunca vira candidato de novo: marca pra sair da fila.
      await prisma.conversation
        .update({ where: { id: conv.id }, data: { slaAlertAt: new Date() } })
        .catch(() => undefined);
      continue;
    }

    try {
      // Busca o lead 1x quando precisa: pra checar a ETAPA (filtro) e/ou pegar o
      // nome se faltar. Se não há filtro nem falta nome, nem lê o Kommo.
      const precisaLead = filtroEtapas.length > 0 || !conv.contactName?.trim();
      const lead = precisaLead ? await kommo.getLead(leadId).catch(() => null) : null;

      // Filtro de etapa: o SLA só vale nas etapas ativas (ex: Entrada, Em
      // Qualificação, Em Negociação). Lead Perdido/Ganho/Tratamento (ou fora da
      // lista) que ficou com "Pausar IA" marcado NÃO é caso de SLA — zera o
      // handoff pra sair da fila de vez.
      if (filtroEtapas.length > 0) {
        if (!lead) continue; // não conseguiu ler: tenta no próximo sweep (não dropa)
        if (!filtroEtapas.includes(lead.status_id)) {
          await prisma.conversation
            .update({ where: { id: conv.id }, data: { handoffAt: null } })
            .catch(() => undefined);
          continue;
        }
      }

      const nome = conv.contactName?.trim() || (lead?.name ?? '').trim();
      const contato = nome ? `[Contato: ${nome}] ` : '';
      const espera = humanizarEspera(Date.now() - (conv.handoffAt as Date).getTime());
      const texto =
        `ALERTA · ${unit.slug} · ${contato}` +
        `Lead aguardando há ${espera} e ninguém respondeu (IA pausada). Priorizar!`;
      const completeAt = Math.floor(Date.now() / 1000); // vence agora → aparece como pendente

      const res = await kommo.createTask({ leadId, text: texto, completeAt });
      if (res) {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { slaAlertAt: new Date() },
        });
        logger.info({ unit: unit.slug, leadId, espera }, 'SLA: alerta de humano sem resposta criado');
      }
      // Se createTask falhou (null/throw), NÃO marca — tenta de novo no próximo sweep.
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'SLA: falha ao criar alerta — segue');
    }
  }
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const unidades = await prisma.unit.findMany();
    for (const unit of unidades) {
      await alertarUnidade(unit).catch((err) =>
        logger.warn({ err: String(err), unit: unit.slug }, 'SLA: unidade falhou'),
      );
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'SLA: varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startSlaAlertWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info('SLA: worker iniciado (opt-in por pipelineIntents.sla_alert_minutes)');
}

export function stopSlaAlertWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
