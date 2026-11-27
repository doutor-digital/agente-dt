import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { opsAlert } from './ops-alert.js';
import { AGORA_UTC } from './sql-tempo.js';

/**
 * Avisa quando a taxa de erro sobe.
 *
 * O único alarme técnico que existia era o de saldo esgotado. Erro de verdade —
 * chamada falhando, execução quebrando — era gravado no banco e ninguém
 * comparava com o normal. Foi assim que tudo que apareceu hoje passou meses
 * invisível: nada quebra de forma barulhenta, o número na tela só fica errado.
 *
 * DOIS OLHARES
 * ------------
 * 1. POR UNIDADE: compara a última meia hora com as 24 horas anteriores, que é a
 *    linha de base daquela operação. Alarme com número fixo ("mais de 5 erros")
 *    não serve aqui: cinco erros numa unidade que atende trinta conversas por dia
 *    é incêndio, e na que atende mil é terça-feira. Exige VOLUME MÍNIMO antes de
 *    comparar (uma unidade parada com duas chamadas, uma falhando, marcaria 50%
 *    e acordaria todo mundo por nada) e taxa alta em termos absolutos (sair de
 *    0,2% para 0,6% é o triplo e continua sendo ruído).
 *
 * 2. DA REDE (queda geral): a madrugada de 26 para 27/11 mostrou o furo do
 *    primeiro. A Sofia ficou 15 h fora (saldo de crédito da Anthropic) com 100%
 *    de erro em `llm_calls` — e o alarme por unidade não tinha como ver: à noite
 *    a rede inteira faz ~20 chamadas a cada 10 min, repartidas em dezenas de
 *    unidades, e nenhuma chegava ao mínimo de 20. Então a rede toda também é
 *    medida como UMA coisa: 90% das chamadas falhando nos últimos 10 min é queda
 *    geral, com ou sem mínimo por unidade. Quando há queda geral, sai UM aviso,
 *    com a causa lida da mensagem de erro, e os avisos por unidade ficam quietos
 *    (39 mensagens iguais não ajudam ninguém).
 *
 * O FUSO. `llm_calls.created_at` é `timestamp` sem fuso gravado em UTC pelo Prisma,
 * e a sessão do banco está em America/Sao_Paulo. `created_at > now() - interval
 * '30 minutes'` virava 3h30 (8x mais linhas que o certo). Toda comparação com
 * "agora" aqui usa `AGORA_UTC` (lib/sql-tempo.ts).
 */

const SWEEP_MS = Number(process.env.TAXA_ERRO_SWEEP_MS) || 10 * 60_000;

/** A queda geral é checada com mais frequência: a consulta é pequena (10 min de uma tabela com índice em created_at). */
const REDE_SWEEP_MS = Number(process.env.TAXA_ERRO_REDE_SWEEP_MS) || 2 * 60_000;

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

/** Queda geral: janela em minutos, fração de erros e amostra mínima NA REDE (não por unidade). */
const REDE_JANELA_MIN = Number(process.env.TAXA_ERRO_REDE_JANELA_MIN) || 10;
const REDE_TAXA = Number(process.env.TAXA_ERRO_REDE_TAXA) || 0.9;
const REDE_MINIMO = Number(process.env.TAXA_ERRO_REDE_MINIMO) || 5;

let timer: NodeJS.Timeout | null = null;
let timerRede: NodeJS.Timeout | null = null;
let rodando = false;
let rodandoRede = false;

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
           count(*) filter (where c.created_at > ${AGORA_UTC} - ($1 || ' minutes')::interval)::int
             as "recentesTotal",
           count(*) filter (where c.created_at > ${AGORA_UTC} - ($1 || ' minutes')::interval
                              and c.status = 'error')::int
             as "recentesErro",
           count(*) filter (where c.created_at <= ${AGORA_UTC} - ($1 || ' minutes')::interval)::int
             as "baseTotal",
           count(*) filter (where c.created_at <= ${AGORA_UTC} - ($1 || ' minutes')::interval
                              and c.status = 'error')::int
             as "baseErro"
      from llm_calls c
      join units u on u.id = c.unit_id
     where c.created_at > ${AGORA_UTC} - interval '24 hours'
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

// ── Queda geral ─────────────────────────────────────────────────────────────

export type Causa = 'credito' | 'autenticacao' | 'limite' | 'indisponivel' | 'outra';

/**
 * Lê a causa na mensagem de erro do provedor. A ORDEM importa: «429 … no credits remaining» é crédito, não limite
 * de taxa; «400 invalid_request_error … credit balance» também é crédito (a Anthropic devolve 400 para saldo zerado).
 */
export function classificarCausa(mensagem: string | null | undefined): Causa {
  const m = (mensagem ?? '').toLowerCase();
  if (
    /credit balance|no credits?|out of credits?|insufficient[_ ]quota|exceeded your current quota|billing|payment required|saldo/.test(m)
  ) {
    return 'credito';
  }
  if (/\b40[13]\b|invalid[_ ]api[_ ]key|authentication|unauthori[sz]ed|permission[_ ]denied|forbidden|invalid x-api-key/.test(m)) {
    return 'autenticacao';
  }
  if (/\b429\b|rate[_ ]limit|too many requests/.test(m)) return 'limite';
  if (/\b5\d\d\b|overloaded|timeout|timed out|econn|enotfound|fetch failed|socket hang up|unavailable/.test(m)) {
    return 'indisponivel';
  }
  return 'outra';
}

const FRASE_DA_CAUSA: Record<Causa, string> = {
  credito: 'saldo de crédito do provedor esgotado (recarregar na conta do provedor)',
  autenticacao: 'chave de API recusada pelo provedor (401/403: chave revogada, trocada ou sem permissão)',
  limite: 'limite de uso (429) estourado no provedor',
  indisponivel: 'provedor fora do ar ou lento demais (erro 5xx, timeout ou rede)',
  outra: 'causa não identificada pela mensagem (ver llm_calls.error_message)',
};

export interface AmostraDaRede {
  /** `rede` = tudo somado; senão o nome do provedor (`openai`, `anthropic`…). */
  escopo: string;
  total: number;
  erros: number;
  /** Quantas unidades distintas tiveram erro: uma conversa quebrada sozinha não é queda. */
  unidadesComErro: number;
  /** Quantos erros por causa, lida da mensagem. */
  causas: Partial<Record<Causa, number>>;
}

export interface VeredictoDaRede {
  alarme: boolean;
  escopo: string;
  taxa: number;
  causa: Causa;
  motivo: string;
}

function causaDominante(causas: AmostraDaRede['causas']): Causa {
  let melhor: Causa = 'outra';
  let n = -1;
  for (const [c, q] of Object.entries(causas) as Array<[Causa, number]>) {
    if (q > n) {
      melhor = c;
      n = q;
    }
  }
  return melhor;
}

/**
 * Queda geral = 90% (ou mais) das chamadas falhando na janela curta, SEM exigir o mínimo por unidade. O mínimo da
 * rede é pequeno de propósito (de madrugada são ~20 chamadas por 10 min), e a salvaguarda contra falso alarme é outra:
 * ou o erro aparece em 2 unidades ou mais, ou a causa é de CONTA (crédito, chave) — esses dois não são uma conversa
 * esquisita, são o provedor recusando tudo.
 */
export function quedaGeral(amostras: AmostraDaRede[]): VeredictoDaRede {
  const candidatas: VeredictoDaRede[] = [];
  for (const a of amostras) {
    const taxa = a.total > 0 ? a.erros / a.total : 0;
    if (a.total < REDE_MINIMO || taxa < REDE_TAXA) continue;
    const causa = causaDominante(a.causas);
    const decisiva = causa === 'credito' || causa === 'autenticacao';
    if (a.unidadesComErro < 2 && !decisiva) continue;
    candidatas.push({
      alarme: true,
      escopo: a.escopo,
      taxa,
      causa,
      motivo:
        `${Math.round(taxa * 100)}% das chamadas falhando nos últimos ${REDE_JANELA_MIN} min ` +
        `(${a.erros} de ${a.total}${a.escopo === 'rede' ? ', na rede toda' : `, provedor ${a.escopo}`}). ` +
        `Causa provável: ${FRASE_DA_CAUSA[causa]}.`,
    });
  }
  if (!candidatas.length) return { alarme: false, escopo: 'rede', taxa: 0, causa: 'outra', motivo: 'sem queda geral' };
  // a rede inteira vale mais que um provedor; entre provedores, o que tem mais erro.
  candidatas.sort((x, y) => (x.escopo === 'rede' ? -1 : 0) - (y.escopo === 'rede' ? -1 : 0) || y.taxa - x.taxa);
  return candidatas[0];
}

interface LinhaTotais {
  provider: string | null;
  /** 1 na linha que soma a rede toda (ROLLUP), 0 nas linhas por provedor. */
  rede: number;
  total: number;
  erros: number;
  unidades: number;
}
interface LinhaMensagem {
  provider: string | null;
  msg: string;
  n: number;
}

/** Duas consultas pequenas (10 min), ambas pelo índice de `created_at`. */
async function medirRede(): Promise<AmostraDaRede[]> {
  const totais = await prisma.$queryRawUnsafe<LinhaTotais[]>(
    `
    select c.provider as provider,
           grouping(c.provider)::int as rede,
           count(*)::int as total,
           count(*) filter (where c.status = 'error')::int as erros,
           count(distinct c.unit_id) filter (where c.status = 'error')::int as unidades
      from llm_calls c
     where c.created_at > ${AGORA_UTC} - ($1 || ' minutes')::interval
     group by rollup (c.provider)
    `,
    String(REDE_JANELA_MIN),
  );
  const mensagens = await prisma.$queryRawUnsafe<LinhaMensagem[]>(
    `
    select c.provider as provider,
           left(coalesce(c.error_message, ''), 300) as msg,
           count(*)::int as n
      from llm_calls c
     where c.status = 'error'
       and c.created_at > ${AGORA_UTC} - ($1 || ' minutes')::interval
     group by 1, 2
     order by n desc
     limit 100
    `,
    String(REDE_JANELA_MIN),
  );
  return montarRede(totais, mensagens);
}

/** PURA: junta as duas consultas na forma que `quedaGeral` espera (linha `rede` = soma, vinda do ROLLUP). */
export function montarRede(totais: LinhaTotais[], mensagens: LinhaMensagem[]): AmostraDaRede[] {
  const nome = (p: string | null) => p ?? '?';
  const porProvedor = new Map<string, AmostraDaRede>();
  let rede: AmostraDaRede = { escopo: 'rede', total: 0, erros: 0, unidadesComErro: 0, causas: {} };
  for (const t of totais) {
    const a: AmostraDaRede = {
      escopo: t.rede ? 'rede' : nome(t.provider),
      total: Number(t.total),
      erros: Number(t.erros),
      unidadesComErro: Number(t.unidades),
      causas: {},
    };
    if (t.rede) rede = a;
    else porProvedor.set(a.escopo, a);
  }
  for (const m of mensagens) {
    const c = classificarCausa(m.msg);
    const n = Number(m.n);
    rede.causas[c] = (rede.causas[c] ?? 0) + n;
    const a = porProvedor.get(nome(m.provider));
    if (a) a.causas[c] = (a.causas[c] ?? 0) + n;
  }
  return [rede, ...porProvedor.values()];
}

/** Devolve `true` se há queda geral (e já avisou). */
async function varrerRede(): Promise<boolean> {
  if (rodandoRede) return false;
  rodandoRede = true;
  try {
    const v = quedaGeral(await medirRede());
    if (!v.alarme) return false;
    logger.error({ escopo: v.escopo, taxa: v.taxa, causa: v.causa }, `queda geral da IA: ${v.motivo}`);
    void opsAlert({
      chave: `queda-geral:${v.escopo}`,
      title: 'IA FORA DO AR: queda geral',
      message: `${v.motivo} Todas as unidades estão afetadas; a Sofia não está respondendo.`,
    });
    return true;
  } catch (err) {
    logger.warn({ err: String(err) }, 'varredura de queda geral falhou');
    return false;
  } finally {
    rodandoRede = false;
  }
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    // Havendo queda geral, o aviso dela já diz tudo: os por unidade só repetiriam, 39 vezes.
    if (await varrerRede()) return;
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
  timerRede = setInterval(() => void varrerRede(), REDE_SWEEP_MS);
  timerRede.unref?.();
  logger.info(
    { sweepMs: SWEEP_MS, janelaMin: JANELA_MIN, redeSweepMs: REDE_SWEEP_MS, redeJanelaMin: REDE_JANELA_MIN },
    'vigia de taxa de erro ligado',
  );
}

export function stopTaxaErroWorker(): void {
  if (timer) clearInterval(timer);
  if (timerRede) clearInterval(timerRede);
  timer = null;
  timerRede = null;
}

export const _internos = { medir, medirRede, varrer, varrerRede, MINIMO_CHAMADAS, TAXA_ABSURDA, FATOR_PIORA };
