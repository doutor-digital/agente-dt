import { test } from 'node:test';
import assert from 'node:assert/strict';

import { motivoDeNaoCancelar } from './cancelavel.js';

const AGORA = '2026-10-26T13:00';

test('só cancela consulta FUTURA e de pé', () => {
  assert.equal(motivoDeNaoCancelar({ quando: '2026-10-27T14:00', idStatus: 37 }, AGORA), null, 'agendada, amanhã');
  assert.equal(motivoDeNaoCancelar({ quando: '2026-10-27T14:00', idStatus: 38 }, AGORA), null, 'confirmada, amanhã');
  assert.equal(motivoDeNaoCancelar({ quando: '2026-10-27T14:00' }, AGORA), null, 'sem status: confia na data futura');
});

test('passada ou em andamento: nunca', () => {
  assert.match(motivoDeNaoCancelar({ quando: '2026-10-25T14:00', idStatus: 37 }, AGORA) ?? '', /já passou/);
  assert.match(motivoDeNaoCancelar({ quando: '2026-10-26T13:00', idStatus: 37 }, AGORA) ?? '', /já passou ou está acontecendo/);
  assert.match(motivoDeNaoCancelar({ quando: '2026-10-26T09:00', idStatus: 38 }, AGORA) ?? '', /já passou/);
});

test('ATENDIDA aparece como "confirmada" no reconciliador — a ferramenta não cancela (nem a futura marcada como atendida)', () => {
  assert.match(motivoDeNaoCancelar({ quando: '2026-10-27T14:00', idStatus: 42 }, AGORA) ?? '', /ATENDIDA/);
  assert.match(motivoDeNaoCancelar({ quando: '2026-10-25T14:00', idStatus: 42 }, AGORA) ?? '', /ATENDIDA/);
  assert.match(motivoDeNaoCancelar({ quando: '2026-10-27T14:00', idStatus: 40 }, AGORA) ?? '', /NÃO COMPARECEU/);
  assert.match(motivoDeNaoCancelar({ quando: '2026-10-27T14:00', idStatus: 57 }, AGORA) ?? '', /DESMARCADA/);
});

test('sem data não há como provar que é futura: não cancela', () => {
  assert.match(motivoDeNaoCancelar({ quando: null, idStatus: 37 }, AGORA) ?? '', /não sei o dia/);
});

import { perguntadoEmOutroTurno } from './cancelavel.js';

test('confirmado=true só passa se a pergunta nomeada foi feita em OUTRO turno, e há pouco', () => {
  const agora = new Date('2026-10-26T15:00:00Z');
  const marca = (trace: string, h: number) => ({ ruleKey: `cancelar_pergunta:${trace}`, createdAt: new Date(agora.getTime() - h * 3600_000) });
  assert.equal(perguntadoEmOutroTurno([], 't2', agora), false, 'nunca perguntou');
  assert.equal(perguntadoEmOutroTurno([marca('t2', 0)], 't2', agora), false, 'perguntou NESTE turno: "pode cancelar" dito antes não vale');
  assert.equal(perguntadoEmOutroTurno([marca('t1', 0.1)], 't2', agora), true, 'perguntou no turno anterior');
  assert.equal(perguntadoEmOutroTurno([marca('t1', 72)], 't2', agora), false, 'pergunta velha demais');
  assert.equal(perguntadoEmOutroTurno([{ ruleKey: 'outra_regra:t1', createdAt: agora }], 't2', agora), false, 'outra marca do cartão não conta');
});
