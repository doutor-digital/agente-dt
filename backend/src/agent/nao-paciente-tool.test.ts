/**
 * Candidato a vaga: a regra está no prompt de TODA unidade e a ferramenta está montada e faz o serviço (04/11/2026).
 * A decisão "é candidato ou paciente que fala do trabalho dele" é do modelo, e a prova dela só sai da rodada de eval
 * (banco: curriculo-sai-do-funil e paciente-que-trabalha-em-laboratorio-nao-e-candidato). Aqui se prende o que o código garante.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { KommoClient } from '../services/kommo.service.js';
import type { TraceRecorder } from './trace-recorder.js';
import { buildTools } from './tools.js';
import { composeFlattenedPrompt, composeSystemPrompt, composeSystemPromptParts, renderNaoPaciente } from './prompt-composer.js';
import { _limparPausasProprias, pausouSozinhaDesde } from '../lib/pausa-propria.js';

logger.warn = (() => undefined) as never;
logger.error = (() => undefined) as never;

Object.defineProperty(prisma, 'conversation', {
  value: { updateMany: async () => ({ count: 1 }), findFirst: async () => null },
  configurable: true,
});

let escritas: string[] = [];
let movido: { statusId: number; pipelineId: number; campos?: unknown } | null = null;
beforeEach(() => {
  escritas = [];
  movido = null;
  _limparPausasProprias();
});

const kommo = {
  getLead: async (id: number) => ({ id, name: 'Joana', status_id: 1, pipeline_id: 100, _embedded: { tags: [] }, custom_fields_values: [] }),
  listPipelines: async () => [{ id: 100, name: 'COMERCIAL', is_main: true, statuses: [{ id: 143, name: 'PERDIDO' }] }],
  listLeadCustomFieldsTyped: async () => [
    { id: 7, name: '⊘ Motivo do não agendamento', type: 'select', code: null, enums: [{ id: 55, value: 'Não é paciente (currículo)' }] },
  ],
  listLeadTags: async () => [{ id: 1, name: 'NO_FOLLOW_UP' }],
  addTag: async () => {
    escritas.push('tag');
  },
  tagsDoLead: async () => ['CURRÍCULO', 'NO_FOLLOW_UP'],
  setLeadFieldFlag: async () => {
    escritas.push('pausa');
  },
  moverCartao: async (_id: number, p: { statusId: number; pipelineId: number; campos?: unknown }) => {
    escritas.push('mover');
    movido = p;
  },
  addLeadNote: async () => ({ id: 1 }),
  createTask: async () => ({ id: 1 }),
} as unknown as KommoClient;
const recorder = { step: async () => undefined } as unknown as TraceRecorder;

const unit = { id: 'u1', slug: 'doutor-hernia-teste', kommoSubdomain: 'teste', spineEnabled: false } as unknown as Unit;

test('a ferramenta existe, aceita só tipo "curriculo" e faz tudo; a resposta deste turno não é jogada fora (UMA frase)', async () => {
  const tools = buildTools({ recorder, kommo, pausedFieldId: 5, unit });
  const t = tools.find((x) => x.name === 'marcar_nao_paciente');
  assert.ok(t, 'marcar_nao_paciente não foi montada');
  const out = String(await (t as unknown as { invoke: (a: unknown) => Promise<unknown> }).invoke({ leadId: 42, tipo: 'curriculo' }));
  assert.match(out, /^OK/);
  assert.match(out, /UMA frase só/);
  assert.deepEqual(escritas, ['tag', 'pausa', 'mover']);
  assert.deepEqual(movido, { statusId: 143, pipelineId: 100, campos: [{ field_id: 7, values: [{ enum_id: 55 }] }] });
  assert.ok(pausouSozinhaDesde(unit, 42, Date.now() - 1000));
  await assert.rejects(() => (t as unknown as { invoke: (a: unknown) => Promise<unknown> }).invoke({ leadId: 42, tipo: 'fornecedor' }), 'só currículo entra nesta regra');
});

test('a regra está no prompt de TODA unidade: modo normal, modo cacheado e prompt inteiro da unidade', () => {
  const normal = unit;
  const unico = { ...unit, singlePromptMode: true, systemPrompt: 'Prompt inteiro escrito à mão.' } as unknown as Unit;
  for (const u of [normal, unico]) {
    assert.match(composeSystemPrompt({ unit: u }), /<nao_paciente>/);
    assert.match(composeSystemPromptParts({ unit: u }).cacheable, /<nao_paciente>/);
  }
  assert.match(composeFlattenedPrompt({ unit: normal }), /<nao_paciente>/);
});

test('o texto da regra: chama a ferramenta, UMA frase, exceção da pergunta final, e NÃO dispara para paciente que cita o trabalho', () => {
  const r = renderNaoPaciente();
  assert.match(r, /marcar_nao_paciente\(\{ tipo: "curriculo" \}\)/);
  assert.match(r, /UMA frase só/);
  assert.match(r, /exceção à regra da pergunta final/);
  assert.match(r, /recrutamento é tratado direto pela equipe da clínica/);
  assert.match(r, /trabalho em laboratório/);
  assert.match(r, /RECUSADO/);
  // fornecedor e propaganda ficam como estão
  assert.match(r, /Fornecedor, agência, propaganda e funcionário/);
});

test('juiz da pergunta final: candidato marcado neste turno não é reescrito em venda; RECUSADO e turno de paciente seguem a regra de sempre', async () => {
  const { HumanMessage, AIMessage, ToolMessage } = await import('@langchain/core/messages');
  const { marcouCandidatoNoTurno } = await import('./repeticao.js');
  const chamada = new AIMessage({ content: '', tool_calls: [{ id: 'c1', name: 'marcar_nao_paciente', args: { tipo: 'curriculo' } }] });
  const ok = new ToolMessage({ content: 'OK — candidato marcado: etiqueta, motivo e PERDIDO aplicados.', tool_call_id: 'c1', name: 'marcar_nao_paciente' });
  const recusado = new ToolMessage({ content: 'RECUSADO: este cartão está com «consulta futura no cartão».', tool_call_id: 'c1', name: 'marcar_nao_paciente' });
  const parcial = new ToolMessage({ content: 'PARCIAL — a equipe vai terminar a marcação à mão.', tool_call_id: 'c1', name: 'marcar_nao_paciente' });
  const velha = [new HumanMessage('mando o currículo'), chamada, ok, new AIMessage('Obrigada!'), new HumanMessage('e quanto custa a consulta?')];

  assert.equal(marcouCandidatoNoTurno([new HumanMessage('oi'), chamada, ok]), true);
  assert.equal(marcouCandidatoNoTurno([new HumanMessage('oi'), chamada, parcial]), true);
  assert.equal(marcouCandidatoNoTurno([new HumanMessage('oi'), chamada, recusado]), false);
  assert.equal(marcouCandidatoNoTurno(velha), false, 'a marcação de um turno anterior não vale para o turno de agora');
});
