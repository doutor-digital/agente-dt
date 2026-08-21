import axios from 'axios';
import type { Unit } from '@prisma/client';
import { resolveOpenAIApiKey } from './openai.service.js';

const EMBED_URL = 'https://api.openai.com/v1/embeddings';
const EMBED_MODEL = 'text-embedding-3-small';

export interface EmbedInput {
  unit: Pick<Unit, 'openaiApiKey'>;
  texts: string[];
}

export interface EmbedResult {
  vectors: number[][];
}

export async function embedTexts({ unit, texts }: EmbedInput): Promise<EmbedResult> {
  const apiKey = resolveOpenAIApiKey(unit);
  if (!apiKey) throw new Error('Nenhuma chave OpenAI disponível — embedding bloqueado');
  if (texts.length === 0) return { vectors: [] };

  const { data } = await axios.post<{ data: Array<{ embedding: number[] }> }>(
    EMBED_URL,
    { model: EMBED_MODEL, input: texts, encoding_format: 'float' },
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 30_000,
    },
  );
  return { vectors: data.data.map((d) => d.embedding) };
}

export function cosineSim(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
