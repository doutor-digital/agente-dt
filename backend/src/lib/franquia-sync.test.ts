import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';
import {
  casarFisioterapeuta,
  categoriaDaConsulta,
  chaveTelefone,
  escolherConsulta,
  opcaoDoTratamento,
  planejarEscritas,
  situacaoDaConsulta,
} from './franquia-sync.js';

const OPCOES = {
  fisio: ['DRA. BÁRBARA WIRTZBIKI', 'DR. JOÃO SILVA', 'DRA. ANA PAULA SILVA'],
  categoria: ['Avaliação', 'Sessão', 'Retorno', 'Retorno com exames', 'Retorno após tratamento'],
  tratamento: ['03 Meses — LOMBAR CRÔNICO', '03 Meses — CERVICAL CRÔNICO', '06 Meses — LOMBAR CRÔNICO'],
};

function consulta(over: Partial<SpineSchedule> = {}): SpineSchedule {
  return {
    idSchedule: 10, idTreatment: null, idStatus: SPINE_STATUS.AGENDADO, statusName: 'AGENDADO',
    clientName: 'Maria', categoryName: 'AVALIAÇÃO', physicalTherapist: 'Bárbara Wirtzbiki',
    dateAttendanceUtc: '2026-09-20T13:00:00Z', dateAttendanceLocal: '2026-09-20T10:00', dayLocal: '2026-09-20', timeLocal: '10:00',
    isBusy: true, requiresManualValidation: false, ...over,
  };
}

test('telefone: compara pelos últimos 8 dígitos, sem 55 e sem o 9', () => {
  assert.equal(chaveTelefone('+55 (99) 99131-0238'), '91310238');
  assert.equal(chaveTelefone('5599913102 38'), '91310238');
  assert.equal(chaveTelefone('9991310238'), '91310238');
  assert.equal(chaveTelefone(''), '');
});

test('situação: cada status da franquia vira a opção exata do cartão', () => {
  assert.equal(situacaoDaConsulta(SPINE_STATUS.AGENDADO), 'Agendado');
  assert.equal(situacaoDaConsulta(SPINE_STATUS.NAO_COMPARECEU), 'Não compareceu');
  assert.equal(situacaoDaConsulta(SPINE_STATUS.DESMARCADO), 'Desmarcado');
  assert.equal(situacaoDaConsulta(999), null);
});

test('categoria: casa por sentido, não por texto exato', () => {
  assert.equal(categoriaDaConsulta('AVALIAÇÃO', OPCOES.categoria), 'Avaliação');
  assert.equal(categoriaDaConsulta('Retorno c/ exames', OPCOES.categoria), 'Retorno com exames');
  assert.equal(categoriaDaConsulta('Sessão de fisioterapia', OPCOES.categoria), 'Sessão');
  assert.equal(categoriaDaConsulta('Pilates', OPCOES.categoria), null);
});

test('fisioterapeuta: acha pelo nome apesar do DRA. e das maiúsculas; ambíguo devolve null', () => {
  assert.equal(casarFisioterapeuta('Bárbara Wirtzbiki', OPCOES.fisio), 'DRA. BÁRBARA WIRTZBIKI');
  assert.equal(casarFisioterapeuta('barbara wirtzbiki', OPCOES.fisio), 'DRA. BÁRBARA WIRTZBIKI');
  assert.equal(casarFisioterapeuta('Silva', OPCOES.fisio), null);
  assert.equal(casarFisioterapeuta('Ana Paula Silva', OPCOES.fisio), 'DRA. ANA PAULA SILVA');
  assert.equal(casarFisioterapeuta(null, OPCOES.fisio), null);
});

test('tratamento: monta a opção a partir de categoria + local + grau', () => {
  assert.equal(opcaoDoTratamento({ category: '03 Meses', local: 'Lombar', degree: 'Crônico' }, OPCOES.tratamento), '03 Meses — LOMBAR CRÔNICO');
  assert.equal(opcaoDoTratamento({ category: '12 Meses', local: 'Lombar', degree: 'Crônico' }, OPCOES.tratamento), null);
  assert.equal(opcaoDoTratamento({ category: null, local: 'Lombar', degree: null }, OPCOES.tratamento), null, 'só "lombar" casa duas → null');
});

test('escolherConsulta: a mais recente não desmarcada; se todas desmarcadas, a mais recente', () => {
  const a = consulta({ idSchedule: 1, dateAttendanceUtc: '2026-09-10T13:00:00Z' });
  const b = consulta({ idSchedule: 2, dateAttendanceUtc: '2026-09-25T13:00:00Z', idStatus: SPINE_STATUS.DESMARCADO });
  const c = consulta({ idSchedule: 3, dateAttendanceUtc: '2026-09-20T13:00:00Z' });
  assert.equal(escolherConsulta([a, b, c])?.idSchedule, 3);
  assert.equal(escolherConsulta([b])?.idSchedule, 2);
  assert.equal(escolherConsulta([]), null);
});

const AGORA = Math.floor(Date.parse('2026-09-14T18:00:00Z') / 1000);
const EPOCH_CONSULTA = Math.floor(Date.parse('2026-09-20T13:00:00Z') / 1000);

test('cartão vazio + consulta futura: preenche data, situação, fisio, categoria, carimbo e quem agendou', () => {
  const w = planejarEscritas({ valores: {}, consulta: consulta(), consultaEpoch: EPOCH_CONSULTA, tratamento: null, feitoPelaIa: false, agoraEpoch: AGORA, opcoes: OPCOES });
  const por = Object.fromEntries(w.map((x) => [x.campo, x.valor]));
  assert.equal(por.DATA_CONSULTA, EPOCH_CONSULTA);
  assert.equal(por.SITUACAO, 'Agendado');
  assert.equal(por.FISIO, 'DRA. BÁRBARA WIRTZBIKI');
  assert.equal(por.CATEGORIA, 'Avaliação');
  assert.equal(por.AGENDADO_SDR_EM, AGORA);
  assert.equal(por.FEITO_POR, 'Humano');
});

test('cartão já igual à franquia: não escreve nada', () => {
  const valores = {
    '◷ Data da Consulta': String(EPOCH_CONSULTA), '✓ Situação da consulta': 'Agendado', '⚕ Fisioterapeuta': 'DRA. BÁRBARA WIRTZBIKI',
    '⌂ Categoria da consulta': 'Avaliação', '◷ Agendado pela SDR em': String(AGORA - 3600), '⬢ Agendamento feito por': 'IA',
  };
  const w = planejarEscritas({ valores, consulta: consulta(), consultaEpoch: EPOCH_CONSULTA, tratamento: null, feitoPelaIa: true, agoraEpoch: AGORA, opcoes: OPCOES });
  assert.deepEqual(w, []);
});

test('franquia diverge do cartão: a franquia vence em data e situação, mas não reinventa o carimbo', () => {
  const valores = { '◷ Data da Consulta': String(EPOCH_CONSULTA - 86_400), '✓ Situação da consulta': 'Agendado', '◷ Agendado pela SDR em': String(AGORA - 7200), '⬢ Agendamento feito por': 'Humano' };
  const w = planejarEscritas({ valores, consulta: consulta({ idStatus: SPINE_STATUS.ATENDIDO }), consultaEpoch: EPOCH_CONSULTA, tratamento: null, feitoPelaIa: false, agoraEpoch: AGORA, opcoes: OPCOES });
  const campos = w.map((x) => x.campo);
  assert.ok(campos.includes('DATA_CONSULTA'));
  assert.equal(w.find((x) => x.campo === 'SITUACAO')?.valor, 'Atendido');
  assert.ok(!campos.includes('AGENDADO_SDR_EM'));
  assert.ok(!campos.includes('FEITO_POR'));
});

test('consulta passada sem carimbo: não inventa "Agendado pela SDR em"', () => {
  const w = planejarEscritas({ valores: {}, consulta: consulta({ idStatus: SPINE_STATUS.ATENDIDO }), consultaEpoch: AGORA - 86_400, tratamento: null, feitoPelaIa: false, agoraEpoch: AGORA, opcoes: OPCOES });
  assert.ok(!w.some((x) => x.campo === 'AGENDADO_SDR_EM'));
});

test('tratamento em andamento: Fechou=Sim, opção do tratamento e fisio se vazio; o valor é da SDR, não da franquia', () => {
  const t = { idTreatment: 1, idClient: 2, clientName: 'Maria', category: '03 Meses', local: 'LOMBAR', degree: 'CRÔNICO', staffName: 'Bárbara Wirtzbiki', statusName: 'EM ANDAMENTO', price: 2400 };
  const w = planejarEscritas({ valores: { '¤ Valor do tratamento': '1800' }, consulta: null, consultaEpoch: null, tratamento: t, feitoPelaIa: false, agoraEpoch: AGORA, opcoes: OPCOES });
  const por = Object.fromEntries(w.map((x) => [x.campo, x.valor]));
  assert.equal(por.FECHOU_TRAT, 'Sim');
  assert.equal(por.TRAT_FECHADO, '03 Meses — LOMBAR CRÔNICO');
  assert.ok(!('VALOR_TRAT' in por), 'a franquia não pode sobrescrever o valor digitado pela SDR');
  assert.equal(por.FISIO, 'DRA. BÁRBARA WIRTZBIKI');
});

test('tratamento com valor vazio no cartão: a franquia continua não escrevendo o valor', () => {
  const t = { idTreatment: 1, idClient: 2, clientName: 'Maria', category: '03 Meses', local: 'LOMBAR', degree: 'CRÔNICO', staffName: null, statusName: 'EM ANDAMENTO', price: 2400 };
  const w = planejarEscritas({ valores: {}, consulta: null, consultaEpoch: null, tratamento: t, feitoPelaIa: false, agoraEpoch: AGORA, opcoes: OPCOES });
  assert.ok(!w.some((x) => x.campo === 'VALOR_TRAT'));
});

test('mapa de campos: aceita date_time como date e ignora tipos que não gravamos', async () => {
  const { _interno } = await import('./franquia-sync-worker.js');
  const mapa = _interno.mapearCampos([
    { id: 1, name: '◷ Data da Consulta', type: 'date_time' },
    { id: 2, name: '✓ Situação da consulta', type: 'select', enums: [{ id: 9, value: 'Agendado' }] },
    { id: 3, name: '◷ Agendado pela SDR em', type: 'date_time' },
    { id: 4, name: '⚕ Fisioterapeuta', type: 'tracking_data' },
  ]);
  assert.equal(mapa.DATA_CONSULTA?.type, 'date');
  assert.equal(mapa.AGENDADO_SDR_EM?.id, 3);
  assert.deepEqual(mapa.SITUACAO?.enums, [{ id: 9, value: 'Agendado' }]);
  assert.equal(mapa.FISIO, undefined);
});

test('sessão de tratamento não é consulta: não entra na escolha nem carimba agendamento', () => {
  const sessao = consulta({ idSchedule: 5, categoryName: 'SESSÃO', dateAttendanceUtc: '2026-09-30T13:00:00Z' });
  const avaliacao = consulta({ idSchedule: 6, categoryName: 'AVALIAÇÃO', dateAttendanceUtc: '2026-09-01T13:00:00Z', idStatus: SPINE_STATUS.ATENDIDO });
  assert.equal(escolherConsulta([sessao, avaliacao])?.idSchedule, 6, 'a avaliação antiga vence a sessão futura');
  assert.equal(escolherConsulta([sessao]), null, 'só sessões: nada a espelhar no bloco CONSULTA');
  const w = planejarEscritas({ valores: {}, consulta: null, consultaEpoch: null, tratamento: null, feitoPelaIa: false, agoraEpoch: AGORA, opcoes: OPCOES });
  assert.deepEqual(w, []);
});

test('retorno: espelha data/situação/categoria mas não carimba "Agendado pela SDR em" nem "feito por"', () => {
  const retorno = consulta({ categoryName: 'RETORNO', dateAttendanceUtc: '2026-09-20T13:00:00Z' });
  const w = planejarEscritas({ valores: {}, consulta: retorno, consultaEpoch: EPOCH_CONSULTA, tratamento: null, feitoPelaIa: false, agoraEpoch: AGORA, opcoes: OPCOES });
  const campos = w.map((x) => x.campo);
  assert.ok(campos.includes('DATA_CONSULTA') && campos.includes('SITUACAO'));
  assert.equal(w.find((x) => x.campo === 'CATEGORIA')?.valor, 'Retorno');
  assert.ok(!campos.includes('AGENDADO_SDR_EM') && !campos.includes('FEITO_POR'));
});

test('tratamento: "PROTOCOLO 03 MESES" da franquia casa com "03 Meses — CERVICAL CRÔNICO" do cartão', () => {
  assert.equal(opcaoDoTratamento({ category: 'PROTOCOLO 03 MESES', local: 'CERVICAL', degree: 'CRÔNICO' }, OPCOES.tratamento), '03 Meses — CERVICAL CRÔNICO');
});
