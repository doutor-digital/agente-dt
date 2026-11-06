/**
 * perda-ia × o que o CARTÃO já diz (06/11/2026): quem a IA nem chega a ler. Tudo puro, sem Kommo.
 *
 * Os JAMAIS do João: consulta futura, ◷ Retomar em no futuro, «Pausar IA» ligado, etiqueta de cartão já tratado.
 * E a regra do motivo-perdido-ia: só preenche o que está vazio.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERDIDO, porQueNaoPreencherMotivo, porQueOCartaoFica } from './perda-ia-cartao.js';

const AGORA = 1_800_000_000; // meio do dia em UTC
const TZ = 'UTC';
const DIA = 86_400;
const PAUSAR_IA = 777;

type Campo = { field_id?: number; field_name?: string; values?: Array<{ value: unknown }> };
const campo = (field_name: string, value: unknown, field_id?: number): Campo => ({ field_id, field_name, values: [{ value }] });
const cartao = (campos: Campo[] = [], tags: string[] = []) => ({
  custom_fields_values: campos as never,
  _embedded: { tags: tags.map((name, id) => ({ id, name })) },
});
const ctx = { agoraEpoch: AGORA, tz: TZ, pausarIaFieldId: PAUSAR_IA };

test('cartão limpo é candidato (a IA ainda vai ler a conversa)', () => {
  assert.equal(porQueOCartaoFica(cartao(), ctx), null);
});

test('consulta futura no cartão não é candidato; consulta passada ou desmarcada, sim', () => {
  const futura = cartao([campo('◷ Data da Consulta', AGORA + 3 * DIA), campo('✓ Situação da consulta', 'Agendado')]);
  assert.match(porQueOCartaoFica(futura, ctx) ?? '', /consulta futura/);
  const desmarcada = cartao([campo('◷ Data da Consulta', AGORA + 3 * DIA), campo('✓ Situação da consulta', 'Desmarcado')]);
  assert.equal(porQueOCartaoFica(desmarcada, ctx), null);
  const passada = cartao([campo('◷ Data da Consulta', AGORA - 3 * DIA), campo('✓ Situação da consulta', 'Agendado')]);
  assert.equal(porQueOCartaoFica(passada, ctx), null);
});

test('◷ Retomar em de hoje em diante segura; retomada que já passou não', () => {
  assert.match(porQueOCartaoFica(cartao([campo('◷ Retomar em', AGORA + 5 * DIA)]), ctx) ?? '', /Retomar em/);
  assert.match(porQueOCartaoFica(cartao([campo('◷ Retomar em', AGORA)]), ctx) ?? '', /Retomar em é hoje/);
  assert.equal(porQueOCartaoFica(cartao([campo('◷ Retomar em', AGORA - 5 * DIA)]), ctx), null);
});

test('«Pausar IA» marcado segura (caixinha em qualquer formato do Kommo); desmarcado ou unidade sem o campo, não', () => {
  for (const marcado of [true, '1', 1, 'true']) assert.match(porQueOCartaoFica(cartao([campo('Pausar IA', marcado, PAUSAR_IA)]), ctx) ?? '', /Pausar IA/, String(marcado));
  assert.equal(porQueOCartaoFica(cartao([campo('Pausar IA', false, PAUSAR_IA)]), ctx), null);
  assert.equal(porQueOCartaoFica(cartao([campo('Pausar IA', true, PAUSAR_IA)]), { ...ctx, pausarIaFieldId: null }), null);
});

test('etiqueta de cartão já tratado segura: NO_FOLLOW_UP, CURRÍCULO, opt-out', () => {
  for (const tag of ['NO_FOLLOW_UP', 'CURRÍCULO', 'curriculo', 'NAO_PERTURBAR', 'Fluxo · Opt-out WhatsApp']) assert.match(porQueOCartaoFica(cartao([], [tag]), ctx) ?? '', /etiqueta/, tag);
  assert.equal(porQueOCartaoFica(cartao([], ['Meta-Ads', 'Quente demais?']), ctx), null);
});

test('quem já foi atendido ou faltou (e foi parar em EM ESPERA) é jornada da franquia: não é candidato', () => {
  for (const situacao of ['Atendido', 'Não compareceu']) assert.match(porQueOCartaoFica(cartao([campo('✓ Situação da consulta', situacao)]), ctx) ?? '', /consulta já aconteceu/, situacao);
});

test('pagamento antecipado e Quente/Morno seguram (a trava da perda automática, a mesma do parados)', () => {
  assert.match(porQueOCartaoFica(cartao([], ['$ · Pagou antecipado']), ctx) ?? '', /pagou/);
  assert.match(porQueOCartaoFica(cartao([], ['Quente']), ctx) ?? '', /Quente/);
});

// ── motivo-perdido-ia ──

const PERDIDO_BASE = { status_id: PERDIDO, pipeline_id: 10, closed_at: AGORA - 3600, updated_at: AGORA - 3600, ...cartao() };
const o = { agoraEpoch: AGORA, comercialId: 10 };

test('motivo-perdido-ia: PERDIDO do COMERCIAL que entrou há 10 min a 24 h, com os dois ⊘ vazios, é candidato', () => {
  assert.equal(porQueNaoPreencherMotivo(PERDIDO_BASE, o), null);
});

test('motivo-perdido-ia: nunca toca em motivo preenchido (não agendamento OU não fechamento)', () => {
  const preenchido = { ...PERDIDO_BASE, ...cartao([campo('⊘ Motivo do não agendamento', 'Sem interesse')]) };
  assert.match(porQueNaoPreencherMotivo(preenchido, o) ?? '', /já está preenchido/);
  const naoFechou = { ...PERDIDO_BASE, ...cartao([campo('⊘ Motivo de não fechamento', 'Decidir com a família')]) };
  assert.match(porQueNaoPreencherMotivo(naoFechou, o) ?? '', /não fechamento/);
  const nomeAntigo = { ...PERDIDO_BASE, ...cartao([campo('⊘ Motivo de não fechamento do tratamento', 'Vai viajar')]) };
  assert.match(porQueNaoPreencherMotivo(nomeAntigo, o) ?? '', /não fechamento/);
});

test('motivo-perdido-ia: janela de 24 h, carência de 10 min, funil e etapa certos, consulta já feita e currículo ficam de fora', () => {
  assert.match(porQueNaoPreencherMotivo({ ...PERDIDO_BASE, closed_at: AGORA - 30 * 3600 }, o) ?? '', /mais de 24 h/);
  assert.match(porQueNaoPreencherMotivo({ ...PERDIDO_BASE, closed_at: AGORA - 120 }, o) ?? '', /menos de 10 min/);
  assert.match(porQueNaoPreencherMotivo({ ...PERDIDO_BASE, pipeline_id: 11 }, o) ?? '', /não está em PERDIDO do COMERCIAL/);
  assert.match(porQueNaoPreencherMotivo({ ...PERDIDO_BASE, status_id: 555 }, o) ?? '', /não está em PERDIDO/);
  assert.match(porQueNaoPreencherMotivo({ ...PERDIDO_BASE, ...cartao([campo('✓ Situação da consulta', 'Atendido')]) }, o) ?? '', /consulta já aconteceu/);
  assert.match(porQueNaoPreencherMotivo({ ...PERDIDO_BASE, ...cartao([], ['CURRÍCULO']) }, o) ?? '', /currículo/);
});
