import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  avaliacoesPorDia,
  destinoDaAvaliacao,
  faixaDaNota,
  faixasDeNota,
  noPeriodo,
  piorAvaliacao,
  unidadesPiores,
} from './agregar.js';
import type { LinhaDeAvaliacao } from './tipos.js';

let seq = 0;
const linha = (o: Partial<LinhaDeAvaliacao> = {}): LinhaDeAvaliacao => ({
  quebrada: false,
  conversationId: `c${seq++}`,
  unitId: 'u1',
  unidade: 'Serra',
  dia: '2026-10-26',
  nota: 6,
  sofiaFalou: true,
  pacienteRespondeu: true,
  ganhou: false,
  comConsulta: false,
  ...o,
});

test('destino: sem fala da Sofia, paciente sumiu, ou avaliável — nessa ordem de precedência', () => {
  assert.equal(destinoDaAvaliacao({ sofiaFalou: false, pacienteRespondeu: false }), 'sem-sofia');
  assert.equal(destinoDaAvaliacao({ sofiaFalou: false, pacienteRespondeu: true }), 'sem-sofia', 'sem Sofia vence');
  assert.equal(destinoDaAvaliacao({ sofiaFalou: true, pacienteRespondeu: false }), 'sumiu');
  assert.equal(destinoDaAvaliacao({ sofiaFalou: true, pacienteRespondeu: true }), 'avaliavel');
});

test('por dia: a média é só das avaliáveis — nota de conversa sem Sofia não entra', () => {
  const dias = avaliacoesPorDia([
    linha({ nota: 8 }),
    linha({ nota: 4 }),
    linha({ nota: 1, sofiaFalou: false, pacienteRespondeu: false }),
    linha({ nota: 2, pacienteRespondeu: false }),
    linha({ dia: '2026-10-25', nota: 5 }),
  ]);
  assert.deepEqual(dias.map((d) => d.dia), ['2026-10-25', '2026-10-26']);
  const d = dias[1];
  assert.deepEqual({ total: d.total, semSofia: d.semSofia, sumiu: d.sumiu, avaliaveis: d.avaliaveis }, { total: 4, semSofia: 1, sumiu: 1, avaliaveis: 2 });
  assert.equal(d.mediaAvaliaveis, 6, 'média ingênua das 4 notas seria 3,75');
  assert.equal(avaliacoesPorDia([linha({ sofiaFalou: false })])[0].mediaAvaliaveis, null);
});

test('avaliação quebrada (nota 0 de artefato) não entra na média, no ranking, nas faixas nem na pior conversa', () => {
  const l = [
    linha({ nota: 8 }),
    linha({ nota: 6 }),
    linha({ nota: 0, quebrada: true }),
    linha({ nota: 0, quebrada: true, unitId: 'b', unidade: 'B' }),
  ];
  const d = avaliacoesPorDia(l)[0];
  assert.deepEqual({ total: d.total, quebradas: d.quebradas, avaliaveis: d.avaliaveis, semSofia: d.semSofia, sumiu: d.sumiu }, { total: 4, quebradas: 2, avaliaveis: 2, semSofia: 0, sumiu: 0 });
  assert.equal(d.mediaAvaliaveis, 7, 'com as duas quebradas a média seria 3,5');
  assert.deepEqual(unidadesPiores(l, 1).map((u) => u.nome), ['Serra'], 'a unidade B só tem avaliação quebrada');
  assert.equal(piorAvaliacao(l)?.nota, 6, 'a pior conversa não é uma nota 0 quebrada');
  assert.equal(faixasDeNota(l).find((f) => f.faixa === 'baixa')?.conversas, 0);
  assert.equal(destinoDaAvaliacao({ sofiaFalou: false, pacienteRespondeu: false, quebrada: true }), 'quebrada', 'quebrada vence as outras');
});

test('unidades piores: mínimo de avaliáveis, ordem crescente, máximo de 3', () => {
  const l = [
    ...Array.from({ length: 5 }, () => linha({ unitId: 'a', unidade: 'A', nota: 4 })),
    ...Array.from({ length: 5 }, () => linha({ unitId: 'b', unidade: 'B', nota: 5 })),
    ...Array.from({ length: 5 }, () => linha({ unitId: 'c', unidade: 'C', nota: 6 })),
    ...Array.from({ length: 5 }, () => linha({ unitId: 'd', unidade: 'D', nota: 7 })),
    // nota 1 mas só 4 conversas: não pode liderar o ranking
    ...Array.from({ length: 4 }, () => linha({ unitId: 'e', unidade: 'E', nota: 1 })),
    // e uma unidade cheia de conversa sem Sofia (nota 0) não pode puxar a média
    ...Array.from({ length: 9 }, () => linha({ unitId: 'f', unidade: 'F', nota: 0, sofiaFalou: false })),
  ];
  assert.deepEqual(unidadesPiores(l, 5).map((u) => u.nome), ['A', 'B', 'C']);
  assert.equal(unidadesPiores(l, 5)[0].media, 4);
  assert.deepEqual(unidadesPiores(l, 5, 1).map((u) => u.nome), ['A']);
  assert.deepEqual(unidadesPiores([], 5), []);
});

test('faixas: limites 5 e 7, conversão só das avaliáveis', () => {
  assert.equal(faixaDaNota(4.9), 'baixa');
  assert.equal(faixaDaNota(5), 'media');
  assert.equal(faixaDaNota(6.9), 'media');
  assert.equal(faixaDaNota(7), 'alta');
  const f = faixasDeNota([
    linha({ nota: 3, ganhou: true }),
    linha({ nota: 3 }),
    linha({ nota: 6, comConsulta: true }),
    linha({ nota: 9, ganhou: true, comConsulta: true }),
    linha({ nota: 9, sofiaFalou: false, ganhou: true }),
  ]);
  assert.deepEqual(f.map((x) => [x.faixa, x.conversas, x.ganhos, x.comConsulta]), [
    ['baixa', 2, 1, 0],
    ['media', 1, 0, 1],
    ['alta', 1, 1, 1],
  ]);
});

test('pior avaliação: a de menor nota entre as avaliáveis; no empate, a primeira da lista (mais recente)', () => {
  const a = linha({ nota: 1, sofiaFalou: false });
  const b = linha({ nota: 3 });
  const c = linha({ nota: 3 });
  assert.equal(piorAvaliacao([a, b, c]), b);
  assert.equal(piorAvaliacao([a]), null);
});

test('período: inclusive nas duas pontas', () => {
  const l = [linha({ dia: '2026-10-24' }), linha({ dia: '2026-10-25' }), linha({ dia: '2026-10-26' }), linha({ dia: '2026-10-27' })];
  assert.deepEqual(noPeriodo(l, '2026-10-25', '2026-10-26').map((x) => x.dia), ['2026-10-25', '2026-10-26']);
});
