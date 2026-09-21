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
 *  - 100 %: aviso de novo e, SE `TETO_MENSAL_ACAO=pausar`, a CONTA inteira entra em pausa até o
 *    dia 1º — a mesma pausa que a recepção liga pela página /pausa, então webhook, régua,
 *    reativação e lembrete já a respeitam sem código novo. O paciente do turno em que estourou
 *    recebe "uma pessoa continua" e o cartão ganha nota; os próximos nem chegam ao agente.
 *    O padrão é `avisar`: pausar sem ninguém olhando derruba lead de R$ 3.500 pra economizar
 *    R$ 50 — cortar de fato é decisão da chefe, e ela vira por env.
 *
 * DE ONDE VEM O NÚMERO: `llm_calls.cost_usd` (o que medimos, já com desconto de cache) vezes o
 * mesmo câmbio do painel (`USD_BRL`). A soma fica em cache 5 min por conta: tolerância de ~R$ 1
 * na borda em troca de não pesar o banco a cada turno. Falha de banco NUNCA trava o atendimento.
 */
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { opsAlert } from '../lib/ops-alert.js';
import { avisoRecente, marcarAviso } from '../lib/aviso-dedupe.js';
import { fusoDaUnidade, inicioDoMesNoFuso, inicioDoProximoMesNoFuso, mesNoFuso } from '../lib/fuso.js';

/** Teto por conta Kommo por mês, em reais. */
export const TETO_MENSAL_BRL = Number(process.env.TETO_MENSAL_BRL) || 300;
/** O MESMO câmbio do painel (units.controller): alerta e tela têm de mostrar o mesmo número. */
export const USD_BRL = Number(process.env.USD_BRL ?? 5.4) || 5.4;
/** Fração do teto a partir da qual já avisa. */
export const FRACAO_DE_AVISO = 0.8;
const CACHE_MS = Number(process.env.TETO_MENSAL_CACHE_MS) || 5 * 60_000;
/** Um aviso por tipo por conta por mês: a marca vive 40 dias, mais que qualquer mês. */
const JANELA_DEDUPE_MS = 40 * 24 * 60 * 60_000;
export const PAUSA_POR = 'teto mensal';

export type AcaoTeto = 'avisar' | 'pausar';
export type NivelTeto = 'ok' | 'aviso' | 'estourou';

/** `TETO_MENSAL_ACAO`: `pausar` corta a IA ao estourar; qualquer outra coisa só avisa. */
export function acaoAoEstourar(raw: string | undefined = process.env.TETO_MENSAL_ACAO): AcaoTeto {
  return (raw ?? '').trim().toLowerCase() === 'pausar' ? 'pausar' : 'avisar';
}

/** `TETO_MENSAL_SLUGS`: csv de slugs ou `*`. Ausente OU em branco = todas (linha vazia no env não desliga a régua). */
export function tetoHabilitado(slug: string, raw: string | undefined = process.env.TETO_MENSAL_SLUGS): boolean {
  const texto = (raw ?? '').trim();
  if (!texto) return true;
  const lista = texto
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

/** A conta Kommo é a clínica (normalizada: minúsculas, sem espaço); sem subdomínio, a unidade responde sozinha. */
export function contaDaUnidade(unit: Pick<Unit, 'id' | 'kommoSubdomain'>): string {
  const sub = unit.kommoSubdomain?.trim().toLowerCase();
  return sub ? sub : `unidade:${unit.id}`;
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

function subdominio(unit: Pick<Unit, 'kommoSubdomain'>): string | null {
  const sub = unit.kommoSubdomain?.trim().toLowerCase();
  return sub || null;
}

async function somarGastoUsd(unit: Pick<Unit, 'id' | 'kommoSubdomain'>, inicio: Date): Promise<number> {
  const sub = subdominio(unit);
  const rows = sub
    ? await prisma.$queryRaw<{ usd: unknown }[]>`
        select coalesce(sum(l.cost_usd), 0) as usd
        from llm_calls l join units u on u.id = l.unit_id
        where lower(trim(u.kommo_subdomain)) = ${sub} and l.created_at >= ${inicio}`
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
  const mes = mesNoFuso(agora, tz);
  const c = cache.get(conta);
  if (c && c.mes === mes && agora.getTime() - c.em < CACHE_MS) return { conta, mes, brl: c.brl };
  const usd = await somarGastoUsd(unit, inicioDoMesNoFuso(agora, tz));
  const brl = usd * USD_BRL;
  cache.set(conta, { brl, mes, em: agora.getTime() });
  return { conta, mes, brl };
}

/**
 * Onde a conta está no mês. Chamado ANTES de gastar de novo. Dispara o aviso (80 % / 100 %) por
 * conta própria, uma vez por mês; quem chama decide se bloqueia (`acaoAoEstourar() === 'pausar'`).
 */
export async function conferirTetoMensal(unit: Unit, agora: Date = new Date()): Promise<VereditoMensal> {
  const base = { conta: contaDaUnidade(unit), mes: mesNoFuso(agora, fusoDaUnidade(unit)), teto: TETO_MENSAL_BRL };
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

/**
 * Pausa TODAS as unidades da conta até a meia-noite do dia 1º (fuso da clínica), pela mesma pausa
 * da recepção. Devolve o instante em que a IA volta sozinha. Quem despausar pela página /pausa antes
 * disso vê a IA pausar de novo na próxima mensagem — o alerta explica.
 */
export async function pausarContaAteProximoMes(unit: Unit, v: VereditoMensal, agora: Date = new Date()): Promise<Date> {
  const ate = inicioDoProximoMesNoFuso(agora, fusoDaUnidade(unit));
  const sub = subdominio(unit);
  const where = sub ? { kommoSubdomain: { equals: sub, mode: 'insensitive' as const } } : { id: unit.id };
  const r = await prisma.unit.updateMany({
    where,
    data: {
      pausaDesde: null,
      pausaAte: ate,
      pausaMotivo: `teto mensal de IA: ${formatarBrl(v.brl)} de ${formatarBrl(v.teto)} em ${v.mes}`,
      pausaPor: PAUSA_POR,
    },
  });
  logger.warn({ conta: v.conta, unidades: r.count, ate: ate.toISOString(), brl: Number(v.brl.toFixed(2)) }, 'teto mensal: conta pausada até o dia 1º');
  return ate;
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
          ? 'A IA foi pausada nesta conta até o dia 1º (aparece na página /pausa da unidade); a equipe assume pelo Kommo. ' +
            'Pra liberar antes: subir TETO_MENSAL_BRL e despausar na página /pausa — só despausar não basta, ela pausa de novo na próxima mensagem.'
          : 'A IA continua respondendo (TETO_MENSAL_ACAO=avisar). Pra cortar de fato ao bater o teto: TETO_MENSAL_ACAO=pausar.',
    };
  }
  const pct = Math.round(v.fracao * 100);
  return {
    title: `💸 IA em ${v.conta}: ${brl} de ${teto} do mês (${pct} %)`,
    message:
      'Neste ritmo passa do teto antes do fim do mês. Nada muda no atendimento por enquanto; ao chegar em 100 % ' +
      (acao === 'pausar' ? 'a IA pausa nesta conta até o dia 1º.' : 'só avisa de novo.'),
  };
}

/** A marca persistente vive numa unidade só da conta (a de menor id), pra irmãs não repetirem o aviso. */
async function unidadeDonaDaMarca(unit: Pick<Unit, 'id' | 'kommoSubdomain'>): Promise<string> {
  const sub = subdominio(unit);
  if (!sub) return unit.id;
  try {
    const dona = await prisma.unit.findFirst({
      where: { kommoSubdomain: { equals: sub, mode: 'insensitive' } },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    return dona?.id ?? unit.id;
  } catch {
    return unit.id;
  }
}

async function avisar(unit: Unit, v: VereditoMensal): Promise<void> {
  // O teto entra na chave: se a chefe subir o teto no meio do mês, bater no novo teto avisa de novo.
  const chave = `${v.nivel === 'estourou' ? 'teto_mensal_100' : 'teto_mensal_80'}:${v.teto}`;
  const marca = `${v.conta}:${v.mes}:${chave}`;
  if (avisadosEmMemoria.has(marca)) return;
  const dona = await unidadeDonaDaMarca(unit);
  const leadKey = `mes:${v.mes}`;
  if (await avisoRecente(dona, leadKey, chave, JANELA_DEDUPE_MS)) {
    avisadosEmMemoria.add(marca);
    return;
  }
  const texto = textoDoAviso(v, acaoAoEstourar());
  // Marca SÓ depois de entregar: relay fora do ar na hora do estouro não pode calar o aviso do mês
  // inteiro. Se falhar, o próprio opsAlert segura 30 min e a próxima conferência tenta de novo.
  const entregue = await opsAlert({ chave: marca, ...texto });
  if (!entregue) {
    logger.warn({ unit: unit.slug, conta: v.conta, chave }, 'teto mensal: aviso não entregue agora — tenta de novo depois');
    return;
  }
  logger.warn({ unit: unit.slug, conta: v.conta, mes: v.mes, brl: Number(v.brl.toFixed(2)), teto: v.teto }, texto.title);
  avisadosEmMemoria.add(marca);
  await marcarAviso(dona, leadKey, chave);
}

export function _resetarTetoMensal(): void {
  cache.clear();
  avisadosEmMemoria.clear();
}
