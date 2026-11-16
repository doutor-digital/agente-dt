import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mascararUrlDoLog } from './mascara-url-log.js';

test('o código do formulário nova clínica nunca vai para o log (página e API), nem o token do cofre nem as chaves da query', () => {
  const codigo = 'AbC-_9xYz012345678901234';
  assert.equal(mascararUrlDoLog(`/nova-clinica/${codigo}`), '/nova-clinica/[codigo]');
  assert.equal(mascararUrlDoLog(`/api/public/nova-clinica/${codigo}?x=1`), '/api/public/nova-clinica/[codigo]?x=1');
  assert.equal(mascararUrlDoLog('/arquivos/enviar/segredo123?k=abc&z=1'), '/arquivos/enviar/[token]?k=[chave]&z=1');
  assert.equal(mascararUrlDoLog('/api/x?access_token=zzz'), '/api/x?access_token=[chave]');
  assert.equal(mascararUrlDoLog('/api/health'), '/api/health');
  assert.ok(!mascararUrlDoLog(`/nova-clinica/${codigo}`).includes(codigo));
});
