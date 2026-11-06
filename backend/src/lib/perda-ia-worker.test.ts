/**
 * perda-ia e motivo-perdido-ia ponta a ponta, com Kommo, banco, franquia e Anthropic falsos (06/11/2026).
 *
 * Prova: seco não escreve nada no Kommo (e registra «moveria»/«gravaria»); ligado move pelo MESMO fecho do parados (etiquetas →
 * motivo → status → nota); teto por varredura; o que não pode mover nem chega a gastar leitura de conversa; a franquia segura;
 * motivo preenchido não é tocado; opção inexistente e falha da IA não gravam nada.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { SpineService } from '../services/spine.service.js';
import { ETAPA } from './franquia-move.js';
import type { Funis } from './franquia-sync-worker.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import { fecharComoPerdido } from './parados-worker.js';
import { MAX_AVALIACOES, MAX_LEITURAS, MAX_MOVIMENTOS, MAX_MOTIVOS, decisaoDeFecho, varrerMotivos, varrerPerda } from './perda-ia-worker.js';
import { TAG_PERDA_IA } from './perda-ia.js';

// ── banco falso ──
let conversasComFala = new Set<string>();
const simulacoes: Array<{ kommoLeadId: number; acao: string; alvo: string; valor: string | null; motivo: string | null }> = [];
let vinculoDoLead: number | null = null;
Object.defineProperty(prisma, 'conversation', {
  value: { findMany: async (a: { where: { leadId: { in: string[] } } }) => a.where.leadId.in.filter((id) => conversasComFala.has(id)).map((leadId) => ({ leadId })) },
  configurable: true,
});
Object.defineProperty(prisma, 'automacaoSimulacao', {
  value: {
    upsert: async (a: { create: { kommoLeadId: number; acao: string; alvo: string; valor: string | null; motivo: string | null } }) => void simulacoes.push(a.create),
    deleteMany: async () => ({}),
  },
  configurable: true,
});
Object.defineProperty(prisma, 'cardAlert', { value: { upsert: async () => ({}), findMany: async () => [] }, configurable: true });
Object.defineProperty(prisma, 'unitAutomacao', { value: { findMany: async () => [] }, configurable: true });
Object.defineProperty(prisma, 'llmCall', { value: { create: async () => ({}) }, configurable: true });
Object.defineProperty(prisma, 'systemLog', { value: { create: async () => ({}) }, configurable: true });
Object.defineProperty(prisma, 'spineLeadLink', {
  value: { findFirst: async () => (vinculoDoLead ? { spineIdClient: vinculoDoLead } : null) },
  configurable: true,
});

// ── tempo e unidade ──
const AGORA = Math.floor(Date.now() / 1000);
const H = 3600;
const PAUSAR_IA = 777;
let n = 0;
function unidade(extra: Partial<Unit> = {}): Unit {
  const slug = `teste-perda-ia-${++n}`;
  return { id: `u-${slug}`, slug, spineEnabled: false, spineToken: null, spineTimezone: 'UTC', kommoSubdomain: 'teste', kommoPausedFieldId: PAUSAR_IA, anthropicApiKey: 'sk-teste', ...extra } as unknown as Unit;
}

// ── funis ──
const QUALIFICACAO = { pipelineId: 1, statusId: 11 };
const ESPERA = { pipelineId: 1, statusId: 12 };
const funis = {
  comercialId: 1,
  tratamentoId: null,
  status: new Map(),
  nomeDe: (_p: number, statusId: number) => (statusId === 11 ? { funil: 'COMERCIAL', status: ETAPA.QUALIFICACAO } : statusId === 12 ? { funil: 'COMERCIAL', status: ETAPA.ESPERA } : statusId === 143 ? { funil: 'COMERCIAL', status: ETAPA.PERDIDO } : null),
  idDe: (funil: string, etapa: string) => (funil !== 'COMERCIAL' ? null : etapa === ETAPA.QUALIFICACAO ? QUALIFICACAO : etapa === ETAPA.ESPERA ? ESPERA : null),
} as unknown as Funis;

const OPCOES = ['Plano de Saúde', 'Sem condições financeira', 'Outra cidade', 'Sem interesse', 'Clicou por engano', 'Não interagiu', 'Não deu continuidade ao atendimento'];

// ── conversas e IA ──
type Fala = { autor: 'PACIENTE' | 'SOFIA' | 'EQUIPE'; texto: string; h: number };
const conversas = new Map<number, Fala[]>();
const respostasDaIa = new Map<number, string>();
let iaFora = false;
let chamadasAIa = 0;
let leiturasDeConversa = 0;
let escreveuNoMeio = false;

function msgsDoKommo(leadId: number) {
  return (conversas.get(leadId) ?? []).map((f, i) => ({
    id: `m${leadId}-${i}`,
    type: f.autor === 'PACIENTE' ? 'incoming' : 'outgoing',
    text: f.texto,
    created_at: AGORA - f.h * H,
    author: f.autor === 'PACIENTE' ? { type: 'external' } : f.autor === 'SOFIA' ? { type: 'bot', name: 'Salesbot' } : { type: 'internal', name: 'Giulia' },
  }));
}

beforeEach(() => {
  conversasComFala = new Set();
  simulacoes.length = 0;
  vinculoDoLead = null;
  conversas.clear();
  respostasDaIa.clear();
  iaFora = false;
  chamadasAIa = 0;
  leiturasDeConversa = 0;
  escreveuNoMeio = false;
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async (_url: unknown, init: { body: string }) => {
    chamadasAIa++;
    if (iaFora) return { ok: false, status: 500, json: async () => ({ error: { type: 'overloaded' } }) };
    const prompt = String(JSON.parse(init.body).messages[0].content);
    const id = Number(/#(\d+)#/.exec(prompt)?.[1]);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: respostasDaIa.get(id) ?? '{"perdido":"nao","padrao":"nenhum","confianca":"baixa","justificativa":"sem sinal"}' }], usage: { input_tokens: 2500, output_tokens: 100 } }) };
  });
});

const RECUSA = (frase: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ perdido: 'sim', padrao: 'recusa', confianca: 'alta', motivo: 'Sem interesse', frase_do_paciente: frase, justificativa: 'recusou com clareza', ...extra });

// ── Kommo falso ──
interface Escritas {
  status: Array<{ id: number; lossReasonId?: number }>;
  tags: Array<{ id: number; tags: string[] }>;
  notas: Array<{ id: number; texto: string }>;
  campos: Array<{ id: number; campo: number; valor: string }>;
  ordem: string[];
  removidas: Array<{ id: number; tag: string }>;
}
function kommoFalso(leads: KommoLead[], e: Escritas, fresco: Record<number, Partial<KommoLead>> = {}): KommoClient {
  const porId = (id: number) => ({ ...(leads.find((l) => l.id === id) as KommoLead), ...(fresco[id] ?? {}) });
  return {
    listLeadsPorEtapa: async (_p: number, statusId: number, _l: number, page: number) => (page === 1 ? leads.filter((l) => l.status_id === statusId) : []),
    listLeadsDasEtapasDesde: async (_e: unknown, _d: number, page: number) => (page === 1 ? leads.filter((l) => l.status_id === 143) : []),
    listTalks: async (id: number) => {
      leiturasDeConversa++;
      return conversas.has(id) ? [{ talk_id: id }] : [];
    },
    listTalkMessages: async (talkId: number) => msgsDoKommo(talkId),
    getLead: async (id: number) => porId(id),
    contatoEscreveuDesde: async () => escreveuNoMeio,
    listLossReasons: async () => [{ id: 900, name: 'Sem interesse' }],
    createLossReason: async (name: string) => ({ id: 901, name }),
    listLeadCustomFields: async () => ({ _embedded: { custom_fields: [{ id: 5, name: '⊘ Motivo do não agendamento' }] } }),
    listPipelines: async () => [],
    listLeadTags: async () => [{ id: 1, name: 'NO_FOLLOW_UP' }],
    removeTag: async (id: number, tag: string) => void e.removidas.push({ id, tag }),
    addTag: async (a: { leadId: number; tags?: string[] }) => {
      e.ordem.push('tag');
      e.tags.push({ id: a.leadId, tags: a.tags ?? [] });
    },
    addLeadNote: async (id: number, texto: string) => {
      e.notas.push({ id, texto });
      return {};
    },
    setLeadCustomFieldValue: async (id: number, campo: number, _t: string, valor: string) => {
      e.ordem.push('campo');
      e.campos.push({ id, campo, valor });
    },
    setLeadStatus: async (id: number, o: { lossReasonId?: number }) => {
      e.ordem.push('status');
      e.status.push({ id, lossReasonId: o.lossReasonId });
    },
    listLeadCustomFieldsTyped: async () => [{ id: 5, name: '⊘ Motivo do não agendamento', type: 'select', code: null, enums: OPCOES.map((value, i) => ({ id: i + 1, value })) }],
  } as unknown as KommoClient;
}
const escritas = (): Escritas => ({ status: [], tags: [], notas: [], campos: [], ordem: [], removidas: [] });

const lead = (id: number, statusId = 11, extra: Partial<KommoLead> = {}): KommoLead => ({ id, name: `Lead ${id}`, status_id: statusId, pipeline_id: 1, updated_at: AGORA - id, custom_fields_values: [], _embedded: { tags: [] }, ...extra });
/** um cartão cujo paciente recusou há 70 h e a Sofia respondeu */
function comRecusa(id: number, frase = 'não tenho interesse, obrigado', ia = RECUSA('não tenho interesse')) {
  conversas.set(id, [{ autor: 'PACIENTE', texto: `quanto custa? #${id}#`, h: 80 }, { autor: 'SOFIA', texto: 'R$ 250', h: 79 }, { autor: 'PACIENTE', texto: frase, h: 70 }, { autor: 'SOFIA', texto: 'tudo bem!', h: 70 }]);
  conversasComFala.add(String(id));
  respostasDaIa.set(id, ia);
  return lead(id);
}

const resumoNovo = (unit: Unit, seco: boolean) => ({ unit: unit.slug, automacao: 'perda-ia', seco, candidatos: 0, avaliados: 0, moveria: 0, gravados: 0, vacuo: 0, seguradosPelaFranquia: 0, erros: 0, custoUsd: 0 });
const ctxDe = (unit: Unit, kommo: KommoClient, seco: boolean, opcoes = OPCOES) => ({ unit, kommo, funis, grupo: null, unidadesDaConta: [unit], pausarIaFieldId: PAUSAR_IA, seco, agora: AGORA, opcoes });

// ───────────────────────── perda-ia ─────────────────────────

test('SECO não grava nada no Kommo: registra «moveria» com motivo e justificativa — e a leitura da IA rodou', async () => {
  const unit = unidade();
  const e = escritas();
  const l = comRecusa(101);
  const r = resumoNovo(unit, true);
  await varrerPerda(ctxDe(unit, kommoFalso([l], e), true), r);
  assert.equal(chamadasAIa, 1);
  assert.deepEqual([e.status, e.tags, e.notas, e.campos], [[], [], [], []], 'o papel não escreve em cartão nenhum');
  assert.equal(r.moveria, 1);
  const s = simulacoes.find((x) => x.kommoLeadId === 101);
  assert.equal(s?.acao, 'moveria');
  assert.equal(s?.valor, 'Sem interesse');
  assert.match(s?.motivo ?? '', /recusou com clareza/);
  assert.ok(r.custoUsd > 0);
});

test('LIGADO move pelo fecho do parados: etiquetas ANTES do status, motivo no cartão, motivo de perda, nota com padrão e justificativa', async () => {
  const unit = unidade();
  const e = escritas();
  const l = comRecusa(102);
  const r = resumoNovo(unit, false);
  await varrerPerda(ctxDe(unit, kommoFalso([l], e), false), r);
  assert.deepEqual(e.ordem, ['tag', 'campo', 'status'], 'a etiqueta entra antes do status: o gatilho de PERDIDO lê a condição no evento');
  assert.deepEqual(e.tags[0].tags, [TAG_PERDA_IA, 'NO_FOLLOW_UP'], 'recusa definitiva leva a etiqueta de não contatar: a régua de PERDIDO não manda nada');
  assert.deepEqual(e.campos[0], { id: 102, campo: 5, valor: 'Sem interesse' });
  assert.equal(e.status[0].id, 102);
  assert.equal(e.status[0].lossReasonId, 900);
  assert.match(e.notas[0].texto, /pela IA, que leu a conversa/);
  assert.match(e.notas[0].texto, /recusa clara/);
  assert.match(e.notas[0].texto, /recusou com clareza/);
  assert.match(e.notas[0].texto, /não tenho interesse/);
  assert.doesNotMatch(e.notas[0].texto, /pelo prazo/, 'não pode dizer que foi o prazo');
  assert.equal(r.moveria, 1);
});

test('motivo recuperável (preço) não leva NO_FOLLOW_UP: pode receber a régua de PERDIDO da conta', async () => {
  const unit = unidade();
  const e = escritas();
  const l = comRecusa(103, 'achei muito caro, não tenho condições', RECUSA('achei muito caro', { motivo: 'Sem condições financeira' }));
  await varrerPerda(ctxDe(unit, kommoFalso([l], e), false), resumoNovo(unit, false));
  assert.deepEqual(e.tags[0].tags, [TAG_PERDA_IA]);
  assert.match(e.notas[0].texto, /pode receber a régua de PERDIDO/);
});

test('REVISÃO 4: motivo definitivo exige a etiqueta — se o addTag falha, o cartão NÃO é movido e a nota não afirma etiqueta', async () => {
  const unit = unidade();
  const e = escritas();
  const k = { ...kommoFalso([comRecusa(901)], e), addTag: async () => { throw new Error('kommo 500'); } } as unknown as KommoClient;
  const r = resumoNovo(unit, false);
  await varrerPerda(ctxDe(unit, k, false), r);
  assert.deepEqual([e.status, e.notas, e.campos], [[], [], []], 'sem etiqueta, nada é escrito e o cartão fica aberto');
  assert.equal(r.moveria, 0);
  await varrerPerda(ctxDe(unit, k, false), resumoNovo(unit, false));
  assert.equal(chamadasAIa, 2, 'falha de etiqueta é transitória: o cartão não fica de molho por um dia');
});

test('REVISÃO 4: o parados de sempre segue IDÊNTICO — etiqueta que falha só loga e o cartão é movido', async () => {
  const unit = unidade();
  const e = escritas();
  const l = lead(902);
  const k = { ...kommoFalso([l], e), addTag: async () => { throw new Error('kommo 500'); } } as unknown as KommoClient;
  const d = { para: 'PERDIDO' as const, regra: 'EM ESPERA há mais de 30 dias', dias: 30, motivoPerda: 'Não deu continuidade ao atendimento', semRegua: true };
  const fechou = await fecharComoPerdido(unit, k, funis, 902, ETAPA.QUALIFICACAO, d, false, 'parados', l);
  assert.equal(fechou, true);
  assert.equal(e.status.length, 1);
});

test('REVISÃO 4b: o status falha DEPOIS de a etiqueta entrar → a perda-ia desfaz as etiquetas (cartão não fica calado e fora da varredura); o parados de sempre não mexe', async () => {
  const unit = unidade();
  const e = escritas();
  const l = comRecusa(910);
  const k = { ...kommoFalso([l], e), setLeadStatus: async () => { throw new Error('kommo 500 no status'); } } as unknown as KommoClient;
  const r = resumoNovo(unit, false);
  await varrerPerda(ctxDe(unit, k, false), r);
  assert.deepEqual(e.removidas.map((x) => x.tag).sort(), ['NO_FOLLOW_UP', 'perdido pela IA']);
  assert.equal(r.erros, 1);
  assert.equal(r.moveria, 0);

  const e2 = escritas();
  const l2 = lead(911);
  const k2 = { ...kommoFalso([l2], e2), setLeadStatus: async () => { throw new Error('kommo 500 no status'); } } as unknown as KommoClient;
  const d = { para: 'PERDIDO' as const, regra: 'x', dias: 30, motivoPerda: 'Não interagiu', semRegua: true };
  await assert.rejects(fecharComoPerdido(unidade(), k2, funis, 911, ETAPA.QUALIFICACAO, d, false, 'parados', l2));
  assert.deepEqual(e2.removidas, [], 'o parados de sempre: comportamento idêntico, sem desfazer nada');
});

test('REVISÃO 4c: o status deu timeout mas o Kommo JÁ moveu o cartão → as etiquetas ficam (a régua não pode mandar mensagem)', async () => {
  const unit = unidade();
  const e = escritas();
  const l = comRecusa(912);
  const k = { ...kommoFalso([l], e, {}), setLeadStatus: async () => { throw new Error('timeout'); } } as unknown as KommoClient;
  let leituras = 0;
  const comMovido = { ...k, getLead: async (id: number) => (++leituras >= 3 ? { ...l, id, status_id: 143 } : l) } as unknown as KommoClient;
  const r = await (async () => { const res = resumoNovo(unit, false); await varrerPerda(ctxDe(unit, comMovido, false), res); return res; })();
  assert.equal(r.erros, 1, 'chegou ao status (e errou)');
  assert.deepEqual(e.removidas, []);
});

test('motivo recuperável (preço) NÃO tem etiqueta obrigatória: se o addTag falha, move assim mesmo (a nota diz que a régua pode ir)', async () => {
  const d = decisaoDeFecho({ tipo: 'mover', padrao: 'recusa', motivo: 'Sem condições financeira', justificativa: 'caro.', frase: 'achei caro' }, 'EM ESPERA');
  assert.equal(d.etiquetaObrigatoria, false);
  assert.match(d.nota ?? '', /pode receber a régua/);
});

test('REVISÃO 7: conta sem a etiqueta NO_FOLLOW_UP (Rio Verde) não move motivo definitivo — e o seco mostra por quê', async () => {
  const unit = unidade();
  const e = escritas();
  const k = { ...kommoFalso([comRecusa(903)], e), listLeadTags: async () => [{ id: 1, name: 'NAO_PERTURBAR' }] } as unknown as KommoClient;
  const r = resumoNovo(unit, true);
  await varrerPerda(ctxDe(unit, k, true), r);
  assert.equal(r.moveria, 0);
  assert.match(simulacoes.find((x) => x.kommoLeadId === 903)?.motivo ?? '', /não tem a etiqueta NO_FOLLOW_UP/);
  // ligado: o mesmo, sem escrita
  const unit2 = unidade();
  const e2 = escritas();
  const k2 = { ...kommoFalso([comRecusa(904)], e2), listLeadTags: async () => [{ id: 1, name: 'NAO_PERTURBAR' }] } as unknown as KommoClient;
  await varrerPerda(ctxDe(unit2, k2, false), resumoNovo(unit2, false));
  assert.deepEqual([e2.status, e2.tags], [[], []]);
  // e o preço (sem etiqueta obrigatória) move mesmo nessa conta
  const unit3 = unidade();
  const e3 = escritas();
  const caro = comRecusa(905, 'achei muito caro, não tenho condições', RECUSA('achei muito caro', { motivo: 'Sem condições financeira' }));
  const k3 = { ...kommoFalso([caro], e3), listLeadTags: async () => [] } as unknown as KommoClient;
  await varrerPerda(ctxDe(unit3, k3, false), resumoNovo(unit3, false));
  assert.equal(e3.status.length, 1);
});

test('padrão 3, vácuo: não move (é do parados), aparece como «pularia» no papel', async () => {
  const unit = unidade();
  const e = escritas();
  conversas.set(104, [{ autor: 'PACIENTE', texto: `quanto custa? #104#`, h: 200 }, { autor: 'SOFIA', texto: 'R$ 250', h: 199 }, { autor: 'SOFIA', texto: 'ainda aí?', h: 150 }, { autor: 'SOFIA', texto: 'posso ajudar?', h: 100 }, { autor: 'SOFIA', texto: 'último toque', h: 60 }]);
  conversasComFala.add('104');
  respostasDaIa.set(104, JSON.stringify({ perdido: 'sim', padrao: 'sem_resposta', confianca: 'alta', motivo: 'Não deu continuidade ao atendimento', frase_do_paciente: '', justificativa: '3 toques sem resposta' }));
  const r = resumoNovo(unit, true);
  await varrerPerda(ctxDe(unit, kommoFalso([lead(104)], e), true), r);
  assert.equal(r.moveria, 0);
  assert.equal(r.vacuo, 1);
  assert.equal(simulacoes.find((x) => x.kommoLeadId === 104)?.acao, 'pularia');
  assert.deepEqual(e.status, []);
});

test('dúvida aberta (última fala é do paciente, com pergunta) não move, no papel nem ligado', async () => {
  for (const seco of [true, false]) {
    const unit = unidade();
    const e = escritas();
    conversas.set(105, [{ autor: 'SOFIA', texto: `R$ 250 #105#`, h: 80 }, { autor: 'PACIENTE', texto: 'não tenho interesse, mas atende pelo plano?', h: 70 }]);
    conversasComFala.add('105');
    respostasDaIa.set(105, RECUSA('não tenho interesse'));
    const r = resumoNovo(unit, seco);
    await varrerPerda(ctxDe(unit, kommoFalso([lead(105)], e), seco), r);
    assert.equal(r.moveria, 0, `seco=${seco}`);
    assert.deepEqual(e.status, []);
  }
});

test('consulta futura no cartão, ◷ Retomar em no futuro, «Pausar IA», NO_FOLLOW_UP e CURRÍCULO: nem a conversa é lida', async () => {
  const unit = unidade();
  const e = escritas();
  const futuro = AGORA + 5 * 86_400;
  const cards = [
    comRecusa(201), comRecusa(202), comRecusa(203), comRecusa(204), comRecusa(205),
  ];
  cards[0].custom_fields_values = [{ field_name: '◷ Data da Consulta', values: [{ value: futuro }] }, { field_name: '✓ Situação da consulta', values: [{ value: 'Agendado' }] }] as never;
  cards[1].custom_fields_values = [{ field_name: '◷ Retomar em', values: [{ value: futuro }] }] as never;
  cards[2].custom_fields_values = [{ field_id: PAUSAR_IA, field_name: 'Pausar IA', values: [{ value: true }] }] as never;
  cards[3]._embedded = { tags: [{ id: 1, name: 'NO_FOLLOW_UP' }] };
  cards[4]._embedded = { tags: [{ id: 2, name: 'CURRÍCULO' }] };
  const r = resumoNovo(unit, false);
  await varrerPerda(ctxDe(unit, kommoFalso(cards, e), false), r);
  assert.equal(leiturasDeConversa, 0);
  assert.equal(chamadasAIa, 0);
  assert.deepEqual(e.status, []);
});

test('consulta futura NA FRANQUIA segura: a IA disse perdido, a franquia diz que ele vem na semana que vem', async () => {
  const unit = unidade({ spineEnabled: true, spineToken: 'tk' } as Partial<Unit>);
  vinculoDoLead = 4242;
  const amanha = new Date((AGORA + 86_400) * 1000).toISOString();
  mock.method(SpineService, 'getClient', async () => ({
    ok: true as const,
    data: { client: { idClient: 4242, name: 'X', whatsapp: null, schedules: [{ idSchedule: 1, categoryName: 'Avaliação', idStatus: 37, dateAttendanceUtc: amanha }], treatments: [] } },
  }));
  const e = escritas();
  const r = resumoNovo(unit, false);
  await varrerPerda(ctxDe(unit, kommoFalso([comRecusa(301)], e), false), r);
  assert.equal(chamadasAIa, 1);
  assert.equal(r.seguradosPelaFranquia, 1);
  assert.deepEqual(e.status, []);
});

test('franquia fora do ar: o cartão fica (erro nunca vira «livre para perder»)', async () => {
  const unit = unidade({ spineEnabled: true, spineToken: 'tk' } as Partial<Unit>);
  vinculoDoLead = 4343;
  mock.method(SpineService, 'getClient', async () => ({ ok: false as const, error: 'timeout' }));
  const e = escritas();
  const r = resumoNovo(unit, false);
  await varrerPerda(ctxDe(unit, kommoFalso([comRecusa(302)], e), false), r);
  assert.equal(r.erros, 1);
  assert.deepEqual(e.status, []);
});

test('equipe conversando nas últimas 24 h e paciente recente: não gasta IA', async () => {
  const unit = unidade();
  const e = escritas();
  const l1 = comRecusa(401);
  conversas.get(401)!.push({ autor: 'EQUIPE', texto: 'oi, posso ajudar?', h: 3 });
  const l2 = comRecusa(402, 'não tenho interesse');
  conversas.set(402, [{ autor: 'PACIENTE', texto: `não tenho interesse #402#`, h: 5 }, { autor: 'SOFIA', texto: 'ok', h: 5 }]);
  await varrerPerda(ctxDe(unit, kommoFalso([l1, l2], e), false), resumoNovo(unit, false));
  assert.equal(chamadasAIa, 0);
  assert.deepEqual(e.status, []);
});

test('quem nunca escreveu (sem mensagem do paciente no banco) não gasta nem a leitura da conversa', async () => {
  const unit = unidade();
  const e = escritas();
  const l = lead(501);
  conversas.set(501, [{ autor: 'SOFIA', texto: 'oi', h: 100 }]);
  await varrerPerda(ctxDe(unit, kommoFalso([l], e), false), resumoNovo(unit, false));
  assert.equal(leiturasDeConversa, 0);
  assert.equal(chamadasAIa, 0);
});

test('falha da IA não faz nada: o cartão fica e nenhuma escrita acontece', async () => {
  const unit = unidade();
  const e = escritas();
  iaFora = true;
  const r = resumoNovo(unit, false);
  await varrerPerda(ctxDe(unit, kommoFalso([comRecusa(601)], e), false), r);
  assert.equal(chamadasAIa, 1);
  assert.equal(r.moveria, 0);
  assert.deepEqual([e.status, e.tags, e.notas, e.campos], [[], [], [], []]);
});

test('IA fora do ar: depois de 3 falhas seguidas encerra a varredura da unidade (não bate 20 vezes)', async () => {
  const unit = unidade();
  const e = escritas();
  iaFora = true;
  const cards = Array.from({ length: 8 }, (_, i) => comRecusa(1500 + i));
  await varrerPerda(ctxDe(unit, kommoFalso(cards, e), false), resumoNovo(unit, false));
  assert.equal(chamadasAIa, 3);
  assert.deepEqual(e.status, []);
});

test('TETO de leituras: sem IA nenhuma (todos recentes demais), lê no máximo MAX_LEITURAS conversas por varredura', async () => {
  const unit = unidade();
  const e = escritas();
  const cards = Array.from({ length: MAX_LEITURAS + 10 }, (_, i) => {
    const l = lead(7000 + i);
    conversas.set(7000 + i, [{ autor: 'PACIENTE', texto: `oi #${7000 + i}#`, h: 2 }, { autor: 'SOFIA', texto: 'olá', h: 2 }]);
    conversasComFala.add(String(7000 + i));
    return l;
  });
  await varrerPerda(ctxDe(unit, kommoFalso(cards, e), false), resumoNovo(unit, false));
  assert.equal(leiturasDeConversa, MAX_LEITURAS);
  assert.equal(chamadasAIa, 0);
});

test('queda do Kommo (erro que não é 403) não deixa o cartão de molho: tenta de novo na varredura seguinte', async () => {
  const unit = unidade();
  const e = escritas();
  const k = { ...kommoFalso([comRecusa(1700)], e), listTalks: async () => { throw new Error('socket hang up'); } } as unknown as KommoClient;
  const r1 = resumoNovo(unit, false);
  await varrerPerda(ctxDe(unit, k, false), r1);
  const r2 = resumoNovo(unit, false);
  await varrerPerda(ctxDe(unit, k, false), r2);
  assert.equal(r1.erros + r2.erros, 2);
});

test('conta sem o escopo de chats (talks dá 403): conta o erro, não escreve e não tenta o mesmo cartão de novo na hora', async () => {
  const unit = unidade();
  const e = escritas();
  const k = { ...kommoFalso([comRecusa(1600)], e), listTalks: async () => { throw new Error('403 Invalid scope'); } } as unknown as KommoClient;
  const r = resumoNovo(unit, false);
  await varrerPerda(ctxDe(unit, k, false), r);
  assert.equal(r.erros, 1);
  const r2 = resumoNovo(unit, false);
  await varrerPerda(ctxDe(unit, k, false), r2);
  assert.equal(r2.erros, 0, 'o cartão com erro fica de molho por um dia');
  assert.equal(chamadasAIa, 0);
});

test('opção inexistente na conta: a IA diz «Outro» e a lista não tem → não move (nada de inventar motivo)', async () => {
  const unit = unidade();
  const e = escritas();
  const l = comRecusa(701, 'não tenho interesse, obrigado', RECUSA('não tenho interesse', { motivo: 'Outro' }));
  const r = resumoNovo(unit, true);
  await varrerPerda(ctxDe(unit, kommoFalso([l], e), true), r);
  assert.equal(r.moveria, 0);
  assert.equal(simulacoes.find((x) => x.kommoLeadId === 701)?.acao, 'pularia');
  assert.match(simulacoes.find((x) => x.kommoLeadId === 701)?.motivo ?? '', /a conta não tem a opção/);
});

test('o cartão mudou enquanto a IA lia (a SDR marcou «Pausar IA»): relê antes de escrever e não move', async () => {
  const unit = unidade();
  const e = escritas();
  const l = comRecusa(801);
  const k = kommoFalso([l], e, { 801: { custom_fields_values: [{ field_id: PAUSAR_IA, field_name: 'Pausar IA', values: [{ value: true }] }] as never } });
  await varrerPerda(ctxDe(unit, k, false), resumoNovo(unit, false));
  assert.equal(chamadasAIa, 1);
  assert.deepEqual(e.status, []);
});

test('o paciente respondeu enquanto a IA lia: a frase que provava a recusa ficou velha, não move', async () => {
  const unit = unidade();
  const e = escritas();
  escreveuNoMeio = true;
  const l = { ...comRecusa(850), _embedded: { tags: [], contacts: [{ id: 99, is_main: true }] } };
  const r = resumoNovo(unit, false);
  await varrerPerda(ctxDe(unit, kommoFalso([l], e), false), r);
  assert.equal(chamadasAIa, 1);
  assert.deepEqual(e.status, []);
});

test('TETO de movimentos: 8 recusas, 5 por varredura (no papel conta igual); o resto fica pra próxima', async () => {
  for (const seco of [true, false]) {
    const unit = unidade();
    const e = escritas();
    const cards = Array.from({ length: 8 }, (_, i) => comRecusa(1000 + i));
    const r = resumoNovo(unit, seco);
    await varrerPerda(ctxDe(unit, kommoFalso(cards, e), seco), r);
    assert.equal(r.moveria, MAX_MOVIMENTOS, `seco=${seco}`);
    if (seco) assert.equal(simulacoes.filter((s) => s.acao === 'moveria' && s.kommoLeadId >= 1000 && s.kommoLeadId < 2000).length >= MAX_MOVIMENTOS, true);
    else assert.equal(e.status.length, MAX_MOVIMENTOS);
  }
});

test('TETO de avaliações: 30 cartões que a IA diz «não» → lê no máximo MAX_AVALIACOES por varredura', async () => {
  const unit = unidade();
  const e = escritas();
  const cards = Array.from({ length: 30 }, (_, i) => {
    const l = comRecusa(2000 + i);
    respostasDaIa.delete(2000 + i); // a IA responde o padrão: não é perda
    return l;
  });
  const r = resumoNovo(unit, false);
  await varrerPerda(ctxDe(unit, kommoFalso(cards, e), false), r);
  assert.equal(chamadasAIa, MAX_AVALIACOES);
  assert.equal(r.avaliados, MAX_AVALIACOES);
  assert.deepEqual(e.status, []);
});

test('cartão já avaliado não gasta IA de novo na varredura seguinte (a mesma unidade, no mesmo dia)', async () => {
  const unit = unidade();
  const e = escritas();
  const l = comRecusa(2999);
  respostasDaIa.delete(2999);
  await varrerPerda(ctxDe(unit, kommoFalso([l], e), false), resumoNovo(unit, false));
  await varrerPerda(ctxDe(unit, kommoFalso([l], e), false), resumoNovo(unit, false));
  assert.equal(chamadasAIa, 1);
});

test('só EM QUALIFICAÇÃO e EM ESPERA: NÃO COMPARECEU e a entrada nem são listadas', async () => {
  const unit = unidade();
  const e = escritas();
  const naoComparecer = { ...comRecusa(3001), status_id: 13 };
  const espera = { ...comRecusa(3002), status_id: 12 };
  const r = resumoNovo(unit, true);
  await varrerPerda(ctxDe(unit, kommoFalso([naoComparecer, espera], e), true), r);
  assert.equal(chamadasAIa, 1, 'só o EM ESPERA foi lido');
  assert.equal(simulacoes.filter((s) => s.acao === 'moveria')[0]?.kommoLeadId, 3002);
});

test('decisaoDeFecho: a nota e as etiquetas são da IA, não do prazo', () => {
  const d = decisaoDeFecho({ tipo: 'mover', padrao: 'contato_invalido', motivo: 'Clicou por engano', justificativa: 'foi engano.', frase: 'foi engano' }, 'EM QUALIFICAÇÃO');
  assert.equal(d.para, 'PERDIDO');
  assert.equal(d.semRegua, true);
  assert.deepEqual(d.etiquetas, ['perdido pela IA', 'NO_FOLLOW_UP']);
  assert.equal(d.etiquetaObrigatoria, true, 'sem a etiqueta o fecho não acontece');
  assert.equal(d.campo?.opcao, 'Clicou por engano');
  assert.match(d.nota ?? '', /contato inválido/);
});

// ───────────────────── motivo-perdido-ia ─────────────────────

const perdido = (id: number, extra: Partial<KommoLead> = {}): KommoLead => ({ ...lead(id, 143), closed_at: AGORA - 2 * H, updated_at: AGORA - 2 * H, ...extra });
const resumoMotivo = (unit: Unit, seco: boolean) => ({ ...resumoNovo(unit, seco), automacao: 'motivo-perdido-ia' });
function perdidoComConversa(id: number, resposta: string) {
  conversas.set(id, [{ autor: 'PACIENTE', texto: `Quanto é? #${id}#`, h: 50 }, { autor: 'SOFIA', texto: 'R$ 250', h: 49 }, { autor: 'PACIENTE', texto: 'não quero, obrigada', h: 40 }]);
  respostasDaIa.set(id, resposta);
  return perdido(id);
}
const NAO_QUERO = JSON.stringify({ frase_do_paciente: 'não quero, obrigada', resposta: 'Sem interesse' });
const ctxMotivo = (unit: Unit, kommo: KommoClient, seco: boolean) => ({ unit, kommo, funis, grupo: null, seco, agora: AGORA });

test('motivo-perdido-ia LIGADO: grava a opção da lista da conta, com nota; o classificador é o do widget', async () => {
  const unit = unidade();
  const e = escritas();
  const r = resumoMotivo(unit, false);
  await varrerMotivos(ctxMotivo(unit, kommoFalso([perdidoComConversa(1, NAO_QUERO)], e), false), r);
  assert.deepEqual(e.campos, [{ id: 1, campo: 5, valor: 'Sem interesse' }]);
  assert.match(e.notas[0].texto, /preencheu o ⊘ Motivo do não agendamento: «Sem interesse»/);
  assert.deepEqual(e.status, [], 'só o campo: não move, não etiqueta');
  assert.equal(r.gravados, 1);
});

test('motivo-perdido-ia SECO: loga «gravaria» e não escreve nada', async () => {
  const unit = unidade();
  const e = escritas();
  await varrerMotivos(ctxMotivo(unit, kommoFalso([perdidoComConversa(2, NAO_QUERO)], e), true), resumoMotivo(unit, true));
  assert.deepEqual([e.campos, e.notas, e.tags, e.status], [[], [], [], []]);
  const s = simulacoes.find((x) => x.kommoLeadId === 2);
  assert.equal(s?.acao, 'gravaria');
  assert.equal(s?.valor, 'Sem interesse');
});

test('motivo-perdido-ia: motivo já preenchido não é tocado — nem lê a conversa; e se a SDR preencher enquanto a IA lê, não sobrescreve', async () => {
  const unit = unidade();
  const e = escritas();
  const jaTem = perdidoComConversa(3, NAO_QUERO);
  jaTem.custom_fields_values = [{ field_name: '⊘ Motivo do não agendamento', values: [{ value: 'Plano de Saúde' }] }] as never;
  const r = resumoMotivo(unit, false);
  await varrerMotivos(ctxMotivo(unit, kommoFalso([jaTem], e), false), r);
  assert.equal(chamadasAIa, 0);
  assert.equal(leiturasDeConversa, 0);
  assert.deepEqual(e.campos, []);

  const unit2 = unidade();
  const e2 = escritas();
  const corrida = perdidoComConversa(4, NAO_QUERO);
  const k = kommoFalso([corrida], e2, { 4: { custom_fields_values: [{ field_name: '⊘ Motivo do não agendamento', values: [{ value: 'Outra cidade' }] }] as never } });
  await varrerMotivos(ctxMotivo(unit2, k, false), resumoMotivo(unit2, false));
  assert.equal(chamadasAIa, 1);
  assert.deepEqual(e2.campos, [], 'relê o cartão logo antes de gravar');
});

test('motivo-perdido-ia: opção que a conta não tem (ou «Outro») → não grava nada', async () => {
  const unit = unidade();
  const e = escritas();
  const r = resumoMotivo(unit, false);
  await varrerMotivos(ctxMotivo(unit, kommoFalso([perdidoComConversa(5, JSON.stringify({ frase_do_paciente: 'x', resposta: 'Outro' }))], e), false), r);
  assert.deepEqual(e.campos, []);
  assert.equal(r.gravados, 0);
});

test('motivo-perdido-ia: IA fora do ar não grava nada; e perdido há mais de 24 h ou há 2 min fica de fora', async () => {
  const unit = unidade();
  const e = escritas();
  iaFora = true;
  await varrerMotivos(ctxMotivo(unit, kommoFalso([perdidoComConversa(6, NAO_QUERO)], e), false), resumoMotivo(unit, false));
  assert.equal(chamadasAIa, 1);
  assert.deepEqual(e.campos, []);

  iaFora = false;
  const unit2 = unidade();
  const e2 = escritas();
  const velho = perdidoComConversa(7, NAO_QUERO);
  velho.closed_at = AGORA - 40 * H;
  const novinho = perdidoComConversa(8, NAO_QUERO);
  novinho.closed_at = AGORA - 120;
  await varrerMotivos(ctxMotivo(unit2, kommoFalso([velho, novinho], e2), false), resumoMotivo(unit2, false));
  assert.equal(chamadasAIa, 1, 'nenhuma chamada nova além da primeira (a de IA fora)');
  assert.deepEqual(e2.campos, []);
});

test('motivo-perdido-ia: teto por varredura', async () => {
  const unit = unidade();
  const e = escritas();
  const cards = Array.from({ length: MAX_MOTIVOS + 5 }, (_, i) => perdidoComConversa(5000 + i, NAO_QUERO));
  const r = resumoMotivo(unit, false);
  await varrerMotivos(ctxMotivo(unit, kommoFalso(cards, e), false), r);
  assert.equal(e.campos.length, MAX_MOTIVOS);
});

test('REVISÃO 5 (worker): a IA chuta «Outra cidade» sem frase e o paciente falou por último → grava o genérico, nunca o específico', async () => {
  const unit = unidade();
  const e = escritas();
  conversas.set(20, [{ autor: 'SOFIA', texto: `R$ 250 #20#`, h: 50 }, { autor: 'PACIENTE', texto: 'hum', h: 40 }, { autor: 'PACIENTE', texto: 'ok', h: 39 }]);
  respostasDaIa.set(20, JSON.stringify({ frase_do_paciente: '', resposta: 'Outra cidade' }));
  await varrerMotivos(ctxMotivo(unit, kommoFalso([perdido(20)], e), false), resumoMotivo(unit, false));
  assert.deepEqual(e.campos, [{ id: 20, campo: 5, valor: 'Não deu continuidade ao atendimento' }]);
});

test('REVISÃO 5 (worker): conversa sem nenhuma fala do paciente não vira motivo nenhum', async () => {
  const unit = unidade();
  const e = escritas();
  conversas.set(21, [{ autor: 'SOFIA', texto: `oi #21#`, h: 50 }]);
  respostasDaIa.set(21, JSON.stringify({ frase_do_paciente: '', resposta: 'Outra cidade' }));
  await varrerMotivos(ctxMotivo(unit, kommoFalso([perdido(21)], e), false), resumoMotivo(unit, false));
  assert.deepEqual(e.campos, []);
});
