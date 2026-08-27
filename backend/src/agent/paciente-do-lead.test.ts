import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pacienteConfere } from './agenda-tools.js';

/**
 * `agendar_consulta` recebia o `idClient` que o MODELO escreveu, sem conferir com
 * o cadastro que `buscar_paciente` já tinha confirmado pelo telefone e gravado no
 * lead. Marcar, remarcar ou CANCELAR a consulta de outra pessoa passava batido —
 * e a resposta ao paciente parece normal, então o guardrail de saída não pega.
 */

const PACIENTE_DESTE_LEAD = 351701;
const OUTRO_PACIENTE = 348015;

test('idClient de outro paciente é recusado, e diz qual é o certo', () => {
  const r = pacienteConfere(PACIENTE_DESTE_LEAD, OUTRO_PACIENTE);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.idClientCerto, PACIENTE_DESTE_LEAD);
});

test('o paciente certo passa', () => {
  assert.equal(pacienteConfere(PACIENTE_DESTE_LEAD, PACIENTE_DESTE_LEAD).ok, true);
});

test('lead sem vínculo passa — é paciente novo, não há com o que comparar', () => {
  // Acabou de sair do cadastrar_paciente: o vínculo ainda não foi gravado.
  assert.equal(pacienteConfere(null, 999001).ok, true);
  assert.equal(pacienteConfere(undefined, 999001).ok, true);
  assert.equal(pacienteConfere(0, 999001).ok, true);
});

test('a recusa nunca aponta para o paciente errado', () => {
  const r = pacienteConfere(PACIENTE_DESTE_LEAD, OUTRO_PACIENTE);
  assert.notEqual(r.ok === false && r.idClientCerto, OUTRO_PACIENTE);
});
