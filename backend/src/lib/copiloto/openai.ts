/** A chamada ao modelo (OpenAI, chave própria do Copiloto). Só fala com a API; todo o resto é testado sem rede. */
import type { ChamarModelo } from './responder.js';

export const MODELO_PADRAO_DO_COPILOTO = 'gpt-4.1-mini';

export function chamarOpenAi(chave: string, modelo: string = MODELO_PADRAO_DO_COPILOTO): ChamarModelo {
  return async ({ system, user }) => {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${chave}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelo,
        temperature: 0.2,
        max_tokens: 600,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await resp.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: unknown;
    };
    if (!resp.ok || data.error) throw new Error(`OpenAI ${resp.status}: ${JSON.stringify(data.error ?? '').slice(0, 160)}`);
    return {
      texto: data.choices?.[0]?.message?.content ?? '',
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    };
  };
}
