/**
 * Ponte entre o webhook `/kommo` e o `/widget` pro caso de áudio.
 *
 * No modo widget o Salesbot só nos manda `{{message_text}}`, que vem VAZIO
 * quando o paciente grava um áudio — o link do arquivo não passa por ali. Quem
 * enxerga o anexo é o webhook `add_message`, que chega alguns instantes antes.
 * Então o webhook deposita o link aqui e o `/widget` vem buscar.
 *
 * Guardado em memória e com TTL curto: se o widget não vier atrás em poucos
 * minutos, o áudio perdeu a validade e a conversa segue em texto.
 */
interface Entry {
  audioUrl: string;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const MAX_SIZE = 2_000;

const store = new Map<string, Entry>();

function key(unitId: string, leadId: number | string): string {
  return `${unitId}:${leadId}`;
}

function purgeExpired(now: number): void {
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
}

export function rememberIncomingAudio(unitId: string, leadId: number | string, audioUrl: string): void {
  if (!audioUrl) return;
  const now = Date.now();
  if (store.size >= MAX_SIZE) purgeExpired(now);
  store.set(key(unitId, leadId), { audioUrl, expiresAt: now + TTL_MS });
}

/** Consome o registro: devolve o link uma vez só e some com ele. */
export function takeIncomingAudio(unitId: string, leadId: number | string): string | null {
  const k = key(unitId, leadId);
  const entry = store.get(k);
  if (!entry) return null;
  store.delete(k);
  if (entry.expiresAt <= Date.now()) return null;
  return entry.audioUrl;
}

export function _pendingAudioStats(): { size: number } {
  return { size: store.size };
}

export function clearPendingAudio(): number {
  const n = store.size;
  store.clear();
  return n;
}
