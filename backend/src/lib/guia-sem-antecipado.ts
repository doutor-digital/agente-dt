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
  /** unidade desativada NÃO decide a conta (não pode vetar a lista nem entrar nela); sem o campo = ativa */
  isActive?: boolean | null;
}

/** PURA: as contas (id numérico > 0) em que toda unidade ATIVA é «sem antecipado». Conta só com unidades desativadas fica de fora (guia de sempre). */
export function contasSemAntecipadoDe(linhas: readonly LinhaDaConta[]): number[] {
  const porConta = new Map<number, boolean[]>();
  for (const l of linhas) {
    if (!l.contaId || !Number.isInteger(l.contaId) || l.contaId <= 0) continue;
    if (l.isActive === false) continue;
    const v = porConta.get(l.contaId) ?? [];
    v.push(unidadeSemAntecipado(l));
    porConta.set(l.contaId, v);
  }
  return [...porConta.entries()].filter(([, v]) => v.length > 0 && v.every(Boolean)).map(([c]) => c).sort((a, b) => a - b);
}

const VALIDADE_MS = 60_000;
/** Quanto o `menu.js` espera pela lista na 1ª vez (sem lista nenhuma ainda): passou disso, sai com a lista vazia (guia de sempre) e a leitura segue por trás. O menu carrega TODO o CRM: não pode esperar o banco. */
export const PRAZO_DA_LISTA_MS = 400;
let cache: { em: number; contas: number[] } | null = null;
let lendo: Promise<number[]> | null = null;

export type LeitorDeLinhas = () => Promise<LinhaDaConta[]>;

const lerDoBanco: LeitorDeLinhas = async () => {
  const linhas = await prisma.unitChatwoot.findMany({ where: { contaId: { not: null } }, select: { contaId: true, unit: { select: { acceptsAdvancePayment: true, spineBookingRequiresPayment: true, isActive: true } } } });
  return linhas.map((l) => ({ contaId: l.contaId, acceptsAdvancePayment: l.unit.acceptsAdvancePayment, spineBookingRequiresPayment: l.unit.spineBookingRequiresPayment, isActive: l.unit.isActive }));
};

/** Começa (uma só) leitura em segundo plano; quando termina guarda a lista. Nunca lança, nem se o leitor lançar de forma síncrona. */
function renovar(ler: LeitorDeLinhas, agora: number): Promise<number[]> {
  if (lendo) return lendo;
  const p: Promise<number[]> = (async () => {
    try {
      const contas = contasSemAntecipadoDe(await Promise.resolve().then(() => ler()));
      cache = { em: agora, contas };
      return contas;
    } catch (err) {
      logger.warn({ err: String(err) }, 'guia-sem-antecipado: não consegui ler o banco — vale a última lista (ou nenhuma)');
      // tenta de novo em 5 s (não deixa a lista vazia valer o minuto inteiro)
      cache = { em: agora - VALIDADE_MS + 5_000, contas: cache?.contas ?? [] };
      return cache.contas;
    }
  })();
  lendo = p;
  // solta a trava só depois de atribuí-la (um leitor que falha na hora não pode deixá-la presa)
  void p.finally(() => {
    if (lendo === p) lendo = null;
  });
  return p;
}

/**
 * As contas sem antecipado, NUNCA esperando o banco além de `prazoMs`:
 *  - lista fresca (60 s): devolve na hora;
 *  - lista velha: devolve a velha NA HORA e renova por trás (o menu não espera);
 *  - nenhuma lista ainda: espera até `prazoMs`; passou, devolve [] (guia de sempre) e a leitura segue por trás.
 * Erro do banco = a última lista boa, ou []. Nunca lança.
 */
export async function contasSemAntecipado(ler: LeitorDeLinhas = lerDoBanco, agora: number = Date.now(), prazoMs: number = PRAZO_DA_LISTA_MS): Promise<number[]> {
  if (cache && agora - cache.em < VALIDADE_MS) return cache.contas;
  const leitura = renovar(ler, agora);
  if (cache) return cache.contas;
  let relogio: NodeJS.Timeout | undefined;
  const prazo = new Promise<number[]>((resolve) => {
    relogio = setTimeout(() => resolve([]), prazoMs);
    relogio.unref?.();
  });
  try {
    return await Promise.race([leitura, prazo]);
  } finally {
    clearTimeout(relogio);
  }
}

export function _esquecerCacheDoGuia(): void {
  cache = null;
  lendo = null;
}
