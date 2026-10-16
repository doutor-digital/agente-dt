import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cifrar, decifrar, finalDaChave } from './cofre.js';

const SEGREDO = 'x'.repeat(40);

test('cifra e decifra; o texto cifrado não contém a chave e muda a cada vez', () => {
  const chave = '$aact_prod_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OjAwMDAw';
  const a = cifrar(chave, SEGREDO);
  const b = cifrar(chave, SEGREDO);
  assert.notEqual(a, b);
  assert.ok(!a.includes('aact'));
  assert.equal(decifrar(a, SEGREDO), chave);
});

test('segredo errado ou texto adulterado não decifra', () => {
  const a = cifrar('segredo-da-conta', SEGREDO);
  assert.throws(() => decifrar(a, 'y'.repeat(40)));
  const partes = a.split('.');
  partes[3] = Buffer.from('outra coisa').toString('base64url');
  assert.throws(() => decifrar(partes.join('.'), SEGREDO));
  assert.throws(() => decifrar('lixo', SEGREDO));
});

test('final da chave mostra só os 4 últimos', () => {
  assert.equal(finalDaChave('$aact_prod_abcdefgh1234'), '…1234');
  assert.equal(finalDaChave('curta'), '…');
});
