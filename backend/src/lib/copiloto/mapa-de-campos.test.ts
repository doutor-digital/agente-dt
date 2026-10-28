import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DICIONARIO } from './dicionario-campos.js';
import {
  atoresDe, camposDaEtapa, ehCampoTecnico, explicarCampo, infoDoCampo, missaoDaEtapa, podeSugerir, proximasEtapas, validarProposta,
} from './mapa-de-campos.js';

const vazio = () => null;

test('o dicionário carrega e todo campo listado numa etapa existe nele (ninguém inventa nome)', () => {
  assert.equal(Object.keys(DICIONARIO.campos).length, 108);
  for (const [etapa, lista] of Object.entries(DICIONARIO.etapas)) {
    for (const nome of lista) assert.ok(infoDoCampo(nome), `"${nome}" (etapa ${etapa}) não está no dicionário`);
  }
});

test('atoresDe lê o texto de "quem preenche"', () => {
  assert.deepEqual(atoresDe('SDR'), ['sdr']);
  assert.deepEqual(atoresDe('Sofia ou SDR').sort(), ['sdr', 'sofia']);
  assert.deepEqual(atoresDe('Automático (Asaas)'), ['automatico']);
  assert.deepEqual(atoresDe('Fisio ou Recepção').sort(), ['fisio', 'recepcao']);
  assert.ok(atoresDe('Sofia (ajuste se discordar)').includes('sdr'), 'a pessoa pode ajustar o que a Sofia preencheu');
  assert.deepEqual(atoresDe('Sofia'), ['sofia']);
});

test('campo que chega sozinho NUNCA é proposto, nem que o texto diga "SDR"', () => {
  for (const nome of Object.keys(DICIONARIO.campos)) {
    const i = infoDoCampo(nome)!;
    if (i.chegaSozinho) assert.notEqual(podeSugerir(nome, 'sdr').acao, 'propor', `${nome} chega sozinho mas foi proposto`);
    if (i.atores.includes('automatico')) assert.notEqual(podeSugerir(nome, 'sdr').acao, 'propor', `${nome} é automático mas foi proposto`);
  }
});

test('data da consulta e valor do tratamento: chegam da franquia, o Copiloto só explica', () => {
  const d = podeSugerir('◷ Data da Consulta');
  assert.equal(d.acao, 'recusar');
  assert.match(d.motivo, /chega sozinho/i);
  assert.equal(podeSugerir('¤ Valor do tratamento').acao, 'recusar');
});

test('campo técnico e campo inexistente são recusados', () => {
  assert.ok(ehCampoTecnico('utm_source'));
  assert.equal(podeSugerir('utm_source').acao, 'recusar');
  assert.equal(podeSugerir('Campo Que Eu Inventei').acao, 'recusar');
  assert.match(podeSugerir('Campo Que Eu Inventei').motivo, /não existe no padrão/);
});

test('campo da recepção não é proposto para a SDR, mas é para a recepção', () => {
  assert.equal(podeSugerir('★ Satisfação / NPS', 'sdr').acao, 'recusar');
  assert.match(podeSugerir('★ Satisfação / NPS', 'sdr').motivo, /recepção/);
  assert.equal(podeSugerir('★ Satisfação / NPS', 'recepcao').acao, 'propor');
});

test('campo com parte automática ("Sofia ou automático") só gera aviso', () => {
  assert.equal(podeSugerir('⬢ Tipo de lead').acao, 'avisar');
});

test('proposta válida: campo da SDR, da etapa, vazio, com opção da lista', () => {
  const r = validarProposta({ campo: '✎ Observações', valor: 'Prefere de manhã' }, { etapa: 'EM QUALIFICAÇÃO', valorAtual: vazio });
  assert.equal(r.acao, 'propor');
});

test('não sobrescreve o que já tem valor', () => {
  const r = validarProposta({ campo: '✎ Queixa', valor: 'dor lombar' }, { etapa: 'EM QUALIFICAÇÃO', valorAtual: () => 'dor cervical' });
  assert.equal(r.acao, 'recusar');
  assert.match(r.motivo, /não sobrescrevo/);
});

test('campo de outra etapa é recusado, com a etapa certa no motivo', () => {
  const r = validarProposta({ campo: '¤ Valor pago / entrada', valor: '250' }, { etapa: 'EM QUALIFICAÇÃO', valorAtual: vazio });
  assert.equal(r.acao, 'recusar');
  assert.match(r.motivo, /GANHO/);
});

test('campo da próxima etapa NÃO passa por padrão; só com a opção explícita', () => {
  assert.ok(proximasEtapas('EM QUALIFICAÇÃO').includes('AGENDADO'));
  const r = validarProposta({ campo: '¤ Valor da Consulta', valor: '250' }, { etapa: 'EM QUALIFICAÇÃO', valorAtual: vazio });
  assert.equal(r.acao, 'recusar');
  assert.match(r.motivo, /AGENDADO/);
  assert.equal(validarProposta({ campo: '¤ Valor da Consulta', valor: '250' }, { etapa: 'EM QUALIFICAÇÃO', valorAtual: vazio, incluirProximas: true }).acao, 'propor');
});

test('lista sem opções conhecidas: recusa o valor (não dá para conferir)', () => {
  const r = validarProposta({ campo: '⬢ Tipo de agendamento', valor: 'qualquer coisa' }, { etapa: 'AGENDADO', valorAtual: vazio, opcoes: () => null, ehLista: () => true });
  assert.equal(r.acao, 'recusar');
});

test('lista de opções: valor fora da lista é recusado, dentro (sem diferença de maiúscula) passa', () => {
  const opcoes = () => ['Quente', 'Morno', 'Frio'];
  assert.equal(validarProposta({ campo: '★ Qualificação (Quente/Morno/Frio)', valor: 'Fervendo' }, { etapa: 'EM QUALIFICAÇÃO', valorAtual: vazio, opcoes }).acao, 'recusar');
  // Qualificação é da Sofia com ajuste da SDR: vazio e na lista, pode propor
  assert.equal(validarProposta({ campo: '★ Qualificação (Quente/Morno/Frio)', valor: 'quente' }, { etapa: 'EM QUALIFICAÇÃO', valorAtual: vazio, opcoes }).acao, 'propor');
});

test('valor vazio é recusado', () => {
  assert.equal(validarProposta({ campo: '✎ Queixa', valor: '  ' }, { etapa: 'EM QUALIFICAÇÃO' }).acao, 'recusar');
});

test('missão e campos da etapa vêm do dicionário', () => {
  assert.match(missaoDaEtapa('EM QUALIFICAÇÃO') ?? '', /queixa/i);
  assert.ok(camposDaEtapa('AGENDADO').length > 0);
  assert.equal(camposDaEtapa('ETAPA QUE NÃO EXISTE').length, 0);
});

test('explicarCampo usa o dicionário e diz quando chega sozinho', () => {
  assert.match(explicarCampo('◷ Data da Consulta') ?? '', /Chega sozinho/);
  assert.equal(explicarCampo('Campo que não existe'), null);
});
