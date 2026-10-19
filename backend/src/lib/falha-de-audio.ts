/**
 * Quando o áudio do paciente não vira texto: é passageiro (pedir pra mandar de novo resolve) ou é nosso e
 * vai continuar falhando (pedir de novo só irrita)?
 *
 * Canaã, 18–19/10/2026: a OpenAI ficou sem crédito por 21 h e TODO áudio voltava 429. A Sofia respondia
 * "seu áudio chegou cortadinho", o paciente gravava de novo, falhava de novo — 54 áudios em 15 unidades,
 * nenhum passado para a equipe. Falha estrutural (saldo, chave recusada) ou a 2ª falha seguida na mesma
 * conversa vão para a equipe, que ouve o áudio no aparelho.
 */
import { ehErroDeSaldo } from './ops-alert.js';

export class FalhaDeTranscricao extends Error {
  constructor(
    message: string,
    /** vai continuar falhando até alguém agir (saldo, chave): não adianta pedir pro paciente repetir */
    readonly estrutural: boolean,
    readonly saldo = false,
  ) {
    super(message);
    this.name = 'FalhaDeTranscricao';
  }
}

/** Resposta de erro da API da OpenAI (`{ error: { type, code, message } }`) → o que fazer. */
export function classificarErroDaOpenAI(status: number | undefined, corpo: unknown): { estrutural: boolean; saldo: boolean; resumo: string } {
  const e = (corpo as { error?: { type?: string; code?: string; message?: string } } | null)?.error ?? {};
  const texto = [e.type, e.code, e.message].filter(Boolean).join(' ');
  const saldo =
    status === 402 ||
    (status === 429 && (/insufficient_quota|credit_balance_exhausted|billing_hard_limit/i.test(texto) || ehErroDeSaldo(texto)));
  const estrutural = saldo || status === 401 || status === 403;
  return { estrutural, saldo, resumo: `${status ?? '?'}${texto ? ` ${texto.slice(0, 160)}` : ''}` };
}

export function ehFalhaEstrutural(err: unknown): boolean {
  return err instanceof FalhaDeTranscricao && err.estrutural;
}

// ── falhas seguidas por conversa (memória do processo; um deploy zera, o que só deixa mais gentil) ──

const VALIDADE_MS = 12 * 60 * 60_000;
const seguidas = new Map<string, { n: number; em: number }>();

/** Conta mais uma falha nesta conversa e devolve quantas seguidas já são. */
export function registrarFalhaDeAudio(chave: string, agora = Date.now()): number {
  const a = seguidas.get(chave);
  const n = a && agora - a.em < VALIDADE_MS ? a.n + 1 : 1;
  seguidas.set(chave, { n, em: agora });
  return n;
}

/** Um áudio transcrito zera a sequência. */
export function limparFalhasDeAudio(chave: string): void {
  seguidas.delete(chave);
}

/** Vai para a equipe: unidade que já não ouve áudio (Boa Vista), falha estrutural, ou a 2ª seguida. */
export function deveIrParaEquipe(a: { flagDaUnidade: boolean; estrutural: boolean; falhasSeguidas: number }): boolean {
  return a.flagDaUnidade || a.estrutural || a.falhasSeguidas >= 2;
}

/** Só para teste. */
export function _zerarFalhasDeAudio(): void {
  seguidas.clear();
}
