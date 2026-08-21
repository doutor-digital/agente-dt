import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import type { KommoLead } from '../services/kommo.service.js';

const SWEEP_MS = 5 * 60_000;
const LOOKBACK_MIN = 12;

let timer: NodeJS.Timeout | null = null;
let rodando = false;

const PIPE_COMERCIAL = 14091100;
const PIPE_TRATAMENTO = 14091116;
const ST = {
  AGENDADO: 108773008,
  GANHO: 142,
  PERDIDO: 143,
  EM_TRAT: 108773168,
  CANCELADO: 143,
} as const;

const F = {
  AGENDOU: 2442703,
  TIPO_AGENDAMENTO: 2443059,
  SITUACAO_CONSULTA: 2444779,
  FECHOU_TRAT: 2440941,
  TRAT_FECHADO: 2440849,
  FORMA_PAG_1: 2442715,
  FORMA_PAG_2: 2442951,
  MOTIVO_NAO_AGEND: 2440819,
  MOTIVO_NAO_FECH: 2440919,
  COMPARECEU_ULT: 2440987,
  PG_ANTECIPADO: 2440921,
  SESSOES_PREV: 2442731,
  DATA_CANCEL: 2440985,
  MOTIVO_CANCEL_TRAT: 2442739,
} as const;

function vals(lead: KommoLead, fid: number): string[] {
  const cf = (lead.custom_fields_values ?? []).find((f) => f.field_id === fid);
  return (cf?.values ?? [])
    .map((v) => String((v as { value?: unknown }).value ?? '').trim())
    .filter(Boolean);
}
const vazio = (lead: KommoLead, fid: number): boolean => vals(lead, fid).length === 0;
const igual = (lead: KommoLead, fid: number, v: string): boolean =>
  vals(lead, fid).some((x) => x.toLowerCase() === v.toLowerCase());

interface Regra {
  key: string;
  aplica: (l: KommoLead) => boolean;
  erro: (l: KommoLead) => string | null;
}

const REGRAS: Regra[] = [
  {
    key: 'A_agendado_incompleto',
    aplica: (l) => l.pipeline_id === PIPE_COMERCIAL && l.status_id === ST.AGENDADO,
    erro: (l) => {
      const p: string[] = [];
      if (igual(l, F.AGENDOU, 'Não')) p.push('"✓ Agendou" = Não');
      if (vazio(l, F.TIPO_AGENDAMENTO)) p.push('"Tipo de agendamento" vazio');
      if (vazio(l, F.SITUACAO_CONSULTA)) p.push('"Situação da consulta" vazia');
      return p.length ? 'está em AGENDADO mas ' + p.join('; ') : null;
    },
  },
  {
    key: 'B_ganho_sem_fechamento',
    aplica: (l) => l.pipeline_id === PIPE_COMERCIAL && l.status_id === ST.GANHO,
    erro: (l) => {
      const p: string[] = [];
      if (!igual(l, F.FECHOU_TRAT, 'Sim')) p.push('"Fechou tratamento" não está Sim');
      if (vazio(l, F.TRAT_FECHADO)) p.push('"Tratamento fechado" vazio');
      if (vazio(l, F.FORMA_PAG_1) && vazio(l, F.FORMA_PAG_2)) p.push('"Forma de pagamento" vazia');
      return p.length ? 'está em GANHO mas ' + p.join('; ') : null;
    },
  },
  {
    key: 'C_perdido_sem_motivo',
    aplica: (l) => l.pipeline_id === PIPE_COMERCIAL && l.status_id === ST.PERDIDO,
    erro: (l) =>
      vazio(l, F.MOTIVO_NAO_AGEND) && vazio(l, F.MOTIVO_NAO_FECH)
        ? 'está em PERDIDO sem "Motivo do não agendamento" nem "Motivo de não fechamento"'
        : null,
  },
  {
    key: 'D_noshow_pago',
    aplica: () => true,
    erro: (l) =>
      igual(l, F.COMPARECEU_ULT, 'Não') && igual(l, F.PG_ANTECIPADO, 'Sim')
        ? '"Compareceu à última sessão" = Não mas "Consulta pg antecipado" = Sim (no-show pago)'
        : null,
  },
  {
    key: 'F_cancelado_sem_dados',
    aplica: (l) => l.pipeline_id === PIPE_TRATAMENTO && l.status_id === ST.CANCELADO,
    erro: (l) => {
      const p: string[] = [];
      if (vazio(l, F.DATA_CANCEL)) p.push('"Data do cancelamento" vazia');
      if (vazio(l, F.MOTIVO_CANCEL_TRAT)) p.push('"Motivo do cancelamento" vazio');
      return p.length ? 'está em TRATAMENTO CANCELADO mas ' + p.join('; ') : null;
    },
  },
];

async function validarUnidade(unit: Unit): Promise<void> {
  const desde = Math.floor((Date.now() - LOOKBACK_MIN * 60_000) / 1000);
  const kommo = createKommoClient(unit);
  const leads = await kommo.listLeadsAtualizadosComCampos(desde, 250);
  if (leads.length === 0) return;

  const existentes = await prisma.cardAlert.findMany({
    where: { unitId: unit.id },
    select: { leadId: true, ruleKey: true },
  });
  const jaAlertado = new Set(existentes.map((e) => `${e.leadId}|${e.ruleKey}`));

  for (const lead of leads) {
    const leadIdStr = String(lead.id);
    for (const r of REGRAS) {
      if (!r.aplica(lead)) continue;
      const chave = `${leadIdStr}|${r.key}`;
      const erro = r.erro(lead);

      if (!erro) {
        if (jaAlertado.has(chave)) {
          await prisma.cardAlert
            .deleteMany({ where: { unitId: unit.id, leadId: leadIdStr, ruleKey: r.key } })
            .catch(() => undefined);
          jaAlertado.delete(chave);
        }
        continue;
      }

      if (jaAlertado.has(chave)) continue;

      const nome = (lead.name ?? '').trim() || 'lead';
      const texto = `ALERTA · ${unit.slug} · [Contato: ${nome}] ⚠️ Card ${erro}. Revisar preenchimento no Kommo.`;
      try {
        const res = await kommo.createTask({
          leadId: lead.id,
          text: texto,
          completeAt: Math.floor(Date.now() / 1000),
        });
        if (res) {
          await prisma.cardAlert.create({
            data: { unitId: unit.id, leadId: leadIdStr, ruleKey: r.key },
          });
          jaAlertado.add(chave);
          logger.info({ unit: unit.slug, leadId: lead.id, rule: r.key }, 'card-validation: alerta criado');
        }
      } catch (err) {
        logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id, rule: r.key }, 'card-validation: falha ao criar alerta');
      }
    }
  }
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const unidades = await prisma.unit.findMany({ where: { cardValidationEnabled: true } });
    for (const unit of unidades) {
      await validarUnidade(unit).catch((err) =>
        logger.warn({ err: String(err), unit: unit.slug }, 'card-validation: unidade falhou'),
      );
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'card-validation: varredura falhou');
  } finally {
    rodando = false;
  }
}

export async function seedBaselineUnit(unit: Unit): Promise<{ leads: number; erros: number }> {
  const kommo = createKommoClient(unit);
  const leads = await kommo.listLeads(120);
  const rows: Array<{ unitId: string; leadId: string; ruleKey: string }> = [];
  for (const lead of leads) {
    for (const r of REGRAS) {
      if (r.aplica(lead) && r.erro(lead)) {
        rows.push({ unitId: unit.id, leadId: String(lead.id), ruleKey: r.key });
      }
    }
  }
  if (rows.length) {
    await prisma.cardAlert.createMany({ data: rows, skipDuplicates: true });
  }
  logger.info({ unit: unit.slug, leads: leads.length, erros: rows.length }, 'card-validation: baseline semeado');
  return { leads: leads.length, erros: rows.length };
}

export function startCardValidationWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info('card-validation: worker iniciado (guardado por cardValidationEnabled)');
}

export function stopCardValidationWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
