import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marcouNesteTurno, promptTemConsulta, reservaSemMarcar, semOTrecho } from './reserva-sem-marcar.js';

const SEM_NADA = { marcouAgora: false, temConsulta: false };

test('Anderson (Olímpia, 19/10): "vou deixar reservado" sem consulta é barrado', () => {
  const t = 'Perfeito, Anderson! Vou deixar reservado pra você. Só confirmando: você consegue vir terça-feira, 20/10, às 11h30? 😊';
  const p = reservaSemMarcar(t, SEM_NADA);
  assert.ok(p, 'devia barrar');
  assert.match(p!.trecho, /reservado/i);
});

test('o exemplo que o próprio prompt ensinava também é barrado', () => {
  assert.ok(reservaSemMarcar('Deixo reservado pra você. Pra eu fechar: você consegue vir quinta, 24/09, às 15h?', SEM_NADA));
});

test('com consulta marcada neste turno ou no prompt, a mesma frase passa', () => {
  const t = '✅ Agendamento confirmado, Marcos! ⭐ Data: terça-feira, 20/10/2026 ⏰ Horário: 11:30';
  assert.equal(reservaSemMarcar(t, { marcouAgora: true, temConsulta: false }), null);
  assert.equal(reservaSemMarcar('Sua consulta está marcada pra terça, 20/10, às 11h30.', { marcouAgora: false, temConsulta: true }), null);
});

test('oferta, pergunta, condição e explicação de preço não são promessa', () => {
  for (const t of [
    'Não precisa pagar antes — a vaga fica reservada e você paga no dia, tá? Qual horário prefere?',
    'O Pix antecipado garante seu horário reservado. Prefere Pix ou na clínica?',
    'Se quiser, já deixo reservado terça às 11h30.',
    'Deixo reservado pra você?',
    'Pra eu já deixar reservado: qual desses três horários fica melhor pra você, terça 11h30 ou quarta 7h? 😊',
    'Quer que eu deixe reservado terça, 20/10, às 11h30?',
    'Tenho terça às 11h30 ou quarta às 7h. Qual fica melhor pra você?',
    'Assim que você fizer o Pix, já garanto sua vaga de terça 💙 Consegue me confirmar?',
  ]) {
    assert.equal(reservaSemMarcar(t, SEM_NADA), null, t);
  }
});

test('o que agendar_consulta e remarcar_consulta devolvem conta como marcado', () => {
  assert.equal(marcouNesteTurno(['Consulta marcada para terça-feira, 20/10/2026 às 11:30. Envie a chave…']), true);
  assert.equal(marcouNesteTurno(['Remarcada de sexta para segunda. …']), true);
  assert.equal(marcouNesteTurno(['A CONSULTA NOVA ESTÁ MARCADA para segunda — pode confirmar…']), true);
  assert.equal(marcouNesteTurno(['Consulta NÃO marcada ainda. Antes de reservar falta: …', 'RECUSADO: nesta unidade…']), false);
  assert.equal(marcouNesteTurno([]), false);
});

test('prompt com consulta de verdade: confirmada, não confirmada, ou próximo agendamento da franquia', () => {
  assert.equal(promptTemConsulta('<consulta_do_paciente>\nConsulta CONFIRMADA agora no sistema da clínica: **terça**'), true);
  assert.equal(promptTemConsulta('Este paciente TEM consulta marcada, mas eu NÃO consegui confirmar'), true);
  assert.equal(promptTemConsulta('- Próximo agendamento: sessão em **quarta, 21/10, às 9h**.'), true);
  assert.equal(promptTemConsulta('- Não há nenhum agendamento futuro marcado.'), false);
  assert.equal(promptTemConsulta('A consulta deste paciente era sexta e essa data JÁ PASSOU'), false);
  assert.equal(promptTemConsulta(undefined), false);
});

test('último recurso: tira só o trecho que promete', () => {
  const t = 'Perfeito, Anderson! Vou deixar reservado pra você. Só confirmando: você consegue vir terça-feira, 20/10, às 11h30? 😊';
  const p = reservaSemMarcar(t, SEM_NADA)!;
  const r = semOTrecho(t, p.trecho);
  assert.ok(r);
  assert.ok(!/reservad/i.test(r!), r!);
  assert.match(r!, /^Perfeito, Anderson! Só confirmando: você consegue vir terça-feira, 20\/10, às 11h30\? 😊$/);
  assert.equal(semOTrecho('Fica reservado!', 'Fica reservado'), null, 'sobra quase nada');
  assert.equal(semOTrecho('abc', 'xyz'), null);
});
