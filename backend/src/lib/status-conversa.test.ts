import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { cartaoEncerrado, decidirStatusConversa, etapaEncerraConversa, statusAtualDoCartao } from './status-conversa.js';
import { aplicarCarimbosDeEtapa, CAMPOS_CARIMBO } from './carimbo-etapa.js';
import { limparCacheEsquema, montarEsquema } from './kommo-schema.js';
import { _semearParaTeste } from './automacoes-estado.js';
import { _semearCrmParaTeste } from './crm-compartilhado.js';
import { carimbarHumanoAssumiu, carimbarSemResposta, CAMPOS_DIGITAL, gravarStatusConversa } from '../services/lead-metrics.service.js';

/**
 * "⬢ Status da conversa": o "Encerrada" que o carimbo de etapa grava em PERDIDO não pode ser desfeito pelos
 * outros escritores (follow-up, IA, handoff). Caso real: Açailândia, 24/10/2026 — leads 29017216, 29020564,
 * 29020582 (follow-up → "Sem resposta") e 29027086, 29027778 (handoff → "Respondendo").
 */

before(() => {
  // o carimbo de etapa é o dono do "Encerrada" nesta unidade (como na Açailândia em produção)
  _semearParaTeste([{ slug: 'doutor-hernia-acailandia', automacao: 'carimbo-etapa', estado: 'ligado' }]);
  _semearCrmParaTeste([]);
});

const SLUG = 'doutor-hernia-acailandia';
const unidade = { id: 'u-status-conversa', slug: SLUG, kommoSubdomain: 'doutorherniaacailandia', kommoAccessToken: 'x' } as Unit;

const ID_STATUS_CONVERSA = 2449972;
const COMERCIAL = 13795975;
const TRATAMENTO = 13795980;
const ETAPA_QUALIFICACAO = 106809907;

const CAMPOS = [
  { id: ID_STATUS_CONVERSA, name: CAMPOS_CARIMBO.STATUS_CONVERSA },
  { id: 2449973, name: CAMPOS_DIGITAL.ASSUMIDO_HUMANO },
  { id: 2449974, name: CAMPOS_DIGITAL.MOTIVO_HANDOFF },
];
const FUNIS = [
  { id: COMERCIAL, name: 'COMERCIAL', statuses: [{ id: ETAPA_QUALIFICACAO, name: 'EM QUALIFICAÇÃO' }, { id: 142, name: 'GANHO / CONCLUÍDO' }, { id: 143, name: 'PERDIDO' }] },
  { id: TRATAMENTO, name: 'TRATAMENTO', statuses: [{ id: 21, name: 'EM TRATAMENTO' }, { id: 142, name: 'ALTA' }, { id: 143, name: 'TRATAMENTO CANCELADO' }] },
];
const esquema = montarEsquema(CAMPOS, FUNIS);

/** Kommo falso com ESTADO: um cartão, com etapa e o valor atual do campo. O que o teste afirma é o que ficou no cartão. */
function cartaoFalso(statusId: number, pipelineId: number, statusConversa: string | null, funis = FUNIS) {
  const estado = { status_id: statusId, pipeline_id: pipelineId, statusConversa, leituras: 0, falhaNaLeitura: false };
  const kommo = {
    listLeadCustomFields: async () => ({ _embedded: { custom_fields: CAMPOS } }),
    listPipelines: async () => funis,
    getLead: async (id: number) => {
      estado.leituras++;
      if (estado.falhaNaLeitura) throw new Error('429');
      const valores = estado.statusConversa === null
        ? []
        : [{ field_id: ID_STATUS_CONVERSA, field_name: CAMPOS_CARIMBO.STATUS_CONVERSA, values: [{ value: estado.statusConversa }] }];
      return { id, name: 'x', status_id: estado.status_id, pipeline_id: estado.pipeline_id, custom_fields_values: valores };
    },
    setLeadCustomFieldValue: async (_leadId: number, fieldId: number, _tipo: string, valor: unknown) => {
      if (fieldId === ID_STATUS_CONVERSA) estado.statusConversa = String(valor);
    },
  };
  return { estado, kommo: kommo as never };
}

test('só o carimbo de etapa escreve "Encerrada"; qualquer outro valor respeita cartão encerrado', () => {
  assert.deepEqual(decidirStatusConversa('Encerrada', true, 'Encerrada'), { gravar: true });
  assert.deepEqual(decidirStatusConversa('Encerrada', false, null), { gravar: true });
  for (const v of ['Sem resposta', 'Respondendo', 'Aguardando lead'] as const) {
    assert.equal(decidirStatusConversa(v, false, 'Encerrada').gravar, true, `${v} em cartão aberto`);
    assert.equal(decidirStatusConversa(v, true, 'Encerrada').gravar, false, `${v} em cartão encerrado e campo Encerrada`);
    // o outro lado: encerrado mas o campo diz outra coisa (ou está vazio) — grava, senão o campo congela
    for (const atual of ['Aguardando lead', 'Respondendo', 'Sem resposta', null]) {
      assert.equal(decidirStatusConversa(v, true, atual).gravar, true, `${v} em cartão encerrado com o campo em ${atual}`);
    }
  }
});

test('statusAtualDoCartao: acha pelo id ou, sem esquema, pelo nome; vazio vira null', () => {
  const lead = { custom_fields_values: [{ field_id: 7, field_name: '⬢ Status da conversa', values: [{ value: 'Encerrada' }] }] };
  assert.equal(statusAtualDoCartao(lead, 7, '⬢ Status da conversa'), 'Encerrada');
  assert.equal(statusAtualDoCartao(lead, null, '⬢ Status da conversa'), 'Encerrada');
  assert.equal(statusAtualDoCartao({ custom_fields_values: [] }, 7, '⬢ Status da conversa'), null);
  assert.equal(statusAtualDoCartao(null, 7, '⬢ Status da conversa'), null);
});

test('"etapa que encerra" é uma definição só, e o carimbo de etapa usa a mesma', () => {
  for (const e of ['PERDIDO', 'Perdido', 'GANHO / CONCLUÍDO', 'GANHO', 'CONCLUÍDO']) assert.equal(etapaEncerraConversa(e), true, e);
  for (const e of ['EM QUALIFICAÇÃO', 'AGENDADO', 'ALTA', 'TRATAMENTO CANCELADO', '', null, undefined]) assert.equal(etapaEncerraConversa(e), false, String(e));
});

test('142/143 não bastam: o nome da etapa decide (ALTA e TRATAMENTO CANCELADO do funil TRATAMENTO não encerram)', () => {
  assert.equal(cartaoEncerrado({ status_id: 143 }, 'PERDIDO'), true);
  assert.equal(cartaoEncerrado({ status_id: 142 }, 'GANHO / CONCLUÍDO'), true);
  assert.equal(cartaoEncerrado({ status_id: 142 }, 'ALTA'), false);
  assert.equal(cartaoEncerrado({ status_id: 143 }, 'TRATAMENTO CANCELADO'), false);
  // sem nome conhecido, vale o id que o Kommo garante
  assert.equal(cartaoEncerrado({ status_id: 143 }, null), true);
  assert.equal(cartaoEncerrado({ status_id: 142 }, null), true);
  assert.equal(cartaoEncerrado({ status_id: ETAPA_QUALIFICACAO }, null), false);
});

test('REPRODUÇÃO 24/10: PERDIDO → "Encerrada"; fim da escada, handoff e turno da IA não a desfazem', async () => {
  limparCacheEsquema();
  const { estado, kommo } = cartaoFalso(143, COMERCIAL, 'Aguardando lead');

  // 1. o SDR move o cartão para PERDIDO; o webhook de etapa carimba "Encerrada"
  const gravados = await aplicarCarimbosDeEtapa(unidade, [{ id: 29017216, status_id: 143, pipeline_id: COMERCIAL }], {
    kommo, esquema, raw: '*', grupo: null,
  });
  assert.equal(gravados, 1);
  assert.equal(estado.statusConversa, 'Encerrada');

  // 2. o follow-up termina a escada (11:13) — antes do conserto gravava "Sem resposta" aqui
  await carimbarSemResposta(unidade, 29017216, kommo);
  assert.equal(estado.statusConversa, 'Encerrada', 'follow-up desfez o Encerrada');

  // 3. a IA passa o cartão para um humano (pausar_ia / auto-pausa) — antes gravava "Respondendo"
  await carimbarHumanoAssumiu(unidade, kommo, 29027086, 'Escalonamento');
  assert.equal(estado.statusConversa, 'Encerrada', 'handoff desfez o Encerrada');

  // 4. fim do turno da IA — antes gravava "Aguardando lead" se a leitura do cartão falhasse/atrasasse
  await gravarStatusConversa(unidade, kommo, 29017216, 'Aguardando lead', 'turno-da-ia');
  assert.equal(estado.statusConversa, 'Encerrada', 'turno da IA desfez o Encerrada');
});

test('cartão aberto continua sendo escrito pelos três (nada mudou para quem não está encerrado)', async () => {
  limparCacheEsquema();
  const { estado, kommo } = cartaoFalso(ETAPA_QUALIFICACAO, COMERCIAL, null);
  await gravarStatusConversa(unidade, kommo, 1, 'Aguardando lead', 'turno-da-ia');
  assert.equal(estado.statusConversa, 'Aguardando lead');
  await carimbarHumanoAssumiu(unidade, kommo, 1);
  assert.equal(estado.statusConversa, 'Respondendo');
  await carimbarSemResposta(unidade, 1, kommo);
  assert.equal(estado.statusConversa, 'Sem resposta');
});

test('reaberto: o SDR tira o cartão de PERDIDO e a IA volta a escrever o campo', async () => {
  limparCacheEsquema();
  const { estado, kommo } = cartaoFalso(143, COMERCIAL, 'Encerrada');
  await gravarStatusConversa(unidade, kommo, 1, 'Aguardando lead', 'turno-da-ia');
  assert.equal(estado.statusConversa, 'Encerrada');
  estado.status_id = ETAPA_QUALIFICACAO; // a equipe moveu de etapa
  await gravarStatusConversa(unidade, kommo, 1, 'Aguardando lead', 'turno-da-ia');
  assert.equal(estado.statusConversa, 'Aguardando lead');
});

test('SONDA DO SÊNIOR: cartão encerrado onde o carimbo NÃO gravou "Encerrada" — handoff, follow-up e turno da IA gravam (o campo não congela)', async () => {
  limparCacheEsquema();
  const { estado, kommo } = cartaoFalso(143, COMERCIAL, 'Aguardando lead'); // PERDIDO, campo ainda velho
  await carimbarHumanoAssumiu(unidade, kommo, 1, 'Escalonamento');
  assert.equal(estado.statusConversa, 'Respondendo', 'handoff foi recusado e o campo congelou');
  await carimbarSemResposta(unidade, 1, kommo);
  assert.equal(estado.statusConversa, 'Sem resposta', 'follow-up foi recusado e o campo congelou');
  await gravarStatusConversa(unidade, kommo, 1, 'Aguardando lead', 'turno-da-ia');
  assert.equal(estado.statusConversa, 'Aguardando lead');
  // campo vazio num cartão encerrado também grava
  const vazio = cartaoFalso(143, COMERCIAL, null);
  await carimbarSemResposta(unidade, 1, vazio.kommo);
  assert.equal(vazio.estado.statusConversa, 'Sem resposta');
});

test('funil TRATAMENTO: ALTA (142) não é encerramento de conversa — o campo segue sendo escrito', async () => {
  limparCacheEsquema();
  const { estado, kommo } = cartaoFalso(142, TRATAMENTO, 'Aguardando lead');
  await carimbarHumanoAssumiu(unidade, kommo, 1);
  assert.equal(estado.statusConversa, 'Respondendo');
});

test('cartão que não deu para ler: grava como sempre gravou (perder o "Sem resposta" deixaria o lead parado) e avisa', async () => {
  limparCacheEsquema();
  const { estado, kommo } = cartaoFalso(ETAPA_QUALIFICACAO, COMERCIAL, 'Aguardando lead');
  estado.falhaNaLeitura = true;
  const gravou = await gravarStatusConversa(unidade, kommo, 1, 'Sem resposta', 'follow-up-sem-resposta');
  assert.equal(gravou, true);
  assert.equal(estado.statusConversa, 'Sem resposta');
});

test('etapa 143 com nome que não é PERDIDO (conta fora do padrão): vale o id, como a guarda antiga do turno da IA', async () => {
  limparCacheEsquema();
  const funis = [{ id: COMERCIAL, name: 'COMERCIAL', statuses: [{ id: ETAPA_QUALIFICACAO, name: 'EM QUALIFICAÇÃO' }, { id: 143, name: 'Venda perdida' }] }];
  const { estado, kommo } = cartaoFalso(143, COMERCIAL, 'Encerrada', funis);
  await carimbarSemResposta(unidade, 1, kommo);
  assert.equal(estado.statusConversa, 'Encerrada');
});

test('unidade SEM carimbo de etapa: ninguém grava "Encerrada", então handoff e follow-up gravam como sempre (sem leitura extra)', async () => {
  limparCacheEsquema();
  _semearParaTeste([]); // carimbo-etapa desligado
  try {
    const { estado, kommo } = cartaoFalso(143, COMERCIAL, 'Aguardando lead');
    await carimbarSemResposta(unidade, 1, kommo);
    assert.equal(estado.statusConversa, 'Sem resposta');
    await carimbarHumanoAssumiu(unidade, kommo, 1);
    assert.equal(estado.statusConversa, 'Respondendo');
    assert.equal(estado.leituras, 0, 'não leu o cartão à toa');
    // o turno da IA mantém a guarda de 142/143 que já tinha antes deste conserto
    estado.statusConversa = 'Encerrada';
    await gravarStatusConversa(unidade, kommo, 1, 'Aguardando lead', 'turno-da-ia');
    assert.equal(estado.statusConversa, 'Encerrada');
    // ...inclusive no funil TRATAMENTO (ALTA = 142): sem o carimbo, a guarda antiga por id continua igual
    const alta = cartaoFalso(142, TRATAMENTO, 'Encerrada');
    await gravarStatusConversa(unidade, alta.kommo, 1, 'Aguardando lead', 'turno-da-ia');
    assert.equal(alta.estado.statusConversa, 'Encerrada');
  } finally {
    _semearParaTeste([{ slug: 'doutor-hernia-acailandia', automacao: 'carimbo-etapa', estado: 'ligado' }]);
  }
});

test('esquema da conta que não carregou: o cartão em 143 segue protegido pelo id, e o cartão aberto grava', async () => {
  limparCacheEsquema();
  const { estado, kommo } = cartaoFalso(143, COMERCIAL, 'Encerrada');
  (kommo as { listPipelines: () => Promise<never> }).listPipelines = async () => { throw new Error('500'); };
  await gravarStatusConversa(unidade, kommo, 1, 'Respondendo', 'humano-assumiu');
  assert.equal(estado.statusConversa, 'Encerrada');
});
