import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planejarDataDoPrimeiroContato, type CampoDaContaData } from './data-primeiro-contato-retroativo.js';

const CAMPO: CampoDaContaData = { id: 77, name: '◷ Data do primeiro contato', type: 'date_time' };
const cartao = (id: number, status: number, criado: number | null, valor?: unknown) => ({
  id,
  status_id: status,
  created_at: criado,
  custom_fields_values: valor === undefined ? [] : [{ field_id: 77, values: [{ value: valor }] }],
});

test('vazio → data de criação do cartão; preenchido nunca é sobrescrito', () => {
  const p = planejarDataDoPrimeiroContato([cartao(1, 10, 1_700_000_000), cartao(2, 10, 1_700_000_100, 1_600_000_000), cartao(3, 10, 1_700_000_200, '')], [CAMPO]);
  assert.deepEqual(p.gravar, [{ leadId: 1, epoch: 1_700_000_000 }, { leadId: 3, epoch: 1_700_000_200 }]);
  assert.equal(p.jaTinham, 1);
});

test('valor 0 no campo conta como preenchido (nunca sobrescreve)', () => {
  const p = planejarDataDoPrimeiroContato([cartao(1, 10, 1_700_000_000, 0)], [CAMPO]);
  assert.equal(p.gravar.length, 0);
  assert.equal(p.jaTinham, 1);
});

test('Ganho/Perdido ficam de fora, salvo pedido explícito', () => {
  const cartoes = [cartao(1, 142, 1_700_000_000), cartao(2, 143, 1_700_000_000), cartao(3, 10, 1_700_000_000)];
  assert.deepEqual(planejarDataDoPrimeiroContato(cartoes, [CAMPO]).gravar.map((g) => g.leadId), [3]);
  assert.equal(planejarDataDoPrimeiroContato(cartoes, [CAMPO]).fechadosIgnorados, 2);
  assert.deepEqual(planejarDataDoPrimeiroContato(cartoes, [CAMPO], true).gravar.map((g) => g.leadId), [1, 2, 3]);
});

test('sem data de criação válida não grava', () => {
  const p = planejarDataDoPrimeiroContato([cartao(1, 10, null), cartao(2, 10, 0)], [CAMPO]);
  assert.equal(p.gravar.length, 0);
  assert.equal(p.semCriacao, 2);
});

test('conta sem o campo, com dois campos de mesmo nome ou com campo que não é de data: não faz nada', () => {
  assert.match(planejarDataDoPrimeiroContato([cartao(1, 10, 5)], []).semCampo ?? '', /não tem UM campo/);
  assert.match(planejarDataDoPrimeiroContato([cartao(1, 10, 5)], [CAMPO, { ...CAMPO, id: 78 }]).semCampo ?? '', /não tem UM campo/);
  const texto = planejarDataDoPrimeiroContato([cartao(1, 10, 5)], [{ ...CAMPO, type: 'text' }]);
  assert.match(texto.semCampo ?? '', /não de data/);
  assert.equal(texto.gravar.length, 0);
});
