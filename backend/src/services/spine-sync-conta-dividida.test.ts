/**
 * O cadastro da Sofia na franquia numa conta do Kommo dividida (Petrópolis + Caxias), 03/11/2026.
 *
 * Com a divisão gravada, toda escrita sem a marca `escritaConferida` é recusada pela trava (e o cadastro de lead da Sofia
 * nunca chegava a gravar). Agora o cadastro lê o «⌂ Unidade de atendimento» do cartão: cartão DESTA unidade grava, com a
 * marca; cartão da irmã, vazio ou ilegível não grava — e nunca com o token da outra unidade.
 * Só a franquia, o Kommo e o banco são falsos; `syncLeadToSpine`, a conferência do cartão e a trava são os de produção.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { SpineService } from './spine.service.js';
import { KommoClient } from './kommo.service.js';
import { _semearParaTeste } from '../lib/automacoes-estado.js';
import { limparCacheEsquema } from '../lib/kommo-schema.js';
import { _semearCrmParaTeste } from '../lib/crm-compartilhado.js';
import { _zerarTravaParaTeste, definirTokensProtegidos, motivoParaNaoEscrever } from '../lib/trava-escrita-franquia.js';
import { syncLeadToSpine, syncPatientToSpine } from './spine-sync.service.js';

const PETRO = 'u-petropolis';
const CAXIAS = 'u-caxias';
const chamadas: Array<{ metodo: string; token: string | null | undefined; conferida: boolean | undefined }> = [];

// A franquia falsa aplica a MESMA trava de produção antes de aceitar a escrita (o createLead de verdade a chama primeiro).
const spine = SpineService as unknown as Record<string, unknown>;
spine.createLead = async (u: Unit & { escritaConferida?: boolean }) => {
  const recusa = await motivoParaNaoEscrever(u);
  if (recusa) return { ok: false, error: recusa };
  chamadas.push({ metodo: 'createLead', token: u.spineToken, conferida: u.escritaConferida });
  return { ok: true, data: { idLead: 777 } };
};
spine.createClient = async (u: Unit & { escritaConferida?: boolean }) => {
  const recusa = await motivoParaNaoEscrever(u);
  if (recusa) return { ok: false, error: recusa };
  chamadas.push({ metodo: 'createClient', token: u.spineToken, conferida: u.escritaConferida });
  return { ok: true, data: { idClient: 888 } };
};
spine.searchClients = async () => ({ ok: true, data: { clients: [] } });

let valorDoCampo: string | null = 'Petrópolis';
let kommoFora = false;
let comLead = false;
const kommo = KommoClient.prototype as unknown as Record<string, unknown>;
kommo.getLead = async (id: number) => {
  if (kommoFora) throw new Error('Kommo fora');
  return {
    id,
    name: 'Maria Souza Lima',
    status_id: 1,
    pipeline_id: 1,
    custom_fields_values: valorDoCampo === null ? [] : [{ field_id: 479786, field_name: '⌂ Unidade de atendimento', values: [{ value: valorDoCampo }] }],
    _embedded: { contacts: [{ id: 5 }] },
  };
};
kommo.getContactBasico = async () => ({ nome: 'Maria Souza Lima', telefone: '+55 24 98888-7777' });
kommo.getContactPhone = async () => '+55 24 98888-7777';
kommo.listLeadCustomFields = async () => ({ _embedded: { custom_fields: [] } });
kommo.listPipelines = async () => [];
kommo.listLeadsPorTelefone = async () => [];

Object.defineProperty(prisma, 'spineLeadLink', {
  value: { findUnique: async () => (comLead ? { spineIdLead: 5, spineIdClient: null, nome: 'Maria Souza Lima', status: 'ok' } : null), findFirst: async () => null, upsert: async () => ({}), update: async () => ({}) },
  configurable: true,
});
Object.defineProperty(prisma, 'unit', {
  value: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === CAXIAS ? caxias() : petro()) },
  configurable: true,
});

const petro = (): Unit =>
  ({
    id: PETRO, slug: 'doutor-hernia-petropolis', name: 'Petrópolis', spineEnabled: true, spineToken: 'tok-petro', spineSyncLeads: true,
    spineSyncPatients: false, spineTimezone: 'America/Sao_Paulo', kommoAccessToken: 'k', kommoSubdomain: 'doutorhernialvp',
  }) as unknown as Unit;
const caxias = (): Unit =>
  ({ id: CAXIAS, slug: 'doutor-hernia-caxias', name: 'Caxias', spineEnabled: true, spineToken: 'tok-caxias', spineSyncLeads: true, kommoAccessToken: null }) as unknown as Unit;

beforeEach(() => {
  chamadas.length = 0;
  valorDoCampo = 'Petrópolis';
  kommoFora = false;
  comLead = false;
  limparCacheEsquema();
  _semearParaTeste([
    { slug: 'doutor-hernia-petropolis', automacao: 'casamento-jornada', estado: 'ligado' },
    { slug: 'doutor-hernia-serra', automacao: 'casamento-jornada', estado: 'ligado' },
    { slug: 'doutor-hernia-caxias', automacao: 'casamento-jornada', estado: 'ligado' },
  ]);
  _semearCrmParaTeste([
    { unitId: PETRO, contaUnitId: PETRO, rotulo: 'Petrópolis', slug: 'doutor-hernia-petropolis' },
    { unitId: CAXIAS, contaUnitId: PETRO, rotulo: 'Caxias', slug: 'doutor-hernia-caxias' },
  ]);
  _zerarTravaParaTeste();
  definirTokensProtegidos(['tok-petro', 'tok-caxias']);
});

test('cartão de Petrópolis: o lead entra na franquia, com o token de Petrópolis e a marca de conferido', async () => {
  const r = await syncLeadToSpine(petro(), 10, { soLead: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(chamadas, [{ metodo: 'createLead', token: 'tok-petro', conferida: true }]);
});

test('cartão de Caxias: NADA é gravado — nem com o token de Petrópolis, nem com o de Caxias', async () => {
  valorDoCampo = 'Caxias';
  const r = await syncLeadToSpine(petro(), 10, { soLead: true });
  assert.equal(r.ok, false);
  assert.match(String(r.motivo), /Caxias/);
  assert.deepEqual(chamadas, []);
});

test('cartão sem unidade, com valor estranho ou ilegível: NADA é gravado', async () => {
  for (const v of [null, 'Rio']) {
    valorDoCampo = v;
    const r = await syncLeadToSpine(petro(), 10, { soLead: true });
    assert.equal(r.ok, false, `valor ${v}`);
  }
  valorDoCampo = 'Petrópolis';
  kommoFora = true;
  assert.equal((await syncLeadToSpine(petro(), 10, { soLead: true })).ok, false, 'Kommo fora = recusa');
  assert.deepEqual(chamadas, []);
});

test('o paciente (agendou) segue a mesma regra: Petrópolis grava, Caxias não', async () => {
  comLead = true;
  const ok = await syncPatientToSpine(petro(), 10);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(chamadas.at(-1)?.metodo, 'createClient');
  assert.equal(chamadas.at(-1)?.conferida, true);
  chamadas.length = 0;
  valorDoCampo = 'Caxias';
  assert.equal((await syncPatientToSpine(petro(), 10)).ok, false);
  assert.deepEqual(chamadas, []);
});

test('unidade que não divide Kommo: nada muda (campo vazio não trava, nada é marcado)', async () => {
  _semearCrmParaTeste([]);
  _zerarTravaParaTeste();
  valorDoCampo = null; // sem o campo: numa conta dividida isto recusaria; numa comum não importa
  const r = await syncLeadToSpine({ ...petro(), slug: 'doutor-hernia-serra' } as Unit, 10, { soLead: true });
  assert.equal(chamadas[0]?.conferida, undefined);
  assert.equal(chamadas[0]?.metodo, 'createLead', JSON.stringify(r));
});

test('a irmã (Caxias, sem Kommo próprio) chamando o cadastro: recusa, mesmo com o cartão dela — quem cadastra o de Caxias é o widget', async () => {
  valorDoCampo = 'Caxias';
  const r = await syncLeadToSpine(caxias(), 10, { soLead: true });
  assert.equal(r.ok, false);
  assert.match(String(r.motivo), /Kommo de/);
  assert.deepEqual(chamadas, []);
});
