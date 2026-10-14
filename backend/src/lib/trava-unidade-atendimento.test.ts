/**
 * Trava da unidade de atendimento (14/10/2026): a conta de Petrópolis atende Petrópolis e Caxias, mas só tem o
 * token da franquia de Petrópolis. Cartão de Caxias, ou sem cidade, não escreve na franquia; as outras unidades
 * não mudam nada — nem uma leitura a mais no Kommo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import type { KommoLead } from '../services/kommo.service.js';
import { REGRAS_POR_UNIDADE } from './unidade-por-canal.js';
import { regrasDaUnidade, travaDaUnidadeDeAtendimento, travaPeloCampo, unidadeNoCartao } from './trava-unidade-atendimento.js';

const PETRO = 'doutor-hernia-petropolis';
const REGRAS = REGRAS_POR_UNIDADE[PETRO];
const MSG_CAXIAS = 'Este paciente é de Caxias. Marque na agenda de Caxias. A marcação pelo widget para Caxias chega na próxima atualização.';
const MSG_VAZIO = 'Escolha a unidade de atendimento do cartão (Petrópolis ou Caxias) antes de marcar ou cadastrar.';

const cartao = (unidade: string | null, id = 1): KommoLead => ({
  id,
  name: 'Paciente Teste',
  status_id: 1,
  pipeline_id: 1,
  custom_fields_values: [
    { field_id: 264810, field_name: '⌂ Unidade', values: [{ value: 'texto antigo que não conta' }] },
    ...(unidade === null ? [] : [{ field_id: 479786, field_name: '⌂ Unidade de atendimento', values: [{ value: unidade }] }]),
  ],
});

function kommoFalso(lead: KommoLead | Error) {
  const lidos: number[] = [];
  return {
    lidos,
    kommo: {
      getLead: async (id: number) => {
        lidos.push(id);
        if (lead instanceof Error) throw lead;
        return lead;
      },
    },
  };
}

const unidade = (slug: string): Unit => ({ id: 'u1', slug, kommoAccessToken: 'tok' }) as Unit;

test('trava: só a conta com unidade de atendimento tem regra (hoje Petrópolis)', () => {
  assert.equal(regrasDaUnidade(PETRO), REGRAS);
  assert.equal(regrasDaUnidade('doutor-hernia-serra'), null);
  assert.equal(regrasDaUnidade('constructor'), null, 'nome de propriedade do objeto não vira regra');
  assert.equal(regrasDaUnidade(null), null);
});

test('trava: cartão de Caxias recusa com a frase combinada; Petrópolis segue', () => {
  const t = travaPeloCampo(REGRAS, 'Caxias');
  assert.equal(t?.codigo, 'unidade_de_outra_cidade');
  assert.equal(t?.motivo, MSG_CAXIAS);
  assert.match(t?.paraIa ?? '', /^RECUSADO: este paciente é de Caxias/);
  assert.equal(travaPeloCampo(REGRAS, 'Petrópolis'), null);
  assert.equal(travaPeloCampo(REGRAS, '  petropolis '), null, 'acento e caixa não separam a mesma cidade');
});

test('trava: campo vazio recusa e pede para escolher a unidade', () => {
  for (const vazio of [null, '', '   ']) {
    const t = travaPeloCampo(REGRAS, vazio);
    assert.equal(t?.codigo, 'unidade_vazia');
    assert.equal(t?.motivo, MSG_VAZIO);
  }
});

test('trava: unidade comum nunca trava, com o campo que for', () => {
  assert.equal(travaPeloCampo(null, 'Caxias'), null);
  assert.equal(travaPeloCampo(null, null), null);
});

test('trava: lê o campo pelo nome, não pelo "⌂ Unidade" antigo', () => {
  assert.equal(unidadeNoCartao(cartao('Caxias')), 'Caxias');
  assert.equal(unidadeNoCartao(cartao(null)), null);
  assert.equal(unidadeNoCartao({ custom_fields_values: null }), null);
});

test('trava no cartão: unidade comum não lê o Kommo', async () => {
  const { kommo, lidos } = kommoFalso(cartao('Caxias'));
  assert.equal(await travaDaUnidadeDeAtendimento(unidade('doutor-hernia-serra'), 10, kommo), null);
  assert.deepEqual(lidos, [], 'nenhuma chamada a mais nas outras unidades');
});

test('trava no cartão: Petrópolis lê o cartão — Caxias e vazio recusam, Petrópolis segue', async () => {
  const caxias = kommoFalso(cartao('Caxias'));
  assert.equal((await travaDaUnidadeDeAtendimento(unidade(PETRO), 10, caxias.kommo))?.motivo, MSG_CAXIAS);
  assert.deepEqual(caxias.lidos, [10]);

  const vazio = kommoFalso(cartao(null));
  assert.equal((await travaDaUnidadeDeAtendimento(unidade(PETRO), 11, vazio.kommo))?.motivo, MSG_VAZIO);

  const petro = kommoFalso(cartao('Petrópolis'));
  assert.equal(await travaDaUnidadeDeAtendimento(unidade(PETRO), 12, petro.kommo), null);
});

test('trava no cartão: sem cartão ou Kommo fora, recusa (trava que falha aberta não é trava)', async () => {
  const fora = kommoFalso(new Error('Kommo 503'));
  assert.equal((await travaDaUnidadeDeAtendimento(unidade(PETRO), 10, fora.kommo))?.codigo, 'unidade_ilegivel');

  const semLead = kommoFalso(cartao('Petrópolis'));
  assert.equal((await travaDaUnidadeDeAtendimento(unidade(PETRO), undefined, semLead.kommo))?.codigo, 'unidade_ilegivel');
  assert.deepEqual(semLead.lidos, [], 'sem lead não há o que ler');
});
