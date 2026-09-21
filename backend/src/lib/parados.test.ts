import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMPO,
  DIA_S,
  MOTIVO_PERDA,
  candidatoPeloCartao,
  decidirFalta,
  decidirParado,
  decidirReguaEsgotada,
  ehRespostaDeCortesia,
  modoSeco,
  paradosLiberado,
  reguaEsgotadaDerruba,
  textoDaNota,
} from './parados.js';

const AGORA = Date.parse('2026-09-21T15:00:00Z') / 1000;
const dias = (d: number) => AGORA - d * DIA_S;
const prazos = { esperaDias: 30, negociacaoDias: 45 };
const quieto = { escreveuNaJanela: false, mudouEtapaNaJanela: false, retomarEmEpoch: null, criadoEpoch: dias(120) };

test('parados: liga por slug ou *, e vazio é ninguém', () => {
  assert.equal(paradosLiberado('doutor-hernia-imperatriz', undefined), false);
  assert.equal(paradosLiberado('doutor-hernia-imperatriz', ''), false);
  assert.equal(paradosLiberado('doutor-hernia-imperatriz', '*'), true);
  assert.equal(paradosLiberado('laboratorio-kommo', '"laboratorio-kommo, doutor-hernia-imperatriz"'), true);
  assert.equal(paradosLiberado('doutor-hernia-serra', 'laboratorio-kommo'), false);
  assert.equal(modoSeco('1'), true);
  assert.equal(modoSeco('0'), false);
  assert.equal(modoSeco(undefined), false);
});

test('parados: EM ESPERA quieta há 30 dias cai em PERDIDO sem régua; EM NEGOCIAÇÃO em 45', () => {
  const e = decidirParado('EM ESPERA', quieto, AGORA, prazos);
  assert.equal(e?.para, 'PERDIDO');
  assert.equal(e?.motivoPerda, MOTIVO_PERDA.ESPERA);
  assert.deepEqual(e?.campo, { nome: CAMPO.MOTIVO_NAO_AGENDAMENTO, opcao: MOTIVO_PERDA.ESPERA });
  assert.equal(e?.semRegua, true, 'quem sumiu depois de semanas não recebe a régua de quem nunca veio');
  const n = decidirParado('EM NEGOCIAÇÃO', quieto, AGORA, prazos);
  assert.equal(n?.motivoPerda, MOTIVO_PERDA.NEGOCIACAO);
  assert.equal(n?.campo?.nome, CAMPO.MOTIVO_NAO_FECHAMENTO);
});

test('parados: qualquer sinal de vida na janela segura o cartão', () => {
  assert.equal(decidirParado('EM ESPERA', { ...quieto, escreveuNaJanela: true }, AGORA, prazos), null, 'paciente escreveu');
  assert.equal(decidirParado('EM NEGOCIAÇÃO', { ...quieto, mudouEtapaNaJanela: true }, AGORA, prazos), null, 'acabou de entrar na etapa');
  assert.equal(decidirParado('EM ESPERA', { ...quieto, criadoEpoch: dias(10) }, AGORA, prazos), null, 'cartão novo');
});

test('parados: "Retomar em" futura ou recente segura EM ESPERA — a retomada tem a vez antes do prazo', () => {
  assert.equal(decidirParado('EM ESPERA', { ...quieto, retomarEmEpoch: AGORA + 20 * DIA_S }, AGORA, prazos), null, 'retomada futura');
  assert.equal(decidirParado('EM ESPERA', { ...quieto, retomarEmEpoch: dias(5) }, AGORA, prazos), null, 'retomada há 5 dias: conta dela');
  assert.equal(decidirParado('EM ESPERA', { ...quieto, retomarEmEpoch: dias(31) }, AGORA, prazos)?.para, 'PERDIDO', 'retomada há 31 dias sem volta');
  assert.equal(candidatoPeloCartao('EM ESPERA', { retomarEmEpoch: AGORA + 1, criadoEpoch: null }, AGORA, prazos), false);
  assert.equal(candidatoPeloCartao('EM ESPERA', { retomarEmEpoch: null, criadoEpoch: null }, AGORA, prazos), true, 'sem data nenhuma vale consultar');
});

test('parados: outras etapas nunca são movidas por prazo', () => {
  for (const etapa of ['AGENDADO', 'COMPARECEU', 'EM QUALIFICAÇÃO', 'PERDIDO', 'RETORNO PÓS-TRATAMENTO', 'NÃO COMPARECEU']) {
    assert.equal(decidirParado(etapa, quieto, AGORA, prazos), null, etapa);
    assert.equal(candidatoPeloCartao(etapa, quieto, AGORA, prazos), false, etapa);
  }
});

test('parados: falta há 7 dias sem consulta futura vai pra EM ESPERA com retomada em +7', () => {
  assert.equal(decidirFalta(dias(6), false, AGORA, 7), null);
  assert.equal(decidirFalta(dias(10), true, AGORA, 7), null, 'remarcou na franquia: fica');
  assert.equal(decidirFalta(null, false, AGORA, 7), null, 'sem data da falta não inventa');
  const d = decidirFalta(dias(7), false, AGORA, 7);
  assert.equal(d?.para, 'EM ESPERA');
  assert.deepEqual(d?.campo, { nome: CAMPO.MOTIVO_ESPERA, opcao: 'Outro' });
  assert.equal(d?.retomarEmEpoch, AGORA + 7 * DIA_S);
});

test('parados: régua esgotada só derruba entrada e qualificação, e só se o cartão diz "Sem resposta" e ninguém escreveu depois', () => {
  for (const e of ['Incoming leads', 'Etapa de leads de entrada', 'EM QUALIFICAÇÃO']) assert.equal(reguaEsgotadaDerruba(e), true, e);
  for (const e of ['EM ESPERA', 'AGENDADO', 'EM NEGOCIAÇÃO', 'COMPARECEU']) assert.equal(reguaEsgotadaDerruba(e), false, e);
  assert.equal(decidirReguaEsgotada(null, false), null);
  assert.equal(decidirReguaEsgotada('Aguardando lead', false), null);
  assert.equal(decidirReguaEsgotada('Sem resposta', true), null, 'respondeu ao último toque');
  const d = decidirReguaEsgotada('Sem resposta', false);
  assert.equal(d?.motivoPerda, MOTIVO_PERDA.FOLLOW_UP);
  assert.equal(d?.campo?.opcao, 'Não interagiu');
  assert.equal(d?.semRegua, false, 'quem nunca interagiu recebe a régua de PERDIDO');
});

test('parados: "ok, obrigado 🙏" é cortesia; pergunta ou frase é o paciente voltando', () => {
  for (const m of ['ok', 'Ok, obrigada!', 'tá bom 🙏', 'Beleza, valeu', 'Bom dia', '👍', '']) assert.equal(ehRespostaDeCortesia(m), true, m);
  for (const m of ['sim', 'pode ser', 'tudo bem, vamos marcar', 'oi, consegui os exames', 'quanto custa a consulta?', 'quero agendar', 'ok mas tem horário amanhã?']) {
    assert.equal(ehRespostaDeCortesia(m), false, m);
  }
});

test('parados: a nota diz de onde veio, por que e o que acontece se o paciente voltar', () => {
  const perdido = decidirParado('EM ESPERA', quieto, AGORA, prazos)!;
  const t = textoDaNota(perdido, 'EM ESPERA');
  assert.match(t, /EM ESPERA para PERDIDO/);
  assert.match(t, /mais de 30 dias/);
  assert.match(t, /Não deu continuidade ao atendimento/);
  const espera = decidirFalta(dias(8), false, AGORA, 7)!;
  assert.match(textoDaNota(espera, 'NÃO COMPARECEU'), /NÃO COMPARECEU para EM ESPERA/);
});
