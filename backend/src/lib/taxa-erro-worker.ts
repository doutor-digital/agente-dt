import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { opsAlert } from './ops-alert.js';
import { AGORA_UTC } from './sql-tempo.js';
import { classificarCausa, filtrosSql, type Causa } from './causa-erro-ia.js';

export { classificarCausa, type Causa };

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

/**
 * Com a janela agora de 30 min de verdade, o mínimo de 20 deixou de pegar a unidade pequena com a chave quebrada (antes a
 * janela de 3h30 trazia ~8x mais chamadas). Unidade em que TODAS as chamadas falham, com pelo menos isto, alarma mesmo assim.
 */
const MINIMO_TUDO_FALHANDO = Number(process.env.TAXA_ERRO_MINIMO_TUDO_FALHANDO) || 8;

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
/** Nenhuma unidade pode responder por mais que esta fração dos erros: acima disso é o problema DELA, não da rede. */
const REDE_MAIOR_UNIDADE = Number(process.env.TAXA_ERRO_REDE_MAIOR_UNIDADE) || 0.7;
/** Só vale como «laço» com volume: com 10 erros, uma unidade com 8 é o normal de uma madrugada com 2 unidades falando, não um laço. */
const REDE_LACO_MINIMO_ERROS = Number(process.env.TAXA_ERRO_REDE_LACO_MINIMO) || 20;

let timer: NodeJS.Timeout | null = null;
let timerRede: NodeJS.Timeout | null = null;
let rodando = false;

interface Amostra {
  slug: string;
  unitId: string;
  recentesTotal: number;
  recentesErro: number;
  baseTotal: number;
  baseErro: number;
}

/** `cancelled` (quem chamou desistiu) não é do provedor: fica fora do total, senão dilui a taxa e atrapalha a regra «todas falhando». */
async function medir(): Promise<Amostra[]> {
  return prisma.$queryRawUnsafe<Amostra[]>(
    `
    select u.slug,
           u.id as "unitId",
           count(*) filter (where c.status <> 'cancelled' and c.created_at > ${AGORA_UTC} - ($1 || ' minutes')::interval)::int
             as "recentesTotal",
           count(*) filter (where c.created_at > ${AGORA_UTC} - ($1 || ' minutes')::interval
                              and c.status = 'error')::int
             as "recentesErro",
           count(*) filter (where c.status <> 'cancelled' and c.created_at <= ${AGORA_UTC} - ($1 || ' minutes')::interval)::int
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

  if (a.recentesTotal >= MINIMO_TUDO_FALHANDO && a.recentesErro === a.recentesTotal && a.recentesTotal < MINIMO_CHAMADAS) {
    return { alarme: true, motivo: `todas as ${a.recentesTotal} chamadas falhando`, taxa };
  }
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
  /** Erros da unidade que mais errou: uma unidade em laço de reentrega não pode, sozinha, parecer queda da rede. */
  maiorUnidade: number;
  /** Quantos erros por causa, lida da mensagem (contada no SQL, sobre TODOS os erros da janela, não numa amostra). */
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
 * rede é pequeno de propósito (de madrugada são ~20 chamadas por 10 min). A salvaguarda contra falso alarme é UMA só: o erro
 * tem de aparecer em 2 unidades ou mais, na rede ou no provedor, e nenhuma unidade pode responder por mais de 70% dos erros (uma
 * unidade em laço de reentrega, mais um erro isolado de outra, não é queda da rede). Nem crédito nem chave abrem exceção: cada unidade pode ter a
 * PRÓPRIA chave (`Unit.anthropicApiKey`), então a chave de uma acabando não é «a rede toda fora». Uma unidade só com tudo falhando
 * é coberta pela regra por unidade («todas as chamadas falhando», `pioroDemais`).
 */
export function quedaGeral(amostras: AmostraDaRede[]): VeredictoDaRede {
  const candidatas: VeredictoDaRede[] = [];
  for (const a of amostras) {
    const taxa = a.total > 0 ? a.erros / a.total : 0;
    if (a.total < REDE_MINIMO || taxa < REDE_TAXA) continue;
    if (a.unidadesComErro < 2) continue;
    if (a.erros >= REDE_LACO_MINIMO_ERROS && a.maiorUnidade / a.erros > REDE_MAIOR_UNIDADE) continue;
    const causa = causaDominante(a.causas);
    candidatas.push({
      alarme: true,
      escopo: a.escopo,
      taxa,
      causa,
      motivo:
        `${Math.round(taxa * 100)}% das chamadas falhando nos últimos ${REDE_JANELA_MIN} min ` +
        `(${a.erros} de ${a.total}, em ${a.unidadesComErro} unidades${a.escopo === 'rede' ? ', na rede toda' : `, provedor ${a.escopo}`}). ` +
        `Causa provável: ${FRASE_DA_CAUSA[causa]}.`,
    });
  }
  if (!candidatas.length) return { alarme: false, escopo: 'rede', taxa: 0, causa: 'outra', motivo: 'sem queda geral' };
  // a rede inteira vale mais que um provedor; entre provedores, o que tem mais erro.
  candidatas.sort((x, y) => (x.escopo === 'rede' ? -1 : 0) - (y.escopo === 'rede' ? -1 : 0) || y.taxa - x.taxa);
  return candidatas[0];
}

export interface LinhaDaRede {
  provider: string | null;
  /** 1 na linha que soma a rede toda (ROLLUP), 0 nas linhas por provedor. */
  rede: number;
  total: number;
  erros: number;
  unidades: number;
  maior_unidade: number;
  erros_credito: number;
  erros_chave: number;
  erros_limite: number;
  erros_indisponivel: number;
}

/**
 * UMA consulta (10 min, pelo índice de `created_at`). Chamada `cancelled` (quem chamou desistiu: prazo estourado, sinal abortado) não é do
 * provedor e fica FORA do total: contá-la diluiria a taxa justo quando o provedor trava. A causa é contada no SQL, sobre todos os erros: agrupar por texto de
 * erro e pegar os 100 maiores falhava justo com mensagem que traz um `request_id` único (cada erro vira um grupo de 1).
 */
export function sqlDaRede(): string {
  const f = filtrosSql('c.error_message');
  const rec = `c.created_at > ${AGORA_UTC} - ($1 || ' minutes')::interval`;
  // por (provedor, unidade) primeiro, para saber quantas unidades erraram e quanto errou a pior delas; depois soma por provedor e na rede (ROLLUP)
  return `
    with u as (
      select c.provider as provider,
             c.unit_id as unit_id,
             count(*) filter (where c.status <> 'cancelled') as total,
             count(*) filter (where c.status = 'error') as erros,
             count(*) filter (where c.status = 'error' and ${f.credito}) as erros_credito,
             count(*) filter (where c.status = 'error' and ${f.autenticacao}) as erros_chave,
             count(*) filter (where c.status = 'error' and ${f.limite}) as erros_limite,
             count(*) filter (where c.status = 'error' and ${f.indisponivel}) as erros_indisponivel
        from llm_calls c
       where ${rec}
       group by c.provider, c.unit_id
    ),
    por_unidade as (
      -- erros por unidade SOMADOS entre os provedores (o plano B conta junto); NULL fica de fora
      select unit_id, sum(erros) as erros from u where unit_id is not null group by unit_id
    )
    select provider,
           grouping(provider)::int as rede,
           sum(total)::int as total,
           sum(erros)::int as erros,
           count(distinct unit_id) filter (where erros > 0)::int as unidades,
           case when grouping(provider) = 1
                then (select coalesce(max(erros), 0) from por_unidade)
                else coalesce(max(erros) filter (where unit_id is not null), 0)
           end::int as maior_unidade,
           sum(erros_credito)::int as erros_credito,
           sum(erros_chave)::int as erros_chave,
           sum(erros_limite)::int as erros_limite,
           sum(erros_indisponivel)::int as erros_indisponivel
      from u
     group by rollup (provider)
  `;
}

async function medirRede(): Promise<AmostraDaRede[]> {
  return montarRede(await prisma.$queryRawUnsafe<LinhaDaRede[]>(sqlDaRede(), String(REDE_JANELA_MIN)));
}

/** PURA: linhas do banco → o que `quedaGeral` espera (a linha `rede` vem do ROLLUP). */
export function montarRede(linhas: LinhaDaRede[]): AmostraDaRede[] {
  const paraAmostra = (l: LinhaDaRede): AmostraDaRede => {
    const causas: AmostraDaRede['causas'] = {};
    const pares: Array<[Causa, number]> = [
      ['credito', Number(l.erros_credito)],
      ['autenticacao', Number(l.erros_chave)],
      ['limite', Number(l.erros_limite)],
      ['indisponivel', Number(l.erros_indisponivel)],
    ];
    for (const [c, n] of pares) if (n > 0) causas[c] = n;
    // o que nenhuma regra reconhece também é uma causa: 39 erros «outra» + 1 de crédito não são «crédito esgotado»
    const outra = Number(l.erros) - pares.reduce((t, [, n]) => t + n, 0);
    if (outra > 0) causas.outra = outra;
    return { escopo: l.rede ? 'rede' : (l.provider ?? '?'), total: Number(l.total), erros: Number(l.erros), unidadesComErro: Number(l.unidades), maiorUnidade: Number(l.maior_unidade), causas };
  };
  const soma = linhas.find((l) => Number(l.rede) === 1);
  const vazia: AmostraDaRede = { escopo: 'rede', total: 0, erros: 0, unidadesComErro: 0, maiorUnidade: 0, causas: {} };
  return [soma ? paraAmostra(soma) : vazia, ...linhas.filter((l) => Number(l.rede) !== 1).map(paraAmostra)];
}

/** Uma varredura da rede por vez: quem chegar enquanto uma roda espera o MESMO resultado (e não conclui «sem queda» por falta de leitura). */
let emVoo: Promise<boolean> | null = null;

/** Devolve `true` se há queda geral que cobre a REDE INTEIRA (e já avisou). */
function varrerRede(): Promise<boolean> {
  if (emVoo) return emVoo;
  emVoo = (async () => {
    try {
      const v = quedaGeral(await medirRede());
      if (!v.alarme) return false;
      logger.error({ escopo: v.escopo, taxa: v.taxa, causa: v.causa }, `queda geral da IA: ${v.motivo}`);
      const toda = v.escopo === 'rede';
      void opsAlert({
        chave: `queda-geral:${v.escopo}`,
        title: toda ? 'IA FORA DO AR: queda geral' : `IA FORA DO AR no provedor ${v.escopo}`,
        message: toda
          ? `${v.motivo} A IA não está respondendo nas unidades afetadas.`
          : `${v.motivo} Quem usa esse provedor está afetado; as unidades em outro provedor seguem normais.`,
      });
      // Só a queda da REDE INTEIRA cala os avisos por unidade: com um provedor só caído, o problema de uma unidade em outro continua valendo
      // (e as unidades do provedor caído ainda recebem o aviso por unidade, além do do provedor: decisão consciente, o aviso do provedor diz a causa).
      return toda;
    } catch (err) {
      logger.warn({ err: String(err) }, 'varredura de queda geral falhou');
      return false;
    } finally {
      emVoo = null;
    }
  })();
  return emVoo;
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
