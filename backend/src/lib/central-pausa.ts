/**
 * Central do João — fase 1: pausa do agente de chamados (63 9103-9464) por PESSOA, pela extensão do Chrome (pedido do João,
 * 11/11/2026: "pausar geral ou na pessoa específica"). A pausa GERAL já existe (`suporte-pausa.ts`); aqui só a regra da pausa
 * por pessoa, pura (sem banco e sem rede; o I/O mora em `central-pausa-banco.ts`).
 *
 * O telefone NÃO é guardado: vira uma chave HMAC (segredo do servidor) do número canônico, e só os 4 últimos dígitos ficam para
 * mostrar. O número canônico junta as duas formas que o WhatsApp usa para celular brasileiro (com e sem o 9 da frente), então
 * pausar "63 99999-1234" também pausa a mensagem que chega como 556399991234.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Número canônico (só dígitos, com 55; celular BR sem o 9 extra) ou null se não parece telefone. `@lid` (id interno) = null. */
export function numeroCanonico(bruto: unknown): string | null {
  if (typeof bruto !== 'string') return null;
  const s = bruto.trim();
  if (!s || s.endsWith('@lid') || s.endsWith('@g.us')) return null;
  let d = s.split('@')[0]!.replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = `55${d}`; // DDD + número, sem o país
  if (d.length < 12 || d.length > 15) return null;
  // celular BR: 55 + DDD + 9 + 8 dígitos (13) → a forma sem o 9 (12), que é como o WhatsApp entrega os números antigos
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') d = d.slice(0, 4) + d.slice(5);
  return d;
}

/** Os números canônicos de uma mensagem (o jid e o alternativo, quando o jid é o id interno `@lid`), sem repetir. */
export function numerosDaMensagem(jid: string, jidAlt: string | null): string[] {
  return [...new Set([numeroCanonico(jid), numeroCanonico(jidAlt)].filter((x): x is string => !!x))];
}

/** A chave guardada no banco no lugar do telefone. */
export function chaveDaPessoa(canonico: string, segredo: string): string {
  return createHmac('sha256', segredo).update(`central-pessoa:${canonico}`).digest('hex');
}

/** "…1234" — o único pedaço do número que aparece (extensão, painel, Telegram). */
export function finalDoNumero(canonico: string): string {
  return `…${canonico.slice(-4)}`;
}

/** Chave da extensão (cabeçalho X-Central-Chave). Sem chave configurada ou curta demais = a Central fica desligada (404). */
export const MIN_CHAVE = 32;
export function chaveCentralLigada(esperada: string | undefined): boolean {
  return String(esperada ?? '').trim().length >= MIN_CHAVE;
}
export function chaveCentralConfere(esperada: string | undefined, recebida: unknown): boolean {
  const e = String(esperada ?? '').trim();
  if (e.length < MIN_CHAVE || typeof recebida !== 'string' || !recebida) return false;
  return timingSafeEqual(createHash('sha256').update(e).digest(), createHash('sha256').update(recebida.trim()).digest());
}

/** Nome que a extensão manda (o título da conversa no WhatsApp Web): só para o João reconhecer; curto e sem quebra de linha. */
export function nomeLimpo(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s || null;
}

export const TEXTOS_CENTRAL = {
  pausouPessoa: (nome: string | null, final: string) => `⏸ Agente de chamados PAUSADO só para ${nome ? `${nome} (${final})` : final} — pela extensão.`,
  voltouPessoa: (nome: string | null, final: string, ignoradas: number) =>
    `▶️ Agente de chamados RETOMADO para ${nome ? `${nome} (${final})` : final} — pela extensão.${ignoradas > 0 ? `\nCerca de ${ignoradas} mensagem(ns) dessa pessoa ficaram sem resposta na pausa.` : ''}`,
};
