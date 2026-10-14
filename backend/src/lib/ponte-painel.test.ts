// Ponte 0.5.0 (visual novo) — os campos novos da resposta do cartão (`lib/ponte-painel.ts`).
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _semearParaTeste } from './automacoes-estado.js';
import type { GrupoDoCrm } from './crm-compartilhado.js';
import {
  barraDoTratamento,
  desdeEmIso,
  franquiaAndaSozinha,
  nomeCurtoDaUnidade,
  qualificacaoDoCartao,
  slugDaUnidadeDoCartao,
  sofiaNaUnidade,
  telefoneDoPainel,
  unidadeDoPainel,
} from './ponte-painel.js';

// a conta de Petrópolis atende Petrópolis e Caxias (PR #58)
const GRUPO: GrupoDoCrm = {
  contaUnitId: 'u-petro',
  membros: [
    { unitId: 'u-petro', contaUnitId: 'u-petro', rotulo: 'Petrópolis', slug: 'doutor-hernia-petropolis' },
    { unitId: 'u-caxias', contaUnitId: 'u-petro', rotulo: 'Caxias', slug: 'doutor-hernia-caxias' },
  ],
};
const PETRO = { id: 'u-petro', slug: 'doutor-hernia-petropolis' };

describe('o selo da unidade', () => {
  it('conta de uma unidade: o nome dela, sem a lista', () => {
    assert.deepEqual(unidadeDoPainel(null, 'Açailândia', null), { nome: 'Açailândia', compartilhada: false });
    assert.deepEqual(unidadeDoPainel(null, 'Açailândia', 'qualquer coisa'), { nome: 'Açailândia', compartilhada: false }, 'o campo só manda na conta dividida');
  });

  it('conta dividida: o campo manda (com a grafia do grupo); vazio = escolher; valor que ninguém usa aparece como está', () => {
    assert.deepEqual(unidadeDoPainel(GRUPO, 'Petrópolis', 'CAXIAS'), { nome: 'Caxias', compartilhada: true, opcoes: ['Petrópolis', 'Caxias'] });
    assert.deepEqual(unidadeDoPainel(GRUPO, 'Petrópolis', 'petropolis'), { nome: 'Petrópolis', compartilhada: true, opcoes: ['Petrópolis', 'Caxias'] });
    assert.deepEqual(unidadeDoPainel(GRUPO, 'Petrópolis', null), { nome: null, compartilhada: true, opcoes: ['Petrópolis', 'Caxias'] });
    assert.equal(unidadeDoPainel(GRUPO, 'Petrópolis', 'Teresópolis').nome, 'Teresópolis');
  });

  it('o nome curto: sem "Doutor Hérnia"; "Comercial" (o nome da Imperatriz no banco) cai no slug', () => {
    assert.equal(nomeCurtoDaUnidade('Doutor Hérnia Açailândia', 'doutor-hernia-acailandia'), 'Açailândia');
    assert.equal(nomeCurtoDaUnidade('Doutor Hernia Rio Verde', 'doutor-hernia-rioverde'), 'Rio Verde');
    assert.equal(nomeCurtoDaUnidade('Comercial', 'doutor-hernia-imperatriz'), 'Imperatriz');
    assert.equal(nomeCurtoDaUnidade(null, 'doutor-hernia-boa-vista'), 'Boa Vista');
    assert.equal(nomeCurtoDaUnidade('Instituto Trauma', 'default'), 'Instituto Trauma');
  });
});

describe('o cartão anda sozinho atrás da franquia? (franquia-move E franquia-sync ligados, da unidade DO CARTÃO)', () => {
  beforeEach(() => _semearParaTeste([]));

  it('a unidade do cartão: a própria; na conta dividida, a do campo; campo vazio = nenhuma', () => {
    assert.equal(slugDaUnidadeDoCartao(null, PETRO, null), 'doutor-hernia-petropolis');
    assert.equal(slugDaUnidadeDoCartao(GRUPO, PETRO, 'Caxias'), 'doutor-hernia-caxias');
    assert.equal(slugDaUnidadeDoCartao(GRUPO, PETRO, null), null);
    assert.equal(slugDaUnidadeDoCartao(GRUPO, PETRO, 'Teresópolis'), null);
    const semSlug: GrupoDoCrm = { contaUnitId: 'u-petro', membros: [{ unitId: 'u-petro', contaUnitId: 'u-petro', rotulo: 'Petrópolis' }] };
    assert.equal(slugDaUnidadeDoCartao(semSlug, PETRO, 'Petrópolis'), 'doutor-hernia-petropolis');
  });

  it('as DUAS ligadas na tela: sim; uma só, "só no papel" ou desligada: não', () => {
    const s = 'doutor-hernia-acailandia';
    _semearParaTeste([{ slug: s, automacao: 'franquia-move', estado: 'ligado' }, { slug: s, automacao: 'franquia-sync', estado: 'ligado' }]);
    assert.equal(franquiaAndaSozinha(s, {}), true);
    _semearParaTeste([{ slug: s, automacao: 'franquia-move', estado: 'seco' }, { slug: s, automacao: 'franquia-sync', estado: 'ligado' }]);
    assert.equal(franquiaAndaSozinha(s, {}), false, 'em seco nada se move de verdade');
    _semearParaTeste([{ slug: s, automacao: 'franquia-move', estado: 'ligado' }, { slug: s, automacao: 'franquia-sync', estado: 'desligado' }]);
    assert.equal(franquiaAndaSozinha(s, {}), false);
    _semearParaTeste([{ slug: s, automacao: 'franquia-move', estado: 'ligado' }]);
    assert.equal(franquiaAndaSozinha(s, {}), false, 'o sync sem linha na tela e fora do .env = desligado');
  });

  it('sem nada na tela, vale o .env de sempre; sem unidade do cartão, nunca', () => {
    const s = 'doutor-hernia-serra';
    assert.equal(franquiaAndaSozinha(s, { FRANQUIA_MOVE_SLUGS: 'doutor-hernia-serra', FRANQUIA_SYNC_SLUGS: '*' }), true);
    assert.equal(franquiaAndaSozinha(s, { FRANQUIA_MOVE_SLUGS: 'doutor-hernia-serra' }), false);
    assert.equal(franquiaAndaSozinha(null, { FRANQUIA_MOVE_SLUGS: '*', FRANQUIA_SYNC_SLUGS: '*' }), false);
  });
});

describe('a qualificação do cartão', () => {
  const DEFS = [
    { id: 10, name: '## QUALIFICAÇÃO', type: 'text' },
    { id: 2449912, name: '★ Qualificação (Quente/Morno/Frio)', type: 'select', enums: [{ id: 1, value: 'Quente' }] },
  ];

  it('com os campos da conta: o valor; vazio = null; a conta sem o campo = undefined; cabeçalho nunca', () => {
    assert.equal(qualificacaoDoCartao(DEFS, [{ field_id: 2449912, field_name: '★ Qualificação (Quente/Morno/Frio)', values: [{ value: 'Quente' }] }]), 'Quente');
    assert.equal(qualificacaoDoCartao(DEFS, []), null);
    assert.equal(qualificacaoDoCartao(DEFS, [{ field_id: 10, field_name: '## QUALIFICAÇÃO', values: [{ value: 'x' }] }]), null);
    assert.equal(qualificacaoDoCartao([{ id: 1, name: '✎ Queixa', type: 'text' }], []), undefined);
  });

  it('sem os campos da conta (o Kommo não respondeu): o valor do cartão, ou undefined — nunca um "vazio" que não se sabe', () => {
    assert.equal(qualificacaoDoCartao([], [{ field_id: 2449912, field_name: '★ Qualificação (Quente/Morno/Frio)', values: [{ value: 'Morno' }] }]), 'Morno');
    assert.equal(qualificacaoDoCartao([], []), undefined);
  });
});

describe('telefone, a Sofia, a trilha do TRATAMENTO e o tempo na etapa', () => {
  it('o telefone para mostrar: o do contato primeiro; põe o 55; lixo não vira número', () => {
    assert.equal(telefoneDoPainel('+55 (99) 90000-0001', '5599911112222'), '(99) 90000-0001');
    assert.equal(telefoneDoPainel(null, '5599911112222'), '(99) 91111-2222');
    assert.equal(telefoneDoPainel('99 90000-0001'), '(99) 90000-0001');
    assert.equal(telefoneDoPainel('123', null, undefined), null);
  });

  it('Sofia na unidade: entrega + chave do modelo do provedor; desativada não', () => {
    const base = { isActive: true, llmProvider: 'anthropic', anthropicApiKey: 'sk-ant', googleApiKey: null, openaiApiKey: null, kommoReplyFieldId: 1, kommoWidgetReplyEnabled: false, kommoBypassSalesbot: false };
    assert.equal(sofiaNaUnidade(base, undefined), true);
    assert.equal(sofiaNaUnidade({ ...base, kommoReplyFieldId: null }, undefined), false, 'sem caminho de entrega');
    assert.equal(sofiaNaUnidade({ ...base, kommoReplyFieldId: null, kommoWidgetReplyEnabled: true }, undefined), true, 'o modo widget também entrega');
    assert.equal(sofiaNaUnidade({ ...base, anthropicApiKey: null }, undefined), false);
    assert.equal(sofiaNaUnidade({ ...base, llmProvider: 'google', googleApiKey: 'g' }, undefined), true);
    assert.equal(sofiaNaUnidade({ ...base, llmProvider: 'openai', anthropicApiKey: null }, 'sk-env'), true, 'openai usa a chave do ambiente');
    assert.equal(sofiaNaUnidade({ ...base, isActive: false }, undefined), false);
  });

  it('a trilha do TRATAMENTO só com o cartão nele (o 142 é a ALTA desse funil)', () => {
    const funis = [
      { id: 1, name: 'COMERCIAL', statuses: [{ id: 11, name: 'AGENDADO', sort: 10 }, { id: 142, name: 'GANHO', sort: 10000 }] },
      { id: 2, name: 'TRATAMENTO', statuses: [{ id: 21, name: 'Etapa de leads de entrada', sort: 1, type: 1 }, { id: 22, name: 'EM TRATAMENTO', sort: 20 }, { id: 142, name: 'ALTA', sort: 10000 }, { id: 143, name: 'TRATAMENTO CANCELADO', sort: 11000 }] },
    ];
    assert.deepEqual(barraDoTratamento(funis, { pipeline_id: 2, status_id: 22 }), {
      funil: 'TRATAMENTO',
      noFunil: true,
      etapas: [{ id: 22, nome: 'EM TRATAMENTO', atual: true }, { id: 142, nome: 'ALTA', atual: false }, { id: 143, nome: 'TRATAMENTO CANCELADO', atual: false }],
    });
    assert.equal(barraDoTratamento(funis, { pipeline_id: 1, status_id: 11 }), null);
    assert.equal(barraDoTratamento([{ ...funis[1], is_archive: true }], { pipeline_id: 2, status_id: 22 }), null);
  });

  it('o tempo na etapa vai como ISO', () => {
    assert.equal(desdeEmIso(1_792_000_000), new Date(1_792_000_000_000).toISOString());
    assert.equal(desdeEmIso(null), null);
    assert.equal(desdeEmIso(0), null);
  });
});
