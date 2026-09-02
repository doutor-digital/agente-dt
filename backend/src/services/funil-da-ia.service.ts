import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { searchSchedules, SPINE_STATUS, type SpineUnit } from './spine.service.js';

/**
 * O funil da Sofia até o fim: quem ela agendou, quem apareceu e quem fechou
 * tratamento.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 * ---------------------------
 * O painel mostrava "atendidos → consultas agendadas → pacientes fechados" e o
 * terceiro número era o mesmo evento do segundo, contado de novo: `converted_at`
 * na conversa é gravado quando a IA AGENDA, não quando o tratamento fecha. Por
 * isso a Serra aparecia com 3 agendados e 3 "fechados" — 100% de conversão, que
 * é justamente o número que denuncia a duplicação.
 *
 * Cliente experiente pergunta "100% dos agendados fecharam mesmo?" e derruba a
 * credibilidade do resto do painel, que é bom.
 *
 * A VERDADE ESTÁ NA FRANQUIA, NÃO AQUI
 * ------------------------------------
 * Quem sabe se o paciente compareceu e se virou tratamento é o sistema da
 * clínica. Guardamos o `spineIdSchedule` de cada consulta que a IA marcou lá;
 * daí basta perguntar o desfecho de cada uma.
 *
 * É barato: a IA marcou 19 consultas na rede inteira até 02/09/2026, então são
 * poucas dezenas de linhas por unidade. Ainda assim vai com cache, porque o
 * painel recarrega a cada troca de período.
 */

/** A franquia recusa intervalo maior que isso. */
const MAX_DIAS_POR_CONSULTA = 100;
const CACHE_MS = 5 * 60_000;

export interface FunilDaIA {
  /** Consultas que a IA marcou na agenda da clínica. */
  agendou: number;
  /** Dessas, quantas o paciente compareceu. */
  compareceu: number;
  /** Dessas, quantas viraram tratamento fechado. */
  fechouTratamento: number;
  /** Consulta ainda no futuro — não dá para cobrar desfecho delas. */
  aindaNoFuturo: number;
}

const VAZIO: FunilDaIA = { agendou: 0, compareceu: 0, fechouTratamento: 0, aindaNoFuturo: 0 };

const cache = new Map<string, { em: number; valor: FunilDaIA }>();

function somarDias(iso: string, dias: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Janelas de no máximo 100 dias cobrindo de `desde` até 120 dias à frente — a
 * consulta marcada hoje pode ser para daqui a dois meses, e ela precisa entrar
 * na conta como "ainda no futuro" em vez de sumir.
 */
function janelas(desde: Date): Array<[string, string]> {
  const inicio = desde.toISOString().slice(0, 10);
  const fim = somarDias(new Date().toISOString().slice(0, 10), 120);
  const out: Array<[string, string]> = [];
  let cursor = inicio;
  while (cursor < fim && out.length < 6) {
    const proximo = somarDias(cursor, MAX_DIAS_POR_CONSULTA);
    out.push([cursor, proximo < fim ? proximo : fim]);
    cursor = somarDias(proximo, 1);
  }
  return out;
}

export async function funilDaIA(
  unit: SpineUnit & { id: string; slug: string },
  desde: Date,
): Promise<FunilDaIA> {
  const chave = `${unit.id}:${desde.toISOString().slice(0, 10)}`;
  const guardado = cache.get(chave);
  if (guardado && Date.now() - guardado.em < CACHE_MS) return guardado.valor;

  const links = await prisma.spineLeadLink.findMany({
    where: { unitId: unit.id, spineIdSchedule: { not: null }, createdAt: { gte: desde } },
    select: { spineIdSchedule: true },
  });
  if (links.length === 0) {
    cache.set(chave, { em: Date.now(), valor: VAZIO });
    return VAZIO;
  }

  const alvo = new Set(links.map((l) => l.spineIdSchedule!));
  const encontrados = new Map<number, { idStatus: number | null; idTreatment: number | null; quando: string | null }>();

  for (const [inicio, fim] of janelas(desde)) {
    const r = await searchSchedules(unit, { initialDate: inicio, endDate: fim, rowsPerPage: 100 });
    if (!r.ok || !r.data) {
      logger.warn({ unit: unit.slug, erro: r.error }, 'funil da IA: não consegui ler a agenda da franquia');
      continue;
    }
    for (const s of r.data.schedules) {
      if (s.idSchedule && alvo.has(s.idSchedule)) {
        encontrados.set(s.idSchedule, {
          idStatus: s.idStatus,
          idTreatment: s.idTreatment,
          quando: s.dateAttendanceUtc,
        });
      }
    }
  }

  const agora = Date.now();
  let compareceu = 0;
  let fechouTratamento = 0;
  let aindaNoFuturo = 0;

  for (const s of encontrados.values()) {
    if (s.idStatus === SPINE_STATUS.ATENDIDO) compareceu++;
    if (s.idTreatment) fechouTratamento++;
    if (s.quando && new Date(s.quando).getTime() > agora) aindaNoFuturo++;
  }

  // `agendou` conta o que a IA marcou, não o que a franquia devolveu: consulta
  // que sumiu da agenda (apagada na mão, por exemplo) foi marcada do mesmo jeito
  // e não pode desaparecer do topo do funil.
  const valor: FunilDaIA = { agendou: links.length, compareceu, fechouTratamento, aindaNoFuturo };
  cache.set(chave, { em: Date.now(), valor });
  return valor;
}
