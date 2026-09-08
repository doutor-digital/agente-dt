import { test } from 'node:test';
import assert from 'node:assert/strict';

import { avisarJoao, configurado, esquecerAvisos } from './alerta-whatsapp.js';

/**
 * Sem Evolution configurada o aviso vira só log — e a trava por chave tem que
 * segurar a repetição mesmo assim, senão a primeira falha real de sessão do Kommo
 * viraria uma mensagem por paciente no WhatsApp do João.
 */

test('sem configuração, não manda e não estoura', async () => {
  esquecerAvisos();
  delete process.env.EVOLUTION_ALERT_URL;
  assert.equal(configurado(), false);
  assert.equal(await avisarJoao('teste', 'k1'), false);
});

test('a mesma chave dentro da janela fica em silêncio; chave diferente passa pela trava', async () => {
  esquecerAvisos();
  delete process.env.EVOLUTION_ALERT_URL;
  await avisarJoao('a', 'voz-sessao', 60_000);
  // segunda chamada na janela: nem tenta (mesma resposta false, mas por silêncio)
  assert.equal(await avisarJoao('b', 'voz-sessao', 60_000), false);
  // outra chave não é afetada
  assert.equal(await avisarJoao('c', 'voz-falha:x', 60_000), false);
});
