import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chaveCentralConfere, chaveCentralLigada, chaveDaPessoa, finalDoNumero, nomeLimpo, numeroCanonico, numerosDaMensagem } from './central-pausa.js';

test('número canônico: com e sem o 9, com e sem 55, jid e texto formatado dão o MESMO número', () => {
  const formas = ['5563999991234@s.whatsapp.net', '556399991234@s.whatsapp.net', '+55 (63) 99999-1234', '63 99999-1234', '6399991234', '556399991234'];
  const canon = formas.map(numeroCanonico);
  assert.ok(canon.every((c) => c === '556399991234'), JSON.stringify(canon));
});

test('número canônico: id interno (@lid), grupo, curto ou lixo = null; fixo não perde dígito', () => {
  assert.equal(numeroCanonico('123456789012345@lid'), null);
  assert.equal(numeroCanonico('120363000000000000@g.us'), null);
  assert.equal(numeroCanonico('12345'), null);
  assert.equal(numeroCanonico(undefined), null);
  assert.equal(numeroCanonico('556332141234'), '556332141234');
});

test('mensagem com @lid usa o número alternativo; sem repetir', () => {
  assert.deepEqual(numerosDaMensagem('99999@lid', '5563999991234@s.whatsapp.net'), ['556399991234']);
  assert.deepEqual(numerosDaMensagem('556399991234@s.whatsapp.net', '5563999991234@s.whatsapp.net'), ['556399991234']);
  assert.deepEqual(numerosDaMensagem('99999@lid', null), []);
});

test('chave da pessoa: depende do segredo, não contém o telefone; final só 4 dígitos', () => {
  const k = chaveDaPessoa('556399991234', 'segredo-a');
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.notEqual(k, chaveDaPessoa('556399991234', 'segredo-b'));
  assert.ok(!k.includes('99991234'));
  assert.equal(finalDoNumero('556399991234'), '…1234');
});

test('chave da extensão: desligada sem chave ou curta; confere só a certa', () => {
  const boa = 'a'.repeat(40);
  assert.equal(chaveCentralLigada(undefined), false);
  assert.equal(chaveCentralLigada('curta'), false);
  assert.equal(chaveCentralLigada(boa), true);
  assert.equal(chaveCentralConfere(boa, boa), true);
  assert.equal(chaveCentralConfere(boa, 'a'.repeat(39)), false);
  assert.equal(chaveCentralConfere('curta', 'curta'), false);
  assert.equal(chaveCentralConfere(boa, undefined), false);
});

test('nome da conversa: sem quebra de linha nem controle, até 60 caracteres', () => {
  assert.equal(nomeLimpo('  Tamires\nAçail  '), 'Tamires Açail');
  assert.equal(nomeLimpo('x'.repeat(80))!.length, 60);
  assert.equal(nomeLimpo(''), null);
  assert.equal(nomeLimpo(42), null);
});
