/**
 * O sincronizador entrega a agenda que JÁ leu ao histórico de mudanças de status (chave `recuperacao-agenda`), sem chamar a franquia de novo
 * e sem mudar nada do que ele faz hoje. De ponta a ponta contra uma franquia FALSA local (HTTP) e um Kommo falso; o banco é trocado por memória.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Unit } from '@prisma/client';

import { prisma } from './prisma.js';
import { _semearParaTeste, type Estado } from './automacoes-estado.js';
import { _semearCrmParaTeste } from './crm-compartilhado.js';
import { _interno, type CampoBruto, type ResumoSync } from './franquia-sync-worker.js';
import type { KommoClient } from '../services/kommo.service.js';

// ── o banco, em memória ─────────────────────────────────────────────────────────
let gravados: Array<Record<string, unknown>> = [];
let consultasAoBanco = 0;
function definir(nome: string, valor: unknown) {
  Object.defineProperty(prisma, nome, { value: valor, configurable: true });
}
definir('agendaStatusEvento', { createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => { gravados.push(...data); return { count: data.length }; } });
Object.defineProperty(prisma, '$queryRaw', { value: async () => { consultasAoBanco++; return []; }, configurable: true });
definir('spineLeadLink', { findFirst: async () => null, findMany: async () => [], findUnique: async () => null });
definir('cardAlert', { findUnique: async () => null, findFirst: async () => null, findMany: async () => [], upsert: async () => ({}), deleteMany: async () => ({ count: 0 }), create: async () => ({}) });
definir('automacaoSimulacao', { upsert: async () => ({}), deleteMany: async () => ({ count: 0 }) });
definir('unitAutomacao', { findMany: async () => [] });
definir('unit', { findUnique: async () => null, findMany: async () => [] });
definir('unitCrmCompartilhado', { findMany: async () => [] });

// ── a franquia falsa ────────────────────────────────────────────────────────────
let agendaFalsa: Array<Record<string, unknown>> = [];
let chamadasFranquia: string[] = [];
let servidor: http.Server;
let base = '';
before(async () => {
  servidor = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      chamadasFranquia.push(`${req.method} ${req.url}`);
      if (req.method === 'POST' && req.url === '/api/schedules/search') {
        res.end(JSON.stringify({ data: { data: agendaFalsa, totalPages: 1, total: agendaFalsa.length } }));
        return;
      }
      if (req.method === 'POST' && (req.url === '/api/treatments/search' || req.url === '/api/clients/search')) {
        res.end(JSON.stringify({ data: { data: [], totalPages: 1 } }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
after(() => servidor.close());

process.env.AGENDA_HISTORICO_SEGREDO = 'segredo-de-teste-da-agenda-0123456789abcdef';
const SLUG = 'acailandia-historico-teste';
let seq = 0;
const unidade = () => ({ id: `uh-${++seq}`, slug: SLUG, name: 'Açailândia (teste)', spineBaseUrl: base, spineToken: 'token-falso', spineTimezone: 'America/Sao_Paulo', spineEnabled: true }) as unknown as Unit;

const CAMPOS_BRUTOS: CampoBruto[] = [
  { id: 1, name: '◷ Data da Consulta', type: 'date' },
  { id: 2, name: '✓ Situação da consulta', type: 'select', enums: ['Agendado', 'Desmarcado'].map((value, i) => ({ id: 20 + i, value })) },
];
const kommoFalso = { listLeadCustomFields: async () => ({ _embedded: { custom_fields: CAMPOS_BRUTOS } }), listPipelines: async () => [], listLeadsPorTelefone: async () => [] } as unknown as KommoClient;

const chaves = (estado: Estado) =>
  _semearParaTeste(['recuperacao-agenda', 'casamento-jornada', 'franquia-tela', 'campos-sdr', 'franquia-sessoes'].map((automacao) => ({ slug: SLUG, automacao, estado: automacao === 'recuperacao-agenda' ? estado : 'desligado' })));

beforeEach(() => {
  gravados = [];
  consultasAoBanco = 0;
  chamadasFranquia = [];
  _semearCrmParaTeste([]);
  const em = (dias: number) => new Date(Date.now() + dias * 86_400_000).toISOString();
  agendaFalsa = [
    { idSchedule: 9001, idStatus: 57, statusName: 'Desmarcado', clientName: 'MARIA TESTE', categoryName: 'AVALIAÇÃO', dateAttendance: em(2), modified: em(-1) },
    { idSchedule: 9002, idStatus: 37, statusName: 'Agendado', clientName: 'JOSE TESTE', categoryName: 'AVALIAÇÃO', dateAttendance: em(3), modified: em(-2) },
  ];
});

test('chave «só no papel»: a agenda que o sincronizador leu vira histórico (sem chamar a franquia de novo)', async () => {
  chaves('seco');
  const unit = unidade();
  const r = (await _interno.sincronizarUnidade(unit, { kommo: kommoFalso })) as ResumoSync;
  assert.equal(r.agendamentos, 2);
  assert.equal(gravados.length, 2);
  const desmarcado = gravados.find((g) => g.idSchedule === 9001)!;
  assert.equal(desmarcado.paraStatus, 57);
  assert.equal(desmarcado.deStatus, null);
  assert.equal(desmarcado.unitId, unit.id);
  assert.match(String(desmarcado.pacienteChave), /^[0-9a-f]{32}$/);
  assert.ok(desmarcado.modificadoEm instanceof Date, 'a hora em que a franquia lançou o desmarque');
  assert.equal(JSON.stringify(gravados).includes('MARIA'), false, 'nome de paciente não vai para o histórico');
  assert.equal(chamadasFranquia.filter((c) => c === 'POST /api/schedules/search').length, 1, 'uma leitura da agenda, não duas');
});

test('chave DESLIGADA: o sincronizador faz o que sempre fez — nada vai ao histórico e o banco do histórico nem é consultado', async () => {
  chaves('desligado');
  const r = (await _interno.sincronizarUnidade(unidade(), { kommo: kommoFalso })) as ResumoSync;
  assert.equal(r.agendamentos, 2);
  assert.deepEqual(gravados, []);
  assert.equal(consultasAoBanco, 0);
});

test('o banco do histórico falha: o sincronizador termina igual (o registro nunca derruba a varredura)', async () => {
  chaves('ligado');
  Object.defineProperty(prisma, '$queryRaw', { value: async () => { throw new Error('banco fora'); }, configurable: true });
  const r = (await _interno.sincronizarUnidade(unidade(), { kommo: kommoFalso })) as ResumoSync;
  assert.equal(r.agendamentos, 2);
  assert.deepEqual(gravados, []);
});
