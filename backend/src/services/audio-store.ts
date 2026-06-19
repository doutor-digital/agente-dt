// ============================================================================
// audio-store.ts — Cache em memória de áudios gerados (TTS) pra servir via URL.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Pra mandar áudio pelo Kommo, o Salesbot precisa de um LINK público do arquivo
// (`[https://.../audio/xyz.ogg]` no campo "Resposta IA"). Como ainda NÃO temos
// bucket (S3/GCS), guardamos o buffer do áudio aqui em memória e expomos numa
// rota GET pública (`/audio/:file`). O Kommo busca esse link e entrega ao
// paciente.
//
// É uma solução de TESTE: serve o suficiente pro Kommo baixar logo após a
// geração. TTL curto (10 min) + prune evita vazar memória. Quando virar
// produção, trocar por storage real (o resto do fluxo não muda — só a origem
// da URL).
// ============================================================================

import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';

interface AudioEntry {
  buf: Buffer;
  contentType: string;
  ext: string;
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000; // 10 min — o Kommo busca em segundos.
const store = new Map<string, AudioEntry>();

/** Remove entradas expiradas. Chamado a cada put — barato e suficiente. */
function prune(now: number): void {
  for (const [id, entry] of store) {
    if (entry.expiresAt <= now) store.delete(id);
  }
}

/** Guarda um áudio e retorna o id pra montar a URL pública. */
export function putAudio(buf: Buffer, contentType: string, ext: string): string {
  const now = Date.now();
  prune(now);
  const id = randomUUID();
  store.set(id, { buf, contentType, ext, expiresAt: now + TTL_MS });
  logger.debug({ id, bytes: buf.byteLength, ext, cached: store.size }, 'audio-store: áudio guardado');
  return id;
}

/** Busca um áudio pelo id (sem a extensão). undefined = inexistente/expirado. */
export function getAudio(id: string): AudioEntry | undefined {
  const entry = store.get(id);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.delete(id);
    return undefined;
  }
  return entry;
}
