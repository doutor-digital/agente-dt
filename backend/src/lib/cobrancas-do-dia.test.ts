import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cobrancasNoDia, ehEnvioDeRetomada, limiteDoDiaAtingido, LIMITE_COBRANCAS_POR_DIA, marcaDoDegrau } from './cobrancas-do-dia.js';

const ARAGUAINA = 'America/Araguaina'; // UTC−3, sem horário de verão
const BOA_VISTA = 'America/Boa_Vista'; // UTC−4

/** Hora local de Araguaína em 15/10/2026 → instante. */
const em = (hhmm: string, dia = '2026-10-15') => new Date(`${dia}T${hhmm}:00-03:00`);

test('limite do dia é 2', () => {
  assert.equal(LIMITE_COBRANCAS_POR_DIA, 2);
});

test('Araguaína, lead 28655414 (15/10): dos degraus de 08:30, 09:28, 11:28 e 17:29 só saem os dois primeiros', () => {
  // A régua tentou estes quatro no mesmo dia (oferta da Sofia às 08:20, paciente calada).
  const tentativas = ['08:30', '09:28', '11:28', '17:29'].map((h) => em(h));
  const enviados: Date[] = [];
  for (const agora of tentativas) {
    if (limiteDoDiaAtingido(enviados, agora, ARAGUAINA)) continue;
    enviados.push(agora);
  }
  assert.deepEqual(
    enviados.map((d) => d.toISOString()),
    [em('08:30').toISOString(), em('09:28').toISOString()],
  );
});

test('o que saiu ontem não conta hoje: a régua volta a poder cobrar depois da meia-noite local', () => {
  const ontem = [em('10:00', '2026-10-14'), em('15:00', '2026-10-14')];
  assert.equal(cobrancasNoDia(ontem, em('08:05'), ARAGUAINA), 0);
  assert.equal(limiteDoDiaAtingido(ontem, em('08:05'), ARAGUAINA), false);
  assert.equal(limiteDoDiaAtingido([...ontem, em('08:05')], em('09:00'), ARAGUAINA), false, 'uma hoje: ainda cabe a segunda');
});

test('o dia é o da UNIDADE: 23:30 de Boa Vista ainda é o mesmo dia, mesmo já sendo dia seguinte em Brasília', () => {
  // 15/10 23:30 em Boa Vista = 16/10 03:30 UTC = 16/10 00:30 em Brasília.
  const tarde = new Date('2026-10-15T20:00:00-04:00');
  const noite = new Date('2026-10-15T23:30:00-04:00');
  assert.equal(cobrancasNoDia([tarde], noite, BOA_VISTA), 1);
  assert.equal(cobrancasNoDia([tarde], noite, 'America/Sao_Paulo'), 0, 'em Brasília já virou o dia');
});

test('só degrau da régua e reativação contam como cobrança — resposta da Sofia e mensagem da equipe não', () => {
  assert.equal(ehEnvioDeRetomada({ followUp: 3 }), true);
  assert.equal(ehEnvioDeRetomada({ reactivation: 1 }), true);
  assert.equal(ehEnvioDeRetomada({ origem: 'kommo_talks' }), false);
  assert.equal(ehEnvioDeRetomada(null), false);
  assert.equal(ehEnvioDeRetomada({ followUp: null }), false);
});

test('a marca que o degrau grava é a mesma que o limite conta', () => {
  assert.deepEqual(marcaDoDegrau(1), { followUp: 1 });
  assert.equal(ehEnvioDeRetomada(marcaDoDegrau(1)), true);
  assert.equal(ehEnvioDeRetomada(marcaDoDegrau(5)), true);
});
