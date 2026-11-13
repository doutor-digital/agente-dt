/**
 * Pedido à Doutor Digital pela tela Agente: validação, o texto que vai para o suporte e o aviso do bot de chamados.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PEDIDO, TIPOS_DE_PEDIDO, avisoDoPedido, lerPedido, relatoDoPedido, situacaoDoPedido } from './agente-pedidos.js';

test('lerPedido: exige tipo conhecido e uma frase; corta caractere de controle; conversa opcional', () => {
  assert.deepEqual(lerPedido({ tipo: 'valor', texto: 'A consulta passa a custar R$ 380 em dezembro.' }), {
    ok: true, tipo: 'valor', texto: 'A consulta passa a custar R$ 380 em dezembro.', conversa: null,
  });
  assert.equal(lerPedido({ tipo: 'nao-existe', texto: 'qualquer coisa longa' }).ok, false);
  assert.equal(lerPedido({ tipo: 'toString', texto: 'qualquer coisa longa' }).ok, false, 'nada de propriedade herdada');
  assert.equal(lerPedido({ tipo: 'erro', texto: 'curto' }).ok, false);
  assert.equal(lerPedido({ tipo: 'erro', texto: 'x'.repeat(MAX_PEDIDO + 1) }).ok, false);
  const r = lerPedido({ tipo: 'erro', texto: 'A Sofia\u0007 não respondeu ontem', conversa: '42' });
  assert.ok(r.ok && r.texto === 'A Sofia não respondeu ontem' && r.conversa === 42);
  assert.equal(lerPedido(null).ok, false);
});

test('relato e aviso: dizem quem, de onde e o tipo; o aviso corta texto longo', () => {
  const relato = relatoDoPedido({ unidade: 'Doutor Hérnia Parauapebas', nome: 'Cleia', tipo: 'agenda', texto: 'Sábado não abre mais.', conversa: 7 });
  assert.ok(relato.startsWith('[Agente no Chatwoot] Cleia, de Doutor Hérnia Parauapebas, pediu (conversa 7 do Chatwoot):'));
  assert.ok(relato.includes(TIPOS_DE_PEDIDO.agenda.rotulo) && relato.endsWith('Sábado não abre mais.'));
  const aviso = avisoDoPedido({ protocolo: 123, unidade: 'Parauapebas', nome: 'Cleia', tipo: 'outro', texto: 'y'.repeat(600) });
  assert.ok(aviso.startsWith('🆕 Pedido #123 pelo Agente (Chatwoot) — Parauapebas'));
  assert.ok(aviso.includes('…') && aviso.length < 600);
});

test('situação do pedido para a lista', () => {
  assert.equal(situacaoDoPedido('aberta'), 'na-fila');
  assert.equal(situacaoDoPedido('resolvida'), 'resolvido');
  assert.equal(situacaoDoPedido('reaberta'), 'reaberto');
});
