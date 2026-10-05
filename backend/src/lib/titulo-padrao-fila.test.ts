/**
 * Queda do agente em 05/10/2026: com o "Título padrão" ligado, uma falha de rede do Kommo dentro da
 * renomeação ("socket hang up") virou rejeição NÃO TRATADA e o Node derrubou o processo — a Sofia de
 * todas as unidades caiu junto. Este teste prende: a falha volta para quem chamou (que já registra e
 * segue) e nada escapa sem tratamento.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TITULO_PADRAO_SLUGS = '*';
const { garantirTituloPadrao } = await import('./titulo-padrao.js');

test('falha do Kommo na renomeação não vira rejeição não tratada', async () => {
  const soltas: unknown[] = [];
  const pega = (e: unknown) => soltas.push(e);
  process.on('unhandledRejection', pega);
  try {
    const unit = { id: 'u-teste', slug: 'unidade-teste', spineTimezone: 'America/Sao_Paulo' } as never;
    const kommo = {
      getLead: async () => ({ id: 1, name: '', created_at: 1_791_000_000 }),
      listLeadsCriadosEntre: async () => { throw new Error('socket hang up'); },
    } as never;
    await assert.rejects(garantirTituloPadrao(unit, kommo, 1), /socket hang up/);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(soltas, []);
  } finally {
    process.off('unhandledRejection', pega);
  }
});
