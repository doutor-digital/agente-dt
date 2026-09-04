/**
 * Livro de resultados — o que a IA fez em cada conversa e o que aconteceu depois.
 *
 * Por que existe (04/09/2026, pedido do João: "quero que ela tome as decisões certas
 * sozinha e consiga o máximo de agendamentos e comparecimentos"): até aqui a Sofia era
 * avaliada por um juiz que lê a conversa e dá nota de estilo. A recompensa que importa
 * é consulta marcada que virou paciente na cadeira. Este serviço fecha o ciclo por
 * conversa: mensagens/ferramentas (o que ela fez) → Kommo (marcou?) → franquia
 * (compareceu?). Tudo que for aprender com resultado — reflexão semanal, experimentos,
 * motor de comparecimento — lê daqui.
 *
 * Duas partes: funções PURAS (extrairComportamento, classificarDesfecho), testáveis
 * sem banco; e calcularConversa/calcularResultados, que buscam nos sistemas.
 */
import type { Conversation, Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { createKommoClient } from './kommo.service.js';
import { esquemaDaUnidade } from '../lib/kommo-schema.js';
import { estadoEtapaDoLead } from './lead-stage.service.js';
import { SpineService } from './spine.service.js';

export interface MsgResumo {
  role: string;
  content: string;
  createdAt: Date;
}
export interface StepResumo {
  kind: string;
  title: string;
  payload: unknown;
  createdAt: Date;
}

export interface Comportamento {
  msgsPaciente: number;
  msgsIa: number;
  primeiraRespostaSeg: number | null;
  consultasAgenda: number;
  horariosOferecidos: number;
  precoNaMsg: number | null;
  agendouIa: boolean;
  agendouIaEm: Date | null;
  agendadoPara: string | null;
  spineIdSchedule: number | null;
  ultimaMsgEm: Date | null;
}

const RE_PRECO = /R\$\s?\d/;

/** Lê mensagens e passos da conversa e resume o que a IA fez. Puro. */
export function extrairComportamento(msgs: MsgResumo[], steps: StepResumo[]): Comportamento {
  const ordenadas = [...msgs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const paciente = ordenadas.filter((m) => m.role === 'user');
  const ia = ordenadas.filter((m) => m.role === 'assistant');
  let primeiraRespostaSeg: number | null = null;
  if (paciente[0]) {
    const resp = ia.find((m) => m.createdAt > paciente[0].createdAt);
    if (resp) primeiraRespostaSeg = Math.round((resp.createdAt.getTime() - paciente[0].createdAt.getTime()) / 1000);
  }
  const idxPreco = ia.findIndex((m) => RE_PRECO.test(m.content));

  let consultasAgenda = 0;
  let horariosOferecidos = 0;
  let agendouIaEm: Date | null = null;
  let agendadoPara: string | null = null;
  let spineIdSchedule: number | null = null;
  for (const s of steps) {
    if (s.kind === 'TOOL_RESULT' && s.title.startsWith('consultar_horarios')) {
      consultasAgenda++;
      const p = s.payload as { oferecer?: unknown } | null;
      if (Array.isArray(p?.oferecer)) horariosOferecidos += p.oferecer.length;
    }
    if (s.kind === 'TOOL_RESULT' && s.title.startsWith('Consulta marcada:')) {
      const p = s.payload as { data?: string; hora?: string; idSchedule?: number } | null;
      agendouIaEm = s.createdAt; // a última marcação vale (remarcação sobrescreve)
      agendadoPara = p?.data && p?.hora ? `${p.data}T${p.hora}` : agendadoPara;
      spineIdSchedule = typeof p?.idSchedule === 'number' ? p.idSchedule : spineIdSchedule;
    }
  }
  return {
    msgsPaciente: paciente.length,
    msgsIa: ia.length,
    primeiraRespostaSeg,
    consultasAgenda,
    horariosOferecidos,
    precoNaMsg: idxPreco >= 0 ? idxPreco + 1 : null,
    agendouIa: agendouIaEm !== null,
    agendouIaEm,
    agendadoPara,
    spineIdSchedule,
    ultimaMsgEm: ordenadas.at(-1)?.createdAt ?? null,
  };
}

export type Desfecho =
  | 'em_conversa'
  | 'nao_agendou'
  | 'agendado_futuro'
  | 'compareceu'
  | 'faltou'
  | 'cancelou'
  | 'sem_registro';

export interface SinaisDesfecho {
  agendouIa: boolean;
  agendouKommo: boolean;
  /** idStatus da franquia (37 AGENDADO, 38 CONFIRMADO, 40 NÃO COMPARECEU, 41 REMARCADO, 42 ATENDIDO, 57 DESMARCADO) — null = sem consulta localizada. */
  statusFranquia: number | null;
  /** Consulta havia sido marcada na franquia mas sumiu do cadastro do paciente (cancelada/apagada). */
  consultaSumiu: boolean;
  situacaoKommo: string | null;
  dataConsulta: Date | null;
  ultimaMsgEm: Date | null;
  agora: Date;
}

const DIAS_SILENCIO_ENCERRA = 7;
const DIAS_TOLERANCIA_REGISTRO = 3;
const DIA_MS = 86_400_000;

/** Decide o desfecho e se ele é definitivo. Puro. */
export function classificarDesfecho(s: SinaisDesfecho): { desfecho: Desfecho; compareceu: boolean | null; final: boolean } {
  const { ATENDIDO, NAO_COMPARECEU, DESMARCADO } = SpineService.SPINE_STATUS;
  if (s.statusFranquia === ATENDIDO) return { desfecho: 'compareceu', compareceu: true, final: true };
  if (s.statusFranquia === NAO_COMPARECEU) return { desfecho: 'faltou', compareceu: false, final: true };
  if (s.statusFranquia === DESMARCADO || s.consultaSumiu) return { desfecho: 'cancelou', compareceu: null, final: true };

  const sit = (s.situacaoKommo ?? '').toLowerCase();
  if (/compareceu|atendid|realizad/.test(sit) && !/n[ãa]o/.test(sit)) return { desfecho: 'compareceu', compareceu: true, final: true };
  if (/n[ãa]o compareceu|faltou|falta/.test(sit)) return { desfecho: 'faltou', compareceu: false, final: true };
  if (/cancel|desmarc/.test(sit)) return { desfecho: 'cancelou', compareceu: null, final: true };

  const marcou = s.agendouIa || s.agendouKommo || s.statusFranquia !== null;
  if (marcou) {
    if (s.dataConsulta && s.dataConsulta.getTime() > s.agora.getTime()) return { desfecho: 'agendado_futuro', compareceu: null, final: false };
    if (s.dataConsulta && s.agora.getTime() - s.dataConsulta.getTime() > DIAS_TOLERANCIA_REGISTRO * DIA_MS) {
      // consulta passou e ninguém registrou o desfecho: vira definitivo depois de uma semana
      const final = s.agora.getTime() - s.dataConsulta.getTime() > 7 * DIA_MS;
      return { desfecho: 'sem_registro', compareceu: null, final };
    }
    return { desfecho: 'agendado_futuro', compareceu: null, final: false };
  }

  const silencio = s.ultimaMsgEm ? s.agora.getTime() - s.ultimaMsgEm.getTime() : 0;
  if (silencio > DIAS_SILENCIO_ENCERRA * DIA_MS) return { desfecho: 'nao_agendou', compareceu: null, final: true };
  return { desfecho: 'em_conversa', compareceu: null, final: false };
}

// ── leitura dos sistemas ────────────────────────────────────────────────────

const CAMPO_SITUACAO = '✓ Situação da consulta';
const CAMPO_DATA_CONSULTA = '◷ Data da Consulta';
const CAMPO_PG_ANTECIPADO = '✓ Consulta pg antecipado';

type CampoKommo = { field_id: number; values?: Array<{ value?: unknown }> };

function valorCampo(lead: unknown, fieldId: number | null): unknown {
  if (!fieldId) return null;
  const cfv = (lead as { custom_fields_values?: CampoKommo[] | null })?.custom_fields_values ?? [];
  return cfv.find((f) => f.field_id === fieldId)?.values?.[0]?.value ?? null;
}

function comoData(v: unknown): Date | null {
  if (typeof v === 'number' && v > 1_000_000_000) return new Date(v * 1000);
  if (typeof v === 'string' && /^\d{9,}$/.test(v)) return new Date(Number(v) * 1000);
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function comoSimNao(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  if (typeof v !== 'string' || !v) return null;
  if (/^sim$/i.test(v.trim())) return true;
  if (/^n[ãa]o$/i.test(v.trim())) return false;
  return null;
}

export async function calcularConversa(unit: Unit, conv: Conversation): Promise<void> {
  const leadId = Number(conv.leadId);
  if (!Number.isInteger(leadId) || leadId <= 0) return;

  const [msgs, steps, vinculo] = await Promise.all([
    prisma.message.findMany({ where: { conversationId: conv.id }, select: { role: true, content: true, createdAt: true } }),
    prisma.executionStep.findMany({
      where: { trace: { unitId: unit.id, leadId: String(leadId) }, kind: 'TOOL_RESULT' },
      select: { kind: true, title: true, payload: true, createdAt: true },
    }),
    prisma.spineLeadLink.findUnique({ where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId: leadId } } }),
  ]);
  const c = extrairComportamento(msgs, steps);

  // Kommo: etapa e campos da consulta
  let etapaKommo: string | null = null;
  let agendouKommo = false;
  let dataConsultaKommo: Date | null = null;
  let situacaoKommo: string | null = null;
  let pgAntecipado: boolean | null = null;
  if (unit.kommoAccessToken) {
    try {
      const kommo = createKommoClient(unit);
      const [etapa, esquema, lead] = await Promise.all([
        estadoEtapaDoLead(unit, leadId).catch(() => null),
        esquemaDaUnidade(unit, kommo),
        kommo.getLead(leadId),
      ]);
      etapaKommo = etapa?.nome ?? null;
      dataConsultaKommo = comoData(valorCampo(lead, esquema.campoPorNome(CAMPO_DATA_CONSULTA)));
      const sit = valorCampo(lead, esquema.campoPorNome(CAMPO_SITUACAO));
      situacaoKommo = typeof sit === 'string' ? sit : null;
      pgAntecipado = comoSimNao(valorCampo(lead, esquema.campoPorNome(CAMPO_PG_ANTECIPADO)));
      agendouKommo = !!etapa?.jaAgendadoOuPaciente || dataConsultaKommo !== null || !!situacaoKommo;
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'resultados: falha lendo o Kommo — segue com o que há');
    }
  }

  // Franquia: status da consulta marcada
  let statusFranquia: number | null = null;
  let consultaSumiu = false;
  const idSchedule = c.spineIdSchedule ?? vinculo?.spineIdSchedule ?? null;
  if (unit.spineEnabled && unit.spineToken && vinculo?.spineIdClient && idSchedule) {
    const r = await SpineService.getClient(unit, vinculo.spineIdClient);
    if (r.ok && r.data?.client) {
      const s = r.data.client.schedules.find((x) => x.idSchedule === idSchedule);
      if (s) statusFranquia = s.idStatus;
      else consultaSumiu = true;
    }
  }

  const dataConsulta =
    dataConsultaKommo ?? (c.agendadoPara ? new Date(`${c.agendadoPara}:00`) : null);
  const d = classificarDesfecho({
    agendouIa: c.agendouIa,
    agendouKommo,
    statusFranquia,
    consultaSumiu,
    situacaoKommo,
    dataConsulta,
    ultimaMsgEm: c.ultimaMsgEm,
    agora: new Date(),
  });

  const dados = {
    unitId: unit.id,
    kommoLeadId: leadId,
    inicioEm: conv.createdAt,
    ultimaMsgEm: c.ultimaMsgEm,
    msgsPaciente: c.msgsPaciente,
    msgsIa: c.msgsIa,
    primeiraRespostaSeg: c.primeiraRespostaSeg,
    consultasAgenda: c.consultasAgenda,
    horariosOferecidos: c.horariosOferecidos,
    precoNaMsg: c.precoNaMsg,
    followUps: conv.followUpStep,
    handoff: conv.handoffAt !== null,
    agendouIa: c.agendouIa,
    agendouIaEm: c.agendouIaEm,
    agendadoPara: c.agendadoPara ?? vinculo?.agendadoPara ?? null,
    spineIdSchedule: idSchedule,
    etapaKommo,
    agendouKommo,
    dataConsultaKommo,
    situacaoKommo,
    pgAntecipado,
    statusFranquia: statusFranquia !== null ? nomeStatus(statusFranquia) : consultaSumiu ? 'SUMIU' : null,
    compareceu: d.compareceu,
    desfecho: d.desfecho,
    final: d.final,
  };
  await prisma.conversationOutcome.upsert({
    where: { conversationId: conv.id },
    update: dados,
    create: { conversationId: conv.id, ...dados },
  });
}

function nomeStatus(id: number): string {
  const inv = Object.entries(SpineService.SPINE_STATUS).find(([, v]) => v === id);
  return inv ? inv[0] : String(id);
}

/**
 * Recalcula as conversas da unidade que ainda não têm desfecho definitivo.
 * `limite` protege o Kommo (≈7 req/s): 300 conversas ≈ 1–2 min por unidade.
 */
export async function calcularResultados(
  unit: Unit,
  opts: { dias?: number; limite?: number; apenasPendentes?: boolean } = {},
): Promise<{ calculadas: number; erros: number }> {
  const dias = opts.dias ?? 90;
  const limite = opts.limite ?? 300;
  const desde = new Date(Date.now() - dias * DIA_MS);
  const convs = await prisma.conversation.findMany({
    where: { unitId: unit.id, createdAt: { gte: desde } },
    orderBy: { createdAt: 'desc' },
  });
  const existentes = await prisma.conversationOutcome.findMany({
    where: { unitId: unit.id, conversationId: { in: convs.map((c) => c.id) } },
    select: { conversationId: true, final: true, calculadoEm: true },
  });
  const porConv = new Map(existentes.map((e) => [e.conversationId, e]));
  const fila = convs.filter((c) => {
    const e = porConv.get(c.id);
    if (!e) return true;
    if (e.final) return false;
    if (opts.apenasPendentes === false) return true;
    return Date.now() - e.calculadoEm.getTime() > 12 * 60 * 60_000;
  }).slice(0, limite);

  let calculadas = 0;
  let erros = 0;
  for (const conv of fila) {
    try {
      await calcularConversa(unit, conv);
      calculadas++;
    } catch (err) {
      erros++;
      logger.warn({ err: String(err), unit: unit.slug, conv: conv.id }, 'resultados: falha ao calcular conversa');
    }
  }
  return { calculadas, erros };
}

export interface ResumoResultados {
  dias: number;
  conversas: number;
  comPaciente: number;
  agendouIa: number;
  agendouKommo: number;
  agendouQualquer: number;
  compareceu: number;
  faltou: number;
  cancelou: number;
  agendadoFuturo: number;
  semRegistro: number;
  pendentes: number;
  pgAntecipadoSim: number;
  pgAntecipadoNao: number;
  taxaMarcacao: number | null;
  taxaComparecimento: number | null;
  mediaHorariosOferecidosQuemMarcou: number | null;
  mediaHorariosOferecidosQuemNao: number | null;
  mediaFollowUpsQuemMarcou: number | null;
  mediaFollowUpsQuemNao: number | null;
}

export async function resumoResultados(unitId: string, dias: number): Promise<ResumoResultados> {
  const desde = new Date(Date.now() - dias * DIA_MS);
  const rows = await prisma.conversationOutcome.findMany({ where: { unitId, inicioEm: { gte: desde } } });
  const comPaciente = rows.filter((r) => r.msgsPaciente > 0);
  const marcou = comPaciente.filter((r) => r.agendouIa || r.agendouKommo);
  const nao = comPaciente.filter((r) => !(r.agendouIa || r.agendouKommo));
  const media = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const compareceu = rows.filter((r) => r.desfecho === 'compareceu').length;
  const faltou = rows.filter((r) => r.desfecho === 'faltou').length;
  return {
    dias,
    conversas: rows.length,
    comPaciente: comPaciente.length,
    agendouIa: rows.filter((r) => r.agendouIa).length,
    agendouKommo: rows.filter((r) => r.agendouKommo).length,
    agendouQualquer: marcou.length,
    compareceu,
    faltou,
    cancelou: rows.filter((r) => r.desfecho === 'cancelou').length,
    agendadoFuturo: rows.filter((r) => r.desfecho === 'agendado_futuro').length,
    semRegistro: rows.filter((r) => r.desfecho === 'sem_registro').length,
    pendentes: rows.filter((r) => r.desfecho === 'em_conversa').length,
    pgAntecipadoSim: rows.filter((r) => r.pgAntecipado === true).length,
    pgAntecipadoNao: rows.filter((r) => r.pgAntecipado === false).length,
    taxaMarcacao: comPaciente.length ? Math.round((marcou.length / comPaciente.length) * 1000) / 10 : null,
    taxaComparecimento: compareceu + faltou ? Math.round((compareceu / (compareceu + faltou)) * 1000) / 10 : null,
    mediaHorariosOferecidosQuemMarcou: media(marcou.map((r) => r.horariosOferecidos)),
    mediaHorariosOferecidosQuemNao: media(nao.map((r) => r.horariosOferecidos)),
    mediaFollowUpsQuemMarcou: media(marcou.map((r) => r.followUps)),
    mediaFollowUpsQuemNao: media(nao.map((r) => r.followUps)),
  };
}
