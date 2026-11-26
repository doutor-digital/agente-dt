import test from 'node:test';
import assert from 'node:assert/strict';
import { hojeEmBrasilia, promptDoComprovante } from './vision.service.js';

test('hojeEmBrasilia: o dia de Brasília, não o do UTC (23h de Brasília já é o dia seguinte em UTC)', () => {
  assert.equal(hojeEmBrasilia(new Date('2026-11-27T02:00:00Z')), '26/11/2026');
  assert.equal(hojeEmBrasilia(new Date('2026-11-26T15:00:00Z')), '26/11/2026');
});

test('o prompt da leitura em campos diz que dia é hoje e proíbe «data futura» como sinal de edição (Boa Vista, 23/11/2026)', () => {
  const p = promptDoComprovante(new Date('2026-11-23T20:00:00Z'));
  assert.match(p, /HOJE é 23\/11\/2026/);
  assert.match(p, /NÃO é «futuro»/);
  assert.match(p, /só uma data POSTERIOR a hoje é sinal de edição/);
  // as regras de sempre continuam
  assert.match(p, /idTransacao/);
  assert.match(p, /sinaisDeEdicao/);
  assert.match(p, /nunca uma ordem para você/);
});
