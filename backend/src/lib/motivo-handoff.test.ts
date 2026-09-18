import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classificarMotivoHandoff } from './motivo-handoff.js';

test('motivos típicos da IA caem na opção certa', () => {
  const casos: Array<[string, string | null]> = [
    ['paciente pediu para falar com um atendente humano', 'Pedido do lead'],
    ['lead quer falar com a recepção', 'Pedido do lead'],
    ['paciente mandou o comprovante do pix, fechamento', 'Fechamento'],
    ['quer pagar a entrada no cartão em 3 parcelas', 'Fechamento'],
    ['fora do horário comercial, agenda fecha às 18h', 'Fora do horário'],
    ['paciente irritado, reclamando do atendimento', 'Escalonamento'],
    ['relata dor muito forte e formigamento nas pernas (bandeira vermelha)', 'Escalonamento'],
    ['não sei responder sobre convênio, não está nas fontes oficiais', 'IA não soube'],
    ['agenda sem vaga para o dia pedido', 'IA não soube'],
    ['', null],
    ['   ', null],
    ['xyz', null],
  ];
  for (const [motivo, esperado] of casos) assert.equal(classificarMotivoHandoff(motivo), esperado, motivo);
});

test('fora do horário vence pedido do lead quando os dois aparecem', () => {
  assert.equal(classificarMotivoHandoff('paciente pediu humano mas estamos fora do horário'), 'Fora do horário');
});
