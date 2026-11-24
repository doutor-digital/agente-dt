import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doisParaOferecer, ehHorarioDaGrade, gradeDoDia, horariosLivres, instante, intervalosOcupados, somarDias, dataLocal } from './horarios.js';

// 2026-11-18 é quarta; 2026-11-21 é sábado; 2026-12-25 é Natal (sexta).

test('grade: seg–sex, de hora em hora, 8h–12h e 14h–18h, 8 horários; o último de cada janela termina 11h50 e 17h50', () => {
  const g = gradeDoDia('2026-11-18');
  assert.deepEqual(g.map((s) => s.hora), ['08:00', '09:00', '10:00', '11:00', '14:00', '15:00', '16:00', '17:00']);
  assert.equal(g[3]!.fim - g[3]!.inicio, 50 * 60_000);
  assert.equal(g[3]!.fim, instante('2026-11-18', '11:50'));
  assert.equal(g[7]!.fim, instante('2026-11-18', '17:50'));
});

test('grade: fim de semana, feriado nacional e data inválida não têm horário', () => {
  assert.deepEqual(gradeDoDia('2026-11-21'), []);
  assert.deepEqual(gradeDoDia('2026-11-22'), []);
  assert.deepEqual(gradeDoDia('2026-12-25'), []);
  assert.deepEqual(gradeDoDia('18/11/2026'), []);
  assert.equal(ehHorarioDaGrade('2026-11-18', '12:00'), false);
  assert.equal(ehHorarioDaGrade('2026-11-18', '13:00'), false);
  assert.equal(ehHorarioDaGrade('2026-11-18', '09:30'), false);
  assert.equal(ehHorarioDaGrade('2026-11-18', '09:00'), true);
});

test('ocupação: dia inteiro (prazo, lembrete) não ocupa; sem fim ocupa 50 min; arquivada não conta', () => {
  const o = intervalosOcupados([
    { start: '2026-11-18T00:00:00-03:00', end: '2026-11-18T23:59:00-03:00', all_day: true },
    { start: '2026-11-18T10:00:00-03:00', end: null },
    { start: '2026-11-18T14:00:00-03:00', end: '2026-11-18T15:30:00-03:00' },
    { start: '2026-11-18T16:00:00-03:00', end: '2026-11-18T17:00:00-03:00', archived_at: '2026-11-01T00:00:00Z' },
    { start: null },
    { start: 'lixo' },
  ]);
  assert.equal(o.length, 2);
  assert.equal(o[0]!.fim - o[0]!.inicio, 50 * 60_000);
  assert.equal(o[1]!.fim - o[1]!.inicio, 90 * 60_000);
});

const AGORA = instante('2026-11-18', '05:00'); // quarta 5h: o corte de 2 h de antecedência cai às 7h, antes do 1º horário

test('livre = sem atividade sobreposta: evento 09:30–10:30 tira 09:00 e 10:00; 08:00 e 11:00 seguem livres', () => {
  const ocupado = { amanda: intervalosOcupados([{ start: '2026-11-18T09:30:00-03:00', end: '2026-11-18T10:30:00-03:00' }]) };
  const l = horariosLivres({ agora: AGORA, advogados: ['amanda'], ocupado, diasAFrente: 0 });
  assert.deepEqual(l.map((s) => s.hora), ['08:00', '11:00', '14:00', '15:00', '16:00', '17:00']);
});

test('atendimento que termina exatamente quando o próximo começa não sobrepõe', () => {
  const ocupado = { amanda: intervalosOcupados([{ start: '2026-11-18T08:00:00-03:00', end: '2026-11-18T09:00:00-03:00' }]) };
  const l = horariosLivres({ agora: AGORA, advogados: ['amanda'], ocupado, diasAFrente: 0 });
  assert.equal(l[0]!.hora, '09:00');
});

test('antecedência: a menos de 2 h do horário não se oferece; já passou, menos ainda', () => {
  const l = horariosLivres({ agora: instante('2026-11-18', '08:30'), advogados: ['amanda'], ocupado: {}, diasAFrente: 0 });
  assert.equal(l[0]!.hora, '11:00'); // 08:30 + 2h = 10:30 → 11:00
  const tarde = horariosLivres({ agora: instante('2026-11-18', '16:30'), advogados: ['amanda'], ocupado: {}, diasAFrente: 0 });
  assert.deepEqual(tarde, []);
});

test('dois advogados: horário que um tem ocupado sai com o outro; os dois livres aparecem UMA vez, com o menos carregado do dia', () => {
  const ocupado = {
    amanda: intervalosOcupados([{ start: '2026-11-18T08:00:00-03:00', end: '2026-11-18T08:50:00-03:00' }]),
    victor: [],
  };
  const l = horariosLivres({ agora: AGORA, advogados: ['amanda', 'victor'], ocupado, diasAFrente: 0 });
  assert.equal(l.filter((s) => s.hora === '08:00').length, 1);
  assert.equal(l.find((s) => s.hora === '08:00')!.advogado, 'victor');
  assert.equal(l.find((s) => s.hora === '09:00')!.advogado, 'victor'); // Amanda tem 1 no dia, Victor 0
});

test('os dois lotados: nenhum horário (nada inventado)', () => {
  const cheio = intervalosOcupados([{ start: '2026-11-18T08:00:00-03:00', end: '2026-11-18T18:00:00-03:00' }]);
  assert.deepEqual(horariosLivres({ agora: AGORA, advogados: ['amanda', 'victor'], ocupado: { amanda: cheio, victor: cheio }, diasAFrente: 0 }), []);
});

test('pula fim de semana e segue nos dias úteis seguintes', () => {
  const sexta17 = instante('2026-11-20', '17:30'); // sexta 20/11 (dia da Consciência Negra: feriado nacional)
  const l = horariosLivres({ agora: sexta17, advogados: ['amanda'], ocupado: {}, diasAFrente: 5 });
  assert.equal(l[0]!.data, '2026-11-23'); // segunda
});

test('dois para oferecer: o mais cedo e o primeiro de outro dia ou período', () => {
  const l = horariosLivres({ agora: AGORA, advogados: ['amanda'], ocupado: {}, diasAFrente: 1 });
  const dois = doisParaOferecer(l);
  assert.equal(dois.length, 2);
  assert.equal(dois[0]!.hora, '08:00');
  assert.equal(dois[1]!.hora, '14:00'); // outro período do mesmo dia
});

test('datas locais: UTC-3 e somar dias', () => {
  assert.equal(dataLocal(Date.parse('2026-11-18T02:00:00Z')), '2026-11-17');
  assert.equal(somarDias('2026-11-30', 1), '2026-12-01');
});
