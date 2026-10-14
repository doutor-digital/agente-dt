/**
 * Ferramentas da Sofia e o espelho na franquia × trava da unidade de atendimento (14/10/2026).
 *
 * Conta de Petrópolis, cartão de Caxias (ou sem cidade): consultar horários (a sondagem marca e desmarca),
 * cadastrar, agendar e remarcar devolvem RECUSADO para a IA sem tocar na franquia; o espelho de lead e o cadastro
 * de paciente pelo servidor também não entram. Cancelar e confirmar uma consulta que JÁ está na agenda não travam.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { SpineService, SPINE_STATUS } from '../services/spine.service.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import type { ConsultaReconciliada } from '../services/agenda-reconcile.service.js';
import type { TraceRecorder } from './trace-recorder.js';
import { buildAgendarConsulta, buildCadastrarPaciente, buildConsultarHorarios, buildRemarcarConsulta } from './agenda-tools.js';
import { fixarLeadDaConversa } from './graph.js';
import { syncLeadToSpine, syncPatientToSpine } from '../services/spine-sync.service.js';
import { confirmarNaFranquia } from '../lib/confirmacao-d1.js';

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
  const lidos: number[] = [];
  const lead = (id: number): KommoLead => ({
    id,
    name: 'Maria Teste',
    status_id: 1,
    pipeline_id: 1,
    custom_fields_values:
      unidadeDeAtendimento === null ? [] : [{ field_id: 479786, field_name: '⌂ Unidade de atendimento', values: [{ value: unidadeDeAtendimento }] }],
  });
  const kommo = {
    getLead: async (id: number) => {
      lidos.push(id);
      return lead(id);
    },
  } as unknown as KommoClient;
  return { kommo, lidos };
}

const recorder = { step: async () => undefined } as unknown as TraceRecorder;

test('Sofia: cartão de Caxias — consultar, cadastrar, agendar e remarcar recusam sem chamar a franquia', async () => {
  unidadeAtual = unidade();
  const { kommo, lidos } = kommoFalso('Caxias');
  const ctx = { unit: unidadeAtual, recorder, kommo, estado: { consultou: false } };
  // como no grafo: o lead da conversa entra em toda ferramenta, inclusive na que não tem `leadId` no schema
  const [consultar] = fixarLeadDaConversa([buildConsultarHorarios(ctx)], 5, recorder, unidadeAtual);
  const chamadas: Array<[string, Promise<unknown>]> = [
    ['consultar_horarios', consultar.invoke({ data: '2026-12-01' })],
    ['cadastrar_paciente', buildCadastrarPaciente(ctx).invoke({ nome: 'Maria Teste', telefone: '24999990000', leadId: 5, horarioEscolhido: '2026-12-01 09:00' })],
    ['agendar_consulta', buildAgendarConsulta(ctx).invoke({ idClient: 9, data: '2026-12-01', hora: '09:00', leadId: 5, diaConfirmado: true, formaPagamento: 'na_clinica' })],
    ['remarcar_consulta', buildRemarcarConsulta(ctx).invoke({ leadId: 5, idClient: 9, data: '2026-12-01', hora: '09:00' })],
  ];
  for (const [nome, p] of chamadas) {
    assert.match(String(await p), /^RECUSADO: este paciente é de Caxias/, nome);
  }
  assert.deepEqual(naFranquia, [], 'nenhuma chamada à franquia');
  assert.ok(lidos.every((id) => id === 5), 'leu o cartão da conversa');
});

test('Sofia: cartão sem unidade de atendimento também recusa', async () => {
  unidadeAtual = unidade();
  const ctx = { unit: unidadeAtual, recorder, kommo: kommoFalso(null).kommo };
  const texto = String(await buildAgendarConsulta(ctx).invoke({ idClient: 9, data: '2026-12-01', hora: '09:00', leadId: 5, diaConfirmado: true, formaPagamento: 'na_clinica' }));
  assert.match(texto, /^RECUSADO: o cartão ainda não diz a unidade de atendimento \(Petrópolis ou Caxias\)/);
  assert.deepEqual(naFranquia, []);
});

test('Sofia: unidade comum não lê o cartão para consultar horários', async () => {
  unidadeAtual = unidade({ slug: 'doutor-hernia-serra', spineAgendaDays: [1, 2, 3, 4, 5] });
  const { kommo, lidos } = kommoFalso('Caxias');
  const ctx = { unit: unidadeAtual, recorder, kommo, estado: { consultou: false } };
  const [consultar] = fixarLeadDaConversa([buildConsultarHorarios(ctx)], 5, recorder, unidadeAtual);
  Object.defineProperty(prisma, 'spineLeadLink', { value: { findFirst: async () => null }, configurable: true });
  Object.defineProperty(prisma, 'agendaBlock', { value: { findMany: async () => [] }, configurable: true });
  const texto = String(await consultar.invoke({ data: '2026-12-01' }));
  assert.doesNotMatch(texto, /RECUSADO/);
  assert.deepEqual(lidos, [], 'nenhuma leitura a mais do cartão');
  assert.ok(naFranquia.includes('searchSchedules'), 'seguiu para a agenda como sempre');
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

test('confirmação D-1 de consulta que já está na agenda de Petrópolis não trava (só criar trava)', async () => {
  const consulta = { idSchedule: 1, quando: '2026-12-01T09:00', salvo: '2026-12-01T09:00', estado: 'confirmada', mudou: false, especialista: null, idStatus: SPINE_STATUS.AGENDADO } as ConsultaReconciliada;
  const confirmadas: number[] = [];
  const r = await confirmarNaFranquia(
    { unit: unidade(), leadId: 5, consulta, contactName: 'Maria', kommo: { createTask: async () => ({}) as never } },
    {
      confirmSchedule: async (_u, id) => {
        confirmadas.push(id);
        return { ok: true };
      },
      perguntou: async () => true,
      esquecerConsulta: () => undefined,
    },
  );
  assert.equal(r, 'confirmada');
  assert.deepEqual(confirmadas, [1]);
});
