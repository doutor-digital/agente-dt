/**
 * Regras de 16/10/2026 no SINCRONIZADOR, de ponta a ponta, contra uma franquia FALSA local (HTTP) e um Kommo falso
 * (objeto que anota etiquetas, notas, tarefas, campos e etapas). O banco é trocado por memória. Nenhuma requisição sai
 * da máquina.
 *
 *  - decisão 1: dois pacientes no mesmo telefone → CONFLITO_FRANQUIA, nada gravado; a escolha da SDR destrava;
 *  - decisão 3: idClient → telefone → nome (o "CONFERIR falso" do cartão sem nome no título);
 *  - decisão 4: falta em retorno/sessão → nota + tarefa, uma vez;
 *  - decisão 2: a Sofia não tira o cartão do funil TRATAMENTO.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Unit } from '@prisma/client';

import { prisma } from './prisma.js';
import { _semearParaTeste, type Estado } from './automacoes-estado.js';
import { _semearCrmParaTeste } from './crm-compartilhado.js';
import { _interno, camposDaConta, carregarFunis, casarPacienteDoCartao, idClientDoLead, type CampoBruto, type ResumoSync } from './franquia-sync-worker.js';
import { TAG_CONFLITO } from './casamento-jornada.js';
import { recusaDoFunilTratamento } from './guarda-funil-tratamento.js';
import { normalizar } from './franquia-sync.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import type { SpineSchedule } from '../services/spine.service.js';

// ── o banco, em memória ─────────────────────────────────────────────────────────
type Alerta = { unitId: string; leadId: string; ruleKey: string; createdAt: Date };
let alertas: Alerta[] = [];
let simulacoes: Array<{ automacao: string; kommoLeadId: number; alvo: string; acao: string }> = [];
let vinculos: Array<{ unitId: string; kommoLeadId: number; spineIdClient: number | null; spineIdSchedule: number | null }> = [];

const casaRuleKey = (rk: string, f: unknown): boolean => {
  if (typeof f === 'string') return rk === f;
  const o = (f ?? {}) as { startsWith?: string; not?: string };
  return (!o.startsWith || rk.startsWith(o.startsWith)) && (o.not === undefined || rk !== o.not);
};
const casaAlerta = (a: Alerta, w: { unitId?: string; leadId?: string; ruleKey?: unknown }) =>
  (!w.unitId || a.unitId === w.unitId) && (!w.leadId || a.leadId === w.leadId) && (w.ruleKey === undefined || casaRuleKey(a.ruleKey, w.ruleKey));

function definir(nome: string, valor: unknown) {
  Object.defineProperty(prisma, nome, { value: valor, configurable: true });
}
definir('cardAlert', {
  findUnique: async ({ where }: { where: { unitId_leadId_ruleKey: { unitId: string; leadId: string; ruleKey: string } } }) =>
    alertas.find((a) => casaAlerta(a, where.unitId_leadId_ruleKey)) ?? null,
  findFirst: async ({ where }: { where: { unitId: string; leadId: string; ruleKey: unknown } }) =>
    [...alertas].reverse().find((a) => casaAlerta(a, where)) ?? null,
  findMany: async ({ where }: { where: { unitId: string; leadId?: string; ruleKey?: unknown } }) => alertas.filter((a) => casaAlerta(a, where)),
  upsert: async ({ where, create, update }: { where: { unitId_leadId_ruleKey: Alerta }; create: Alerta; update: Partial<Alerta> }) => {
    const atual = alertas.find((a) => casaAlerta(a, where.unitId_leadId_ruleKey));
    if (atual) Object.assign(atual, update);
    else alertas.push({ ...create, createdAt: create.createdAt ?? new Date() });
    return {};
  },
  deleteMany: async ({ where }: { where: { unitId: string; leadId: string; ruleKey: unknown } }) => {
    alertas = alertas.filter((a) => !casaAlerta(a, where));
    return { count: 0 };
  },
  create: async ({ data }: { data: Alerta }) => alertas.push({ ...data, createdAt: new Date() }),
});
definir('spineLeadLink', {
  findFirst: async ({ where }: { where: { unitId: string; kommoLeadId?: number | { in: number[] }; spineIdSchedule?: unknown; spineIdClient?: unknown } }) => {
    if (where.spineIdSchedule !== undefined) {
      const f = where.spineIdSchedule as number | { in: number[] };
      const ids = typeof f === 'number' ? [f] : f.in;
      return vinculos.find((v) => v.unitId === where.unitId && v.spineIdSchedule !== null && ids.includes(v.spineIdSchedule) && (where.kommoLeadId === undefined || v.kommoLeadId === where.kommoLeadId)) ?? null;
    }
    return vinculos.find((v) => v.unitId === where.unitId && v.kommoLeadId === where.kommoLeadId && v.spineIdClient) ?? null;
  },
  findMany: async ({ where }: { where: { unitId: string; kommoLeadId: { in: number[] } } }) =>
    vinculos.filter((v) => v.unitId === where.unitId && where.kommoLeadId.in.includes(v.kommoLeadId) && v.spineIdClient),
  findUnique: async () => null,
});
definir('automacaoSimulacao', {
  upsert: async ({ create }: { create: { automacao: string; kommoLeadId: number; alvo: string; acao: string } }) => {
    simulacoes.push(create);
    return {};
  },
  deleteMany: async () => ({ count: 0 }),
});
definir('unitAutomacao', { findMany: async () => [] });
definir('unitCrmCompartilhado', { findMany: async () => [] });

// ── a franquia falsa ────────────────────────────────────────────────────────────
let agendaFalsa: Array<Record<string, unknown>> = [];
let clientesFalsos: Array<{ idClient: number; name: string; whatsapp: string }> = [];
let fichasFalsas = new Map<number, Record<string, unknown>>();
let chamadasFranquia: string[] = [];
let servidor: http.Server;
let base = '';

before(async () => {
  servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => (corpo += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      chamadasFranquia.push(`${req.method} ${req.url}`);
      const ficha = /^\/api\/clients\/(\d+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && ficha) {
        res.end(JSON.stringify({ data: { data: fichasFalsas.get(Number(ficha[1])) ?? null } }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/schedules/search') {
        res.end(JSON.stringify({ data: { data: agendaFalsa, totalPages: 1, total: agendaFalsa.length } }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/treatments/search') {
        res.end(JSON.stringify({ data: { data: [], totalPages: 1 } }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/clients/search') {
        const termo = normalizar(String((JSON.parse(corpo || '{}') as { name?: string }).name ?? ''));
        res.end(JSON.stringify({ data: { data: clientesFalsos.filter((c) => normalizar(c.name).includes(termo)) } }));
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

let seqUnidade = 0;
const SLUG = 'acailandia-teste';
const unidade = () => ({ id: `u1610-${++seqUnidade}`, slug: SLUG, name: 'Açailândia (teste)', spineBaseUrl: base, spineToken: 'token-falso', spineTimezone: 'America/Sao_Paulo', spineEnabled: true }) as unknown as Unit;

function chaves(estado: Estado, extra: Array<{ automacao: string; estado: Estado }> = []) {
  _semearParaTeste([{ slug: SLUG, automacao: 'casamento-jornada', estado }, ...extra.map((e) => ({ slug: SLUG, ...e }))]);
}

beforeEach(() => {
  alertas = [];
  simulacoes = [];
  vinculos = [];
  chamadasFranquia = [];
  agendaFalsa = [];
  clientesFalsos = [];
  fichasFalsas = new Map();
  _semearCrmParaTeste([]);
});

// ── o Kommo falso ───────────────────────────────────────────────────────────────
const ID = { DATA: 1, SITUACAO: 2, IDCLIENT: 3, FISIO: 4 };
const CAMPOS_BRUTOS: CampoBruto[] = [
  { id: ID.DATA, name: '◷ Data da Consulta', type: 'date' },
  { id: ID.SITUACAO, name: '✓ Situação da consulta', type: 'select', enums: ['Agendado', 'Confirmado', 'Atendido', 'Não compareceu', 'Remarcado', 'Desmarcado'].map((value, i) => ({ id: 20 + i, value })) },
  { id: ID.IDCLIENT, name: '⚙ idClient (franquia)', type: 'numeric' },
  { id: ID.FISIO, name: '⚕ Fisioterapeuta', type: 'select', enums: [] },
];
const CAMPOS = camposDaConta(CAMPOS_BRUTOS);
const FONE = '+5599991234567';

const PIPES = [
  { id: 10, name: 'COMERCIAL', is_main: true, statuses: [
    { id: 101, name: 'Incoming leads' }, { id: 102, name: 'EM QUALIFICAÇÃO' }, { id: 103, name: 'EM ESPERA' }, { id: 104, name: 'CONFERIR NA FRANQUIA' },
    { id: 105, name: 'AGENDADO' }, { id: 106, name: 'NÃO COMPARECEU' }, { id: 107, name: 'COMPARECEU' }, { id: 108, name: 'EM NEGOCIAÇÃO' },
    { id: 109, name: 'RETORNO PÓS-TRATAMENTO' }, { id: 142, name: 'GANHO / CONCLUIDO' }, { id: 143, name: 'PERDIDO' },
  ] },
  { id: 20, name: 'TRATAMENTO', statuses: [{ id: 201, name: 'Incoming leads' }, { id: 202, name: 'EM TRATAMENTO' }, { id: 142, name: 'ALTA' }, { id: 143, name: 'TRATAMENTO CANCELADO' }] },
];

interface Cartao { id: number; name: string; pipeline_id: number; status_id: number; campos: Record<number, unknown>; tags: string[]; contato: number; fone: string }
function kommoFalso(cartoes: Cartao[]) {
  const reg = {
    gravacoes: [] as Array<{ leadId: number; campo: number; valor: unknown }>,
    etiquetas: [] as Array<{ leadId: number; tags: string[] }>,
    tirou: [] as Array<{ leadId: number; tag: string }>,
    notas: [] as Array<{ leadId: number; texto: string }>,
    tarefas: [] as Array<{ leadId: number; text: string }>,
    movidos: [] as Array<{ leadId: number; statusId: number; pipelineId?: number }>,
  };
  const comoLead = (c: Cartao): KommoLead => ({
    id: c.id, name: c.name, pipeline_id: c.pipeline_id, status_id: c.status_id, updated_at: Math.floor(Date.now() / 1000), responsible_user_id: 9,
    custom_fields_values: Object.entries(c.campos).map(([k, v]) => ({ field_id: Number(k), values: [{ value: v }] })),
    _embedded: { tags: c.tags.map((name, i) => ({ id: i + 1, name })), contacts: [{ id: c.contato, is_main: true }] },
  });
  const achar = (id: number) => cartoes.find((c) => c.id === id) as Cartao;
  const kommo = {
    listLeadCustomFields: async () => ({ _embedded: { custom_fields: CAMPOS_BRUTOS } }),
    listPipelines: async () => PIPES,
    getLead: async (id: number) => comoLead(achar(id)),
    listLeadsPorTelefone: async (f: string) => cartoes.filter((c) => c.fone.replace(/\D/g, '').endsWith(f.replace(/\D/g, '').slice(-8))).map(comoLead),
    getContactPhone: async (contato: number) => cartoes.find((c) => c.contato === contato)?.fone ?? null,
    listLeadsPorEtapa: async (pipelineId: number, statusId: number, _l: number, page: number) =>
      page > 1 ? [] : cartoes.filter((c) => c.pipeline_id === pipelineId && c.status_id === statusId).map(comoLead),
    setLeadCustomFieldValue: async (leadId: number, campo: number, _t: string, valor: unknown) => { reg.gravacoes.push({ leadId, campo, valor }); achar(leadId).campos[campo] = valor; },
    clearLeadCustomField: async (leadId: number, campo: number) => { reg.gravacoes.push({ leadId, campo, valor: null }); },
    addTag: async ({ leadId, tags }: { leadId: number; tags: string[] }) => { reg.etiquetas.push({ leadId, tags }); achar(leadId).tags.push(...tags); },
    removeTag: async (leadId: number, tag: string) => { reg.tirou.push({ leadId, tag }); achar(leadId).tags = achar(leadId).tags.filter((t) => t !== tag); },
    addLeadNote: async (leadId: number, texto: string) => { reg.notas.push({ leadId, texto }); return { id: 1 }; },
    createTask: async (a: { leadId: number; text: string }) => { reg.tarefas.push({ leadId: a.leadId, text: a.text }); return { id: 1 }; },
    moveStage: async (m: { leadId: number; statusId: number; pipelineId?: number }) => { reg.movidos.push(m); const c = achar(m.leadId); c.status_id = m.statusId; if (m.pipelineId) c.pipeline_id = m.pipelineId; },
  } as unknown as KommoClient;
  return { kommo, reg };
}

const diaLocal = (dias: number) => {
  const d = new Date(Date.now() + dias * 86_400_000);
  d.setUTCHours(13, 0, 0, 0); // 10h em São Paulo
  return d.toISOString();
};

/** O cenário do cartão 1292772: MARIA e JOSE dividem o WhatsApp; os dois têm avaliação marcada; o Kommo tem UM cartão. */
function doisPacientesNoMesmoTelefone(cartao: Partial<Cartao> = {}) {
  clientesFalsos = [
    { idClient: 101, name: 'MARIA TESTE', whatsapp: FONE },
    { idClient: 202, name: 'JOSE TESTE', whatsapp: '(99) 99123-4567' },
  ];
  agendaFalsa = [
    { idSchedule: 9001, idStatus: 37, statusName: 'Agendado', clientName: 'MARIA TESTE', categoryName: 'AVALIAÇÃO', dateAttendance: diaLocal(2) },
    { idSchedule: 9002, idStatus: 37, statusName: 'Agendado', clientName: 'JOSE TESTE', categoryName: 'AVALIAÇÃO', dateAttendance: diaLocal(3) },
  ];
  return kommoFalso([{ id: 555, name: 'MARIA TESTE', pipeline_id: 10, status_id: 105, campos: {}, tags: [], contato: 77, fone: FONE, ...cartao }]);
}

// ── decisão 1 ───────────────────────────────────────────────────────────────────

test('decisão 1 — desligado: os dois pacientes gravam no mesmo cartão, como sempre (o problema de Petrópolis)', async () => {
  chaves('desligado');
  const { kommo, reg } = doisPacientesNoMesmoTelefone();
  await _interno.sincronizarUnidade(unidade(), { kommo });
  const datas = reg.gravacoes.filter((g) => g.leadId === 555 && g.campo === ID.DATA);
  assert.equal(datas.length, 2, 'a data da consulta foi gravada pelos dois');
  assert.deepEqual(reg.etiquetas, []);
});

test('decisão 1 — ligado: nada é gravado; CONFLITO_FRANQUIA + nota uma vez; os candidatos ficam guardados para o widget', async () => {
  chaves('ligado');
  const unit = unidade();
  const { kommo, reg } = doisPacientesNoMesmoTelefone();
  const r = (await _interno.sincronizarUnidade(unit, { kommo })) as ResumoSync;
  assert.deepEqual(reg.gravacoes, [], 'nenhum campo gravado');
  assert.deepEqual(reg.etiquetas, [{ leadId: 555, tags: [TAG_CONFLITO] }]);
  assert.equal(reg.notas.length, 1);
  assert.match(reg.notas[0].texto, /101/);
  assert.match(reg.notas[0].texto, /202/);
  assert.equal(r.conflitosDeTelefone, 1);
  assert.ok(alertas.some((a) => a.leadId === '555' && a.ruleKey === 'conflito-franquia:101,202'));

  // segunda varredura: o cartão já tem a etiqueta — nada de nota nova, nada gravado
  await _interno.sincronizarUnidade(unit, { kommo });
  assert.equal(reg.notas.length, 1);
  assert.equal(reg.etiquetas.length, 1);
  assert.deepEqual(reg.gravacoes, []);
});

test('decisão 1 — depois da escolha da SDR (⚙ idClient no cartão): só o escolhido grava, o outro é recusado calado', async () => {
  chaves('ligado');
  const unit = unidade();
  const { kommo, reg } = doisPacientesNoMesmoTelefone({ campos: { [ID.IDCLIENT]: 101 } });
  alertas.push({ unitId: unit.id, leadId: '555', ruleKey: 'paciente-escolhido:101', createdAt: new Date() });
  await _interno.sincronizarUnidade(unit, { kommo });
  const datas = reg.gravacoes.filter((g) => g.leadId === 555 && g.campo === ID.DATA);
  assert.equal(datas.length, 1, 'só a MARIA (101) gravou');
  assert.deepEqual(reg.etiquetas, [], 'não pergunta de novo');
  assert.deepEqual(reg.notas, []);
});

test('decisão 1 — cartão com dono: o outro paciente que chegou sem idClient (pelo vínculo da agenda) também não grava', async () => {
  chaves('ligado');
  const unit = unidade();
  const { kommo, reg } = doisPacientesNoMesmoTelefone({ campos: { [ID.IDCLIENT]: 101 } });
  clientesFalsos = clientesFalsos.filter((c) => c.idClient === 101); // a franquia não acha o JOSE pelo nome
  vinculos.push({ unitId: unit.id, kommoLeadId: 555, spineIdClient: null, spineIdSchedule: 9002 });
  alertas.push({ unitId: unit.id, leadId: '555', ruleKey: 'paciente-escolhido:101', createdAt: new Date() });
  await _interno.sincronizarUnidade(unit, { kommo });
  assert.equal(reg.gravacoes.filter((g) => g.leadId === 555 && g.campo === ID.DATA).length, 1, 'só a MARIA gravou');
});

test('decisão 1 — só no papel: grava como sempre e a tela mostra "etiquetaria"', async () => {
  chaves('seco');
  const { kommo, reg } = doisPacientesNoMesmoTelefone();
  await _interno.sincronizarUnidade(unidade(), { kommo });
  assert.equal(reg.gravacoes.filter((g) => g.campo === ID.DATA).length, 2);
  assert.deepEqual(reg.etiquetas, []);
  assert.ok(simulacoes.some((s) => s.automacao === 'casamento-jornada' && s.acao === 'etiquetaria' && s.alvo === TAG_CONFLITO));
});

// ── decisão 3 ───────────────────────────────────────────────────────────────────

test('decisão 3 — o ⚙ idClient do cartão casa sem nenhuma chamada à franquia', async () => {
  const { kommo } = kommoFalso([{ id: 1, name: 'Lead 16/10/2026', pipeline_id: 10, status_id: 105, campos: {}, tags: [], contato: 1, fone: FONE }]);
  const r = await casarPacienteDoCartao(unidade(), 1, 'Lead 16/10/2026', { kommo, contatoId: 1, idDoCartao: 4321, campos: CAMPOS });
  assert.deepEqual(r, { tipo: 'achou', idClient: 4321, por: 'idClient' });
  assert.deepEqual(chamadasFranquia, []);
});

test('decisão 3 — cartão sem nome no título: o telefone acha o paciente pelo cartão irmão (antes ia pra CONFERIR)', async () => {
  const unit = unidade();
  const { kommo } = kommoFalso([
    { id: 1, name: 'Lead 16/10/2026', pipeline_id: 10, status_id: 104, campos: {}, tags: [], contato: 1, fone: FONE },
    { id: 2, name: 'ANA ANTIGA', pipeline_id: 20, status_id: 142, campos: { [ID.IDCLIENT]: 4321 }, tags: [], contato: 2, fone: '(99) 99123-4567' },
  ]);
  assert.equal(await idClientDoLead(unit, 1, 'Lead 16/10/2026', { kommo, contatoId: 1 }), null, 'regra antiga: não acha');
  assert.deepEqual(await casarPacienteDoCartao(unit, 1, 'Lead 16/10/2026', { kommo, contatoId: 1, campos: CAMPOS }), { tipo: 'achou', idClient: 4321, por: 'telefone' });
});

test('decisão 3 — o vínculo da Sofia é idClient também (vem antes da busca)', async () => {
  const unit = unidade();
  vinculos.push({ unitId: unit.id, kommoLeadId: 3, spineIdClient: 999, spineIdSchedule: null });
  const { kommo } = kommoFalso([{ id: 3, name: 'MARIA TESTE', pipeline_id: 10, status_id: 105, campos: {}, tags: [], contato: 3, fone: FONE }]);
  assert.deepEqual(await casarPacienteDoCartao(unit, 3, 'MARIA TESTE', { kommo, contatoId: 3, campos: CAMPOS }), { tipo: 'achou', idClient: 999, por: 'idClient' });
  assert.deepEqual(chamadasFranquia, []);
});

test('decisão 3 — revisão: cartão "Lead dd/mm" com ⚙ idClient não vai mais pra CONFERIR (o CONFERIR falso)', async () => {
  const montar = () => {
    fichasFalsas = new Map([[4321, { idClient: 4321, name: 'ANA', whatsapp: FONE, schedules: [{ idSchedule: 1, idStatus: 42, statusName: 'Atendido', category: 'AVALIAÇÃO', dateAttendance: diaLocal(-10) }], treatments: [] }]]);
    return kommoFalso([{ id: 7, name: 'Lead 01/10/2026', pipeline_id: 10, status_id: 105, campos: { [ID.IDCLIENT]: 4321, [ID.DATA]: String(Math.floor(Date.now() / 1000) - 20 * 86_400) }, tags: [], contato: 7, fone: FONE }]);
  };
  const revisar = async (estado: Estado) => {
    chaves(estado, [{ automacao: 'franquia-revisao', estado: 'ligado' }, { automacao: 'franquia-move', estado: 'ligado' }]);
    const { kommo, reg } = montar();
    const unit = unidade();
    const funis = await carregarFunis(kommo);
    const resumo: ResumoSync = { unit: SLUG, em: '', agendamentos: 0, tratamentos: 0, pacientes: 0, comLead: 0, semLead: 0, escritas: 0, erros: 0, exemplosSemLead: [], movimentos: 0, revisados: 0 };
    await _interno.revisarPeloHistorico({
      unit, kommo, funis, mapa: _interno.mapearCampos(CAMPOS_BRUTOS), ops: { fisio: [], categoria: [], tratamento: [] }, agoraEpoch: Math.floor(Date.now() / 1000),
      resumo, camposPorNome: CAMPOS, jornada: estado,
    } as Parameters<typeof _interno.revisarPeloHistorico>[0]);
    return reg.movidos;
  };
  const antes = await revisar('desligado');
  assert.deepEqual(antes.map((m) => m.statusId), [104], 'regra antiga: CONFERIR NA FRANQUIA');
  const depois = await revisar('ligado');
  assert.ok(!depois.some((m) => m.statusId === 104), 'regra nova: não vai pra CONFERIR');
  assert.deepEqual(depois.map((m) => m.statusId), [108], 'atendida há 10 d sem tratamento: EM NEGOCIAÇÃO');
});

// ── decisão 4 ───────────────────────────────────────────────────────────────────

function faltaEmSessao(): SpineSchedule {
  return {
    idSchedule: 8080, idTreatment: null, idStatus: 40, statusName: 'Não compareceu', clientName: 'X', categoryName: 'PROTOCOLO 03 MESES - LOMBAR',
    physicalTherapist: null, dateAttendanceUtc: new Date(Date.now() - 5 * 3600_000).toISOString(), dateAttendanceLocal: null, dayLocal: '2026-10-16', timeLocal: '08:00',
    isBusy: true, requiresManualValidation: false,
  };
}

async function avisar(estado: Estado) {
  const unit = unidade();
  const { kommo, reg } = kommoFalso([{ id: 50, name: 'PACIENTE', pipeline_id: 20, status_id: 202, campos: {}, tags: [], contato: 50, fone: FONE }]);
  const lead = await kommo.getLead(50);
  const resumo: ResumoSync = { unit: SLUG, em: '', agendamentos: 0, tratamentos: 0, pacientes: 0, comLead: 0, semLead: 0, escritas: 0, erros: 0, exemplosSemLead: [], movimentos: 0, revisados: 0 };
  const ctx = { unit, kommo, funis: null, mapa: {}, ops: { fisio: [], categoria: [], tratamento: [] }, agoraEpoch: Math.floor(Date.now() / 1000), resumo, camposPorNome: CAMPOS, jornada: estado } as Parameters<typeof _interno.avisarFaltas>[0];
  return { ctx, lead, reg, unit };
}

test('decisão 4 — ligado: falta em sessão vira UMA tarefa + nota; a varredura seguinte não repete', async () => {
  const { ctx, lead, reg } = await avisar('ligado');
  await _interno.avisarFaltas(ctx, 50, lead, 'EM TRATAMENTO', [faltaEmSessao()]);
  await _interno.avisarFaltas(ctx, 50, lead, 'EM TRATAMENTO', [faltaEmSessao()]);
  assert.equal(reg.tarefas.length, 1);
  assert.match(reg.tarefas[0].text, /sessão/);
  assert.equal(reg.notas.length, 1);
  assert.deepEqual(reg.movidos, [], 'a etapa não muda');
});

test('decisão 4 — só no papel registra "alertaria"; desligado não faz nada', async () => {
  const seco = await avisar('seco');
  await _interno.avisarFaltas(seco.ctx, 50, seco.lead, 'EM TRATAMENTO', [faltaEmSessao()]);
  assert.equal(seco.reg.tarefas.length, 0);
  assert.ok(simulacoes.some((s) => s.acao === 'alertaria'));
  simulacoes = [];
  const desl = await avisar('desligado');
  await _interno.avisarFaltas(desl.ctx, 50, desl.lead, 'EM TRATAMENTO', [faltaEmSessao()]);
  assert.equal(desl.reg.tarefas.length, 0);
  assert.equal(simulacoes.length, 0);
});

// ── decisão 2: a guarda do funil TRATAMENTO ────────────────────────────────────

test('decisão 2 — ligado recusa a Sofia levar cartão do TRATAMENTO pro COMERCIAL; só no papel deixa e registra; desligado nem olha', async () => {
  const { kommo } = kommoFalso([
    { id: 60, name: 'EM TRATAMENTO', pipeline_id: 20, status_id: 202, campos: {}, tags: [], contato: 60, fone: FONE },
    { id: 61, name: 'COMERCIAL', pipeline_id: 10, status_id: 102, campos: {}, tags: [], contato: 61, fone: FONE },
  ]);
  const unit = unidade();
  chaves('ligado');
  assert.match((await recusaDoFunilTratamento(unit, kommo, 60, { tipo: 'etapa', statusId: 105 })) ?? '', /TRATAMENTO/);
  assert.equal(await recusaDoFunilTratamento(unit, kommo, 60, { tipo: 'etapa', statusId: 202 }), null, 'dentro do funil pode');
  assert.equal(await recusaDoFunilTratamento(unit, kommo, 61, { tipo: 'etapa', statusId: 105 }), null, 'cartão do comercial: livre');
  chaves('seco');
  assert.equal(await recusaDoFunilTratamento(unit, kommo, 60, { tipo: 'fechar', ganho: false }), null);
  assert.ok(simulacoes.some((s) => s.acao === 'pularia'));
  chaves('desligado');
  assert.equal(await recusaDoFunilTratamento(unit, kommo, 60, { tipo: 'funil', pipelineId: 10 }), null);
});
