import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderConversationContext } from './prompt-composer.js';
import { paraNumero } from '../services/kommo.service.js';

/**
 * O telefone do paciente no prompt.
 *
 * Existe por um caso medido em 01/09/2026: `conversations.phone` estava vazio
 * em 100% das conversas porque o webhook do Kommo — o caminho de todas as
 * unidades — nunca gravava o número. Como `cadastrar_paciente` exige telefone
 * com DDD, a IA passou a pedir o telefone ao paciente, e pedia na pior hora:
 *
 *   paciente: "me manda o pix que eu pago agora"
 *   Sofia:    "preciso confirmar seu telefone com DDD"   (sem mandar a chave)
 *
 * O número nunca foi desconhecido — é o WhatsApp de onde a mensagem veio.
 */

test('com telefone, o prompt manda usar o número e proíbe pedir', () => {
  const bloco = renderConversationContext(24917886, '+55 63 99102-1043');
  assert.ok(bloco.includes('+55 63 99102-1043'), 'o número precisa aparecer');
  assert.ok(/cadastrar_paciente/.test(bloco), 'precisa dizer onde usar o número');
  assert.match(bloco, /NÃO peça o telefone/i);
});

test('sem telefone, nenhuma linha sobre telefone entra no prompt', () => {
  // Silêncio é melhor que "telefone: null": um campo vazio no prompt convida
  // o modelo a preencher com o que ele achar.
  const bloco = renderConversationContext(24917886, null);
  assert.ok(!/telefone/i.test(bloco), 'não deve falar de telefone quando não há');
  assert.ok(bloco.includes('24917886'), 'o leadId continua lá');
});

test('telefone em branco conta como ausente', () => {
  for (const vazio of ['', '   ', undefined]) {
    const bloco = renderConversationContext(1, vazio as string | undefined);
    assert.ok(!/telefone/i.test(bloco), `"${String(vazio)}" não deveria virar bloco de telefone`);
  }
});

test('o leadId continua sendo a instrução principal', () => {
  // A trava de lead alheio vem antes: com ou sem telefone, o bloco existe pra
  // dizer qual lead é o desta conversa.
  const comFone = renderConversationContext(777, '63991021043');
  const semFone = renderConversationContext(777, null);
  for (const bloco of [comFone, semFone]) {
    assert.ok(bloco.includes('777'));
    assert.match(bloco, /NUNCA passe 0/);
  }
});

/**
 * Valor em dinheiro do comprovante.
 *
 * O campo "¤ Valor pago / entrada" é `monetary`, e até 01/09/2026 esse tipo
 * estourava com "tipo não suportado" — a IA lia o valor no comprovante e não
 * conseguia gravar. O modelo escreve o número do jeito que o paciente mandou.
 */
test('lê o valor do comprovante em qualquer formato que o modelo escreva', () => {
  assert.equal(paraNumero(200), 200);
  assert.equal(paraNumero('200'), 200);
  assert.equal(paraNumero('R$ 200'), 200);
  assert.equal(paraNumero('R$ 200,00'), 200);
  assert.equal(paraNumero('200,50'), 200.5);
  assert.equal(paraNumero('1.250,50'), 1250.5);
  assert.equal(paraNumero('1250.50'), 1250.5);
});

test('recusa o que não é valor em vez de inventar um número', () => {
  // Gravar um valor de pagamento errado é pior que não gravar: o cartão passa
  // a dizer que o paciente pagou algo que ele não pagou.
  for (const ruim of ['', 'duzentos', 'R$', 'abc', ['200'], Number.NaN]) {
    assert.equal(paraNumero(ruim as string), null, `"${String(ruim)}" deveria ser recusado`);
  }
});
