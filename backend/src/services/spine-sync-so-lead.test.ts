/**
 * "Nunca paciente" no caminho REAL do sincronizador (27/10/2026).
 *
 * Lead cadastrado só porque entrou em contato (`soLead`) é lead, e só lead — mesmo na unidade que tem
 * `spine_sync_patients` ligado, onde o lead que agenda vira paciente na mesma chamada. E nunca sem o
 * casamento cartão × paciente ligado: sem ele o lead nasce em cima de quem já é paciente.
 * Aqui só a franquia, o Kommo e o banco são falsos; `syncLeadToSpine` é o de produção.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { SpineService } from './spine.service.js';
import { KommoClient } from './kommo.service.js';
import { _semearParaTeste } from '../lib/automacoes-estado.js';
import { limparCacheEsquema } from '../lib/kommo-schema.js';
import { syncLeadToSpine } from './spine-sync.service.js';

const feitos: string[] = [];

const spine = SpineService as unknown as Record<string, unknown>;
spine.createLead = async () => {
  feitos.push('createLead');
  return { ok: true, data: { idLead: 777 } };
};
spine.createClient = async () => {
  feitos.push('createClient');
  return { ok: true, data: { idClient: 888 } };
};
spine.searchClients = async () => ({ ok: true, data: { clients: [] } });

const kommo = KommoClient.prototype as unknown as Record<string, unknown>;
kommo.getLead = async (id: number) => ({ id, name: 'Maria Souza Lima', status_id: 1, pipeline_id: 1, custom_fields_values: [], _embedded: { contacts: [{ id: 5 }] } });
kommo.getContactBasico = async () => ({ nome: 'Maria Souza Lima', telefone: '+55 11 98888-7777' });
kommo.getContactPhone = async () => '+55 11 98888-7777';
kommo.listLeadCustomFields = async () => ({ _embedded: { custom_fields: [] } });
kommo.listPipelines = async () => [];
kommo.listLeadsPorTelefone = async () => [];

Object.defineProperty(prisma, 'spineLeadLink', {
  value: {
    findUnique: async () => null,
    findFirst: async () => null,
    upsert: async () => ({}),
    update: async () => ({}),
  },
  configurable: true,
});

function unidade(): Unit {
  return {
    id: 'u-serra',
    slug: 'doutor-hernia-serra',
    name: 'Serra',
    spineEnabled: true,
    spineToken: 'tok',
    spineSyncLeads: true,
    spineSyncPatients: true,
    spineTimezone: 'America/Sao_Paulo',
    kommoAccessToken: 'tok',
    kommoSubdomain: 'teste',
  } as unknown as Unit;
}

const casamento = (estado: 'ligado' | 'seco' | 'desligado' | null) =>
  _semearParaTeste(estado ? [{ slug: 'doutor-hernia-serra', automacao: 'casamento-jornada', estado }] : []);

beforeEach(() => {
  feitos.length = 0;
  limparCacheEsquema();
  casamento('ligado');
});

test('só lead: cria o lead e NÃO cria o paciente, mesmo com spine_sync_patients ligado', async () => {
  const r = await syncLeadToSpine(unidade(), 10, { soLead: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(feitos, ['createLead']);
});

test('sem soLead (quem agendou, o console): o lead continua virando paciente na mesma chamada, como sempre', async () => {
  const r = await syncLeadToSpine(unidade(), 11);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(feitos, ['createLead', 'createClient']);
});

test('só lead SEM o casamento-jornada ligado não cria nada — duplicaria quem já é paciente', async () => {
  for (const estado of ['desligado', 'seco', null] as const) {
    casamento(estado);
    feitos.length = 0;
    const r = await syncLeadToSpine(unidade(), 12, { soLead: true });
    assert.equal(r.ok, false, String(estado));
    assert.match(r.motivo ?? '', /casamento-jornada/);
    assert.deepEqual(feitos, [], String(estado));
  }
});

test('sem soLead e sem casamento: o caminho de sempre segue criando (a regra de 26/09 não muda)', async () => {
  casamento(null);
  const r = await syncLeadToSpine(unidade(), 13);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(feitos, ['createLead', 'createClient']);
});
