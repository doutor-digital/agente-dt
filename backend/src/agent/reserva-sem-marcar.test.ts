import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocoDaConsulta, datasCitadas, marcasDoQuando, marcouNesteTurno, promptTemConsulta, reservaSemMarcar, semOTrecho } from './reserva-sem-marcar.js';

const SEM_NADA = { marcouAgora: false, consultasValidas: [] as string[] };

test('Anderson (Olímpia, 19/10): "vou deixar reservado" sem consulta é barrado', () => {
  const t = 'Perfeito, Anderson! Vou deixar reservado pra você. Só confirmando: você consegue vir terça-feira, 20/10, às 11h30? 😊';
  const p = reservaSemMarcar(t, SEM_NADA);
  assert.ok(p, 'devia barrar');
  assert.match(p!.trecho, /reservado/i);
});

test('o exemplo que o próprio prompt ensinava também é barrado', () => {
  assert.ok(reservaSemMarcar('Deixo reservado pra você. Pra eu fechar: você consegue vir quinta, 24/09, às 15h?', SEM_NADA));
});

test('com consulta marcada neste turno, ou falando da MESMA data da consulta que existe, passa', () => {
  const t = '✅ Agendamento confirmado, Marcos! ⭐ Data: terça-feira, 20/10/2026 ⏰ Horário: 11:30';
  assert.equal(reservaSemMarcar(t, { marcouAgora: true }), null);
  const bloco = 'Consulta CONFIRMADA agora no sistema da clínica: **terça-feira, 20/10, às 11h30**';
  assert.equal(reservaSemMarcar('Sua consulta está marcada pra terça, 20/10, às 11h30.', { marcouAgora: false, consultasValidas: [bloco] }), null);
  assert.equal(reservaSemMarcar('Sua consulta está confirmada.', { marcouAgora: false, consultasValidas: [bloco] }), null, 'sem data = fala da que existe');
  assert.equal(reservaSemMarcar('Fica reservado terça, 20/10, às 11h30!', { marcouAgora: false, consultasValidas: ['2026-10-20T11:30'] }), null, 'vínculo do agendar');
});

test('ter OUTRA consulta não libera promessa de data nova (achado do Codex)', () => {
  const bloco = '- Próximo agendamento: sessão em **quarta, 21/10, às 9h**.';
  assert.ok(reservaSemMarcar('Deixo reservado pra sexta, 23/10, às 15h!', { marcouAgora: false, consultasValidas: [bloco] }));
});

test('com consulta existente: dia da semana ou hora diferentes continuam barrados (2º achado do Codex)', () => {
  const bloco = 'Consulta CONFIRMADA agora no sistema da clínica: **terça-feira, 20/10, às 11h30**';
  const ev = { marcouAgora: false, consultasValidas: [bloco] };
  assert.ok(reservaSemMarcar('Deixo reservado pra sexta às 15h!', ev), 'outro dia da semana');
  assert.ok(reservaSemMarcar('Fica reservado terça, 20/10, às 15h!', ev), 'mesmo dia, outra hora');
  assert.equal(reservaSemMarcar('Fica reservado terça às 11h30, combinado!', ev), null, 'mesma consulta');
  const doVinculo = { marcouAgora: false, consultasValidas: ['2026-10-20T11:30'] };
  assert.equal(reservaSemMarcar('Fica reservado terça às 11h30!', doVinculo), null, 'vínculo: terça 11:30');
  assert.ok(reservaSemMarcar('Fica reservado quarta às 11h30!', doVinculo));
});

test('marcas do quando: data, dia e hora em vários formatos', () => {
  const m = marcasDoQuando('terça-feira, 20/10, às 11h30 ou 14:00 e às 9h');
  assert.deepEqual([...m.datas], ['20/10']);
  assert.deepEqual([...m.dias], ['terca']);
  assert.deepEqual([...m.horas].sort(), ['11:30', '14:00', '9:00']);
  const v = marcasDoQuando('2026-10-20T07:00');
  assert.deepEqual([...v.dias], ['terca']);
  assert.deepEqual([...v.horas], ['7:00']);
});

test('datas: dd/mm e AAAA-MM-DD viram a mesma coisa; bloco do prompt é extraído', () => {
  assert.deepEqual([...datasCitadas('terça, 20/10 às 11h30 e 2026-10-21T07:00')].sort(), ['20/10', '21/10']);
  assert.deepEqual([...datasCitadas('dia 05/03')], ['5/3']);
  assert.equal(blocoDaConsulta('a <consulta_do_paciente>\nX 20/10\n</consulta_do_paciente> b').trim(), 'X 20/10');
  assert.equal(blocoDaConsulta('sem bloco'), '');
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
