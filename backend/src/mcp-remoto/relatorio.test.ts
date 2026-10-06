/**
 * O relatório cruzado de ponta a ponta: Kommo falso + franquia falsa (HTTP local) + "banco" em mapas.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { criarContexto } from '../franquia-mcp/contexto.js';
import { type FranquiaFalsa, subirFranquiaFalsa } from '../franquia-mcp/franquia-falsa.js';
import type { Unidade } from '../franquia-mcp/unidade.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { criarContextoKommo } from './kommo.js';
import { fonteFalsa, leadFalso, unidadeKommo } from './kommo-falso.js';
import { relatorioFunil, type DepsRelatorio } from './relatorio.js';

const TOKEN = 'token-franquia-serra-0123456789abcdef';
let falsa: FranquiaFalsa;
let deps: DepsRelatorio;

before(async () => {
  falsa = await subirFranquiaFalsa({
    [TOKEN]: {
      pacientes: [
        { idClient: 10, name: 'Ana Souza', whatsapp: '5541999998888', created: '2026-09-02T12:00:00Z' },
        { idClient: 20, name: 'Bruno Lima', whatsapp: '5541977776666', created: '2026-09-03T12:00:00Z' },
        { idClient: 30, name: 'Carla Dias', whatsapp: '5541955554444', created: '2026-09-04T12:00:00Z' },
      ],
      agendamentos: [
        { idSchedule: 1, clientName: 'ANA SOUZA', dateAttendance: '2026-09-05T13:00:00Z', statusName: 'Atendido', idStatus: 42 },
        { idSchedule: 2, clientName: 'Bruno Lima', dateAttendance: '2026-09-06T13:00:00Z', statusName: 'Não compareceu', idStatus: 40 },
        // Carla veio pela recepção: não tem lead no Kommo, mas é da franquia no período
        { idSchedule: 3, clientName: 'Carla Dias', dateAttendance: '2026-09-07T13:00:00Z', statusName: 'Atendido', idStatus: 42 },
      ],
      tratamentos: [{ idTreatment: 1, idClient: 10, clientName: 'Ana Souza', created: '2026-09-05T15:00:00Z', price: 1800, category: 'Fisioterapia' }],
    },
  });
  const franquia = criarContexto(
    new Map<string, Unidade>([['doutor-hernia-serra', { slug: 'doutor-hernia-serra', nome: 'Serra', token: TOKEN, fuso: 'America/Sao_Paulo', baseUrl: falsa.url }]]),
    { intervaloMs: 0, cliente: { log: () => {} } },
  );
  const leads = [
    leadFalso(1, '2026-09-01T12:00:00Z', {
      custom_fields_values: [
        { field_id: 5, field_name: 'Origem', values: [{ value: 'Instagram' }] },
        { field_id: 6, field_name: 'Origem – Campanha', values: [{ value: 'LEADS | WPP' }] },
      ],
    }),
    leadFalso(2, '2026-09-01T13:00:00Z', {
      custom_fields_values: [
        { field_id: 5, field_name: 'Origem', values: [{ value: 'Instagram' }] },
        { field_id: 6, field_name: 'Origem – Campanha', values: [{ value: 'TRÁFEGO | WPP' }] },
      ],
    }),
    leadFalso(3, '2026-09-02T12:00:00Z'), // sem telefone nem vínculo
    leadFalso(4, '2026-09-02T13:00:00Z'), // telefone fora do cadastro
  ];
  // Carla nunca falou com a IA (veio por ligação): o telefone dela só existe no CONTATO do Kommo
  const leadsComCarla = [...leads, leadFalso(5, '2026-09-03T12:00:00Z', { _embedded: { contacts: [{ id: 500, is_main: true }] } })];
  const kommo = criarContextoKommo(
    new Map([
      ['doutor-hernia-serra', unidadeKommo('doutor-hernia-serra', fonteFalsa(leadsComCarla, [], { 500: '+55 41 95555-4444' }))],
      ['doutor-hernia-boituva', unidadeKommo('doutor-hernia-boituva', fonteFalsa(leads))], // tem Kommo, não tem franquia
    ]),
  );
  deps = {
    franquia,
    kommo,
    telefonesDosLeads: async () => new Map([[1, '41999998888'], [2, '+55 41 97777-6666'], [4, '11900000000']]),
    vinculosDosLeads: async () => new Map(),
    agora: () => new Date('2026-10-06T15:00:00Z'),
  };
});
after(() => falsa.fechar());

type R = Record<string, any>;

test('funil cruzado: leads → paciente → agendou → compareceu → tratamento, com cobertura e origem', async () => {
  const r = (await relatorioFunil(deps, { unidade: 'serra', inicio: '2026-09-01', fim: '2026-09-30' })) as R;
  const u = r.porUnidade['doutor-hernia-serra'];
  assert.equal(u.ok, true, u.erro);
  const f = u.funil;
  assert.equal(f.leads, 5);
  assert.equal(f.viraramPaciente, 3); // Ana e Bruno pela conversa, Carla pelo contato do Kommo
  assert.equal(f.agendaram, 3);
  assert.equal(f.compareceram, 2);
  assert.equal(f.fecharamTratamento, 1);
  assert.equal(f.valorDosTratamentos, 1800);
  assert.deepEqual(f.cobertura, { comTelefoneOuVinculo: 4, semTelefoneNemVinculo: 1, semCasamento: 2 });
  assert.equal(f.porOrigem.Instagram.compareceram, 1);
  // a franquia no período inclui a Carla, que não passou pelo Kommo
  assert.equal(u.naFranquiaNoPeriodo.agendamentos, 3);
  assert.equal(u.naFranquiaNoPeriodo.compareceram, 2);
  assert.equal(u.naFranquiaNoPeriodo.tratamentosNovos, 1);
  assert.match(r.comoLer, /semCasamento/);
});

test('unidade só com Kommo: devolve os leads e avisa que não dá pra cruzar', async () => {
  const r = (await relatorioFunil(deps, { unidade: 'boituva', inicio: '2026-09-01', fim: '2026-09-30' })) as R;
  const u = r.porUnidade['doutor-hernia-boituva'];
  assert.equal(u.ok, true);
  assert.equal(u.leadsNoKommo, 4);
  assert.match(u.avisos[0], /sem token da franquia/);
});

test('várias unidades: a rede soma só as que cruzaram e diz quem ficou de fora', async () => {
  const r = (await relatorioFunil(deps, { unidade: ['serra', 'boituva'], inicio: '2026-09-01', fim: '2026-09-30' })) as R;
  assert.equal(r.rede.leads, 5);
  assert.deepEqual(r.rede.unidadesForaDoTotal, ['doutor-hernia-boituva']);
});

test('período: no máximo 92 dias e só os últimos 180 — recusado antes de ler', async () => {
  const antes = falsa.pedidos.length;
  await assert.rejects(relatorioFunil(deps, { unidade: 'serra', inicio: '2026-06-01', fim: '2026-09-30' }), /92 dias/);
  await assert.rejects(relatorioFunil(deps, { unidade: 'serra', inicio: '2026-03-01', fim: '2026-03-31' }), /últimos 180 dias/);
  assert.equal(falsa.pedidos.length, antes);
});

test('"todas" e mais de 4 unidades são recusados ANTES de ler qualquer coisa', async () => {
  const antes = falsa.pedidos.length;
  await assert.rejects(relatorioFunil(deps, { unidade: 'todas', inicio: '2026-09-01', fim: '2026-09-30' }), (e: Error) => e instanceof ErroDeEntrada && /até 4/.test(e.message));
  await assert.rejects(relatorioFunil(deps, { unidade: 'xpto', inicio: '2026-09-01', fim: '2026-09-30' }), /desconhecida/);
  assert.equal(falsa.pedidos.length, antes);
});

test('funil por CAMPANHA (campos do rastreio de anúncios no cartão)', async () => {
  const r = (await relatorioFunil(deps, { unidade: 'serra', inicio: '2026-09-01', fim: '2026-09-30', agruparPor: 'campanha' })) as R;
  const g = r.porUnidade['doutor-hernia-serra'].funil.porOrigem;
  assert.equal(r.agrupadoPor, 'campanha');
  assert.equal(g['LEADS | WPP'].compareceram, 1); // Ana
  assert.equal(g['TRÁFEGO | WPP'].compareceram, 0); // Bruno faltou
  assert.equal(g['(sem campanha)'].leads, 3);
});
