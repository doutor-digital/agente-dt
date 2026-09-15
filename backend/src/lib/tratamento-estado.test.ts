import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classificarTratamento,
  protocoloCompleto,
  resumirTratamento,
  sessoesDoProtocolo,
  type SessaoDoPaciente,
} from './tratamento-estado.js';

const ATENDIDO = 42;
const NAO_COMPARECEU = 40;
const AGENDADO = 37;
const HOJE = new Date('2026-09-15T12:00:00-03:00');

const s = (dia: string, idStatus = ATENDIDO): SessaoDoPaciente => ({
  dateAttendanceUtc: `${dia}T10:00:00.000Z`,
  idStatus,
});

test('protocolo: o número de meses diz quantas sessões foram contratadas', () => {
  assert.equal(sessoesDoProtocolo('PROTOCOLO 01 MÊS'), 8);
  assert.equal(sessoesDoProtocolo('PROTOCOLO 02 MESES'), 16);
  assert.equal(sessoesDoProtocolo('PROTOCOLO 03 MESES'), 24);
  assert.equal(sessoesDoProtocolo('Protocolo 3 meses'), 24);
});

test('protocolo desconhecido conta 0 — nunca vira "completo" por engano', () => {
  // 0 é o lado seguro: sem previstas, protocoloCompleto é falso e o paciente
  // não pode ser classificado como CANDIDATO_ALTA.
  assert.equal(sessoesDoProtocolo('AVALIAÇÃO'), 0);
  assert.equal(sessoesDoProtocolo(null), 0);
  assert.equal(sessoesDoProtocolo('PROTOCOLO ANUAL'), 0);
  assert.equal(protocoloCompleto({ previstas: 0, realizadas: 30 }), false);
});

test('quem renovou soma os protocolos', () => {
  // A Angela fez 49 sessões porque renovou; escrever 24 diria que ela fez o
  // dobro do contratado.
  const r = resumirTratamento([], [{ category: 'PROTOCOLO 03 MESES' }, { category: 'PROTOCOLO 02 MESES' }], HOJE);
  assert.equal(r.previstas, 40);
});

test('"última sessão" é a última JÁ OCORRIDA, nunca a futura', () => {
  const r = resumirTratamento(
    [s('2026-09-10'), s('2026-09-12'), s('2026-09-16', AGENDADO)],
    [{ category: 'PROTOCOLO 03 MESES' }],
    HOJE,
  );
  assert.equal(r.ultimaFeita, '2026-09-12T10:00:00.000Z');
  assert.equal(r.proxima, '2026-09-16T10:00:00.000Z');
  assert.notEqual(r.ultimaFeita, r.proxima);
});

test('"compareceu" fala da última já ocorrida, não da que ainda vai acontecer', () => {
  const r = resumirTratamento(
    [s('2026-09-12', NAO_COMPARECEU), s('2026-09-16', AGENDADO)],
    [{ category: 'PROTOCOLO 01 MÊS' }],
    HOJE,
  );
  assert.equal(r.compareceu, 'Não');
});

test('realizadas conta só atendidas; falta não conta como sessão feita', () => {
  const r = resumirTratamento(
    [s('2026-09-01'), s('2026-09-03', NAO_COMPARECEU), s('2026-09-05')],
    [{ category: 'PROTOCOLO 01 MÊS' }],
    HOJE,
  );
  assert.equal(r.realizadas, 2);
  assert.equal(r.faltas, 1);
});

test('tem sessão futura: está em tratamento, mesmo com o protocolo completo', () => {
  // Regra 1 vence a 2: quem tem horário marcado está ativo, ponto.
  const r = resumirTratamento(
    [s('2026-08-01'), s('2026-09-20', AGENDADO)],
    [{ category: 'PROTOCOLO 01 MÊS' }],
    HOJE,
  );
  assert.equal(classificarTratamento({ ...r, realizadas: 8, previstas: 8 }, HOJE), 'EM_TRATAMENTO');
});

test('terminou o protocolo e não tem próxima: candidato a alta, não move sozinho', () => {
  const r = resumirTratamento([s('2026-09-08')], [{ category: 'PROTOCOLO 01 MÊS' }], HOJE);
  assert.equal(classificarTratamento({ ...r, realizadas: 8 }, HOJE), 'CANDIDATO_ALTA');
});

test('terminou o protocolo há POUCOS DIAS ainda é candidato a alta', () => {
  // O caso que fez a régua anterior somar 150 para 148 pessoas: quem termina o
  // protocolo dentro dos 30 dias casava em duas regras ao mesmo tempo.
  // "Terminou é terminou" — a regra 2 vence a 3.
  const r = resumirTratamento([s('2026-09-14')], [{ category: 'PROTOCOLO 01 MÊS' }], HOJE);
  assert.equal(classificarTratamento({ ...r, realizadas: 8 }, HOJE), 'CANDIDATO_ALTA');
});

test('sem próxima, protocolo incompleto, sessão recente: segue em tratamento', () => {
  const r = resumirTratamento([s('2026-09-10')], [{ category: 'PROTOCOLO 03 MESES' }], HOJE);
  assert.equal(classificarTratamento(r, HOJE), 'EM_TRATAMENTO');
});

test('sem próxima, protocolo incompleto, parado há mais de 30 dias: PAROU', () => {
  const r = resumirTratamento([s('2026-06-01')], [{ category: 'PROTOCOLO 03 MESES' }], HOJE);
  assert.equal(classificarTratamento(r, HOJE), 'PAROU');
});

test('o caso que motivou a régua: última sessão em 2025 não é "em tratamento hoje"', () => {
  const r = resumirTratamento([s('2025-10-18')], [{ category: 'PROTOCOLO 03 MESES' }], HOJE);
  assert.equal(classificarTratamento(r, HOJE), 'PAROU');
});

test('nunca fez sessão e não tem horário: SEM_SESSAO, fora de qualquer lista', () => {
  const r = resumirTratamento([], [{ category: 'PROTOCOLO 01 MÊS' }], HOJE);
  assert.equal(classificarTratamento(r, HOJE), 'SEM_SESSAO');
});

test('a fronteira dos 30 dias é fechada: exatamente 30 ainda está em tratamento', () => {
  const r = resumirTratamento([s('2026-08-16')], [{ category: 'PROTOCOLO 03 MESES' }], HOJE);
  assert.equal(classificarTratamento(r, HOJE), 'EM_TRATAMENTO');
  const r31 = resumirTratamento([s('2026-08-15')], [{ category: 'PROTOCOLO 03 MESES' }], HOJE);
  assert.equal(classificarTratamento(r31, HOJE), 'PAROU');
});

test('as quatro classes são mutuamente exclusivas: cada paciente cai em exatamente uma', () => {
  // A régua anterior não era exclusiva e a soma dava 150 para 148 pessoas.
  const casos: SessaoDoPaciente[][] = [
    [],
    [s('2026-09-14')],
    [s('2026-09-14'), s('2026-09-20', AGENDADO)],
    [s('2025-10-18')],
    [s('2026-09-10', NAO_COMPARECEU)],
  ];
  const vistos = new Set<string>();
  for (const sessoes of casos) {
    const r = resumirTratamento(sessoes, [{ category: 'PROTOCOLO 01 MÊS' }], HOJE);
    const c = classificarTratamento(r, HOJE);
    assert.ok(['EM_TRATAMENTO', 'CANDIDATO_ALTA', 'PAROU', 'SEM_SESSAO'].includes(c), `classe inesperada: ${c}`);
    vistos.add(c);
  }
  assert.ok(vistos.size >= 3, 'os casos deveriam exercitar pelo menos 3 classes distintas');
});
