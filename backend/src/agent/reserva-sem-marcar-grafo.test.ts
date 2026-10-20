/**
 * Prova do roteamento em que a trava "reservado sem marcar" confia (achado repetido do Codex, 19/10/2026):
 * quando o nó do agente DEVOLVE uma mensagem com tool_calls (a refeita que decidiu chamar agendar_consulta),
 * o grafo executa a ferramenta e volta ao agente — o mesmo caminho de uma resposta normal com ferramenta.
 * Montado igual ao `graph.ts`: agente → (último recado tem tool_calls ? ferramentas : fim) → agente.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { END, START, StateGraph, MessagesAnnotation } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

test('recado devolvido com tool_calls é executado pelo grafo e volta ao agente', async () => {
  const chamadas: string[] = [];
  const agendar = new DynamicStructuredTool({
    name: 'agendar_consulta',
    description: 'teste',
    schema: z.object({ hora: z.string() }),
    func: async ({ hora }) => {
      chamadas.push(hora);
      return `Consulta marcada para terça às ${hora}.`;
    },
  });
  let passagens = 0;
  const agente = async (state: typeof MessagesAnnotation.State) => {
    passagens++;
    const ultima = state.messages[state.messages.length - 1];
    if (ultima.getType() === 'tool') return { messages: [new AIMessage('✅ Agendamento confirmado!')] };
    // como a trava: a resposta original prometeu, e o nó devolve a REFEITA, que chama a ferramenta
    return { messages: [new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'agendar_consulta', args: { hora: '11:30' } }] })] };
  };
  const continuar = (state: typeof MessagesAnnotation.State) => {
    const last = state.messages[state.messages.length - 1] as AIMessage;
    return Array.isArray(last.tool_calls) && last.tool_calls.length > 0 ? 'tools' : END;
  };
  const grafo = new StateGraph(MessagesAnnotation)
    .addNode('agent', agente)
    .addNode('tools', new ToolNode([agendar]))
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', continuar, { tools: 'tools', [END]: END })
    .addEdge('tools', 'agent')
    .compile();
  const fim = await grafo.invoke({ messages: [new HumanMessage('Terça às 11:30')] });
  assert.deepEqual(chamadas, ['11:30'], 'a ferramenta rodou');
  assert.equal(passagens, 2, 'voltou ao agente depois da ferramenta');
  assert.equal(String(fim.messages[fim.messages.length - 1].content), '✅ Agendamento confirmado!');
});
