export const AGENT_NODE_TIMEOUT_MS = Number(process.env.AGENT_NODE_TIMEOUT_MS) || 35000;

export const FALLBACK_INDISPONIVEL =
  'Opa, tive uma instabilidade rapidinha aqui do meu lado 🙈 Pode mandar de novo? Já te respondo.';

/**
 * Dita quando a conversa passou do teto de gasto. Não menciona custo — isso é
 * problema nosso, não do paciente — e não pede pra ele repetir nada, porque
 * quem vai continuar é uma pessoa, que já tem o histórico na frente.
 */
export const FALLBACK_TETO =
  'Vou te passar agora pra uma pessoa da equipe continuar seu atendimento, tá? ' +
  'Ela já está com todo o nosso papo aqui e te responde em instantes 🙂';

export interface PlanoB {
  provider: 'anthropic' | 'openai' | 'google';
  modelName: string;
}

interface UnitCreds {
  llmProvider: string | null;
  anthropicApiKey: string | null;
  anthropicModel: string | null;
  openaiApiKey: string | null;
  openaiModel: string | null;
  googleApiKey: string | null;
  googleModel: string | null;
}

export function escolherPlanoB(unit: UnitCreds, temChaveOpenAiNoAmbiente: boolean): PlanoB | null {
  const principal = unit.llmProvider ?? 'openai';

  const anthropicDisponivel = !!unit.anthropicApiKey;
  const openaiDisponivel = !!unit.openaiApiKey || temChaveOpenAiNoAmbiente;
  const googleDisponivel = !!unit.googleApiKey;

  if (principal === 'anthropic') {
    if (openaiDisponivel) return { provider: 'openai', modelName: unit.openaiModel || 'gpt-4o-mini' };
    if (googleDisponivel) return { provider: 'google', modelName: unit.googleModel || 'gemini-2.5-flash' };
    return null;
  }
  if (principal === 'google') {
    if (anthropicDisponivel) return { provider: 'anthropic', modelName: unit.anthropicModel || 'claude-opus-4-8' };
    if (openaiDisponivel) return { provider: 'openai', modelName: unit.openaiModel || 'gpt-4o-mini' };
    return null;
  }
  if (anthropicDisponivel) return { provider: 'anthropic', modelName: unit.anthropicModel || 'claude-opus-4-8' };
  if (googleDisponivel) return { provider: 'google', modelName: unit.googleModel || 'gemini-2.5-flash' };
  return null;
}

export const PLANO_B_TIMEOUT_MS = Number(process.env.AGENT_FALLBACK_TIMEOUT_MS) || 20000;

export class LlmTimeoutError extends Error {
  constructor(ms: number) {
    super(`IA não respondeu em ${ms}ms`);
    this.name = 'LlmTimeoutError';
  }
}

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
