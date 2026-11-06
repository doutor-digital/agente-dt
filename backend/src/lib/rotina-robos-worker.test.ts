/**
 * Rotina diária dos robôs ponta a ponta, com Kommo, banco e franquia FALSOS (06/11/2026).
 *
 * Prova: cada régua/etapa no prazo; cada trava; teto do dia (somado nas três réguas) e da varredura; a marca (não repete,
 * não pula, o paciente escrever zera); etiqueta que a conta não tem; o SECO não escreve nada (nem etiqueta, nem marca) e
 * mostra por etapa e degrau; o ex-lead (nunca agendou, motivo morto, absorção da Reativação); o aniversário (data,
 * ficha, ano, tratamento, não junto com outro toque).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import type { KommoLead } from '../services/kommo.service.js';
import type { Funis } from './franquia-sync-worker.js';
import type { NaFranquia } from './parados-worker.js';
import { ETAPA, TRATAMENTO_EM_ANDAMENTO } from './franquia-move.js';
import { configDaUnidade } from './rotina-robos.js';
import {
  _limparCacheDaRotina,
  estadoDasEtapas,
  estadoDoAniversario,
  estadoDoExLead,
  nuncaAgendou,
  varrerAniversario,
  varrerEtapas,
  varrerExLead,
  type Ctx,
  type ResumoDaRegua,
} from './rotina-robos-worker.js';

// ── tempo ──
const AGORA = Date.UTC(2026, 10, 6, 13, 0, 0) / 1000; // 10h em Brasília, sexta
const DIA = 86_400;
const H = 3600;

// ── banco falso ──
interface Traco {
  id: string;
  unitId: string;
  leadId: string;
  createdAt: Date;
}
let tracos = new Map<string, Traco>();
let conversas = new Map<string, number>();
let pausados = new Set<number>();
const simulacoes: Array<{ unitId: string; automacao: string; kommoLeadId: number; acao: string; alvo: string; deEtapa: string | null; valor: string | null; motivo: string | null }> = [];

const bate = (t: Traco, where: Record<string, unknown>): boolean => {
  if (where.unitId && t.unitId !== where.unitId) return false;
  const lead = where.leadId as { in?: string[] } | undefined;
  if (lead?.in && !lead.in.includes(t.leadId)) return false;
  const id = where.id as { startsWith?: string; in?: string[] } | string | undefined;
  if (typeof id === 'object' && id?.startsWith && !t.id.startsWith(id.startsWith)) return false;
  if (typeof id === 'object' && id?.in && !id.in.includes(t.id)) return false;
  const quando = where.createdAt as { gte?: Date } | undefined;
  if (quando?.gte && t.createdAt < quando.gte) return false;
  return true;
};
Object.defineProperty(prisma, 'executionTrace', {
  value: {
    findMany: async (a: { where: Record<string, unknown> }) => [...tracos.values()].filter((t) => bate(t, a.where)),
    create: async (a: { data: { id: string; unitId: string; leadId: string } }) => {
      if (tracos.has(a.data.id)) throw new Error('Unique constraint failed');
      tracos.set(a.data.id, { id: a.data.id, unitId: a.data.unitId, leadId: a.data.leadId, createdAt: new Date(AGORA * 1000) });
      return {};
    },
    delete: async (a: { where: { id: string } }) => {
      tracos.delete(a.where.id);
      return {};
    },
  },
  configurable: true,
});
Object.defineProperty(prisma, 'conversation', {
  value: { findMany: async (a: { where: { leadId: { in: string[] } } }) => a.where.leadId.in.filter((id) => conversas.has(id)).map((leadId) => ({ leadId, lastMessageAt: new Date((conversas.get(leadId) as number) * 1000) })) },
  configurable: true,
});
Object.defineProperty(prisma, 'leadPausa', {
  value: { findUnique: async (a: { where: { unitId_kommoLeadId: { kommoLeadId: number } } }) => (pausados.has(a.where.unitId_kommoLeadId.kommoLeadId) ? { ate: new Date((AGORA + DIA) * 1000) } : null) },
  configurable: true,
});
Object.defineProperty(prisma, 'automacaoSimulacao', {
  value: { upsert: async (a: { create: (typeof simulacoes)[number] }) => void simulacoes.push(a.create), deleteMany: async () => ({}) },
  configurable: true,
});
Object.defineProperty(prisma, 'unitAutomacao', { value: { findMany: async () => [] }, configurable: true });

// ── funis ──
const COM = 1;
const TRAT = 2;
const STATUS: Record<string, { pipelineId: number; statusId: number }> = {
  [`COMERCIAL:${ETAPA.QUALIFICACAO}`]: { pipelineId: COM, statusId: 11 },
  [`COMERCIAL:${ETAPA.NAO_COMPARECEU}`]: { pipelineId: COM, statusId: 12 },
  [`COMERCIAL:${ETAPA.NEGOCIACAO}`]: { pipelineId: COM, statusId: 13 },
  [`COMERCIAL:${ETAPA.ESPERA}`]: { pipelineId: COM, statusId: 14 },
  [`COMERCIAL:${ETAPA.AGENDADO}`]: { pipelineId: COM, statusId: 15 },
  [`TRATAMENTO:${ETAPA.EM_TRATAMENTO}`]: { pipelineId: TRAT, statusId: 21 },
  [`TRATAMENTO:${ETAPA.ALTA}`]: { pipelineId: TRAT, statusId: 22 },
};
const NOMES: Record<string, string> = { '1:11': ETAPA.QUALIFICACAO, '1:12': ETAPA.NAO_COMPARECEU, '1:13': ETAPA.NEGOCIACAO, '1:14': ETAPA.ESPERA, '1:15': ETAPA.AGENDADO, '1:143': ETAPA.PERDIDO, '2:21': ETAPA.EM_TRATAMENTO, '2:22': ETAPA.ALTA };
const funis = {
  comercialId: COM,
  tratamentoId: TRAT,
  status: new Map(),
  nomeDe: (p: number, s: number) => (NOMES[`${p}:${s}`] ? { funil: p === TRAT ? 'TRATAMENTO' : 'COMERCIAL', status: NOMES[`${p}:${s}`] } : null),
  idDe: (funil: string, etapa: string) => STATUS[`${funil}:${etapa}`] ?? null,
} as unknown as Funis;

// ── Kommo falso ──
let n = 0;
interface Cartao {
  lead: KommoLead;
  contato: number;
  /** última mensagem do paciente (epoch s); null = nunca escreveu */
  paciente: number | null;
  /** falas do chat oficial */
  falas: Array<{ autor: 'external' | 'bot' | 'user'; em: number }>;
}
let cartoes: Cartao[] = [];
const chamadas: string[] = [];
let tagsNoKommo = new Map<number, string[]>();

function campos(c: Record<string, unknown>): KommoLead['custom_fields_values'] {
  return Object.entries(c).map(([nome, value], i) => ({ field_id: 5000 + i, field_name: nome, values: [{ value }] })) as KommoLead['custom_fields_values'];
}
function novo(opts: { etapa?: [number, number]; silencioDias?: number | null; tags?: string[]; campos?: Record<string, unknown>; falas?: Cartao['falas']; nome?: string; closed?: number } = {}): Cartao {
  const id = 1000 + ++n;
  const [pipeline_id, status_id] = opts.etapa ?? [COM, 11];
  const lead = {
    id,
    name: opts.nome ?? `Paciente ${id}`,
    pipeline_id,
    status_id,
    updated_at: AGORA - n,
    closed_at: opts.closed,
    custom_fields_values: campos(opts.campos ?? {}),
    _embedded: { tags: (opts.tags ?? []).map((name, i) => ({ id: i + 1, name })), contacts: [{ id: 50_000 + id, is_main: true }] },
  } as unknown as KommoLead;
  const c: Cartao = { lead, contato: 50_000 + id, paciente: opts.silencioDias === null ? null : AGORA - (opts.silencioDias ?? 3) * DIA, falas: opts.falas ?? [] };
  if (c.paciente !== null) c.falas.push({ autor: 'external', em: c.paciente });
  tagsNoKommo.set(id, opts.tags ?? []);
  cartoes.push(c);
  return c;
}

const kommo = {
  listLeadsPorEtapa: async (pipelineId: number, statusId: number, _l?: number, page = 1) => (page > 1 ? [] : cartoes.filter((c) => c.lead.pipeline_id === pipelineId && c.lead.status_id === statusId).map((c) => c.lead)),
  ultimaMensagemDoContatoDesde: async (contato: number, desde: number) => {
    chamadas.push(`mensagem:${contato}`);
    const c = cartoes.find((x) => x.contato === contato);
    return c?.paciente != null && c.paciente >= desde ? c.paciente : null;
  },
  listTalks: async (leadId: number) => (cartoes.find((c) => c.lead.id === leadId)?.falas.length ? [{ talk_id: leadId, updated_at: AGORA }] : []),
  listTalkMessages: async (talkId: number) =>
    (cartoes.find((c) => c.lead.id === talkId)?.falas ?? []).map((f, i) => ({ id: `m${i}`, type: 'x', text: 'oi', created_at: f.em, author: { type: f.autor, name: f.autor } })),
  getLead: async (leadId: number) => {
    const c = cartoes.find((x) => x.lead.id === leadId) as Cartao;
    return { ...c.lead, _embedded: { ...c.lead._embedded, tags: (tagsNoKommo.get(leadId) ?? []).map((name, i) => ({ id: i + 1, name })) } } as KommoLead;
  },
  addTag: async (p: { leadId: number; tag?: string }) => {
    chamadas.push(`addTag:${p.leadId}:${p.tag}`);
    tagsNoKommo.set(p.leadId, [...(tagsNoKommo.get(p.leadId) ?? []), p.tag as string]);
  },
  removeTag: async (leadId: number, tag: string) => {
    chamadas.push(`removeTag:${leadId}:${tag}`);
    tagsNoKommo.set(leadId, (tagsNoKommo.get(leadId) ?? []).filter((t) => t !== tag));
  },
  addLeadNote: async (leadId: number) => {
    chamadas.push(`nota:${leadId}`);
    return {};
  },
} as unknown as Ctx['kommo'];

const escritas = () => chamadas.filter((c) => /^(addTag|removeTag|nota)/.test(c));
const tagsPostas = () => chamadas.filter((c) => c.startsWith('addTag')).map((c) => c.split(':').slice(2).join(':'));

const SEM_FRANQUIA: NaFranquia = { conhecido: false, consultaFutura: false, emAndamento: false, finalizado: false, temHistorico: false };
const TODAS = ['▶ Retomada', '▶ Retomada 2', '▶ Retomada 3', '▶ Reativação', '▶ Reativação 2', '▶ Reativação 3', '▶ Aniversário', '▶ Aniversário tratamento', 'NO_FOLLOW_UP'];
let franquia: (leadId: number) => NaFranquia = () => SEM_FRANQUIA;
let fichas = new Map<number, { birthdate: string | null; status: string | null; emTratamento?: boolean }>();

let seq = 0;
function ctx(extra: { intents?: Record<string, number>; tags?: string[]; teto?: Partial<Ctx['teto']>; agora?: number } = {}): Ctx {
  const unit = { id: `u-rotina-${++seq}`, slug: `rotina-${seq}`, spineEnabled: false, spineToken: null, spineTimezone: 'America/Sao_Paulo', kommoSubdomain: 'teste', pipelineIntents: extra.intents ?? null } as unknown as Unit;
  const cfg = configDaUnidade(unit.pipelineIntents, {});
  return {
    unit,
    kommo,
    funis,
    grupo: null,
    agora: extra.agora ?? AGORA,
    tz: 'America/Sao_Paulo',
    cfg,
    pausarIaFieldId: 777,
    tagsDaConta: extra.tags ?? TODAS,
    teto: { restanteHoje: cfg.teto, restanteNaVarredura: cfg.porVarredura, simulado: cfg.teto, ...extra.teto },
    franquia: async (_u, leadId) => franquia(leadId),
    ficha: (async (_u: unknown, idClient: number) => {
      const f = fichas.get(idClient);
      return f
        ? { ok: true, data: { ficha: { idClient, name: 'X', gender: null, birthdate: f.birthdate, addressCity: null, addressUf: null, address: null, email: null, source: null, status: f.status, schedules: [], treatments: f.emTratamento ? [{ idStatus: TRATAMENTO_EM_ANDAMENTO }] : [] } } }
        : { ok: false, error: 'sem ficha' };
    }) as Ctx['ficha'],
  };
}

beforeEach(() => {
  tracos = new Map();
  conversas = new Map();
  pausados = new Set();
  simulacoes.length = 0;
  cartoes = [];
  chamadas.length = 0;
  tagsNoKommo = new Map();
  franquia = () => SEM_FRANQUIA;
  fichas = new Map();
  _limparCacheDaRotina();
});

async function etapas(c: Ctx, seco: boolean): Promise<Record<string, ResumoDaRegua>> {
  const r: Record<string, ResumoDaRegua> = {};
  await varrerEtapas(c, seco, r);
  return r;
}

// ─── régua por etapa: prazos ──────────────────────────────────────────────────────────────────────

test('cada etapa recebe no prazo dela: QUALIFICAÇÃO 2 d, NÃO COMPARECEU 1 d, NEGOCIAÇÃO 2 d; antes disso, nada', async () => {
  const q = novo({ etapa: [COM, 11], silencioDias: 2.1 });
  const qCedo = novo({ etapa: [COM, 11], silencioDias: 1.5 });
  const nc = novo({ etapa: [COM, 12], silencioDias: 1.1 });
  const ncCedo = novo({ etapa: [COM, 12], silencioDias: 0.5 });
  const ng = novo({ etapa: [COM, 13], silencioDias: 2.2 });
  const ngCedo = novo({ etapa: [COM, 13], silencioDias: 1.9 });
  const c = ctx();
  const r = await etapas(c, false);
  const postas = chamadas.filter((x) => x.startsWith('addTag')).map((x) => Number(x.split(':')[1]));
  assert.deepEqual(postas.sort(), [q.lead.id, nc.lead.id, ng.lead.id].sort());
  for (const cedo of [qCedo, ncCedo, ngCedo]) assert.ok(!postas.includes(cedo.lead.id));
  assert.equal(r.qualificacao.porToque['1'], 1);
  assert.equal(r.naocompareceu.porToque['1'], 1);
  assert.equal(r.negociacao.porToque['1'], 1);
  assert.deepEqual(new Set(tagsPostas()), new Set(['▶ Retomada']));
});

test('o prazo da unidade vale (pipelineIntents): QUALIFICAÇÃO com d1=5 não recebe aos 3 dias', async () => {
  novo({ etapa: [COM, 11], silencioDias: 3 });
  await etapas(ctx({ intents: { rotina_qualificacao_d1: 5, rotina_qualificacao_d2: 8, rotina_qualificacao_d3: 12 } }), false);
  assert.equal(tagsPostas().length, 0);
});

// ─── régua por etapa: marca de ciclo ──────────────────────────────────────────────────────────────

test('1 envio por cartão por ciclo: a 2ª varredura no mesmo dia não repete, nem com a memória limpa', async () => {
  const a = novo({ silencioDias: 3 });
  await etapas(ctx(), false);
  assert.equal(tagsPostas().length, 1);
  assert.equal(tracos.size, 1, 'a marca ficou gravada ANTES da etiqueta');
  chamadas.length = 0;
  _limparCacheDaRotina();
  // mesma unidade, nova varredura (o teto de hoje já contou a marca)
  const c2 = ctx();
  c2.unit = { ...c2.unit, id: [...tracos.values()][0].unitId } as Unit;
  await etapas(c2, false);
  assert.equal(tagsPostas().length, 0, 'não repete');
  assert.ok(a);
});

test('a régua anda: com o 1º enviado há 2,5 dias e 4,5 de silêncio, sai o 2º degrau (▶ Retomada 2)', async () => {
  const a = novo({ silencioDias: 4.5 });
  const c = ctx({ intents: { rotina_toques_prontos: 3 } });
  const id = `rotina-${c.unit.id}-${a.lead.id}-qualificacao-1-${a.paciente}`;
  tracos.set(id, { id, unitId: c.unit.id, leadId: String(a.lead.id), createdAt: new Date((AGORA - 2.5 * DIA) * 1000) });
  await etapas(c, false);
  assert.deepEqual(tagsPostas(), ['▶ Retomada 2']);
  assert.ok(tracos.has(`rotina-${c.unit.id}-${a.lead.id}-qualificacao-2-${a.paciente}`), 'a marca do 2º ficou');
});

test('depois do 3º degrau sem resposta não manda mais nada (quem move é o parados)', async () => {
  const a = novo({ silencioDias: 12 });
  const c = ctx({ intents: { rotina_toques_prontos: 3 } });
  for (const k of [1, 2, 3]) {
    const id = `rotina-${c.unit.id}-${a.lead.id}-qualificacao-${k}-${a.paciente}`;
    tracos.set(id, { id, unitId: c.unit.id, leadId: String(a.lead.id), createdAt: new Date((AGORA - (4 - k) * 2 * DIA) * 1000) });
  }
  const r = await etapas(c, false);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.qualificacao.esgotadas, 1);
  assert.ok(!chamadas.includes(`mensagem:${a.contato}`), 'acabou sem gastar nem a chamada de mensagem');
});

test('qualquer mensagem do paciente zera a régua: depois de responder, recomeça pelo 1º degrau', async () => {
  const a = novo({ silencioDias: 3 });
  const c = ctx({ intents: { rotina_toques_prontos: 3 } });
  const antigo = `rotina-${c.unit.id}-${a.lead.id}-qualificacao-1-${AGORA - 20 * DIA}`;
  // o 1º degrau saiu há 10 dias; ele respondeu há 3 dias e calou de novo
  tracos.set(antigo, { id: antigo, unitId: c.unit.id, leadId: String(a.lead.id), createdAt: new Date((AGORA - 10 * DIA) * 1000) });
  await etapas(c, false);
  assert.deepEqual(tagsPostas(), ['▶ Retomada'], 'de novo o 1º, não o 2º');
});

test('a etiqueta do ciclo anterior ainda no cartão: tira antes de pôr (o gatilho é «etiqueta adicionada»)', async () => {
  novo({ silencioDias: 3, tags: ['▶ Retomada'] });
  await etapas(ctx(), false);
  assert.deepEqual(chamadas.filter((x) => /^(removeTag|addTag)/.test(x)).map((x) => x.split(':')[0]), ['removeTag', 'addTag']);
});

// ─── régua por etapa: travas ──────────────────────────────────────────────────────────────────────

test('travas do cartão: NO_FOLLOW_UP, NAO_PERTURBAR, CURRÍCULO, opt-out, consulta futura, ◷ Retomar em futuro, Pausar IA — ninguém recebe', async () => {
  novo({ tags: ['NO_FOLLOW_UP'] });
  novo({ tags: ['NAO_PERTURBAR'] });
  novo({ tags: ['CURRÍCULO'] });
  novo({ campos: { '✓ Opt-out WhatsApp': 'Sim' } });
  novo({ campos: { '◷ Data da Consulta': AGORA + 3 * DIA } });
  novo({ campos: { '◷ Retomar em': AGORA + 5 * DIA } });
  const pausar = novo();
  (pausar.lead.custom_fields_values as unknown[]).push({ field_id: 777, field_name: 'Pausar IA', values: [{ value: true }] });
  const livre = novo();
  const r = await etapas(ctx(), false);
  assert.deepEqual(tagsPostas(), ['▶ Retomada']);
  assert.ok(chamadas.some((x) => x === `addTag:${livre.lead.id}:▶ Retomada`));
  assert.deepEqual(Object.keys(r.qualificacao.barrados).sort(), ['consulta-futura-cartao', 'nao-contatar', 'opt-out', 'pausar-ia', 'retomar-em']);
  assert.equal(chamadas.filter((x) => x.startsWith('mensagem')).length, 1, 'os travados nem gastaram a chamada de mensagem');
});

test('travas que custam chamada: equipe nas últimas 48 h, qualquer fala nas últimas 24 h, franquia com consulta futura, cartão pausado pela recepção', async () => {
  const equipe = novo({ falas: [{ autor: 'user', em: AGORA - 30 * H }] });
  const hoje = novo({ falas: [{ autor: 'bot', em: AGORA - 5 * H }] });
  const futura = novo();
  const emTrat = novo();
  const pausado = novo();
  const livre = novo();
  franquia = (id) => (id === futura.lead.id ? { ...SEM_FRANQUIA, conhecido: true, consultaFutura: true } : id === emTrat.lead.id ? { ...SEM_FRANQUIA, conhecido: true, emAndamento: true } : SEM_FRANQUIA);
  pausados.add(pausado.lead.id);
  const r = await etapas(ctx(), false);
  assert.deepEqual(chamadas.filter((x) => x.startsWith('addTag')), [`addTag:${livre.lead.id}:▶ Retomada`]);
  assert.equal(r.qualificacao.seguradas['equipe-conversando'], 1);
  assert.equal(r.qualificacao.seguradas['falaram-hoje'], 1);
  assert.equal(r.qualificacao.seguradas['franquia-segura'], 2);
  assert.equal(r.qualificacao.seguradas['lead-pausado'], 1);
  assert.ok(equipe && hoje);
});

test('conversa com mensagem nas últimas 24 h no banco nem gasta chamada; o paciente que escreveu no meio tempo não recebe', async () => {
  const recente = novo({ silencioDias: 3 });
  conversas.set(String(recente.lead.id), AGORA - 3 * H);
  const escreveu = novo({ silencioDias: 3 });
  escreveu.falas.push({ autor: 'external', em: AGORA - 600 }); // a conversa oficial já tem fala dele de agora há pouco
  await etapas(ctx(), false);
  assert.equal(tagsPostas().length, 0);
  assert.ok(!chamadas.includes(`mensagem:${recente.contato}`), 'a peneira do banco poupou a chamada');
});

test('quem nunca escreveu, quem é estoque antigo e quem está em outra etapa não recebem', async () => {
  novo({ silencioDias: null });
  novo({ silencioDias: 40 });
  novo({ etapa: [COM, 14], silencioDias: 3 }); // EM ESPERA não é da régua por etapa
  novo({ etapa: [COM, 15], silencioDias: 3 }); // AGENDADO também não
  const r = await etapas(ctx(), false);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.qualificacao.foraDaJanela, 2);
});

test('funil TRATAMENTO nunca é varrido pelas réguas de silêncio', async () => {
  novo({ etapa: [TRAT, 21], silencioDias: 5 });
  novo({ etapa: [TRAT, 22], silencioDias: 5 });
  await etapas(ctx(), false);
  assert.equal(chamadas.length, 0, 'nem leu o cartão');
});

test('no dia do aniversário o cartão de PACIENTE é do toque de aniversário (quando ele está ligado): a retomada pula; lead que nunca consultou segue', async () => {
  const hoje = new Date(AGORA * 1000).toISOString().slice(5, 10);
  const nasc = Date.parse(`1980-${hoje}T03:00:00Z`) / 1000;
  novo({ etapa: [COM, 12], campos: { '◷ Data de nascimento': nasc, '◷ Data da Consulta': AGORA - 3 * DIA, '✓ Situação da consulta': 'Não compareceu' }, silencioDias: 2 });
  const lead = novo({ campos: { '◷ Data de nascimento': nasc } });
  const c = ctx();
  c.aniversarioLigado = true;
  const r = await etapas(c, false);
  assert.deepEqual(chamadas.filter((x) => x.startsWith('addTag')), [`addTag:${lead.lead.id}:▶ Retomada`]);
  assert.equal(r.naocompareceu.barrados['aniversario-hoje'], 1);
  chamadas.length = 0;
  tracos = new Map();
  _limparCacheDaRotina();
  const desligado = ctx(); // aniversário desligado: ninguém cede nada
  await etapas(desligado, false);
  assert.equal(tagsPostas().length, 2);
});

test('não junto de outro toque no mesmo dia: o cartão que já recebeu algo hoje (rotina ou etiquetas-auto) fica pra amanhã', async () => {
  const a = novo();
  const b = novo();
  const c = ctx();
  tracos.set('x-rotina', { id: `rotina-${c.unit.id}-${a.lead.id}-negociacao-1-1`, unitId: c.unit.id, leadId: String(a.lead.id), createdAt: new Date(AGORA * 1000) });
  tracos.set('x-auto', { id: `etiqueta-${c.unit.id}-boas-vindas:${b.lead.id}:1`, unitId: c.unit.id, leadId: String(b.lead.id), createdAt: new Date(AGORA * 1000) });
  tracos.set(`rotina-${c.unit.id}-${a.lead.id}-negociacao-1-1`, tracos.get('x-rotina') as Traco);
  tracos.delete('x-rotina');
  const r = await etapas(c, false);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.qualificacao.barrados['ja-recebeu-toque-hoje'], 2);
});

// ─── teto ─────────────────────────────────────────────────────────────────────────────────────────

test('teto por unidade por dia: o que já saiu hoje conta, e o resto fica pra amanhã', async () => {
  for (let i = 0; i < 6; i++) novo();
  const c = ctx({ intents: { rotina_teto_dia: 4 } });
  for (let k = 0; k < 3; k++) {
    const id = `rotina-${c.unit.id}-9${k}-aniv-1-2026`;
    tracos.set(id, { id, unitId: c.unit.id, leadId: `9${k}`, createdAt: new Date(AGORA * 1000) });
  }
  // o worker conta as marcas de hoje; o teste monta o contexto como a varredura monta
  c.teto.restanteHoje = Math.max(0, c.cfg.teto - 3);
  const r = await etapas(c, false);
  assert.equal(tagsPostas().length, 1, 'cabia 1 (4 − 3 do aniversário de hoje)');
  assert.ok(r.qualificacao.acimaDoTeto >= 1);
});

test('teto da varredura (10 por padrão): não solta tudo de uma vez', async () => {
  for (let i = 0; i < 14; i++) novo();
  await etapas(ctx({ intents: { rotina_teto_dia: 30 } }), false);
  assert.equal(tagsPostas().length, 10);
});

test('falha ao pôr a etiqueta: se o cartão NÃO tem a etiqueta, solta a marca (tenta de novo); se ela consta (timeout depois de gravar), a marca fica', async () => {
  const a = novo();
  const b = novo();
  const original = kommo.addTag;
  (kommo as { addTag: unknown }).addTag = async (p: { leadId: number; tag?: string }) => {
    if (p.leadId === b.lead.id) tagsNoKommo.set(b.lead.id, [p.tag as string]); // o Kommo gravou e a resposta se perdeu
    throw new Error('timeout');
  };
  try {
    const c = ctx();
    const r = await etapas(c, false);
    assert.equal(r.qualificacao.erros, 2);
    assert.ok(!tracos.has(`rotina-${c.unit.id}-${a.lead.id}-qualificacao-1-${a.paciente}`), 'não gravou: a marca saiu, a próxima varredura tenta de novo');
    assert.ok(tracos.has(`rotina-${c.unit.id}-${b.lead.id}-qualificacao-1-${b.paciente}`), 'gravou: a marca FICA, senão o paciente recebe o modelo duas vezes');
    assert.equal(c.teto.restanteHoje, 29, 'o teto conta o que saiu de fato (b, que o Kommo gravou); a falha de verdade (a) não gasta vaga');
  } finally {
    (kommo as { addTag: unknown }).addTag = original;
  }
});

// ─── etiqueta inexistente ─────────────────────────────────────────────────────────────────────────

test('a conta sem ▶ Retomada não faz nada nas etapas (e não cria etiqueta solta)', async () => {
  novo();
  const r = await etapas(ctx({ tags: ['NO_FOLLOW_UP', 'LOMBAR'] }), false);
  assert.equal(chamadas.length, 0, 'nem leu cartão');
  assert.equal(r.etapas.seguradas['sem-etiqueta-na-conta'], 1);
});

test('degrau cuja etiqueta a conta não tem: não manda, e no papel aparece o porquê', async () => {
  const a = novo({ silencioDias: 5 });
  const c = ctx({ intents: { rotina_toques_prontos: 3 }, tags: ['▶ Retomada'] });
  const id = `rotina-${c.unit.id}-${a.lead.id}-qualificacao-1-${a.paciente}`;
  tracos.set(id, { id, unitId: c.unit.id, leadId: String(a.lead.id), createdAt: new Date((AGORA - 3 * DIA) * 1000) });
  const r = await etapas(c, true);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.qualificacao.seguradas['sem-etiqueta-na-conta'], 1);
  assert.ok(simulacoes.some((s) => s.acao === 'pularia' && /não tem a etiqueta ▶ Retomada 2/.test(s.motivo ?? '')));
});

test('degrau sem robô/gatilho confirmado (rotina_toques_prontos=1) não sai, mesmo com a etiqueta na conta', async () => {
  const a = novo({ silencioDias: 5 });
  const c = ctx();
  const id = `rotina-${c.unit.id}-${a.lead.id}-qualificacao-1-${a.paciente}`;
  tracos.set(id, { id, unitId: c.unit.id, leadId: String(a.lead.id), createdAt: new Date((AGORA - 3 * DIA) * 1000) });
  const r = await etapas(c, false);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.qualificacao.seguradas['sem-gatilho-confirmado'], 1);
});

// ─── seco ─────────────────────────────────────────────────────────────────────────────────────────

test('SECO não escreve nada: nem etiqueta, nem nota, nem marca — só registra «etiquetaria» por etapa e por degrau', async () => {
  novo({ etapa: [COM, 11], silencioDias: 3 });
  novo({ etapa: [COM, 12], silencioDias: 2 });
  novo({ etapa: [COM, 13], silencioDias: 3 });
  novo({ etapa: [COM, 13], silencioDias: 3, tags: ['NO_FOLLOW_UP'] });
  const c = ctx();
  const r = await etapas(c, true);
  assert.equal(escritas().length, 0, 'nenhuma escrita no Kommo');
  assert.equal(tracos.size, 0, 'nenhuma marca');
  const quem = simulacoes.filter((s) => s.acao === 'etiquetaria');
  assert.equal(quem.length, 3);
  assert.deepEqual(quem.map((s) => s.deEtapa).sort(), [ETAPA.NAO_COMPARECEU, ETAPA.NEGOCIACAO, ETAPA.QUALIFICACAO].sort());
  assert.ok(quem.every((s) => s.alvo === '1º toque · ▶ Retomada' && s.automacao === 'rotina-robos'));
  assert.equal(r.qualificacao.porToque['1'] + r.naocompareceu.porToque['1'] + r.negociacao.porToque['1'], 3);
  assert.equal(c.teto.simulado, 27, 'o seco simula o teto');
  assert.equal(c.teto.restanteHoje, 30, 'sem gastar o teto de verdade');
});

test('seco acima do teto mostra «pularia: teto do dia» em vez de calar', async () => {
  for (let i = 0; i < 3; i++) novo();
  const r = await etapas(ctx({ intents: { rotina_teto_dia: 2 } }), true);
  assert.equal(simulacoes.filter((s) => s.acao === 'etiquetaria').length, 2);
  assert.equal(r.qualificacao.acimaDoTeto, 1);
  assert.ok(simulacoes.some((s) => s.acao === 'pularia' && /teto do dia/.test(s.motivo ?? '')));
});

test('o teto «simulado» do papel não gasta a vaga de uma régua LIGADA na mesma unidade', async () => {
  for (let i = 0; i < 3; i++) novo({ etapa: [COM, 12], silencioDias: 2 });
  paciente({ etapa: [COM, 15] });
  const c = ctx({ intents: { rotina_teto_dia: 3 } });
  await aniversario(c, true); // aniversário só no papel
  assert.equal(c.teto.simulado, 2);
  assert.equal(c.teto.restanteHoje, 3, 'o teto de verdade ficou intacto');
  await etapas(c, false); // etapas ligadas
  assert.equal(tagsPostas().length, 3, 'as três retomadas saíram: o papel do aniversário não tirou a vaga delas');
});

test('o que foi decidido «no papel» não segura a mesma decisão depois que a régua é ligada', async () => {
  novo({ silencioDias: 3 });
  const c = ctx();
  await etapas(c, true);
  assert.equal(tagsPostas().length, 0);
  await etapas(c, false);
  assert.equal(tagsPostas().length, 1, 'virou ligado: o cartão é avaliado de novo');
});

test('os estados são por régua e começam DESLIGADOS', () => {
  assert.equal(estadoDasEtapas('serra', undefined), 'desligado');
  assert.equal(estadoDoExLead('serra', undefined), 'desligado');
  assert.equal(estadoDoAniversario('serra', undefined), 'desligado');
  assert.equal(estadoDasEtapas('serra', 'serra'), 'ligado');
  assert.equal(estadoDoExLead('serra', 'salto'), 'desligado', 'ligar uma não liga a outra');
});

// ─── ex-lead ──────────────────────────────────────────────────────────────────────────────────────

async function exlead(c: Ctx, seco: boolean): Promise<Record<string, ResumoDaRegua>> {
  const r: Record<string, ResumoDaRegua> = {};
  await varrerExLead(c, seco, r);
  return r;
}
const PERDIDO: [number, number] = [COM, 143];

test('ex-lead: 30 dias desde a última mensagem em PERDIDO ou EM ESPERA → ▶ Reativação', async () => {
  const p = novo({ etapa: PERDIDO, silencioDias: 31 });
  const e = novo({ etapa: [COM, 14], silencioDias: 35 });
  const cedo = novo({ etapa: PERDIDO, silencioDias: 20 });
  await exlead(ctx(), false);
  const postas = chamadas.filter((x) => x.startsWith('addTag'));
  assert.deepEqual(postas.sort(), [`addTag:${p.lead.id}:▶ Reativação`, `addTag:${e.lead.id}:▶ Reativação`].sort());
  assert.ok(!postas.some((x) => x.includes(String(cedo.lead.id))));
});

test('ex-lead: quem já teve consulta (cartão ou franquia) NÃO é ex-lead', async () => {
  novo({ etapa: PERDIDO, silencioDias: 40, campos: { '✓ Situação da consulta': 'Atendido' } });
  const naFranquia = novo({ etapa: PERDIDO, silencioDias: 40 });
  franquia = (id) => (id === naFranquia.lead.id ? { ...SEM_FRANQUIA, conhecido: true, temHistorico: true } : SEM_FRANQUIA);
  const r = await exlead(ctx(), false);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.exlead.barrados['ja-teve-consulta-no-cartao'], 1);
  assert.equal(r.exlead.seguradas['ja-agendou-na-franquia'], 1);
});

test('ex-lead: motivo de perda encerrado, NO_FOLLOW_UP, opt-out e CURRÍCULO nunca recebem', async () => {
  for (const m of ['Outra cidade', 'Clicou por engano', 'Outra patologia', 'Plano de Saúde', 'Sem interesse']) novo({ etapa: PERDIDO, silencioDias: 40, campos: { '⊘ Motivo do não agendamento': m } });
  novo({ etapa: PERDIDO, silencioDias: 40, tags: ['NO_FOLLOW_UP'] });
  novo({ etapa: PERDIDO, silencioDias: 40, campos: { '✓ Opt-out WhatsApp': 'Sim' } });
  novo({ etapa: PERDIDO, silencioDias: 40, tags: ['CURRÍCULO'] });
  const trabalhavel = novo({ etapa: PERDIDO, silencioDias: 40, campos: { '⊘ Motivo do não agendamento': 'Sem condições financeira' } });
  await exlead(ctx(), false);
  assert.deepEqual(chamadas.filter((x) => x.startsWith('addTag')), [`addTag:${trabalhavel.lead.id}:▶ Reativação`]);
});

test('ex-lead: estoque antigo (silêncio ≥ 60 d sem 1º toque) não entra de uma vez; o 2º e o 3º degraus exigem os degraus prontos', async () => {
  novo({ etapa: PERDIDO, silencioDias: 75 });
  const r = await exlead(ctx(), false);
  assert.equal(r.exlead.foraDaJanela, 1);
  assert.equal(tagsPostas().length, 0);
  const a = novo({ etapa: PERDIDO, silencioDias: 62 });
  const c = ctx({ intents: { rotina_exlead_toques_prontos: 3 } });
  const id = `rotina-${c.unit.id}-${a.lead.id}-exlead-1-${a.paciente}`;
  tracos.set(id, { id, unitId: c.unit.id, leadId: String(a.lead.id), createdAt: new Date((AGORA - 32 * DIA) * 1000) });
  chamadas.length = 0;
  await exlead(c, false);
  assert.deepEqual(tagsPostas(), ['▶ Reativação 2']);
});

test('ex-lead: o relógio também conta da ENTRADA em PERDIDO — o estoque que o parados perdeu depois de meses calado entra 30 dias depois da perda, e a perda de hoje espera', async () => {
  const calouHaMuito = novo({ etapa: PERDIDO, silencioDias: 100, closed: AGORA - 31 * DIA }); // calado há 100 d, perdido há 31
  const perdidoHoje = novo({ etapa: PERDIDO, silencioDias: 100, closed: AGORA - 2 * H }); // calado há 100 d, perdido agora
  const r = await exlead(ctx(), false);
  assert.deepEqual(chamadas.filter((x) => x.startsWith('addTag')), [`addTag:${calouHaMuito.lead.id}:▶ Reativação`]);
  assert.ok(perdidoHoje);
  assert.equal(r.exlead.esperando, 1);
});

test('ex-lead: a ▶ Reativação que o etiquetas-auto já pôs naquele PERDIDO conta como o 1º degrau (nada de mensagem em dobro)', async () => {
  const a = novo({ etapa: PERDIDO, silencioDias: 33, closed: AGORA - 33 * DIA });
  const c = ctx();
  const id = `etiqueta-${c.unit.id}-reativacao:${a.lead.id}:${AGORA - 33 * DIA}`;
  tracos.set(id, { id, unitId: c.unit.id, leadId: String(a.lead.id), createdAt: new Date((AGORA - 3 * DIA) * 1000) });
  await exlead(c, false);
  assert.equal(tagsPostas().length, 0, 'o 1º já saiu; o 2º é com 60 dias');
});

test('ex-lead no seco: registra por régua, não escreve', async () => {
  novo({ etapa: PERDIDO, silencioDias: 31 });
  await exlead(ctx(), true);
  assert.equal(escritas().length, 0);
  assert.equal(tracos.size, 0);
  assert.deepEqual(simulacoes.map((s) => [s.automacao, s.acao, s.alvo]), [['rotina-exlead', 'etiquetaria', '1º toque · ▶ Reativação']]);
});

test('nuncaAgendou: o cartão que mostra consulta, ou a franquia com histórico, desmente; erro da franquia lança', async () => {
  const unit = { id: 'u' } as Unit;
  const lead = (c: Record<string, unknown>) => ({ id: 1, name: 'A', custom_fields_values: campos(c) }) as unknown as KommoLead;
  assert.equal(await nuncaAgendou(unit, lead({}), async () => SEM_FRANQUIA), true);
  assert.equal(await nuncaAgendou(unit, lead({ '◷ Data da Consulta': AGORA }), async () => SEM_FRANQUIA), false);
  assert.equal(await nuncaAgendou(unit, lead({}), async () => ({ ...SEM_FRANQUIA, conhecido: true, temHistorico: true })), false);
  await assert.rejects(nuncaAgendou(unit, lead({}), async () => { throw new Error('franquia fora'); }));
});

// ─── aniversário ──────────────────────────────────────────────────────────────────────────────────

const nasc = (anoMesDia: string) => Date.parse(`${anoMesDia}T03:00:00Z`) / 1000;
const HOJE_MD = '11-06';
async function aniversario(c: Ctx, seco: boolean): Promise<Record<string, ResumoDaRegua>> {
  const r: Record<string, ResumoDaRegua> = {};
  await varrerAniversario(c, seco, r);
  return r;
}
const paciente = (extra: Parameters<typeof novo>[0] = {}) => novo({ ...extra, campos: { '◷ Data de nascimento': nasc(`1980-${HOJE_MD}`), '◷ Data da Consulta': AGORA - 30 * DIA, ...(extra.campos ?? {}) } });

test('aniversário: paciente que faz anos hoje recebe a ▶ Aniversário; quem faz amanhã, não', async () => {
  const hoje = paciente({ etapa: [COM, 15] });
  novo({ etapa: [COM, 15], campos: { '◷ Data de nascimento': nasc('1980-11-07'), '◷ Data da Consulta': AGORA + DIA } });
  await aniversario(ctx(), false);
  assert.deepEqual(chamadas.filter((x) => x.startsWith('addTag')), [`addTag:${hoje.lead.id}:▶ Aniversário`]);
});

test('aniversário vale para ex-paciente em PERDIDO e para o funil TRATAMENTO (ALTA); lead que nunca consultou não ganha parabéns', async () => {
  const perdido = paciente({ etapa: PERDIDO });
  const alta = paciente({ etapa: [TRAT, 22] });
  novo({ etapa: PERDIDO, campos: { '◷ Data de nascimento': nasc(`1980-${HOJE_MD}`) } }); // nunca consultou
  await aniversario(ctx(), false);
  assert.deepEqual(new Set(tagsPostas()), new Set(['▶ Aniversário']));
  const ids = chamadas.filter((x) => x.startsWith('addTag')).map((x) => Number(x.split(':')[1]));
  assert.deepEqual(ids.sort(), [perdido.lead.id, alta.lead.id].sort());
});

test('aniversário de quem está em tratamento ativo: só parabéns (etiqueta própria); sem ela na conta, não manda nada', async () => {
  const emTrat = paciente({ etapa: [TRAT, 21] });
  await aniversario(ctx(), false);
  assert.deepEqual(tagsPostas(), ['▶ Aniversário tratamento']);
  chamadas.length = 0;
  tracos = new Map();
  _limparCacheDaRotina();
  const r = await aniversario(ctx({ tags: ['▶ Aniversário'] }), false);
  assert.equal(tagsPostas().length, 0, 'convite não vale para quem já se trata');
  assert.equal(r.aniv.seguradas['sem-etiqueta-na-conta'], 1);
  assert.ok(emTrat);
});

test('aniversário: sem data de nascimento confiável não manda; sem a etiqueta na conta não faz nada', async () => {
  novo({ etapa: [COM, 15], campos: { '◷ Data da Consulta': AGORA + DIA } });
  paciente({ etapa: [COM, 15] });
  const sem = await aniversario(ctx({ tags: ['LOMBAR'] }), false);
  assert.equal(chamadas.length, 0);
  assert.equal(sem.aniv.seguradas['sem-etiqueta-na-conta'], 1);
  await aniversario(ctx(), false);
  assert.equal(tagsPostas().length, 1, 'só o que tem data');
});

test('aniversário: a franquia é o cadastro — outra data na ficha, ou paciente falecido, não manda; em tratamento na franquia vira «só parabéns»', async () => {
  const outraData = paciente({ etapa: [COM, 15], campos: { '⚙ idClient (franquia)': 1 } });
  const falecido = paciente({ etapa: [COM, 15], campos: { '⚙ idClient (franquia)': 2 } });
  const tratando = paciente({ etapa: [COM, 15], campos: { '⚙ idClient (franquia)': 3 } });
  fichas.set(1, { birthdate: '1980-03-15', status: 'Ativo' });
  fichas.set(2, { birthdate: '1980-11-06', status: 'Óbito' });
  fichas.set(3, { birthdate: '1980-11-06', status: 'Ativo', emTratamento: true });
  const c = ctx();
  (c.unit as { spineEnabled: boolean; spineToken: string }).spineEnabled = true;
  (c.unit as { spineEnabled: boolean; spineToken: string }).spineToken = 't';
  const r = await aniversario(c, false);
  assert.deepEqual(chamadas.filter((x) => x.startsWith('addTag')), [`addTag:${tratando.lead.id}:▶ Aniversário tratamento`]);
  assert.equal(r.aniv.seguradas['franquia-diz-outra-data'], 1);
  assert.equal(r.aniv.barrados['falecido-na-franquia'], 1);
  assert.ok(outraData && falecido);
});

test('aniversário: uma vez por ano por pessoa (a marca é do contato), e nunca junto de outro toque no mesmo dia', async () => {
  const a = paciente({ etapa: [COM, 15] });
  const outro = paciente({ etapa: [COM, 15] });
  const c = ctx();
  // este cartão já recebeu o aniversário de 2026
  const id = `rotina-${c.unit.id}-c${a.contato}-aniv-1-2026`;
  tracos.set(id, { id, unitId: c.unit.id, leadId: String(a.lead.id), createdAt: new Date((AGORA - 3 * H) * 1000) });
  // e este recebeu outra coisa hoje
  const outra = `rotina-${c.unit.id}-${outro.lead.id}-negociacao-1-9`;
  tracos.set(outra, { id: outra, unitId: c.unit.id, leadId: String(outro.lead.id), createdAt: new Date((AGORA - H) * 1000) });
  const r = await aniversario(c, false);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.aniv.barrados['ja-recebeu-este-ano'], 1);
  assert.equal(r.aniv.barrados['ja-recebeu-toque-hoje'], 1);
});

test('aniversário: NO_FOLLOW_UP, NAO_PERTURBAR, opt-out, CURRÍCULO e motivo de perda encerrado nunca recebem; Retomar em futuro NÃO impede', async () => {
  paciente({ tags: ['NO_FOLLOW_UP'] });
  paciente({ tags: ['NAO_PERTURBAR'] });
  paciente({ campos: { '✓ Opt-out WhatsApp': 'Sim' } });
  paciente({ tags: ['CURRÍCULO'] });
  paciente({ etapa: PERDIDO, campos: { '⊘ Motivo do não agendamento': 'Outra cidade' } });
  const livre = paciente({ etapa: [COM, 15], campos: { '◷ Retomar em': AGORA + 9 * DIA } });
  for (const c of cartoes) if (c.lead.status_id === 11) c.lead.status_id = 15;
  await aniversario(ctx(), false);
  assert.deepEqual(chamadas.filter((x) => x.startsWith('addTag')), [`addTag:${livre.lead.id}:▶ Aniversário`]);
});

test('aniversário atrasado: unidade fechada no fim de semana cumprimenta no 1º dia útil (até 2 dias); depois disso a data passou', async () => {
  const dois = novo({ etapa: [COM, 15], campos: { '◷ Data de nascimento': nasc('1980-11-04'), '◷ Data da Consulta': AGORA - 30 * DIA } });
  novo({ etapa: [COM, 15], campos: { '◷ Data de nascimento': nasc('1980-11-03'), '◷ Data da Consulta': AGORA - 30 * DIA } });
  await aniversario(ctx(), false);
  assert.deepEqual(chamadas.filter((x) => x.startsWith('addTag')), [`addTag:${dois.lead.id}:▶ Aniversário`]);
});

test('aniversário só de manhã, no fuso da unidade; fora da janela não lê nem o funil', async () => {
  paciente({ etapa: [COM, 15] });
  const r = await aniversario(ctx({ agora: Date.UTC(2026, 10, 6, 20, 0, 0) / 1000 }), false);
  assert.equal(chamadas.length, 0);
  assert.equal(r.aniv.seguradas['fora-da-janela-da-manha'], 1);
});

test('aniversário no seco: não escreve, não marca, e registra por régua', async () => {
  paciente({ etapa: [COM, 15] });
  await aniversario(ctx(), true);
  assert.equal(escritas().length, 0);
  assert.equal(tracos.size, 0);
  assert.deepEqual(simulacoes.map((s) => [s.automacao, s.acao, s.alvo]), [['rotina-aniversario', 'etiquetaria', '1º toque · ▶ Aniversário']]);
});

test('o teto do dia é um só para as três réguas: o aniversário gasta a vaga das outras', async () => {
  paciente({ etapa: [COM, 15] });
  novo({ silencioDias: 3 });
  const c = ctx({ intents: { rotina_teto_dia: 1 } });
  await aniversario(c, false);
  await etapas(c, false);
  assert.deepEqual(tagsPostas(), ['▶ Aniversário'], 'o aniversário saiu primeiro e esgotou o teto de 1');
});
