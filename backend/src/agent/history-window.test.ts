import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';

import { podarHistorico } from './history-window.js';

const h = (t: string) => new HumanMessage(t);
const a = (t: string) => new AIMessage(t);
const aTool = (id: string) =>
  new AIMessage({ content: '', tool_calls: [{ id, name: 'consultar_horarios', args: {} }] });
const tRes = (id: string) => new ToolMessage({ tool_call_id: id, content: 'ok' });

test('conversa curta passa intacta', () => {
  const msgs = [h('oi'), a('olá!'), h('quero agendar')];
  assert.equal(podarHistorico(msgs, 40, 20), msgs);
});

test('conversa longa é cortada, começa em mensagem do paciente e termina na última resposta', () => {
  const msgs: BaseMessage[] = [];
  for (let i = 0; i < 60; i++) {
    msgs.push(h(`pergunta ${i}`), a(`resposta ${i}`));
  }
  const out = podarHistorico(msgs, 40, 20);
  assert.ok(out.length >= 40 && out.length < 60);
  assert.equal(out[0].getType(), 'human');
  assert.ok(String(out[out.length - 1].content).includes('resposta 59'));
});

test('a âncora fica estável enquanto a conversa cresce dentro do passo', () => {
  const base: BaseMessage[] = [];
  for (let i = 0; i < 70; i++) base.push(h(`p${i}`), a(`r${i}`));
  const anchor = (msgs: BaseMessage[]) => String(podarHistorico(msgs, 40, 20)[0].content);
  const a1 = anchor(base.slice(0, 121));
  const a2 = anchor(base.slice(0, 129));
  const a3 = anchor(base.slice(0, 139));
  assert.equal(a1, a2);
  assert.equal(a2, a3);
});

test('nunca começa a janela num tool_result órfão', () => {
  const msgs: BaseMessage[] = [h('início')];
  for (let i = 0; i < 30; i++) {
    msgs.push(h(`msg ${i}`), aTool(`c${i}`), tRes(`c${i}`), a(`fechei ${i}`));
  }
  for (const max of [3, 5, 7, 10, 13, 21]) {
    const out = podarHistorico(msgs, max, 4);
    assert.notEqual(out[0].getType(), 'tool', `janela max=${max} começou em tool_result`);
    for (let i = 0; i < out.length; i++) {
      if (out[i].getType() === 'tool') {
        const anterior = out[i - 1];
        assert.ok(
          anterior && anterior.getType() === 'ai',
          `tool_result sem o tool_call par na janela (max=${max})`,
        );
      }
    }
  }
});

test('max invalido ou zero desliga o corte', () => {
  const msgs = Array.from({ length: 100 }, (_, i) => h(`m${i}`));
  assert.equal(podarHistorico(msgs, 0, 20).length, 100);
  assert.equal(podarHistorico(msgs, Number.NaN, 20).length, 100);
});

test('sem mensagem humana depois da âncora, devolve o histórico inteiro (nunca janela inválida)', () => {
  const msgs: BaseMessage[] = [h('única do paciente')];
  for (let i = 0; i < 50; i++) msgs.push(aTool(`x${i}`), tRes(`x${i}`));
  const out = podarHistorico(msgs, 10, 20);
  assert.equal(out.length, msgs.length);
  assert.notEqual(out[0].getType(), 'tool');
});
