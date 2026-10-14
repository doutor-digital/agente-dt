import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  PRAZOS_DA_FILA,
  candidatosSemResposta,
  contarSemResposta,
  conversaPorCartao,
  montarGrupos,
  type CartaoDoKommoNaFila,
  type ConversaDoKommo,
} from './ponte-fila.js';

// O mesmo `contador.js` que o service worker da extensão carrega.
const EXTENSAO = new URL('../../../extensao-ponte/', import.meta.url);
const daExtensao = createRequire(import.meta.url)(new URL('contador.js', EXTENSAO).pathname) as {
  badge(resposta: unknown, anterior: number | null): { texto: string; dica: string };
};

const TZ = 'America/Sao_Paulo';
const agora = new Date('2026-10-14T15:00:00.000Z');
const agoraEp = Math.floor(agora.getTime() / 1000);
const H = 3600;
const COMERCIAL = {
  id: 13795975,
  statuses: [
    { id: 106446875, name: 'Incoming leads', type: 1 },
    { id: 106809907, name: 'EM QUALIFICAÇÃO', type: 0 },
    { id: 106809915, name: 'AGENDADO', type: 0 },
  ],
};

const conversa = (leadId: number, extra: Partial<ConversaDoKommo> = {}): ConversaDoKommo => ({
  entity_id: leadId,
  entity_type: 'lead',
  is_read: false,
  is_in_work: true,
  updated_at: agoraEp - 3 * H,
  ...extra,
});

const cartao = (id: number, statusId = 106809907, pipelineId = COMERCIAL.id): CartaoDoKommoNaFila => ({
  id,
  name: `Paciente ${id}`,
  pipeline_id: pipelineId,
  status_id: statusId,
  created_at: agoraEp - 5 * 86400,
  _embedded: { contacts: [{ id: id * 10, is_main: true }] },
});

function leitores(opcoes: { conversas?: ConversaDoKommo[]; completa?: boolean; cartoes?: CartaoDoKommoNaFila[]; sofia?: Map<number, number>; conversasFalham?: boolean; cartoesFalham?: boolean } = {}) {
  return {
    conversas: async () => {
      if (opcoes.conversasFalham) throw new Error('kommo fora');
      return { conversas: opcoes.conversas ?? [], completa: opcoes.completa ?? true };
    },
    cartoes: async (ids: number[]) => {
      if (opcoes.cartoesFalham) throw new Error('kommo fora');
      return (opcoes.cartoes ?? []).filter((c) => ids.includes(c.id));
    },
    falaDaSofia: async () => opcoes.sofia ?? new Map<number, number>(),
  };
}

describe('contador do ícone (0.4.0) — o mesmo "sem resposta" da Fila de hoje', () => {
  it('conta quem a fila poria no grupo "sem resposta": não lida há mais de 2 h, sem a Sofia por último, entrada ou EM QUALIFICAÇÃO', async () => {
    const r = await contarSemResposta(
      leitores({
        conversas: [
          conversa(1), // conta
          conversa(2, { updated_at: agoraEp - 30 * 60 }), // há 30 min: ainda não
          conversa(3, { is_read: true }), // lida
          conversa(4), // a Sofia respondeu por último
          conversa(5), // AGENDADO: não é "sem resposta"
          conversa(6), // outro funil
          conversa(7, { updated_at: agoraEp - 26 * H }), // conta (entrada)
          conversa(1, { updated_at: agoraEp - 10 * H }), // conversa antiga do mesmo cartão: vale a mais nova
        ],
        cartoes: [cartao(1), cartao(2), cartao(3), cartao(4), cartao(5, 106809915), cartao(6, 1, 999), cartao(7, 106446875)],
        sofia: new Map([[4, agoraEp - 3 * H + 60]]),
      }),
      COMERCIAL,
      agora,
      TZ,
    );
    assert.deepEqual(r, { total: 2, completo: true });
  });

  it('o total é o mesmo do grupo "sem resposta" da fila (a mesma função)', async () => {
    const opcoes = { conversas: [conversa(1), conversa(7, { updated_at: agoraEp - 26 * H })], cartoes: [cartao(1), cartao(7, 106446875)] };
    const conta = await contarSemResposta(leitores(opcoes), COMERCIAL, agora, TZ);
    const { candidatos } = await candidatosSemResposta(conversaPorCartao(opcoes.conversas), COMERCIAL, leitores(opcoes), agora, TZ);
    const grupo = montarGrupos(candidatos, PRAZOS_DA_FILA).find((g) => g.def.id === 'sem-resposta');
    assert.equal(conta.total, grupo?.total);
  });

  it('Kommo fora (conversas ou cartões) ou conta sem COMERCIAL: total null — NUNCA um 0 falso', async () => {
    for (const r of [
      await contarSemResposta(leitores({ conversasFalham: true }), COMERCIAL, agora, TZ),
      await contarSemResposta(leitores({ conversas: [conversa(1)], cartoesFalham: true }), COMERCIAL, agora, TZ),
      await contarSemResposta(leitores({ conversas: [conversa(1)], cartoes: [cartao(1)] }), null, agora, TZ),
    ]) {
      assert.deepEqual(r, { total: null, completo: false });
      // e a extensão mostra "?" (nunca "0" nem vazio, que diriam "ninguém esperando")
      const b = daExtensao.badge(r, 3);
      assert.equal(b.texto, '?');
      assert.match(b.dica, /Não consegui contar/);
    }
  });

  it('leitura cortada (mais conversas do que o teto de páginas): completo falso, e 0 vira "?" na extensão', async () => {
    const r = await contarSemResposta(leitores({ conversas: [], completa: false }), COMERCIAL, agora, TZ);
    assert.deepEqual(r, { total: 0, completo: false });
    assert.equal(daExtensao.badge(r, null).texto, '?');
    const algum = await contarSemResposta(leitores({ conversas: [conversa(1)], cartoes: [cartao(1)], completa: false }), COMERCIAL, agora, TZ);
    assert.deepEqual(algum, { total: 1, completo: false });
    assert.equal(daExtensao.badge(algum, null).texto, '1+');
  });

  it('ninguém esperando (leitura completa): 0 — e a extensão deixa o ícone sem número', async () => {
    const r = await contarSemResposta(leitores({ conversas: [conversa(3, { is_read: true })], cartoes: [cartao(3)] }), COMERCIAL, agora, TZ);
    assert.deepEqual(r, { total: 0, completo: true });
    assert.equal(daExtensao.badge(r, 2).texto, '');
  });
});
