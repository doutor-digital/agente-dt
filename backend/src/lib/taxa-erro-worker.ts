import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { opsAlert } from './ops-alert.js';

/**
 * Avisa quando a taxa de erro sobe.
 *
 * O único alarme técnico que existia era o de saldo esgotado. Erro de verdade —
 * chamada falhando, execução quebrando — era gravado no banco e ninguém
 * comparava com o normal. Foi assim que tudo que apareceu hoje passou meses
 * invisível: nada quebra de forma barulhenta, o número na tela só fica errado.
 *
 * COMO ELE DECIDE QUE PIOROU
 * --------------------------
 * Compara a última meia hora com as 24 horas anteriores, que é a linha de base
 * daquela operação. Alarme com número fixo ("mais de 5 erros") não serve aqui:
 * cinco erros numa unidade que atende trinta conversas por dia é incêndio, e na
 * que atende mil é terça-feira.
 *
 * Exige VOLUME MÍNIMO antes de comparar. Sem isso, uma unidade parada com duas
 * chamadas, uma falhando, marcaria 50% de erro e acordaria todo mundo por nada
 * — e alarme que toca à toa é alarme que ninguém olha mais.
 *
 * Exige também que a taxa seja alta em termos absolutos, não só relativamente:
 * sair de 0,2% para 0,6% é o triplo e continua sendo ruído.
 */

const SWEEP_MS = Number(process.env.TAXA_ERRO_SWEEP_MS) || 10 * 60_000;

/** Janela recente que está sendo julgada. */
const JANELA_MIN = Number(process.env.TAXA_ERRO_JANELA_MIN) || 30;

/** Abaixo disso não há amostra pra concluir nada. */
const MINIMO_CHAMADAS = Number(process.env.TAXA_ERRO_MINIMO) || 20;

/** Taxa que já é ruim por si só, mesmo sem comparação. */
const TAXA_ABSURDA = Number(process.env.TAXA_ERRO_ABSURDA) || 0.25;

/** Quantas vezes pior que o normal para virar alarme. */
const FATOR_PIORA = Number(process.env.TAXA_ERRO_FATOR) || 3;

/** Piso: abaixo disso, ser o triplo do normal ainda é ruído. */
const TAXA_MINIMA_PARA_ALARMAR = Number(process.env.TAXA_ERRO_PISO) || 0.08;

let timer: NodeJS.Timeout | null = null;
let rodando = false;

interface Amostra {
  slug: string;
  unitId: string;
  recentesTotal: number;
  recentesErro: number;
  baseTotal: number;
  baseErro: number;
}

async function medir(): Promise<Amostra[]> {
  return prisma.$queryRawUnsafe<Amostra[]>(
    `
    select u.slug,
           u.id as "unitId",
           count(*) filter (where c.created_at > now() - ($1 || ' minutes')::interval)::int
             as "recentesTotal",
           count(*) filter (where c.created_at > now() - ($1 || ' minutes')::interval
                              and c.status = 'error')::int
             as "recentesErro",
           count(*) filter (where c.created_at <= now() - ($1 || ' minutes')::interval)::int
             as "baseTotal",
           count(*) filter (where c.created_at <= now() - ($1 || ' minutes')::interval
                              and c.status = 'error')::int
             as "baseErro"
      from llm_calls c
      join units u on u.id = c.unit_id
     where c.created_at > now() - interval '24 hours'
     group by u.slug, u.id
    `,
    String(JANELA_MIN),
  );
}

/** Decide, a partir dos números, se isto merece acordar alguém. */
export function pioroDemais(a: Amostra): { alarme: boolean; motivo: string; taxa: number } {
  const taxa = a.recentesTotal > 0 ? a.recentesErro / a.recentesTotal : 0;
  const base = a.baseTotal > 0 ? a.baseErro / a.baseTotal : 0;

  if (a.recentesTotal < MINIMO_CHAMADAS) {
    return { alarme: false, motivo: 'amostra pequena demais pra concluir', taxa };
  }
  if (taxa >= TAXA_ABSURDA) {
    return { alarme: true, motivo: `${Math.round(taxa * 100)}% das chamadas falhando`, taxa };
  }
  if (taxa < TAXA_MINIMA_PARA_ALARMAR) {
    return { alarme: false, motivo: 'taxa baixa em termos absolutos', taxa };
  }
  // Base zerada e taxa acima do piso: piorou de vez, sem precisar de razão.
  if (base === 0) {
    return { alarme: true, motivo: `saiu de zero para ${Math.round(taxa * 100)}%`, taxa };
  }
  if (taxa >= base * FATOR_PIORA) {
    return {
      alarme: true,
      motivo: `${Math.round(taxa * 100)}% agora contra ${Math.round(base * 100)}% do normal`,
      taxa,
    };
  }
  return { alarme: false, motivo: 'dentro do normal da unidade', taxa };
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    for (const a of await medir()) {
      const v = pioroDemais(a);
      if (!v.alarme) continue;

      logger.error(
        { unit: a.slug, taxa: v.taxa, recentes: a.recentesTotal, erros: a.recentesErro },
        `taxa de erro subiu: ${v.motivo}`,
      );
      opsAlert({
        // A chave inclui a unidade para uma não abafar o alarme da outra, e o
        // anti-flood de 30 min do relay cuida da repetição.
        chave: `taxa-erro:${a.slug}`,
        title: `IA falhando em ${a.slug}`,
        message:
          `${v.motivo}. Foram ${a.recentesErro} erros em ${a.recentesTotal} chamadas ` +
          `nos últimos ${JANELA_MIN} minutos. Ver Execuções no console para a causa.`,
      });
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'varredura de taxa de erro falhou');
  } finally {
    rodando = false;
  }
}

export function startTaxaErroWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  timer.unref?.();
  logger.info({ sweepMs: SWEEP_MS, janelaMin: JANELA_MIN }, 'vigia de taxa de erro ligado');
}

export function stopTaxaErroWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export const _internos = { medir, varrer, MINIMO_CHAMADAS, TAXA_ABSURDA, FATOR_PIORA };
