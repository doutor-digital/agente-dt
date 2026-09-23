import { test } from 'node:test';
import assert from 'node:assert/strict';

import { termosDeBuscaDoNome } from './franquia-sync-worker.js';

test('termosDeBuscaDoNome: cada pessoa do título vira termos, do específico ao largo, com sobrenome', () => {
  // o caso que o João achou: o paciente era o SEGUNDO nome, e a franquia escreve "ALEXSANDRO"
  const t = termosDeBuscaDoNome('MARIA DA PENHA - ALEXANDRO SANT ANA 17/08/2026');
  assert.ok(t.includes('MARIA DA PENHA'), 'o primeiro nome continua');
  assert.ok(t.includes('ALEXANDRO SANT ANA'), 'o segundo nome entra');
  assert.ok(t.includes('SANT ANA'), 'o sobrenome sozinho acha quem tem o primeiro nome escrito diferente');
  assert.deepEqual(termosDeBuscaDoNome('Elmir Ribeiro Gil. 26/03/26'), ['Elmir Ribeiro Gil', 'Elmir Ribeiro', 'Ribeiro Gil', 'Elmir']);
  assert.deepEqual(termosDeBuscaDoNome('Edvania Pardinho 11/05/26'), ['Edvania Pardinho', 'Edvania']);
  assert.deepEqual(termosDeBuscaDoNome('Rosi 14/09/2026'), ['Rosi']);
  assert.ok(termosDeBuscaDoNome('Dina Alves / Felipe Correia da Silva 18/03/26').includes('Felipe Correia da Silva'));
  for (const n of ['Lead #22647811', 'Lead 2 23/09/2026', 'Zé', null]) assert.deepEqual(termosDeBuscaDoNome(n), [], String(n));
});

test('termosDeBuscaDoNome: teto de 8 termos (cada um é uma chamada na franquia)', () => {
  assert.ok(termosDeBuscaDoNome('Ana Paula Souza Lima - Jose Carlos Pereira Silva').length <= 8);
});
