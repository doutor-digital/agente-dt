import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acharLacunas, preencherLacunas } from './lacunas.js';

const RIO_VERDE = {
  chavePix: '68.896.219/0001-54',
  titularPix: 'Sousa e Magalhaes Clinica de Fisioterapia LTDA',
  valorAntecipado: 250,
};

// A mensagem que o paciente Renilson recebeu em 16/09/2026, 14:29.
const MSG_RENILSON =
  'Renilson, a chave Pix da clínica é [chave das Fontes Oficiais], no nome Doutor Hérnia ' +
  'Rio Verde ♥ O valor antecipado fica R$ [valor], e você pode pagar até a véspera da consulta.';

test('o caso real: a chave e o valor são preenchidos, nada sobra', () => {
  const r = preencherLacunas(MSG_RENILSON, RIO_VERDE);
  assert.deepEqual(r.restantes, []);
  assert.match(r.texto, /68\.896\.219\/0001-54/);
  assert.match(r.texto, /R\$ 250/);
  assert.doesNotMatch(r.texto, /\[/);
});

test('"R$ [valor]" não vira "R$ R$ 250"', () => {
  const r = preencherLacunas('fica R$ [valor] antecipado', RIO_VERDE);
  assert.equal(r.texto, 'fica R$ 250 antecipado');
});

test('lacuna de valor sem R$ na frente ganha o R$', () => {
  const r = preencherLacunas('o valor antecipado é [valor]', RIO_VERDE);
  assert.equal(r.texto, 'o valor antecipado é R$ 250');
});

test('a marcação de botões NÃO é lacuna', () => {
  // sem isto o guardrail derrubaria toda mensagem que oferece os botões rápidos
  const t = 'Como prefere pagar?\n[[botoes: Pix antecipado | Na clínica]]';
  assert.deepEqual(acharLacunas(t), []);
  assert.deepEqual(preencherLacunas(t, RIO_VERDE).restantes, []);
});

test('link markdown NÃO é lacuna', () => {
  assert.deepEqual(acharLacunas('veja o [mapa](https://maps.app/x)'), []);
});

test('colchete sem letra não é lacuna', () => {
  assert.deepEqual(acharLacunas('a nota [2] do exame'), []);
});

test('chave grafada de outro jeito ainda é reconhecida', () => {
  const r = preencherLacunas('nossa chave é {CNPJ da clínica}', RIO_VERDE);
  assert.equal(r.restantes.length, 0);
  assert.match(r.texto, /68\.896\.219/);
});

test('titular ganha do "chave" quando a lacuna fala de titular', () => {
  const r = preencherLacunas('a chave está no [nome do titular]', RIO_VERDE);
  assert.match(r.texto, /Sousa e Magalhaes/);
});

test('sem dado cadastrado a lacuna SOBRA — não inventa', () => {
  const r = preencherLacunas(MSG_RENILSON, { chavePix: null, titularPix: null, valorAntecipado: null });
  assert.equal(r.restantes.length, 2);
  assert.equal(r.texto, MSG_RENILSON);
});

test('lacuna que não é chave nem valor sobra', () => {
  const r = preencherLacunas('atendemos de [horário de funcionamento]', RIO_VERDE);
  assert.deepEqual(r.restantes, ['horário de funcionamento']);
});

test('texto limpo passa sem tocar', () => {
  const t = 'Sua consulta está marcada para quarta-feira às 16h. Confirma sua presença?';
  const r = preencherLacunas(t, RIO_VERDE);
  assert.equal(r.texto, t);
  assert.deepEqual(r.trocas, []);
});

test('várias lacunas na mesma mensagem', () => {
  const r = preencherLacunas('chave [chave], titular [titular], valor R$ [valor]', RIO_VERDE);
  assert.deepEqual(r.restantes, []);
  assert.equal(r.trocas.length, 3);
});
