import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ETIQUETA,
  decidirBoasVindas,
  decidirConfirmarRetorno,
  decidirReativacao,
  epochSeg,
} from './etiquetas-auto.js';

const H = 3600;
const D = 24 * H;
const AGORA = Math.floor(Date.parse('2026-10-07T15:00:00Z') / 1000);

type Campos = Record<string, unknown>;
const cartao = (o: { id?: number; campos?: Campos; tags?: string[]; closed_at?: number | null } = {}) => ({
  id: o.id ?? 1,
  closed_at: o.closed_at ?? null,
  custom_fields_values: Object.entries(o.campos ?? {}).map(([field_name, value], i) => ({
    field_id: i + 1,
    field_name,
    values: [{ value }],
  })),
  _embedded: { tags: (o.tags ?? []).map((name, i) => ({ id: i + 1, name })) },
});

const PROGRAMA = { '⚕ Tratamento fechado': 'PROTOCOLO 03 MESES', '◷ Próxima sessão': AGORA + 2 * D };

// ── ▶ Boas-vindas ─────────────────────────────────────────────────────────────────────────────

test('boas-vindas: entrou em GANHO há 1 h com programa e próxima sessão → coloca', () => {
  const d = decidirBoasVindas(cartao({ closed_at: AGORA - H, campos: PROGRAMA }), AGORA);
  assert.equal(d?.tipo, 'coloca');
  assert.equal(d?.etiqueta, ETIQUETA.BOAS_VINDAS);
});

test('boas-vindas: sem o programa ou a próxima sessão o modelo sairia com buraco → pula e explica', () => {
  const d = decidirBoasVindas(cartao({ closed_at: AGORA - H, campos: { '⚕ Tratamento fechado': 'X' } }), AGORA);
  assert.equal(d?.tipo, 'pula');
  assert.match(d!.motivo, /Próxima sessão/);
});

test('boas-vindas: GANHO de 3 dias atrás é história, não entra', () => {
  assert.equal(decidirBoasVindas(cartao({ closed_at: AGORA - 3 * D, campos: PROGRAMA }), AGORA), null);
});

test('boas-vindas: quem já tem a etiqueta ou já recebeu não ganha de novo', () => {
  assert.equal(decidirBoasVindas(cartao({ closed_at: AGORA - H, campos: PROGRAMA, tags: [ETIQUETA.BOAS_VINDAS] }), AGORA), null);
  assert.equal(decidirBoasVindas(cartao({ closed_at: AGORA - H, campos: PROGRAMA, tags: ['Fluxo · Boas-vindas enviadas'] }), AGORA), null);
});

test('boas-vindas: opt-out pula', () => {
  const d = decidirBoasVindas(cartao({ closed_at: AGORA - H, campos: { ...PROGRAMA, '✓ Opt-out WhatsApp': 'Sim' } }), AGORA);
  assert.equal(d?.tipo, 'pula');
});

// ── ▶ Confirmar retorno ───────────────────────────────────────────────────────────────────────

test('retorno: próxima sessão daqui a 20 h → coloca, com chave por data', () => {
  const quando = AGORA + 20 * H;
  const d = decidirConfirmarRetorno(cartao({ campos: { '◷ Próxima sessão': quando } }), AGORA);
  assert.equal(d?.tipo, 'coloca');
  assert.equal(d?.chave, `retorno:1:${quando}`);
  assert.equal(d?.tipo === 'coloca' && d.reaplica, false);
});

test('retorno: daqui a 3 dias ainda não; já passou também não', () => {
  assert.equal(decidirConfirmarRetorno(cartao({ campos: { '◷ Próxima sessão': AGORA + 3 * D } }), AGORA), null);
  assert.equal(decidirConfirmarRetorno(cartao({ campos: { '◷ Próxima sessão': AGORA - H } }), AGORA), null);
  assert.equal(decidirConfirmarRetorno(cartao(), AGORA), null);
});

test('retorno: etiqueta de um retorno anterior ainda no cartão → reaplica (tira e põe)', () => {
  const d = decidirConfirmarRetorno(cartao({ campos: { '◷ Próxima sessão': AGORA + 5 * H }, tags: [ETIQUETA.CONFIRMAR_RETORNO] }), AGORA);
  assert.equal(d?.tipo === 'coloca' && d.reaplica, true);
});

// ── ▶ Reativação ──────────────────────────────────────────────────────────────────────────────

const RESP = { '☻ Responsável agendamento': 'MARIA' };

test('reativação: cruzou 30 dias em PERDIDO agora, sem conversa → coloca', () => {
  const d = decidirReativacao(cartao({ closed_at: AGORA - 30 * D - 2 * H, campos: RESP }), AGORA, null);
  assert.equal(d?.tipo, 'coloca');
  assert.equal(d?.etiqueta, ETIQUETA.REATIVACAO);
});

test('reativação: estoque antigo (90 dias) nunca entra de uma vez', () => {
  assert.equal(decidirReativacao(cartao({ closed_at: AGORA - 90 * D, campos: RESP }), AGORA, null), null);
});

test('reativação: 29 dias ainda não', () => {
  assert.equal(decidirReativacao(cartao({ closed_at: AGORA - 29 * D, campos: RESP }), AGORA, null), null);
});

test('reativação: conversou há 10 dias → pula', () => {
  const d = decidirReativacao(cartao({ closed_at: AGORA - 30 * D - H, campos: RESP }), AGORA, AGORA - 10 * D);
  assert.equal(d?.tipo, 'pula');
});

test('reativação: responsável vazio sairia "Aqui é , da" → pula e explica', () => {
  const d = decidirReativacao(cartao({ closed_at: AGORA - 30 * D - H }), AGORA, null);
  assert.equal(d?.tipo, 'pula');
  assert.match(d!.motivo, /Aqui é , da/);
});

test('reativação: NO_FOLLOW_UP ou opt-out → pula', () => {
  for (const tags of [['NO_FOLLOW_UP'], ['Fluxo · Opt-out WhatsApp']]) {
    const d = decidirReativacao(cartao({ closed_at: AGORA - 30 * D - H, campos: RESP, tags }), AGORA, null);
    assert.equal(d?.tipo, 'pula');
  }
});

test('reativação: quem já tem a etiqueta não ganha de novo', () => {
  assert.equal(decidirReativacao(cartao({ closed_at: AGORA - 30 * D - H, campos: RESP, tags: [ETIQUETA.REATIVACAO] }), AGORA, null), null);
});

test('epochSeg aceita segundos, ms e ISO', () => {
  assert.equal(epochSeg(1790000000), 1790000000);
  assert.equal(epochSeg(1790000000000), 1790000000);
  assert.equal(epochSeg('2026-10-07T15:00:00Z'), AGORA);
  assert.equal(epochSeg(''), null);
  assert.equal(epochSeg(null), null);
});
