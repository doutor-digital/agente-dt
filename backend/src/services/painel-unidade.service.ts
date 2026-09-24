import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { searchSchedules, SPINE_STATUS, type SpineSchedule, type SpineUnit } from './spine.service.js';

/**
 * O que a TELA DA UNIDADE precisa além do painel do operador.
 *
 * Quatro perguntas que o dono da clínica faz e que nenhum número solto responde:
 *   1. quem avaliou e não fechou? (dinheiro parado na mesa, com nome)
 *   2. quem está sumindo do tratamento? (receita já vendida escorrendo)
 *   3. a que horas os pacientes chamam? (justifica a IA existir de madrugada)
 *   4. está melhor ou pior que o mês passado?
 *
 * Tudo numa chamada só: a tela recarrega sozinha e não pode virar seis viagens.
 */

const CACHE_MS = 5 * 60_000;

/**
 * Ticket mais frequente da rede, medido em 04/09/2026 (228× na franquia, 184× no
 * Kommo). É ESTIMATIVA e a tela diz isso — preencher valor de venda automaticamente
 * é inventar faturamento, e esse erro já custou caro no painel de receita.
 */
export const TICKET_ESTIMADO_BRL = 3680;

/** Sessão sem comparecimento. A franquia quase nunca usa "NÃO COMPARECEU": tudo vira desmarcado. */
const FALTOU = new Set(['DESMARCADO', 'NÃO COMPARECEU', 'NAO COMPARECEU']);

export interface NaMesa {
  nome: string;
  quando: string | null;
}

export interface Sumindo {
  nome: string;
  faltasSeguidas: number;
  feitas: number;
  total: number;
  ultimaFalta: string | null;
}

export interface PainelUnidade {
  /** Avaliou e não fechou tratamento — o orçamento que ficou na mesa. */
  naMesa: NaMesa[];
  ticketEstimadoBrl: number;
  /** Em tratamento e faltando sessões seguidas. */
  sumindo: Sumindo[];
  /** Mensagens recebidas por hora do dia (0–23), no período. */
  porHora: number[];
  /** O mesmo funil no período anterior, pra dizer se melhorou. */
  anterior: { chegaram: number; conversou: number } | null;
}

const VAZIO: PainelUnidade = {
  naMesa: [],
  ticketEstimadoBrl: TICKET_ESTIMADO_BRL,
  sumindo: [],
  porHora: Array.from({ length: 24 }, () => 0),
  anterior: null,
};

const cache = new Map<string, { em: number; valor: PainelUnidade }>();

function dia(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function somarDias(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Quem está sumindo: conta, do mais recente pra trás, as sessões sem comparecimento
 * até achar uma atendida.
 *
 * REMARCADO não conta nem quebra a sequência — a sessão foi movida, não perdida.
 * Sem essa regra, clínica que remarca em bloco vira uma lista falsa de abandono.
 */
export function contarSumindo(sessoes: SpineSchedule[], hojeISO: string, minimo = 2): Sumindo[] {
  const porPaciente = new Map<string, SpineSchedule[]>();
  for (const s of sessoes) {
    if (s.categoryName !== 'SESSÃO') continue;
    if (!s.clientName) continue;
    if ((s.dayLocal ?? '') > hojeISO) continue; // sessão futura não é falta
    const lista = porPaciente.get(s.clientName) ?? [];
    lista.push(s);
    porPaciente.set(s.clientName, lista);
  }

  const out: Sumindo[] = [];
  for (const [nome, lista] of porPaciente) {
    lista.sort((a, b) => (a.dayLocal ?? '').localeCompare(b.dayLocal ?? ''));
    let seguidas = 0;
    let ultima: string | null = null;
    for (let i = lista.length - 1; i >= 0; i--) {
      const st = (lista[i].statusName ?? '').toUpperCase();
      if (FALTOU.has(st)) {
        seguidas++;
        ultima = ultima ?? lista[i].dayLocal;
      } else if (st === 'ATENDIDO') {
        break;
      }
    }
    if (seguidas >= minimo) {
      out.push({
        nome,
        faltasSeguidas: seguidas,
        feitas: lista.filter((s) => (s.statusName ?? '').toUpperCase() === 'ATENDIDO').length,
        total: lista.length,
        ultimaFalta: ultima,
      });
    }
  }
  return out.sort((a, b) => b.faltasSeguidas - a.faltasSeguidas);
}

export async function painelDaUnidade(
  unit: SpineUnit & { id: string; slug: string },
  desde: Date,
): Promise<PainelUnidade> {
  const chave = `${unit.id}:${dia(desde)}`;
  const guardado = cache.get(chave);
  if (guardado && Date.now() - guardado.em < CACHE_MS) return guardado.valor;

  const hojeISO = dia(new Date());
  const dias = Math.max(1, Math.round((Date.now() - desde.getTime()) / 86_400_000));
  const anteriorDesde = new Date(desde.getTime() - dias * 86_400_000);

  // ── o que é nosso (banco) ────────────────────────────────────────────────
  const [mensagens, chegaramAntes, conversouAntes, links] = await Promise.all([
    prisma.message.findMany({
      where: { role: 'user', createdAt: { gte: desde }, conversation: { unitId: unit.id } },
      select: { createdAt: true },
      take: 5000,
    }),
    prisma.conversation.count({
      where: { unitId: unit.id, createdAt: { gte: anteriorDesde, lt: desde } },
    }),
    prisma.conversation.count({
      where: {
        unitId: unit.id,
        createdAt: { gte: anteriorDesde, lt: desde },
        messages: { some: { role: 'assistant' } },
      },
    }),
    prisma.spineLeadLink.findMany({
      where: { unitId: unit.id, spineIdSchedule: { not: null }, createdAt: { gte: desde } },
      select: { spineIdSchedule: true },
    }),
  ]);

  const porHora = Array.from({ length: 24 }, () => 0);
  for (const m of mensagens) {
    // hora local de Brasília: o dono lê "as 22h" e não UTC
    const h = new Date(m.createdAt.getTime() - 3 * 3_600_000).getUTCHours();
    porHora[h]++;
  }

  const valor: PainelUnidade = {
    ...VAZIO,
    porHora,
    anterior: { chegaram: chegaramAntes, conversou: conversouAntes },
  };

  // ── o que é da clínica (franquia) ────────────────────────────────────────
  // Uma leitura só da agenda cobre as duas perguntas: o desfecho das consultas que
  // a IA marcou e as sessões de quem está em tratamento.
  const inicio = dia(desde) < somarDias(hojeISO, -100) ? somarDias(hojeISO, -100) : dia(desde);
  const r = await searchSchedules(unit, {
    initialDate: inicio,
    endDate: somarDias(hojeISO, 45),
    rowsPerPage: 100,
  }).catch(() => null);

  if (!r?.ok || !r.data) {
    logger.warn({ unit: unit.slug }, 'painel da unidade: agenda da franquia indisponível');
    cache.set(chave, { em: Date.now(), valor });
    return valor;
  }

  const agenda = r.data.schedules;
  const marcadas = new Set(links.map((l) => l.spineIdSchedule!));
  const agora = Date.now();

  valor.naMesa = agenda
    .filter(
      (s) =>
        s.idSchedule != null &&
        marcadas.has(s.idSchedule) &&
        s.idStatus === SPINE_STATUS.ATENDIDO &&
        !s.idTreatment &&
        (!s.dateAttendanceUtc || new Date(s.dateAttendanceUtc).getTime() < agora),
    )
    .map((s) => ({ nome: s.clientName ?? 'sem nome', quando: s.dayLocal }))
    .sort((a, b) => (b.quando ?? '').localeCompare(a.quando ?? ''));

  valor.sumindo = contarSumindo(agenda, hojeISO).slice(0, 8);

  cache.set(chave, { em: Date.now(), valor });
  return valor;
}
