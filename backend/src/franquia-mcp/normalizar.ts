/**
 * O que a franquia devolve e o relatório precisa em outro formato:
 *  - datas em UTC (§9.2) → também no horário local da unidade;
 *  - WhatsApp só com dígitos → também em +55DDNNNNNNNNN, a chave pra cruzar com o Kommo.
 * Os campos originais ficam intactos; os novos entram ao lado (`<campo>Local`, `<campo>E164`).
 */

/**
 * Data com hora. Sem fuso explícito vale a regra do guia (§9.2: "datas retornadas em UTC"); com
 * `Z`, `±hh:mm` ou `±hhmm`, vale o fuso escrito. Só data (`2026-05-10`) não é instante: fica de fora.
 */
const ISO_DATA_HORA = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/;
const CAMPO_TELEFONE = /whats|phone|telefone|celular/i;

const formatadores = new Map<string, Intl.DateTimeFormat>();

function formatador(fuso: string): Intl.DateTimeFormat {
  let f = formatadores.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: fuso,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatadores.set(fuso, f);
  }
  return f;
}

/** `2026-09-08T20:00:00.000Z` em São Paulo → `2026-09-08T17:00:00`. */
export function instanteNoFuso(d: Date, fuso: string): string {
  const p: Record<string, string> = {};
  for (const parte of formatador(fuso).formatToParts(d)) p[parte.type] = parte.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/** Hora local de um valor de data-hora da franquia; `null` se não for um. */
export function paraLocal(valor: unknown, fuso: string): string | null {
  if (typeof valor !== 'string') return null;
  const m = ISO_DATA_HORA.exec(valor.trim());
  if (!m) return null;
  const zona = !m[3] || m[3] === 'Z' ? 'Z' : m[3].includes(':') ? m[3] : `${m[3].slice(0, 3)}:${m[3].slice(3)}`;
  const d = new Date(`${m[1]}T${m[2]}${zona}`);
  return Number.isNaN(d.getTime()) ? null : instanteNoFuso(d, fuso);
}

/** Dia local (`YYYY-MM-DD`) de um valor de data-hora da franquia; `null` se não for um. */
export function diaLocal(valor: unknown, fuso: string): string | null {
  return paraLocal(valor, fuso)?.slice(0, 10) ?? null;
}

/**
 * Celular brasileiro em +55DDNNNNNNNNN. Aceita com ou sem 55, com ou sem máscara.
 * Qualquer outra coisa vira `null` — número errado como chave junta pacientes diferentes.
 */
export function normalizarWhatsapp(valor: unknown): string | null {
  if (typeof valor !== 'string' && typeof valor !== 'number') return null;
  const digitos = String(valor).replace(/\D/g, '');
  if (/^55\d{10,11}$/.test(digitos)) return `+${digitos}`;
  if (/^\d{10,11}$/.test(digitos)) return `+55${digitos}`;
  return null;
}

/** Cópia rasa do item com os campos `…Local` e `…E164` acrescentados. */
export function normalizarItem(item: unknown, fuso: string): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const saida: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const [chave, valor] of Object.entries(item)) {
    const local = paraLocal(valor, fuso);
    if (local !== null) saida[`${chave}Local`] = local;
    if (CAMPO_TELEFONE.test(chave)) {
      const e164 = normalizarWhatsapp(valor);
      if (e164 !== null) saida[`${chave}E164`] = e164;
    }
  }
  return saida;
}
