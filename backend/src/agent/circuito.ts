/**
 * Disjuntor por provedor de IA.
 *
 * Sem isto, provedor fora do ar custa o tempo INTEIRO de espera em toda
 * mensagem: 35s no principal mais 20s no plano B, por paciente, indefinidamente.
 * Enquanto isso o paciente espera quase um minuto para receber "tive uma
 * instabilidade" — e a próxima mensagem dele paga a conta de novo.
 *
 * A ideia é simples: depois de N falhas seguidas do MESMO provedor, para de
 * tentar por um tempo e vai direto pro plano B. Uma tentativa isolada volta a
 * passar quando o descanso termina — se der certo, o circuito fecha; se falhar,
 * abre de novo. Assim o provedor volta sozinho quando se recuperar, sem
 * ninguém precisar mexer.
 *
 * Só falha de INFRAESTRUTURA conta nas três seguidas (timeout, 5xx, conexão).
 * Recusa legítima do modelo e prompt inválido não abrem o circuito: trocar de
 * provedor não resolveria, e abrir por isso tiraria do ar um provedor que está
 * perfeitamente de pé. Saldo/cota esgotados é caso à parte: abre NA HORA por
 * `abrirCircuito` (a cadeia de reserva, `cadeia-reserva.ts`, decide quando).
 *
 * O estado vive em memória: cada réplica aprende por conta. É de propósito —
 * compartilhar em banco custaria uma ida ao Postgres em toda mensagem para
 * proteger contra alguns segundos a mais de espera na réplica que ainda não
 * aprendeu. Numa operação de uma réplica, é o suficiente.
 */

export type Provedor = 'anthropic' | 'openai' | 'google';

/** Falhas seguidas antes de cortar. Uma sozinha é ruído; três seguidas é padrão. */
const FALHAS_PARA_ABRIR = Number(process.env.CIRCUITO_FALHAS) || 3;

/** Quanto tempo fica cortado antes de deixar passar uma tentativa. */
const DESCANSO_MS = Number(process.env.CIRCUITO_DESCANSO_MS) || 60_000;

/** Descanso de um provedor sem saldo/cota: a sonda é barata (erro volta na hora), mas saldo não volta em segundos. */
const DESCANSO_SALDO_MS = Number(process.env.CIRCUITO_SALDO_DESCANSO_MS) || 120_000;

interface Estado {
  falhasSeguidas: number;
  abertoAte: number;
}

/** Chave = o provedor (infra) ou "provedor:escopo" (saldo, que é por chave/conta — ver `chaveDeSaldo`). */
const estados = new Map<string, Estado>();

function estadoDe(p: string): Estado {
  let e = estados.get(p);
  if (!e) {
    e = { falhasSeguidas: 0, abertoAte: 0 };
    estados.set(p, e);
  }
  return e;
}

/**
 * Decide se vale tentar este provedor agora.
 * Quando o descanso termina, deixa passar UMA tentativa para sondar.
 */
export function circuitoAberto(p: string, agora = Date.now()): boolean {
  // Consultar não cria entrada (há uma chave de saldo por unidade): só quem já falhou ou abriu tem estado.
  const e = estados.get(p);
  if (!e || e.abertoAte === 0) return false;
  if (agora >= e.abertoAte) {
    // Descanso acabou: solta uma tentativa. Se falhar de novo, reabre.
    e.abertoAte = 0;
    return false;
  }
  return true;
}

/** Provedor respondeu: fecha o circuito e zera o histórico. */
export function registrarSucesso(p: string): void {
  const e = estadoDe(p);
  e.falhasSeguidas = 0;
  e.abertoAte = 0;
}

/**
 * Provedor falhou por infraestrutura. Devolve true quando esta falha foi a que
 * abriu o circuito — quem chamou pode querer registrar isso.
 */
export function registrarFalha(p: string, agora = Date.now()): boolean {
  const e = estadoDe(p);
  e.falhasSeguidas++;
  if (e.falhasSeguidas >= FALHAS_PARA_ABRIR && e.abertoAte <= agora) {
    e.abertoAte = agora + DESCANSO_MS;
    return true;
  }
  return false;
}

/**
 * Corta o provedor AGORA, sem esperar três falhas: serve para erro que não passa sozinho — saldo/cota
 * esgotados (ver `erro-de-saldo.ts`). Insistir só gasta uma chamada por mensagem. Depois do descanso
 * uma tentativa sonda; se o saldo voltou, o circuito fecha sozinho (`registrarSucesso`).
 * O descanso é maior que o de infra (que sonda por um timeout caro); aqui a sonda é barata, mas
 * não precisa ser a cada minuto.
 */
export function abrirCircuito(p: string, agora = Date.now(), descansoMs = DESCANSO_SALDO_MS): void {
  const e = estadoDe(p);
  e.abertoAte = agora + descansoMs;
}

/** Lançado quando o circuito de SALDO da chave está aberto e a chamada nem é feita. Nunca conta como falha de infra. */
export class CircuitoDeSaldoAbertoError extends Error {
  constructor(public readonly chave: string) {
    super(`circuito de saldo aberto (${chave}) — chamada não feita`);
    this.name = 'CircuitoDeSaldoAbertoError';
  }
}

/**
 * Distingue "o provedor está fora" de "o provedor respondeu e disse não".
 * Só o primeiro justifica cortar o tráfego.
 */
export function ehFalhaDeInfra(err: unknown): boolean {
  // Pular por circuito de SALDO aberto não é falha do provedor: contar aqui deixaria a unidade sem crédito
  // (três mensagens bastam) cortar o provedor da rede toda.
  if (err instanceof CircuitoDeSaldoAbertoError) return false;
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  const nome = err instanceof Error ? err.name : '';

  if (nome === 'LlmTimeoutError') return true;
  if (/\b(etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up)\b/.test(msg)) return true;
  if (/\b(timeout|timed out)\b/.test(msg)) return true;
  if (/\b(overloaded|service unavailable|bad gateway|gateway timeout)\b/.test(msg)) return true;

  const status = (err as { status?: number; response?: { status?: number } })?.status
    ?? (err as { response?: { status?: number } })?.response?.status;
  if (typeof status === 'number' && status >= 500) return true;

  // 429 é ambíguo: pode ser excesso nosso (passa) ou saldo/cota (não adianta
  // insistir, mas também não é o provedor fora). Fica de fora dos dois lados.
  return false;
}

/**
 * Retrato pro painel e pros testes: os três provedores (circuito de infra) e, se existirem, os circuitos de SALDO por chave
 * ("anthropic:<unidade>", "openai:ambiente", "google:reserva") que já foram abertos alguma vez.
 */
export function estadoDoCircuito(agora = Date.now()): Array<{
  provedor: string;
  aberto: boolean;
  falhasSeguidas: number;
  voltaEmMs: number;
}> {
  const chaves = new Set<string>(['anthropic', 'openai', 'google']);
  for (const k of estados.keys()) chaves.add(k);
  return [...chaves].map((p) => {
    const e = estadoDe(p);
    return {
      provedor: p,
      aberto: e.abertoAte > agora,
      falhasSeguidas: e.falhasSeguidas,
      voltaEmMs: e.abertoAte > agora ? e.abertoAte - agora : 0,
    };
  });
}

/** Só para teste — zera tudo entre casos. */
export function resetarCircuitos(): void {
  estados.clear();
}
