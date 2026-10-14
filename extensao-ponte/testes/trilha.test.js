// 0.5.0 — as regras da trilha (trilha.js): de quem é cada etapa, o que vem depois, o que é da atendente agora,
// e as leituras mastigadas (qualificação, consulta, dias). Puro: sem DOM.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../trilha.js');

describe('trilha.js', () => {
  it('as etapas que andam sozinhas pela franquia × as da atendente (pelo nome, com ou sem acento)', () => {
    const franquia = ['AGENDADO', 'COMPARECEU', 'NÃO COMPARECEU', 'NAO COMPARECEU', 'EM TRATAMENTO', 'ALTA', 'GANHO / CONCLUIDO', 'GANHO / CONCLUÍDO', 'RETORNO PÓS-TRATAMENTO'];
    const voce = ['Etapa de leads de entrada', 'EM QUALIFICAÇÃO', 'EM ESPERA', 'PERDIDO', 'CONFERIR NA FRANQUIA', 'EM NEGOCIAÇÃO', 'TRATAMENTO CANCELADO'];
    for (const n of franquia) assert.equal(T.donoDaEtapa(n), 'franquia', n);
    for (const n of voce) assert.equal(T.donoDaEtapa(n), 'voce', n);
    assert.equal(T.donoDaEtapa('ETAPA INVENTADA'), null);
    assert.equal(T.donoDaEtapa(null), null);
  });

  it('o que vem depois diz quem faz o cartão andar', () => {
    assert.match(T.depoisDaEtapa('AGENDADO'), /sozinho para COMPARECEU ou NÃO COMPARECEU/);
    assert.match(T.depoisDaEtapa('EM QUALIFICAÇÃO'), /você move pelo guia/);
    assert.match(T.depoisDaEtapa('EM TRATAMENTO'), /sozinho para ALTA/);
    assert.equal(T.depoisDaEtapa('XYZ'), null);
  });

  it('"O que é seu agora": de 1 a 3 ações; o próximo passo do servidor entra primeiro; qualificação vazia vira ação', () => {
    for (const e of ['Etapa de leads de entrada', 'EM QUALIFICAÇÃO', 'EM ESPERA', 'CONFERIR NA FRANQUIA', 'AGENDADO', 'NÃO COMPARECEU', 'COMPARECEU', 'EM NEGOCIAÇÃO', 'RETORNO PÓS-TRATAMENTO', 'GANHO / CONCLUIDO', 'EM TRATAMENTO', 'ALTA', 'PERDIDO', 'TRATAMENTO CANCELADO']) {
      const l = T.acoesDaEtapa(e, {});
      assert.ok(l.length >= 1 && l.length <= 3, e);
    }
    const ag = T.acoesDaEtapa('AGENDADO', { proximoPasso: 'Confirmar a presença na consulta de 15/10 às 08:00.' });
    assert.equal(ag[0], 'Confirmar a presença na consulta de 15/10 às 08:00.');
    assert.ok(T.acoesDaEtapa('EM QUALIFICAÇÃO', { qualificacao: null }).some((t) => /Qualificação/.test(t)));
    assert.ok(!T.acoesDaEtapa('EM QUALIFICAÇÃO', { qualificacao: 'Quente' }).some((t) => /Marcar a ★/.test(t)));
    assert.ok(!T.acoesDaEtapa('EM QUALIFICAÇÃO', {}).some((t) => /Marcar a ★/.test(t)), 'conta sem o campo (undefined) não pede');
    assert.match(T.acoesDaEtapa('EM TRATAMENTO', { proximaSessao: { dia: '16/10', hora: '17:30' } })[0], /16\/10 às 17:30/);
    assert.deepEqual(T.acoesDaEtapa('XYZ', {}), []);
  });

  it('estações: feitas antes da atual; PERDIDO não pinta nada; GANHO/PERDIDO são saídas', () => {
    const b = { etapas: [{ id: 1, nome: 'EM QUALIFICAÇÃO' }, { id: 2, nome: 'AGENDADO', atual: true }, { id: 142, nome: 'GANHO' }, { id: 143, nome: 'PERDIDO' }] };
    assert.deepEqual(T.estacoes(b).map((e) => e.estado), ['feita', 'atual', 'futura', 'futura']);
    assert.deepEqual(T.estacoes(b).map((e) => e.saida), [false, false, true, true]);
    const p = { etapas: [{ id: 1, nome: 'EM QUALIFICAÇÃO' }, { id: 2, nome: 'AGENDADO' }, { id: 143, nome: 'PERDIDO', atual: true }] };
    assert.deepEqual(T.estacoes(p).map((e) => e.estado), ['futura', 'futura', 'atual']);
    assert.deepEqual(T.estacoes(null), []);
  });

  it('tempo na etapa e o relógio de alerta (só nas etapas em que esperar custa)', () => {
    const agora = new Date('2026-10-14T13:00:00Z');
    assert.equal(T.tempoNaEtapa('2026-10-14T12:30:00Z', agora), 'há 30 min');
    assert.equal(T.tempoNaEtapa('2026-10-14T10:00:00Z', agora), 'há 3 h');
    assert.equal(T.tempoNaEtapa('2026-10-13T12:00:00Z', agora), 'há 1 dia');
    assert.equal(T.tempoNaEtapa(null, agora), null);
    assert.equal(T.relogioAtrasado('EM QUALIFICAÇÃO', '2026-10-11T13:00:00Z', agora), true);
    assert.equal(T.relogioAtrasado('EM QUALIFICAÇÃO', '2026-10-14T10:00:00Z', agora), false);
    assert.equal(T.relogioAtrasado('EM ESPERA', '2026-09-01T13:00:00Z', agora), false, 'esperar é o normal de EM ESPERA');
  });

  it('qualificação, situação da consulta, dias e alta', () => {
    assert.equal(T.qualificacao(undefined), null);
    assert.equal(T.qualificacao(null).nivel, 'sem');
    assert.equal(T.qualificacao('Quente').nivel, 'quente');
    assert.equal(T.qualificacao('morno').nivel, 'morno');
    assert.equal(T.qualificacao('FRIO').nivel, 'frio');
    assert.deepEqual(T.situacaoDaConsulta('ATENDIDO'), { rotulo: 'Compareceu', nivel: 'bom' });
    assert.deepEqual(T.situacaoDaConsulta('NÃO COMPARECEU'), { rotulo: 'Faltou', nivel: 'ruim' });
    assert.deepEqual(T.situacaoDaConsulta('CONFIRMADO'), { rotulo: 'Confirmada', nivel: 'bom' });
    assert.equal(T.situacaoDaConsulta(null), null);
    const agora = new Date('2026-10-14T13:00:00Z');
    assert.equal(T.diasAte('2026-10-15T11:00:00Z', agora, 'America/Sao_Paulo'), 'amanhã');
    assert.equal(T.diasAte('2026-10-14T23:00:00Z', agora, 'America/Sao_Paulo'), 'hoje', '20h em SP ainda é hoje');
    assert.equal(T.diasAte('2026-10-17T13:00:00Z', agora, 'America/Sao_Paulo'), 'em 3 dias');
    assert.equal(T.diaDaSemana('2026-10-15T11:00:00Z', 'America/Sao_Paulo'), 'qui');
    assert.equal(T.teveAlta(null, 'ALTA'), true);
    assert.equal(T.teveAlta({ status: 'Finalizado' }, 'EM TRATAMENTO'), true);
    assert.equal(T.teveAlta({ status: 'Em andamento' }, 'EM TRATAMENTO'), false);
  });

  it('selo da unidade: o servidor manda o campo; sem ele, o nome da franquia; vazio na conta dividida = escolher', () => {
    assert.deepEqual(T.unidadeDoCartao({ unidade: { nome: null, compartilhada: true } }, null), { nome: null, vazia: true, compartilhada: true, cor: null });
    assert.equal(T.unidadeDoCartao({ unidade: { nome: 'Caxias', compartilhada: true } }, null).cor, 'magenta');
    assert.equal(T.unidadeDoCartao({}, { unidade: 'Açailândia' }).nome, 'Açailândia');
    assert.equal(T.unidadeDoCartao({}, null), null);
  });
});

describe('trilha.js — sem a movimentação pela franquia (0.5.0)', () => {
  it('o dono, o depois, a regra e as ações não prometem que o cartão anda sozinho', () => {
    assert.equal(T.rotuloDoDono('franquia', true), 'A recepção atualiza pela franquia');
    assert.equal(T.rotuloDoDono('franquia', false), 'Anda sozinha pela franquia');
    assert.equal(T.rotuloDoDono('voce', true), T.rotuloDoDono('voce', false));
    for (const e of ['EM QUALIFICAÇÃO', 'EM ESPERA', 'CONFERIR NA FRANQUIA', 'AGENDADO', 'NÃO COMPARECEU', 'COMPARECEU', 'EM NEGOCIAÇÃO', 'RETORNO PÓS-TRATAMENTO', 'GANHO / CONCLUIDO', 'EM TRATAMENTO', 'ALTA']) {
      assert.doesNotMatch(T.depoisDaEtapa(e, true), /sozinh/, e);
      for (const a of T.acoesDaEtapa(e, { semRobo: true })) assert.doesNotMatch(a, /sozinh|leva o cartão/, `${e}: ${a}`);
    }
    assert.doesNotMatch(T.regraDaFranquia(true), /sozinh/);
    assert.match(T.regraDaFranquia(false), /anda sozinho/);
  });
});
