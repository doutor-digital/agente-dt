/**
 * 👍/👎 da Sofia: a fala do paciente que aparece no caso e o resumo da tela Agente (semana × semana anterior, 👎 em aberto).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumir, ultimaFalaDoPaciente, ehNota, type AvaliacaoLida } from './sofia-avaliacoes.js';

const agora = new Date('2026-11-13T15:00:00Z');
const DIA = 86_400_000;
let n = 0;
function aval(nota: string, diasAtras: number, extra: Partial<AvaliacaoLida> = {}): AvaliacaoLida {
  n++;
  return {
    id: `a${n}`, nota, texto: nota === 'ruim' ? 'devia dizer o valor' : null, quemNome: 'Cleia', criadoEm: new Date(agora.getTime() - diasAtras * DIA),
    conversa: 10, messageId: 100 + n, revisadaEm: null, revisadaPor: null, revisadaComo: null, resposta: 'Oi!', fala: 'quanto custa?', ...extra,
  };
}

test('a fala do paciente é a última fala dele (ignora a da Sofia e as vazias)', () => {
  assert.equal(ultimaFalaDoPaciente([{ role: 'user', content: 'oi' }, { role: 'user', content: ' quanto custa? ' }, { role: 'assistant', content: 'R$ 350' }]), 'quanto custa?');
  assert.equal(ultimaFalaDoPaciente([{ role: 'assistant', content: 'oi' }, { role: 'user', content: '   ' }]), null);
  assert.equal(ultimaFalaDoPaciente([]), null);
});

test('nota só aceita boa ou ruim', () => {
  assert.ok(ehNota('boa') && ehNota('ruim'));
  assert.ok(!ehNota('ótima') && !ehNota(null) && !ehNota(1));
});

test('resumo: conta a semana e a anterior, e só 👎 não revisada fica para revisar (mais nova primeiro)', () => {
  const velha = aval('ruim', 3);
  const nova = aval('ruim', 0.5);
  const revisada = aval('ruim', 1, { revisadaEm: new Date(agora.getTime() - 3_600_000), revisadaPor: 'Lia', revisadaComo: 'regra' });
  const r = resumir([aval('boa', 1), aval('boa', 2), velha, nova, revisada, aval('boa', 8), aval('ruim', 9), aval('boa', 20)], agora);
  assert.deepEqual(r.semana, { boas: 2, ruins: 3 });
  assert.deepEqual(r.anterior, { boas: 1, ruins: 1 });
  assert.deepEqual(r.paraRevisar.map((a) => a.id), [nova.id, velha.id, r.paraRevisar[2]!.id]);
  assert.equal(r.paraRevisar.length, 3, 'a 👎 de 9 dias atrás ainda está aberta');
  assert.ok(!r.paraRevisar.some((a) => a.id === revisada.id));
  assert.deepEqual(r.revisadas.map((a) => a.id), [revisada.id]);
});

test('resumo vazio não quebra', () => {
  const r = resumir([], agora);
  assert.deepEqual(r.semana, { boas: 0, ruins: 0 });
  assert.equal(r.paraRevisar.length, 0);
});
