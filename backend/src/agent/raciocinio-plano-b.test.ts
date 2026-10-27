import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';

import { semRaciocinioParaPlanoB } from './raciocinio-plano-b.js';

const raciocinio = { type: 'thinking', thinking: '', signature: 'assinatura-opaca' };
const oculto = { type: 'redacted_thinking', data: 'xxxx' };

test('tira thinking e redacted_thinking, mantém texto e tool_use, e preserva tool_calls', () => {
  const ai = new AIMessage({
    content: [raciocinio, oculto, { type: 'text', text: 'vou consultar' }, { type: 'tool_use', id: 't1', name: 'consultar_horarios', input: {} }],
    tool_calls: [{ id: 't1', name: 'consultar_horarios', args: {}, type: 'tool_call' }],
    id: 'm1',
  });
  const [saida] = semRaciocinioParaPlanoB([ai]);
  assert.deepEqual(saida!.content, [
    { type: 'text', text: 'vou consultar' },
    { type: 'tool_use', id: 't1', name: 'consultar_horarios', input: {} },
  ]);
  assert.equal((saida as AIMessage).tool_calls?.[0]?.name, 'consultar_horarios');
  assert.equal(saida!.id, 'm1');
});

test('só texto depois da limpeza vira string simples', () => {
  const ai = new AIMessage({ content: [raciocinio, { type: 'text', text: 'oi, tudo bem?' }] });
  assert.equal(semRaciocinioParaPlanoB([ai])[0]!.content, 'oi, tudo bem?');
});

test('só raciocínio vira string vazia (com tool_calls preservados)', () => {
  const ai = new AIMessage({
    content: [raciocinio],
    tool_calls: [{ id: 't2', name: 'x', args: {}, type: 'tool_call' }],
  });
  const [saida] = semRaciocinioParaPlanoB([ai]);
  assert.equal(saida!.content, '');
  assert.equal((saida as AIMessage).tool_calls?.length, 1);
});

test('não altera as mensagens recebidas (o principal as manda intactas) e reaproveita as que não têm bloco', () => {
  const comBloco = new AIMessage({ content: [raciocinio, { type: 'text', text: 'a' }] });
  const humana = new HumanMessage('oi');
  const ferramenta = new ToolMessage({ content: 'ok', tool_call_id: 't1' });
  const simples = new AIMessage('texto');
  const entrada = [humana, comBloco, ferramenta, simples];
  const saida = semRaciocinioParaPlanoB(entrada);
  assert.equal(comBloco.content.length, 2); // original intacto
  assert.deepEqual(comBloco.content[0], raciocinio);
  assert.equal(saida[0], humana);
  assert.equal(saida[2], ferramenta);
  assert.equal(saida[3], simples);
  assert.notEqual(saida[1], comBloco);
});
