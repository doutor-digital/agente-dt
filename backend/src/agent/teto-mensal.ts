/**
 * Teto MENSAL de gasto com IA, por conta Kommo (= clínica).
 *
 * Decisão da chefe (21/09/2026, via João): a IA não pode custar mais de R$ 300 por clínica por
 * mês. O teto por CONVERSA (`teto-conversa.ts`) pega o caso patológico de uma conversa só; este
 * pega o mês inteiro — e é a régua que a chefe olha.
 *
 * O QUE É "CLÍNICA": a conta Kommo (`units.kommo_subdomain`). Uma clínica tem de 1 a 4 unidades
 * no agente (Sofia, resgate, financeiro…), todas na mesma conta — o gasto soma todas.
 *
 * O QUE ACONTECE
 *  - 80 % do teto: aviso no canal de operação, uma vez por mês por conta. Nada muda no atendimento.
 *  - 100 %: aviso de novo e, SE `TETO_MENSAL_ACAO=pausar`, a IA para de responder nessa conta até
 *    o dia 1º: o paciente recebe a mensagem de "uma pessoa continua", o cartão ganha nota e a IA
 *    fica pausada no lead. O padrão é `avisar`: pausar sem ninguém olhando derruba lead de
 *    R$ 3.500 pra economizar R$ 50 — cortar de fato é decisão da chefe, e ela vira por env.
 *
 * DE ONDE VEM O NÚMERO: `llm_calls.cost_usd` (o que medimos, já com desconto de cache) vezes
 * `CAMBIO_BRL_POR_USD`. A soma fica em cache 5 min por conta: tolerância de ~R$ 1 na borda em troca
 * de não pesar o banco a cada turno. Falha de banco NUNCA trava o atendimento — devolve "ok".
 */
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { opsAlert } from '../lib/ops-alert.js';
import { avisoRecente, marcarAviso } from '../lib/aviso-dedupe.js';
import { fusoDaUnidade } from '../lib/fuso.js';

/** Teto por conta Kommo por mês, em reais. */
export const TETO_MENSAL_BRL = Number(process.env.TETO_MENSAL_BRL) || 300;
/** Câmbio usado pra converter o custo medido (US$) em reais. */
export const CAMBIO_BRL_POR_USD = Number(process.env.CAMBIO_BRL_POR_USD) || 5.1;
/** Fração do teto a partir da qual já avisa. */
export const FRACAO_DE_AVISO = 0.8;
const CACHE_MS = Number(process.env.TETO_MENSAL_CACHE_MS) || 5 * 60_000;
/** Um aviso por tipo por conta por mês: a marca vive 40 dias, mais que qualquer mês. */
const JANELA_DEDUPE_MS = 40 * 24 * 60 * 60_000;

export type AcaoTeto = 'avisar' | 'pausar';
export type NivelTeto = 'ok' | 'aviso' | 'estourou';

/** `TETO_MENSAL_ACAO`: `pausar` corta a IA ao estourar; qualquer outra coisa só avisa. */
export function acaoAoEstourar(raw: string | undefined = process.env.TETO_MENSAL_ACAO): AcaoTeto {
  return (raw ?? '').trim().toLowerCase() === 'pausar' ? 'pausar' : 'avisar';
}

/** `TETO_MENSAL_SLUGS`: csv de slugs ou `*` (padrão: todas). */
export function tetoHabilitado(slug: string, raw: string | undefined = process.env.TETO_MENSAL_SLUGS): boolean {
  const lista = (raw ?? '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return lista.includes('*') || lista.includes(slug);
}

export function avaliarNivel(brl: number, teto = TETO_MENSAL_BRL, fracaoAviso = FRACAO_DE_AVISO): NivelTeto {
  if (!(teto > 0) || !Number.isFinite(brl)) return 'ok';
  if (brl >= teto) return 'estourou';
  if (brl >= teto * fracaoAviso) return 'aviso';
  return 'ok';
}

/** A conta Kommo é a clínica; sem subdomínio, a unidade responde sozinha. */
export function contaDaUnidade(unit: Pick<Unit, 'id' | 'kommoSubdomain'>): string {
  const sub = unit.kommoSubdomain?.trim();
  return sub ? sub : `unidade:${unit.id}`;
}

function partesNoFuso(d: Date, tz: string): { ano: number; mes: number; dia: number; hora: number; min: number; seg: number } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d);
  const n = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value ?? '0');
  return { ano: n('year'), mes: n('month'), dia: n('day'), hora: n('hour'), min: n('minute'), seg: n('second') };
}

/** Diferença (min) entre o relógio do fuso e o UTC naquele instante. São Paulo: -180. */
export function offsetMinutos(d: Date, tz: string): number {
  const p = partesNoFuso(d, tz);
  const comoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.min, p.seg);
  return Math.round((comoUtc - d.getTime()) / 60_000);
}

/** Meia-noite do dia 1º do mês corrente NO FUSO da clínica, como instante UTC. */
export function inicioDoMes(agora: Date, tz: string): Date {
  const p = partesNoFuso(agora, tz);
  const candidato = new Date(Date.UTC(p.ano, p.mes - 1, 1, 0, 0, 0));
  return new Date(candidato.getTime() - offsetMinutos(candidato, tz) * 60_000);
}

/** "2026-09" — o mês corrente no fuso da clínica. */
export function rotuloDoMes(agora: Date, tz: string): string {
  const p = partesNoFuso(agora, tz);
  return `${p.ano}-${String(p.mes).padStart(2, '0')}`;
}

export interface VereditoMensal {
  conta: string;
  mes: string;
  brl: number;
  teto: number;
  /** brl / teto — 1.0 é o teto. */
  fracao: number;
  nivel: NivelTeto;
}

const cache = new Map<string, { brl: number; mes: string; em: number }>();
const avisadosEmMemoria = new Set<string>();

async function somarGastoUsd(unit: Pick<Unit, 'id' | 'kommoSubdomain'>, inicio: Date): Promise<number> {
  const sub = unit.kommoSubdomain?.trim();
  const rows = sub
    ? await prisma.$queryRaw<{ usd: unknown }[]>`
        select coalesce(sum(l.cost_usd), 0) as usd
        from llm_calls l join units u on u.id = l.unit_id
        where u.kommo_subdomain = ${sub} and l.created_at >= ${inicio}`
    : await prisma.$queryRaw<{ usd: unknown }[]>`
        select coalesce(sum(cost_usd), 0) as usd
        from llm_calls where unit_id = ${unit.id} and created_at >= ${inicio}`;
  const usd = Number(rows[0]?.usd ?? 0);
  return Number.isFinite(usd) ? usd : 0;
}

/** Gasto do mês corrente da conta, em reais (cache de 5 min por conta). */
export async function gastoDoMesBrl(
  unit: Pick<Unit, 'id' | 'kommoSubdomain' | 'businessHoursTimezone' | 'spineTimezone'>,
  agora: Date = new Date(),
): Promise<{ conta: string; mes: string; brl: number }> {
  const conta = contaDaUnidade(unit);
  const tz = fusoDaUnidade(unit);
  const mes = rotuloDoMes(agora, tz);
  const c = cache.get(conta);
  if (c && c.mes === mes && agora.getTime() - c.em < CACHE_MS) return { conta, mes, brl: c.brl };
  const usd = await somarGastoUsd(unit, inicioDoMes(agora, tz));
  const brl = usd * CAMBIO_BRL_POR_USD;
  cache.set(conta, { brl, mes, em: agora.getTime() });
  return { conta, mes, brl };
}

/**
 * Onde a conta está no mês. Chamado ANTES de gastar de novo. Dispara o aviso (80 % / 100 %) por
 * conta própria, uma vez por mês; quem chama decide se bloqueia (`acaoAoEstourar() === 'pausar'`).
 */
export async function conferirTetoMensal(unit: Unit, agora: Date = new Date()): Promise<VereditoMensal> {
  const base = { conta: contaDaUnidade(unit), mes: rotuloDoMes(agora, fusoDaUnidade(unit)), teto: TETO_MENSAL_BRL };
  if (!tetoHabilitado(unit.slug)) return { ...base, brl: 0, fracao: 0, nivel: 'ok' };
  let brl: number;
  try {
    brl = (await gastoDoMesBrl(unit, agora)).brl;
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'teto mensal: falha ao somar o gasto — atendimento segue');
    return { ...base, brl: 0, fracao: 0, nivel: 'ok' };
  }
  const v: VereditoMensal = {
    ...base,
    brl,
    fracao: TETO_MENSAL_BRL > 0 ? brl / TETO_MENSAL_BRL : 0,
    nivel: avaliarNivel(brl),
  };
  if (v.nivel !== 'ok') void avisar(unit, v);
  return v;
}

export function formatarBrl(v: number): string {
  return `R$ ${Math.round(v).toLocaleString('pt-BR')}`;
}

export function textoDoAviso(v: VereditoMensal, acao: AcaoTeto): { title: string; message: string } {
  const brl = formatarBrl(v.brl);
  const teto = formatarBrl(v.teto);
  if (v.nivel === 'estourou') {
    return {
      title: `🛑 IA em ${v.conta} passou do teto do mês: ${brl} de ${teto}`,
      message:
        acao === 'pausar'
          ? 'A IA parou de responder nesta conta até o dia 1º; a equipe assume pelo Kommo (cada lead que ' +
            'escrever ganha nota no cartão e fica pausado). Pra liberar: TETO_MENSAL_ACAO=avisar ou subir TETO_MENSAL_BRL.'
          : 'A IA continua respondendo (TETO_MENSAL_ACAO=avisar). Pra cortar de fato ao bater o teto: TETO_MENSAL_ACAO=pausar.',
    };
  }
  const pct = Math.round(v.fracao * 100);
  return {
    title: `💸 IA em ${v.conta}: ${brl} de ${teto} do mês (${pct} %)`,
    message:
      'Neste ritmo passa do teto antes do fim do mês. Nada muda no atendimento por enquanto; ao chegar em 100 % ' +
      (acao === 'pausar' ? 'a IA pausa nesta conta.' : 'só avisa de novo.'),
  };
}

async function avisar(unit: Unit, v: VereditoMensal): Promise<void> {
  const chave = v.nivel === 'estourou' ? 'teto_mensal_100' : 'teto_mensal_80';
  const marca = `${v.conta}:${v.mes}:${chave}`;
  if (avisadosEmMemoria.has(marca)) return;
  // Persistente (sobrevive a deploy) — reaproveita card_alert como o resto dos avisos. A conta pode
  // ter 2-4 unidades: em memória a marca é por conta; no banco, por unidade (no pior caso um aviso
  // repetido depois de um reinício).
  const leadKey = `mes:${v.mes}`;
  if (await avisoRecente(unit.id, leadKey, chave, JANELA_DEDUPE_MS)) {
    avisadosEmMemoria.add(marca);
    return;
  }
  const texto = textoDoAviso(v, acaoAoEstourar());
  opsAlert({ chave: marca, ...texto });
  logger.warn({ unit: unit.slug, conta: v.conta, mes: v.mes, brl: Number(v.brl.toFixed(2)), teto: v.teto }, texto.title);
  avisadosEmMemoria.add(marca);
  await marcarAviso(unit.id, leadKey, chave);
}

export function _resetarTetoMensal(): void {
  cache.clear();
  avisadosEmMemoria.clear();
}
