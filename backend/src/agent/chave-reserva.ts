/**
 * Plano B da CHAVE: quando a chave Anthropic da unidade para de valer.
 *
 * 05/10/2026: a chave da Taubaté tinha validade de 30 dias e venceu às 09h14. Até as 16h a Sofia
 * respondeu ~82 vezes "tive uma instabilidade rapidinha" — a Anthropic estava de pé, só a CHAVE
 * estava morta. O circuito (circuito.ts) não ajuda nesse caso: ele cuida de provedor FORA DO AR, e
 * esperar não ressuscita chave vencida. O plano B de provedor (llm-policy.ts) troca o modelo
 * inteiro — e naquele dia também não segurou.
 *
 * Aqui: se a chamada à Anthropic falhar por motivo de CHAVE ou CONTA (401, 402, 403, sem crédito),
 * refaz UMA vez a MESMA chamada — mesmo modelo, mesmo prompt, mesmas ferramentas — com a chave
 * reserva de ANTHROPIC_RESERVE_API_KEY. Sem a variável, nada muda.
 *
 * Não entra em erro passageiro (5xx, sobrecarga, timeout, 429 de limite por minuto): isso é do
 * circuito e da retentativa. E a reserva é tentada uma vez só: se ela também falhar, sobe o erro
 * ORIGINAL e o caminho de hoje continua (plano B de provedor e, por fim, a frase de instabilidade).
 *
 * A chave da unidade é sempre tentada primeiro. Assim, quando alguém trocar a chave vencida no
 * console, a unidade volta pra própria chave sozinha, sem deploy.
 */
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { opsAlert } from '../lib/ops-alert.js';

/** Como a chamada feita com a reserva aparece em llm_calls.provider. */
export const PROVEDOR_RESERVA = 'anthropic-reserva';

/** Um aviso por unidade por hora: chave vencida falha em TODA mensagem até alguém trocar. */
const JANELA_AVISO_MS = 60 * 60_000;

export interface FalhaDeChave {
  status: number | null;
  tipo: string;
}

/** Lida na hora (não no boot): trocar a variável não exige mexer em código. */
export function chaveReservaAnthropic(): string | null {
  const k = process.env.ANTHROPIC_RESERVE_API_KEY?.trim();
  return k ? k : null;
}

function mensagemDe(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? '');
}

/** O SDK da Anthropic põe o status no erro e também no começo da mensagem ("401 {...}"). */
function statusDe(err: unknown): number | null {
  const e = err as { status?: unknown; response?: { status?: unknown } } | null | undefined;
  const s = e?.status ?? e?.response?.status;
  if (typeof s === 'number') return s;
  const m = /^(\d{3})\s/.exec(mensagemDe(err));
  return m ? Number(m[1]) : null;
}

/** O tipo da API (authentication_error, permission_error...): no campo `type` do SDK ou no corpo. */
function tipoDe(err: unknown): string | null {
  const e = err as { type?: unknown; error?: { error?: { type?: unknown } } } | null | undefined;
  if (typeof e?.type === 'string' && e.type) return e.type;
  if (typeof e?.error?.error?.type === 'string') return e.error.error.type;
  const m = /"type"\s*:\s*"([a-z]+(?:_[a-z]+)*_error)"/.exec(mensagemDe(err));
  return m ? m[1] : null;
}

const TIPOS_DE_CHAVE = new Set(['authentication_error', 'permission_error', 'billing_error']);

/** A Anthropic responde falta de crédito como 400 ("Your credit balance is too low..."). */
const SEM_CREDITO_400 = /credit balance|usage limits?|billing|payment required/i;
/** 429 é limite por minuto (passageiro) — só conta como conta quebrada se falar de crédito. */
const SEM_CREDITO_429 = /credit balance|billing|insufficient[_ ]quota|payment required|api usage limits/i;

/**
 * Distingue "a chave/conta desta unidade não serve" de "a Anthropic está ruim agora".
 * Só o primeiro justifica trocar de chave; o segundo é do circuito.
 */
export function ehFalhaDeChave(err: unknown): FalhaDeChave | null {
  if (err == null) return null;
  if (err instanceof Error && err.name === 'LlmTimeoutError') return null;

  const status = statusDe(err);
  if (status !== null && status >= 500) return null;

  const tipo = tipoDe(err);
  if (tipo && TIPOS_DE_CHAVE.has(tipo)) return { status, tipo };
  if (status === 401) return { status, tipo: tipo ?? 'authentication_error' };
  if (status === 402) return { status, tipo: tipo ?? 'billing_error' };
  if (status === 403) return { status, tipo: tipo ?? 'permission_error' };

  const msg = mensagemDe(err);
  if (status === 400 && SEM_CREDITO_400.test(msg)) return { status, tipo: 'sem_credito' };
  if (status === 429 && SEM_CREDITO_429.test(msg)) return { status, tipo: 'sem_credito' };
  return null;
}

/** Resumo do erro sem a mensagem crua: status/tipo, ou o nome do erro (ex.: LlmTimeoutError). */
function rotuloDoErro(err: unknown): string {
  const status = statusDe(err);
  const tipo = tipoDe(err);
  if (status !== null || tipo) return `${status ?? '?'}/${tipo ?? 'erro'}`;
  return err instanceof Error ? err.name : 'erro';
}

const ultimoAviso = new Map<string, number>();

/** Trava em memória (cada réplica conta a sua), igual ao circuito e ao ops-alert. */
function devoAvisar(chave: string, agora: number): boolean {
  const antes = ultimoAviso.get(chave);
  if (antes !== undefined && agora - antes < JANELA_AVISO_MS) return false;
  ultimoAviso.set(chave, agora);
  return true;
}

/** Só para teste — zera a trava entre casos. */
export function resetarAvisosDaReserva(): void {
  ultimoAviso.clear();
}

export type AvisoReserva =
  | { evento: 'usando-reserva'; unitId: string; slug: string; falha: FalhaDeChave }
  | { evento: 'reserva-falhou'; unitId: string; slug: string; falha: FalhaDeChave; erroReserva: string };

/** Vai pro system_logs (logger com `module`) e pro relay de alertas — nunca com a chave. */
function avisarPadrao(a: AvisoReserva): void {
  const rotulo = `${a.falha.status ?? '?'}/${a.falha.tipo}`;
  const contexto = { module: 'chave-reserva', unitId: a.unitId, slug: a.slug, status: a.falha.status, tipo: a.falha.tipo };
  if (a.evento === 'usando-reserva') {
    logger.warn(contexto, `chave da unidade ${a.slug} falhou (${rotulo}), usando a reserva`);
    void opsAlert({
      chave: `chave-reserva:${a.slug}`,
      title: `Chave Anthropic da unidade ${a.slug} falhou — Sofia respondendo pela chave reserva`,
      message:
        `A chave Anthropic da unidade ${a.slug} foi recusada (${rotulo}). A Sofia segue respondendo ` +
        `pela chave reserva (ANTHROPIC_RESERVE_API_KEY). Troque a chave da unidade no console ` +
        `(chave SEM validade); enquanto isso o gasto dessa unidade cai na conta da reserva.`,
    });
    return;
  }
  logger.error(
    { ...contexto, erroReserva: a.erroReserva },
    `chave da unidade ${a.slug} falhou (${rotulo}) e a reserva também falhou (${a.erroReserva}) — seguindo o caminho de hoje`,
  );
  void opsAlert({
    chave: `chave-reserva-falhou:${a.slug}`,
    title: `Chave Anthropic da unidade ${a.slug} E a chave reserva falharam`,
    message:
      `A chave da unidade ${a.slug} foi recusada (${rotulo}) e a chave reserva também falhou ` +
      `(${a.erroReserva}). O atendimento segue pro plano B de provedor; se ele também falhar, o ` +
      `paciente recebe a mensagem de instabilidade.`,
  });
}

export interface ComChaveReservaArgs<T> {
  unidade: Pick<Unit, 'id' | 'slug' | 'anthropicApiKey'>;
  /** Provedor efetivo da chamada principal. A reserva só vale para 'anthropic'. */
  provedor: string;
  /**
   * Faz a chamada. `null` = com a chave da unidade, como hoje. Uma string = refazer
   * com esta chave (mesmo modelo, mesmos parâmetros).
   */
  chamar: (chaveReserva: string | null) => Promise<T>;
  /** A reserva respondeu — pra registrar na trilha da execução. */
  aoUsarReserva?: (falha: FalhaDeChave) => void | Promise<void>;
  /** A reserva também falhou — o erro ORIGINAL sobe logo depois. */
  aoFalharReserva?: (falha: FalhaDeChave, erroReserva: unknown) => void | Promise<void>;
  /** Injeções para teste. Padrão: env, system_logs + relay, relógio. */
  chaveReserva?: string | null;
  avisar?: (a: AvisoReserva) => void;
  agora?: number;
}

async function semDerrubar(fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.warn({ err: String(err) }, 'chave-reserva: falha ao registrar (ignorada)');
  }
}

export async function comChaveReserva<T>(args: ComChaveReservaArgs<T>): Promise<T> {
  try {
    return await args.chamar(null);
  } catch (err) {
    if (args.provedor !== 'anthropic') throw err;
    const falha = ehFalhaDeChave(err);
    if (!falha) throw err;
    const reserva = args.chaveReserva !== undefined ? args.chaveReserva : chaveReservaAnthropic();
    // Reserva igual à chave da unidade falharia do mesmo jeito: não gasta a segunda chamada.
    if (!reserva || reserva === args.unidade.anthropicApiKey) throw err;

    const avisar = args.avisar ?? avisarPadrao;
    const agora = args.agora ?? Date.now();
    const { id: unitId, slug } = args.unidade;

    let resposta: T;
    try {
      resposta = await args.chamar(reserva);
    } catch (errReserva) {
      if (devoAvisar(`${slug}:reserva-falhou`, agora)) {
        avisar({ evento: 'reserva-falhou', unitId, slug, falha, erroReserva: rotuloDoErro(errReserva) });
      }
      const aoFalhar = args.aoFalharReserva;
      if (aoFalhar) await semDerrubar(() => aoFalhar(falha, errReserva));
      throw err;
    }

    if (devoAvisar(slug, agora)) avisar({ evento: 'usando-reserva', unitId, slug, falha });
    const aoUsar = args.aoUsarReserva;
    if (aoUsar) await semDerrubar(() => aoUsar(falha));
    return resposta;
  }
}
