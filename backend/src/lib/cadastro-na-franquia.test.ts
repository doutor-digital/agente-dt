/**
 * Quem entra na base da franqueadora.
 *
 * O erro que estes testes impedem já aconteceu em escala: 4.270 leads criados em 30 dias,
 * 96% deles gente que mandou uma mensagem e sumiu. A regra é do João e é simples — só
 * agendou entra.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deveCriarNaFranquia, ferramentasChamadas } from './cadastro-na-franquia.js';

test('quem só conversou NÃO entra — é 96% dos leads', () => {
  const d = deveCriarNaFranquia({ ferramentas: ['registrar_campo', 'aplicar_tag'] });
  assert.equal(d.criar, false);
  assert.match(d.motivo, /sem agendamento/);
});

test('agendou, entra', () => {
  assert.equal(deveCriarNaFranquia({ ferramentas: ['agendar_consulta'] }).criar, true);
  assert.equal(deveCriarNaFranquia({ ferramentas: ['remarcar_consulta'] }).criar, true);
  assert.equal(deveCriarNaFranquia({ ferramentas: ['confirmar_presenca'] }).criar, true);
});

test('só PERGUNTAR horário não basta — perguntar é intenção, não agendamento', () => {
  const d = deveCriarNaFranquia({ ferramentas: ['consultar_horarios'] });
  assert.equal(d.criar, false, 'metade de quem consulta não fecha; isso traria o lixo de volta');
});

test('cartão já em etapa de quem tem consulta entra, mesmo sem ferramenta nesta rodada', () => {
  for (const etapa of ['AGENDADO', 'COMPARECEU', 'NÃO COMPARECEU', 'EM NEGOCIAÇÃO', 'EM TRATAMENTO', 'ALTA']) {
    assert.equal(deveCriarNaFranquia({ ferramentas: [], etapaDoCartao: etapa }).criar, true, etapa);
  }
});

test('etapa do começo do funil não entra', () => {
  for (const etapa of ['EM QUALIFICAÇÃO', 'EM ESPERA', 'Incoming leads', 'PERDIDO', 'CONFERIR NA FRANQUIA']) {
    assert.equal(deveCriarNaFranquia({ ferramentas: [], etapaDoCartao: etapa }).criar, false, etapa);
  }
});

test('acento na etapa não muda a decisão', () => {
  assert.equal(deveCriarNaFranquia({ ferramentas: [], etapaDoCartao: 'nao compareceu' }).criar, true);
  assert.equal(deveCriarNaFranquia({ ferramentas: [], etapaDoCartao: 'NÃO COMPARECEU' }).criar, true);
});

test('quem já tem consulta na franquia entra sempre', () => {
  assert.equal(deveCriarNaFranquia({ ferramentas: [], jaTemConsulta: true }).criar, true);
});

test('sem sinal nenhum, não entra — o padrão é não sujar a base', () => {
  assert.equal(deveCriarNaFranquia({ ferramentas: [] }).criar, false);
  assert.equal(deveCriarNaFranquia({ ferramentas: [], etapaDoCartao: null }).criar, false);
});

test('lê tool_calls nos dois formatos que o LangChain produz', () => {
  const msgs = [
    { tool_calls: [{ name: 'agendar_consulta' }] },
    { additional_kwargs: { tool_calls: [{ function: { name: 'registrar_campo' } }] } },
    { content: 'texto sem ferramenta' },
  ];
  const f = ferramentasChamadas(msgs);
  assert.deepEqual(f.sort(), ['agendar_consulta', 'registrar_campo']);
});

test('entrada estranha não derruba — devolve lista vazia', () => {
  for (const v of [null, undefined, 'texto', 42, {}]) {
    assert.deepEqual(ferramentasChamadas(v), []);
  }
});
