// ============================================================================
// llm-policy.ts — política de resiliência do nó da IA (timeout + fallback).
//
// O cliente do modelo (openai.service) já tem timeout por chamada + maxRetries
// no nível HTTP. O que faltava era o COMPORTAMENTO quando isso tudo esgota: hoje
// o erro sobe e o paciente fica no vácuo (conversa travada). Aqui centralizamos:
//
//   - `withTimeout` — backstop pra travamento infinito (o invoke que nunca volta).
//   - `FALLBACK_INDISPONIVEL` — a frase educada que vai no lugar do silêncio.
//
// O nó do grafo (graph.ts) envolve a chamada do modelo com isto e, na falha,
// entrega o fallback em vez de deixar o turno morrer. Complementa a RetryPolicy
// nativa do LangGraph (retry do nó) — que não sabe entregar uma mensagem de
// fallback, só relança.
// ============================================================================

// Backstop pro caso do invoke NUNCA voltar. Fica ACIMA do pior caso do cliente
// (timeout 15s × (1+maxRetries)) de propósito: não é pra cortar resposta lenta
// porém válida — é rede de segurança. Ajustável por env.
export const AGENT_NODE_TIMEOUT_MS = Number(process.env.AGENT_NODE_TIMEOUT_MS) || 35000;

// Mensagem quando a IA fica indisponível. Curta, humana, sem "erro de sistema".
export const FALLBACK_INDISPONIVEL =
  'Opa, tive uma instabilidade rapidinha aqui do meu lado 🙈 Pode mandar de novo? Já te respondo.';

export class LlmTimeoutError extends Error {
  constructor(ms: number) {
    super(`IA não respondeu em ${ms}ms`);
    this.name = 'LlmTimeoutError';
  }
}

/** Corre a promessa contra um timeout. Rejeita com LlmTimeoutError se estourar. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LlmTimeoutError(ms)), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}
