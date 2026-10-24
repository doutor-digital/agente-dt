import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { cartaoEncerrado, decidirStatusConversa, etapaEncerraConversa } from './status-conversa.js';
import { aplicarCarimbosDeEtapa, CAMPOS_CARIMBO } from './carimbo-etapa.js';
import { limparCacheEsquema, montarEsquema } from './kommo-schema.js';
import { regraPara } from './follow-up-worker.js';
import { _semearParaTeste } from './automacoes-estado.js';
import { _semearCrmParaTeste } from './crm-compartilhado.js';
import { carimbarHumanoAssumiu, carimbarSemResposta, CAMPOS_DIGITAL, gravarStatusConversa } from '../services/lead-metrics.service.js';

/**
 * "⬢ Status da conversa": o "Encerrada" que o carimbo de etapa grava em PERDIDO não pode ser desfeito pelos
 * outros escritores (follow-up, IA, handoff). Caso real: Açailândia, 24/10/2026 — leads 29017216, 29020564,
 * 29020582 (follow-up → "Sem resposta") e 29027086, 29027778 (handoff → "Respondendo").
 */

before(() => {
  _semearParaTeste([]);
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
function cartaoFalso(statusId: number, pipelineId: number, statusConversa: string | null) {
  const estado = { status_id: statusId, pipeline_id: pipelineId, statusConversa, leituras: 0, falhaNaLeitura: false };
  const kommo = {
    listLeadCustomFields: async () => ({ _embedded: { custom_fields: CAMPOS } }),
    listPipelines: async () => FUNIS,
    getLead: async (id: number) => {
      estado.leituras++;
      if (estado.falhaNaLeitura) throw new Error('429');
      return { id, name: 'x', status_id: estado.status_id, pipeline_id: estado.pipeline_id, custom_fields_values: [] };
    },
    setLeadCustomFieldValue: async (_leadId: number, fieldId: number, _tipo: string, valor: unknown) => {
      if (fieldId === ID_STATUS_CONVERSA) estado.statusConversa = String(valor);
    },
  };
  return { estado, kommo: kommo as never };
}

test('só o carimbo de etapa escreve "Encerrada"; qualquer outro valor respeita cartão encerrado', () => {
  assert.deepEqual(decidirStatusConversa('Encerrada', true), { gravar: true });
  assert.deepEqual(decidirStatusConversa('Encerrada', false), { gravar: true });
  for (const v of ['Sem resposta', 'Respondendo', 'Aguardando lead'] as const) {
    assert.equal(decidirStatusConversa(v, false).gravar, true, `${v} em cartão aberto`);
    assert.equal(decidirStatusConversa(v, true).gravar, false, `${v} em cartão encerrado`);
  }
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

test('funil TRATAMENTO: ALTA (142) não é encerramento de conversa — o campo segue sendo escrito', async () => {
  limparCacheEsquema();
  const { estado, kommo } = cartaoFalso(142, TRATAMENTO, 'Aguardando lead');
  await carimbarHumanoAssumiu(unidade, kommo, 1);
  assert.equal(estado.statusConversa, 'Respondendo');
});

test('cartão que não deu para ler: não grava às cegas', async () => {
  limparCacheEsquema();
  const { estado, kommo } = cartaoFalso(143, COMERCIAL, 'Encerrada');
  estado.falhaNaLeitura = true;
  const gravou = await gravarStatusConversa(unidade, kommo, 1, 'Sem resposta', 'follow-up-sem-resposta');
  assert.equal(gravou, false);
  assert.equal(estado.statusConversa, 'Encerrada');
});

test('quem já leu o cartão passa o lead e não paga uma segunda leitura', async () => {
  limparCacheEsquema();
  const { estado, kommo } = cartaoFalso(ETAPA_QUALIFICACAO, COMERCIAL, null);
  await gravarStatusConversa(unidade, kommo, 1, 'Respondendo', 'humano-assumiu', { status_id: ETAPA_QUALIFICACAO, pipeline_id: COMERCIAL });
  assert.equal(estado.leituras, 0);
  assert.equal(estado.statusConversa, 'Respondendo');
});

/**
 * A régua de follow-up para PERDIDO é política do João (30 regras LIGADAS em 15 unidades, "escada definida pelo João"
 * para "Não interagiu" e "Não deu continuidade"). Este PR NÃO a muda — o teste trava o que vale hoje, para uma mudança
 * futura ser deliberada e não acidental: PERDIDO só recebe follow-up com regra (etapa 143 + motivo) cadastrada.
 */
test('follow-up em PERDIDO: só com regra cadastrada para o motivo de perda (política atual, a confirmar)', () => {
  const DEGRAU = [{ aposMin: 5, intencao: 'x' }];
  const regras = [{ statusId: 143, lossReasonId: 38401647, steps: DEGRAU }];
  const estado = (lossReasonId: number | null) => ({
    statusId: 143, lossReasonId, pausada: false, pagouAntecipado: false, titulo: null,
  });
  assert.notEqual(regraPara(regras, estado(38401647)), null, 'Não interagiu tem a escada do João');
  assert.equal(regraPara(regras, estado(38401655)), null, 'motivo sem regra não recebe');
  assert.equal(regraPara(regras, estado(null)), null, 'PERDIDO sem motivo não recebe');
});
