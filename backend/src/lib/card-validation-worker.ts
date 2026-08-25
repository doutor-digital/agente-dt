import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';

const SWEEP_MS = 5 * 60_000;
const LOOKBACK_MIN = 12;
const CTX_TTL_MS = 30 * 60_000;

let timer: NodeJS.Timeout | null = null;
let rodando = false;

export const NOMES_CAMPO = {
  AGENDOU: '✓ Agendou',
  TIPO_AGENDAMENTO: '⬢ Tipo de agendamento',
  SITUACAO_CONSULTA: '✓ Situação da consulta',
  FECHOU_TRAT: '✓ Fechou tratamento',
  TRAT_FECHADO: '⚕ Tratamento fechado',
  FORMA_PAGAMENTO: '⬢ Forma de pagamento',
  MOTIVO_NAO_AGEND: '⊘ Motivo do não agendamento',
  MOTIVO_NAO_FECH: '⊘ Motivo de não fechamento do tratamento',
  COMPARECEU_ULT: '✓ Compareceu à última sessão marcada',
  PG_ANTECIPADO: '✓ Consulta pg antecipado',
  DATA_CANCEL: '◷ Data do cancelamento',
  MOTIVO_CANCEL_TRAT: '⊘ Motivo do cancelamento do tratamento',
  AGENDADO_SDR_EM: '◷ Agendado pela SDR em',
  DATA_CONSULTA: '◷ Data da Consulta',
} as const;

export type ChaveCampo = keyof typeof NOMES_CAMPO;

export interface ContextoUnidade {
  campos: Record<ChaveCampo, number[]>;
  pipeComercial: number | null;
  pipeTratamento: number | null;
  stAgendado: number | null;
}

const GANHO = 142;
const PERDIDO = 143;

const cache = new Map<string, { ctx: ContextoUnidade; expiraEm: number }>();

function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

export function montarContexto(
  campos: Array<{ id: number; name: string }>,
  pipelines: Array<{ id: number; name: string; statuses: Array<{ id: number; name: string }> }>,
): ContextoUnidade {
  const porNome = new Map<string, number[]>();
  for (const c of campos) {
    const k = normalizar(c.name);
    porNome.set(k, [...(porNome.get(k) ?? []), c.id]);
  }
  const resolvido = {} as Record<ChaveCampo, number[]>;
  for (const [chave, nome] of Object.entries(NOMES_CAMPO) as Array<[ChaveCampo, string]>) {
    resolvido[chave] = porNome.get(normalizar(nome)) ?? [];
  }

  const acharPipe = (nome: string) =>
    pipelines.find((p) => normalizar(p.name) === normalizar(nome))?.id ?? null;
  const comercial = pipelines.find((p) => normalizar(p.name) === normalizar('COMERCIAL'));
  const stAgendado =
    comercial?.statuses.find((s) => normalizar(s.name) === normalizar('AGENDADO'))?.id ?? null;

  return {
    campos: resolvido,
    pipeComercial: acharPipe('COMERCIAL'),
    pipeTratamento: acharPipe('TRATAMENTO'),
    stAgendado,
  };
}

async function contextoDaUnidade(unit: Unit, kommo: KommoClient): Promise<ContextoUnidade> {
  const guardado = cache.get(unit.id);
  if (guardado && guardado.expiraEm > Date.now()) return guardado.ctx;

  const [brutoCampos, pipelines] = await Promise.all([
    kommo.listLeadCustomFields(),
    kommo.listPipelines(),
  ]);
  const campos =
    (brutoCampos as { _embedded?: { custom_fields?: Array<{ id: number; name: string }> } })?._embedded
      ?.custom_fields ?? [];
  const ctx = montarContexto(
    campos,
    pipelines.map((p) => ({ id: p.id, name: p.name, statuses: p.statuses ?? [] })),
  );
  cache.set(unit.id, { ctx, expiraEm: Date.now() + CTX_TTL_MS });
  return ctx;
}

function vals(lead: KommoLead, ids: number[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const cf = (lead.custom_fields_values ?? []).find((f) => f.field_id === id);
    for (const v of cf?.values ?? []) {
      const s = String((v as { value?: unknown }).value ?? '').trim();
      if (s) out.push(s);
    }
  }
  return out;
}

export interface Leitor {
  vazio: (c: ChaveCampo) => boolean;
  igual: (c: ChaveCampo, v: string) => boolean;
  data: (c: ChaveCampo) => number | null;
}

function leitor(lead: KommoLead, ctx: ContextoUnidade): Leitor {
  const ler = (c: ChaveCampo) => vals(lead, ctx.campos[c]);
  return {
    vazio: (c) => ler(c).length === 0,
    igual: (c, v) => ler(c).some((x) => x.toLowerCase() === v.toLowerCase()),
    data: (c) => {
      const bruto = ler(c)[0];
      if (!bruto) return null;
      const n = Number(bruto);
      return Number.isFinite(n) && n > 0 ? n : null;
    },
  };
}

export interface Regra {
  key: string;
  aplica: (l: KommoLead, ctx: ContextoUnidade) => boolean;
  erro: (r: Leitor, l: KommoLead) => string | null;
}

const emComercial = (l: KommoLead, ctx: ContextoUnidade, status: number | null) =>
  ctx.pipeComercial !== null && l.pipeline_id === ctx.pipeComercial && l.status_id === status;

export const REGRAS_CARD: Regra[] = [
  {
    key: 'A_agendado_incompleto',
    aplica: (l, ctx) => emComercial(l, ctx, ctx.stAgendado),
    erro: (r) => {
      const p: string[] = [];
      if (r.igual('AGENDOU', 'Não')) p.push('"✓ Agendou" = Não');
      if (r.vazio('TIPO_AGENDAMENTO')) p.push('"Tipo de agendamento" vazio');
      if (r.vazio('SITUACAO_CONSULTA')) p.push('"Situação da consulta" vazia');
      return p.length ? 'está em AGENDADO mas ' + p.join('; ') : null;
    },
  },
  {
    key: 'A2_data_agendamento_invalida',
    aplica: (l, ctx) => emComercial(l, ctx, ctx.stAgendado),
    erro: (r) => {
      const agendadoEm = r.data('AGENDADO_SDR_EM');
      if (agendadoEm === null) {
        return 'está em AGENDADO mas "◷ Agendado pela SDR em" está vazio — o agendamento não entra no relatório do dia';
      }
      const consulta = r.data('DATA_CONSULTA');
      const agora = Math.floor(Date.now() / 1000);
      if (agendadoEm > agora + 86_400) {
        return 'está em AGENDADO mas "◷ Agendado pela SDR em" tem data FUTURA — esse campo é quando a SDR agendou, não a data da consulta';
      }
      if (consulta !== null && agendadoEm === consulta) {
        return 'está em AGENDADO mas "◷ Agendado pela SDR em" está igual à "◷ Data da Consulta" — o primeiro é quando agendou, o segundo é quando o paciente vem';
      }
      return null;
    },
  },
  {
    key: 'B_ganho_sem_fechamento',
    aplica: (l, ctx) => emComercial(l, ctx, GANHO),
    erro: (r) => {
      const p: string[] = [];
      if (!r.igual('FECHOU_TRAT', 'Sim')) p.push('"Fechou tratamento" não está Sim');
      if (r.vazio('TRAT_FECHADO')) p.push('"Tratamento fechado" vazio');
      if (r.vazio('FORMA_PAGAMENTO')) p.push('"Forma de pagamento" vazia');
      return p.length ? 'está em GANHO mas ' + p.join('; ') : null;
    },
  },
  {
    key: 'C_perdido_sem_motivo',
    aplica: (l, ctx) => emComercial(l, ctx, PERDIDO),
    erro: (r, l) =>
      !l.loss_reason_id && r.vazio('MOTIVO_NAO_AGEND') && r.vazio('MOTIVO_NAO_FECH')
        ? 'está em PERDIDO sem motivo nenhum — nem o do Kommo, nem "Motivo do não agendamento", nem "Motivo de não fechamento"'
        : null,
  },
  {
    key: 'D_noshow_pago',
    aplica: () => true,
    erro: (r) =>
      r.igual('COMPARECEU_ULT', 'Não') && r.igual('PG_ANTECIPADO', 'Sim')
        ? '"Compareceu à última sessão" = Não mas "Consulta pg antecipado" = Sim (no-show pago)'
        : null,
  },
  {
    key: 'F_cancelado_sem_dados',
    aplica: (l, ctx) =>
      ctx.pipeTratamento !== null && l.pipeline_id === ctx.pipeTratamento && l.status_id === PERDIDO,
    erro: (r) => {
      const p: string[] = [];
      if (r.vazio('DATA_CANCEL')) p.push('"Data do cancelamento" vazia');
      if (r.vazio('MOTIVO_CANCEL_TRAT')) p.push('"Motivo do cancelamento" vazio');
      return p.length ? 'está em TRATAMENTO CANCELADO mas ' + p.join('; ') : null;
    },
  },
];

export function avaliarLead(lead: KommoLead, ctx: ContextoUnidade): Array<{ key: string; erro: string }> {
  const r = leitor(lead, ctx);
  const out: Array<{ key: string; erro: string }> = [];
  for (const regra of REGRAS_CARD) {
    if (!regra.aplica(lead, ctx)) continue;
    const erro = regra.erro(r, lead);
    if (erro) out.push({ key: regra.key, erro });
  }
  return out;
}

async function validarUnidade(unit: Unit): Promise<void> {
  const desde = Math.floor((Date.now() - LOOKBACK_MIN * 60_000) / 1000);
  const kommo = createKommoClient(unit);
  const ctx = await contextoDaUnidade(unit, kommo);
  if (ctx.pipeComercial === null || ctx.stAgendado === null) {
    logger.warn({ unit: unit.slug }, 'card-validation: funil COMERCIAL/AGENDADO não resolvido, pulando');
    return;
  }

  const leads = await kommo.listLeadsAtualizadosComCampos(desde, 250);
  if (leads.length === 0) return;

  const existentes = await prisma.cardAlert.findMany({
    where: { unitId: unit.id },
    select: { leadId: true, ruleKey: true },
  });
  const jaAlertado = new Set(existentes.map((e) => `${e.leadId}|${e.ruleKey}`));

  for (const lead of leads) {
    const leadIdStr = String(lead.id);
    const achados = new Map(avaliarLead(lead, ctx).map((a) => [a.key, a.erro]));

    for (const regra of REGRAS_CARD) {
      if (!regra.aplica(lead, ctx)) continue;
      const chave = `${leadIdStr}|${regra.key}`;
      const erro = achados.get(regra.key);

      if (!erro) {
        if (jaAlertado.has(chave)) {
          await prisma.cardAlert
            .deleteMany({ where: { unitId: unit.id, leadId: leadIdStr, ruleKey: regra.key } })
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
            data: { unitId: unit.id, leadId: leadIdStr, ruleKey: regra.key },
          });
          jaAlertado.add(chave);
          logger.info({ unit: unit.slug, leadId: lead.id, rule: regra.key }, 'card-validation: alerta criado');
        }
      } catch (err) {
        logger.warn(
          { err: String(err), unit: unit.slug, leadId: lead.id, rule: regra.key },
          'card-validation: falha ao criar alerta',
        );
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
  const ctx = await contextoDaUnidade(unit, kommo);
  if (ctx.pipeComercial === null || ctx.stAgendado === null) {
    logger.warn({ unit: unit.slug }, 'card-validation: funil não resolvido, baseline abortado');
    return { leads: 0, erros: 0 };
  }
  const leads = await kommo.listLeads(120);
  const rows: Array<{ unitId: string; leadId: string; ruleKey: string }> = [];
  for (const lead of leads) {
    for (const a of avaliarLead(lead, ctx)) {
      rows.push({ unitId: unit.id, leadId: String(lead.id), ruleKey: a.key });
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
