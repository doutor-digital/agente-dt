import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ETAPA, ehEtapaDeEntrada, horasAteNegociacao, moveLiberado, planejarMovimento, tratamentoAberto, type EntradaMovimento } from './franquia-move.js';
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
  // proposta pendente (44) não segura a alta; tratamento vindo do /treatments/search (sem id, nome EM ANDAMENTO) segura
  assert.equal(planejarMovimento(entrada(ETAPA.EM_TRATAMENTO, [], [{ idStatus: 46 }, { idStatus: 44 }], 'TRATAMENTO'))?.para, ETAPA.ALTA);
  assert.equal(planejarMovimento({ ...entrada(ETAPA.EM_TRATAMENTO, [], [], 'TRATAMENTO'), tratamentos: [{ idStatus: 46 }, { idStatus: null, statusName: 'EM ANDAMENTO' }] }), null);
  // pendente sozinho ainda leva pra GANHO (abriu tratamento), mas só a 1ª sessão atendida leva pra EM TRATAMENTO
  assert.equal(planejarMovimento(entrada(ETAPA.COMPARECEU, [ag({ h: -100, idStatus: 42 })], [{ idStatus: 44 }]))?.para, ETAPA.GANHO);
});

test('intocáveis: PERDIDO e TRATAMENTO CANCELADO nunca se movem; ALTA e RETORNO PÓS só pelo retorno pós-tratamento (aqui não há)', () => {
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

test('tratamento cancelado não conta como aberto (nem segura a regra das 48 h)', () => {
  assert.equal(tratamentoAberto({ idStatus: 47, statusName: 'CANCELADO' }), false);
  assert.equal(tratamentoAberto({ idStatus: 46, statusName: 'FINALIZADO' }), false);
  assert.equal(tratamentoAberto({ idStatus: 44, statusName: 'PENDENTE' }), true);
  assert.equal(tratamentoAberto({ idStatus: 45, statusName: 'EM ANDAMENTO' }), true);
  // só cancelado no histórico: quem foi atendido há 50 h vai pra EM NEGOCIAÇÃO
  assert.equal(planejarMovimento(entrada(ETAPA.COMPARECEU, [ag({ h: -50, idStatus: 42 })], [{ idStatus: 47, statusName: 'CANCELADO' } as { idStatus: number }]))?.para, ETAPA.NEGOCIACAO);
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

// ── 22/09/2026: cancelamento, retorno pós-tratamento e a volta do paciente de alta ──

test('tratamento cancelado na franquia leva EM TRATAMENTO pra TRATAMENTO CANCELADO — mas outro aberto ou finalizado segura', () => {
  const canc = { idStatus: 47, statusName: 'CANCELADO' } as { idStatus: number };
  const m = planejarMovimento(entrada(ETAPA.EM_TRATAMENTO, [], [canc], 'TRATAMENTO'));
  assert.equal(m?.para, ETAPA.CANCELADO);
  assert.equal(m?.funil, 'TRATAMENTO');
  assert.equal(planejarMovimento(entrada(ETAPA.EM_TRATAMENTO, [], [canc, { idStatus: 45 }], 'TRATAMENTO')), null, 'outro em andamento segura');
  assert.equal(planejarMovimento(entrada(ETAPA.EM_TRATAMENTO, [], [canc, { idStatus: 44 }], 'TRATAMENTO')), null, 'proposta pendente segura');
  assert.equal(planejarMovimento(entrada(ETAPA.EM_TRATAMENTO, [], [canc, { idStatus: 46 }], 'TRATAMENTO'))?.para, ETAPA.ALTA, 'finalizado ganha do cancelado');
  assert.equal(planejarMovimento(entrada(ETAPA.CANCELADO, [], [{ idStatus: 45 }], 'TRATAMENTO')), null, 'de CANCELADO ninguém sai sozinho');
});

test('paciente de ALTA com retorno pós-tratamento marcado vai pra RETORNO PÓS-TRATAMENTO (COMERCIAL); sem retorno, fica', () => {
  const alta = [{ idStatus: 46 }];
  const m = planejarMovimento(entrada(ETAPA.ALTA, [ag({ h: 72, idStatus: 37, categoria: 'Retorno após tratamento' })], alta, 'TRATAMENTO'));
  assert.equal(m?.para, ETAPA.RETORNO);
  assert.equal(m?.funil, 'COMERCIAL');
  assert.equal(planejarMovimento(entrada(ETAPA.ALTA, [ag({ h: 72, idStatus: 37, categoria: 'RETORNO' })], alta, 'TRATAMENTO')), null, '"Retorno" simples não é retorno pós-tratamento');
  assert.equal(planejarMovimento(entrada(ETAPA.ALTA, [ag({ h: 72, idStatus: 37 })], alta, 'TRATAMENTO')), null, 'avaliação nova não tira da alta');
  assert.equal(planejarMovimento(entrada(ETAPA.ALTA, [ag({ h: -72, idStatus: 42, categoria: 'Retorno após tratamento' })], alta, 'TRATAMENTO'))?.para, ETAPA.COMPARECEU, 'retorno atendido há 3 dias: entre varreduras, vai direto pra COMPARECEU');
  assert.equal(planejarMovimento(entrada(ETAPA.ALTA, [ag({ h: 72, idStatus: 57, categoria: 'Retorno após tratamento' })], alta, 'TRATAMENTO')), null, 'retorno desmarcado não move');
});

test('retorno pós-tratamento atendido tira de RETORNO pra COMPARECEU, e dali segue como avaliação normal', () => {
  const alta = [{ idStatus: 46 }];
  const retornoFeito = ag({ h: -3, idStatus: 42, categoria: 'Retorno após tratamento' });
  const m = planejarMovimento(entrada(ETAPA.RETORNO, [retornoFeito], alta));
  assert.equal(m?.para, ETAPA.COMPARECEU);
  assert.equal(planejarMovimento(entrada(ETAPA.RETORNO, [ag({ h: 48, idStatus: 37, categoria: 'Retorno após tratamento' })], alta)), null, 'retorno ainda futuro: fica');
  assert.equal(planejarMovimento(entrada(ETAPA.RETORNO, [ag({ h: -3, idStatus: 40, categoria: 'Retorno após tratamento' })], alta)), null, 'faltou ao retorno: fica, a equipe decide');
  // o tratamento FINALIZADO do ciclo anterior não empurra de volta pra GANHO
  assert.equal(planejarMovimento(entrada(ETAPA.COMPARECEU, [retornoFeito], alta)), null, 'dentro das 48 h do retorno, fica em COMPARECEU');
  assert.equal(planejarMovimento(entrada(ETAPA.COMPARECEU, [ag({ h: -50, idStatus: 42, categoria: 'Retorno após tratamento' })], alta))?.para, ETAPA.NEGOCIACAO, '48 h depois do retorno sem tratamento novo: NEGOCIAÇÃO');
  // tratamento NOVO aberto depois do retorno é venda nova: GANHO
  assert.equal(planejarMovimento(entrada(ETAPA.COMPARECEU, [retornoFeito], [...alta, { idStatus: 45 }]))?.para, ETAPA.GANHO);
});

test('paciente que volta de alta: sessão e tratamento do ciclo VELHO não empurram GANHO → EM TRATAMENTO → ALTA', () => {
  // ciclo velho: sessões atendidas há meses e tratamento finalizado; retorno pós atendido há 3 h; proposta NOVA pendente
  const velho = [ag({ h: -2000, idStatus: 42, categoria: 'SESSÃO' }), ag({ h: -1900, idStatus: 42, categoria: 'SESSÃO' })];
  const retorno = ag({ h: -3, idStatus: 42, categoria: 'Retorno após tratamento' });
  const trats = [{ idStatus: 46 }, { idStatus: 44 }];
  assert.equal(planejarMovimento(entrada(ETAPA.COMPARECEU, [...velho, retorno], trats))?.para, ETAPA.GANHO, 'proposta nova = venda nova');
  assert.equal(planejarMovimento(entrada(ETAPA.GANHO, [...velho, retorno], trats)), null, 'sessão velha não leva pra EM TRATAMENTO');
  // sessão NOVA (depois do retorno) atendida: aí sim
  assert.equal(planejarMovimento(entrada(ETAPA.GANHO, [...velho, retorno, ag({ h: -1, idStatus: 42, categoria: 'SESSÃO' })], [{ idStatus: 46 }, { idStatus: 45 }]))?.para, ETAPA.EM_TRATAMENTO);
  // em EM TRATAMENTO com o finalizado velho e o novo em andamento: fica
  assert.equal(planejarMovimento(entrada(ETAPA.EM_TRATAMENTO, [...velho, retorno], [{ idStatus: 46 }, { idStatus: 45 }], 'TRATAMENTO')), null);
  // novo cancelado: CANCELADO, não ALTA (o finalizado é do ciclo velho)
  assert.equal(planejarMovimento(entrada(ETAPA.EM_TRATAMENTO, [...velho, retorno], [{ idStatus: 46 }, { idStatus: 47, statusName: 'CANCELADO' } as { idStatus: number }], 'TRATAMENTO'))?.para, ETAPA.CANCELADO);
  // novo finalizado também: ALTA de novo
  assert.equal(planejarMovimento(entrada(ETAPA.EM_TRATAMENTO, [...velho, retorno], [{ idStatus: 46 }, { idStatus: 46 }], 'TRATAMENTO'))?.para, ETAPA.ALTA);
});

test('ALTA com retorno pós atendido entre duas varreduras vai direto pra COMPARECEU; retorno atendido há meses não move', () => {
  const alta = [{ idStatus: 46 }];
  assert.equal(planejarMovimento(entrada(ETAPA.ALTA, [ag({ h: -2, idStatus: 42, categoria: 'Retorno após tratamento' })], alta, 'TRATAMENTO'))?.para, ETAPA.COMPARECEU);
  assert.equal(planejarMovimento(entrada(ETAPA.ALTA, [ag({ h: -24 * 30, idStatus: 42, categoria: 'Retorno após tratamento' })], alta, 'TRATAMENTO')), null, 'retorno velho: fica');
  // o retorno MAIS RECENTE decide: um antigo atendido + um novo marcado → RETORNO
  assert.equal(planejarMovimento(entrada(ETAPA.ALTA, [ag({ h: -24 * 30, idStatus: 42, categoria: 'Retorno após tratamento' }), ag({ h: 48, idStatus: 37, categoria: 'Retorno após tratamento' })], alta, 'TRATAMENTO'))?.para, ETAPA.RETORNO);
  // em RETORNO, um retorno antigo atendido não empurra; só o mais recente
  assert.equal(planejarMovimento(entrada(ETAPA.RETORNO, [ag({ h: -24 * 30, idStatus: 42, categoria: 'Retorno após tratamento' }), ag({ h: 48, idStatus: 37, categoria: 'Retorno após tratamento' })], alta)), null);
});

test('tratamento com status desconhecido e sem nome não é "aberto": não vira GANHO', () => {
  assert.equal(tratamentoAberto({ idStatus: 47, statusName: null }), false);
  assert.equal(tratamentoAberto({ idStatus: 99, statusName: null }), false);
  assert.equal(tratamentoAberto({ idStatus: null, statusName: null }), true, 'do /treatments/search, sem id nem nome, é em andamento');
  assert.equal(tratamentoAberto({ idStatus: 45, statusName: null }), true);
  assert.equal(tratamentoAberto({ idStatus: 44, statusName: null }), true);
  assert.equal(planejarMovimento(entrada(ETAPA.COMPARECEU, [ag({ h: -100, idStatus: 42 })], [{ idStatus: 47, statusName: null } as { idStatus: number }]))?.para, ETAPA.NEGOCIACAO, 'cancelado sem nome não abre venda');
});
