import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avisoLigadoPara, chaveDoAviso, textoDoAviso } from './aviso-de-agendamento.js';

test('só avisa nas unidades da lista', () => {
  assert.equal(avisoLigadoPara('doutor-hernia-mossoro', 'doutor-hernia-mossoro'), true);
  assert.equal(avisoLigadoPara('doutor-hernia-serra', 'doutor-hernia-mossoro'), false);
});

test('lista vazia não avisa ninguém — silêncio é o padrão seguro', () => {
  // ligar na rede toda vira metralhadora: dezenas por dia somando 22 unidades
  assert.equal(avisoLigadoPara('doutor-hernia-mossoro', ''), false);
  assert.equal(avisoLigadoPara('doutor-hernia-mossoro', undefined), false);
});

test('curinga liga todas', () => {
  assert.equal(avisoLigadoPara('qualquer-unidade', '*'), true);
});

test('remarcar a mesma pessoa pra outro horário avisa DE NOVO', () => {
  const a = chaveDoAviso('m', 10, '2026-09-25', '09:00');
  const b = chaveDoAviso('m', 10, '2026-09-25', '14:00');
  assert.notEqual(a, b);
});

test('a mesma marcação repetida no mesmo turno não avisa duas vezes', () => {
  assert.equal(chaveDoAviso('m', 10, '2026-09-25', '09:00'), chaveDoAviso('m', 10, '2026-09-25', '09:00'));
});

test('o aviso diz quem, quando e como vai pagar', () => {
  const t = textoDoAviso({
    unidade: 'Doutor Hérnia Mossoró', paciente: 'Rafael Lima',
    dia: 'quinta-feira, 25 de setembro', hora: '09:00',
    especialista: 'Dra. Victória Nunes', formaPagamento: 'pix_antecipado',
  });
  assert.match(t, /Mossoró/);
  assert.match(t, /Rafael Lima/);
  assert.match(t, /25 de setembro às 09:00/);
  assert.match(t, /Victória/);
  assert.match(t, /Pix antecipado/);
});

test('cartão sem nome não vira mensagem quebrada', () => {
  const t = textoDoAviso({ unidade: 'X', paciente: null, dia: 'sexta', hora: '10:00' });
  assert.match(t, /paciente sem nome no cartão/);
});

test('remarcação usa outro ícone e outro verbo', () => {
  const t = textoDoAviso({ unidade: 'X', paciente: 'Ana', dia: 'sexta', hora: '10:00', remarcando: true });
  assert.match(t, /remarcou/);
  assert.doesNotMatch(t, /🗓️ sexta às 10:00\n.*marcou/);
});
