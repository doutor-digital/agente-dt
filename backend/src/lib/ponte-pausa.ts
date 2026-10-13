/**
 * Ponte, fase 2 — "Pausar a Sofia neste paciente" pelo painel do WhatsApp Web (13/10/2026).
 *
 * A pausa em si é a MESMA do widget "Pausar a Sofia" (`pausa-lead.ts`): a linha em `lead_pausas` manda na
 * Sofia, a caixinha "Pausar IA" vai junto para os Salesbots, e o worker de vencimento solta sozinho. Aqui
 * fica só a leitura PURA do pedido que a extensão manda, com as regras de sempre (`validarPausaDoLead`:
 * fim no futuro e no máximo 30 dias). A extensão calcula o `ate` das opções (amanhã 8h, 3 dias, 1 semana,
 * escolher a data) no relógio da atendente; quem decide se vale é o servidor.
 */
import { PAUSA_LEAD_MAX_DIAS, validarPausaDoLead } from './pausa-lead-regras.js';

export { PAUSA_LEAD_MAX_DIAS };

export interface PedidoDePausa {
  leadId: number;
  ate: Date;
  motivo: string | null;
  /** O nome da atendente (opções da extensão, "Seu nome"). */
  por: string | null;
}

export type Lido<T> = { ok: true; pedido: T } | { ok: false; erro: string };

/** Texto livre que vai para o banco e para o painel: uma linha só, sem caractere de controle, com teto. */
export function textoCurto(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/** Id de cartão vindo do corpo: inteiro positivo (aceita string de dígitos). */
export function leadIdDoPedido(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

/** `POST …/ponte/pausa` → `{ leadId, ate (ISO), motivo?, por? }`. */
export function lerPedidoDePausa(corpo: unknown, agora: Date = new Date()): Lido<PedidoDePausa> {
  const b = (corpo && typeof corpo === 'object' ? corpo : {}) as Record<string, unknown>;
  const leadId = leadIdDoPedido(b.leadId);
  if (!leadId) return { ok: false, erro: 'lead inválido' };
  if (typeof b.ate !== 'string' || b.ate.trim().length < 10) return { ok: false, erro: 'data de retorno inválida' };
  const ate = new Date(b.ate.trim());
  const erro = validarPausaDoLead(ate, agora);
  if (erro) return { ok: false, erro };
  return { ok: true, pedido: { leadId, ate, motivo: textoCurto(b.motivo, 200), por: textoCurto(b.por, 80) } };
}

/** `DELETE …/ponte/pausa` → `{ leadId, por? }`. */
export function lerPedidoDeRetomada(corpo: unknown): Lido<{ leadId: number; por: string | null }> {
  const b = (corpo && typeof corpo === 'object' ? corpo : {}) as Record<string, unknown>;
  const leadId = leadIdDoPedido(b.leadId);
  if (!leadId) return { ok: false, erro: 'lead inválido' };
  return { ok: true, pedido: { leadId, por: textoCurto(b.por, 80) } };
}

/** Quem aparece como autor quando a atendente não pôs o nome nas opções. */
export const POR_PADRAO = 'extensão Ponte';
