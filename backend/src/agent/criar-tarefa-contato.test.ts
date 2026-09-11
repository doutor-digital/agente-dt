import test from 'node:test';
import assert from 'node:assert/strict';
import { prefixarContato } from './tools.js';

test('prefixarContato: tarefa da ação de unidade ganha [Contato: nome] na frente', () => {
  assert.equal(
    prefixarContato('URGENTE: paciente com sinal de alerta clínico — orientar pronto-atendimento e ligar já', 'Maria 11/09/2026'),
    '[Contato: Maria 11/09/2026] URGENTE: paciente com sinal de alerta clínico — orientar pronto-atendimento e ligar já',
  );
});

test('prefixarContato: quem já traz a marca passa intacto (não duplica)', () => {
  const t = 'ALERTA · doutor-hernia-serra · [Contato: Luiz] pediu para remarcar';
  assert.equal(prefixarContato(t, 'Luiz'), t);
  assert.equal(prefixarContato('  [contato: Ana] algo  ', 'Outra'), '[contato: Ana] algo');
});

test('prefixarContato: sem nome, a tarefa sai como veio', () => {
  assert.equal(prefixarContato('Ligar para o paciente', null), 'Ligar para o paciente');
  assert.equal(prefixarContato('Ligar para o paciente', '   '), 'Ligar para o paciente');
});
