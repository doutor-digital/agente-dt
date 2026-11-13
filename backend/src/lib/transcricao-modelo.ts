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

/** O texto de instrução que a `transcribeAudio` mandava como `prompt` até 13/11/2026. Fica só para reconhecer o eco dele. */
export const INSTRUCAO_ANTIGA_DE_TRANSCRICAO =
  'Paciente brasileiro falando com uma clínica de fisioterapia e reabilitação ortopédica. ' +
  'Assuntos comuns: dor na coluna, lombar, ombro, joelho, quadril, hérnia de disco, ' +
  'fisioterapia, pilates, consulta, agendamento, valor.';

const palavras = (t: string): string[] =>
  t.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);

/**
 * A transcrição é o próprio texto de instrução devolvido pelo modelo (áudio mudo/curto)? Igual, contido ou quase igual.
 * Fala curta legítima ("dor na lombar") está CONTIDA na instrução, então "contido" só vale a partir de 8 palavras e quando
 * ao menos 80% dos pares de palavras seguidas do texto estão na instrução.
 */
export function ehEcoDeInstrucao(transcricao: string, instrucao: string): boolean {
  const t = palavras(transcricao);
  const i = palavras(instrucao);
  if (!t.length || !i.length) return false;
  if (t.join(' ') === i.join(' ')) return true;
  if (t.length < 8) return false;
  const pares = (w: string[]) => w.slice(1).map((x, k) => `${w[k]} ${x}`);
  const dela = new Set(pares(i));
  const nossos = pares(t);
  return nossos.filter((p) => dela.has(p)).length / nossos.length >= 0.8;
}
