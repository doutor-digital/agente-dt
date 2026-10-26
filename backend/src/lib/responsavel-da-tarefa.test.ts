import { test } from 'node:test';
import assert from 'node:assert/strict';

import { responsavelDaTarefa, type UsuarioKommo } from './responsavel-da-tarefa.js';

// Marabá em 26/10: os dois únicos usuários da conta.
const maraba: UsuarioKommo[] = [
  { id: 12586363, name: 'Doutor Digital', rights: { is_active: true } },
  { id: 12586999, name: 'Doutor Hérnia Marabá', rights: { is_active: true } },
];

test('Marabá 29029780: lead do Doutor Digital → tarefa para o usuário da clínica', () => {
  assert.equal(responsavelDaTarefa(maraba, 12586363), 12586999);
});

test('sem responsável pedido (o Kommo daria ao dono do token) → usuário da clínica', () => {
  assert.equal(responsavelDaTarefa(maraba, undefined), 12586999);
});

test('lead já com o usuário da clínica fica com ele', () => {
  assert.equal(responsavelDaTarefa(maraba, 12586999), 12586999);
});

test('Açailândia: usuário da clínica sem "Doutor Hérnia" no nome também conta', () => {
  const acailandia: UsuarioKommo[] = [
    { id: 1, name: 'Doutor Digital' },
    { id: 2, name: 'Açailandia' },
  ];
  assert.equal(responsavelDaTarefa(acailandia, 1), 2);
});

test('conta com mais de um usuário da clínica: não adivinha, fica como pedido', () => {
  const varias = [...maraba, { id: 3, name: 'SDR Fulana' }];
  assert.equal(responsavelDaTarefa(varias, 12586363), 12586363);
  assert.equal(responsavelDaTarefa(varias, undefined), undefined);
});

test('usuário inativo não conta como a clínica', () => {
  const comInativo = [...maraba, { id: 3, name: 'Antiga', rights: { is_active: false } }];
  assert.equal(responsavelDaTarefa(comInativo, 12586363), 12586999);
});

test('nome da consultoria com variação de caixa e espaço', () => {
  assert.equal(responsavelDaTarefa([{ id: 1, name: '  DOUTOR digital ' }, { id: 2, name: 'Clínica' }], 1), 2);
});

test('conta sem usuário da clínica: fica como pedido', () => {
  assert.equal(responsavelDaTarefa([{ id: 1, name: 'Doutor Digital' }], 1), 1);
});
