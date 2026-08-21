import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatarQuandoFoi,
  sanitizeOutcome,
  preservarFatosDeContato,
} from './lead-memory.service.js';

const AGORA = new Date('2026-08-21T12:00:00Z');
const diasAtras = (d: number) => new Date(AGORA.getTime() - d * 86_400_000).toISOString();

test('formatarQuandoFoi fala como gente, não em data ISO', () => {
  assert.equal(formatarQuandoFoi(diasAtras(0), AGORA), 'hoje');
  assert.equal(formatarQuandoFoi(diasAtras(1), AGORA), 'ontem');
  assert.equal(formatarQuandoFoi(diasAtras(3), AGORA), 'há 3 dias');
  assert.equal(formatarQuandoFoi(diasAtras(10), AGORA), 'há uma semana');
  assert.equal(formatarQuandoFoi(diasAtras(60), AGORA), 'há 2 meses');
  assert.equal(formatarQuandoFoi(diasAtras(500), AGORA), 'há mais de um ano');
});

test('formatarQuandoFoi não quebra com lixo', () => {
  assert.equal(formatarQuandoFoi('não é data', AGORA), '');
  assert.equal(formatarQuandoFoi('', AGORA), '');
});

test('sanitizeOutcome só aceita desfecho conhecido', () => {
  assert.equal(sanitizeOutcome('agendou'), 'agendou');
  assert.equal(sanitizeOutcome('TRAVOU_PRECO'), 'travou_preco');
  assert.equal(sanitizeOutcome('inventado_pelo_llm'), null);
  assert.equal(sanitizeOutcome(42), null);
  assert.equal(sanitizeOutcome(null), null);
});

test('o summarizer não apaga o carimbo de último contato', () => {
  const anterior = {
    ultimo_contato: '2026-06-01T10:00:00Z',
    ultimo_desfecho: 'travou_preco',
    travou_em: 'preço',
    queixa: 'lombar',
  };
  const doSummarizer = { queixa: 'lombar irradiando', cidade: 'Canaã' };
  const out = preservarFatosDeContato(anterior, doSummarizer);
  assert.equal(out.ultimo_contato, '2026-06-01T10:00:00Z');
  assert.equal(out.ultimo_desfecho, 'travou_preco');
  assert.equal(out.travou_em, 'preço');
  assert.equal(out.queixa, 'lombar irradiando');
  assert.equal(out.cidade, 'Canaã');
});

test('carimbo novo tem precedência sobre o antigo', () => {
  const out = preservarFatosDeContato(
    { ultimo_desfecho: 'sumiu' },
    { ultimo_desfecho: 'agendou' },
  );
  assert.equal(out.ultimo_desfecho, 'agendou');
});

test('sem carimbo anterior, não inventa chave', () => {
  const out = preservarFatosDeContato({}, { queixa: 'ombro' });
  assert.equal(out.ultimo_contato, undefined);
  assert.equal(out.queixa, 'ombro');
});
