/** Lê o corpo do pedido do widget sem confiar nele. */
import { MAX_CHARS_DA_PERGUNTA, type TurnoDoHistorico } from './prompt.js';

export interface PedidoDoCopiloto {
  leadId: number;
  pergunta: string;
  historico: TurnoDoHistorico[];
}

const MAX_TURNOS = 6;
const MAX_CHARS_DO_TURNO = 800;

export function lerPedido(corpo: unknown): PedidoDoCopiloto | { erro: string } {
  if (!corpo || typeof corpo !== 'object') return { erro: 'pedido inválido' };
  const { leadId, pergunta, historico } = corpo as Record<string, unknown>;
  const id = Number(leadId);
  if (!Number.isInteger(id) || id <= 0 || id > 2 ** 40) return { erro: 'lead inválido' };
  if (typeof pergunta !== 'string' || !pergunta.trim()) return { erro: 'faltou a pergunta' };
  if (pergunta.length > MAX_CHARS_DA_PERGUNTA) return { erro: `pergunta grande demais (máximo ${MAX_CHARS_DA_PERGUNTA} letras)` };
  const turnos: TurnoDoHistorico[] = [];
  if (Array.isArray(historico)) {
    for (const t of historico.slice(-MAX_TURNOS)) {
      if (!t || typeof t !== 'object') continue;
      const { papel, texto } = t as Record<string, unknown>;
      if ((papel === 'pessoa' || papel === 'copiloto') && typeof texto === 'string' && texto.trim()) {
        turnos.push({ papel, texto: texto.trim().slice(0, MAX_CHARS_DO_TURNO) });
      }
    }
  }
  return { leadId: id, pergunta: pergunta.trim(), historico: turnos };
}
