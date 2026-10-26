// Testes dos nós de código do fluxo CAPI (v3). Rodar: `node --test n8n/capi-conversoes/` (Node >= 20).
// Cada teste carrega o .js do nó exatamente como o n8n o recebe (corpo de função com `$`, `$input`, `require`) —
// o que roda aqui é o que vai para o workflow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const carregar = (f) => fs.readFileSync(path.join(aqui, f), 'utf8');
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

function rodar(arquivo, cfg, itens) {
  const fn = new Function('$', '$input', 'require', carregar(arquivo));
  const $ = (nome) => {
    assert.equal(nome, 'Config');
    return { first: () => ({ json: { cfg } }) };
  };
  const out = fn($, { all: () => itens.map((json) => ({ json })) }, require);
  return out.map((o) => o.json);
}

const AGORA = Math.floor(Date.now() / 1000);
const DIA = 86400;

const CFG = {
  cfCtwaClid: 1, cfQualificacao: 2, enumQuente: 77,
  pipelineId: '900', wabaId: '348149625044226', dataset: 'ds', unidade: 'balsas',
  statusQualificacao: '10', janelaDias: 7, valorPurchase: 3500,
  cadeia: { '20': ['quente', 'agendado'], '142': ['quente', 'agendado', 'compareceu', 'ganho'] },
  preAgendado: ['5', '10'],
  pediuHorario: { modo: 'ligado', tag: 'IA · Pediu horário', tagsExcluir: ['Alerta · Mora fora', 'Fora do escopo'] },
  status: { modo: 'desligado', pageId: '' },
};
const comCfg = (extra) => ({ ...CFG, ...extra });

function lead({ status = 10, tags = [], quente = false, clid = 'CLID1', updated = AGORA - 60, id = 555 } = {}) {
  return {
    id, status_id: status, pipeline_id: 900, price: 0, updated_at: updated,
    custom_fields_values: [
      ...(clid ? [{ field_id: 1, values: [{ value: clid }] }] : []),
      ...(quente ? [{ field_id: 2, values: [{ enum_id: 77 }] }] : []),
    ],
    _embedded: { tags: tags.map((name) => ({ id: 1, name })) },
  };
}

// ═══ Classificar etapa ═══════════════════════════════════════════════════════════════════════════════════
test('classificar: Quente em etapa pré-agendamento sai igual à v2 (via quente, hora = agora, nunca seco)', () => {
  const [e, ...resto] = rodar('classificar-etapa.v3.js', comCfg({ pediuHorario: { modo: 'seco', tag: 'IA · Pediu horário' } }), [lead({ quente: true })]);
  assert.equal(resto.length, 0);
  assert.deepEqual([e.event_name, e.event_id, e.via, e._seco], ['LeadSubmitted', 'quente-555', 'quente', false]);
  assert.ok(Math.abs(e.event_time - AGORA) <= 2);
});

test('classificar: a etiqueta "IA · Pediu horário" gera LeadSubmitted com o MESMO event_id do Quente, na hora do cartão', () => {
  const [e] = rodar('classificar-etapa.v3.js', CFG, [lead({ tags: ['IA · Pediu horário'], updated: AGORA - 3600 })]);
  assert.equal(e.event_name, 'LeadSubmitted');
  assert.equal(e.event_id, 'quente-555', 'mesmo id do Quente: quem chegar primeiro manda, o UNIQUE segura o outro');
  assert.equal(e.via, 'pediu_horario');
  assert.equal(e.event_time, AGORA - 3600, 'a hora do pedido, não a hora em que o fluxo rodou');
  assert.equal(e._seco, false);
});

test('classificar: caixa, acento e pontuação não escondem a etiqueta; etiqueta parecida não vale', () => {
  assert.equal(rodar('classificar-etapa.v3.js', CFG, [lead({ tags: ['ia pediu horario'] })]).length, 1);
  assert.equal(rodar('classificar-etapa.v3.js', CFG, [lead({ tags: ['IA · Pediu horário de volta'] })]).length, 0);
  assert.equal(rodar('classificar-etapa.v3.js', CFG, [lead({ tags: [] })]).length, 0, 'só "oi": sem etiqueta, sem Lead');
});

test('classificar: modo desligado = v2 (nada sai); modo seco marca _seco', () => {
  assert.equal(rodar('classificar-etapa.v3.js', comCfg({ pediuHorario: { modo: 'desligado', tag: 'IA · Pediu horário' } }), [lead({ tags: ['IA · Pediu horário'] })]).length, 0);
  assert.equal(rodar('classificar-etapa.v3.js', comCfg({ pediuHorario: undefined }), [lead({ tags: ['IA · Pediu horário'] })]).length, 0, 'cfg antiga, sem o bloco v3');
  const [e] = rodar('classificar-etapa.v3.js', comCfg({ pediuHorario: { modo: 'seco', tag: 'IA · Pediu horário' } }), [lead({ tags: ['IA · Pediu horário'] })]);
  assert.equal(e._seco, true);
});

test('classificar: etiqueta de exclusão (mora fora / fora do escopo) anula o sinal', () => {
  assert.equal(rodar('classificar-etapa.v3.js', CFG, [lead({ tags: ['IA · Pediu horário', 'Alerta · Mora fora'] })]).length, 0);
  assert.equal(rodar('classificar-etapa.v3.js', CFG, [lead({ tags: ['IA · Pediu horário', 'Fora do escopo'] })]).length, 0);
});

test('classificar: sem duplicar com o Quente — Quente + etiqueta sai UMA vez, como Quente (e o seco não o segura)', () => {
  const r = rodar('classificar-etapa.v3.js', comCfg({ pediuHorario: { modo: 'seco', tag: 'IA · Pediu horário' } }), [lead({ quente: true, tags: ['IA · Pediu horário'] })]);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].via, r[0]._seco], ['quente', false]);
});

test('classificar: de AGENDADO em diante a cadeia manda (via quente), a etiqueta não muda nada', () => {
  const r = rodar('classificar-etapa.v3.js', CFG, [lead({ status: 20, tags: ['IA · Pediu horário'] })]);
  assert.deepEqual(r.map((x) => [x.event_name, x.via]), [['LeadSubmitted', 'quente'], ['AddToCart', 'quente']]);
});

test('classificar: etapa fora do mapa (PERDIDO etc.) não emite, mesmo com a etiqueta', () => {
  assert.equal(rodar('classificar-etapa.v3.js', CFG, [lead({ status: 143, tags: ['IA · Pediu horário'] })]).length, 0);
});

test('classificar: updated_at no futuro (relógio adiantado) vira "agora"', () => {
  const [e] = rodar('classificar-etapa.v3.js', CFG, [lead({ tags: ['IA · Pediu horário'], updated: AGORA + 5000 })]);
  assert.ok(e.event_time <= AGORA + 2);
});

// ═══ Montar evento ═══════════════════════════════════════════════════════════════════════════════════════
const ev = (extra = {}) => ({
  event_name: 'LeadSubmitted', event_id: 'quente-555', event_time: AGORA, ctwa_clid: 'CLID1',
  kommo_lead_id: '555', pipeline_id: '900', telefone: '559984553221', nome: 'José da Silva', via: 'quente',
  clique_em: AGORA - 3600, clique_encontrado: true, ...extra,
});
const montar = (cfg, itens) => rodar('montar-evento.v3.js', cfg, itens);
const STATUS_ON = { modo: 'ligado', pageId: '1234567890' };

test('montar: com clid o payload é o de sempre (ctwa_clid + waba), sem page_id', () => {
  const [o] = montar(CFG, [ev()]);
  assert.equal(o._aprovado, true);
  const u = o.corpo.data[0].user_data;
  assert.equal(u.ctwa_clid, 'CLID1');
  assert.equal(u.whatsapp_business_account_id, CFG.wabaId);
  assert.equal(u.page_id, undefined);
  assert.equal(o.corpo.data[0].action_source, 'business_messaging');
  assert.equal(o.corpo.data[0].messaging_channel, 'whatsapp');
});

test('montar: o ph vai em sha256 do telefone COM 55 (wa_id), só dígitos; nome sem acento', () => {
  const [o] = montar(CFG, [ev({ telefone: '+55 (99) 98455-3221' })]);
  const u = o.corpo.data[0].user_data;
  assert.equal(u.ph, sha('5599984553221'));
  assert.equal(u.fn, sha('jose'));
  assert.equal(u.ln, sha('silva'));
});

test('montar: número estrangeiro não ganha 55 (chutar DDI marcaria a pessoa errada)', () => {
  const [o] = montar(CFG, [ev({ telefone: '351912345678' })]);
  assert.equal(o.corpo.data[0].user_data.ph, sha('351912345678'));
});

test('montar: Status DESLIGADO (padrão) descarta como sem_ctwa_clid, igual à v2', () => {
  const [o] = montar(CFG, [ev({ ctwa_clid: null })]);
  assert.deepEqual([o._aprovado, o.motivo], [false, 'sem_ctwa_clid']);
});

test('montar: Status ligado sem o page_id configurado continua descartando (nunca manda sem page_id)', () => {
  const [o] = montar(comCfg({ status: { modo: 'ligado', pageId: '' } }), [ev({ ctwa_clid: null })]);
  assert.deepEqual([o._aprovado, o.motivo], [false, 'sem_ctwa_clid']);
});

test('montar: Status ligado manda page_id + waba + ph, SEM ctwa_clid', () => {
  const [o] = montar(comCfg({ status: STATUS_ON }), [ev({ ctwa_clid: null })]);
  assert.equal(o._aprovado, true);
  const u = o.corpo.data[0].user_data;
  assert.equal(u.page_id, '1234567890');
  assert.equal(u.whatsapp_business_account_id, CFG.wabaId);
  assert.equal(u.ph, sha('559984553221'));
  assert.equal(u.ctwa_clid, undefined);
  assert.match(o.sinais, /^page_id,ph/);
  assert.equal(o._seco, false);
});

test('montar: Status em modo seco vira _seco (o IF do fluxo não chama a Meta)', () => {
  const [o] = montar(comCfg({ status: { modo: 'seco', pageId: '1234567890' } }), [ev({ ctwa_clid: null })]);
  assert.deepEqual([o._aprovado, o._seco], [true, true]);
});

test('montar: Status sem clique do cartão em ctwa_eventos = lead que não é de anúncio: descarte sem_ctwa_clid', () => {
  const [o] = montar(comCfg({ status: STATUS_ON }), [ev({ ctwa_clid: null, clique_encontrado: false, clique_em: null, telefone: null })]);
  assert.deepEqual([o._aprovado, o.motivo], [false, 'sem_ctwa_clid']);
});

test('montar: Status com clique de mais de 7 dias não sai (a Meta aceitaria e não atribuiria)', () => {
  const [o] = montar(comCfg({ status: STATUS_ON }), [ev({ ctwa_clid: null, clique_em: AGORA - 8 * DIA })]);
  assert.deepEqual([o._aprovado, o.motivo], [false, 'status_fora_7d_do_clique']);
});

test('montar: Status sem telefone não sai (a Meta exige ao menos um dado de cliente)', () => {
  const [o] = montar(comCfg({ status: STATUS_ON }), [ev({ ctwa_clid: null, telefone: null })]);
  assert.deepEqual([o._aprovado, o.motivo], [false, 'status_sem_telefone']);
});

test('montar: "pediu horário" até 7 dias do clique sai; a hora nunca é anterior ao clique', () => {
  const [o] = montar(CFG, [ev({ via: 'pediu_horario', event_time: AGORA - 7200, clique_em: AGORA - 3600 })]);
  assert.equal(o._aprovado, true);
  assert.equal(o.corpo.data[0].event_time, AGORA - 3600);
});

test('montar: "pediu horário" com mais de 7 dias do clique não vale para a meta de leads', () => {
  const [o] = montar(CFG, [ev({ via: 'pediu_horario', event_time: AGORA - 3600, clique_em: AGORA - 9 * DIA })]);
  assert.deepEqual([o._aprovado, o.motivo], [false, 'pediu_fora_7d_do_clique']);
});

test('montar: "pediu horário" sem a hora do clique não sai (não se adivinha janela)', () => {
  const [o] = montar(CFG, [ev({ via: 'pediu_horario', clique_em: null, clique_encontrado: false })]);
  assert.deepEqual([o._aprovado, o.motivo], [false, 'pediu_sem_hora_do_clique']);
});

test('montar: o Quente de sempre NÃO ganha a trava de 7 dias do clique (comportamento da v2 preservado)', () => {
  const [o] = montar(CFG, [ev({ via: 'quente', clique_em: AGORA - 20 * DIA })]);
  assert.equal(o._aprovado, true);
});

test('montar: evento com mais de 7 dias de event_time cai em fora_da_janela_7d (agora de verdade)', () => {
  const [o] = montar(CFG, [ev({ event_time: AGORA - 8 * DIA })]);
  assert.deepEqual([o._aprovado, o.motivo], [false, 'fora_da_janela_7d']);
});

test('montar: outro funil continua descartado; Purchase leva valor fixo e moeda', () => {
  assert.equal(montar(CFG, [ev({ pipeline_id: '1' })])[0].motivo, 'unidade_fora_do_mapa');
  const [p] = montar(CFG, [ev({ event_name: 'Purchase', event_id: 'ganho-555' })]);
  assert.deepEqual(p.corpo.data[0].custom_data, { currency: 'BRL', value: 3500 });
});

test('montar: o _seco do "pediu horário" atravessa; ViewContent do relógio (sem campos novos) segue como antes', () => {
  const [a] = montar(CFG, [ev({ via: 'pediu_horario', _seco: true, event_time: AGORA - 60 })]);
  assert.equal(a._seco, true);
  const [v] = montar(CFG, [{ event_name: 'ViewContent', event_id: 'msg-CLID1', event_time: AGORA - 600, ctwa_clid: 'CLID1', kommo_lead_id: null, pipeline_id: '900', telefone: '559984553221', nome: null, wamid: 'w' }]);
  assert.deepEqual([v._aprovado, v._seco], [true, false]);
});

test('montar: clique no futuro (dado quebrado) não vale como prova — nem no Status, nem no "pediu horário"', () => {
  const [a] = montar(comCfg({ status: STATUS_ON }), [ev({ ctwa_clid: null, clique_em: AGORA + 3 * DIA })]);
  assert.deepEqual([a._aprovado, a.motivo], [false, 'clique_no_futuro']);
  const [b] = montar(CFG, [ev({ via: 'pediu_horario', event_time: AGORA - 60, clique_em: AGORA + 3 * DIA })]);
  assert.deepEqual([b._aprovado, b.motivo], [false, 'clique_no_futuro']);
});

test('montar: Status com o clique alguns segundos depois do event_time sobe o evento para a hora do clique', () => {
  const [o] = montar(comCfg({ status: STATUS_ON }), [ev({ ctwa_clid: null, event_time: AGORA - 30, clique_em: AGORA - 10 })]);
  assert.equal(o._aprovado, true);
  assert.equal(o.corpo.data[0].event_time, AGORA - 10);
});

test('montar: clique poucos segundos "no futuro" (relógios diferentes) nunca gera event_time no futuro', () => {
  const [a] = montar(comCfg({ status: STATUS_ON }), [ev({ ctwa_clid: null, event_time: AGORA - 5, clique_em: AGORA + 120 })]);
  assert.equal(a._aprovado, true);
  assert.ok(a.corpo.data[0].event_time <= AGORA + 1);
  const [b] = montar(CFG, [ev({ via: 'pediu_horario', event_time: AGORA - 5, clique_em: AGORA + 120 })]);
  assert.ok(b.corpo.data[0].event_time <= AGORA + 1);
});
