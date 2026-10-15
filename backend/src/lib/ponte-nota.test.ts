// Ponte 0.5.1 — "Observações": a observação da atendente vira uma NOTA comum no cartão (`lib/ponte-nota.ts`).
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';
import { KommoApiError, KommoClient } from '../services/kommo.service.js';
import {
  JANELA_DE_REPETICAO_MS,
  MAX_OBSERVACAO,
  dataHoraDeBrasilia,
  gravarObservacao,
  gravarObservacaoUmaVez,
  lerPedidoDeNota,
  limparObservacao,
  limparObservacoesRecentes,
  temHtml,
  textoDaNota,
  type KommoDaNota,
} from './ponte-nota.js';

// qua 15/10/2026, 15:42 em Brasília
const AGORA = new Date('2026-10-15T18:42:00.000Z');

/** Um Kommo falso: só o cartão `existe` é desta conta; guarda tudo que foi pedido. */
function kommoFalso(opcoes: { existe?: number; semId?: boolean; notaFalha?: boolean; lerFalha?: boolean } = {}) {
  const existe = opcoes.existe ?? 123;
  const chamadas: unknown[][] = [];
  let proximo = 900;
  const k: KommoDaNota & { chamadas: unknown[][]; notas(): unknown[][] } = {
    chamadas,
    notas: () => chamadas.filter((c) => c[0] === 'nota'),
    getLead: async (id) => {
      chamadas.push(['ler', id]);
      if (opcoes.lerFalha) throw new KommoApiError('getLead: 502', 502, {});
      // o token desta unidade não enxerga cartão de outra conta: o Kommo responde 204/404
      if (id !== existe) throw new KommoApiError('getLead: 204', 204, {});
      return { id };
    },
    addLeadNote: async (id, texto) => {
      chamadas.push(['nota', id, texto]);
      if (opcoes.notaFalha) throw new KommoApiError('addLeadNote: 502', 502, {});
      return opcoes.semId ? null : { id: proximo++ };
    },
  };
  return k;
}

const pedido = (texto = 'Prefere ligação depois das 17h.', extra: Partial<{ leadId: number; por: string | null }> = {}) => ({ leadId: 123, texto, por: 'Ana', ...extra });

beforeEach(() => limparObservacoesRecentes());

describe('observação — o pedido', () => {
  it('lê leadId, texto e por; o texto mantém as quebras de linha e perde o controle', () => {
    const r = lerPedidoDeNota({ leadId: '123', texto: '  Mãe acompanha.\r\n\r\n\r\n\tPrefere tarde.\u0007  ', por: '  Ana  ' });
    assert.deepEqual(r, { ok: true, pedido: { leadId: 123, texto: 'Mãe acompanha.\n\n Prefere tarde.', por: 'Ana' } });
  });

  it('recusa sem lead, sem texto, só espaço, longo demais e com HTML — nada vai para o Kommo', () => {
    assert.deepEqual(lerPedidoDeNota({ texto: 'oi' }), { ok: false, erro: 'lead inválido' });
    assert.deepEqual(lerPedidoDeNota({ leadId: 1 }), { ok: false, erro: 'escreva a observação' });
    assert.deepEqual(lerPedidoDeNota({ leadId: 1, texto: ' \n\t ' }), { ok: false, erro: 'escreva a observação' });
    assert.deepEqual(lerPedidoDeNota({ leadId: 1, texto: 42 }), { ok: false, erro: 'escreva a observação' });
    const longo = lerPedidoDeNota({ leadId: 1, texto: 'a'.repeat(MAX_OBSERVACAO + 1) });
    assert.ok(!longo.ok && /passa de 2000 letras/.test(longo.erro));
    assert.ok(lerPedidoDeNota({ leadId: 1, texto: 'a'.repeat(MAX_OBSERVACAO) }).ok, 'exatamente o limite passa');
    for (const t of ['<b>urgente</b>', 'linha<br>outra', '<img src=x onerror=alert(1)>', 'oi <!-- x -->', '<script>alert(1)</script>']) {
      const r = lerPedidoDeNota({ leadId: 1, texto: t });
      assert.ok(!r.ok && /HTML/.test(r.erro), t);
    }
  });

  it('HTML é tag de verdade: "dor < 5 e > 2" e "a<b" não são', () => {
    assert.equal(temHtml('dor < 5 e > 2'), false);
    assert.equal(temHtml('a<b'), false);
    assert.equal(temHtml('3 <> 4'), false);
    assert.equal(temHtml('<p>'), true);
    assert.equal(temHtml('</div>'), true);
    assert.equal(temHtml('<br/>'), true);
  });

  it('o nome de quem escreveu nunca vira tag; sem nome, "extensão Ponte"', () => {
    const r = lerPedidoDeNota({ leadId: 1, texto: 'x', por: '<b>Ana</b>' });
    assert.ok(r.ok && r.pedido.por === 'bAna/b');
    const s = lerPedidoDeNota({ leadId: 1, texto: 'x' });
    assert.ok(s.ok && s.pedido.por === null);
    assert.match(textoDaNota({ texto: 'x', por: null }, AGORA), /^Observação pela Ponte · extensão Ponte · /);
  });

  it('limparObservacao: no máximo uma linha em branco seguida', () => {
    assert.equal(limparObservacao('a\n\n\n\nb'), 'a\n\nb');
    assert.equal(limparObservacao('a   \nb'), 'a\nb');
  });
});

describe('observação — o texto da nota', () => {
  it('"Observação pela Ponte · <nome> · <data/hora de Brasília>:" e o texto embaixo', () => {
    assert.equal(dataHoraDeBrasilia(AGORA), '15/10/2026 15:42');
    assert.equal(textoDaNota(pedido(), AGORA), 'Observação pela Ponte · Ana · 15/10/2026 15:42:\nPrefere ligação depois das 17h.');
  });

  it('a hora é a de Brasília, não a do servidor nem a UTC (virada do dia)', () => {
    // 02:30 UTC de 16/10 = 23:30 de 15/10 em Brasília
    assert.equal(dataHoraDeBrasilia(new Date('2026-10-16T02:30:00.000Z')), '15/10/2026 23:30');
  });
});

describe('observação — com o Kommo', () => {
  it('lê o cartão com o token da unidade e grava UMA nota comum com o texto', async () => {
    const k = kommoFalso();
    const r = await gravarObservacao(k, pedido(), AGORA);
    assert.deepEqual(r, { ok: true, leadId: 123, notaId: 900 });
    assert.deepEqual(k.chamadas, [['ler', 123], ['nota', 123, 'Observação pela Ponte · Ana · 15/10/2026 15:42:\nPrefere ligação depois das 17h.']]);
  });

  it('cartão de OUTRA conta (o token desta unidade não vê) ou apagado: 404 e nenhuma nota', async () => {
    const k = kommoFalso({ existe: 999 });
    const r = await gravarObservacao(k, pedido(), AGORA);
    assert.deepEqual(r, { ok: false, status: 404, erro: 'cartão não encontrado no Kommo desta unidade' });
    assert.deepEqual(k.notas(), []);
  });

  it('o Kommo fora na leitura: lança (vira 502 na rota) e nenhuma nota', async () => {
    const k = kommoFalso({ lerFalha: true });
    await assert.rejects(gravarObservacao(k, pedido(), AGORA));
    assert.deepEqual(k.notas(), []);
  });

  it('o Kommo não devolveu o id da nota: erro que manda conferir antes de tentar de novo', async () => {
    const r = await gravarObservacao(kommoFalso({ semId: true }), pedido(), AGORA);
    assert.ok(!r.ok && r.status === 502 && /confira no cartão antes de tentar de novo/.test(r.erro));
  });

  it('a nota vai pelo `addLeadNote` de sempre: POST /leads/{id}/notes, nota comum', async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const http = {
      post: async (url: string, body: unknown) => { posts.push({ url, body }); return { data: { _embedded: { notes: [{ id: 77 }] } } }; },
    } as unknown as AxiosInstance;
    const cliente = new KommoClient({ subdomain: 'teste', accessToken: 't' } as never, http);
    assert.deepEqual(await cliente.addLeadNote(123, textoDaNota(pedido(), AGORA)), { id: 77 });
    assert.deepEqual(posts, [{ url: '/leads/123/notes', body: [{ note_type: 'common', params: { text: 'Observação pela Ponte · Ana · 15/10/2026 15:42:\nPrefere ligação depois das 17h.' } }] }]);
  });
});

describe('observação — uma nota por observação', () => {
  it('clique duplo (dois pedidos juntos) e o clique de novo logo depois: uma nota só', async () => {
    const k = kommoFalso();
    const [a, b] = await Promise.all([gravarObservacaoUmaVez('conta', k, pedido(), AGORA), gravarObservacaoUmaVez('conta', k, pedido(), AGORA)]);
    const c = await gravarObservacaoUmaVez('conta', k, pedido(), new Date(AGORA.getTime() + 30_000));
    assert.equal(k.notas().length, 1);
    assert.ok(a.ok && b.ok && c.ok);
    assert.equal(a.ok && a.notaId, 900);
    assert.equal(b.ok && b.notaId, 900);
    assert.equal(c.ok && c.repetido, true);
  });

  it('texto diferente, outro cartão ou passada a janela: grava de novo', async () => {
    const k = kommoFalso();
    await gravarObservacaoUmaVez('conta', k, pedido('primeira'), AGORA);
    await gravarObservacaoUmaVez('conta', k, pedido('segunda'), AGORA);
    await gravarObservacaoUmaVez('conta', k, pedido('primeira'), new Date(AGORA.getTime() + JANELA_DE_REPETICAO_MS + 1));
    assert.equal(k.notas().length, 3);
  });

  it('a primeira falhou: a próxima tenta de verdade', async () => {
    const falha = kommoFalso({ notaFalha: true });
    await assert.rejects(gravarObservacaoUmaVez('conta', falha, pedido(), AGORA));
    const ok = kommoFalso();
    const r = await gravarObservacaoUmaVez('conta', ok, pedido(), AGORA);
    assert.ok(r.ok && !r.repetido);
    assert.equal(ok.notas().length, 1);
  });
});
