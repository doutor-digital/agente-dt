import { ToolMessage, type BaseMessage } from '@langchain/core/messages';

/**
 * Sanea o histórico ANTES de mandar ao modelo: toda chamada de ferramenta do assistente (`tool_use`) precisa de
 * um resultado (`tool_result`) logo em seguida, e todo resultado precisa de uma chamada logo antes. A Anthropic
 * (e a OpenAI) devolvem 400 se faltar um lado — e o histórico mora no checkpoint do LangGraph, então uma conversa
 * que ficou assim fica assim PARA SEMPRE: o lead 29012474 (Canaã, 26/10) tomou "IA indisponível" em 5 turnos
 * seguidos, com o modelo saudável, porque o turno de 14:08 UTC foi cortado entre a resposta do modelo e a ferramenta.
 *
 * O que fazemos, sem tocar no checkpoint (só no que vai ao modelo neste turno):
 *  - chamada sem resultado imediato  -> entra um resultado sintético "interrompida", logo depois da chamada;
 *  - resultado sem a chamada antes   -> sai (não há o que pareá-lo).
 * Histórico íntegro volta como a MESMA referência (zero custo no caminho normal).
 */

export const TEXTO_FERRAMENTA_INTERROMPIDA =
  'Esta chamada foi interrompida antes de terminar e o resultado não foi registrado. Não presuma que a ação foi feita; ' +
  'se ela ainda for necessária, chame a ferramenta de novo.';

export interface HistoricoSaneado {
  messages: BaseMessage[];
  /** ids de tool_use que ganharam resultado sintético */
  completados: string[];
  /** resultados órfãos (sem tool_use antes) que saíram */
  removidos: number;
}

interface Chamada {
  id: string;
  name: string;
}

function chamadasDoAssistente(m: BaseMessage): Chamada[] {
  if (m.getType() !== 'ai') return [];
  const vistos = new Map<string, Chamada>();
  const tc = (m as { tool_calls?: Array<{ id?: string; name?: string }> }).tool_calls;
  if (Array.isArray(tc)) {
    for (const c of tc) if (c?.id) vistos.set(c.id, { id: c.id, name: c.name ?? 'ferramenta' });
  }
  // A Anthropic lê os blocos `tool_use` do conteúdo: o id que está lá é o que ela cobra.
  if (Array.isArray(m.content)) {
    for (const b of m.content as Array<{ type?: string; id?: string; name?: string }>) {
      if (b && b.type === 'tool_use' && b.id && !vistos.has(b.id)) vistos.set(b.id, { id: b.id, name: b.name ?? 'ferramenta' });
    }
  }
  return [...vistos.values()];
}

export function sanearHistorico(messages: BaseMessage[]): HistoricoSaneado {
  const saida: BaseMessage[] = [];
  const completados: string[] = [];
  let removidos = 0;

  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    const tipo = m.getType();

    if (tipo === 'tool') {
      // Resultado cuja chamada não está imediatamente antes (as boas são consumidas junto da chamada, abaixo).
      removidos++;
      i++;
      continue;
    }

    saida.push(m);
    i++;
    const chamadas = chamadasDoAssistente(m);
    if (chamadas.length === 0) continue;

    const esperados = new Set(chamadas.map((c) => c.id));
    const respondidos = new Set<string>();
    while (i < messages.length && messages[i].getType() === 'tool') {
      const id = (messages[i] as ToolMessage).tool_call_id;
      if (esperados.has(id) && !respondidos.has(id)) {
        respondidos.add(id);
        saida.push(messages[i]);
      } else {
        removidos++;
      }
      i++;
    }
    for (const c of chamadas) {
      if (respondidos.has(c.id)) continue;
      completados.push(c.id);
      saida.push(
        new ToolMessage({ tool_call_id: c.id, name: c.name, status: 'error', content: TEXTO_FERRAMENTA_INTERROMPIDA }),
      );
    }
  }

  if (completados.length === 0 && removidos === 0) return { messages, completados, removidos };
  return { messages: saida, completados, removidos };
}
