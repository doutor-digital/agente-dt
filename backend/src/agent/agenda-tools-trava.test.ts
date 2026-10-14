/**
 * Ferramentas da Sofia e o espelho na franquia × trava da unidade de atendimento (14/10/2026).
 *
 * Conta de Petrópolis, cartão de Caxias (ou sem cidade): cadastrar, agendar, remarcar, cancelar e confirmar
 * devolvem RECUSADO para a IA sem tocar na franquia; o cadastro/espelho pelo servidor também não entra.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { SpineService } from '../services/spine.service.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import type { TraceRecorder } from './trace-recorder.js';
import {
  buildAgendarConsulta,
  buildCadastrarPaciente,
  buildCancelarConsulta,
  buildConfirmarPresenca,
  buildRemarcarConsulta,
} from './agenda-tools.js';
import { syncLeadToSpine, syncPatientToSpine } from '../services/spine-sync.service.js';
import { confirmarNaFranquia } from '../lib/confirmacao-d1.js';
import { SPINE_STATUS } from '../services/spine.service.js';
import type { ConsultaReconciliada } from '../services/agenda-reconcile.service.js';

const PETRO = 'doutor-hernia-petropolis';

let unidadeAtual: Unit;
const naFranquia: string[] = [];

Object.defineProperty(prisma, 'unit', { value: { findUnique: async () => unidadeAtual }, configurable: true });

const spine = SpineService as unknown as Record<string, unknown>;
for (const nome of ['createClient', 'convertLead', 'createSchedule', 'createLead', 'cancelSchedule', 'confirmSchedule', 'searchClients', 'searchSchedules']) {
  spine[nome] = async () => {
    naFranquia.push(nome);
    return { ok: false, error: 'não devia chegar aqui' };
  };
}

beforeEach(() => {
  naFranquia.length = 0;
});

function unidade(over: Partial<Unit> = {}): Unit {
  return {
    id: 'u-petro',
    slug: PETRO,
    name: 'Petrópolis',
    spineEnabled: true,
    spineToken: 'tok',
    spineSyncLeads: true,
    spineTimezone: 'America/Sao_Paulo',
    kommoAccessToken: 'tok',
    kommoSubdomain: 'teste',
    ...over,
  } as unknown as Unit;
}

function kommoFalso(unidadeDeAtendimento: string | null) {
  const lead = (id: number): KommoLead => ({
    id,
    name: 'Maria Teste',
    status_id: 1,
    pipeline_id: 1,
    custom_fields_values:
      unidadeDeAtendimento === null ? [] : [{ field_id: 479786, field_name: '⌂ Unidade de atendimento', values: [{ value: unidadeDeAtendimento }] }],
  });
  return { getLead: async (id: number) => lead(id) } as unknown as KommoClient;
}

const recorder = { step: async () => undefined } as unknown as TraceRecorder;

test('Sofia: cartão de Caxias — as 5 ferramentas que escrevem na franquia recusam sem chamar a franquia', async () => {
  unidadeAtual = unidade();
  const ctx = { unit: unidadeAtual, recorder, kommo: kommoFalso('Caxias') };
  const chamadas: Array<[string, Promise<unknown>]> = [
    ['cadastrar_paciente', buildCadastrarPaciente(ctx).invoke({ nome: 'Maria Teste', telefone: '24999990000', leadId: 5, horarioEscolhido: '2026-12-01 09:00' })],
    ['agendar_consulta', buildAgendarConsulta(ctx).invoke({ idClient: 9, data: '2026-12-01', hora: '09:00', leadId: 5, diaConfirmado: true, formaPagamento: 'na_clinica' })],
    ['remarcar_consulta', buildRemarcarConsulta(ctx).invoke({ leadId: 5, idClient: 9, data: '2026-12-01', hora: '09:00' })],
    ['cancelar_consulta', buildCancelarConsulta(ctx).invoke({ leadId: 5, confirmado: true })],
    ['confirmar_presenca', buildConfirmarPresenca(ctx).invoke({ leadId: 5 })],
  ];
  for (const [nome, p] of chamadas) {
    const texto = String(await p);
    assert.match(texto, /^RECUSADO: este paciente é de Caxias/, nome);
  }
  assert.deepEqual(naFranquia, [], 'nenhuma chamada à franquia');
});

test('Sofia: cartão sem unidade de atendimento também recusa', async () => {
  unidadeAtual = unidade();
  const ctx = { unit: unidadeAtual, recorder, kommo: kommoFalso(null) };
  const texto = String(await buildAgendarConsulta(ctx).invoke({ idClient: 9, data: '2026-12-01', hora: '09:00', leadId: 5, diaConfirmado: true, formaPagamento: 'na_clinica' }));
  assert.match(texto, /^RECUSADO: o cartão ainda não diz a unidade de atendimento \(Petrópolis ou Caxias\)/);
  assert.deepEqual(naFranquia, []);
});

test('espelho e cadastro pelo servidor: conta de Petrópolis sem conseguir ler o cartão não escreve na franquia', async () => {
  // sem token do Kommo não dá para ler a unidade do cartão: recusa sem ir à franquia
  const semKommo = unidade({ kommoAccessToken: null });
  const lead = await syncLeadToSpine(semKommo, 5);
  const paciente = await syncPatientToSpine(semKommo, 5);
  assert.equal(lead.ok, false);
  assert.equal(paciente.ok, false);
  assert.match(lead.motivo ?? '', /unidade de atendimento/);
  assert.deepEqual(naFranquia, []);
});

test('confirmação D-1: cartão de Caxias não confirma na franquia e avisa a equipe; outra unidade confirma', async () => {
  const consulta = { idSchedule: 1, quando: '2026-12-01T09:00', salvo: '2026-12-01T09:00', estado: 'confirmada', mudou: false, especialista: null, idStatus: SPINE_STATUS.AGENDADO } as ConsultaReconciliada;
  const tarefas: string[] = [];
  const kommo = { createTask: async (a: { text: string }) => { tarefas.push(a.text); return {} as never; } };
  const confirmadas: number[] = [];
  const deps = (cidade: string | null) => ({
    confirmSchedule: async (_u: Unit, id: number) => { confirmadas.push(id); return { ok: true }; },
    perguntou: async () => true,
    esquecerConsulta: () => undefined,
    travaDaUnidade: async (u: Unit, leadId: number) => {
      const { travaDaUnidadeDeAtendimento } = await import('../lib/trava-unidade-atendimento.js');
      return travaDaUnidadeDeAtendimento(u, leadId, kommoFalso(cidade));
    },
  });

  const r = await confirmarNaFranquia({ unit: unidade(), leadId: 5, consulta, contactName: 'Maria', kommo }, deps('Caxias'));
  assert.equal(r, 'unidade_de_atendimento');
  assert.deepEqual(confirmadas, []);
  assert.match(tarefas[0] ?? '', /cartão de Caxias/);

  const ok = await confirmarNaFranquia(
    { unit: unidade({ slug: 'doutor-hernia-acailandia' }), leadId: 5, consulta, contactName: 'Maria', kommo },
    deps('Caxias'),
  );
  assert.equal(ok, 'confirmada', 'nas outras unidades nada muda');
  assert.deepEqual(confirmadas, [1]);
});
