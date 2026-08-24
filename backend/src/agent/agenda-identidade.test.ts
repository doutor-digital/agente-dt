import { test } from 'node:test';
import assert from 'node:assert/strict';

function fim8(fone: string | null | undefined): string | null {
  const d = (fone ?? '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : null;
}

function recusa(
  foneLead: string | null,
  foneInformado: string | null,
  foneCadastro: string | null,
): boolean {
  const aceitos = [fim8(foneLead), fim8(foneInformado)].filter((x): x is string => x !== null);
  const b = fim8(foneCadastro);
  return aceitos.length > 0 && b !== null && !aceitos.includes(b);
}

test('caso real do Luzinaldo: escreveu de um número e cadastrou com outro', () => {
  const lead = '+559984620735';
  const cadastro = '+5599991813468';
  assert.equal(recusa(lead, null, cadastro), true, 'sem o informado, recusava');
  assert.equal(recusa(lead, cadastro, cadastro), false, 'com o informado, passa');
});

test('cadastro de terceiro continua barrado', () => {
  assert.equal(recusa('+5599984620735', '+5599984620735', '+5563991146630'), true);
});

test('telefone do lead batendo passa mesmo sem informar nada', () => {
  assert.equal(recusa('+5599984972309', null, '+559984972309'), false);
});

test('sem nenhum telefone conhecido não bloqueia (não inventa suspeita)', () => {
  assert.equal(recusa(null, null, '+5599991813468'), false);
});

test('cadastro sem telefone não bloqueia', () => {
  assert.equal(recusa('+5599984620735', null, null), false);
});

test('9º dígito: mesmo número em formato antigo e novo bate pelos 8 finais', () => {
  assert.equal(recusa('+559984972306', null, '+5599984972306'), false);
});
