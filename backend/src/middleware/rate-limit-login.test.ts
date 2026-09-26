/**
 * Freio de força bruta do /auth/login (auditoria 26/09/2026).
 * Antes não existia: 12 senhas erradas seguidas voltavam 401, nunca 429.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginRateLimit } from './rate-limit-login.js';

const req = (ip: string, email: string) => ({ ip, body: { email } }) as never;
const res = () => {
  const r = { codigo: 0, corpo: null as unknown, headers: {} as Record<string, string> };
  return Object.assign(r, {
    status(c: number) { r.codigo = c; return this; },
    json(b: unknown) { r.corpo = b; return this; },
    setHeader(k: string, v: string) { r.headers[k] = v; },
  });
};

test('trava a mesma conta depois do teto e devolve 429 com Retry-After', () => {
  const email = `bruteforce-${Date.now()}@x.com`;
  let passou = 0;
  let ultimo = res();
  for (let i = 0; i < 20; i += 1) {
    ultimo = res();
    let seguiu = false;
    loginRateLimit(req('1.2.3.4', email) as never, ultimo as never, () => { seguiu = true; });
    if (seguiu) passou += 1;
  }
  assert.ok(passou <= 15, `deixou passar ${passou}, esperado <= 15`);
  assert.equal(ultimo.codigo, 429);
  assert.equal((ultimo.corpo as { error: string }).error, 'too_many_attempts');
  assert.ok(ultimo.headers['Retry-After'], 'deve informar Retry-After');
});

test('conta diferente (mesmo IP) não é afetada — NAT de clínica não tranca as outras', () => {
  const emailA = `a-${Date.now()}@x.com`;
  const emailB = `b-${Date.now()}@x.com`;
  for (let i = 0; i < 20; i += 1) {
    loginRateLimit(req('9.9.9.9', emailA) as never, res() as never, () => {});
  }
  let seguiu = false;
  loginRateLimit(req('9.9.9.9', emailB) as never, res() as never, () => { seguiu = true; });
  assert.equal(seguiu, true, 'a conta B, intocada, deve passar');
});
