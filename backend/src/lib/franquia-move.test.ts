import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ETAPA, ehEtapaDeEntrada, horasAteNegociacao, moveLiberado, planejarMovimento, type EntradaMovimento } from './franquia-move.js';
import type { SpineSchedule } from '../services/spine.service.js';

const AGORA = Date.parse('2026-09-18T15:00:00Z') / 1000;
const iso = (h: number) => new Date((AGORA + h * 3600) * 1000).toISOString();

function ag(partial: Partial<SpineSchedule> & { h: number; idStatus: number; categoria?: string }): SpineSchedule {
  return {
    idSchedule: partial.idSchedule ?? Math.floor(Math.random() * 1e6),
    idStatus: partial.idStatus,
    clientName: 'Paciente Teste',
    categoryName: partial.categoria ?? 'AVALIAÇÃO',
    dateAttendanceUtc: iso(partial.h),
    dateAttendanceLocal: null,
  } as unknown as SpineSchedule;
}

function entrada(status: string, agendamentos: SpineSchedule[], tratamentos: Array<{ idStatus: number }> = [], funil: 'COMERCIAL' | 'TRATAMENTO' = 'COMERCIAL'): EntradaMovimento {
  return { atual: { funil, status }, agendamentos, tratamentos, agoraEpoch: AGORA, horasAteNegociacao: 48 };
}

test('avaliação marcada leva pra AGENDADO a partir da entrada, qualificação, espera e falta', () => {
  for (const de of ['Incoming leads', 'Etapa de leads de entrada', ETAPA.QUALIFICACAO, ETAPA.ESPERA, ETAPA.NAO_COMPARECEU]) {
    const m = planejarMovimento(entrada(de, [ag({ h: 30, idStatus: 37 })]));
    assert.equal(m?.para, ETAPA.AGENDADO, de);
  }
  assert.equal(planejarMovimento(entrada(ETAPA.AGENDADO, [ag({ h: 30, idStatus: 38 })])), null, 'já está em AGENDADO');
  assert.equal(planejarMovimento(entrada(ETAPA.COMPARECEU, [ag({ h: 30, idStatus: 37, categoria: 'RETORNO' })])), null, 'retorno futuro não volta pra AGENDADO');
});

test('avaliação atendida leva pra COMPARECEU; 48 h depois sem tratamento vai pra EM NEGOCIAÇÃO', () => {
  assert.equal(planejarMovimento(entrada(ETAPA.AGENDADO, [ag({ h: -2, idStatus: 42 })]))?.para, ETAPA.COMPARECEU);
  assert.equal(planejarMovimento(entrada(ETAPA.QUALIFICACAO, [ag({ h: -2, idStatus: 42 })]))?.para, ETAPA.COMPARECEU, 'SDR nunca moveu: pula direto');
  assert.equal(planejarMovimento(entrada(ETAPA.COMPARECEU, [ag({ h: -20, idStatus: 42 })])), null, 'ainda dentro das 48 h');
  const m = planejarMovimento(entrada(ETAPA.COMPARECEU, [ag({ h: -50, idStatus: 42 })]));
  assert.equal(m?.para, ETAPA.NEGOCIACAO);
  // retorno marcado: fica em COMPARECEU, as 48 h só contam depois do retorno
  assert.equal(planejarMovimento(entrada(ETAPA.COMPARECEU, [ag({ h: -50, idStatus: 42 }), ag({ h: 70, idStatus: 37, categoria: 'RETORNO COM EXAMES' })])), null, 'retorno futuro segura');
  assert.equal(planejarMovimento(entrada(ETAPA.COMPARECEU, [ag({ h: -100, idStatus: 42 }), ag({ h: -50, idStatus: 57, categoria: 'RETORNO' })]))?.para, ETAPA.NEGOCIACAO, 'retorno desmarcado não segura');
  assert.equal(planejarMovimento(entrada(ETAPA.NEGOCIACAO, [ag({ h: -100, idStatus: 42 })])), null, 'fica em negociação até fechar ou a SDR decidir');
});

test('falta registrada leva AGENDADO pra NÃO COMPARECEU; remarcou volta pra AGENDADO', () => {
  assert.equal(planejarMovimento(entrada(ETAPA.AGENDADO, [ag({ h: -3, idStatus: 40 })]))?.para, ETAPA.NAO_COMPARECEU);
  assert.equal(planejarMovimento(entrada(ETAPA.NAO_COMPARECEU, [ag({ h: -3, idStatus: 40 }), ag({ h: 48, idStatus: 37 })]))?.para, ETAPA.AGENDADO);
  assert.equal(planejarMovimento(entrada(ETAPA.QUALIFICACAO, [ag({ h: -3, idStatus: 40 })])), null, 'falta sem ter passado por AGENDADO: não inventa');
});

test('tratamento aberto → GANHO primeiro (Purchase do n8n); 1ª sessão atendida → EM TRATAMENTO', () => {
  const trat = [{ idStatus: 45 }];
  for (const de of [ETAPA.COMPARECEU, ETAPA.NEGOCIACAO, ETAPA.AGENDADO, ETAPA.QUALIFICACAO]) {
    const m = planejarMovimento(entrada(de, [ag({ h: -100, idStatus: 42 })], trat));
    assert.equal(m?.para, ETAPA.GANHO, de);
    assert.equal(m?.funil, 'COMERCIAL');
  }
  // em GANHO sem sessão atendida: espera
  assert.equal(planejarMovimento(entrada(ETAPA.GANHO, [ag({ h: 24, idStatus: 37, categoria: 'SESSÃO' })], trat)), null);
  // em GANHO com sessão atendida: vai pro funil TRATAMENTO
  const m = planejarMovimento(entrada(ETAPA.GANHO, [ag({ h: -2, idStatus: 42, categoria: 'PROTOCOLO 03 MESES - LOMBAR' })], trat));
  assert.equal(m?.para, ETAPA.EM_TRATAMENTO);
  assert.equal(m?.funil, 'TRATAMENTO');
  // mesmo com sessão atendida, quem está antes de GANHO passa por GANHO primeiro
  assert.equal(planejarMovimento(entrada(ETAPA.COMPARECEU, [ag({ h: -2, idStatus: 42, categoria: 'SESSÃO' })], trat))?.para, ETAPA.GANHO);
});

test('tratamento finalizado leva EM TRATAMENTO pra ALTA; com outro em andamento, fica', () => {
  assert.equal(planejarMovimento(entrada(ETAPA.EM_TRATAMENTO, [], [{ idStatus: 46 }], 'TRATAMENTO'))?.para, ETAPA.ALTA);
  assert.equal(planejarMovimento(entrada(ETAPA.EM_TRATAMENTO, [], [{ idStatus: 46 }, { idStatus: 45 }], 'TRATAMENTO')), null);
  assert.equal(planejarMovimento(entrada(ETAPA.EM_TRATAMENTO, [], [{ idStatus: 45 }], 'TRATAMENTO')), null);
});

test('intocáveis: PERDIDO, RETORNO PÓS, ALTA e TRATAMENTO CANCELADO nunca se movem', () => {
  const tudo = [ag({ h: 30, idStatus: 37 }), ag({ h: -100, idStatus: 42 })];
  assert.equal(planejarMovimento(entrada(ETAPA.PERDIDO, tudo, [{ idStatus: 45 }])), null);
  assert.equal(planejarMovimento(entrada(ETAPA.RETORNO, tudo, [{ idStatus: 45 }])), null);
  assert.equal(planejarMovimento(entrada(ETAPA.ALTA, tudo, [{ idStatus: 45 }], 'TRATAMENTO')), null);
  assert.equal(planejarMovimento(entrada(ETAPA.CANCELADO, tudo, [{ idStatus: 46 }], 'TRATAMENTO')), null);
  assert.equal(planejarMovimento({ ...entrada(ETAPA.AGENDADO, tudo), atual: null }), null, 'cartão em funil desconhecido');
});

test('sessão não é consulta: sessão futura não leva pra AGENDADO, sessão atendida não leva pra COMPARECEU', () => {
  assert.equal(planejarMovimento(entrada(ETAPA.QUALIFICACAO, [ag({ h: 30, idStatus: 37, categoria: 'SESSÃO' })])), null);
  assert.equal(planejarMovimento(entrada(ETAPA.AGENDADO, [ag({ h: -2, idStatus: 42, categoria: 'SESSÃO' })])), null);
});

test('flags e prazo', () => {
  assert.equal(moveLiberado('laboratorio-kommo', undefined), false);
  assert.equal(moveLiberado('laboratorio-kommo', "'laboratorio-kommo'"), true);
  assert.equal(moveLiberado('x', '*'), true);
  assert.equal(horasAteNegociacao(undefined), 48);
  assert.equal(horasAteNegociacao('72'), 72);
  assert.equal(horasAteNegociacao('abc'), 48);
  assert.equal(ehEtapaDeEntrada('Incoming leads'), true);
  assert.equal(ehEtapaDeEntrada('EM QUALIFICAÇÃO'), false);
});
