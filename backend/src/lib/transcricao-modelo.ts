// Funções puras da transcrição do conector (sem env/config): usadas pelo serviço e pelo transcricao-audio.

/**
 * Modelo da transcrição do conector (TRANSCRICAO_MODELO). Padrão `gpt-4o-transcribe` (lida melhor com áudio ruim de câmera, pedido da
 * Suzanne/Lia em 04/11). Ele NÃO devolve segmentos: quem chama corta o áudio em pedaços curtos e cada pedaço vira um segmento.
 * `whisper-1` continua valendo (segmentos e tempos nativos) — é só pôr TRANSCRICAO_MODELO=whisper-1.
 */
export function modeloDeTranscricao(e: NodeJS.ProcessEnv = process.env): string {
  return e.TRANSCRICAO_MODELO?.trim() || 'gpt-4o-transcribe';
}

/** Média dos logprobs dos tokens (o gpt-4o-*-transcribe devolve com include[]=logprobs); sem tokens = -1 (confiança desconhecida, não boa). */
export function mediaLogprob(logprobs: ReadonlyArray<{ logprob?: number }> | undefined): number {
  const v = (logprobs ?? []).map((t) => t.logprob).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : -1;
}
