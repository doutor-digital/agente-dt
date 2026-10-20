/**
 * Regras de 16/10/2026 na máquina de etapas (chave `casamento-jornada`). Cada teste diz qual decisão do João ele prende,
 * e — onde a regra nova muda o comportamento — mostra a regra antiga ao lado, pra provar que sem a chave nada mudou.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ETAPA, planejarMovimento, sessaoEsquecidaComTratamentoFinalizado, type EntradaMovimento } from './franquia-move.js';
import type { SpineSchedule } from '../services/spine.service.js';

const AGORA = Date.parse('2026-10-16T15:00:00Z') / 1000;
const iso = (h: number) => new Date((AGORA + h * 3600) * 1000).toISOString();
const DIA = 24;

let seq = 1;
function ag(p: { h: number; idStatus: number; categoria?: string }): SpineSchedule {
  return {
    idSchedule: seq++,
    idTreatment: null,
    idStatus: p.idStatus,
    statusName: null,
    clientName: 'Paciente Teste',
    categoryName: p.categoria ?? 'AVALIAÇÃO',
    physicalTherapist: null,
    dateAttendanceUtc: iso(p.h),
    dateAttendanceLocal: null,
    dayLocal: null,
    timeLocal: null,
    isBusy: true,
    requiresManualValidation: false,
  };
}

const FINALIZADO = [{ idStatus: 46, statusName: 'FINALIZADO' }];
const EM_ANDAMENTO = [{ idStatus: 45, statusName: 'EM ANDAMENTO' }];

function e(status: string, agendamentos: SpineSchedule[], tratamentos: EntradaMovimento['tratamentos'] = [], funil: 'COMERCIAL' | 'TRATAMENTO' = 'COMERCIAL', regras1610 = true): EntradaMovimento {
  return { atual: { funil, status }, agendamentos, tratamentos, agoraEpoch: AGORA, horasAteNegociacao: 48, regras1610 };
}

/** O ciclo velho de um ex-paciente: avaliação, sessões e o fim (última sessão há 60 dias). */
function cicloVelho(): SpineSchedule[] {
  return [
    ag({ h: -200 * DIA, idStatus: 42 }),
    ag({ h: -150 * DIA, idStatus: 42, categoria: 'PROTOCOLO 03 MESES - LOMBAR' }),
    ag({ h: -60 * DIA, idStatus: 42, categoria: 'PROTOCOLO 03 MESES - LOMBAR' }),
  ];
}

// ── decisão 2: ex-paciente que volta → RETORNO PÓS-TRATAMENTO; finalizado nunca vira GANHO ──

test('decisão 2: ex-paciente com AVALIAÇÃO nova marcada sai da ALTA pra RETORNO PÓS-TRATAMENTO (antes ficava na ALTA)', () => {
  const ag1 = [...cicloVelho(), ag({ h: 48, idStatus: 37 })];
  const m = planejarMovimento(e(ETAPA.ALTA, ag1, FINALIZADO, 'TRATAMENTO'));
  assert.equal(m?.para, ETAPA.RETORNO);
  assert.equal(m?.funil, 'COMERCIAL');
  assert.equal(planejarMovimento(e(ETAPA.ALTA, ag1, FINALIZADO, 'TRATAMENTO', false)), null, 'regra antiga: só "retorno após tratamento" tirava da ALTA');
});

test('decisão 2: ex-paciente com cartão novo no comercial e consulta marcada vai pra RETORNO, nunca pra GANHO', () => {
  const ag1 = [...cicloVelho(), ag({ h: 30, idStatus: 37 })];
  for (const de of ['Incoming leads', ETAPA.QUALIFICACAO, ETAPA.ESPERA, ETAPA.AGENDADO, ETAPA.COMPARECEU]) {
    assert.equal(planejarMovimento(e(de, ag1, FINALIZADO))?.para, ETAPA.RETORNO, de);
  }
  // regra antiga: finalizado recente levava pra GANHO (Purchase falso pra Meta)
  const antigo = planejarMovimento(e(ETAPA.QUALIFICACAO, [ag({ h: -20 * DIA, idStatus: 42, categoria: 'SESSÃO' }), ag({ h: 30, idStatus: 37 })], FINALIZADO, 'COMERCIAL', false));
  assert.equal(antigo?.para, ETAPA.GANHO);
  const novo = planejarMovimento(e(ETAPA.QUALIFICACAO, [ag({ h: -20 * DIA, idStatus: 42, categoria: 'SESSÃO' }), ag({ h: 30, idStatus: 37 })], FINALIZADO));
  assert.equal(novo?.para, ETAPA.RETORNO);
});

test('decisão 2: finalizado nunca LEVA a GANHO — cartão parado de quem terminou vai pra ALTA (sem régua se velho)', () => {
  const recente = [ag({ h: -40 * DIA, idStatus: 42 }), ag({ h: -10 * DIA, idStatus: 42, categoria: 'SESSÃO' })];
  const m = planejarMovimento(e(ETAPA.COMPARECEU, recente, FINALIZADO));
  assert.equal(m?.para, ETAPA.ALTA);
  assert.equal(m?.funil, 'TRATAMENTO');
  assert.equal(m?.semRegua, false, 'terminou há 10 d: a régua de alta ainda cabe');
  assert.equal(planejarMovimento(e(ETAPA.COMPARECEU, recente, FINALIZADO, 'COMERCIAL', false))?.para, ETAPA.GANHO, 'regra antiga: GANHO');
  const velho = planejarMovimento(e(ETAPA.NEGOCIACAO, cicloVelho(), FINALIZADO));
  assert.equal(velho?.para, ETAPA.ALTA);
  assert.equal(velho?.semRegua, true, '60 d sem nada: ALTA sem mensagem');
  // quem a Sofia está atendendo agora (entrada/qualificação/espera) e não marcou nada: fica
  assert.equal(planejarMovimento(e(ETAPA.QUALIFICACAO, cicloVelho(), FINALIZADO)), null);
});

test('decisão 2: em GANHO, finalizado só mantém a passagem GANHO → EM TRATAMENTO (não volta atrás)', () => {
  const m = planejarMovimento(e(ETAPA.GANHO, [ag({ h: -5 * DIA, idStatus: 42, categoria: 'SESSÃO' })], FINALIZADO));
  assert.equal(m?.para, ETAPA.EM_TRATAMENTO);
});

test('decisão 2: tratamento ABERTO continua levando a GANHO (é venda de verdade)', () => {
  assert.equal(planejarMovimento(e(ETAPA.COMPARECEU, [ag({ h: -3 * DIA, idStatus: 42 })], EM_ANDAMENTO))?.para, ETAPA.GANHO);
});

test('decisão 2: em RETORNO, a consulta da volta atendida (mesmo vindo como avaliação) leva pra COMPARECEU', () => {
  const ag1 = [...cicloVelho(), ag({ h: -3, idStatus: 42 })];
  assert.equal(planejarMovimento(e(ETAPA.RETORNO, ag1, FINALIZADO))?.para, ETAPA.COMPARECEU);
  assert.equal(planejarMovimento(e(ETAPA.RETORNO, ag1, FINALIZADO, 'COMERCIAL', false)), null, 'regra antiga: avaliação não tirava do RETORNO');
  // a avaliação de ANTES do tratamento não conta como volta
  assert.equal(planejarMovimento(e(ETAPA.RETORNO, cicloVelho(), FINALIZADO)), null);
});

test('decisão 2: ex-paciente que voltou e foi atendido segue a jornada normal pelas consultas da volta', () => {
  const ag1 = [...cicloVelho(), ag({ h: -5 * DIA, idStatus: 42 })];
  assert.equal(planejarMovimento(e(ETAPA.AGENDADO, ag1, FINALIZADO))?.para, ETAPA.NEGOCIACAO, 'atendido há 5 d sem tratamento novo');
});

// ── decisão 4: falta em RETORNO ou SESSÃO não muda a etapa ──

test('decisão 4: falta em consulta de RETORNO não leva pra NÃO COMPARECEU (antes levava)', () => {
  const ag1 = [ag({ h: -3, idStatus: 40, categoria: 'RETORNO' })];
  assert.equal(planejarMovimento(e(ETAPA.AGENDADO, ag1)), null);
  assert.equal(planejarMovimento(e(ETAPA.AGENDADO, ag1, [], 'COMERCIAL', false))?.para, ETAPA.NAO_COMPARECEU, 'regra antiga');
});

test('decisão 4: falta na consulta de quem está em RETORNO PÓS-TRATAMENTO não muda a etapa', () => {
  const ag1 = [...cicloVelho(), ag({ h: -3, idStatus: 40, categoria: 'Retorno após tratamento' })];
  assert.equal(planejarMovimento(e(ETAPA.RETORNO, ag1, FINALIZADO)), null);
  const ag2 = [...cicloVelho(), ag({ h: -3, idStatus: 40 })];
  assert.equal(planejarMovimento(e(ETAPA.RETORNO, ag2, FINALIZADO)), null, 'mesmo vindo como avaliação');
});

test('decisão 4: falta em sessão não mexe no cartão do funil TRATAMENTO', () => {
  const ag1 = [ag({ h: -3, idStatus: 40, categoria: 'PROTOCOLO 03 MESES - LOMBAR' })];
  assert.equal(planejarMovimento(e(ETAPA.EM_TRATAMENTO, ag1, EM_ANDAMENTO, 'TRATAMENTO')), null);
});

test('decisão 4: falta em AVALIAÇÃO continua levando pra NÃO COMPARECEU', () => {
  assert.equal(planejarMovimento(e(ETAPA.AGENDADO, [ag({ h: -3, idStatus: 40 })]))?.para, ETAPA.NAO_COMPARECEU);
});

// ── decisão 5: âncora = última avaliação ──

test('decisão 5: a âncora é a última AVALIAÇÃO — retorno atendido depois de uma avaliação com falta não leva pra COMPARECEU', () => {
  const ag1 = [ag({ h: -10 * DIA, idStatus: 40 }), ag({ h: -2, idStatus: 42, categoria: 'RETORNO' })];
  // o retorno atendido é o fato mais recente, mas quem manda é a avaliação (falta há 10 d)
  const m = planejarMovimento(e(ETAPA.AGENDADO, ag1));
  assert.equal(m?.para, ETAPA.ESPERA, 'faltou à avaliação há 10 d e não remarcou');
});

test('decisão 5: sem avaliação nenhuma, o retorno não ancora a jornada (antes ancorava)', () => {
  const ag1 = [ag({ h: -2, idStatus: 42, categoria: 'RETORNO' })];
  assert.equal(planejarMovimento(e(ETAPA.AGENDADO, ag1)), null);
  assert.equal(planejarMovimento(e(ETAPA.AGENDADO, ag1, [], 'COMERCIAL', false))?.para, ETAPA.COMPARECEU, 'regra antiga');
});

// ── decisão 6: cancelou na franquia, o robô continua movendo ──

test('decisão 6: tratamento cancelado na franquia continua levando EM TRATAMENTO pra TRATAMENTO CANCELADO', () => {
  const m = planejarMovimento(e(ETAPA.EM_TRATAMENTO, [], [{ idStatus: 47, statusName: 'CANCELADO' }], 'TRATAMENTO'));
  assert.equal(m?.para, ETAPA.CANCELADO);
});

test('decisão 6 + regra de 08/10: TRATAMENTO CANCELADO (que a SDR faz no Kommo) nunca é desfeito pela franquia', () => {
  assert.equal(planejarMovimento(e(ETAPA.CANCELADO, [ag({ h: -2, idStatus: 42, categoria: 'SESSÃO' })], EM_ANDAMENTO, 'TRATAMENTO')), null);
});

// ── decisão 7: a franquia manda ──

test('decisão 7: avaliação marcada na franquia tira do PERDIDO pra AGENDADO (antes o PERDIDO era intocável)', () => {
  const ag1 = [ag({ h: -60 * DIA, idStatus: 40 }), ag({ h: 48, idStatus: 37 })];
  assert.equal(planejarMovimento(e(ETAPA.PERDIDO, ag1))?.para, ETAPA.AGENDADO);
  assert.equal(planejarMovimento(e(ETAPA.PERDIDO, ag1, [], 'COMERCIAL', false)), null, 'regra antiga');
});

test('decisão 7: no PERDIDO, fato velho não reabre — só consulta marcada pra frente', () => {
  assert.equal(planejarMovimento(e(ETAPA.PERDIDO, [ag({ h: -3, idStatus: 42 })])), null, 'atendido ontem: fica');
  assert.equal(planejarMovimento(e(ETAPA.PERDIDO, [ag({ h: -3, idStatus: 42 })], EM_ANDAMENTO)), null, 'tratamento "em andamento" sozinho não reabre');
  assert.equal(planejarMovimento(e(ETAPA.PERDIDO, [ag({ h: 48, idStatus: 37, categoria: 'RETORNO' })])), null, 'retorno simples marcado não reabre');
});

test('decisão 7 + 2: ex-paciente no PERDIDO com consulta marcada vai pra RETORNO PÓS-TRATAMENTO', () => {
  const ag1 = [...cicloVelho(), ag({ h: 48, idStatus: 37, categoria: 'RETORNO' })];
  assert.equal(planejarMovimento(e(ETAPA.PERDIDO, ag1, FINALIZADO))?.para, ETAPA.RETORNO);
});

test('decisão 7: o SDR arrastou pra GANHO sem tratamento na franquia — o robô devolve (como sempre)', () => {
  assert.equal(planejarMovimento(e(ETAPA.GANHO, [ag({ h: -5 * DIA, idStatus: 42 })]))?.para, ETAPA.NEGOCIACAO);
});

// ── resposta do João (16/10, à tarde): "a franquia manda" também na ALTA ──

test('decisão 7 na ALTA: sessão marcada pra frente com tratamento EM ANDAMENTO leva pra EM TRATAMENTO (antes ficava na ALTA)', () => {
  const sessao = ag({ h: 30, idStatus: 37, categoria: 'PROTOCOLO 03 MESES - LOMBAR' });
  const ag1 = [...cicloVelho(), sessao];
  const m = planejarMovimento(e(ETAPA.ALTA, ag1, EM_ANDAMENTO, 'TRATAMENTO'));
  assert.equal(m?.para, ETAPA.EM_TRATAMENTO);
  assert.equal(m?.funil, 'TRATAMENTO');
  assert.equal(m?.gatilho, `sessao:${sessao.idSchedule}`);
  assert.equal(planejarMovimento(e(ETAPA.ALTA, ag1, EM_ANDAMENTO, 'TRATAMENTO', false)), null, 'regra antiga');
});

test('decisão 7 na ALTA: consulta marcada (avaliação ou retorno) vai pra RETORNO, mesmo com tratamento ainda aberto na franquia', () => {
  const marcada = ag({ h: 48, idStatus: 37, categoria: 'RETORNO' });
  const m = planejarMovimento(e(ETAPA.ALTA, [...cicloVelho(), marcada], EM_ANDAMENTO, 'TRATAMENTO'));
  assert.equal(m?.para, ETAPA.RETORNO);
  assert.equal(m?.gatilho, `consulta:${marcada.idSchedule}`, 'o fato que tirou da ALTA vai junto');
  assert.equal(planejarMovimento(e(ETAPA.ALTA, [...cicloVelho(), marcada], EM_ANDAMENTO, 'TRATAMENTO', false)), null, 'regra antiga');
});

test('decisão 7 na ALTA: sem nada marcado pra frente, a ALTA fica', () => {
  assert.equal(planejarMovimento(e(ETAPA.ALTA, cicloVelho(), FINALIZADO, 'TRATAMENTO')), null);
});

test('decisão 7: ALTA e EM TRATAMENTO não se empurram — em andamento fica em EM TRATAMENTO; finalizado vai pra ALTA e de lá não volta', () => {
  const ag1 = [ag({ h: -5 * DIA, idStatus: 42, categoria: 'SESSÃO' }), ag({ h: 30, idStatus: 37, categoria: 'SESSÃO' })];
  assert.equal(planejarMovimento(e(ETAPA.EM_TRATAMENTO, ag1, EM_ANDAMENTO, 'TRATAMENTO')), null, 'em andamento: fica');
  // finalizado com a sessão esquecida (achado 4): vai pra ALTA, e a ALTA não volta pra EM TRATAMENTO por causa dela
  assert.equal(planejarMovimento(e(ETAPA.EM_TRATAMENTO, ag1, FINALIZADO, 'TRATAMENTO'))?.para, ETAPA.ALTA);
  assert.equal(planejarMovimento(e(ETAPA.ALTA, ag1, FINALIZADO, 'TRATAMENTO')), null);
  assert.equal(planejarMovimento(e(ETAPA.EM_TRATAMENTO, ag1, FINALIZADO, 'TRATAMENTO', false))?.para, ETAPA.ALTA, 'regra antiga');
});

test('decisão 7: a saída do PERDIDO leva o fato junto (a consulta que tirou de lá)', () => {
  const marcada = ag({ h: 48, idStatus: 37 });
  assert.equal(planejarMovimento(e(ETAPA.PERDIDO, [marcada]))?.gatilho, `consulta:${marcada.idSchedule}`);
  assert.equal(planejarMovimento(e(ETAPA.AGENDADO, [ag({ h: -3, idStatus: 40 })]))?.gatilho, undefined, 'movimento comum não tem gatilho');
});

// ── revisão independente (16/10) ──

test('achado 3 — o gatilho da sessão leva o id do tratamento (ou da sessão), não um "sessao" fixo', () => {
  const s1 = { ...ag({ h: 30, idStatus: 37, categoria: 'SESSÃO' }), idTreatment: 77 };
  assert.equal(planejarMovimento(e(ETAPA.ALTA, [...cicloVelho(), s1], EM_ANDAMENTO, 'TRATAMENTO'))?.gatilho, 'sessao:trat:77');
  // a sessão sem id de tratamento: vale o tratamento em andamento da franquia (tratamento novo = fato novo)
  const s2 = ag({ h: 30, idStatus: 37, categoria: 'SESSÃO' });
  assert.equal(planejarMovimento(e(ETAPA.ALTA, [...cicloVelho(), s2], [{ idStatus: 45, statusName: 'EM ANDAMENTO', idTreatment: 88 }], 'TRATAMENTO'))?.gatilho, 'sessao:trat:88');
  // sem id de tratamento nenhum: a própria sessão
  assert.equal(planejarMovimento(e(ETAPA.ALTA, [...cicloVelho(), s2], EM_ANDAMENTO, 'TRATAMENTO'))?.gatilho, `sessao:${s2.idSchedule}`);
  assert.notEqual(planejarMovimento(e(ETAPA.ALTA, [...cicloVelho(), s2], EM_ANDAMENTO, 'TRATAMENTO'))?.gatilho, 'sessao', 'nunca mais o "sessao" fixo');
});

test('achado 4 — ALTA + tratamento FINALIZADO + sessão esquecida em AGENDADO não sai da ALTA (é sujeira da franquia)', () => {
  const esquecida = ag({ h: 48, idStatus: 37, categoria: 'SESSÃO' });
  const ag1 = [...cicloVelho(), esquecida];
  assert.equal(planejarMovimento(e(ETAPA.ALTA, ag1, FINALIZADO, 'TRATAMENTO')), null);
  // e EM TRATAMENTO com tratamento finalizado vai pra ALTA mesmo com a sessão esquecida — sem vaivém
  assert.equal(planejarMovimento(e(ETAPA.EM_TRATAMENTO, ag1, FINALIZADO, 'TRATAMENTO'))?.para, ETAPA.ALTA);
  // o vaivém que a revisão rodou: passada a data, a sessão esquecida continua "agendada" — e o cartão continua na ALTA
  const depois = { ...e(ETAPA.ALTA, ag1, FINALIZADO, 'TRATAMENTO'), agoraEpoch: AGORA + 72 * 3600 };
  assert.equal(planejarMovimento(depois), null);
  // a sessão esquecida é o que vira tarefa no sincronizador
  assert.equal(sessaoEsquecidaComTratamentoFinalizado({ agendamentos: ag1, tratamentos: FINALIZADO, agoraEpoch: AGORA })?.idSchedule, esquecida.idSchedule);
  assert.equal(sessaoEsquecidaComTratamentoFinalizado({ agendamentos: ag1, tratamentos: [...FINALIZADO, ...EM_ANDAMENTO], agoraEpoch: AGORA }), null, 'com outro tratamento em andamento não é sujeira');
});
