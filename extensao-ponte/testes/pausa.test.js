// As opções de "Pausar a Sofia neste paciente": as datas de cada opção, o limite de 30 dias e o estado da Sofia
// depois de pausar/retomar. O servidor confere o mesmo arquivo em backend/src/lib/ponte-pausa.test.ts.
process.env.TZ = 'America/Sao_Paulo'; // o relógio da atendente

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../pausa.js');

const HORA = 3600 * 1000;
const DIA = 24 * HORA;
// terça, 13/10/2026, 14:30 em São Paulo
const agora = new Date('2026-10-13T17:30:00.000Z');

describe('pausa — até quando, por opção', () => {
  it('amanhã às 8h, 3 dias e 1 semana', () => {
    assert.equal(P.fimDaPausa('amanha8', agora).ate.toISOString(), '2026-10-14T11:00:00.000Z');
    assert.equal(P.fimDaPausa('3dias', agora).ate.getTime() - agora.getTime(), 3 * DIA);
    assert.equal(P.fimDaPausa('1semana', agora).ate.getTime() - agora.getTime(), 7 * DIA);
  });

  it('amanhã às 8h é amanhã mesmo de madrugada (00:30 → 8h do dia seguinte, não de hoje)', () => {
    const madrugada = new Date('2026-10-14T03:30:00.000Z'); // 00:30 de 14/10 em SP
    assert.equal(P.fimDaPausa('amanha8', madrugada).ate.toISOString(), '2026-10-15T11:00:00.000Z');
  });

  it('escolher a data: volta às 8h do dia escolhido', () => {
    assert.equal(P.fimDaPausa('data', agora, '2026-10-20').ate.toISOString(), '2026-10-20T11:00:00.000Z');
  });

  it('escolher a data: vazia, inexistente, no passado ou hoje depois das 8h é recusada', () => {
    assert.match(P.fimDaPausa('data', agora, '').erro, /Escolha o dia/);
    assert.match(P.fimDaPausa('data', agora, '2026-02-30').erro, /não existe/);
    assert.match(P.fimDaPausa('data', agora, '2026-10-01').erro, /futura/);
    assert.match(P.fimDaPausa('data', agora, '2026-10-13').erro, /futura/, 'hoje às 8h já passou às 14h30');
    assert.match(P.fimDaPausa('qualquer', agora).erro, /Escolha até quando/);
  });

  it('o limite de 30 dias: a data máxima passa, um dia depois não', () => {
    const max = P.dataMaxima(agora);
    assert.equal(max, '2026-11-12');
    assert.ok(P.fimDaPausa('data', agora, max).ate, 'a data máxima cabe');
    assert.match(P.fimDaPausa('data', agora, '2026-11-13').erro, new RegExp(String(P.MAX_DIAS) + ' dias'));
    assert.equal(P.MAX_DIAS, 30);
  });

  it('data máxima recua um dia quando a volta às 8h passaria dos 30 dias (pausa feita antes das 8h)', () => {
    const cedo = new Date('2026-10-13T09:00:00.000Z'); // 06:00 em SP
    const max = P.dataMaxima(cedo);
    assert.equal(max, '2026-11-11');
    const fim = P.fimDaPausa('data', cedo, max).ate;
    assert.ok(fim.getTime() - cedo.getTime() <= 30 * DIA);
  });

  it('data mínima: hoje antes das 8h, amanhã depois', () => {
    assert.equal(P.dataMinima(new Date('2026-10-13T09:00:00.000Z')), '2026-10-13');
    assert.equal(P.dataMinima(agora), '2026-10-14');
  });

  it('as quatro opções, na ordem do painel', () => {
    assert.deepEqual(P.OPCOES.map((o) => o.id), ['amanha8', '3dias', '1semana', 'data']);
  });
});

describe('pausa — o estado da Sofia no painel depois de pausar e retomar', () => {
  const pausa = { ate: '2026-10-14T11:00:00.000Z', motivo: null, por: 'Ana' };

  it('ativa → pausada neste paciente, com a data', () => {
    assert.deepEqual(P.sofiaDepois({ pausada: false, por: null, ate: null }, pausa), { pausada: true, por: 'janela', ate: pausa.ate });
  });

  it('retomar tira a pausa com data', () => {
    assert.deepEqual(P.sofiaDepois({ pausada: true, por: 'janela', ate: pausa.ate }, null), { pausada: false, por: null, ate: null });
  });

  it('as travas mais fortes continuam: unidade inteira, fora do horário, caixinha da SDR', () => {
    for (const por of ['unidade', 'horario', 'caixinha']) {
      const s = { pausada: true, por, ate: null };
      assert.equal(P.sofiaDepois(s, pausa), s);
      assert.equal(P.sofiaDepois(s, null), s);
    }
  });
});
