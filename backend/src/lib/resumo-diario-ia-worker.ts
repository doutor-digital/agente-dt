/**
 * Resumo diário da qualidade da Sofia, às 07:30 (São Paulo), no Telegram do João. SEM IA: só contagem em SQL
 * sobre o que o sistema já grava. Aos sábados sai também o resumo da semana (no lugar do cron antigo
 * `/root/qualidade-semanal.py`, que mandava pelo número de WhatsApp banido).
 *
 * Liga/desliga: variável de ambiente GLOBAL `RESUMO_DIARIO_IA` = `seco` (padrão, só loga o texto) | `ligado`
 * (manda) | `desligado`. É global de propósito: o catálogo de `automacoes.ts` é todo por unidade (lista de slugs),
 * e este resumo é da rede inteira. Mudar a variável vale no próximo reinício do backend.
 *
 * Uma vez por dia: o worker roda só no líder (`worker-lease.ts`), e cada mensagem do dia tem ainda o seu
 * próprio lease (`resumo-diario-ia:AAAA-MM-DD:diario|semanal`), porque o líder muda justamente na janela do deploy.
 */
import { logger } from './logger.js';
import { reivindicarLease, liberarLease } from './worker-lease.js';
import { enviarTelegram, telegramConfigurado } from './telegram.js';
import { somarDias } from './qualidade-ia/dias.js';
import { avaliacoesPorDia, faixasDeNota, noPeriodo, piorAvaliacao, unidadesPiores } from './qualidade-ia/agregar.js';
import { avaliacoesDoPeriodo, detalheDaConversa, mensagensPorDia } from './qualidade-ia/consulta.js';
import { estaNaHora, modoDoResumo, resolverODia, valorReconhecido, type Dependencias } from './qualidade-ia/resumo.js';
import type { DadosDiarios, DadosSemanais, Dia } from './qualidade-ia/tipos.js';

const PASSO_MS = 5 * 60_000;
/** Unidade só entra no "piores" com isto de conversas avaliáveis: abaixo é sorte, não qualidade. */
export const MIN_AVALIAVEIS_DIA = 5;
export const MIN_AVALIAVEIS_SEMANA = 10;

export async function coletarDiario(hoje: Dia): Promise<DadosDiarios> {
  const ontem = somarDias(hoje, -1);
  const de = somarDias(ontem, -7);
  const [linhas, mensagens] = await Promise.all([avaliacoesDoPeriodo(de, ontem), mensagensPorDia(de, ontem)]);
  const doDia = noPeriodo(linhas, ontem, ontem);
  const pior = piorAvaliacao(doDia);
  return {
    dia: ontem,
    avaliacoes: avaliacoesPorDia(linhas),
    mensagens,
    piores: unidadesPiores(doDia, MIN_AVALIAVEIS_DIA),
    pior: pior ? await detalheDaConversa(pior.conversationId, pior.nota, pior.unidade) : null,
  };
}

export async function coletarSemanal(hoje: Dia): Promise<DadosSemanais> {
  const fim = somarDias(hoje, -1);
  const [linhas, mensagens] = await Promise.all([
    avaliacoesDoPeriodo(somarDias(fim, -13), fim),
    mensagensPorDia(somarDias(fim, -13), fim),
  ]);
  const semana = noPeriodo(linhas, somarDias(fim, -6), fim);
  return {
    fim,
    avaliacoes: avaliacoesPorDia(linhas),
    mensagens,
    faixas: faixasDeNota(semana),
    piores: unidadesPiores(semana, MIN_AVALIAVEIS_SEMANA),
  };
}

const dependenciasReais: Dependencias = {
  coletarDiario,
  coletarSemanal,
  enviar: (texto) => enviarTelegram(texto),
  telegramConfigurado: () => telegramConfigurado(),
  reivindicar: (nome, ttlMs) => reivindicarLease(nome, undefined, ttlMs),
  liberar: (nome) => liberarLease(nome),
  registrar: (nivel, dados, mensagem) => logger[nivel](dados, mensagem),
};

let timer: NodeJS.Timeout | null = null;
let rodando = false;
/** Dia já resolvido (enviado, em seco, de outro processo ou desistido). Em memória: o lease cobre o resto. */
let diaResolvido: Dia | null = null;
let diaEmTentativa: Dia | null = null;
let tentativa = 0;
let jaEnviados = new Set<'diario' | 'semanal'>();

async function talvezResumir(): Promise<void> {
  if (rodando) return;
  const modo = modoDoResumo(process.env.RESUMO_DIARIO_IA);
  if (modo === 'desligado') return;
  const { rodar, hoje } = estaNaHora(new Date(), diaResolvido);
  if (!rodar) return;

  rodando = true;
  try {
    if (diaEmTentativa !== hoje) {
      diaEmTentativa = hoje;
      tentativa = 0;
      jaEnviados = new Set();
    }
    tentativa += 1;
    const desfecho = await resolverODia(hoje, modo, dependenciasReais, tentativa, jaEnviados);
    // Falta de lease (banco) não gasta tentativa: a janela até as 12h é o limite.
    if (desfecho === 'sem-lease') tentativa -= 1;
    if (desfecho !== 'tentar-de-novo' && desfecho !== 'sem-lease') diaResolvido = hoje;
    logger.info({ hoje, modo, desfecho, tentativa }, 'resumo-diario-ia: passo concluído');
  } catch (err) {
    logger.error({ err: String(err) }, 'resumo-diario-ia: passo falhou');
  } finally {
    rodando = false;
  }
}

export function startResumoDiarioIaWorker(): void {
  if (timer) return;
  timer = setInterval(() => void talvezResumir(), PASSO_MS);
  timer.unref?.();
  const raw = process.env.RESUMO_DIARIO_IA;
  const modo = modoDoResumo(raw);
  if (!valorReconhecido(raw)) {
    logger.warn({ valor: raw, modo }, 'resumo-diario-ia: RESUMO_DIARIO_IA com valor desconhecido — usando seco (nada é enviado). Use seco, ligado ou desligado');
  }
  logger.info({ modo, passoMs: PASSO_MS }, 'resumo-diario-ia: worker ligado');
}

export function stopResumoDiarioIaWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
