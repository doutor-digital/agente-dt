import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';
import { KommoClient } from '../services/kommo.service.js';
import {
  MAX_CARTOES_DUPLICADOS,
  cartaoAberto,
  cartoesDuplicados,
  contatoPrincipal,
  etapaFinal,
  mesmoTelefoneCompleto,
  origemDoCartao,
  telefoneCompleto,
  type CartaoDoPaciente,
} from './ponte-duplicados.js';

const ETAPAS: Record<number, string> = { 40: 'EM ESPERA', 50: 'EM QUALIFICAÇÃO', 60: 'EM TRATAMENTO', 70: 'ALTA', 80: 'NÃO COMPARECEU', 142: 'GANHO', 143: 'PERDIDO' };
const nomes = (l: { pipeline_id: number; status_id: number }) => ({ funil: l.pipeline_id === 1 ? 'COMERCIAL' : 'TRATAMENTO', etapa: ETAPAS[l.status_id] ?? `etapa ${l.status_id}` });
const link = (id: number) => `https://x.kommo.com/leads/detail/${id}`;
/** O paciente da tela é o contato 9; o contato 77 tem o mesmo número (pode ser da família). */
const QUEM = { contato: 9, doMesmoTelefone: new Set([77]) };
const ATUAL = { id: 123, status_id: 40, pipeline_id: 1 };
const cartao = (id: number, status_id: number, extra: Partial<CartaoDoPaciente> = {}, principal = 9): CartaoDoPaciente => ({
  id,
  name: `Cartão ${id}`,
  status_id,
  pipeline_id: 1,
  updated_at: id,
  _embedded: { contacts: [{ id: principal, is_main: true }] },
  ...extra,
});

describe('duplicado — o mesmo telefone completo', () => {
  it('com e sem o 55, com e sem o nono dígito: é o mesmo', () => {
    assert.ok(mesmoTelefoneCompleto('+55 99 90000-0043', '99900000043'));
    assert.ok(mesmoTelefoneCompleto('5599900000043', '(99) 0000-0043'));
  });

  it('mesmo final em outro DDD não é; número sem DDD não diz "mesma pessoa"', () => {
    assert.equal(mesmoTelefoneCompleto('99900000043', '11900000043'), false);
    assert.equal(mesmoTelefoneCompleto('99900000043', '900000043'), false);
    assert.equal(mesmoTelefoneCompleto('00000043', '00000043'), false);
    assert.equal(telefoneCompleto('900000043'), false);
    assert.equal(telefoneCompleto('+55 99 90000-0043'), true);
    assert.equal(mesmoTelefoneCompleto(null, null), false);
  });
});

describe('duplicado — quais cartões avisar', () => {
  it('dois abertos do mesmo contato principal: avisa o outro, com funil/etapa, ⚑ Origem, link e via "contato"', () => {
    const outro = cartao(456, 50, { custom_fields_values: [{ field_name: '⚑ Origem', values: [{ value: 'Meta-Instagram' }] }] });
    assert.deepEqual(cartoesDuplicados(ATUAL, [outro], QUEM, nomes, link), [
      { id: 456, nome: 'Cartão 456', funil: 'COMERCIAL', etapa: 'EM QUALIFICAÇÃO', origem: 'Meta-Instagram', link: 'https://x.kommo.com/leads/detail/456', via: 'contato' },
    ]);
  });

  it('o paciente só como contato SECUNDÁRIO do outro cartão (a mãe que acompanha a filha) não conta', () => {
    const daFilha = cartao(456, 50, { _embedded: { contacts: [{ id: 31, is_main: true }, { id: 9, is_main: false }] } });
    assert.deepEqual(cartoesDuplicados(ATUAL, [daFilha], QUEM, nomes, link), []);
  });

  it('outro contato com o mesmo número vem com via "telefone" (o painel mostra com cautela)', () => {
    const r = cartoesDuplicados(ATUAL, [cartao(456, 50, {}, 77)], QUEM, nomes, link);
    assert.deepEqual(r.map((d) => [d.id, d.via]), [[456, 'telefone']]);
  });

  it('fechado (GANHO/PERDIDO) ou etapa final pelo nome (ALTA do TRATAMENTO) + um aberto não é duplicado', () => {
    assert.deepEqual(cartoesDuplicados({ ...ATUAL, status_id: 142 }, [cartao(456, 50)], QUEM, nomes, link), []);
    assert.deepEqual(cartoesDuplicados(ATUAL, [cartao(456, 143), cartao(789, 142)], QUEM, nomes, link), []);
    assert.deepEqual(cartoesDuplicados(ATUAL, [cartao(456, 70, { pipeline_id: 2 })], QUEM, nomes, link), [], 'TRATAMENTO › ALTA não é aberto');
    assert.deepEqual(cartoesDuplicados({ id: 123, status_id: 70, pipeline_id: 2 }, [cartao(456, 50)], QUEM, nomes, link), [], 'o da tela em ALTA também não');
  });

  it('o da tela fechado, mas dois abertos em outros cartões: avisa os dois (qualquer funil), mais mexido primeiro', () => {
    const r = cartoesDuplicados({ ...ATUAL, status_id: 142 }, [cartao(456, 50), cartao(789, 60, { pipeline_id: 2 })], QUEM, nomes, link);
    assert.deepEqual(r.map((d) => [d.id, d.funil]), [[789, 'TRATAMENTO'], [456, 'COMERCIAL']]);
  });

  it('o próprio cartão e repetidos não entram; corta no máximo', () => {
    const muitos = Array.from({ length: 30 }, (_, i) => cartao(1000 + i, 50));
    const r = cartoesDuplicados(ATUAL, [cartao(123, 40), cartao(456, 50), cartao(456, 50), ...muitos], QUEM, nomes, link);
    assert.equal(r.length, MAX_CARTOES_DUPLICADOS);
    assert.ok(!r.some((d) => d.id === 123));
    assert.equal(new Set(r.map((d) => d.id)).size, r.length);
  });

  it('etapa final pelo nome: palavra inteira ("FALTOU" não é "alta")', () => {
    for (const nome of ['ALTA', 'TRATAMENTO CANCELADO', 'GANHO / CONCLUÍDO', 'Finalizado', 'ENCERRADO']) assert.equal(etapaFinal(nome), true, nome);
    for (const nome of ['FALTOU', 'EM TRATAMENTO', 'RETORNO PÓS-TRATAMENTO', 'NÃO COMPARECEU', '', null]) assert.equal(etapaFinal(nome), false, String(nome));
  });

  it('aberto = fora de 142 e 143 e de etapa final; origem vazia vira null; contato principal', () => {
    assert.equal(cartaoAberto({ status_id: 142 }), false);
    assert.equal(cartaoAberto({ status_id: 50 }), true);
    assert.equal(cartaoAberto({ status_id: 50 }, 'ALTA'), false);
    assert.equal(origemDoCartao({ custom_fields_values: [{ field_name: '⚑ Origem', values: [{ value: '  ' }] }] }), null);
    assert.equal(origemDoCartao({ custom_fields_values: null }), null);
    assert.equal(contatoPrincipal({ _embedded: { contacts: [{ id: 1 }, { id: 2, is_main: true }] } }), 2);
    assert.equal(contatoPrincipal({ _embedded: { contacts: [{ id: 1 }] } }), 1);
    assert.equal(contatoPrincipal({}), null);
  });
});

describe('duplicado — o contato com os cartões (uma chamada)', () => {
  it('lê nome, todos os telefones e os ids dos cartões; falha vira null (não "sem cartões")', async () => {
    const pedidos: Array<{ url: string; params: unknown }> = [];
    const http = {
      get: async (url: string, cfg: { params: unknown }) => {
        pedidos.push({ url, params: cfg.params });
        return {
          data: {
            id: 9,
            name: ' Maria Souza ',
            custom_fields_values: [{ field_code: 'PHONE', values: [{ value: '+5599900000043' }, { value: ' 9900000043 ' }] }],
            _embedded: { leads: [{ id: 123 }, { id: 456 }] },
          },
        };
      },
    } as unknown as AxiosInstance;
    const c = await new KommoClient({ subdomain: 't', accessToken: 't' } as never, http).contatoComCartoes(9);
    assert.deepEqual(c, { id: 9, nome: 'Maria Souza', telefone: '+5599900000043', telefones: ['+5599900000043', '9900000043'], leadIds: [123, 456] });
    assert.deepEqual(pedidos, [{ url: '/contacts/9', params: { with: 'leads' } }]);
    const falha = { get: async () => { throw new Error('429'); } } as unknown as AxiosInstance;
    assert.equal(await new KommoClient({ subdomain: 't', accessToken: 't' } as never, falha).contatoComCartoes(9), null);
  });
});
