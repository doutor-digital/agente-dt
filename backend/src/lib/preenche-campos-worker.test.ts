import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartaoExiste } from './preenche-campos-worker.js';
import type { KommoLead } from '../services/kommo.service.js';

test('cartaoExiste: o 204 vazio do Kommo (cartão apagado ou juntado) não é um cartão com campos em branco', () => {
  // o axios entrega '' quando o Kommo responde 204 — era isso que virava "tudo vazio, vamos preencher"
  assert.equal(cartaoExiste(''), false);
  assert.equal(cartaoExiste(null), false);
  assert.equal(cartaoExiste(undefined), false);
  assert.equal(cartaoExiste({} as KommoLead), false);
  assert.equal(cartaoExiste({ id: 24703143, name: 'Maria', custom_fields_values: null } as unknown as KommoLead), true);
});
