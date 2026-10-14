import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';
import { KommoClient } from '../services/kommo.service.js';
import { MAX_CARTOES_DUPLICADOS, cartaoAberto, cartoesDuplicados, mesmoTelefoneCompleto, origemDoCartao, telefoneCompleto, type CartaoDoPaciente } from './ponte-duplicados.js';

const nomes = (l: { pipeline_id: number; status_id: number }) => ({ funil: l.pipeline_id === 1 ? 'COMERCIAL' : 'TRATAMENTO', etapa: `etapa ${l.status_id}` });
const link = (id: number) => `https://x.kommo.com/leads/detail/${id}`;
const cartao = (id: number, status_id: number, extra: Partial<CartaoDoPaciente> = {}): CartaoDoPaciente => ({
  id,
  name: `Cartão ${id}`,
  status_id,
  pipeline_id: 1,
  updated_at: id,
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
  it('dois abertos (o da tela e outro): avisa o outro, com funil/etapa, ⚑ Origem e o link', () => {
    const outro = cartao(456, 50, { custom_fields_values: [{ field_name: '⚑ Origem', values: [{ value: 'Meta-Instagram' }] }] });
    assert.deepEqual(cartoesDuplicados(cartao(123, 40), [outro], nomes, link), [
      { id: 456, nome: 'Cartão 456', funil: 'COMERCIAL', etapa: 'etapa 50', origem: 'Meta-Instagram', link: 'https://x.kommo.com/leads/detail/456' },
    ]);
  });

  it('fechado (GANHO/PERDIDO) + um aberto é o paciente que voltou, não duplicado', () => {
    assert.deepEqual(cartoesDuplicados(cartao(123, 142), [cartao(456, 50)], nomes, link), []);
    assert.deepEqual(cartoesDuplicados(cartao(123, 40), [cartao(456, 143), cartao(789, 142)], nomes, link), []);
  });

  it('o da tela fechado, mas dois abertos em outros cartões: avisa os dois (qualquer funil)', () => {
    const r = cartoesDuplicados(cartao(123, 142), [cartao(456, 50), cartao(789, 60, { pipeline_id: 2 })], nomes, link);
    assert.deepEqual(r.map((d) => [d.id, d.funil]), [[789, 'TRATAMENTO'], [456, 'COMERCIAL']], 'mais mexido primeiro');
  });

  it('o próprio cartão e repetidos não entram; corta no máximo', () => {
    const muitos = Array.from({ length: 30 }, (_, i) => cartao(1000 + i, 50));
    const r = cartoesDuplicados(cartao(123, 40), [cartao(123, 40), cartao(456, 50), cartao(456, 50), ...muitos], nomes, link);
    assert.equal(r.length, MAX_CARTOES_DUPLICADOS);
    assert.ok(!r.some((d) => d.id === 123));
    assert.equal(new Set(r.map((d) => d.id)).size, r.length);
  });

  it('aberto = fora de 142 e 143; origem vazia vira null', () => {
    assert.equal(cartaoAberto({ status_id: 142 }), false);
    assert.equal(cartaoAberto({ status_id: 50 }), true);
    assert.equal(origemDoCartao({ custom_fields_values: [{ field_name: '⚑ Origem', values: [{ value: '  ' }] }] }), null);
    assert.equal(origemDoCartao({ custom_fields_values: null }), null);
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
