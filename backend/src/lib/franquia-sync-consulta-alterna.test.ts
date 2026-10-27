/**
 * Defeito de 24/10/2026 (Açailândia, lead 26366662): "Situação", "Categoria", "Compareceu" e "Data da Consulta"
 * alternavam entre varreduras (Atendido/Avaliação/Sim ↔ Desmarcado/Retorno/vazio), com `erros: 0`.
 *
 * Causa: DOIS chamadores do mesmo escritor (`processarCartao`) liam a consulta de FONTES diferentes —
 *   - a varredura, da janela da agenda (D-3…D+45): só enxerga o retorno de hoje, DESMARCADO;
 *   - a revisão pelo histórico, da ficha inteira: enxerga também a avaliação ATENDIDA de 17/10.
 * `escolherConsulta` ("a mais recente que não foi desmarcada") dava respostas opostas para cada uma, e a Situação
 * gravada pela varredura (≠ Atendido) é justamente o que põe o cartão na lista da revisão — que desfaz.
 *
 * Aqui: franquia FALSA local (HTTP) + Kommo falso que APLICA as gravações no cartão (como o de verdade).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Unit } from '@prisma/client';

import { prisma } from './prisma.js';
import { _semearParaTeste } from './automacoes-estado.js';
import { _interno, camposDaConta, historicoDoPaciente, type CampoBruto, type ResumoSync } from './franquia-sync-worker.js';
import { escolherConsulta, escolherConsultaDaJanela } from './franquia-sync.js';
import { instanteNoFuso, somarDias } from '../services/spine.service.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import type { SpineSchedule } from '../services/spine.service.js';

// ── o banco, em memória: nenhum vínculo da IA ──────────────────────────────────
Object.defineProperty(prisma, 'spineLeadLink', { value: { findFirst: async () => null, findMany: async () => [] }, configurable: true });

// ── as chaves, em memória (sem banco): a tela do atendimento e os campos da SDR ficam fora deste teste ──
_semearParaTeste([
  { slug: 'acailandia-teste', automacao: 'franquia-tela', estado: 'desligado' },
  { slug: 'acailandia-teste', automacao: 'campos-sdr', estado: 'desligado' },
  { slug: 'acailandia-teste', automacao: 'franquia-sessoes', estado: 'desligado' },
]);

// ── a franquia falsa: a ficha do paciente (GET /api/clients/:id), com a contagem de leituras ──
const fichas = new Map<number, Array<Record<string, unknown>>>();
let leituras: number[] = [];
let servidor: http.Server;
let base = '';
before(async () => {
  servidor = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const m = /^\/api\/clients\/(\d+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && m) {
      const id = Number(m[1]);
      leituras.push(id);
      res.end(JSON.stringify({ data: { data: { idClient: id, name: 'PACIENTE TESTE', whatsapp: '5599999999999', schedules: fichas.get(id) ?? [], treatments: [] } } }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
after(() => servidor.close());

let seq = 0;
const unidade = () => ({ id: `unidade-alterna-${++seq}`, slug: 'acailandia-teste', name: 'Teste', spineBaseUrl: base, spineToken: 'token-falso', spineTimezone: 'America/Sao_Paulo' }) as unknown as Unit;

// ── a conta do Kommo ────────────────────────────────────────────────────────────
const ID = { DATA: 1, SITUACAO: 2, COMPARECEU: 3, CATEGORIA: 4, FISIO: 5 };
const CAMPOS_BRUTOS: CampoBruto[] = [
  { id: ID.DATA, name: '◷ Data da Consulta', type: 'date' },
  { id: ID.SITUACAO, name: '✓ Situação da consulta', type: 'select', enums: [{ id: 21, value: 'Agendado' }, { id: 22, value: 'Atendido' }, { id: 23, value: 'Desmarcado' }, { id: 24, value: 'Não compareceu' }] },
  { id: ID.COMPARECEU, name: '✓ Compareceu', type: 'select', enums: [{ id: 31, value: 'Sim' }, { id: 32, value: 'Não' }] },
  { id: ID.CATEGORIA, name: '⌂ Categoria da consulta', type: 'select', enums: [{ id: 41, value: 'Avaliação' }, { id: 42, value: 'Retorno' }] },
  { id: ID.FISIO, name: '⚕ Fisioterapeuta', type: 'select', enums: [{ id: 51, value: 'DRA. ANA LIMA' }] },
];
const CAMPOS = camposDaConta(CAMPOS_BRUTOS);
const NOME_DO_CAMPO = new Map(CAMPOS_BRUTOS.map((c) => [c.id, c]));

/** Kommo que guarda o valor gravado — assim a varredura seguinte lê o que a anterior escreveu. */
function kommoQueGuarda() {
  const campos = new Map<number, string>();
  const gravacoes: Array<{ campo: string; valor: string }> = [];
  const lead = (): KommoLead => ({
    id: 26366662,
    name: 'PACIENTE TESTE',
    custom_fields_values: [...campos].map(([field_id, v]) => ({ field_id, values: [{ value: v }] })),
    _embedded: { tags: [] },
  }) as unknown as KommoLead;
  const kommo = {
    setLeadCustomFieldValue: async (_lead: number, campo: number, _tipo: string, valor: unknown) => {
      campos.set(campo, String(valor));
      gravacoes.push({ campo: NOME_DO_CAMPO.get(campo)!.name, valor: String(valor) });
    },
    clearLeadCustomField: async (_lead: number, campo: number) => {
      campos.delete(campo);
      gravacoes.push({ campo: NOME_DO_CAMPO.get(campo)!.name, valor: '(limpar)' });
    },
    addTag: async () => {},
    addLeadNote: async () => ({ id: 1 }),
  } as unknown as KommoClient;
  return { kommo, lead, gravacoes, campos };
}

const TZ = 'America/Sao_Paulo';
const sched = (idSchedule: number, categoria: string, idStatus: number, iso: string): SpineSchedule => ({
  idSchedule, idTreatment: null, idStatus, statusName: null, clientName: 'PACIENTE TESTE', categoryName: categoria, physicalTherapist: null,
  dateAttendanceUtc: iso, dateAttendanceLocal: null, dayLocal: instanteNoFuso(new Date(iso), TZ).slice(0, 10), timeLocal: null, isBusy: true, requiresManualValidation: false,
});
const raw = (s: SpineSchedule) => ({ idSchedule: s.idSchedule, dateAttendance: s.dateAttendanceUtc, category: s.categoryName, idStatus: s.idStatus });

// O caso do 26366662: avaliação ATENDIDA há 7 dias (fora da janela D-3) + retorno de hoje DESMARCADO (dentro dela).
const hoje = Date.now();
const iso = (diasDepois: number) => new Date(hoje + diasDepois * 86_400_000).toISOString();
const AVALIACAO_ATENDIDA = sched(1001, 'AVALIAÇÃO', 42, iso(-7));
const RETORNO_DESMARCADO = sched(1002, 'RETORNO', 57, iso(0));
const JANELA = [RETORNO_DESMARCADO];
const NA_FICHA = [AVALIACAO_ATENDIDA, RETORNO_DESMARCADO];

function varredura(unit: Unit, kommo: KommoClient) {
  const resumo: ResumoSync = { unit: unit.slug, em: '', agendamentos: 0, tratamentos: 0, pacientes: 0, comLead: 0, semLead: 0, escritas: 0, erros: 0, exemplosSemLead: [], movimentos: 0, revisados: 0 };
  return {
    unit, kommo, funis: null, mapa: _interno.mapearCampos(CAMPOS_BRUTOS), ops: { fisio: ['DRA. ANA LIMA'], categoria: ['Avaliação', 'Retorno'], tratamento: [] },
    agoraEpoch: Math.floor(Date.now() / 1000), resumo, camposPorNome: CAMPOS,
  } as Parameters<typeof _interno.processarCartao>[0];
}

type Quem = 'varredura' | 'revisao';
/** Um dos dois chamadores de `processarCartao`, exatamente como `sincronizarUnidade` e `revisarPeloHistorico` o chamam. */
async function chamar(quem: Quem, unit: Unit, kommo: KommoClient, lead: KommoLead, idClient: number) {
  const ctx = varredura(unit, kommo);
  if (quem === 'varredura') {
    // a agenda não traz idClient: só o que o casamento provou (`idsClient`) chega
    await _interno.processarCartao(ctx, lead.id, lead, { nome: 'PACIENTE TESTE', idClient: null, consultas: JANELA, tratamento: null, idsClient: [idClient] });
  } else {
    const hist = await historicoDoPaciente(unit, idClient);
    assert.ok(hist, 'a ficha tem de vir');
    await _interno.processarCartao(ctx, lead.id, lead, { nome: 'PACIENTE TESTE', idClient, consultas: hist.schedules, tratamento: null }, hist);
  }
}

const HOJE = instanteNoFuso(new Date(), TZ).slice(0, 10);
const DE = somarDias(HOJE, -3);
const ATE = somarDias(HOJE, 45);

test('escolherConsultaDaJanela: o que a janela tem, vale a janela; o histórico só responde se ela estiver vazia', () => {
  assert.equal(escolherConsulta(NA_FICHA)?.idSchedule, 1001, 'a regra antiga sobre a ficha inteira: a atendida (era a discordância)');
  assert.equal(escolherConsultaDaJanela(NA_FICHA, DE, ATE)?.idSchedule, 1002, 'janela com a desmarcada de hoje: a mesma que a varredura escolhe');
  assert.equal(escolherConsulta(JANELA)?.idSchedule, 1002, '(e é a escolha da varredura, que só vê a janela)');
  // janela vazia: é para isso que a revisão existe
  assert.equal(escolherConsultaDaJanela([AVALIACAO_ATENDIDA], DE, ATE)?.idSchedule, 1001);
  // dentro da janela vale a regra de sempre: a viva ganha da desmarcada
  const futura = sched(1004, 'AVALIAÇÃO', 37, iso(3));
  assert.equal(escolherConsultaDaJanela([...NA_FICHA, futura], DE, ATE)?.idSchedule, 1004);
  // uma sessão de tratamento na janela não é consulta: a janela "não tem" e o histórico responde
  const sessao = sched(1005, 'PROTOCOLO 03 MESES - LOMBAR', 37, iso(1));
  assert.equal(escolherConsultaDaJanela([AVALIACAO_ATENDIDA, sessao], DE, ATE)?.idSchedule, 1001);
  // a borda: D-3 entra (como no pedido à agenda), D-4 não
  const noD3 = sched(1006, 'AVALIAÇÃO', 42, iso(-3));
  const noD4 = sched(1007, 'AVALIAÇÃO', 42, iso(-4));
  assert.equal(escolherConsultaDaJanela([noD3, RETORNO_DESMARCADO], DE, ATE)?.idSchedule, 1006, 'D-3 está na janela: a viva ganha');
  assert.equal(escolherConsultaDaJanela([noD4, RETORNO_DESMARCADO], DE, ATE)?.idSchedule, 1002, 'D-4 está fora: vale a janela');
  assert.equal(escolherConsultaDaJanela([], DE, ATE), null);
});

test('varredura e revisão se alternando, 6 passadas: o cartão não muda de valor depois da 1ª (antes do conserto alternava)', async () => {
  fichas.set(26366662, NA_FICHA.map(raw));
  const unit = unidade();
  const { kommo, lead, gravacoes, campos } = kommoQueGuarda();
  const ordem: Quem[] = ['varredura', 'revisao', 'varredura', 'revisao', 'varredura', 'revisao'];
  const aposCada: string[] = [];
  for (const quem of ordem) {
    await chamar(quem, unit, kommo, lead(), 26366662);
    aposCada.push(`${campos.get(ID.SITUACAO)}/${campos.get(ID.CATEGORIA)}/${campos.get(ID.COMPARECEU) ?? '-'}`);
  }
  assert.deepEqual(aposCada, Array(6).fill('Desmarcado/Retorno/-'), 'o mesmo valor depois de cada passada');
  // todas as escritas vieram na 1ª passada; da 2ª em diante, nenhuma
  const porCampo = new Map<string, number>();
  for (const g of gravacoes) porCampo.set(g.campo, (porCampo.get(g.campo) ?? 0) + 1);
  for (const [campo, n] of porCampo) assert.equal(n, 1, `${campo} gravado ${n}× em 6 passadas`);
  assert.equal(gravacoes.some((g) => g.valor === 'Atendido' || g.valor === 'Avaliação'), false, 'a avaliação antiga nunca sobrescreveu a janela');
});

test('a ordem não importa: revisão primeiro, depois a varredura — mesmo cartão no fim e nenhuma regravação', async () => {
  fichas.set(26366666, NA_FICHA.map(raw));
  const unit = unidade();
  const { kommo, lead, gravacoes, campos } = kommoQueGuarda();
  for (const quem of ['revisao', 'varredura', 'revisao', 'varredura'] as Quem[]) await chamar(quem, unit, kommo, lead(), 26366666);
  assert.equal(`${campos.get(ID.SITUACAO)}/${campos.get(ID.CATEGORIA)}`, 'Desmarcado/Retorno');
  const porCampo = new Map<string, number>();
  for (const g of gravacoes) porCampo.set(g.campo, (porCampo.get(g.campo) ?? 0) + 1);
  for (const [campo, n] of porCampo) assert.equal(n, 1, `${campo} gravado ${n}×`);
});

test('a revisão continua servindo quem a janela não vê: só a avaliação antiga na ficha → Atendido/Sim', async () => {
  fichas.set(26366667, [raw(AVALIACAO_ATENDIDA)]);
  const unit = unidade();
  const { kommo, lead, campos } = kommoQueGuarda();
  await chamar('revisao', unit, kommo, lead(), 26366667);
  assert.equal(campos.get(ID.SITUACAO), 'Atendido');
  assert.equal(campos.get(ID.COMPARECEU), 'Sim');
  assert.equal(campos.get(ID.CATEGORIA), 'Avaliação');
});

test('a varredura não ganhou chamada nenhuma à franquia (o conserto está só na escolha da revisão)', async () => {
  fichas.set(26366663, NA_FICHA.map(raw));
  leituras = [];
  const unit = unidade();
  const { kommo, lead } = kommoQueGuarda();
  for (let i = 0; i < 4; i++) await chamar('varredura', unit, kommo, lead(), 26366663);
  assert.deepEqual(leituras, [], 'nenhuma leitura de ficha na varredura');
});

test('a regra segue a ORIGEM das consultas, não a existência do histórico: janela + histórico no argumento continua sendo a regra da varredura', async () => {
  fichas.set(26366668, NA_FICHA.map(raw));
  const unit = unidade();
  const { kommo, lead, campos } = kommoQueGuarda();
  const hist = await historicoDoPaciente(unit, 26366668);
  assert.ok(hist);
  // consultas = a janela (outro array), histórico presente: a escolha é a da varredura (janela sozinha), não a da ficha
  await _interno.processarCartao(varredura(unit, kommo), lead().id, lead(), { nome: 'PACIENTE TESTE', idClient: 26366668, consultas: JANELA, tratamento: null }, hist);
  assert.equal(campos.get(ID.SITUACAO), 'Desmarcado');
});
