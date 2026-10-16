import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { webhookSchema } from './webhook.controller.js';
import { listaDoKommo } from '../lib/kommo-webhook-lista.js';
import { aplicarCarimbosDeEtapa, CAMPOS_CARIMBO } from '../lib/carimbo-etapa.js';
import { montarEsquema } from '../lib/kommo-schema.js';
import { _semearParaTeste } from '../lib/automacoes-estado.js';

before(() => _semearParaTeste([]));

/**
 * Carimbo de etapa na Açailândia (decisão do João, 16/10/2026): o evento `status_lead` passa a chegar no webhook
 * do agente. O corpo vem como o Express entrega um form-urlencoded do Kommo — `leads[status][0][id]=…` vira
 * `{ leads: { status: [ {…} ] } }` — e, com mais de 20 cartões no mesmo webhook, `status` vira OBJETO.
 */

const SLUG = 'doutor-hernia-acailandia';
const unidade = { id: 'u1', slug: SLUG, kommoSubdomain: 'doutorherniaacailandia', kommoAccessToken: 'x' } as Unit;

const esquema = montarEsquema(
  [
    { id: 501, name: CAMPOS_CARIMBO.INICIO_TRAT },
    { id: 502, name: CAMPOS_CARIMBO.FIM_TRAT },
    { id: 503, name: CAMPOS_CARIMBO.STATUS_CONVERSA },
  ],
  [
    { id: 1, name: 'COMERCIAL', statuses: [{ id: 11, name: 'AGENDADO' }, { id: 142, name: 'GANHO / CONCLUÍDO' }, { id: 143, name: 'PERDIDO' }] },
    { id: 2, name: 'TRATAMENTO', statuses: [{ id: 21, name: 'EM TRATAMENTO' }, { id: 142, name: 'ALTA' }, { id: 143, name: 'TRATAMENTO CANCELADO' }] },
  ],
);

function kommoFalso(preenchidos: Record<number, Record<number, unknown>> = {}) {
  const gravados: Array<{ leadId: number; fieldId: number; tipo: string; valor: unknown }> = [];
  return {
    gravados,
    kommo: {
      getLead: async (id: number) => ({
        id,
        name: 'x',
        status_id: 0,
        pipeline_id: 0,
        custom_fields_values: Object.entries(preenchidos[id] ?? {}).map(([f, v]) => ({ field_id: Number(f), values: [{ value: v }] })),
      }),
      setLeadCustomFieldValue: async (leadId: number, fieldId: number, tipo: string, valor: unknown) => {
        gravados.push({ leadId, fieldId, tipo, valor });
      },
    } as never,
  };
}

test('status_lead típico do Kommo (form-urlencoded já parseado) passa no schema', () => {
  const corpo = {
    account: { id: '36636699', subdomain: 'doutorherniaacailandia' },
    leads: {
      status: [{ id: '28691582', status_id: '21', pipeline_id: '2', old_status_id: '142', old_pipeline_id: '1', name: 'MARIA', custom_fields: [] }],
    },
  };
  const p = webhookSchema.safeParse(corpo);
  assert.equal(p.success, true);
  assert.deepEqual(p.success && p.data.leads?.status, [{ id: 28691582, status_id: 21, pipeline_id: 2, old_status_id: 142 }]);
});

test('mais de 20 cartões no mesmo webhook (o qs entrega OBJETO): não volta 400, vira lista na ordem', () => {
  const status: Record<string, unknown> = {};
  for (let i = 0; i < 25; i++) status[String(i)] = { id: String(1000 + i), status_id: '143', pipeline_id: '1' };
  const p = webhookSchema.safeParse({ leads: { status } });
  assert.equal(p.success, true);
  const lista = p.success ? p.data.leads?.status ?? [] : [];
  assert.equal(lista.length, 25);
  assert.equal(lista[0].id, 1000);
  assert.equal(lista[24].id, 1024);
});

test('listaDoKommo: array e vazio passam; objeto numérico vira array; item sem índice vira lista de um', () => {
  assert.deepEqual(listaDoKommo([1, 2]), [1, 2]);
  assert.equal(listaDoKommo(undefined), undefined);
  assert.deepEqual(listaDoKommo({ '10': 'b', '2': 'a' }), ['a', 'b']);
  assert.deepEqual(listaDoKommo({ id: '5' }), [{ id: '5' }]);
});

test('o evento chegando: EM TRATAMENTO carimba o início (só se vazio); PERDIDO encerra a conversa', async () => {
  const { kommo, gravados } = kommoFalso({ 2: { 501: 1_780_000_000 } });
  const n = await aplicarCarimbosDeEtapa(
    unidade,
    [
      { id: 1, status_id: 21, pipeline_id: 2 }, // EM TRATAMENTO, campo vazio → grava
      { id: 2, status_id: 21, pipeline_id: 2 }, // EM TRATAMENTO, já preenchido pelo sincronizador → mantém
      { id: 3, status_id: 143, pipeline_id: 1 }, // PERDIDO (funil COMERCIAL) → Encerrada
      { id: 4, status_id: 143, pipeline_id: 2 }, // TRATAMENTO CANCELADO (mesmo 143, outro funil) → fim do tratamento
      { id: 5, status_id: 11, pipeline_id: 1 }, // AGENDADO → nada
    ],
    { kommo, esquema, agora: 1_790_000_000, raw: SLUG },
  );
  assert.equal(n, 3);
  assert.deepEqual(gravados, [
    { leadId: 1, fieldId: 501, tipo: 'date', valor: 1_790_000_000 },
    { leadId: 3, fieldId: 503, tipo: 'select', valor: 'Encerrada' },
    { leadId: 4, fieldId: 502, tipo: 'date', valor: 1_790_000_000 },
  ]);
});

test('chave carimbo-etapa desligada na unidade: o evento chega e nada é gravado', async () => {
  const { kommo, gravados } = kommoFalso();
  const n = await aplicarCarimbosDeEtapa(unidade, [{ id: 1, status_id: 21, pipeline_id: 2 }], { kommo, esquema, raw: '' });
  assert.equal(n, 0);
  assert.equal(gravados.length, 0);
});
