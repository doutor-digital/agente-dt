import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ETIQUETA,
  decidirBoasVindas,
  decidirConfirmarRetorno,
  decidirReativacao,
  epochSeg,
  temModeloV2,
  modelosV2,
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

const retornoEm = (quando: number, mostrada: number | null = quando) => ({
  '◷ Data da Consulta': quando,
  ...(mostrada ? { '◷ Próxima sessão': mostrada } : {}),
});

test('retorno: Data da Consulta daqui a 20 h e o modelo mostra a mesma data → coloca, chave por data', () => {
  const quando = AGORA + 20 * H;
  const d = decidirConfirmarRetorno(cartao({ campos: retornoEm(quando) }), AGORA);
  assert.equal(d?.tipo, 'coloca');
  assert.equal(d?.chave, `retorno:1:${quando}`);
  assert.equal(d?.tipo === 'coloca' && d.reaplica, false);
});

test('retorno: o modelo mostra Próxima sessão vazia ou outra data → pula e manda trocar o modelo', () => {
  const quando = AGORA + 20 * H;
  for (const mostrada of [null, AGORA + 5 * D]) {
    const d = decidirConfirmarRetorno(cartao({ campos: retornoEm(quando, mostrada) }), AGORA);
    assert.equal(d?.tipo, 'pula');
    assert.match(d!.motivo, /trocar o modelo/);
  }
});

test('retorno: daqui a 3 dias ainda não; já passou também não; sem data nada', () => {
  assert.equal(decidirConfirmarRetorno(cartao({ campos: retornoEm(AGORA + 3 * D) }), AGORA), null);
  assert.equal(decidirConfirmarRetorno(cartao({ campos: retornoEm(AGORA - H) }), AGORA), null);
  assert.equal(decidirConfirmarRetorno(cartao(), AGORA), null);
});

test('retorno: só Próxima sessão (sessão de tratamento) não conta como retorno', () => {
  assert.equal(decidirConfirmarRetorno(cartao({ campos: { '◷ Próxima sessão': AGORA + 5 * H } }), AGORA), null);
});

test('retorno: etiqueta de um retorno anterior ainda no cartão → reaplica (tira e põe)', () => {
  const d = decidirConfirmarRetorno(cartao({ campos: retornoEm(AGORA + 5 * H), tags: [ETIQUETA.CONFIRMAR_RETORNO] }), AGORA);
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

test('reativação: NO_FOLLOW_UP, NAO_PERTURBAR, bloqueado, opt-out ou fora do escopo → pula', () => {
  for (const tags of [['NO_FOLLOW_UP'], ['NAO_PERTURBAR'], ['BLOQUEADO_WHATSAPP'], ['Fluxo · Opt-out WhatsApp'], ['Fora do escopo']]) {
    const d = decidirReativacao(cartao({ closed_at: AGORA - 30 * D - H, campos: RESP, tags }), AGORA, null);
    assert.equal(d?.tipo, 'pula');
  }
});

test('reativação: responsável que não é gente (DOUTOR DIGITAL, I.A SOFIA) → pula', () => {
  for (const r of ['DOUTOR DIGITAL', 'I.A SOFIA']) {
    const d = decidirReativacao(cartao({ closed_at: AGORA - 30 * D - H, campos: { '☻ Responsável agendamento': r } }), AGORA, null);
    assert.equal(d?.tipo, 'pula', r);
  }
});

test('reativação: cartão que nasceu em PERDIDO (importação) não conta os 30 dias', () => {
  const perdeu = AGORA - 30 * D - H;
  const d = decidirReativacao({ ...cartao({ closed_at: perdeu, campos: RESP }), created_at: perdeu - 60 }, AGORA, null);
  assert.equal(d?.tipo, 'pula');
  assert.match(d!.motivo, /nasceu em PERDIDO/);
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

test('reativação: com o modelo v2 (nome fixo) o responsável vazio não trava', () => {
  const d = decidirReativacao(cartao({ closed_at: AGORA - 30 * D - H }), AGORA, null, true);
  assert.equal(d?.tipo, 'coloca');
});

test('modelo v2 só vale aprovado, em todos os números, e com o prefixo da unidade', () => {
  const base = [
    { name: 'acai_sdr_reativacao_lead_frio', reviews: [{ status: 'approved' }] },
    { name: 'acai_consulta_confirmada', reviews: [{ status: 'approved' }] },
  ];
  const com = (name: string, ...status: string[]) => [...base, { name, reviews: status.map((s) => ({ status: s })) }];
  const R = 'sdr_reativacao_lead_frio' as const;
  assert.equal(temModeloV2(com('acai_sdr_reativacao_lead_frio_v2', 'approved'), R), true);
  assert.equal(temModeloV2(com('acai_sdr_reativacao_lead_frio_v2', 'review'), R), false);
  assert.equal(temModeloV2(com('acai_sdr_reativacao_lead_frio_v2', 'approved', 'review'), R), false);
  assert.equal(temModeloV2(com('acai_sdr_reativacao_lead_frio_v2'), R), false);
  // v2 de outra unidade na mesma conta não vale aqui
  assert.equal(temModeloV2(com('imp_sdr_reativacao_lead_frio_v2', 'approved'), R), false);
  // conta com dois originais (duas unidades) é ambígua: não reconhece v2 nenhuma
  assert.equal(
    temModeloV2([...com('acai_sdr_reativacao_lead_frio_v2', 'approved'), { name: 'caxias_sdr_reativacao_lead_frio', reviews: [{ status: 'approved' }] }], R),
    false,
  );
  // v2 de OUTRO modelo não vale pra este
  assert.equal(temModeloV2(com('acai_sdr_boas_vindas_programa_v2', 'approved'), R), false);
  // sem o original na conta não há como saber o prefixo: não reconhece
  assert.equal(temModeloV2(com('acai_sdr_boas_vindas_programa_v2', 'approved'), 'sdr_boas_vindas_programa'), false);
  assert.equal(
    temModeloV2([...com('acai_sdr_boas_vindas_programa_v2', 'approved'), { name: 'acai_sdr_boas_vindas_programa' }], 'sdr_boas_vindas_programa'),
    true,
  );
  assert.equal(temModeloV2(base, R), false);
  assert.equal(temModeloV2(null, R), false);
  assert.equal(temModeloV2([], R), false);
  // formato da API pública: _embedded.reviews
  assert.equal(temModeloV2([...base, { name: 'acai_sdr_reativacao_lead_frio_v2', _embedded: { reviews: [{ status: 'approved' }] } }], R), true);
});

test('com a v2: boas-vindas sem programa/sessão e retorno sem Próxima sessão → coloca', () => {
  assert.equal(decidirBoasVindas(cartao({ closed_at: AGORA - H }), AGORA, true)?.tipo, 'coloca');
  assert.equal(decidirConfirmarRetorno(cartao({ campos: { '◷ Data da Consulta': AGORA + 5 * H } }), AGORA, true)?.tipo, 'coloca');
  // opt-out continua pulando mesmo com a v2
  assert.equal(decidirBoasVindas(cartao({ closed_at: AGORA - H, tags: ['NO_FOLLOW_UP'] }), AGORA, true)?.tipo, 'pula');
});

test('retorno: Próxima sessão com OUTRA data — original pula, v2 coloca', () => {
  const lead = cartao({ campos: { '◷ Data da Consulta': AGORA + 5 * H, '◷ Próxima sessão': AGORA + 6 * D } });
  assert.equal(decidirConfirmarRetorno(lead, AGORA)?.tipo, 'pula');
  assert.equal(decidirConfirmarRetorno(lead, AGORA, true)?.tipo, 'coloca');
});

test('modelosV2 devolve as três respostas de uma vez', () => {
  const ok = (name: string) => ({ name, reviews: [{ status: 'approved' }] });
  const lista = [ok('acai_sdr_boas_vindas_programa'), ok('acai_sdr_boas_vindas_programa_v2'), ok('acai_sdr_confirmacao_retorno'), ok('acai_sdr_reativacao_lead_frio')];
  assert.deepEqual(modelosV2(lista), { boasVindas: true, retorno: false, reativacao: false });
  assert.deepEqual(modelosV2(null), { boasVindas: false, retorno: false, reativacao: false });
});
