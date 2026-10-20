import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMPO,
  DIA_S,
  campoDoPerdidoDaFranquia,
  motivoDaSdrNoCartao,
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
  voltaDaEsperaLiberada,
  voltaDaEsperaSeca,
} from './parados.js';
import { MOTIVO_PERDA as MOTIVO_PERDA_FRANQUIA } from './franquia-move.js';

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
  assert.equal(modoSeco(undefined, '1'), true);
  assert.equal(modoSeco('doutor-hernia-serra', '1', 'doutor-hernia-serra'), false, 'unidade ligada sai do seco');
  assert.equal(modoSeco('doutor-hernia-imperatriz', '1', 'doutor-hernia-serra'), true);
  assert.equal(modoSeco(undefined, '0'), false);
  assert.equal(modoSeco(undefined, undefined), false);
});

test('volta de EM ESPERA: chave própria liga sem trazer as regras de prazo junto', () => {
  const PARADAS = 'laboratorio-kommo,doutor-hernia-serra';

  // Taubaté só na chave nova: a volta vale e move de verdade, mas o worker de prazo continua fora.
  assert.equal(voltaDaEsperaLiberada('doutor-hernia-taubate', 'doutor-hernia-taubate', PARADAS), true);
  assert.equal(voltaDaEsperaSeca('doutor-hernia-taubate', 'doutor-hernia-taubate', '1', 'doutor-hernia-serra'), false, 'opt-in explícito ignora PARADOS_SECO');
  assert.equal(paradosLiberado('doutor-hernia-taubate', PARADAS), false, 'as regras de prazo NÃO ligam junto');

  // Quem já vinha por PARADOS_SLUGS segue igual, seco inclusive — nada muda pra Serra/Imperatriz.
  assert.equal(voltaDaEsperaLiberada('doutor-hernia-serra', undefined, PARADAS), true);
  assert.equal(voltaDaEsperaSeca('doutor-hernia-serra', undefined, '1', 'doutor-hernia-serra'), false);
  assert.equal(voltaDaEsperaSeca('laboratorio-kommo', undefined, '1', 'doutor-hernia-serra'), true, 'herdado de PARADOS_SLUGS respeita o seco');

  // Quem não está em lista nenhuma continua de fora.
  assert.equal(voltaDaEsperaLiberada('doutor-hernia-petropolis', undefined, PARADAS), false);
  assert.equal(voltaDaEsperaLiberada('doutor-hernia-petropolis', '', ''), false);
  assert.equal(voltaDaEsperaLiberada('doutor-hernia-petropolis', '*', ''), true);
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

test('parados: o PERDIDO da franquia leva o campo ⊘ que a SDR lê (Açailândia 08/10: 253 cartões "sem motivo")', () => {
  assert.deepEqual(campoDoPerdidoDaFranquia(MOTIVO_PERDA_FRANQUIA.NAO_REMARCOU), {
    nome: CAMPO.MOTIVO_NAO_AGENDAMENTO,
    opcao: MOTIVO_PERDA.ESPERA,
  });
  assert.deepEqual(campoDoPerdidoDaFranquia(MOTIVO_PERDA_FRANQUIA.NAO_FECHOU), {
    nome: CAMPO.MOTIVO_NAO_FECHAMENTO,
    opcao: MOTIVO_PERDA.NEGOCIACAO,
  });
  // sem cadastro não é motivo do paciente
  assert.equal(campoDoPerdidoDaFranquia(MOTIVO_PERDA_FRANQUIA.SEM_CADASTRO), undefined);
  assert.equal(campoDoPerdidoDaFranquia(undefined), undefined);
});

test('parados: o motivo que a SDR já escreveu fica — por qualquer nome, em qualquer dos dois campos', () => {
  const longo = [{ field_name: '⊘ Motivo de não fechamento do tratamento', values: [{ value: 'Decidir com a familia' }] }];
  assert.equal(motivoDaSdrNoCartao(longo), 'Decidir com a familia');
  const curto = [{ field_name: '⊘ Motivo do não agendamento', values: [{ value: 'Está viajando' }] }];
  assert.equal(motivoDaSdrNoCartao(curto), 'Está viajando');
  // outros campos ⊘ não contam
  assert.equal(motivoDaSdrNoCartao([{ field_name: '⊘ Motivo da espera', values: [{ value: 'Viajando' }] }]), null);
  // vazio, branco ou sem campos: grava
  assert.equal(motivoDaSdrNoCartao([{ field_name: '⊘ Motivo do não agendamento', values: [{ value: '  ' }] }]), null);
  assert.equal(motivoDaSdrNoCartao([{ field_name: '⊘ Motivo do não agendamento', values: [] }]), null);
  assert.equal(motivoDaSdrNoCartao(null), null);
});

test('parados: motivo genérico de robô (sobra de um PERDIDO antigo) não segura — o fecho novo escreve o dele', () => {
  for (const generico of Object.values(MOTIVO_PERDA)) {
    assert.equal(motivoDaSdrNoCartao([{ field_name: '⊘ Motivo do não agendamento', values: [{ value: generico }] }]), null, generico);
  }
  // mas a SDR num campo e a sobra do robô no outro: vale a SDR
  assert.equal(
    motivoDaSdrNoCartao([
      { field_name: '⊘ Motivo do não agendamento', values: [{ value: 'Não interagiu' }] },
      { field_name: '⊘ Motivo de não fechamento', values: [{ value: 'Achou caro' }] },
    ]),
    'Achou caro',
  );
});

test('régua esgotada (auditoria 16/10, item 12): o filtro pede a escada CONCLUÍDA — caso real 10819952 vira PERDIDO', async () => {
  const { MOTIVO_ESCADA_CONCLUIDA } = await import('./follow-up-presets.js');
  const { escadaEsgotada, filtroDaReguaEsgotada } = await import('./parados.js');
  const agora = Date.parse('2026-10-20T12:00:00Z') / 1000;
  // 10819952 (Açailândia): o paciente escreveu uma vez em 02/10, a escada acabou em 03/10 e o cartão seguia em
  // EM QUALIFICAÇÃO "Sem resposta" 17 dias depois — o filtro antigo (`followUpStoppedReason = null`) nunca o via.
  const conversa = { followUpStep: 4, followUpStoppedReason: MOTIVO_ESCADA_CONCLUIDA, followUpLastAt: new Date('2026-10-03T11:16:03Z') };
  assert.equal(escadaEsgotada(conversa, agora), true);
  const filtro = filtroDaReguaEsgotada(['u1'], agora);
  assert.equal(filtro.followUpStoppedReason, 'escada concluída', 'o mesmo texto que o follow-up-worker grava no último degrau');
  assert.ok(filtro.followUpLastAt.lt.getTime() === (agora - 24 * 3600) * 1000);
  assert.equal(reguaEsgotadaDerruba('EM QUALIFICAÇÃO'), true);
  const d = decidirReguaEsgotada('Sem resposta', false);
  assert.equal(d?.para, 'PERDIDO');
  assert.equal(d?.motivoPerda, MOTIVO_PERDA.FOLLOW_UP);

  // fora da regra: escada no meio, parada por outro motivo, paciente que voltou (o passo zera) e toque recente
  assert.equal(escadaEsgotada({ ...conversa, followUpStoppedReason: null }, agora), false, 'escada ainda no meio');
  assert.equal(escadaEsgotada({ ...conversa, followUpStoppedReason: 'consulta marcada' }, agora), false);
  assert.equal(escadaEsgotada({ ...conversa, followUpStoppedReason: 'paciente pediu para parar' }, agora), false);
  assert.equal(escadaEsgotada({ ...conversa, followUpStep: 0, followUpLastAt: null }, agora), false, 'escreveu depois: o passo zerou');
  assert.equal(escadaEsgotada({ ...conversa, followUpLastAt: new Date('2026-10-20T01:00:00Z') }, agora), false, 'ainda dentro das 24 h');
});
