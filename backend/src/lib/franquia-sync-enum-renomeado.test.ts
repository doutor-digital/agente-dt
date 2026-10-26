/**
 * 24/10/2026, Açailândia: a opção "DRA. AYLANA" do campo ⚕ Fisioterapeuta foi renomeada para "DRA. AYLANA SILVA MENDES".
 * O Kommo não reescreve o texto dos cartões, só mantém o `enum_id`. O sincronizador comparava o TEXTO do cartão com o da
 * franquia, via divergência em todo ciclo e regravava o mesmo enum a cada varredura, com `erros: 0` — 4 cartões × 4
 * varreduras por hora. A comparação passou a ser pela opção (enum_id) com o nome ATUAL dela.
 *
 * Sem rede e sem banco: Kommo falso que anota as gravações; o banco é trocado por memória (log e estado das automações,
 * todas desligadas); `funis: null` mantém a fase 2 (etapa) fora do caso.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { prisma } from './prisma.js';
import { _semearParaTeste } from './automacoes-estado.js';
import { _interno, camposDaConta, type CampoBruto, type ResumoSync } from './franquia-sync-worker.js';
import { CAMPOS_SYNC, planejarEscritas } from './franquia-sync.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import type { SpineSchedule } from '../services/spine.service.js';

// ── o banco, em memória: o logger grava em `systemLog`; as fases 1b–1e leem o estado das automações (aqui, todas desligadas) ──
for (const [nome, valor] of Object.entries({
  systemLog: { create: async () => ({}) },
  unitAutomacao: { findMany: async () => [] },
  spineLeadLink: { findFirst: async () => null, findMany: async () => [] },
})) Object.defineProperty(prisma, nome, { value: valor, configurable: true });
_semearParaTeste([]);

const ID_FISIO = 4;
const AYLANA = 1846204;
const THAIZ = 1846206;
const CAMPOS_BRUTOS: CampoBruto[] = [
  {
    id: ID_FISIO, name: '⚕ Fisioterapeuta', type: 'select',
    enums: [{ id: AYLANA, value: 'DRA. AYLANA SILVA MENDES' }, { id: THAIZ, value: 'DRA. THAIZ DE SOUSA LIMA' }],
  },
];
const MAPA = _interno.mapearCampos(CAMPOS_BRUTOS);

const unidade = { id: 'unidade-teste-enum', slug: 'doutor-hernia-acailandia' } as unknown as Unit;

function cartao(guardado: { value: string; enum_id?: number }): KommoLead {
  return { id: 18137576, name: 'PACIENTE TESTE', custom_fields_values: [{ field_id: ID_FISIO, values: [guardado] }] } as unknown as KommoLead;
}

function consulta(fisio: string, idStatus = 37): SpineSchedule {
  return {
    idSchedule: 0, idTreatment: null, idStatus, statusName: 'Agendado', clientName: 'PACIENTE TESTE', categoryName: 'AVALIAÇÃO',
    physicalTherapist: fisio, dateAttendanceUtc: '2026-10-20T13:00:00Z', dateAttendanceLocal: null, dayLocal: null, timeLocal: null, isBusy: true, requiresManualValidation: false,
  } as unknown as SpineSchedule;
}

/** Roda a fase 1 de um cartão (a mesma função da varredura) e devolve o que foi gravado. */
async function varrer(lead: KommoLead, fisioDaFranquia: string, campos: CampoBruto[] = CAMPOS_BRUTOS, idStatus = 37) {
  const gravacoes: Array<{ leadId: number; campo: number; valor: unknown }> = [];
  const kommo = {
    setLeadCustomFieldValue: async (leadId: number, campo: number, _t: string, valor: unknown) => { gravacoes.push({ leadId, campo, valor }); },
  } as unknown as KommoClient;
  const resumo: ResumoSync = { unit: unidade.slug, em: '', agendamentos: 0, tratamentos: 0, pacientes: 0, comLead: 0, semLead: 0, escritas: 0, erros: 0, exemplosSemLead: [], movimentos: 0, revisados: 0 };
  const ctx = {
    unit: unidade, kommo, funis: null, mapa: _interno.mapearCampos(campos), ops: { fisio: CAMPOS_BRUTOS[0].enums!.map((e) => e.value), categoria: [], tratamento: [] },
    agoraEpoch: Math.floor(Date.now() / 1000), resumo, camposPorNome: camposDaConta(campos),
  } as unknown as Parameters<typeof _interno.processarCartao>[0];
  await _interno.processarCartao(ctx, lead.id, lead, { nome: 'PACIENTE TESTE', idClient: null, consultas: [consulta(fisioDaFranquia, idStatus)], tratamento: null });
  return { gravacoes, resumo };
}

test('opção renomeada: mesmo enum_id, texto antigo no cartão → NENHUMA escrita, em quantas varreduras forem', async () => {
  const lead = cartao({ value: 'DRA. AYLANA', enum_id: AYLANA });
  for (let varredura = 0; varredura < 4; varredura++) {
    const { gravacoes, resumo } = await varrer(lead, 'AYLANA SILVA MENDES');
    assert.deepEqual(gravacoes, [], `varredura ${varredura + 1}: nada a gravar`);
    assert.equal(resumo.escritas, 0);
  }
});

test('opção renomeada: vale também para a outra fisioterapeuta (THAIZ)', async () => {
  const { gravacoes } = await varrer(cartao({ value: 'DRA. THAIZ', enum_id: THAIZ }), 'THAIZ DE SOUSA LIMA');
  assert.deepEqual(gravacoes, []);
});

test('opção DIFERENTE (enum_id de outra fisio): a franquia ainda vence e grava uma vez', async () => {
  const { gravacoes } = await varrer(cartao({ value: 'DRA. THAIZ DE SOUSA LIMA', enum_id: THAIZ }), 'AYLANA SILVA MENDES');
  assert.deepEqual(gravacoes, [{ leadId: 18137576, campo: ID_FISIO, valor: 'DRA. AYLANA SILVA MENDES' }]);
});

test('enum_id que não existe mais nas opções: cai no texto do cartão, como antes (sem palpite)', async () => {
  const { gravacoes } = await varrer(cartao({ value: 'DRA. AYLANA', enum_id: 999 }), 'AYLANA SILVA MENDES');
  assert.deepEqual(gravacoes, [{ leadId: 18137576, campo: ID_FISIO, valor: 'DRA. AYLANA SILVA MENDES' }], 'texto antigo e opção sumida: diverge e é regravado para o enum certo');
});

test('cartão sem enum_id (dado antigo ou fonte que só traz texto): compara pelo texto, igual a antes', async () => {
  assert.deepEqual((await varrer(cartao({ value: 'DRA. AYLANA SILVA MENDES' }), 'AYLANA SILVA MENDES')).gravacoes, []);
  assert.deepEqual((await varrer(cartao({ value: 'DRA. AYLANA' }), 'AYLANA SILVA MENDES')).gravacoes, [{ leadId: 18137576, campo: ID_FISIO, valor: 'DRA. AYLANA SILVA MENDES' }]);
  // enum_id nulo (o tipo permite): o mesmo caminho do texto, nunca Number(null) = 0
  assert.deepEqual((await varrer(cartao({ value: 'DRA. AYLANA SILVA MENDES', enum_id: null as unknown as number }), 'AYLANA SILVA MENDES')).gravacoes, []);
});

test('valoresDoLead devolve o nome ATUAL da opção guardada; campo que não é lista segue pelo texto', () => {
  const v = _interno.valoresDoLead(cartao({ value: 'DRA. AYLANA', enum_id: AYLANA }), MAPA);
  assert.equal(v[CAMPOS_SYNC.FISIO], 'DRA. AYLANA SILVA MENDES');
  // o planejador (puro) com esse valor não propõe nada
  const w = planejarEscritas({
    valores: v, consulta: consulta('AYLANA SILVA MENDES'), consultaEpoch: null, tratamento: null, feitoPelaIa: false, agoraEpoch: 0,
    opcoes: { fisio: ['DRA. AYLANA SILVA MENDES', 'DRA. THAIZ DE SOUSA LIMA'], categoria: [], tratamento: [] },
  });
  assert.ok(!w.some((x) => x.campo === 'FISIO'));
});

test('radiobutton lê pela opção guardada, igual ao select', () => {
  const mapa = _interno.mapearCampos([{ id: 7, name: '✓ Situação da consulta', type: 'radiobutton', enums: [{ id: 70, value: 'Atendido' }] }]);
  const lead = { id: 1, custom_fields_values: [{ field_id: 7, values: [{ value: 'Atendido (antigo)', enum_id: 70 }] }] } as unknown as KommoLead;
  assert.equal(_interno.valoresDoLead(lead, mapa)[CAMPOS_SYNC.SITUACAO], 'Atendido');
});

// ── a trava "a opção existe nesta conta" (literais do código: 'Atendido', 'Sim', 'Não'…) ──
const ID_SITUACAO = 5;
const SPINE_ATENDIDO = 42;
const conta = (rotuloAtendido: string): CampoBruto[] => [
  ...CAMPOS_BRUTOS,
  { id: ID_SITUACAO, name: '✓ Situação da consulta', type: 'select', enums: [{ id: 50, value: 'Agendado' }, { id: 51, value: rotuloAtendido }] },
];
const cartaoAtendido = (value: string) =>
  ({ id: 18137576, name: 'PACIENTE TESTE', custom_fields_values: [
    { field_id: ID_FISIO, values: [{ value: 'DRA. AYLANA SILVA MENDES', enum_id: AYLANA }] },
    { field_id: ID_SITUACAO, values: [{ value, enum_id: 51 }] },
  ] }) as unknown as KommoLead;

test('conta com "Atendido(a)": o literal "Atendido" não existe lá — não grava, não dá 400, e conta como opção ausente', async () => {
  const { gravacoes, resumo } = await varrer(cartaoAtendido('Atendido(a)'), 'AYLANA SILVA MENDES', conta('Atendido(a)'), SPINE_ATENDIDO);
  assert.deepEqual(gravacoes, [], 'nada de PATCH {value:"Atendido"} a cada varredura');
  assert.equal(resumo.erros, 0);
  assert.equal(resumo.opcoesAusentes, 1, 'a trava aparece no resumo da varredura (não fica invisível)');
});

test('conta com "Atendido": a situação que já é a do cartão não é regravada; a que muda é gravada pela opção certa', async () => {
  const igual = await varrer(cartaoAtendido('Atendido'), 'AYLANA SILVA MENDES', conta('Atendido'), SPINE_ATENDIDO);
  assert.deepEqual(igual.gravacoes, []);
  assert.equal(igual.resumo.opcoesAusentes, undefined);
  // o cartão está em "Agendado" (enum 50) e a franquia diz "Atendido": grava
  const lead = { id: 18137576, custom_fields_values: [{ field_id: ID_FISIO, values: [{ value: 'DRA. AYLANA SILVA MENDES', enum_id: AYLANA }] }, { field_id: ID_SITUACAO, values: [{ value: 'Agendado', enum_id: 50 }] }] } as unknown as KommoLead;
  const muda = await varrer(lead, 'AYLANA SILVA MENDES', conta('Atendido'), SPINE_ATENDIDO);
  assert.deepEqual(muda.gravacoes, [{ leadId: 18137576, campo: ID_SITUACAO, valor: 'Atendido' }]);
});
