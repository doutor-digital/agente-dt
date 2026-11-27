/**
 * Tela da franquia (27/11/2026): "enviado por nós" × "o telefone já estava lá" × "paciente já existia", e o item do índice de telefones na prontidão.
 * Só o banco e a franquia são falsos; os handlers são os de produção.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { SpineService } from '../services/spine.service.js';
import { _semearParaTeste } from '../lib/automacoes-estado.js';
import { listLeadLinksHandler, prontidaoHandler } from './spine.controller.js';

const agora = new Date();
const link = (kommoLeadId: number, o: Record<string, unknown>) => ({
  id: `l${kommoLeadId}`, unitId: 'u1', kommoLeadId, spineIdLead: null, spineIdClient: null, status: 'ok', motivo: null, tentativas: 1, updatedAt: agora, createdAt: agora, ...o,
});
let links: Array<ReturnType<typeof link>> = [];
let leadsLa: number[] = [];
let statusDoIndice: Record<string, unknown> | null = null;
let unidade: Record<string, unknown> = {};

Object.defineProperty(prisma, 'unit', { value: { findUnique: async () => unidade }, configurable: true });
Object.defineProperty(prisma, 'spineLeadLink', {
  value: {
    findMany: async (a: { select?: unknown }) => (a.select ? links.map((l) => ({ motivo: l.motivo })) : links),
    groupBy: async () => [{ status: 'ok', _count: { _all: links.length } }],
    count: async () => 0,
  },
  configurable: true,
});
Object.defineProperty(prisma, 'franquiaIndiceStatus', { value: { findUnique: async () => statusDoIndice }, configurable: true });
const spine = SpineService as unknown as Record<string, unknown>;
spine.searchLeads = async () => ({ ok: true, data: { leads: leadsLa.map((idLead) => ({ idLead, name: 'x', whatsapp: null, idSource: null })) } });
spine.ping = async () => ({ ok: true, data: { total: 1 } });

function chamar(h: (req: Request, res: Response) => Promise<void>): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const res = { status: () => res, json: (b: Record<string, any>) => resolve(b) } as unknown as Response;
    h({ params: { id: 'u1' }, query: {}, body: {} } as unknown as Request, res).catch(reject);
  });
}

beforeEach(() => {
  _semearParaTeste([]);
  leadsLa = [];
  statusDoIndice = null;
  unidade = { id: 'u1', slug: 'doutor-hernia-bebedouro', name: 'Bebedouro', spineToken: 'tok', spineEnabled: true, spineTimezone: 'America/Sao_Paulo', spineSyncLeads: true, spineAgendaStart: '08:00', spineAgendaEnd: '18:00' };
});

test('lead-links: o que já existia na franquia NÃO conta como "enviado por nós" nem como "hoje" e NÃO aparece como "faltando" na conferência de 7 dias', async () => {
  links = [
    link(1, { spineIdLead: 100 }), // criado por nós
    link(2, { spineIdLead: 200, motivo: 'lead já existe na franquia (idLead 200, achado pelo telefone no índice): não criei lead — mesmo primeiro nome do cartão: vinculado' }),
    link(3, { motivo: 'lead já existe na franquia (idLead 300, achado pelo telefone no índice): não criei lead — NÃO vinculado ao cartão' }),
    link(4, { motivo: 'paciente já existe na franquia (idClient 9001, achado pelo telefone no índice): não criei lead' }),
  ];
  leadsLa = [100]; // o lead 200 é antigo (fora da janela de 7 dias) e não aparece na busca: antes disso virava "faltando"
  const r = await chamar(listLeadLinksHandler);
  assert.equal(r.hoje, 1, 'um só foi enviado por nós');
  assert.deepEqual(r.hojeJaExistiam, { lead: 2, paciente: 1 });
  assert.equal(r.conferencia.checado, true);
  assert.equal(r.conferencia.enviadosPorNos, 1);
  assert.deepEqual(r.conferencia.faltando, [], 'o lead antigo (200) não é cobrado como faltando');
  assert.deepEqual(r.links.map((l: { tipo: string }) => l.tipo), ['criado', 'lead-ja-existia', 'lead-ja-existia', 'paciente-ja-existia']);
});

test('lead-links: o lead que NÓS criamos e sumiu da franquia continua aparecendo como "faltando"', async () => {
  links = [link(1, { spineIdLead: 100 }), link(2, { spineIdLead: 101 })];
  leadsLa = [100];
  const r = await chamar(listLeadLinksHandler);
  assert.deepEqual(r.conferencia.faltando, [101]);
});

test('prontidão: unidade do 1º contato com a agenda DESLIGADA mostra o índice de telefones como PROBLEMA (zero lead, nenhum erro)', async () => {
  _semearParaTeste([{ slug: 'doutor-hernia-bebedouro', automacao: 'cadastro-lead-primeiro-contato', estado: 'ligado' }]);
  unidade = { ...unidade, spineEnabled: false };
  const r = await chamar(prontidaoHandler);
  const peca = r.pecas.find((p: { id: string }) => p.id === 'indice-telefones');
  assert.ok(peca, 'o item existe');
  assert.equal(peca.ok, false);
  assert.match(peca.detalhe, /spine_enabled/);
});

test('prontidão: agenda ligada e índice sem problema = item ok; unidade fora do 1º contato nem mostra o item', async () => {
  _semearParaTeste([{ slug: 'doutor-hernia-bebedouro', automacao: 'cadastro-lead-primeiro-contato', estado: 'seco' }]);
  const ok = (await chamar(prontidaoHandler)).pecas.find((p: { id: string }) => p.id === 'indice-telefones');
  assert.equal(ok.ok, true);
  _semearParaTeste([]);
  assert.equal((await chamar(prontidaoHandler)).pecas.find((p: { id: string }) => p.id === 'indice-telefones'), undefined);
});

test('prontidão: carga do índice CORTADA pelo teto aparece como problema', async () => {
  _semearParaTeste([{ slug: 'doutor-hernia-bebedouro', automacao: 'cadastro-lead-primeiro-contato', estado: 'ligado' }]);
  statusDoIndice = { completoEm: null, cargaCompletaEm: null, tentativaEm: agora, clientesTotal: null, leadsAte: null, resultado: 'cortado' };
  const peca = (await chamar(prontidaoHandler)).pecas.find((p: { id: string }) => p.id === 'indice-telefones');
  assert.equal(peca.ok, false);
  assert.match(peca.detalhe, /CORTADA/);
});
