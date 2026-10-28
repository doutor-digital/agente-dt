import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textoDoEspelho, type OndaNoLote } from './disparo/lote.js';

// Fica fora de disparo-lote.test.ts de propósito: o serviço do Kommo valida o ambiente ao carregar, e aquela suíte é pura.
const ONDA: OndaNoLote = {
  id: 'o1', campanhaId: 'c1', campanhaNome: 'Canaã — Resgate', aprovadaEm: null, aprovadaModo: 'ligado', template: 'canaa_x', idioma: 'pt_BR',
  textoModelo: 'Oi {{1}}!', variaveis: ['primeiroNome'], cabecalho: { tipo: 'image', link: 'https://drive.kommo.com/s/abc123' },
};

test('NOTA: depois do downgradeEmoji do Kommo nenhuma linha se perde (📲 vira ☎, o resto fica)', async () => {
  const { downgradeEmoji } = await import('../services/kommo.service.js');
  const nota = downgradeEmoji(textoDoEspelho(ONDA, 'Oi Maria!', new Date(Date.UTC(2026, 9, 28, 17, 5)), 'America/Sao_Paulo'));
  assert.ok(nota.startsWith('☎ Campanha "Canaã — Resgate" — enviada em 28/10 às 14:05'), nota);
  assert.match(nota, /\nImagem enviada junto: https:\/\/drive\.kommo\.com\/s\/abc123\n/);
  assert.match(nota, /Mensagem enviada:\nOi Maria!\n/);
});
