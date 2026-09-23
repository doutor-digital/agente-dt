import { test } from 'node:test';
import assert from 'node:assert/strict';

import { termosDeBuscaDoNome } from './franquia-sync-worker.js';

test('termosDeBuscaDoNome: do mais específico ao mais largo, sem pontuação; "Lead" não busca', () => {
  assert.deepEqual(termosDeBuscaDoNome('Elmir Ribeiro Gil. 26/03/26'), ['Elmir Ribeiro Gil', 'Elmir Ribeiro', 'Elmir']);
  assert.deepEqual(termosDeBuscaDoNome('Edvania Pardinho 11/05/26'), ['Edvania Pardinho', 'Edvania']);
  assert.deepEqual(termosDeBuscaDoNome('Ivair Diniz(Victoria Diniz)  25/02'), ['Ivair Diniz', 'Ivair']);
  assert.deepEqual(termosDeBuscaDoNome('Zé'), []);
  assert.deepEqual(termosDeBuscaDoNome('Lead #22647811'), []);
  assert.deepEqual(termosDeBuscaDoNome('Lead 2 23/09/2026'), []);
  assert.deepEqual(termosDeBuscaDoNome(null), []);
});
