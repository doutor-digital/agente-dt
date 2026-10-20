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
let unidadesNoBanco: Unit[] = [];
definir('unit', { findUnique: async ({ where }: { where: { slug?: string; id?: string } }) => unidadesNoBanco.find((u) => u.slug === where.slug || u.id === where.id) ?? null, findMany: async () => [] });
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
        chamadasFranquia.push(`busca:${termo}`);
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
const ID = { DATA: 1, SITUACAO: 2, IDCLIENT: 3, FISIO: 4, UNIDADE: 5 };
const CAMPOS_BRUTOS: CampoBruto[] = [
  { id: ID.DATA, name: '◷ Data da Consulta', type: 'date' },
  { id: ID.SITUACAO, name: '✓ Situação da consulta', type: 'select', enums: ['Agendado', 'Confirmado', 'Atendido', 'Não compareceu', 'Remarcado', 'Desmarcado'].map((value, i) => ({ id: 20 + i, value })) },
  { id: ID.IDCLIENT, name: '⚙ idClient (franquia)', type: 'numeric' },
  { id: ID.FISIO, name: '⚕ Fisioterapeuta', type: 'select', enums: [] },
  { id: ID.UNIDADE, name: '⌂ Unidade de atendimento', type: 'select', enums: [{ id: 51, value: 'Petrópolis' }, { id: 52, value: 'Caxias' }] },
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
    custom_fields_values: Object.entries(c.campos).map(([k, v]) => ({ field_id: Number(k), field_name: CAMPOS_BRUTOS.find((f) => f.id === Number(k))?.name, values: [{ value: v }] })),
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

test('decisão 3 — a franquia não acha o paciente pelo título, e o cartão irmão (mesmo telefone, mesmo nome) sabe o idClient', async () => {
  const unit = unidade();
  const { kommo } = kommoFalso([
    { id: 1, name: 'Ana Antiga 16/10/2026', pipeline_id: 10, status_id: 104, campos: {}, tags: [], contato: 1, fone: FONE },
    { id: 2, name: 'ANA ANTIGA', pipeline_id: 20, status_id: 142, campos: { [ID.IDCLIENT]: 4321 }, tags: [], contato: 2, fone: '(99) 99123-4567' },
  ]);
  assert.equal(await idClientDoLead(unit, 1, 'Ana Antiga 16/10/2026', { kommo, contatoId: 1 }), null, 'regra antiga: não acha');
  assert.deepEqual(await casarPacienteDoCartao(unit, 1, 'Ana Antiga 16/10/2026', { kommo, contatoId: 1, campos: CAMPOS }), { tipo: 'achou', idClient: 4321, por: 'telefone' });
  // achado 2: título sem nome ("Lead 16/10/2026") não prova que é a mesma pessoa do irmão — fica como antes (CONFERIR)
  assert.equal((await casarPacienteDoCartao(unit, 1, 'Lead 16/10/2026', { kommo, contatoId: 1, campos: CAMPOS })).tipo, 'nenhum');
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

// ── resposta do João (16/10, à tarde): tira de PERDIDO/ALTA UMA vez; a equipe pôs de volta = fica + tarefa ──

async function cenarioDevolucao(cartao: Partial<Cartao>, p: { idClient: number | null; consultas: SpineSchedule[] }, ficha?: Record<string, unknown>) {
  const unit = unidade();
  if (ficha) fichasFalsas.set(Number(ficha.idClient), ficha);
  const { kommo, reg } = kommoFalso([{ id: 70, name: 'PACIENTE TESTE', pipeline_id: 10, status_id: 143, campos: {}, tags: [], contato: 70, fone: FONE, ...cartao }]);
  const funis = await carregarFunis(kommo);
  const resumo: ResumoSync = { unit: SLUG, em: '', agendamentos: 0, tratamentos: 0, pacientes: 0, comLead: 0, semLead: 0, escritas: 0, erros: 0, exemplosSemLead: [], movimentos: 0, revisados: 0 };
  const ctx = {
    unit, kommo, funis, mapa: _interno.mapearCampos(CAMPOS_BRUTOS), ops: { fisio: [], categoria: [], tratamento: [] }, agoraEpoch: Math.floor(Date.now() / 1000),
    resumo, camposPorNome: CAMPOS, jornada: undefined as Estado | undefined,
  } as Parameters<typeof _interno.processarCartao>[0];
  const rodar = async () => _interno.processarCartao(ctx, 70, await kommo.getLead(70), { nome: 'PACIENTE TESTE', idClient: p.idClient, consultas: p.consultas, tratamento: null });
  return { ctx, reg, rodar, kommo };
}

function marcada(idSchedule: number, categoria: string, dias: number): SpineSchedule {
  return {
    idSchedule, idTreatment: null, idStatus: 37, statusName: 'Agendado', clientName: 'PACIENTE TESTE', categoryName: categoria, physicalTherapist: null,
    dateAttendanceUtc: diaLocal(dias), dateAttendanceLocal: null, dayLocal: null, timeLocal: null, isBusy: true, requiresManualValidation: false,
  };
}

test('decisão 7 — PERDIDO com avaliação marcada: sai UMA vez (com nota); a SDR pôs de volta → fica e abre UMA tarefa', async () => {
  chaves('ligado', [{ automacao: 'franquia-move', estado: 'ligado' }]);
  const { ctx, reg, rodar, kommo } = await cenarioDevolucao({}, { idClient: null, consultas: [marcada(9101, 'AVALIAÇÃO', 3)] });
  ctx.jornada = 'ligado';
  await rodar();
  assert.deepEqual(reg.movidos.map((m) => m.statusId), [105], 'PERDIDO → AGENDADO');
  assert.equal(reg.notas.length, 1);
  assert.match(reg.notas[0].texto, /a franquia manda/);
  assert.ok(alertas.some((a) => a.leadId === '70' && a.ruleKey === 'franquia-manda:PERDIDO:consulta:9101'), 'a marca fica no banco');

  // a SDR põe de volta em PERDIDO, com a mesma consulta de pé na franquia
  await kommo.moveStage({ leadId: 70, statusId: 143, pipelineId: 10 });
  reg.movidos.length = 0;
  await rodar();
  await rodar();
  assert.deepEqual(reg.movidos, [], 'não insiste: os robôs da etapa não disparam de novo');
  assert.equal(reg.tarefas.length, 1, 'uma tarefa só, mesmo com duas varreduras');
  assert.match(reg.tarefas[0].text, /Conferir/);
  assert.equal(reg.notas.length, 1, 'sem nota nova');
});

test('decisão 7 — consulta NOVA (outro fato) tira do PERDIDO de novo', async () => {
  chaves('ligado', [{ automacao: 'franquia-move', estado: 'ligado' }]);
  const unitAntes = seqUnidade + 1;
  const { ctx, reg, rodar } = await cenarioDevolucao({}, { idClient: null, consultas: [marcada(9201, 'AVALIAÇÃO', 3)] });
  ctx.jornada = 'ligado';
  alertas.push({ unitId: `u1610-${unitAntes}`, leadId: '70', ruleKey: 'franquia-manda:PERDIDO:consulta:9100', createdAt: new Date() });
  await rodar();
  assert.deepEqual(reg.movidos.map((m) => m.statusId), [105]);
});

test('decisão 7 — ALTA com sessão marcada (tratamento em andamento): vai pra EM TRATAMENTO uma vez; de volta na ALTA → tarefa, sem mover', async () => {
  chaves('ligado', [{ automacao: 'franquia-move', estado: 'ligado' }]);
  const ficha = { idClient: 4321, name: 'PACIENTE TESTE', whatsapp: FONE, treatments: [{ idTreatment: 1, idStatus: 45, statusName: 'EM ANDAMENTO' }], schedules: [
    { idSchedule: 1, idStatus: 42, statusName: 'Atendido', category: 'PROTOCOLO 03 MESES - LOMBAR', dateAttendance: diaLocal(-20) },
    { idSchedule: 2, idStatus: 37, statusName: 'Agendado', category: 'PROTOCOLO 03 MESES - LOMBAR', dateAttendance: diaLocal(2) },
  ] };
  const { ctx, reg, rodar, kommo } = await cenarioDevolucao({ pipeline_id: 20, status_id: 142 }, { idClient: 4321, consultas: [] }, ficha);
  ctx.jornada = 'ligado';
  await rodar();
  assert.deepEqual(reg.movidos.map((m) => [m.pipelineId, m.statusId]), [[20, 202]], 'ALTA → EM TRATAMENTO');
  assert.equal(reg.notas.length, 1);
  await kommo.moveStage({ leadId: 70, statusId: 142, pipelineId: 20 });
  reg.movidos.length = 0;
  await rodar();
  assert.deepEqual(reg.movidos, []);
  assert.equal(reg.tarefas.length, 1);
});

test('decisão 7 — desligado: PERDIDO e ALTA continuam intocáveis', async () => {
  chaves('desligado', [{ automacao: 'franquia-move', estado: 'ligado' }]);
  const { ctx, reg, rodar } = await cenarioDevolucao({}, { idClient: null, consultas: [marcada(9301, 'AVALIAÇÃO', 3)] });
  ctx.jornada = 'desligado';
  await rodar();
  assert.deepEqual(reg.movidos, []);
  assert.deepEqual(reg.tarefas, []);
});

// ── resposta do João: mesmo nome + mesmo telefone em dois cadastros → o robô escolhe e deixa UMA nota ──

function duplicadoNaFranquia() {
  clientesFalsos = [
    { idClient: 11, name: 'ANA LIMA', whatsapp: FONE },
    { idClient: 12, name: 'ANA LIMA', whatsapp: '(99) 99123-4567' },
  ];
  agendaFalsa = [{ idSchedule: 9401, idStatus: 37, statusName: 'Agendado', clientName: 'ANA LIMA', categoryName: 'AVALIAÇÃO', dateAttendance: diaLocal(2) }];
  return kommoFalso([{ id: 556, name: 'ANA LIMA', pipeline_id: 10, status_id: 105, campos: {}, tags: [], contato: 56, fone: FONE }]);
}

test('cadastro duplicado — ligado: o robô segue gravando e deixa UMA nota pedindo para juntar os cadastros', async () => {
  chaves('ligado');
  const unit = unidade();
  const { kommo, reg } = duplicadoNaFranquia();
  await _interno.sincronizarUnidade(unit, { kommo });
  await _interno.sincronizarUnidade(unit, { kommo });
  const notas = reg.notas.filter((n) => /juntar os cadastros/.test(n.texto));
  assert.equal(notas.length, 1, 'uma vez só, mesmo com duas varreduras');
  assert.match(notas[0].texto, /11 e 12/);
  assert.deepEqual(reg.etiquetas, [], 'não é conflito: é a mesma pessoa');
  assert.ok(reg.gravacoes.some((g) => g.leadId === 556 && g.campo === ID.DATA), 'o cartão continua sendo atualizado');
});

test('cadastro duplicado — desligado não deixa nota; só no papel registra que deixaria', async () => {
  chaves('desligado');
  const a = duplicadoNaFranquia();
  await _interno.sincronizarUnidade(unidade(), { kommo: a.kommo });
  assert.equal(a.reg.notas.length, 0);
  chaves('seco');
  const b = duplicadoNaFranquia();
  await _interno.sincronizarUnidade(unidade(), { kommo: b.kommo });
  assert.equal(b.reg.notas.length, 0);
  assert.ok(simulacoes.some((s) => s.alvo === 'nota: cadastros duplicados na franquia'));
});

// ═════ revisão independente (16/10): cada achado reproduzido antes da correção ═════

import { decidirCadastro, pacienteQueJaExiste } from '../services/paciente-existente.js';
import { chaveDoWidget } from './widget-agenda.js';
import { widgetConflitoHandler, _depsWidgetConflito } from '../controllers/widget-conflito.controller.js';
import type { Request, Response } from 'express';

const FONE_MAE = '+5599991234567';

function maeEFilha() {
  clientesFalsos = [{ idClient: 100, name: 'MARIA SOUZA', whatsapp: FONE_MAE }];
  fichasFalsas = new Map([[100, { idClient: 100, name: 'MARIA SOUZA', whatsapp: FONE_MAE, schedules: [], treatments: [] }]]);
}

test('achado 1 — cadastro da Ana Souza no WhatsApp da mãe (Maria Souza, já paciente): não busca pelo sobrenome nem casa com a Maria', async () => {
  maeEFilha();
  const { kommo } = kommoFalso([{ id: 80, name: 'Ana Souza', pipeline_id: 10, status_id: 102, campos: {}, tags: [], contato: 80, fone: FONE_MAE }]);
  const r = await pacienteQueJaExiste(unidade(), 80, { nome: 'Ana Souza', telefone: FONE_MAE, kommo, contatoId: 80 });
  assert.equal(r, null, 'ninguém com o nome dela: cadastra a Ana, como antes de 16/10');
  assert.ok(!chamadasFranquia.includes('busca:souza'), 'no cadastro não se busca só pelo sobrenome (era o que trazia a Maria)');
  assert.ok(!chamadasFranquia.includes('busca:ana'), 'nem só pelo primeiro nome');
});

test('achado 1 — cadastro: a franquia traz OUTRA pessoa com o telefone (nome que não bate) = conflito, nem casa nem cria', async () => {
  clientesFalsos = [{ idClient: 100, name: 'JOANA SOUZA', whatsapp: FONE_MAE }];
  const { kommo } = kommoFalso([{ id: 79, name: 'Ana Souza', pipeline_id: 10, status_id: 102, campos: {}, tags: [], contato: 79, fone: FONE_MAE }]);
  const r = await pacienteQueJaExiste(unidade(), 79, { nome: 'Ana Souza', telefone: FONE_MAE, kommo, contatoId: 79 });
  assert.deepEqual(r, { tipo: 'conflito', ids: [100], outroNome: true });
  const d = decidirCadastro('ligado', r);
  assert.equal(d.criar, false, 'ligado: não cria lead');
  assert.equal(!d.criar && d.vincular, null, 'e não grava a Joana no vínculo');
});

test('achado 1 — cadastro: o ⚙ idClient (ou o vínculo) do cartão com OUTRO nome não vale (conflito); com o nome certo vale', async () => {
  maeEFilha();
  const { kommo } = kommoFalso([{ id: 81, name: 'Ana Souza', pipeline_id: 10, status_id: 102, campos: {}, tags: [], contato: 81, fone: FONE_MAE }]);
  assert.deepEqual(await pacienteQueJaExiste(unidade(), 81, { nome: 'Ana Souza', telefone: FONE_MAE, kommo, idDoCartao: 100 }), { tipo: 'conflito', ids: [100], outroNome: true }, '⚙ da mãe');
  const unit = unidade();
  vinculos.push({ unitId: unit.id, kommoLeadId: 81, spineIdClient: 100, spineIdSchedule: null });
  assert.deepEqual(await pacienteQueJaExiste(unit, 81, { nome: 'Ana Souza', telefone: FONE_MAE, kommo }), { tipo: 'conflito', ids: [100], outroNome: true }, 'vínculo da mãe');
  assert.deepEqual(await pacienteQueJaExiste(unit, 81, { nome: 'Maria Souza', telefone: FONE_MAE, kommo }), { tipo: 'achou', idClient: 100, por: 'idClient' }, 'a própria Maria');
});

test('achado 1 — cadastro: cartão irmão da mãe não casa a filha (conflito); e a própria Maria casa (controle)', async () => {
  maeEFilha();
  clientesFalsos = [];
  const { kommo } = kommoFalso([
    { id: 82, name: 'Ana Souza', pipeline_id: 10, status_id: 102, campos: {}, tags: [], contato: 82, fone: FONE_MAE },
    { id: 83, name: 'MARIA SOUZA', pipeline_id: 20, status_id: 142, campos: { [ID.IDCLIENT]: 100 }, tags: [], contato: 83, fone: FONE_MAE },
  ]);
  assert.deepEqual(await pacienteQueJaExiste(unidade(), 82, { nome: 'Ana Souza', telefone: FONE_MAE, kommo, contatoId: 82 }), { tipo: 'conflito', ids: [100], outroNome: true });
  maeEFilha();
  const r = await pacienteQueJaExiste(unidade(), 82, { nome: 'Maria Souza', telefone: FONE_MAE, kommo, contatoId: 82 });
  assert.deepEqual(r, { tipo: 'achou', idClient: 100, por: 'telefone' });
});

test('achado 2 — robô: cartão irmão com paciente de OUTRO nome não casa', async () => {
  fichasFalsas = new Map([[4321, { idClient: 4321, name: 'MARIA LIMA', whatsapp: FONE, schedules: [], treatments: [] }]]);
  const { kommo } = kommoFalso([
    { id: 84, name: 'JOAO PEREIRA', pipeline_id: 10, status_id: 104, campos: {}, tags: [], contato: 84, fone: FONE },
    { id: 85, name: 'MARIA LIMA', pipeline_id: 20, status_id: 142, campos: { [ID.IDCLIENT]: 4321 }, tags: [], contato: 85, fone: FONE },
  ]);
  const r = await casarPacienteDoCartao(unidade(), 84, 'JOAO PEREIRA', { kommo, contatoId: 84, campos: CAMPOS });
  assert.notEqual(r.tipo, 'achou');
});

test('achado 2 — robô: no Kommo dividido, o cartão irmão de OUTRA unidade não conta', async () => {
  const unit = unidade();
  _semearCrmParaTeste([
    { unitId: unit.id, contaUnitId: unit.id, rotulo: 'Petrópolis', slug: SLUG },
    { unitId: 'caxias-teste', contaUnitId: unit.id, rotulo: 'Caxias', slug: 'caxias-teste' },
  ]);
  fichasFalsas = new Map([[4321, { idClient: 4321, name: 'ANA ANTIGA', whatsapp: FONE, schedules: [], treatments: [] }]]);
  const { kommo } = kommoFalso([
    { id: 86, name: 'ANA ANTIGA', pipeline_id: 10, status_id: 104, campos: { [ID.UNIDADE]: 'Petrópolis' }, tags: [], contato: 86, fone: FONE },
    { id: 87, name: 'ANA ANTIGA', pipeline_id: 20, status_id: 142, campos: { [ID.IDCLIENT]: 4321, [ID.UNIDADE]: 'Caxias' }, tags: [], contato: 87, fone: FONE },
  ]);
  const r = await casarPacienteDoCartao(unit, 86, 'ANA ANTIGA', { kommo, contatoId: 86, campos: CAMPOS });
  assert.notEqual(r.tipo, 'achou', 'o irmão é de Caxias');
  _semearCrmParaTeste([]);
});

test('achado 3 — a tarefa "a equipe pôs de volta" não sai quando quem pôs de volta foi o robô', async () => {
  chaves('ligado', [{ automacao: 'franquia-move', estado: 'ligado' }]);
  const unitAntes = seqUnidade + 1;
  const { ctx, reg, rodar } = await cenarioDevolucao({}, { idClient: null, consultas: [marcada(9501, 'AVALIAÇÃO', 3)] });
  ctx.jornada = 'ligado';
  const uid = `u1610-${unitAntes}`;
  alertas.push({ unitId: uid, leadId: '70', ruleKey: 'franquia-manda:PERDIDO:consulta:9501', createdAt: new Date(Date.now() - 3600_000) });
  alertas.push({ unitId: uid, leadId: '70', ruleKey: 'robo-pos:PERDIDO', createdAt: new Date() });
  await rodar();
  assert.deepEqual(reg.tarefas, [], 'o robô é que pôs de volta: sem tarefa para a equipe');
  assert.deepEqual(reg.movidos, []);
});

test('achado 3 — ALTA → EM TRATAMENTO → o robô dá a alta → tratamento NOVO com sessão marcada: sai da ALTA de novo, sem tarefa falsa', async () => {
  chaves('ligado', [{ automacao: 'franquia-move', estado: 'ligado' }]);
  const { ctx, reg, kommo } = await cenarioDevolucao({ pipeline_id: 20, status_id: 142 }, { idClient: null, consultas: [] });
  ctx.jornada = 'ligado';
  const sessao = (idSchedule: number, idStatus: number, dias: number) => ({ idSchedule, idStatus, statusName: idStatus === 42 ? 'Atendido' : 'Agendado', category: 'PROTOCOLO 03 MESES - LOMBAR', dateAttendance: diaLocal(dias) });
  // o cache do histórico é de 1 h por paciente: cada passo usa um idClient próprio para a franquia falsa "mudar"
  const passo = async (idClient: number, treatments: unknown[], schedules: unknown[]) => {
    fichasFalsas.set(idClient, { idClient, name: 'PACIENTE TESTE', whatsapp: FONE, treatments, schedules });
    await _interno.processarCartao(ctx, 70, await kommo.getLead(70), { nome: 'PACIENTE TESTE', idClient, consultas: [], tratamento: null });
  };
  await passo(5001, [{ idTreatment: 1, idStatus: 45, statusName: 'EM ANDAMENTO' }], [sessao(1, 42, -10), sessao(2, 37, 2)]);
  assert.deepEqual(reg.movidos.map((m) => m.statusId), [202], '1. a franquia manda: ALTA → EM TRATAMENTO');
  await passo(5002, [{ idTreatment: 1, idStatus: 46, statusName: 'FINALIZADO' }], [sessao(1, 42, -10), sessao(2, 42, -1)]);
  assert.deepEqual(reg.movidos.map((m) => m.statusId), [202, 142], '2. o próprio robô dá a alta');
  await passo(5003, [{ idTreatment: 1, idStatus: 46, statusName: 'FINALIZADO' }, { idTreatment: 2, idStatus: 45, statusName: 'EM ANDAMENTO' }], [sessao(1, 42, -10), sessao(2, 42, -1), sessao(3, 37, 3)]);
  assert.deepEqual(reg.movidos.map((m) => m.statusId), [202, 142, 202], '3. tratamento novo = fato novo: sai da ALTA de novo');
  assert.deepEqual(reg.tarefas, [], 'nenhuma tarefa "a equipe pôs de volta" (quem pôs foi o robô)');
});

test('achado 4 — ALTA com tratamento FINALIZADO e sessão esquecida em AGENDADO: fica na ALTA e abre UMA tarefa', async () => {
  chaves('ligado', [{ automacao: 'franquia-move', estado: 'ligado' }]);
  const ficha = { idClient: 4400, name: 'PACIENTE TESTE', whatsapp: FONE, treatments: [{ idTreatment: 1, idStatus: 46, statusName: 'FINALIZADO' }], schedules: [
    { idSchedule: 11, idStatus: 42, statusName: 'Atendido', category: 'PROTOCOLO 03 MESES - LOMBAR', dateAttendance: diaLocal(-20) },
    { idSchedule: 12, idStatus: 37, statusName: 'Agendado', category: 'PROTOCOLO 03 MESES - LOMBAR', dateAttendance: diaLocal(2) },
  ] };
  const { ctx, reg, rodar } = await cenarioDevolucao({ pipeline_id: 20, status_id: 142 }, { idClient: 4400, consultas: [] }, ficha);
  ctx.jornada = 'ligado';
  await rodar();
  await rodar();
  assert.deepEqual(reg.movidos, [], 'não sai da ALTA (a régua da ALTA não dispara de novo)');
  assert.equal(reg.tarefas.length, 1);
  assert.match(reg.tarefas[0].text, /FINALIZADO|finalizado/);
});

function exPacienteNaFranquia(agenda: Array<Record<string, unknown>>) {
  clientesFalsos = [{ idClient: 300, name: 'ROSA LIMA', whatsapp: FONE }];
  agendaFalsa = agenda;
  fichasFalsas = new Map([[300, { idClient: 300, name: 'ROSA LIMA', whatsapp: FONE, treatments: [{ idTreatment: 3, idStatus: 46, statusName: 'FINALIZADO' }], schedules: [
    { idSchedule: 31, idStatus: 42, statusName: 'Atendido', category: 'AVALIAÇÃO', dateAttendance: diaLocal(-200) },
    { idSchedule: 32, idStatus: 42, statusName: 'Atendido', category: 'PROTOCOLO 03 MESES - LOMBAR', dateAttendance: diaLocal(-60) },
    ...agenda.map((a) => ({ idSchedule: a.idSchedule, idStatus: a.idStatus, statusName: a.statusName, category: a.categoryName, dateAttendance: a.dateAttendance })),
  ] }]]);
}

test('achado 5 — ex-paciente no PERDIDO com avaliação marcada vai pra RETORNO (o histórico é lido no cartão COMERCIAL)', async () => {
  chaves('ligado', [{ automacao: 'franquia-move', estado: 'ligado' }]);
  exPacienteNaFranquia([{ idSchedule: 9601, idStatus: 37, statusName: 'Agendado', clientName: 'ROSA LIMA', categoryName: 'AVALIAÇÃO', dateAttendance: diaLocal(3) }]);
  const { kommo, reg } = kommoFalso([{ id: 571, name: 'ROSA LIMA', pipeline_id: 10, status_id: 143, campos: {}, tags: [], contato: 571, fone: FONE }]);
  await _interno.sincronizarUnidade(unidade(), { kommo });
  assert.deepEqual(reg.movidos.map((m) => m.statusId), [109], 'RETORNO PÓS-TRATAMENTO, não AGENDADO');
});

test('achado 5 — ex-paciente em RETORNO com a consulta da volta atendida sai pra COMPARECEU', async () => {
  chaves('ligado', [{ automacao: 'franquia-move', estado: 'ligado' }]);
  exPacienteNaFranquia([{ idSchedule: 9602, idStatus: 42, statusName: 'Atendido', clientName: 'ROSA LIMA', categoryName: 'AVALIAÇÃO', dateAttendance: diaLocal(-1) }]);
  const { kommo, reg } = kommoFalso([{ id: 572, name: 'ROSA LIMA', pipeline_id: 10, status_id: 109, campos: {}, tags: [], contato: 572, fone: FONE }]);
  await _interno.sincronizarUnidade(unidade(), { kommo });
  assert.deepEqual(reg.movidos.map((m) => m.statusId), [107]);
});

function reqRes(slug: string, query: Record<string, string>) {
  const req = { params: { slug }, query, ip: '9.9.9.9', header: (h: string) => (h.toLowerCase() === 'x-widget-key' ? chaveDoWidget(slug, process.env.SESSION_JWT_SECRET as string) : undefined) } as unknown as Request;
  const out: { status: number; body: Record<string, unknown> | null } = { status: 200, body: null };
  const res = { status(n: number) { out.status = n; return this; }, json(b: Record<string, unknown>) { out.body = b; return this; } } as unknown as Response;
  return { req, res, out };
}

test('achado 6 — widget no Kommo dividido: vale a chave da unidade DONA do cartão, não a do endereço', async () => {
  const petropolis = { ...unidade(), slug: 'petropolis-w', isActive: true } as Unit;
  const caxias = { ...unidade(), slug: 'caxias-w', isActive: true } as Unit;
  unidadesNoBanco = [petropolis, caxias];
  _semearParaTeste([{ slug: 'petropolis-w', automacao: 'casamento-jornada', estado: 'desligado' }, { slug: 'caxias-w', automacao: 'casamento-jornada', estado: 'ligado' }]);
  const { kommo } = kommoFalso([{ id: 90, name: 'X', pipeline_id: 10, status_id: 102, campos: {}, tags: [], contato: 90, fone: FONE }]);
  _depsWidgetConflito.kommoDe = () => kommo;
  _depsWidgetConflito.dono = async () => ({ tipo: 'unidade', unit: caxias, rotulo: 'Caxias' }) as never;
  const { req, res, out } = reqRes('petropolis-w', { lead: '90' });
  await widgetConflitoHandler(req, res);
  assert.equal(out.body?.estado, 'ligado', 'Caxias (dona do cartão) está ligada');
});

test('achado 7 — conflito sem nenhum idClient conhecido não põe etiqueta (não haveria o que escolher)', async () => {
  chaves('ligado');
  const unit = unidade();
  const { kommo, reg } = kommoFalso([{ id: 573, name: 'X', pipeline_id: 10, status_id: 105, campos: {}, tags: [], contato: 573, fone: FONE }]);
  const lead = await kommo.getLead(573);
  const resumo: ResumoSync = { unit: SLUG, em: '', agendamentos: 0, tratamentos: 0, pacientes: 0, comLead: 0, semLead: 0, escritas: 0, erros: 0, exemplosSemLead: [], movimentos: 0, revisados: 0 };
  await _interno.marcarConflitoDeTelefone({ unit, kommo, funis: null, mapa: {}, ops: { fisio: [], categoria: [], tratamento: [] }, agoraEpoch: 0, resumo, camposPorNome: CAMPOS, jornada: 'ligado' } as Parameters<typeof _interno.marcarConflitoDeTelefone>[0], 573, lead, [{ idClient: null, nome: 'A' }, { idClient: null, nome: 'B' }]);
  assert.deepEqual(reg.etiquetas, []);
});

test('achado 7 — chave desligada: a etiqueta CONFLITO_FRANQUIA que a regra pôs sai sozinha', async () => {
  chaves('desligado');
  const unit = unidade();
  const { kommo, reg } = kommoFalso([{ id: 574, name: 'X', pipeline_id: 10, status_id: 105, campos: {}, tags: [TAG_CONFLITO], contato: 574, fone: FONE }]);
  alertas.push({ unitId: unit.id, leadId: '574', ruleKey: 'conflito-franquia:101,202', createdAt: new Date() });
  await _interno.sincronizarUnidade(unit, { kommo });
  assert.deepEqual(reg.tirou, [{ leadId: 574, tag: TAG_CONFLITO }]);
  assert.ok(!alertas.some((a) => a.leadId === '574' && a.ruleKey.startsWith('conflito-franquia:')));
});

test('achado 7 — ligado: quando o conflito some (um dos dois trocou de telefone na franquia), a etiqueta sai', async () => {
  chaves('ligado');
  const unit = unidade();
  fichasFalsas = new Map([
    [101, { idClient: 101, name: 'MARIA TESTE', whatsapp: FONE, schedules: [], treatments: [] }],
    [202, { idClient: 202, name: 'JOSE TESTE', whatsapp: '+5511977776666', schedules: [], treatments: [] }],
  ]);
  const { kommo, reg } = kommoFalso([{ id: 575, name: 'MARIA TESTE', pipeline_id: 10, status_id: 105, campos: {}, tags: [TAG_CONFLITO], contato: 575, fone: FONE }]);
  alertas.push({ unitId: unit.id, leadId: '575', ruleKey: 'conflito-franquia:101,202', createdAt: new Date() });
  await _interno.sincronizarUnidade(unit, { kommo });
  assert.deepEqual(reg.tirou, [{ leadId: 575, tag: TAG_CONFLITO }]);
});

test('achado 7 — tirar a etiqueta à mão não traz a nota de novo (o conflito continua: a etiqueta volta, a nota não)', async () => {
  chaves('ligado');
  const unit = unidade();
  const { kommo, reg } = doisPacientesNoMesmoTelefone();
  await _interno.sincronizarUnidade(unit, { kommo });
  assert.equal(reg.notas.length, 1);
  await kommo.removeTag(555, TAG_CONFLITO);
  await _interno.sincronizarUnidade(unit, { kommo });
  assert.equal(reg.etiquetas.length, 2, 'a etiqueta volta (o conflito existe)');
  assert.equal(reg.notas.length, 1, 'a nota não se repete');
});

test('achado 7 — ligado: o ⚙ idClient gravado à mão resolve o conflito (etiqueta sai e a escolha fica anotada)', async () => {
  chaves('ligado');
  const unit = unidade();
  const { kommo, reg } = kommoFalso([{ id: 577, name: 'MARIA TESTE', pipeline_id: 10, status_id: 105, campos: { [ID.IDCLIENT]: 101 }, tags: [TAG_CONFLITO], contato: 577, fone: FONE }]);
  alertas.push({ unitId: unit.id, leadId: '577', ruleKey: 'conflito-franquia:101,202', createdAt: new Date() });
  await _interno.sincronizarUnidade(unit, { kommo });
  assert.deepEqual(reg.tirou, [{ leadId: 577, tag: TAG_CONFLITO }]);
  assert.ok(alertas.some((a) => a.leadId === '577' && a.ruleKey === 'paciente-escolhido:101'));
  assert.ok(!alertas.some((a) => a.leadId === '577' && a.ruleKey.startsWith('conflito-franquia:')));
});

test('Codex (rodada 1) — o Kommo falha ao etiquetar: o cartão continua travado pela marca no banco e a nota sai mesmo assim', async () => {
  chaves('ligado');
  const unit = unidade();
  const { kommo, reg } = doisPacientesNoMesmoTelefone();
  const addTag = kommo.addTag.bind(kommo);
  (kommo as unknown as { addTag: unknown }).addTag = async () => { throw new Error('Kommo fora do ar'); };
  await _interno.sincronizarUnidade(unit, { kommo });
  assert.deepEqual(reg.gravacoes, []);
  assert.equal(reg.notas.length, 1, 'a nota não depende da etiqueta');
  assert.ok(alertas.some((a) => a.leadId === '555' && a.ruleKey === 'conflito-franquia:101,202'), 'a trava fica no banco');
  // na varredura seguinte só a MARIA está na agenda (sem "dois no cartão"): sem etiqueta, quem trava é a marca
  (kommo as unknown as { addTag: unknown }).addTag = addTag;
  agendaFalsa = agendaFalsa.filter((a) => a.clientName === 'MARIA TESTE');
  await _interno.sincronizarUnidade(unit, { kommo });
  assert.deepEqual(reg.gravacoes, [], 'nada gravado no cartão em conflito');
  assert.equal(reg.notas.length, 1, 'sem nota repetida');
});

test('achado 8 — só no papel: 15 e 30 min depois, a simulação do casamento novo não refaz as buscas na franquia', async (t) => {
  clientesFalsos = [{ idClient: 4500, name: 'JOAO PEREIRA DA SILVA', whatsapp: FONE }];
  fichasFalsas = new Map([[4500, { idClient: 4500, name: 'JOAO PEREIRA DA SILVA', whatsapp: FONE, schedules: [], treatments: [] }]]);
  const montar = () => kommoFalso([{ id: 576, name: 'JOAO PEREIRA DA SILVA', pipeline_id: 10, status_id: 105, campos: { [ID.DATA]: String(Math.floor(Date.now() / 1000) - 20 * 86_400) }, tags: [], contato: 576, fone: FONE }]);
  chaves('seco', [{ automacao: 'franquia-revisao', estado: 'ligado' }, { automacao: 'franquia-move', estado: 'seco' }]);
  const unit = unidade();
  const revisar = async () => {
    const { kommo } = montar();
    const funis = await carregarFunis(kommo);
    const resumo: ResumoSync = { unit: SLUG, em: '', agendamentos: 0, tratamentos: 0, pacientes: 0, comLead: 0, semLead: 0, escritas: 0, erros: 0, exemplosSemLead: [], movimentos: 0, revisados: 0 };
    await _interno.revisarPeloHistorico({ unit, kommo, funis, mapa: _interno.mapearCampos(CAMPOS_BRUTOS), ops: { fisio: [], categoria: [], tratamento: [] }, agoraEpoch: Math.floor(Date.now() / 1000), resumo, camposPorNome: CAMPOS, jornada: 'seco' } as Parameters<typeof _interno.revisarPeloHistorico>[0]);
  };
  const buscas = () => chamadasFranquia.filter((c) => c.startsWith('busca:')).length;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await revisar();
  assert.ok(buscas() > 0, 'a 1ª varredura busca (a regra antiga; a simulação reaproveita a mesma busca)');
  assert.equal(buscas(), 1, 'achou pelo telefone no 1º termo: uma busca só, para as duas regras');
  for (const passo of [1, 2]) {
    chamadasFranquia = [];
    t.mock.timers.tick(15 * 60_000);
    await revisar();
    assert.equal(buscas(), 0, `varredura ${passo + 1}: a regra antiga responde do cache dela e a simulação não busca de novo`);
  }
});

test('achado 8 — o paciente que a varredura da agenda já casou com o cartão dispensa a busca pelo título', async () => {
  chaves('ligado');
  const unit = unidade();
  clientesFalsos = [{ idClient: 300, name: 'ROSA LIMA', whatsapp: FONE }];
  agendaFalsa = [{ idSchedule: 9701, idStatus: 37, statusName: 'Agendado', clientName: 'ROSA LIMA', categoryName: 'AVALIAÇÃO', dateAttendance: diaLocal(3) }];
  const { kommo } = kommoFalso([{ id: 578, name: 'Lead 01/10/2026', pipeline_id: 10, status_id: 104, campos: {}, tags: [], contato: 578, fone: FONE }]);
  await _interno.sincronizarUnidade(unit, { kommo });
  chamadasFranquia = [];
  assert.deepEqual(await casarPacienteDoCartao(unit, 578, 'Lead 01/10/2026', { kommo, contatoId: 578, campos: CAMPOS }), { tipo: 'achou', idClient: 300, por: 'telefone' });
  assert.equal(chamadasFranquia.length, 0, 'nenhuma chamada à franquia');
});
