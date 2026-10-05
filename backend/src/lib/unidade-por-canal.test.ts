/**
 * Unidade pelo número de WhatsApp (Petrópolis × Caxias no mesmo Kommo).
 *
 * O que estes testes prendem:
 *  - vale o canal da PRIMEIRA conversa do cartão;
 *  - campo preenchido nunca é trocado (confere/diverge), e a etiqueta segue o que está no campo;
 *  - canal fora do mapa não decide nada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CANAIS_POR_UNIDADE, etiquetaDe, planejarUnidade } from './unidade-por-canal.js';

const MAPA = CANAIS_POR_UNIDADE['doutor-hernia-petropolis'];
const CAXIAS = 15410;
const PETRO = 5332;

test('campo vazio: grava a unidade do canal e a etiqueta da cidade', () => {
  const r = planejarUnidade({ conversas: [{ sourceId: CAXIAS, criadaEm: 100 }], mapa: MAPA, noCartao: null, etiquetas: [] });
  assert.deepEqual(r, { acao: 'gravar', unidade: 'Caxias', etiqueta: 'CAXIAS', motivo: 'primeira conversa pelo número de Caxias' });
});

test('duas conversas por números diferentes: vale a mais antiga', () => {
  const r = planejarUnidade({
    conversas: [{ sourceId: PETRO, criadaEm: 500 }, { sourceId: CAXIAS, criadaEm: 100 }],
    mapa: MAPA, noCartao: null, etiquetas: [],
  });
  assert.equal(r?.unidade, 'Caxias');
});

test('campo já preenchido: não troca; confere ou diverge; etiqueta segue o campo e só quando falta', () => {
  const confere = planejarUnidade({ conversas: [{ sourceId: PETRO, criadaEm: 1 }], mapa: MAPA, noCartao: 'Petrópolis', etiquetas: ['PETRÓPOLIS'] });
  assert.deepEqual(confere, { acao: 'confere', unidade: 'Petrópolis', noCartao: 'Petrópolis', etiqueta: null, motivo: 'primeira conversa pelo número de Petrópolis' });

  // a SDR corrigiu para Petrópolis um lead que entrou por Caxias: diverge, e a etiqueta é a do campo
  const diverge = planejarUnidade({ conversas: [{ sourceId: CAXIAS, criadaEm: 1 }], mapa: MAPA, noCartao: 'Petrópolis', etiquetas: [] });
  assert.equal(diverge?.acao, 'diverge');
  assert.equal(diverge?.etiqueta, 'PETRÓPOLIS');
});

test('canal fora do mapa ou sem conversa: não decide', () => {
  assert.equal(planejarUnidade({ conversas: [{ sourceId: 999, criadaEm: 1 }], mapa: MAPA, noCartao: null, etiquetas: [] }), null);
  assert.equal(planejarUnidade({ conversas: [], mapa: MAPA, noCartao: null, etiquetas: [] }), null);
  assert.equal(planejarUnidade({ conversas: [{ sourceId: null, criadaEm: 1 }], mapa: MAPA, noCartao: null, etiquetas: [] }), null);
});

test('etiqueta: caixa alta com acento', () => {
  assert.equal(etiquetaDe('Petrópolis'), 'PETRÓPOLIS');
});
