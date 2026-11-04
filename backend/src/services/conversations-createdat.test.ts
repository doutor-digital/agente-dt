/**
 * A fala guardada pelo atendimento adiado leva a hora em que o paciente escreveu: o lead-metrics tira daí o "Primeiro contato" e o
 * "Tempo até a 1ª resposta". Sem banco: `dadosDaMensagem` é a parte pura do `addMessage`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dadosDaMensagem } from './conversations.service.js';

const base = { conversationId: 'c1', role: 'user' as const, content: 'Olá' };

test('createdAt dado pelo chamador vai para a mensagem (hora em que o paciente escreveu)', () => {
  const quando = new Date('2026-11-04T04:35:35Z');
  assert.equal(dadosDaMensagem({ ...base, createdAt: quando }, null).createdAt, quando);
});

test('sem createdAt: a chave nem existe (vale o now() do banco), como sempre foi', () => {
  assert.equal('createdAt' in dadosDaMensagem(base, null), false);
});

test('o "pediu tempo" continua indo no meta', () => {
  assert.deepEqual(dadosDaMensagem({ ...base, meta: { a: 1 } }, 'adiamento').meta, { a: 1, pediuTempo: true });
  assert.deepEqual(dadosDaMensagem({ ...base, meta: { a: 1 } }, null).meta, { a: 1 });
});
