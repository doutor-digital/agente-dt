/**
 * Candidato a vaga sai do funil de pacientes (decisão do João, 04/11/2026). Tudo aqui roda contra um Kommo de mentira
 * que anota CADA escrita na ordem em que acontece — a ordem é parte do contrato (etiqueta antes de PERDIDO).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import { ETIQUETA_CURRICULO, marcarNaoPaciente, textoParaOModelo, type ResultadoNaoPaciente } from './nao-paciente.js';
import { _limparPausasProprias, pausouSozinhaDesde } from './pausa-propria.js';

let escritas: string[] = [];
let cartao: KommoLead & { custom_fields_values?: unknown };
let falhar: Partial<Record<'addTag' | 'mover' | 'pausa' | 'campos', boolean>> = {};
let movimentos: Array<{ leadId: number; statusId: number; pipelineId: number; campos?: unknown }> = [];
let etiquetasGravadas: string[] = [];
let tarefas: string[] = [];
let notas: string[] = [];
let paradas: Array<{ where: unknown; data: unknown }> = [];
let avisos: string[] = [];

// Duas contas: o id da OPÇÃO é diferente em cada uma, e a conta do Salto não tem a opção.
const CAMPO_MOTIVO_ID = 777;
type Conta = { opcoes: Array<{ id: number; value: string }> | null; campo: boolean };
let conta: Conta = { campo: true, opcoes: [{ id: 11, value: 'Sem interesse' }, { id: 4242, value: 'Não é paciente (currículo)' }] };

const PIPES = [
  { id: 100, name: 'COMERCIAL', is_main: true, statuses: [{ id: 1, name: 'EM QUALIFICAÇÃO' }, { id: 142, name: 'GANHO' }, { id: 143, name: 'PERDIDO' }] },
  { id: 200, name: 'TRATAMENTO', statuses: [{ id: 2, name: 'EM TRATAMENTO' }, { id: 142, name: 'ALTA' }, { id: 143, name: 'TRATAMENTO CANCELADO' }] },
  { id: 300, name: 'RESGATE', statuses: [{ id: 3, name: 'RESGATE 1' }, { id: 142, name: 'GANHO' }, { id: 143, name: 'PERDIDO' }] },
];

const cartaoNovo = (over: Record<string, unknown> = {}) =>
  ({ id: 42, name: 'Maria 04/11/2026', status_id: 1, pipeline_id: 100, responsible_user_id: 9, _embedded: { tags: [] }, custom_fields_values: [], ...over }) as never;

beforeEach(() => {
  escritas = [];
  movimentos = [];
  etiquetasGravadas = [];
  tarefas = [];
  notas = [];
  paradas = [];
  avisos = [];
  falhar = {};
  cartao = cartaoNovo();
  conta = { campo: true, opcoes: [{ id: 11, value: 'Sem interesse' }, { id: 4242, value: 'Não é paciente (currículo)' }] };
  _limparPausasProprias();
});

Object.defineProperty(prisma, 'conversation', {
  value: {
    updateMany: async (a: { where: unknown; data: unknown }) => {
      escritas.push('followUp');
      paradas.push(a);
      return { count: 1 };
    },
  },
  configurable: true,
});

// logger.warn/error gravam em system_logs (banco): troca por captura, o teste não fala com banco nenhum.
const capturar = ((...a: unknown[]) => {
  avisos.push(JSON.stringify(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))));
}) as never;
logger.warn = capturar;
logger.error = capturar;

const kommo = {
  getLead: async () => cartao,
  listPipelines: async () => PIPES,
  listLeadCustomFieldsTyped: async () => [
    ...(conta.campo
      ? [{ id: CAMPO_MOTIVO_ID, name: '⊘ Motivo do não agendamento', type: 'select', code: null, enums: conta.opcoes ?? [] }]
      : []),
    { id: 5, name: 'Pausar IA', type: 'checkbox', code: null, enums: [] },
  ],
  listLeadTags: async () => [{ id: 1, name: 'NO_FOLLOW_UP' }, { id: 2, name: 'Quente' }],
  addTag: async (p: { tags?: string[] }) => {
    if (falhar.addTag) throw new Error('Kommo fora do ar');
    escritas.push('addTag');
    etiquetasGravadas.push(...(p.tags ?? []));
  },
  tagsDoLead: async () => etiquetasGravadas,
  setLeadFieldFlag: async () => {
    if (falhar.pausa) throw new Error('Kommo fora do ar');
    escritas.push('pausa');
  },
  isLeadFieldChecked: async () => false,
  moverCartao: async (leadId: number, p: { statusId: number; pipelineId: number; campos?: unknown }) => {
    if (falhar.mover) throw new Error('400 required field');
    escritas.push('mover');
    movimentos.push({ leadId, ...p });
  },
  gravarCamposDoLead: async (_id: number, campos: unknown) => {
    if (falhar.campos) throw new Error('Kommo recusou');
    escritas.push('campos');
    movimentos.push({ leadId: 42, statusId: -1, pipelineId: -1, campos });
  },
  addLeadNote: async (_id: number, t: string) => {
    notas.push(t);
    return { id: 1 };
  },
  createTask: async (t: { text: string }) => {
    tarefas.push(t.text);
    return { id: 1 };
  },
} as unknown as KommoClient;

const unit = { id: 'u1', slug: 'doutor-hernia-teste' } as Pick<Unit, 'id' | 'slug'>;
const marcar = (over: Partial<Parameters<typeof marcarNaoPaciente>[0]> = {}) =>
  marcarNaoPaciente({ unit, kommo, leadId: 42, tipo: 'curriculo', pausedFieldId: 5, ...over });

test('candidato: etiqueta CURRÍCULO + não-contatar ANTES de PERDIDO, motivo pelo NOME da opção, PERDIDO do COMERCIAL, IA pausada, follow-up parado', async () => {
  const r = await marcar();
  assert.equal(r.desfecho, 'feito');
  // ordem: etiquetas → pausa → follow-up → movimento (a régua de PERDIDO lê a etiqueta no evento)
  assert.deepEqual(escritas, ['addTag', 'pausa', 'followUp', 'mover']);
  assert.deepEqual(etiquetasGravadas, [ETIQUETA_CURRICULO, 'NO_FOLLOW_UP']);
  assert.equal(movimentos.length, 1);
  assert.equal(movimentos[0].statusId, 143);
  assert.equal(movimentos[0].pipelineId, 100, 'o COMERCIAL da conta');
  // o motivo vai no MESMO patch, com o id da opção desta conta (4242), não um id fixo
  assert.deepEqual(movimentos[0].campos, [{ field_id: CAMPO_MOTIVO_ID, values: [{ enum_id: 4242 }] }]);
  assert.equal(r.motivo, 'gravado');
  assert.ok(r.pausada && r.movido && r.etiquetas);
  assert.deepEqual((paradas[0].data as { followUpStoppedReason: string }).followUpStoppedReason, 'não é paciente (currículo)');
  assert.ok(pausouSozinhaDesde(unit as never, 42, Date.now() - 1000), 'a resposta deste turno não pode ser jogada fora pela trava de pausa');
  assert.match(notas[0], /Candidato a vaga/);
});

test('o id da opção muda por conta: outra conta, outro enum_id', async () => {
  conta = { campo: true, opcoes: [{ id: 9001, value: 'Não é paciente (currículo)' }] };
  await marcar();
  assert.deepEqual(movimentos[0].campos, [{ field_id: CAMPO_MOTIVO_ID, values: [{ enum_id: 9001 }] }]);
});

test('cartão em OUTRO funil (RESGATE): é terreno de paciente recuperado, RECUSADO e nada é escrito', async () => {
  cartao = cartaoNovo({ pipeline_id: 300, status_id: 3 });
  const r = await marcar();
  assert.equal(r.desfecho, 'recusado');
  assert.match(r.recusa ?? '', /não está no funil COMERCIAL/);
  assert.deepEqual(escritas, []);
});

test('o PERDIDO é do COMERCIAL pelo funil principal; o 143 do TRATAMENTO (TRATAMENTO CANCELADO) nunca é alvo', async () => {
  await marcar();
  assert.equal(movimentos[0].pipelineId, 100);
  assert.notEqual(movimentos[0].pipelineId, 200);
});

test('texto para o modelo: UMA frase, sem pergunta, sem prometer', async () => {
  const t = textoParaOModelo(await marcar());
  assert.match(t, /^OK/);
  assert.match(t, /UMA frase só/);
  assert.match(t, /Sem pergunta no fim/);
});

test('conta SEM a opção: não grava outro motivo no lugar, loga, e ainda tira o candidato do funil', async () => {
  conta = { campo: true, opcoes: [{ id: 11, value: 'Sem interesse' }, { id: 12, value: 'Outra cidade' }] };
  const r = await marcar();
  assert.equal(r.motivo, 'sem_opcao');
  assert.equal(r.movido, true);
  assert.equal(movimentos[0].campos, undefined, 'nenhum motivo gravado, nem "Sem interesse"');
  assert.equal(r.desfecho, 'parcial');
  assert.ok(avisos.some((a) => /não tem a opção/.test(a)), 'tem que logar');
  assert.match(notas[0], /SEM motivo gravado/);
  assert.match(textoParaOModelo(r), /^PARCIAL/);
  assert.match(textoParaOModelo(r), /não conte isso ao candidato/);
});

test('conta SEM o campo do motivo: não grava nada de motivo e loga', async () => {
  conta = { campo: false, opcoes: null };
  const r = await marcar();
  assert.equal(r.motivo, 'sem_campo');
  assert.equal(movimentos[0].campos, undefined);
  assert.ok(avisos.some((a) => /não tem o campo/.test(a)));
});

test('paciente com consulta futura no cartão: RECUSADO, nada é escrito', async () => {
  const amanha = Math.floor(Date.now() / 1000) + 86_400;
  cartao = cartaoNovo({
    custom_fields_values: [
      { field_name: '◷ Data da Consulta', values: [{ value: amanha }] },
      { field_name: '✓ Situação da consulta', values: [{ value: 'Agendado' }] },
    ],
  });
  const r = await marcar();
  assert.equal(r.desfecho, 'recusado');
  assert.deepEqual(escritas, []);
  assert.match(textoParaOModelo(r), /^RECUSADO/);
});

test('paciente que pagou o antecipado: RECUSADO', async () => {
  cartao = cartaoNovo({ _embedded: { tags: [{ id: 1, name: '$ · Pagou antecipado' }] } });
  const r = await marcar();
  assert.equal(r.desfecho, 'recusado');
  assert.deepEqual(escritas, []);
});

test('cartão no funil TRATAMENTO ou em GANHO é paciente: RECUSADO', async () => {
  cartao = cartaoNovo({ pipeline_id: 200, status_id: 2 });
  assert.equal((await marcar()).desfecho, 'recusado');
  cartao = cartaoNovo({ pipeline_id: 100, status_id: 142 });
  assert.equal((await marcar()).desfecho, 'recusado');
  assert.deepEqual(escritas, []);
});

test('não consegui ler o cartão: não escreve nada e o modelo ouve ERRO, não RECUSADO', async () => {
  const antes = kommo.getLead;
  (kommo as unknown as { getLead: () => Promise<never> }).getLead = async () => {
    throw new Error('timeout');
  };
  try {
    const r = await marcar();
    assert.equal(r.desfecho, 'erro', 'falha de leitura NÃO é "é paciente"');
    assert.deepEqual(escritas, []);
    assert.match(textoParaOModelo(r), /^ERRO/);
    assert.doesNotMatch(textoParaOModelo(r), /RECUSADO/);
  } finally {
    (kommo as unknown as { getLead: unknown }).getLead = antes;
  }
});

test('etiqueta não entrou: o cartão NÃO anda (PERDIDO sem a etiqueta dispara a régua de recuperação), mas a IA para e a equipe recebe tarefa', async () => {
  falhar.addTag = true;
  const r = await marcar();
  assert.equal(r.movido, false);
  assert.equal(r.etiquetas, false);
  assert.equal(r.pausada, true);
  assert.equal(r.desfecho, 'parcial');
  assert.deepEqual(movimentos, []);
  assert.equal(tarefas.length, 1);
  assert.match(tarefas[0], /Mova à mão/);
});

test('o Kommo recusa o PERDIDO (campo obrigatório): relata, abre tarefa, IA pausada, motivo não conta como gravado', async () => {
  falhar.mover = true;
  const r = await marcar();
  assert.equal(r.movido, false);
  assert.equal(r.motivo, 'nao_gravou');
  assert.equal(r.pausada, true);
  assert.equal(tarefas.length, 1);
  assert.ok(r.falhas.some((f) => /PERDIDO/.test(f)));
});

test('unidade sem o campo «Pausar IA»: tudo o mais acontece e a falha é dita', async () => {
  const r = await marcar({ pausedFieldId: null });
  assert.equal(r.pausada, false);
  assert.equal(r.movido, true);
  assert.equal(r.desfecho, 'parcial');
  assert.match(textoParaOModelo(r), /a pausa da IA/);
});

test('a pausa falhou e a leitura confirma que não pausou: esquece a marca (o próximo turno responde)', async () => {
  falhar.pausa = true;
  const r = await marcar();
  assert.equal(r.pausada, false);
  assert.equal(pausouSozinhaDesde(unit as never, 42, Date.now() - 1000), false);
});

test('chamar duas vezes no mesmo turno: a segunda não escreve etiqueta nem move de novo', async () => {
  cartao = cartaoNovo({ status_id: 143, _embedded: { tags: [{ id: 1, name: 'CURRÍCULO' }] } });
  const r: ResultadoNaoPaciente = await marcar();
  assert.equal(r.desfecho, 'ja_estava');
  assert.deepEqual(escritas, ['pausa', 'followUp']);
  assert.deepEqual(movimentos, []);
});

test('já em PERDIDO, sem etiqueta, e a etiqueta falha: o motivo NÃO consta como gravado (nada foi escrito)', async () => {
  cartao = cartaoNovo({ status_id: 143 });
  falhar.addTag = true;
  const r = await marcar();
  assert.equal(r.etiquetas, false);
  assert.notEqual(r.motivo, 'gravado');
  assert.ok(!escritas.includes('campos'));
  assert.ok(!notas[0].includes('motivo «Não é paciente'), 'a nota não pode afirmar o que não foi feito');
  assert.match(textoParaOModelo(r), /o motivo/);
});

test('o atalho de "já estava marcado" também para a escada de follow-up', async () => {
  cartao = cartaoNovo({ status_id: 143, _embedded: { tags: [{ id: 1, name: 'CURRÍCULO' }] } });
  await marcar();
  assert.deepEqual(escritas, ['pausa', 'followUp']);
});

test('já marcado, mas a IA não pôde ser pausada: parcial, tarefa para a equipe, e o modelo NÃO ouve "segue pausada"', async () => {
  cartao = cartaoNovo({ status_id: 143, _embedded: { tags: [{ id: 1, name: 'CURRÍCULO' }] } });
  const r = await marcar({ pausedFieldId: null });
  assert.equal(r.desfecho, 'parcial');
  assert.equal(tarefas.length, 1);
  assert.doesNotMatch(textoParaOModelo(r), /segue pausada/);
  assert.doesNotMatch(textoParaOModelo(r), /a mudança para PERDIDO/, 'já estava em PERDIDO: não faltou isso');
});

test('já estava em PERDIDO (a equipe fechou) mas sem etiqueta: etiqueta + motivo, sem mover; motivo da equipe fica', async () => {
  cartao = cartaoNovo({ status_id: 143 });
  let r = await marcar();
  assert.equal(r.movido, false);
  assert.equal(r.motivo, 'gravado');
  assert.deepEqual(escritas, ['addTag', 'pausa', 'followUp', 'campos']);
  assert.equal(r.desfecho, 'feito');

  escritas = [];
  cartao = cartaoNovo({ status_id: 143, custom_fields_values: [{ field_name: '⊘ Motivo do não agendamento', values: [{ value: 'Sem interesse' }] }] });
  r = await marcar();
  assert.equal(r.motivo, 'mantido_da_equipe');
  assert.ok(!escritas.includes('campos'));
});
