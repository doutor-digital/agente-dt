import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comNonoDigito } from './nono-digito.js';
import { SpineService } from '../services/spine.service.js';
import { telefoneWhatsapp } from './disparo/regras.js';

test('celular de 12 dígitos (55 + DDD + 8) com 6, 7, 8 ou 9 na frente ganha o 9', () => {
  assert.equal(comNonoDigito('554792919491'), '5547992919491'); // o caso de Timbó
  assert.equal(comNonoDigito('556382345678'), '5563982345678');
  assert.equal(comNonoDigito('551161234567'), '5511961234567');
  assert.equal(comNonoDigito('551171234567'), '5511971234567');
});

test('fixo (2 a 5 depois do DDD) fica como está', () => {
  for (const d of ['554722919491', '554732919491', '554742919491', '554752919491']) assert.equal(comNonoDigito(d), null);
});

test('13 dígitos, estrangeiro, DDD que não existe, tamanho errado e lixo: não mexe', () => {
  assert.equal(comNonoDigito('5547992919491'), null);
  assert.equal(comNonoDigito('351912345678'), null); // Portugal, 12 dígitos, sem 55
  assert.equal(comNonoDigito('551061234567'), null); // DDD 10 não existe (e o 6 passaria pela faixa)
  assert.equal(comNonoDigito('552081234567'), null); // DDD 20 não existe
  assert.equal(comNonoDigito('55479291949'), null); // 11 dígitos
  assert.equal(comNonoDigito('5547929194911'), null);
  assert.equal(comNonoDigito(''), null);
  assert.equal(comNonoDigito('abc'), null);
});

// ── SpineService.normalizarWhatsapp: o que vai para o cadastro na franquia ──

test('normalizarWhatsapp: o número sem o 9 que o WhatsApp entregou vira o de 13 dígitos (Timbó, 29/10)', () => {
  assert.equal(SpineService.normalizarWhatsapp('+554792919491'), '+5547992919491');
  assert.equal(SpineService.normalizarWhatsapp('554792919491'), '+5547992919491');
  assert.equal(SpineService.normalizarWhatsapp('+55 (47) 9291-9491'), '+5547992919491');
});

test('normalizarWhatsapp: DDD + 8 sem o 55 (10 dígitos) também ganha 55 e o 9, se for celular', () => {
  assert.equal(SpineService.normalizarWhatsapp('(47) 9291-9491'), '+5547992919491');
});

test('normalizarWhatsapp: o que já estava certo não muda', () => {
  assert.equal(SpineService.normalizarWhatsapp('(63) 99102-1043'), '+5563991021043');
  assert.equal(SpineService.normalizarWhatsapp('5563991021043'), '+5563991021043');
  assert.equal(SpineService.normalizarWhatsapp('+5547992919491'), '+5547992919491');
  assert.equal(SpineService.normalizarWhatsapp('47992919491'), '+5547992919491');
});

test('normalizarWhatsapp: fixo fica fixo (sem 9 inventado), com e sem o 55', () => {
  assert.equal(SpineService.normalizarWhatsapp('+554733334444'), '+554733334444');
  assert.equal(SpineService.normalizarWhatsapp('(47) 3333-4444'), '+554733334444');
});

test('normalizarWhatsapp: estrangeiro e lixo ficam como estavam', () => {
  assert.equal(SpineService.normalizarWhatsapp('+351 912 345 678'), '+351912345678');
  assert.equal(SpineService.normalizarWhatsapp('+44 7911 123456'), '+447911123456'); // 12 dígitos, não começa com 55
  assert.equal(SpineService.normalizarWhatsapp('+49 1512 3456789'), '+4915123456789');
  // sem mudança: 10 ou 11 dígitos sempre foram lidos como brasileiros (DDD + número), com ou sem esta regra
  assert.equal(SpineService.normalizarWhatsapp('+1 (415) 555-2671'), '+5514155552671');
  assert.equal(SpineService.normalizarWhatsapp('9910'), '+9910');
  assert.equal(SpineService.normalizarWhatsapp(''), '');
  assert.equal(SpineService.normalizarWhatsapp('sem telefone'), '');
});

test('os 8 últimos dígitos continuam sendo a mesma chave antes e depois (a comparação pelo fim8 não quebra)', () => {
  const fim8 = (f: string) => f.replace(/\D/g, '').slice(-8);
  assert.equal(fim8(SpineService.normalizarWhatsapp('+554792919491')), fim8('+554792919491'));
  assert.equal(fim8(SpineService.normalizarWhatsapp('+554792919491')), fim8('+5547992919491'));
});

test('uma fonte só: o disparo e o cadastro dão o MESMO número para o mesmo celular legado', () => {
  for (const bruto of ['554792919491', '+55 63 8234-5678', '551161234567']) {
    assert.equal(`+${telefoneWhatsapp(bruto)}`, SpineService.normalizarWhatsapp(bruto), bruto);
  }
});
