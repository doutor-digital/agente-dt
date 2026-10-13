import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PAUSA_LEAD_MAX_DIAS, POR_PADRAO, leadIdDoPedido, lerPedidoDePausa, lerPedidoDeRetomada, textoCurto } from './ponte-pausa.js';

const agora = new Date('2026-10-13T17:30:00.000Z');
const emHoras = (h: number) => new Date(agora.getTime() + h * 3_600_000).toISOString();

// O mesmo `pausa.js` que a extensão carrega: as opções do painel têm de passar pela regra do servidor.
const EXTENSAO = new URL('../../../extensao-ponte/', import.meta.url);
const daExtensao = createRequire(import.meta.url)(new URL('pausa.js', EXTENSAO).pathname) as {
  MAX_DIAS: number;
  OPCOES: Array<{ id: string }>;
  fimDaPausa(opcao: string, agora: Date, data?: string): { ate?: Date; erro?: string };
  dataMaxima(agora: Date): string;
};

describe('pausa pela Ponte — o pedido', () => {
  it('pedido certo: lead, data, motivo e quem', () => {
    const r = lerPedidoDePausa({ leadId: 123, ate: emHoras(24), motivo: ' reunião\ncom a família ', por: ' Ana ' }, agora);
    assert.ok(r.ok);
    assert.deepEqual(r.pedido, { leadId: 123, ate: new Date(emHoras(24)), motivo: 'reunião com a família', por: 'Ana' });
  });

  it('lead em texto de dígitos vale; lixo não', () => {
    assert.equal(leadIdDoPedido('123'), 123);
    for (const ruim of [0, -1, 1.5, 'abc', '12a', null, undefined, {}]) assert.equal(leadIdDoPedido(ruim), null, String(ruim));
    const r = lerPedidoDePausa({ leadId: 'x', ate: emHoras(1) }, agora);
    assert.deepEqual(r, { ok: false, erro: 'lead inválido' });
  });

  it('as regras de sempre (validarPausaDoLead): futuro e no máximo 30 dias', () => {
    assert.match((lerPedidoDePausa({ leadId: 1, ate: emHoras(-1) }, agora) as { erro: string }).erro, /futuro/);
    assert.match((lerPedidoDePausa({ leadId: 1, ate: 'amanhã' }, agora) as { erro: string }).erro, /inválida/);
    assert.match((lerPedidoDePausa({ leadId: 1 }, agora) as { erro: string }).erro, /inválida/);
    assert.ok(lerPedidoDePausa({ leadId: 1, ate: emHoras(PAUSA_LEAD_MAX_DIAS * 24) }, agora).ok, 'o limite exato passa');
    assert.match((lerPedidoDePausa({ leadId: 1, ate: emHoras(PAUSA_LEAD_MAX_DIAS * 24 + 1) }, agora) as { erro: string }).erro, /30 dias/);
  });

  it('motivo e nome: uma linha, sem caractere de controle, com teto; vazio vira null', () => {
    assert.equal(textoCurto('a\u0000b\tc', 10), 'a b c');
    assert.equal(textoCurto('x'.repeat(300), 200)?.length, 200);
    assert.equal(textoCurto('   ', 10), null);
    assert.equal(textoCurto(42, 10), null);
    const r = lerPedidoDePausa({ leadId: 1, ate: emHoras(2), motivo: '', por: '' }, agora);
    assert.ok(r.ok && r.pedido.motivo === null && r.pedido.por === null);
    assert.equal(POR_PADRAO, 'extensão Ponte');
  });

  it('retomar: só o lead e quem', () => {
    assert.deepEqual(lerPedidoDeRetomada({ leadId: '55', por: 'Ana' }), { ok: true, pedido: { leadId: 55, por: 'Ana' } });
    assert.deepEqual(lerPedidoDeRetomada({}), { ok: false, erro: 'lead inválido' });
    assert.deepEqual(lerPedidoDeRetomada(null), { ok: false, erro: 'lead inválido' });
  });
});

describe('pausa pela Ponte — as opções do painel passam pela regra do servidor', () => {
  it('o limite da extensão é o mesmo do servidor', () => {
    assert.equal(daExtensao.MAX_DIAS, PAUSA_LEAD_MAX_DIAS);
  });

  it('amanhã 8h, 3 dias, 1 semana e a data máxima são aceitas', () => {
    for (const o of ['amanha8', '3dias', '1semana']) {
      const fim = daExtensao.fimDaPausa(o, agora);
      assert.ok(fim.ate, o);
      assert.ok(lerPedidoDePausa({ leadId: 1, ate: fim.ate!.toISOString() }, agora).ok, o);
    }
    const max = daExtensao.fimDaPausa('data', agora, daExtensao.dataMaxima(agora));
    assert.ok(max.ate);
    assert.ok(lerPedidoDePausa({ leadId: 1, ate: max.ate!.toISOString() }, agora).ok, 'a data máxima do painel cabe no servidor');
  });
});
