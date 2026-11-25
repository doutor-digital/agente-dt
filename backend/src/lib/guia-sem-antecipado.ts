/**
 * Quais contas do Chatwoot são de unidade que NÃO aceita pagamento antecipado (`units.accepts_advance_payment = false`; Timbó: a consulta é paga no dia, na clínica).
 * O guia «O que fazer agora» troca os passos do Pix da etapa Agendado nessas contas (`PASSOS_SEM_ANTECIPADO`). O `menu.js` é UM arquivo para todas as contas, então a lista
 * vai dentro dele; vem do banco e fica em memória por 60 s.
 *
 * A decisão «esta unidade é sem antecipado?» é a MESMA do resto do código (`unidadeSemAntecipado`: `accepts_advance_payment=false` E sem taxa de reserva obrigatória, que vence).
 * Só entra a conta própria (`unit_chatwoot.conta_id` preenchido; a conta do ambiente, sem id na tabela, nunca entra: segue com os passos do Pix). Só entra a conta que TODAS as unidades dela dizem «sem antecipado»: unidade sem linha, valor desconhecido ou erro do banco = a conta NÃO entra (o guia continua como sempre,
 * com os passos do Pix). Nunca lança.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { unidadeSemAntecipado } from '../agent/pagamento-da-unidade.js';

export interface LinhaDaConta {
  contaId: number | null;
  acceptsAdvancePayment: boolean | null;
  spineBookingRequiresPayment?: boolean | null;
}

/** PURA: as contas (id numérico > 0) em que toda unidade tem `false`. */
export function contasSemAntecipadoDe(linhas: readonly LinhaDaConta[]): number[] {
  const porConta = new Map<number, boolean[]>();
  for (const l of linhas) {
    if (!l.contaId || !Number.isInteger(l.contaId) || l.contaId <= 0) continue;
    const v = porConta.get(l.contaId) ?? [];
    v.push(unidadeSemAntecipado(l));
    porConta.set(l.contaId, v);
  }
  return [...porConta.entries()].filter(([, v]) => v.length > 0 && v.every(Boolean)).map(([c]) => c).sort((a, b) => a - b);
}

const VALIDADE_MS = 60_000;
let cache: { em: number; contas: number[] } | null = null;
let lendo: Promise<number[]> | null = null;

export type LeitorDeLinhas = () => Promise<LinhaDaConta[]>;

const lerDoBanco: LeitorDeLinhas = async () => {
  const linhas = await prisma.unitChatwoot.findMany({ where: { contaId: { not: null } }, select: { contaId: true, unit: { select: { acceptsAdvancePayment: true, spineBookingRequiresPayment: true } } } });
  return linhas.map((l) => ({ contaId: l.contaId, acceptsAdvancePayment: l.unit.acceptsAdvancePayment, spineBookingRequiresPayment: l.unit.spineBookingRequiresPayment }));
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
      // tenta de novo em 5 s (não deixa a lista vazia valer o minuto inteiro)
      cache = { em: agora - VALIDADE_MS + 5_000, contas: cache?.contas ?? [] };
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
