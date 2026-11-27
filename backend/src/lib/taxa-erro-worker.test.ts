import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pioroDemais } from './taxa-erro-worker.js';

/**
 * O único alarme técnico que existia era o de saldo esgotado. Erro de verdade
 * era gravado e ninguém comparava com o normal — foi assim que tudo que
 * apareceu hoje passou meses invisível.
 *
 * A parte difícil de um alarme desses não é disparar: é NÃO disparar à toa.
 * Alarme que toca sem motivo é alarme que ninguém olha mais, e aí ele fica pior
 * que não existir. Por isso a maior parte dos casos aqui é sobre silêncio.
 */

const amostra = (o: Partial<Parameters<typeof pioroDemais>[0]>) =>
  pioroDemais({
    slug: 'doutor-hernia-porto',
    unitId: 'u1',
    recentesTotal: 0,
    recentesErro: 0,
    baseTotal: 0,
    baseErro: 0,
    ...o,
  } as Parameters<typeof pioroDemais>[0]);

// ── quando DEVE alarmar ─────────────────────────────────────────────────────

test('um quarto das chamadas falhando alarma sozinho, sem comparar com nada', () => {
  const r = amostra({ recentesTotal: 40, recentesErro: 12, baseTotal: 500, baseErro: 100 });
  assert.equal(r.alarme, true);
  assert.match(r.motivo, /30% das chamadas falhando/);
});

test('sair de zero para um patamar alto alarma', () => {
  const r = amostra({ recentesTotal: 50, recentesErro: 6, baseTotal: 900, baseErro: 0 });
  assert.equal(r.alarme, true);
  assert.match(r.motivo, /saiu de zero/);
});

test('triplicar em relação ao normal da unidade alarma', () => {
  // normal 4%, agora 12%
  const r = amostra({ recentesTotal: 100, recentesErro: 12, baseTotal: 1000, baseErro: 40 });
  assert.equal(r.alarme, true);
  assert.match(r.motivo, /12% agora contra 4% do normal/);
});

// ── quando NÃO pode alarmar ─────────────────────────────────────────────────

test('unidade parada com duas chamadas não vira incêndio', () => {
  // 1 de 2 é 50%, mas não há amostra pra concluir nada.
  const r = amostra({ recentesTotal: 2, recentesErro: 1, baseTotal: 300, baseErro: 3 });
  assert.equal(r.alarme, false);
  assert.match(r.motivo, /amostra pequena/);
});

test('triplicar de um número minúsculo continua sendo ruído', () => {
  // normal 0,2%, agora 0,6% — é o triplo, e não interessa a ninguém.
  const r = amostra({ recentesTotal: 500, recentesErro: 3, baseTotal: 5000, baseErro: 10 });
  assert.equal(r.alarme, false);
  assert.match(r.motivo, /baixa em termos absolutos/);
});

test('unidade que sempre erra um pouco não alarma por continuar igual', () => {
  const r = amostra({ recentesTotal: 200, recentesErro: 20, baseTotal: 2000, baseErro: 190 });
  assert.equal(r.alarme, false);
  assert.match(r.motivo, /dentro do normal/);
});

test('zero erro nunca alarma', () => {
  assert.equal(amostra({ recentesTotal: 300, recentesErro: 0, baseTotal: 3000, baseErro: 60 }).alarme, false);
});

test('unidade sem tráfego nenhum não alarma nem quebra', () => {
  const r = amostra({});
  assert.equal(r.alarme, false);
  assert.equal(r.taxa, 0);
});

test('o motivo é frase de gente, não número solto', () => {
  const r = amostra({ recentesTotal: 40, recentesErro: 12, baseTotal: 500, baseErro: 100 });
  assert.ok(r.motivo.length > 12, 'quem for acordado às 3h precisa entender sem abrir o código');
});

// ── tudo falhando, unidade pequena ──────────────────────────────────────────

test('unidade pequena com a chave quebrada (todas as 12 chamadas falham) alarma, apesar de abaixo do mínimo de 20', () => {
  const r = amostra({ recentesTotal: 12, recentesErro: 12, baseTotal: 80, baseErro: 0 });
  assert.equal(r.alarme, true);
  assert.match(r.motivo, /todas as 12 chamadas falhando/);
});

test('mas 7 chamadas, ou 12 com uma que passou, continuam sendo amostra pequena', () => {
  assert.equal(amostra({ recentesTotal: 7, recentesErro: 7 }).alarme, false);
  assert.equal(amostra({ recentesTotal: 12, recentesErro: 11, baseTotal: 80, baseErro: 0 }).alarme, false);
});

// ── queda geral (rede inteira) ──────────────────────────────────────────────

import { classificarCausa, quedaGeral, montarRede, type AmostraDaRede, type LinhaDaRede } from './taxa-erro-worker.js';

const rede = (o: Partial<AmostraDaRede>): AmostraDaRede => ({
  escopo: 'rede',
  total: 0,
  erros: 0,
  unidadesComErro: 0,
  causas: {},
  ...o,
});

const linhaDaRede = (o: Partial<LinhaDaRede>): LinhaDaRede => ({
  provider: null,
  rede: 0,
  total: 0,
  erros: 0,
  unidades: 0,
  erros_credito: 0,
  erros_chave: 0,
  erros_limite: 0,
  erros_indisponivel: 0,
  erros_outra: 0,
  ...o,
});

test('causa: lê crédito, chave, limite e indisponibilidade pela mensagem do provedor', () => {
  // as três mensagens reais da queda de 26/11 para 27/11
  assert.equal(classificarCausa('400 invalid_request_error: Your credit balance is too low to access the Anthropic API'), 'credito');
  assert.equal(classificarCausa('429 You have no credits remaining'), 'credito'); // 429 mas é crédito, não limite de taxa
  assert.equal(classificarCausa('You exceeded your current quota, please check your plan and billing details'), 'credito');
  assert.equal(classificarCausa('401 Incorrect API key provided'), 'autenticacao');
  assert.equal(classificarCausa('Request failed with status code 403'), 'autenticacao');
  assert.equal(classificarCausa('403 Forbidden'), 'autenticacao');
  assert.equal(classificarCausa('429 Rate limit reached for requests'), 'limite');
  assert.equal(classificarCausa('529 overloaded_error'), 'indisponivel');
  assert.equal(classificarCausa('fetch failed'), 'indisponivel');
  assert.equal(classificarCausa('Unexpected token < in JSON'), 'outra');
  assert.equal(classificarCausa(null), 'outra');
});

test('causa: número solto no meio do texto NÃO vira código de erro (nem "billing" sozinho vira crédito)', () => {
  assert.equal(classificarCausa('messages: text too long (512 tokens max)'), 'outra');
  assert.equal(classificarCausa('pedido 401 do cliente 503 não encontrado'), 'outra');
  assert.equal(classificarCausa('erro ao ler a billing address'), 'outra');
});

test('queda geral: 1.000 erros de crédito em 1.000 chamadas alarma e diz a causa, mesmo com 39 unidades abaixo do mínimo', () => {
  const amostras = montarRede([
    linhaDaRede({ provider: 'anthropic', total: 1000, erros: 1000, unidades: 39, erros_credito: 1000 }),
    linhaDaRede({ rede: 1, total: 1000, erros: 1000, unidades: 39, erros_credito: 1000 }),
  ]);
  assert.equal(amostras[0].escopo, 'rede', 'a soma vem primeiro');
  const v = quedaGeral(amostras);
  assert.equal(v.alarme, true);
  assert.equal(v.causa, 'credito');
  assert.equal(v.escopo, 'rede');
  assert.match(v.motivo, /100% das chamadas falhando nos últimos 10 min \(1000 de 1000, na rede toda\)/);
  assert.match(v.motivo, /saldo de crédito/);
});

test('queda geral: um provedor caído alarma mesmo que o outro vá bem e dilua a rede', () => {
  const amostras = montarRede([
    linhaDaRede({ rede: 1, total: 200, erros: 42, unidades: 12, erros_chave: 40 }),
    linhaDaRede({ provider: 'anthropic', total: 40, erros: 40, unidades: 12, erros_chave: 40 }),
    linhaDaRede({ provider: 'openai', total: 160, erros: 2, unidades: 2 }),
  ]);
  const v = quedaGeral(amostras);
  assert.equal(v.alarme, true);
  assert.equal(v.escopo, 'anthropic');
  assert.equal(v.causa, 'autenticacao');
  assert.match(v.motivo, /provedor anthropic/);
});

test('queda geral: UMA unidade com a chave quebrada num provedor NÃO é queda geral (5 de 5, 401, 1 unidade)', () => {
  const v = quedaGeral([
    rede({ total: 20, erros: 5, unidadesComErro: 1, causas: { autenticacao: 5 } }),
    rede({ escopo: 'anthropic', total: 5, erros: 5, unidadesComErro: 1, causas: { autenticacao: 5 } }),
  ]);
  assert.equal(v.alarme, false);
});

test('queda geral: madrugada com 6 chamadas na REDE, todas por crédito, de 1 unidade só, ainda alarma', () => {
  assert.equal(quedaGeral([rede({ total: 6, erros: 6, unidadesComErro: 1, causas: { credito: 6 } })]).alarme, true);
});

test('queda geral: NÃO alarma com amostra minúscula, com 89% de erro, ou com uma conversa quebrada só', () => {
  assert.equal(quedaGeral([rede({ total: 3, erros: 3, unidadesComErro: 3, causas: { credito: 3 } })]).alarme, false, 'amostra < 5');
  assert.equal(quedaGeral([rede({ total: 100, erros: 89, unidadesComErro: 20, causas: { credito: 89 } })]).alarme, false, '89% < 90%');
  assert.equal(quedaGeral([rede({ total: 8, erros: 8, unidadesComErro: 1, causas: { indisponivel: 8 } })]).alarme, false);
  assert.equal(quedaGeral([]).alarme, false);
});

test('queda geral: 90% exatos alarmam (limite inclusivo)', () => {
  assert.equal(quedaGeral([rede({ total: 100, erros: 90, unidadesComErro: 9, causas: { indisponivel: 90 } })]).alarme, true);
});
