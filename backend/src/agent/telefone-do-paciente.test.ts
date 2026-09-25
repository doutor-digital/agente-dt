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

test('sem telefone, o bloco inteiro some do prompt', () => {
  // Silêncio é melhor que "telefone: null": um campo vazio no prompt convida
  // o modelo a preencher com o que ele achar. E desde 24/09/2026 não sobra mais
  // nada neste bloco sem o telefone — o leadId saiu (o código injeta sozinho).
  assert.equal(renderConversationContext(24917886, null), '');
});

test('telefone em branco conta como ausente', () => {
  for (const vazio of ['', '   ', undefined]) {
    assert.equal(renderConversationContext(1, vazio as string | undefined), '', `"${String(vazio)}" não deveria virar bloco`);
  }
});

test('o leadId não é mais ensinado ao modelo', () => {
  // Ele não é argumento de ferramenta nenhuma: o código põe o lead da conversa
  // em toda chamada. Mandar o modelo escrever o número era token pago duas vezes
  // (no prefixo e na saída) por um valor que ia ser sobrescrito de todo jeito.
  const bloco = renderConversationContext(777, '63991021043');
  assert.ok(!bloco.includes('777'), 'o leadId não deve aparecer no prompt');
  assert.doesNotMatch(bloco, /leadId/);
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
