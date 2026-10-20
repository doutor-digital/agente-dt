import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fim8, validarDataHora, validarNome, validarTelefone } from './marcacao-widget.js';

test('widget: basta o primeiro nome (20/10/2026) — e semSobrenome avisa quem chama', () => {
  const so = validarNome('Maria');
  assert.equal(so.ok, true);
  if (so.ok) {
    assert.equal(so.nome, 'Maria');
    assert.equal(so.semSobrenome, true);
  }
  const v = validarNome('  Maria   da  Silva ');
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.nome, 'Maria da Silva', 'espaços dobrados somem, senão a franquia cria homônimo');
    assert.equal(v.semSobrenome, false);
  }
  // partícula de 1 letra não conta como sobrenome
  const e = validarNome('Ana e');
  assert.ok(e.ok && e.semSobrenome);
  assert.equal(validarNome('Jo').ok, true, 'mínimo: 2 letras');
});

test('widget: sem nenhuma palavra de 2+ letras → recusa sem_nome', () => {
  for (const ruim of ['', '   ', 'A', '12', 'A B', '1 2 3']) {
    const r = validarNome(ruim);
    assert.equal(r.ok, false, ruim);
    if (!r.ok) assert.equal(r.codigo, 'sem_nome', ruim);
  }
});

test('widget marcar: telefone exige DDD e sai normalizado como a franquia guarda', () => {
  const ok = validarTelefone('(63) 99102-1043');
  assert.equal(ok.ok, true);
  if (ok.ok) assert.match(ok.fone.replace(/\D/g, ''), /^55639?91021043$/);
  const curto = validarTelefone('99102-1043');
  assert.equal(curto.ok, false);
  if (!curto.ok) assert.equal(curto.codigo, 'telefone_incompleto');
});

test('widget marcar: fim8 compara só os 8 últimos dígitos — DDD e 9º dígito não podem separar a mesma pessoa', () => {
  assert.equal(fim8('+55 63 99102-1043'), '91021043');
  assert.equal(fim8('6391021043'), '91021043');
  assert.equal(fim8('1043'), null);
  assert.equal(fim8(null), null);
});

test('widget marcar: data e hora no formato que a franquia aceita', () => {
  assert.equal(validarDataHora('2026-10-02', '09:30'), null);
  assert.equal(validarDataHora('02/10/2026', '09:30')?.codigo, 'data_invalida');
  assert.equal(validarDataHora('2026-13-40', '09:30')?.codigo, 'data_invalida');
  assert.equal(validarDataHora('2026-10-02', '9h30')?.codigo, 'horario_invalido');
  assert.equal(validarDataHora('2026-09-28', '09:30', '2026-09-29')?.codigo, 'data_passada', 'ontem não se marca');
  assert.equal(validarDataHora('2026-09-29', '09:30', '2026-09-29'), null, 'hoje pode');
});
