import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jaSaiu, valeRetentar } from './reenvio-salesbot.js';

test('socket hang up vale retentar — foi o erro real de Mossoró', () => {
  assert.equal(valeRetentar({ message: 'socket hang up' }), true);
  assert.equal(valeRetentar({ code: 'ECONNRESET' }), true);
  assert.equal(valeRetentar({ code: 'ETIMEDOUT' }), true);
  assert.equal(valeRetentar({ status: 502 }), true);
});

test('4xx não vale: repetir não conserta configuração errada', () => {
  assert.equal(valeRetentar({ status: 404 }), false);
  assert.equal(valeRetentar({ status: 401 }), false);
  assert.equal(valeRetentar({ status: 403 }), false);
  // status vence a mensagem: um 404 que por acaso cite timeout continua sendo 404
  assert.equal(valeRetentar({ status: 404, message: 'timeout' }), false);
});

const AGORA = 1_700_000_000;
const saida = (text: string, atras = 10) => ({ type: 'outgoing', text, created_at: AGORA - atras });

test('se a mensagem já saiu, não dispara de novo', () => {
  const texto = 'Parece que houve algum probleminha no envio das mensagens. Mas tô por aqui!';
  assert.equal(jaSaiu([saida(texto)], texto, AGORA), true);
});

test('emoji removido no downgrade não atrapalha a comparação', () => {
  const escrito = 'Oi! Que bom te ver por aqui 😊 Como posso te chamar?';
  const entregue = 'Oi! Que bom te ver por aqui  Como posso te chamar?';
  assert.equal(jaSaiu([saida(entregue)], escrito, AGORA), true);
});

test('primeiro pedaço basta — o bot pode quebrar a fala', () => {
  const texto = 'Bom dia! Aqui é a Sofia, da Doutor Hérnia. Como posso te chamar?';
  assert.equal(jaSaiu([saida('Bom dia! Aqui é a Sofia, da Doutor Hérnia.')], texto, AGORA), true);
});

test('mensagem antiga não conta como entregue', () => {
  const texto = 'Bom dia! Aqui é a Sofia, da Doutor Hérnia. Como posso te chamar?';
  assert.equal(jaSaiu([saida(texto, 3600)], texto, AGORA), false);
});

test('mensagem do paciente nunca conta como entrega nossa', () => {
  const texto = 'Bom dia! Aqui é a Sofia, da Doutor Hérnia. Como posso te chamar?';
  assert.equal(jaSaiu([{ type: 'incoming', text: texto, created_at: AGORA - 5 }], texto, AGORA), false);
});

test('conversa vazia: não sei que saiu, então retenta', () => {
  assert.equal(jaSaiu([], 'Bom dia! Aqui é a Sofia da Doutor Hérnia.', AGORA), false);
});

test('texto curto demais não autoriza afirmar que saiu', () => {
  assert.equal(jaSaiu([saida('ok')], 'ok', AGORA), false);
});
