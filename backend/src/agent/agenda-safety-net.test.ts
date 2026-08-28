import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOTIVO_ALEGA_FALTA_DE_VAGA } from './tools.js';

/**
 * O safety-net só entra quando a IA pausa o atendimento ALEGANDO falta de vaga sem
 * ter consultado a agenda. Estes testes cuidam da parte que decide isso.
 *
 * O primeiro caso é o motivo literal gravado em produção (Imperatriz, 28/08/2026,
 * lead 24954279) — a paciente com 3 noites sem dormir que virou tarefa manual.
 */

test('pega o motivo real que motivou o safety-net', () => {
  assert.ok(
    MOTIVO_ALEGA_FALTA_DE_VAGA.test(
      'Paciente quente pedindo encaixe hoje 16h, agenda sem vaga automática - equipe precisa buscar encaixe manual',
    ),
  );
});

test('pega as variações comuns de "não tenho horário"', () => {
  for (const motivo of [
    'agenda lotada esta semana',
    'agenda cheia, sem horário disponível',
    'Agenda concorrida no momento',
    'não há vaga para hoje',
    'não temos horários nesta data',
    'paciente quer encaixe urgente',
    'sem horários livres',
  ]) {
    assert.ok(MOTIVO_ALEGA_FALTA_DE_VAGA.test(motivo), `deveria pegar: ${motivo}`);
  }
});

test('não intercepta handoff legítimo que nada tem a ver com agenda', () => {
  // Estes têm de passar direto: a pausa é o comportamento certo, e atrasá-la com
  // uma consulta à agenda seria piorar o atendimento.
  for (const motivo of [
    'Paciente pediu para falar com um humano',
    'Reclamação sobre atendimento anterior',
    'Dúvida sobre cobertura do convênio',
    'Paciente irritado, precisa de supervisor',
    'Assunto financeiro: negociação de valores',
    'Paciente já é do tratamento, não é lead novo',
  ]) {
    assert.equal(
      MOTIVO_ALEGA_FALTA_DE_VAGA.test(motivo),
      false,
      `não deveria pegar: ${motivo}`,
    );
  }
});

test('é insensível a acento e caixa — o motivo é texto livre do modelo', () => {
  assert.ok(MOTIVO_ALEGA_FALTA_DE_VAGA.test('SEM HORARIO disponivel'));
  assert.ok(MOTIVO_ALEGA_FALTA_DE_VAGA.test('sem horário disponível'));
  assert.ok(MOTIVO_ALEGA_FALTA_DE_VAGA.test('Não Há Vaga'));
});
