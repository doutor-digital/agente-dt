import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { renderOndeFica } from './prompt-composer.js';

const unidade = (extra: Partial<Unit>) => ({ ...extra } as Unit);

test('com endereço cadastrado, a IA recebe o dado e a ordem de responder na hora', () => {
  const b = renderOndeFica(
    unidade({
      clinicAddress: 'Av. Bernardo Sayão, 3650 — Ed. Medical Center, Imperatriz/MA',
      clinicMapUrl: 'https://share.google/abc',
    }),
  );
  assert.match(b, /Av\. Bernardo Sayão, 3650/);
  assert.match(b, /https:\/\/share\.google\/abc/);
  // a frase que o paciente ouviu 4 vezes e que fez ele achar que era golpe
  assert.match(b, /Nunca diga que vai confirmar com a equipe/);
});

test('sem endereço cadastrado, o bloco não existe — nada de inventar', () => {
  assert.equal(renderOndeFica(unidade({ clinicAddress: null })), '');
  assert.equal(renderOndeFica(unidade({ clinicAddress: '   ' })), '');
});

test('sem mapa, só o endereço', () => {
  const b = renderOndeFica(unidade({ clinicAddress: 'Rua X, 10 — Centro', clinicMapUrl: null }));
  assert.match(b, /Rua X, 10/);
  assert.doesNotMatch(b, /Mapa:/);
});
