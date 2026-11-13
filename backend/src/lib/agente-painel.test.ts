/**
 * Painel da Sofia (tela Agente): pessoas respondidas = conversas distintas; marcadas; conversão; equipe/Pix pelas ferramentas; à
 * noite e no fim de semana no fuso da unidade; período anterior do mesmo tamanho; 14 dias no gráfico.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foraDoHorario, janelas, lerPeriodo, montarPainel, partesLocais } from './agente-painel.js';

const FUSO = 'America/Belem'; // UTC-3, sem horário de verão
const agora = new Date('2026-11-13T18:00:00Z'); // sexta, 15h em Belém
const h = (horasAtras: number) => new Date(agora.getTime() - horasAtras * 3_600_000);

test('partes locais e fora do horário no fuso da unidade', () => {
  assert.deepEqual(partesLocais(new Date('2026-11-13T23:30:00Z'), FUSO), { dia: '2026-11-13', hora: 20, minuto: 30, segundo: 0, semana: 5 });
  assert.equal(foraDoHorario(new Date('2026-11-13T23:30:00Z'), FUSO), true, '20h30 de sexta');
  assert.equal(foraDoHorario(new Date('2026-11-13T13:00:00Z'), FUSO), false, '10h de sexta');
  assert.equal(foraDoHorario(new Date('2026-11-14T13:00:00Z'), FUSO), true, 'sábado');
  assert.equal(foraDoHorario(new Date('2026-11-13T10:59:00Z'), FUSO), true, '7h59');
});

test('janelas: hoje começa à meia-noite do fuso e compara com ontem até a mesma hora; 7 dias = 7 × 7 antes', () => {
  const j = janelas(agora, 'hoje', FUSO);
  assert.equal(j.inicio.toISOString(), '2026-11-13T03:00:00.000Z');
  assert.equal(j.antesInicio.toISOString(), '2026-11-12T03:00:00.000Z');
  assert.equal(j.antesFim.toISOString(), '2026-11-12T18:00:00.000Z');
  const s = janelas(agora, '7', FUSO);
  assert.equal(s.inicio.toISOString(), '2026-11-06T18:00:00.000Z');
  assert.equal(s.antesInicio.toISOString(), '2026-10-30T18:00:00.000Z');
  assert.equal(lerPeriodo('qualquer'), '7');
  assert.equal(lerPeriodo('hoje'), 'hoje');
});

test('montarPainel: conta pessoas (conversas), marcadas, conversão, equipe, Pix, fora do horário e avaliações', () => {
  const p = montarPainel({
    agora, periodo: '7', fuso: FUSO,
    respostas: [
      { conversa: 1, criadoEm: h(2) },
      { conversa: 1, criadoEm: h(1) },
      { conversa: 2, criadoEm: h(30) },
      { conversa: 3, criadoEm: new Date('2026-11-13T01:00:00Z') }, // 22h de quinta: fora do horário
      { conversa: 9, criadoEm: h(24 * 9) }, // período anterior
    ],
    marcadas: [
      { conversa: 1, nome: 'Rosa Lima', agendadoPara: '2026-11-18T09:00', criadoEm: h(1) },
      { conversa: 7, nome: 'Sem resposta gravada', agendadoPara: null, criadoEm: h(5) }, // conta em marcadas, não na conversão
      { conversa: 8, nome: null, agendadoPara: null, criadoEm: h(24 * 10) },
    ],
    avaliacoes: [{ nota: 'boa', criadoEm: h(1) }, { nota: 'boa', criadoEm: h(3) }, { nota: 'ruim', criadoEm: h(4) }, { nota: 'ruim', criadoEm: h(24 * 8) }],
    eventos: [
      { conversa: 2, tipo: 'equipe', criadoEm: h(30) },
      { conversa: 2, tipo: 'equipe', criadoEm: h(29) }, // mesma conversa: conta 1
      { conversa: 1, tipo: 'pix', criadoEm: h(1) },
      { conversa: 5, tipo: 'equipe', criadoEm: h(24 * 9) }, // período anterior
    ],
  });
  assert.deepEqual(p.respondidas, { agora: 3, antes: 1 });
  assert.equal(p.respostas, 4);
  assert.deepEqual(p.marcadas, { agora: 2, antes: 1 });
  assert.deepEqual(p.conversao, { agora: 33, antes: 0 }, 'só a consulta da conversa 1 (respondida) entra; nunca passa de 100%');
  assert.deepEqual(p.equipe, { agora: 1, antes: 1 });
  assert.deepEqual(p.pix, { agora: 1, antes: 0 });
  assert.deepEqual(p.foraDoHorario, { respostas: 1, pct: 25 });
  assert.deepEqual(p.avaliacoes, { boas: 2, ruins: 1, pct: 67, pctAntes: 0 });
  assert.equal(p.ultimasMarcadas.length, 2);
  assert.equal(p.ultimasMarcadas[0]!.nome, 'Rosa Lima');
  assert.equal(p.porDia.length, 14);
  assert.deepEqual(p.porDia.at(-1), { dia: '2026-11-13', respondidas: 1, marcadas: 2 });
  assert.deepEqual(p.porDia.at(-2), { dia: '2026-11-12', respondidas: 2, marcadas: 0 }, 'conversa 2 (ontem 12h) e 3 (ontem 22h)');
});

test('sem nada: zeros e conversão nula (não divide por zero)', () => {
  const p = montarPainel({ agora, periodo: 'hoje', fuso: FUSO, respostas: [], marcadas: [], avaliacoes: [], eventos: [] });
  assert.deepEqual(p.respondidas, { agora: 0, antes: 0 });
  assert.deepEqual(p.conversao, { agora: null, antes: null });
  assert.equal(p.avaliacoes.pct, null);
  assert.equal(p.foraDoHorario.pct, null);
});

test('% que marcou conta PESSOAS: duas consultas na mesma conversa não passam de 100% (achado do sênior)', () => {
  const p = montarPainel({
    agora, periodo: 'hoje', fuso: FUSO,
    respostas: [{ conversa: 1, criadoEm: h(2) }],
    marcadas: [
      { conversa: 1, nome: 'Rosa', agendadoPara: '2026-11-18T09:00', criadoEm: h(1) },
      { conversa: 1, nome: 'Rosa (mãe)', agendadoPara: '2026-11-18T10:00', criadoEm: h(1) },
    ],
    avaliacoes: [], eventos: [],
  });
  assert.equal(p.marcadas.agora, 2, 'consultas marcadas: as duas');
  assert.equal(p.conversao.agora, 100, 'pessoas que marcaram: uma de uma');
});
