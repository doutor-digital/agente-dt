import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diaDaRetomada, diaDoCampoData, esperaSeguraMovimento, esperaSeguraVolta, retomarEmDoCartao } from './espera-retomada.js';
import { ETAPA, planejarMovimento } from './franquia-move.js';
import type { SpineSchedule } from '../services/spine.service.js';

/** Campo `date` do Kommo como a Açailândia grava: meia-noite de Brasília (03:00 UTC). */
const diaKommo = (iso: string) => Date.parse(`${iso}T03:00:00Z`) / 1000;
const brt = (isoLocal: string) => Date.parse(`${isoLocal}-03:00`) / 1000;
const campos = (epoch: number | null) => (epoch === null ? [] : [{ field_name: '◷ Retomar em', values: [{ value: epoch }] }]);
const ESPERA = { funil: 'COMERCIAL' as const, status: ETAPA.ESPERA };

function ag(dataIsoUtc: string, idStatus: number, categoria = 'AVALIAÇÃO'): SpineSchedule {
  return { idSchedule: Math.floor(Math.random() * 1e6), idStatus, clientName: 'Paciente Teste', categoryName: categoria, dateAttendanceUtc: dataIsoUtc, dateAttendanceLocal: null } as unknown as SpineSchedule;
}

test('dia da retomada: lê o campo date do Kommo no dia certo e compara com hoje no fuso da unidade', () => {
  assert.equal(diaDoCampoData(diaKommo('2026-10-20')), '2026-10-20');
  // conta em UTC-4 (meia-noite = 04:00 UTC) e em UTC: mesmo dia
  assert.equal(diaDoCampoData(Date.parse('2026-10-20T04:00:00Z') / 1000), '2026-10-20');
  assert.equal(diaDoCampoData(Date.parse('2026-10-20T00:00:00Z') / 1000), '2026-10-20');
  const agora = brt('2026-10-13T14:44:00');
  assert.equal(diaDaRetomada(diaKommo('2026-10-20'), agora), 'futuro');
  assert.equal(diaDaRetomada(diaKommo('2026-10-13'), agora), 'hoje');
  assert.equal(diaDaRetomada(diaKommo('2026-10-12'), agora), 'passou');
  assert.equal(diaDaRetomada(null, agora), 'sem');
  // 23:30 de Brasília já é o dia seguinte em UTC: hoje continua sendo hoje
  assert.equal(diaDaRetomada(diaKommo('2026-10-14'), brt('2026-10-13T23:30:00')), 'futuro');
  assert.equal(retomarEmDoCartao(campos(diaKommo('2026-10-20'))), diaKommo('2026-10-20'));
  assert.equal(retomarEmDoCartao([{ field_name: '◷ Retomar em', values: [{ value: String(diaKommo('2026-10-20') * 1000) }] }]), diaKommo('2026-10-20'), 'aceita ms em texto');
  assert.equal(retomarEmDoCartao([]), null);
});

test('caso real 25162400 (13/10): a SDR pôs em EM ESPERA com retomada em 20/10 e o franquia-move devolveu pra COMPARECEU em 10 min — agora fica', () => {
  const agora = brt('2026-10-13T14:44:00');
  const atendidaHoje = ag('2026-10-13T12:30:00Z', 42); // avaliação atendida de manhã, menos de 48 h
  const mov = planejarMovimento({ atual: ESPERA, agendamentos: [atendidaHoje], tratamentos: [], agoraEpoch: agora, horasAteNegociacao: 48 });
  assert.equal(mov?.para, ETAPA.COMPARECEU, 'é isto que o robô fazia');
  const dia = diaDaRetomada(retomarEmDoCartao(campos(diaKommo('2026-10-20'))), agora);
  assert.equal(esperaSeguraMovimento(ESPERA, mov!.para, dia), true);
  // 27441243 (10/10, retomada em 13/10): mesma coisa, e também a passagem pra EM NEGOCIAÇÃO depois das 48 h
  assert.equal(esperaSeguraMovimento(ESPERA, ETAPA.NEGOCIACAO, diaDaRetomada(diaKommo('2026-10-13'), brt('2026-10-10T11:08:00'))), true);
  // no próprio dia da retomada ainda segura: é às 9 h dele que o robô do Kommo manda a retomada pra quem está em EM ESPERA
  assert.equal(esperaSeguraMovimento(ESPERA, ETAPA.COMPARECEU, diaDaRetomada(diaKommo('2026-10-20'), brt('2026-10-20T07:00:00'))), true);
});

test('EM ESPERA sem retomada, ou com a retomada vencida, segue como antes', () => {
  const agora = brt('2026-10-13T14:44:00');
  assert.equal(esperaSeguraMovimento(ESPERA, ETAPA.COMPARECEU, diaDaRetomada(null, agora)), false, 'sem data = estacionamento, o robô arruma');
  assert.equal(esperaSeguraMovimento(ESPERA, ETAPA.COMPARECEU, diaDaRetomada(diaKommo('2026-10-12'), agora)), false, 'retomada que já passou');
});

test('fato NOVO da franquia tira da espera mesmo com retomada marcada: consulta marcada, tratamento aberto, jornada do tratamento', () => {
  const futuro = diaDaRetomada(diaKommo('2026-10-20'), brt('2026-10-13T14:44:00'));
  for (const para of [ETAPA.AGENDADO, ETAPA.GANHO, ETAPA.RETORNO, ETAPA.EM_TRATAMENTO, ETAPA.ALTA]) {
    assert.equal(esperaSeguraMovimento(ESPERA, para, futuro), false, para);
  }
  // e quem não está em EM ESPERA não é afetado
  assert.equal(esperaSeguraMovimento({ funil: 'COMERCIAL', status: ETAPA.COMPARECEU }, ETAPA.NEGOCIACAO, futuro), false);
  assert.equal(esperaSeguraMovimento({ funil: 'TRATAMENTO', status: ETAPA.ESPERA }, ETAPA.ALTA, futuro), false);
  assert.equal(esperaSeguraMovimento(null, ETAPA.COMPARECEU, futuro), false);
});

test('casos reais da volta (28651944, 10822030): retomada pra frente segura; no dia da retomada a resposta traz o cartão de volta', () => {
  // 28651944: a Sofia pôs em EM ESPERA às 11:23 de 15/10 com retomada em 22/10; o paciente escreveu às 11:24
  assert.equal(esperaSeguraVolta(diaDaRetomada(diaKommo('2026-10-22'), brt('2026-10-15T11:24:00'))), true);
  // 10822030: a SDR pôs retomada em 15/10 às 19:09 de 14/10; o paciente escreveu às 19:10
  assert.equal(esperaSeguraVolta(diaDaRetomada(diaKommo('2026-10-15'), brt('2026-10-14T19:10:00'))), true);
  // 10822030 de novo, 15/10 09:36: respondeu à mensagem de retomada do dia — a volta faz o trabalho dela
  assert.equal(esperaSeguraVolta(diaDaRetomada(diaKommo('2026-10-15'), brt('2026-10-15T09:36:00'))), false);
  assert.equal(esperaSeguraVolta(diaDaRetomada(null, brt('2026-10-15T09:36:00'))), false, 'sem retomada: volta como sempre');
});
