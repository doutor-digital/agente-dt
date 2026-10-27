/**
 * Juiz da IA — as partes PURAS (sem banco, sem rede) do "juiz novo" (27/10/2026).
 *
 * Medido em produção: ~77 % das notas baixas NÃO eram falha da Sofia — o juiz dava nota a conversa que
 * não dava para avaliar (paciente sumiu depois da 1ª fala, Sofia nem chegou a falar por pausa, mídia que
 * não abriu) e, quando o JSON quebrava, gravava nota 0 com "(sem veredito)", que entra na média igual.
 * Aqui ficam as três peças do conserto, todas atrás de chave no serviço (o padrão continua sendo o juiz
 * de hoje, gpt-4o-mini):
 *
 *   1. quem julga: `JUDGE_PROVIDER=openai|anthropic` (Haiku 5.5 com saída estruturada);
 *   2. quem merece nota: `avaliabilidadeDaConversa` — função pura, para NÃO chamar o modelo à toa;
 *   3. leitura ESTRITA da resposta: JSON quebrado vira `null` (erro, sem avaliação), nunca nota 0.
 *
 * `montarPedidoAnthropic` devolve o corpo da Messages API cru. É o mesmo corpo que o `params` de um item
 * do Message Batches (`custom_id` = id da conversa) — trocar a chamada síncrona por lote não mexe no
 * schema nem no leitor da resposta.
 */
import { ehAvisoDeMensagemNaoRenderizada, AVISO_PARA_IA } from './mensagem-nao-renderizada.js';

// ── 1. quem julga ─────────────────────────────────────────────────────────────────────────────────

export type ProvedorDoJuiz = 'openai' | 'anthropic';

export const MODELO_PADRAO_OPENAI = 'gpt-4o-mini';
export const MODELO_PADRAO_ANTHROPIC = 'claude-haiku-5-5';

/**
 * Preço do Haiku 5.5 (US$/MTok), usado só quando `calculateCost` do openai.service ainda não conhece o
 * modelo (devolve 0). Quando o MODEL_PRICES de lá ganhar `claude-haiku-5-5`, este fallback deixa de valer.
 */
export const PRECO_FALLBACK_ANTHROPIC: Record<string, { entrada: number; saida: number }> = {
  [MODELO_PADRAO_ANTHROPIC]: { entrada: 0.1, saida: 0.5 },
};

export interface EscolhaDoJuiz {
  provedor: ProvedorDoJuiz;
  modelo: string;
  /** Chave a usar; `null` só quando o provedor é openai (a chave dele é resolvida no serviço, como sempre). */
  apiKeyAnthropic: string | null;
  /** Preenchido quando pediram `anthropic` e voltamos para openai — vai para o log. */
  motivoDoFallback?: string;
}

type EnvLike = Record<string, string | undefined>;

/**
 * Decide o provedor. Qualquer valor que não seja exatamente `anthropic` é openai (comportamento de hoje).
 * `anthropic` sem chave (nem da unidade nem de env) cai para openai COM motivo, em vez de parar o juiz.
 */
export function escolherJuiz(env: EnvLike, unit: { anthropicApiKey?: string | null } | null): EscolhaDoJuiz {
  const modeloOpenai = env.JUDGE_MODEL ?? MODELO_PADRAO_OPENAI;
  const pedido = (env.JUDGE_PROVIDER ?? '').trim().toLowerCase();
  if (pedido !== 'anthropic') return { provedor: 'openai', modelo: modeloOpenai, apiKeyAnthropic: null };

  const chave = unit?.anthropicApiKey?.trim() || env.JUDGE_ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim() || null;
  if (!chave) {
    return {
      provedor: 'openai',
      modelo: modeloOpenai,
      apiKeyAnthropic: null,
      motivoDoFallback: 'JUDGE_PROVIDER=anthropic mas a unidade não tem anthropicApiKey e não há ANTHROPIC_API_KEY',
    };
  }
  // JUDGE_MODEL sobrescreve, mas só se for um modelo da Anthropic — "gpt-4o-mini" mandado à Messages API é 404.
  const sobrescrito = env.JUDGE_MODEL?.trim();
  const modelo = sobrescrito && sobrescrito.startsWith('claude') ? sobrescrito : MODELO_PADRAO_ANTHROPIC;
  return { provedor: 'anthropic', modelo, apiKeyAnthropic: chave };
}

export type EsforcoDoJuiz = 'low' | 'medium' | 'high' | null;

/** `JUDGE_ANTHROPIC_EFFORT`: low (padrão) | medium | high | off (não manda o parâmetro). */
export function esforcoDoJuiz(env: EnvLike): EsforcoDoJuiz {
  const v = (env.JUDGE_ANTHROPIC_EFFORT ?? 'low').trim().toLowerCase();
  if (v === 'off' || v === 'none' || v === '') return null;
  return v === 'medium' || v === 'high' ? v : 'low';
}

// ── 2. quem merece nota ───────────────────────────────────────────────────────────────────────────

export interface MensagemDoJuiz {
  role: string;
  content: string;
}

export type MotivoNaoAvaliavel = 'sem_fala_real_do_paciente' | 'ia_nao_falou' | 'paciente_falou_pouco';

export type Avaliabilidade =
  | { avaliavel: true; falasReais: number; falasDaIa: number }
  | { avaliavel: false; motivo: MotivoNaoAvaliavel; falasReais: number; falasDaIa: number };

/** Marcas que o webhook grava no lugar da fala quando a mídia não abriu. */
const MARCA_ILEGIVEL = /não foi possível ler|não deu pra ouvir|sem fala detectada|sem conteúdo legível|não conseguiu abrir/i;

/**
 * O que sobra de uma mensagem do paciente depois de tirar as marcas de "não abriu". Texto com mídia ilegível
 * junto ("Já paguei" + PDF que não abriu) continua sendo fala real; só a marca sozinha não é.
 */
export function falaReal(conteudo: string | null | undefined): string {
  let t = String(conteudo ?? '').trim();
  if (!t) return '';
  if (ehAvisoDeMensagemNaoRenderizada(t) || t.includes(AVISO_PARA_IA)) return '';
  t = t.replace(/\[[^\]]*\]/g, (trecho) => (MARCA_ILEGIVEL.test(trecho) ? '' : trecho));
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * A conversa merece nota? Critérios medidos em 27/10 (3.063 conversas; 48 notas baixas lidas):
 *   - paciente sem NENHUMA fala real (só mídia ilegível, vazias, aviso do Kommo) → nada a julgar;
 *   - a IA não falou (pausa `__paused__`, `__paused_by_unit__`, `__stage_not_allowed__`) → não é a Sofia;
 *   - o paciente falou menos que `minFalasReais` (padrão 2: "sumiu depois da 1ª fala") → objeção/CTA não
 *     existem para medir.
 * Conversa assumida por humano NÃO entra: o banco não grava a fala da equipe (só 'user'/'assistant' da IA),
 * então não há como saber aqui — fica para quando a mensagem da equipe for gravada.
 */
export function avaliabilidadeDaConversa(
  mensagens: ReadonlyArray<MensagemDoJuiz>,
  opcoes: { minFalasReais?: number } = {},
): Avaliabilidade {
  const minFalasReais = Math.max(1, opcoes.minFalasReais ?? 2);
  let falasReais = 0;
  let falasDaIa = 0;
  for (const m of mensagens) {
    if (m.role === 'user' && falaReal(m.content)) falasReais++;
    else if (m.role === 'assistant' && String(m.content ?? '').trim()) falasDaIa++;
  }
  if (falasReais === 0) return { avaliavel: false, motivo: 'sem_fala_real_do_paciente', falasReais, falasDaIa };
  if (falasDaIa === 0) return { avaliavel: false, motivo: 'ia_nao_falou', falasReais, falasDaIa };
  if (falasReais < minFalasReais) return { avaliavel: false, motivo: 'paciente_falou_pouco', falasReais, falasDaIa };
  return { avaliavel: true, falasReais, falasDaIa };
}

// ── 3. saída estruturada e leitura estrita ────────────────────────────────────────────────────────

export const CHAVES_DE_NOTA = ['clareza', 'empatia', 'objecoes', 'cta', 'tom'] as const;

export interface NotasDoJuiz {
  clareza: number;
  empatia: number;
  objecoes: number;
  cta: number;
  tom: number;
}

/**
 * JSON Schema da resposta (saída estruturada da Anthropic). A Anthropic não aceita `minimum`/`maximum` em
 * número, então o 0–10 vai na descrição e o leitor limita (clamp) do mesmo jeito que o do OpenAI.
 */
export const SCHEMA_DO_JUIZ = {
  type: 'object',
  properties: {
    scores: {
      type: 'object',
      properties: Object.fromEntries(
        CHAVES_DE_NOTA.map((k) => [k, { type: 'number', description: 'Nota de 0 a 10' }]),
      ),
      required: [...CHAVES_DE_NOTA],
      additionalProperties: false,
    },
    verdict: { type: 'string', description: 'Veredito curto (3 a 5 frases)' },
  },
  required: ['scores', 'verdict'],
  additionalProperties: false,
} as const;

const limitar = (n: number): number => Math.max(0, Math.min(10, n));

/**
 * Leitura ESTRITA: só devolve resultado se a resposta é um JSON com as 5 notas numéricas e um veredito.
 * Qualquer outra coisa é `null` — quem chama registra o erro e NÃO grava avaliação (a próxima varredura
 * tenta de novo). O leitor antigo (`parseJudgeOutput`) transformava isso em nota 0 + "(sem veredito)".
 */
export function interpretarSaidaDoJuiz(raw: string): { scores: NotasDoJuiz; verdict: string } | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const { scores, verdict } = obj as { scores?: unknown; verdict?: unknown };
  if (!scores || typeof scores !== 'object') return null;
  if (typeof verdict !== 'string' || !verdict.trim()) return null;
  const s = scores as Record<string, unknown>;
  const notas: Record<string, number> = {};
  for (const k of CHAVES_DE_NOTA) {
    const v = s[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    notas[k] = limitar(v);
  }
  return { scores: notas as unknown as NotasDoJuiz, verdict: verdict.slice(0, 4000) };
}

/** Texto da resposta do ChatAnthropic: `content` é string ou lista de blocos; só os `text` contam. */
export function textoDaResposta(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .join('');
}

/** `refusal` e `max_tokens` cortam o JSON no meio: nunca confiar na saída. */
export function respostaCortada(stopReason: unknown): boolean {
  return stopReason === 'refusal' || stopReason === 'max_tokens';
}

// ── pedido à Messages API (e, depois, ao Batch) ───────────────────────────────────────────────────

export const MAX_TOKENS_DO_JUIZ = 1024;

export interface PedidoAnthropic {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: 'user'; content: string }>;
  /** Haiku 5.5 liga o raciocínio adaptativo sozinho; o juiz não precisa e ele custa token de saída. */
  thinking: { type: 'disabled' };
  output_config: { effort?: 'low' | 'medium' | 'high'; format: { type: 'json_schema'; schema: Record<string, unknown> } };
}

/**
 * Corpo da Messages API. SEM `temperature`/`top_p`: o Haiku 5.5 devolve 400 para valor fora do padrão.
 * É também o `params` de um item do Message Batches — quando o lote entrar, `custom_id` = id da conversa.
 */
export function montarPedidoAnthropic(a: {
  modelo: string;
  system: string;
  user: string;
  esforco: EsforcoDoJuiz;
}): PedidoAnthropic {
  return {
    model: a.modelo,
    max_tokens: MAX_TOKENS_DO_JUIZ,
    system: a.system,
    messages: [{ role: 'user', content: a.user }],
    thinking: { type: 'disabled' },
    output_config: {
      ...(a.esforco ? { effort: a.esforco } : {}),
      format: { type: 'json_schema', schema: SCHEMA_DO_JUIZ as unknown as Record<string, unknown> },
    },
  };
}

/** Custo quando o `calculateCost` do openai.service não conhece o modelo (devolveu 0). */
export function custoComFallback(modelo: string, custoCalculado: number, promptTokens: number, completionTokens: number): number {
  if (custoCalculado > 0) return custoCalculado;
  const p = PRECO_FALLBACK_ANTHROPIC[modelo];
  if (!p) return custoCalculado;
  return Math.round(((promptTokens / 1e6) * p.entrada + (completionTokens / 1e6) * p.saida) * 1e6) / 1e6;
}
