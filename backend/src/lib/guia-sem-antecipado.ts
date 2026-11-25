/**
 * Quais contas do Chatwoot são de unidade que NÃO aceita pagamento antecipado (`units.accepts_advance_payment = false`; Timbó: a consulta é paga no dia, na clínica).
 * O guia «O que fazer agora» troca os passos do Pix da etapa Agendado nessas contas (`PASSOS_SEM_ANTECIPADO`). O `menu.js` é UM arquivo para todas as contas, então a lista
 * vai dentro dele; vem do banco e fica em memória por 60 s.
 *
 * Só entra a conta que TODAS as unidades dela dizem `false`: unidade sem linha, valor desconhecido ou erro do banco = a conta NÃO entra (o guia continua como sempre,
 * com os passos do Pix). Nunca lança.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';

export interface LinhaDaConta {
  contaId: number | null;
  acceptsAdvancePayment: boolean | null;
}

/** PURA: as contas (id numérico > 0) em que toda unidade tem `false`. */
export function contasSemAntecipadoDe(linhas: readonly LinhaDaConta[]): number[] {
  const porConta = new Map<number, boolean[]>();
  for (const l of linhas) {
    if (!l.contaId || !Number.isInteger(l.contaId) || l.contaId <= 0) continue;
    const v = porConta.get(l.contaId) ?? [];
    v.push(l.acceptsAdvancePayment === false);
    porConta.set(l.contaId, v);
  }
  return [...porConta.entries()].filter(([, v]) => v.length > 0 && v.every(Boolean)).map(([c]) => c).sort((a, b) => a - b);
}

const VALIDADE_MS = 60_000;
let cache: { em: number; contas: number[] } | null = null;
let lendo: Promise<number[]> | null = null;

export type LeitorDeLinhas = () => Promise<LinhaDaConta[]>;

const lerDoBanco: LeitorDeLinhas = async () => {
  const linhas = await prisma.unitChatwoot.findMany({ where: { contaId: { not: null } }, select: { contaId: true, unit: { select: { acceptsAdvancePayment: true } } } });
  return linhas.map((l) => ({ contaId: l.contaId, acceptsAdvancePayment: l.unit.acceptsAdvancePayment }));
};

/** As contas sem antecipado (cache de 60 s; o primeiro pedido espera o banco). Erro = a última lista boa, ou vazio. */
export async function contasSemAntecipado(ler: LeitorDeLinhas = lerDoBanco, agora: number = Date.now()): Promise<number[]> {
  if (cache && agora - cache.em < VALIDADE_MS) return cache.contas;
  if (lendo) return lendo;
  lendo = (async () => {
    try {
      const contas = contasSemAntecipadoDe(await ler());
      cache = { em: agora, contas };
      return contas;
    } catch (err) {
      logger.warn({ err: String(err) }, 'guia-sem-antecipado: não consegui ler o banco — vale a última lista (ou nenhuma)');
      cache = { em: agora, contas: cache?.contas ?? [] };
      return cache.contas;
    } finally {
      lendo = null;
    }
  })();
  return lendo;
}

export function _esquecerCacheDoGuia(): void {
  cache = null;
  lendo = null;
}
