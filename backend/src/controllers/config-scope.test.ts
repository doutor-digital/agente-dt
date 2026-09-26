/**
 * Trava do IDOR das rotas /config (auditoria 26/09/2026).
 *
 * Antes: GET/PUT /config e /config/flatten só tinham requireAuth e aceitavam
 * `unitId` do query/corpo sem conferir. Um UNIT_ADMIN da clínica A lia e
 * SOBRESCREVIA o system_prompt (o cérebro da IA que fala com paciente) de outra
 * clínica mandando `?unitId=<B>`, e conseguia mexer na config GLOBAL (unitId=null).
 *
 * Estes testes fixam a decisão de escopo: UNIT_ADMIN nunca escapa da própria
 * unidade nem alcança a global; SUPER_ADMIN continua livre.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_JWT_SECRET ??= 'x'.repeat(40);
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/x';
process.env.KOMMO_SUBDOMAIN ??= 'x';
process.env.KOMMO_ACCESS_TOKEN ??= 'x'.repeat(20);
process.env.OPENAI_API_KEY ??= 'x'.repeat(20);

const { resolveConfigUnitId } = await import('./config.controller.js');

type FakeUser = { role: 'SUPER_ADMIN' | 'UNIT_ADMIN'; unitId: string | null };
const req = (user: FakeUser) => ({ user }) as never;

test('UNIT_ADMIN é travado na própria unidade, ignorando o unitId pedido', () => {
  const r = req({ role: 'UNIT_ADMIN', unitId: 'clinica-A' });
  assert.equal(resolveConfigUnitId(r, 'clinica-B'), 'clinica-A', 'não pode alcançar outra clínica');
  assert.equal(resolveConfigUnitId(r, null), 'clinica-A', 'não pode cair na global (null)');
  assert.equal(resolveConfigUnitId(r, undefined), 'clinica-A');
});

test('UNIT_ADMIN sem unitId cai em sentinela que não casa com nada', () => {
  const r = req({ role: 'UNIT_ADMIN', unitId: null });
  assert.equal(resolveConfigUnitId(r, 'clinica-B'), '__never_match__');
});

test('SUPER_ADMIN honra o unitId pedido, inclusive a global', () => {
  const r = req({ role: 'SUPER_ADMIN', unitId: null });
  assert.equal(resolveConfigUnitId(r, 'clinica-B'), 'clinica-B');
  assert.equal(resolveConfigUnitId(r, null), null, 'null = config global, permitido');
});
