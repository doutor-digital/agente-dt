/**
 * Etapas por conta (fronteira papel ↔ nome da conta). O que este arquivo prova:
 *  1. SEM mapa (Parauapebas, qualquer conta de hoje) nada muda: as funções devolvem o MESMO valor e o MESMO objeto;
 *  2. COM o mapa de Timbó (nomes da Kommo) a leitura devolve o papel e a escrita devolve o nome da conta;
 *  3. a leitura é tolerante (nome antigo do molde), e papel que a conta não tem nunca grava etapa errada;
 *  4. a configuração inválida nunca vira «mapa pela metade».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ETAPAS_DO_MOLDE,
  PAPEIS_COMERCIAIS,
  PAPEIS_DO_TRATAMENTO,
  aplicarEtapasDasContas,
  atributosParaGravar,
  conversaCrua,
  etapasDaConta,
  listaDeEtapas,
  listaDeEtapasDoTratamento,
  mapaDaColuna,
  nomeDoTratamentoParaGravar,
  nomeParaGravar,
  papeisDaLista,
  papeisDosAtributos,
  papelDaEtapa,
  papelDaEtapaDoTratamento,
  problemasDoMapa,
  type MapaDeEtapas,
} from './chatwoot-etapas.js';
import { ETAPAS_DE_TIMBO_NA_COLUNA } from './chatwoot-etapas-timbo.js';

const COLUNA_DE_TIMBO = ETAPAS_DE_TIMBO_NA_COLUNA;
const TIMBO = mapaDaColuna(COLUNA_DE_TIMBO) as MapaDeEtapas;

test('o mapa de Timbó é válido e o molde são os 11 papéis + 4 do tratamento que Parauapebas tem', () => {
  assert.deepEqual(problemasDoMapa(COLUNA_DE_TIMBO), []);
  assert.ok(TIMBO);
  assert.deepEqual(ETAPAS_DO_MOLDE.comercial.map((e) => e.nome), ['Novo lead', 'Sofia qualifica', 'Esperando humano', 'Agendado', 'Confirmado', 'Compareceu', 'Fechou', 'Pós-consulta', 'Resgate', 'Perdido', 'Frio']);
  assert.deepEqual(ETAPAS_DO_MOLDE.tratamento.map((e) => e.nome), ['Entrada', 'Em tratamento', 'Alta', 'Tratamento cancelado']);
  assert.equal(PAPEIS_COMERCIAIS.length, 15);
  assert.equal(PAPEIS_DO_TRATAMENTO.length, 4);
});

test('SEM mapa: a mesma coisa, o mesmo objeto (Parauapebas fica byte a byte igual)', () => {
  const attrs = { etapa: 'Sofia qualifica', etapa_tratamento: 'Em tratamento', funil: 'Comercial', outra: 1 };
  const raw = { id: 7, custom_attributes: attrs };
  for (const mapa of [null, undefined, ETAPAS_DO_MOLDE]) {
    assert.equal(papeisDosAtributos(mapa, attrs), attrs);
    assert.equal(conversaCrua(mapa, raw), raw);
    assert.equal(atributosParaGravar(mapa, attrs), attrs);
    for (const p of [...PAPEIS_COMERCIAIS, 'texto livre', '']) {
      assert.equal(papelDaEtapa(mapa, p), p);
      assert.equal(nomeParaGravar(mapa, p), p);
    }
    for (const p of [...PAPEIS_DO_TRATAMENTO, 'texto livre']) {
      assert.equal(papelDaEtapaDoTratamento(mapa, p), p);
      assert.equal(nomeDoTratamentoParaGravar(mapa, p), p);
    }
    assert.deepEqual(papeisDaLista(mapa, ['Novo lead', 'qualquer']), ['Novo lead', 'qualquer']);
  }
  assert.deepEqual(listaDeEtapas(null), ['Novo lead', 'Sofia qualifica', 'Esperando humano', 'Agendado', 'Confirmado', 'Compareceu', 'Fechou', 'Pós-consulta', 'Resgate', 'Perdido', 'Frio']);
  assert.deepEqual(listaDeEtapasDoTratamento(undefined), ['Entrada', 'Em tratamento', 'Alta', 'Tratamento cancelado']);
});

test('conta sem mapa, conta do ambiente e conta desconhecida usam o molde', () => {
  aplicarEtapasDasContas([{ contaId: 3, etapas: COLUNA_DE_TIMBO }, { contaId: null, etapas: COLUNA_DE_TIMBO }]);
  assert.equal(etapasDaConta(3).comercial[1]!.nome, 'EM QUALIFICAÇÃO');
  assert.equal(etapasDaConta(1), ETAPAS_DO_MOLDE);
  assert.equal(etapasDaConta(null), ETAPAS_DO_MOLDE);
  assert.equal(etapasDaConta(undefined), ETAPAS_DO_MOLDE);
  assert.equal(etapasDaConta(99), ETAPAS_DO_MOLDE);
  // duas linhas na mesma conta com mapa: ambíguo → molde
  aplicarEtapasDasContas([{ contaId: 3, etapas: COLUNA_DE_TIMBO }, { contaId: 3, etapas: COLUNA_DE_TIMBO }]);
  assert.equal(etapasDaConta(3), ETAPAS_DO_MOLDE);
  aplicarEtapasDasContas([]);
});

test('COM o mapa de Timbó: o nome da conta vira papel', () => {
  const lido: Array<[string, string]> = [
    ['Leads de entrada', 'Novo lead'],
    ['EM QUALIFICAÇÃO', 'Sofia qualifica'],
    ['EM ESPERA', 'Em espera'],
    ['CONFERIR NA FRANQUIA', 'Conferir na franquia'],
    ['AGENDADO', 'Agendado'], // o alias «Confirmado» NÃO é devolvido: a diferença está em situacao_consulta
    ['NÃO COMPARECEU', 'Faltou'],
    ['COMPARECEU', 'Compareceu'],
    ['EM NEGOCIAÇÃO', 'Pós-consulta'],
    ['RETORNO PÓS-TRATAMENTO', 'Retorno pós-tratamento'],
    ['GANHO / CONCLUÍDO', 'Fechou'],
    ['PERDIDO', 'Perdido'],
    ['  perdido ', 'Perdido'], // grafia sem acento/caixa também
    ['nao comparecEU', 'Faltou'],
  ];
  for (const [nome, papel] of lido) assert.equal(papelDaEtapa(TIMBO, nome.trim()), papel, nome);
  assert.equal(papelDaEtapaDoTratamento(TIMBO, 'Leads de entrada'), 'Entrada');
  assert.equal(papelDaEtapaDoTratamento(TIMBO, 'EM TRATAMENTO'), 'Em tratamento');
  assert.equal(papelDaEtapaDoTratamento(TIMBO, 'ALTA'), 'Alta');
  assert.equal(papelDaEtapaDoTratamento(TIMBO, 'TRATAMENTO CANCELADO'), 'Tratamento cancelado');
});

test('leitura TOLERANTE: o nome antigo do molde continua valendo (conversa ainda não migrada)', () => {
  for (const p of ['Novo lead', 'Sofia qualifica', 'Esperando humano', 'Confirmado', 'Pós-consulta', 'Fechou', 'Frio', 'Resgate']) assert.equal(papelDaEtapa(TIMBO, p), p);
  assert.equal(papelDaEtapa(TIMBO, 'Agendado'), 'Agendado');
  assert.equal(papelDaEtapaDoTratamento(TIMBO, 'Entrada'), 'Entrada');
  assert.equal(papelDaEtapaDoTratamento(TIMBO, 'Em tratamento'), 'Em tratamento');
  assert.equal(papelDaEtapa(TIMBO, 'etapa que ninguém conhece'), 'etapa que ninguém conhece');
  assert.equal(papelDaEtapa(TIMBO, ''), '');
});

test('papéis dos atributos: troca só etapa e etapa_tratamento, sem tocar no original', () => {
  const attrs = { etapa: 'EM QUALIFICAÇÃO', etapa_tratamento: 'ALTA', funil: 'Tratamento', queixa: 'x' };
  const lidos = papeisDosAtributos(TIMBO, attrs);
  assert.deepEqual(lidos, { etapa: 'Sofia qualifica', etapa_tratamento: 'Alta', funil: 'Tratamento', queixa: 'x' });
  assert.equal(attrs.etapa, 'EM QUALIFICAÇÃO'); // o original ficou
  const ja = { etapa: 'Sofia qualifica' };
  assert.equal(papeisDosAtributos(TIMBO, ja), ja); // nada a trocar → o mesmo objeto
  const sem = {};
  assert.equal(papeisDosAtributos(TIMBO, sem), sem);
  const raw = { id: 1, labels: ['a'], custom_attributes: attrs };
  const r = conversaCrua(TIMBO, raw);
  assert.notEqual(r, raw);
  assert.equal(r.custom_attributes.etapa, 'Sofia qualifica');
  assert.equal(r.labels, raw.labels);
  const semAttrs = { id: 2 };
  assert.equal(conversaCrua(TIMBO, semAttrs), semAttrs);
});

test('gravar: papel vira o nome da conta; o que a conta não tem NÃO é gravado', () => {
  assert.equal(nomeParaGravar(TIMBO, 'Sofia qualifica'), 'EM QUALIFICAÇÃO');
  assert.equal(nomeParaGravar(TIMBO, 'Fechou'), 'GANHO / CONCLUÍDO');
  assert.equal(nomeParaGravar(TIMBO, 'Confirmado'), 'AGENDADO');
  assert.equal(nomeParaGravar(TIMBO, 'Agendado'), 'AGENDADO');
  assert.equal(nomeParaGravar(TIMBO, 'Faltou'), 'NÃO COMPARECEU');
  assert.equal(nomeParaGravar(TIMBO, 'Esperando humano'), 'EM QUALIFICAÇÃO'); // substituto: qualificação + etiqueta
  assert.equal(nomeParaGravar(TIMBO, 'Frio'), null);
  assert.equal(nomeParaGravar(TIMBO, 'Resgate'), null);
  assert.equal(nomeParaGravar(TIMBO, 'texto livre da tela'), 'texto livre da tela');
  assert.equal(nomeDoTratamentoParaGravar(TIMBO, 'Entrada'), 'Leads de entrada');
  assert.equal(nomeDoTratamentoParaGravar(TIMBO, 'Alta'), 'ALTA');

  const g = atributosParaGravar(TIMBO, { etapa: 'Perdido', motivo_nao_agendamento: 'Achou caro', etapa_tratamento: 'Em tratamento' });
  assert.deepEqual(g, { etapa: 'PERDIDO', motivo_nao_agendamento: 'Achou caro', etapa_tratamento: 'EM TRATAMENTO' });
  // papel que a conta não tem: o campo sai da gravação (a etapa que a conversa já tem não é trocada)
  assert.deepEqual(atributosParaGravar(TIMBO, { etapa: 'Frio', retomar_em: '2026-12-01' }), { retomar_em: '2026-12-01' });
  // sem etapa na gravação: o mesmo objeto
  const so = { retomar_em: 'x' };
  assert.equal(atributosParaGravar(TIMBO, so), so);
});

test('a lista do atributo na conta: nomes sem repetir, na ordem do quadro; e quais papéis a conta tem', () => {
  assert.deepEqual(listaDeEtapas(TIMBO), ['Leads de entrada', 'EM QUALIFICAÇÃO', 'EM ESPERA', 'CONFERIR NA FRANQUIA', 'AGENDADO', 'NÃO COMPARECEU', 'COMPARECEU', 'EM NEGOCIAÇÃO', 'RETORNO PÓS-TRATAMENTO', 'GANHO / CONCLUÍDO', 'PERDIDO']);
  assert.deepEqual(listaDeEtapasDoTratamento(TIMBO), ['Leads de entrada', 'EM TRATAMENTO', 'ALTA', 'TRATAMENTO CANCELADO']);
  const papeis = papeisDaLista(TIMBO, listaDeEtapas(TIMBO));
  assert.ok(papeis.includes('Sofia qualifica') && papeis.includes('Perdido') && papeis.includes('Agendado'));
  assert.ok(!papeis.includes('Esperando humano') && !papeis.includes('Frio') && !papeis.includes('Confirmado'));
});

test('configuração inválida nunca vira mapa pela metade', () => {
  assert.equal(mapaDaColuna(null), null);
  assert.equal(mapaDaColuna('texto'), null);
  assert.equal(mapaDaColuna({ comercial: [], tratamento: [] }), null);
  assert.ok(problemasDoMapa({ ...COLUNA_DE_TIMBO, comercial: [{ papel: 'Inventado', nome: 'X' }] }).length > 0);
  assert.ok(problemasDoMapa({ ...COLUNA_DE_TIMBO, comercial: [{ papel: 'Fechou', nome: 'A' }, { papel: 'Fechou', nome: 'B' }] }).some((m) => /repetido/.test(m)));
  assert.ok(problemasDoMapa({ ...COLUNA_DE_TIMBO, comercial: [{ papel: 'Fechou', nome: ' sujo ' }] }).length > 0);
  // o nome da conta que é o nome de OUTRO papel do molde tornaria a leitura ambígua
  assert.ok(problemasDoMapa({ ...COLUNA_DE_TIMBO, comercial: [{ papel: 'Faltou', nome: 'Agendado' }, { papel: 'Agendado', nome: 'AGENDADO' }] }).some((m) => /outro papel|mesmo nome/.test(m)));
  // a conta que mantém o nome do molde para o mesmo papel está certa
  assert.deepEqual(problemasDoMapa({ comercial: ETAPAS_DO_MOLDE.comercial, tratamento: ETAPAS_DO_MOLDE.tratamento }), []);
  // mapa sem um papel que o código grava sozinho (Perdido, Fechou, Agendado, Sofia qualifica, Novo lead; Em tratamento, Alta) é inválido
  assert.ok(problemasDoMapa({ ...COLUNA_DE_TIMBO, comercial: COLUNA_DE_TIMBO.comercial.filter((e) => e.papel !== 'Perdido') }).some((x) => /falta o papel «Perdido»/.test(x)));
  assert.ok(problemasDoMapa({ ...COLUNA_DE_TIMBO, tratamento: COLUNA_DE_TIMBO.tratamento.filter((e) => e.papel !== 'Alta') }).some((x) => /falta o papel «Alta»/.test(x)));
  aplicarEtapasDasContas([{ contaId: 3, etapas: { comercial: [{ papel: 'Inventado', nome: 'X' }], tratamento: [] } }]);
  assert.equal(etapasDaConta(3), ETAPAS_DO_MOLDE);
  aplicarEtapasDasContas([]);
});

test('o alias «Confirmado» não tira «Agendado» da leitura, qualquer que seja a ordem do mapa; e nomes repetidos são recusados', () => {
  const invertido = { ...COLUNA_DE_TIMBO, comercial: [...COLUNA_DE_TIMBO.comercial].reverse() };
  assert.deepEqual(problemasDoMapa(invertido), []);
  const m = mapaDaColuna(invertido) as MapaDeEtapas;
  assert.equal(papelDaEtapa(m, 'AGENDADO'), 'Agendado');
  // o mesmo nome (até só em caixa/acento) em dois papéis que NÃO são o par Agendado/Confirmado
  assert.ok(problemasDoMapa({ ...COLUNA_DE_TIMBO, comercial: [{ papel: 'Faltou', nome: 'Agendado' }, { papel: 'Agendado', nome: 'agendado' }] }).some((x) => /mesmo nome/.test(x)));
  assert.ok(problemasDoMapa({ ...COLUNA_DE_TIMBO, comercial: [{ papel: 'Perdido', nome: 'PERDIDO' }, { papel: 'Frio', nome: 'Perdído' }] }).some((x) => /mesmo nome/.test(x)));
});
