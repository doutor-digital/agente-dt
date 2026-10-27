/**
 * Número interno nunca vira lead na franquia. O erro que estes testes impedem é duplo: deixar a
 * funcionária entrar na base da franqueadora, ou marcar a mãe de um paciente como "interna" por um
 * final de 4 dígitos que casou por acaso.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEMENTE_CONHECIDA, ehNumeroInterno, lerNumerosInternos, ultimos8 } from './numeros-internos.js';

test('compara pelos últimos 8 dígitos — DDI, 0 do DDD, máscara e nono dígito não atrapalham', () => {
  assert.equal(ultimos8('+55 (98) 99999-9464'), '99999464');
  assert.equal(ultimos8('5598999999464'), '99999464');
  assert.equal(ultimos8('98999999464'), '99999464');
  // o WhatsApp de alguns números chega sem o nono dígito: os 8 finais continuam iguais
  assert.equal(ultimos8('559899999464'), '99999464');
  assert.equal(ultimos8('9464'), null, 'menos de 8 dígitos não identifica ninguém');
  assert.equal(ultimos8(null), null);
  assert.equal(ultimos8(undefined), null);
  assert.equal(ultimos8(''), null);
});

test('número da lista é interno em qualquer formato', () => {
  const lista = '+55 98 99999-9464';
  assert.equal(ehNumeroInterno('5598999999464', lista), true);
  assert.equal(ehNumeroInterno('(98) 9 9999-9464', lista), true);
  assert.equal(ehNumeroInterno('559899999464', lista), true, 'sem o nono dígito também');
  assert.equal(ehNumeroInterno('5598999998888', lista), false);
});

test('csv com rótulo, aspas e espaço sobrando — como chega do .env', () => {
  const raw = '"joao:98999999464, alertas : 98988883638 ,,suzanne:(98) 97777-1248"';
  assert.equal(lerNumerosInternos(raw).chaves.size, 3);
  assert.equal(ehNumeroInterno('5598988883638', raw), true);
  assert.equal(ehNumeroInterno('5598977771248', raw), true);
  assert.equal(ehNumeroInterno('5598955556240', raw), false);
});

test('sem a variável, ninguém é interno — a lista mora no .env, não no código', () => {
  assert.equal(ehNumeroInterno('5598999999464', undefined), false);
  assert.equal(ehNumeroInterno('5598999999464', ''), false);
  assert.equal(lerNumerosInternos(undefined).chaves.size, 0);
});

test('item curto é ignorado: 4 dígitos pegariam 1 paciente em cada 10 mil', () => {
  const l = lerNumerosInternos('9464,joao:1043,98999991248');
  assert.deepEqual([...l.chaves], ['99991248']);
  assert.deepEqual(l.ignorados, ['9464', 'joao:1043']);
  // um paciente comum que por acaso termina em 9464 NÃO é interno
  assert.equal(ehNumeroInterno('5511912349464', '9464'), false);
});

test('telefone ilegível ou ausente nunca é interno (quem decide o que fazer com ele é a triagem)', () => {
  assert.equal(ehNumeroInterno(null, '98999999464'), false);
  assert.equal(ehNumeroInterno('abc', '98999999464'), false);
  assert.equal(ehNumeroInterno('123', '98999999464'), false);
});

test('a semente conhecida documenta os finais e serve de insumo — cada final casa com um número cheio', () => {
  assert.deepEqual(
    SEMENTE_CONHECIDA.map((s) => s.final).sort(),
    ['1043', '1248', '3638', '6240', '9464'],
  );
  for (const s of SEMENTE_CONHECIDA) {
    assert.match(s.final, /^\d{4}$/);
    const cheio = `55989999${s.final}`; // número fictício que termina no final conhecido
    assert.equal(ehNumeroInterno(cheio, cheio), true, s.quem);
    assert.equal(ehNumeroInterno(`55989999${s.final === '0000' ? '1' : '0'}${s.final.slice(1)}`, cheio), false, `${s.quem}: final parecido não é o mesmo número`);
  }
});
