import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  credenciaisDaUnidade,
  devoAvisarQueEstouDigitando,
  espelhoParaNota,
  resumirLista,
  type SecaoDaLista,
} from './whatsapp-meta.js';

test('só há credencial quando as DUAS pontas existem', () => {
  assert.equal(credenciaisDaUnidade({ metaPhoneNumberId: '132', metaAccessToken: 'tk' })?.phoneNumberId, '132');
  assert.equal(credenciaisDaUnidade({ metaPhoneNumberId: '132', metaAccessToken: null }), null);
  assert.equal(credenciaisDaUnidade({ metaPhoneNumberId: null, metaAccessToken: 'tk' }), null);
  assert.equal(credenciaisDaUnidade({ metaPhoneNumberId: '  ', metaAccessToken: 'tk' }), null);
});

// O tique azul é uma promessa. Marcar como lido e não responder é pior que não
// marcar: hoje o paciente pelo menos supõe que ninguém viu.
test('não avisa "digitando" quando a IA NÃO vai responder', () => {
  assert.equal(devoAvisarQueEstouDigitando({ pausada: true, foraDoHorario: false, comHumano: false }), false);
  assert.equal(devoAvisarQueEstouDigitando({ pausada: false, foraDoHorario: true, comHumano: false }), false);
  assert.equal(devoAvisarQueEstouDigitando({ pausada: false, foraDoHorario: false, comHumano: true }), false);
});

test('avisa só quando ela vai mesmo responder', () => {
  assert.equal(devoAvisarQueEstouDigitando({ pausada: false, foraDoHorario: false, comHumano: false }), true);
});

const SECOES: SecaoDaLista[] = [
  { titulo: 'Manhã', linhas: [{ id: 'h0800', titulo: '08:00' }, { id: 'h0900', titulo: '09:00' }] },
  { titulo: 'Tarde', linhas: [{ id: 'h1400', titulo: '14:00' }] },
];

test('o resumo da lista cabe numa nota e diz o que foi oferecido', () => {
  assert.equal(resumirLista(SECOES), 'Manhã: 08:00, 09:00 · Tarde: 14:00');
});

test('a nota de espelho explica por que existe', () => {
  const t = espelhoParaNota('lista', resumirLista(SECOES));
  assert.match(t, /lista de opções/);
  assert.match(t, /08:00/);
  // sem esta frase, quem lê a nota acha que é defeito
  assert.match(t, /o Kommo não mostra mensagem enviada por fora dele/i);
  assert.match(t, /O paciente recebeu normalmente/);
});

test('espelho de localização fala em pin, não em lista', () => {
  const t = espelhoParaNota('localizacao', 'Rua Raimundo Leão de Moura, 18');
  assert.match(t, /pin no mapa/);
  assert.doesNotMatch(t, /lista de opções/);
});
