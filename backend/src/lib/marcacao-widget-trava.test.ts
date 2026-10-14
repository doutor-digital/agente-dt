/**
 * "Marcar consulta" do widget × trava da unidade de atendimento (14/10/2026).
 *
 * A conta de Petrópolis atende Petrópolis e Caxias, mas só tem o token da franquia de Petrópolis: cartão de
 * Caxias, ou sem cidade, tem de ser recusado ANTES de qualquer chamada à franquia. Petrópolis e as outras
 * unidades seguem o caminho de sempre (aqui, até a leitura da agenda, que o teste faz falhar de propósito).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { SpineService } from '../services/spine.service.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import { marcarPeloWidget } from './marcacao-widget.js';

const PETRO = 'doutor-hernia-petropolis';
const FONE = '(24) 99999-0000';

let unidadeAtual: Unit;
const naFranquia: string[] = [];

// Sem banco: a unidade "fresca", os passos do rastro e os bloqueios da agenda.
Object.defineProperty(prisma, 'unit', { value: { findUnique: async () => unidadeAtual }, configurable: true });
Object.defineProperty(prisma, 'executionStep', { value: { create: async () => ({}) }, configurable: true });
Object.defineProperty(prisma, 'executionTrace', { value: { update: async () => ({}) }, configurable: true });
Object.defineProperty(prisma, 'agendaBlock', { value: { findMany: async () => [] }, configurable: true });

// Toda chamada à franquia fica registrada. A leitura da agenda falha: é o ponto onde o caminho normal para.
const spine = SpineService as unknown as Record<string, unknown>;
for (const nome of ['createClient', 'convertLead', 'createSchedule', 'createLead', 'cancelSchedule', 'confirmSchedule', 'searchClients']) {
  spine[nome] = async () => {
    naFranquia.push(nome);
    return { ok: false, error: 'não devia chegar aqui' };
  };
}
spine.searchSchedules = async () => {
  naFranquia.push('searchSchedules');
  return { ok: false, error: 'franquia de teste' };
};

beforeEach(() => {
  naFranquia.length = 0;
});

function unidade(slug: string): Unit {
  return {
    id: `u-${slug}`,
    slug,
    name: slug,
    isActive: true,
    spineEnabled: true,
    spineToken: 'tok',
    spineTimezone: 'America/Sao_Paulo',
    kommoAccessToken: 'tok',
    kommoSubdomain: 'teste',
  } as unknown as Unit;
}

function kommoFalso(unidadeDeAtendimento: string | null) {
  const lidos: number[] = [];
  const lead = (id: number): KommoLead => ({
    id,
    name: 'Maria Teste',
    status_id: 1,
    pipeline_id: 1,
    custom_fields_values:
      unidadeDeAtendimento === null ? [] : [{ field_id: 479786, field_name: '⌂ Unidade de atendimento', values: [{ value: unidadeDeAtendimento }] }],
    _embedded: { contacts: [{ id: 77, is_main: true }] },
  });
  const kommo = {
    getLead: async (id: number) => {
      lidos.push(id);
      return lead(id);
    },
    getContactPhone: async () => FONE,
  } as unknown as KommoClient;
  return { kommo, lidos };
}

function amanha(): string {
  return new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
}

const pedido = (leadId: number) => ({ leadId, nome: 'Maria Teste', telefone: FONE, data: amanha(), hora: '09:00' });

test('widget marcar: cartão de Caxias na conta de Petrópolis recusa sem chamar a franquia', async () => {
  unidadeAtual = unidade(PETRO);
  const { kommo } = kommoFalso('Caxias');
  const r = await marcarPeloWidget(unidadeAtual, pedido(101), { kommo });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.codigo, 'unidade_de_outra_cidade');
    assert.equal(r.motivo, 'Este paciente é de Caxias. Marque na agenda de Caxias. A marcação pelo widget para Caxias chega na próxima atualização.');
  }
  assert.deepEqual(naFranquia, [], 'nenhuma chamada à franquia');
});

test('widget marcar: cartão SEM unidade de atendimento na conta de Petrópolis recusa sem chamar a franquia', async () => {
  unidadeAtual = unidade(PETRO);
  const { kommo } = kommoFalso(null);
  const r = await marcarPeloWidget(unidadeAtual, pedido(102), { kommo });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.codigo, 'unidade_vazia');
    assert.equal(r.motivo, 'Escolha a unidade de atendimento do cartão (Petrópolis ou Caxias) antes de marcar ou cadastrar.');
  }
  assert.deepEqual(naFranquia, []);
});

test('widget marcar: cartão de Petrópolis passa da trava e segue o caminho de sempre', async () => {
  unidadeAtual = unidade(PETRO);
  const { kommo } = kommoFalso('Petrópolis');
  const r = await marcarPeloWidget(unidadeAtual, pedido(103), { kommo });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.codigo, 'agenda_indisponivel', 'chegou à leitura da agenda da franquia');
  assert.deepEqual(naFranquia, ['searchSchedules']);
});

test('widget marcar: unidade comum não muda — nem uma leitura a mais do cartão', async () => {
  unidadeAtual = unidade('doutor-hernia-serra');
  const { kommo, lidos } = kommoFalso(null);
  const r = await marcarPeloWidget(unidadeAtual, pedido(104), { kommo });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.codigo, 'agenda_indisponivel');
  assert.deepEqual(naFranquia, ['searchSchedules']);
  // as 2 leituras de sempre: "o cartão existe?" e o telefone do contato
  assert.deepEqual(lidos, [104, 104]);
});
