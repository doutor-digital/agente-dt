import test from 'node:test';
import assert from 'node:assert/strict';
import { DIVISAO_COM_A_IA } from './divisao-com-a-ia.js';
import { instrucoesDaVoz } from './voz.js';
import { REGRAS_DO_COPILOTO } from './prompt.js';

test('a divisão com a IA diz o que a Sofia faz e manda aceitar o que a pessoa contar da unidade dela', () => {
  assert.match(DIVISAO_COM_A_IA, /Sofia/);
  assert.match(DIVISAO_COM_A_IA, /registra sozinha no cartão/);
  assert.match(DIVISAO_COM_A_IA, /VARIA por unidade e por etapa/);
  assert.match(DIVISAO_COM_A_IA, /quase não preenche: ela OLHA e CONFERE/);
  assert.match(DIVISAO_COM_A_IA, /diga "confira" \(e não "preencha"\)/);
  assert.match(DIVISAO_COM_A_IA, /ACEITE/);
  assert.match(DIVISAO_COM_A_IA, /não mande confirmar com a coordenação/);
});

test('voz: a regra errada saiu e a divisão com a IA entrou, com e sem etapa', () => {
  for (const etapa of [null, 'EM QUALIFICAÇÃO', 'AGENDADO']) {
    const t = instrucoesDaVoz(etapa);
    assert.doesNotMatch(t, /quem preenche campo e move o cartão é a pessoa/);
    assert.match(t, /Você não altera nada no Kommo/);
    assert.match(t, /DIVISÃO DE TRABALHO COM A IA/);
  }
  assert.match(instrucoesDaVoz('EM QUALIFICAÇÃO'), /pode ser a Sofia ou a atendente/);
});

test('texto: continua "Você NÃO grava nada", sem dizer que quem digita é sempre a atendente, e traz a divisão', () => {
  assert.match(REGRAS_DO_COPILOTO, /Você NÃO grava nada no Kommo/);
  assert.doesNotMatch(REGRAS_DO_COPILOTO, /Quem digita no Kommo é a atendente\./);
  assert.match(REGRAS_DO_COPILOTO, /DIVISÃO DE TRABALHO COM A IA/);
});
