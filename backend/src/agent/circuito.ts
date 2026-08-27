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
 * Só falha de INFRAESTRUTURA conta (timeout, 5xx, conexão). Recusa legítima do
 * modelo, prompt inválido ou saldo esgotado não abrem o circuito: trocar de
 * provedor não resolveria, e abrir por isso tiraria do ar um provedor que está
 * perfeitamente de pé.
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

interface Estado {
  falhasSeguidas: number;
  abertoAte: number;
}

const estados = new Map<Provedor, Estado>();

function estadoDe(p: Provedor): Estado {
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
export function circuitoAberto(p: Provedor, agora = Date.now()): boolean {
  const e = estadoDe(p);
  if (e.abertoAte === 0) return false;
  if (agora >= e.abertoAte) {
    // Descanso acabou: solta uma tentativa. Se falhar de novo, reabre.
    e.abertoAte = 0;
    return false;
  }
  return true;
}

/** Provedor respondeu: fecha o circuito e zera o histórico. */
export function registrarSucesso(p: Provedor): void {
  const e = estadoDe(p);
  e.falhasSeguidas = 0;
  e.abertoAte = 0;
}

/**
 * Provedor falhou por infraestrutura. Devolve true quando esta falha foi a que
 * abriu o circuito — quem chamou pode querer registrar isso.
 */
export function registrarFalha(p: Provedor, agora = Date.now()): boolean {
  const e = estadoDe(p);
  e.falhasSeguidas++;
  if (e.falhasSeguidas >= FALHAS_PARA_ABRIR && e.abertoAte <= agora) {
    e.abertoAte = agora + DESCANSO_MS;
    return true;
  }
  return false;
}

/**
 * Distingue "o provedor está fora" de "o provedor respondeu e disse não".
 * Só o primeiro justifica cortar o tráfego.
 */
export function ehFalhaDeInfra(err: unknown): boolean {
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

/** Retrato pro painel e pros testes. */
export function estadoDoCircuito(agora = Date.now()): Array<{
  provedor: Provedor;
  aberto: boolean;
  falhasSeguidas: number;
  voltaEmMs: number;
}> {
  return (['anthropic', 'openai', 'google'] as Provedor[]).map((p) => {
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
