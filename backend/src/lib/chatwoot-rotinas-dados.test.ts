/** Os fatos do banco para os alertas da Sofia: agrupados por conversa, só da janela, falas da mais recente para a mais antiga. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { fatosDoBanco } = await import('./chatwoot-rotinas-dados.js');

test('fatosDoBanco: agrupa por conversa, pede só as 24 h da unidade e ordena as falas da mais recente para a mais antiga', async () => {
  const agora = new Date('2026-11-16T12:00:00Z');
  const pedidos: Array<{ slug: string; conversas: number[]; desde: Date }> = [];
  const banco = {
    async falas(slug: string, conversas: number[], desde: Date) {
      pedidos.push({ slug, conversas, desde });
      return [
        { conversa: 1, texto: 'primeira', criadoEm: new Date('2026-11-16T10:00:00Z') },
        { conversa: 1, texto: 'segunda', criadoEm: new Date('2026-11-16T11:00:00Z') },
        { conversa: 2, texto: 'outra', criadoEm: new Date('2026-11-16T09:00:00Z') },
      ];
    },
    async eventos() {
      return [{ conversa: 1, tipo: 'marcou', detalhe: '2026-11-17T09:00', criadoEm: new Date('2026-11-16T11:00:00Z') }, { conversa: 3, tipo: 'ofereceu', detalhe: null, criadoEm: new Date('2026-11-16T08:00:00Z') }];
    },
  };
  const r = await fatosDoBanco('u', [1, 2, 3, 4], agora, banco);
  assert.deepEqual(pedidos[0], { slug: 'u', conversas: [1, 2, 3, 4], desde: new Date('2026-11-15T12:00:00Z') });
  assert.deepEqual(r.get(1)!.falasDaSofia.map((f) => f.texto), ['segunda', 'primeira']);
  assert.deepEqual(r.get(1)!.eventos.map((e) => e.tipo), ['marcou']);
  assert.deepEqual(r.get(2)!.eventos, []);
  assert.equal(r.get(3)!.eventos[0]!.tipo, 'ofereceu');
  assert.equal(r.has(4), false, 'conversa sem fato nenhum não aparece');
  assert.equal((await fatosDoBanco('u', [], agora, banco)).size, 0);
});
