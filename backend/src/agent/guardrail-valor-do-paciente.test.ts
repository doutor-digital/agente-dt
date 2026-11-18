/**
 * Duas mensagens absurdas que o NOSSO guardrail de preço fabricava (reclamações de 18/11/2026), com as frases reais de `execution_steps`:
 *
 *  1. Comprovante: o R$ que o PACIENTE mandou era trocado pelo preço da unidade — "O comprovante mostra R$ 200, mas o valor do pagamento
 *     antecipado é R$ 200 — então não bate" (11+ vezes em 30 dias: Canaã, parauapebas-resgate, Marabá, Rio Verde).
 *  2. "Aprovado mais próximo": o total com sinal errado virava o valor mais próximo que ainda não estava na frase — e o antecipado estava ("o resto
 *     no dia") — "R$ 150 garantindo com sinal de R$ 50 (R$ 50 + R$ 200 no dia)" na unidade cujo antecipado é R$ 200.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { aplicarGuardrail } from './guardrail.js';

function unidade(sourceProdutos: string, over: Record<string, unknown> = {}): Unit {
  return {
    id: 'u-1',
    slug: 'doutor-hernia-teste',
    name: 'Teste',
    category: 'saude',
    spineEnabled: true,
    spineBookingRequiresPayment: false,
    acceptsAdvancePayment: true,
    pixKey: '12.345.678/0001-90',
    pixHolder: 'Clinica LTDA',
    sourceProdutos,
    sourcePapel: null,
    sourceNegocio: null,
    systemPrompt: '',
    sinalPixCentavos: null,
    ...over,
  } as unknown as Unit;
}

/** Canaã: R$ 350 no dia ou R$ 200 antecipado. */
const CANAA = unidade('Consulta: R$ 350 no dia, ou R$ 200 com pagamento antecipado.');
/** Rio Verde / Araguaína: R$ 350 no dia ou R$ 250 antecipado. */
const ARAGUAINA = unidade('Consulta: R$ 350 no dia, ou R$ 250 com pagamento antecipado.');
/** Balsas (ficha de 18/11): R$ 350 no dia ou R$ 200 com sinal de R$ 50 (R$ 50 agora + R$ 150 no dia). */
const BALSAS = unidade(
  'A CONSULTA presencial com o especialista: R$ 350 no dia, ou R$ 200 com pagamento antecipado do sinal de R$ 50 ' +
    '(R$ 50 agora por Pix + R$ 150 no dia). Quem preferir pode pagar os R$ 200 inteiros antes, por Pix.',
);

// ─── 1. O valor do comprovante é do paciente ─────────────────────────────────────────────────────────────────────────

const COMPROVANTES: { nome: string; unit: Unit; texto: string }[] = [
  {
    nome: 'Canaã 31/10: "O comprovante é de R$ 50,00, mas o valor do pagamento antecipado … é R$ 200,00"',
    unit: CANAA,
    texto:
      'O comprovante é de R$ 50,00, mas o valor do pagamento antecipado da consulta é R$ 200,00 — então não bate, e eu não posso confirmar a reserva com esse valor.',
  },
  {
    nome: 'Canaã 31/10: "O comprovante mostra R$ 50,00, mas o valor antecipado da nossa consulta é R$ 200,00"',
    unit: CANAA,
    texto: 'O comprovante mostra R$ 50,00, mas o valor antecipado da nossa consulta é R$ 200,00 — esse valor que você mandou não bate, Adriano 🙏',
  },
  {
    nome: 'Canaã 07/11: "o valor do comprovante foi R$ 50,00, mas o valor da consulta antecipada é R$ 200,00"',
    unit: CANAA,
    texto: 'Vi aqui que o valor do comprovante foi R$ 50,00, mas o valor da consulta antecipada é R$ 200,00. 😊 Será que falta complementar?',
  },
  {
    nome: 'Canaã 07/11: "o comprovante que recebi mostra R$ 50,00"',
    unit: CANAA,
    texto: 'Só pra fechar certinho: o comprovante que recebi mostra R$ 50,00, mas o valor da consulta antecipada é R$ 200,00.',
  },
  {
    nome: 'Canaã 09/11: "O valor desse comprovante é R$ 155,00" + pedido do comprovante com o preço certo',
    unit: CANAA,
    texto:
      'O valor desse comprovante é R$ 155,00, mas o pagamento antecipado da nossa consulta é de R$ 200,00 — por isso não consigo confirmar a reserva. 😊\n\n' +
      'Poderia conferir e me enviar o comprovante certinho, com o valor de R$ 200,00? Assim já garanto seu horário! 🙏',
  },
  {
    nome: 'Canaã 10/11: "o valor de R$ 50 não bate com o pagamento antecipado (que é R$ 200)"',
    unit: CANAA,
    texto: 'O comprovante é da nossa clínica, mas o valor de R$ 50 não bate com o pagamento antecipado da consulta (que é R$ 200) 🙏',
  },
  {
    nome: 'Canaã 27/10: "esse valor de R$ 50,00 ainda não bate com o valor da consulta antecipada"',
    unit: CANAA,
    texto: 'Já vi aqui o seu interesse e o pagamento, mas esse valor de R$ 50,00 ainda não bate com o valor da consulta antecipada aqui da nossa unidade, que é R$ 200,00 😊',
  },
  {
    nome: 'Porto 28/10: "reparei que o valor foi de R$ 750,00"',
    unit: CANAA,
    texto: 'Recebi seu comprovante certinho, mas reparei que o valor foi de R$ 750,00 — aqui a consulta antecipada é R$ 200,00, então esse valor não bate com o que esperávamos.',
  },
  {
    nome: 'Marabá 30/10: "o valor mostrado foi de R$ 50,00 — e o valor antecipado é de R$ 250"',
    unit: ARAGUAINA,
    texto: 'Elina, recebi seu comprovante, mas o valor mostrado foi de R$ 50,00 — e o valor antecipado é de R$ 250 💙. Pode verificar se falta complementar?',
  },
  {
    nome: 'Rio Verde 10/11: "O comprovante mostra R$ 100,00, mas o valor do pagamento antecipado … é R$ 250,00"',
    unit: ARAGUAINA,
    texto: 'O comprovante mostra R$ 100,00, mas o valor do pagamento antecipado da consulta é R$ 250,00 — então ainda não bate certinho.',
  },
  {
    nome: 'Rio Verde 13/11: "O valor do comprovante (R$ 200)" e "o valor que caiu foi R$ 200" (R$ 200 está fora do catálogo de R$ 250/350)',
    unit: ARAGUAINA,
    texto:
      'O valor do comprovante (R$ 200) é menor que o antecipado de R$ 250 das nossas fontes.\n\n' +
      'Só reparei que o valor que caiu foi R$ 200, e o nosso Pix antecipado é de R$ 250. Será que falta complementar essa diferençinha de R$ 50?',
  },
  {
    nome: 'parauapebas-resgate 17/11: "O comprovante é da unidade certa, mas o valor de R$ 200 ficou abaixo …, que é R$ 250"',
    unit: ARAGUAINA,
    texto: 'O comprovante é da unidade certa, mas o valor de R$ 200 ficou abaixo do valor do pagamento antecipado da consulta, que é R$ 250 🙏',
  },
  {
    nome: 'parauapebas-resgate 17/11: "O comprovante mostrou R$ 200,00, e o valor … é R$ 250,00"',
    unit: ARAGUAINA,
    texto: 'Vi aqui de novo, viu 🙏 O comprovante mostrou R$ 200,00, e o valor do pagamento antecipado da consulta é R$ 250,00 — ainda falta R$ 50 pra completar.',
  },
  {
    nome: 'canaa-resgate 18/11: comprovante de R$ 1.500,00 (fora do catálogo) não vira o preço da consulta',
    unit: CANAA,
    texto: 'Esse comprovante de R$ 1.500,00 parece ser de outro paciente ou outro serviço, Raquel — não bate com o valor da sua consulta.',
  },
  {
    nome: 'Araguaína 21/10: "Esse comprovante é de R$ 900,00 — valor diferente do nosso pagamento antecipado (R$ 250)"',
    unit: ARAGUAINA,
    texto: 'Esse comprovante é de R$ 900,00 — valor diferente do nosso pagamento antecipado da consulta (R$ 250), então acho melhor confirmar com você antes de dar baixa. 🙏',
  },
  {
    nome: 'Araguaína 26/10: "O comprovante é de R$150, mas o valor … é R$250" (sem espaço depois do R$)',
    unit: ARAGUAINA,
    texto: 'O comprovante é de R$150, mas o valor do pagamento antecipado da nossa unidade é R$250 — por isso ainda não consigo confirmar a reserva.',
  },
];

for (const c of COMPROVANTES) {
  test(`comprovante — o valor do paciente fica como está: ${c.nome}`, () => {
    const r = aplicarGuardrail(c.texto, c.unit);
    assert.equal(r.text, c.texto);
    assert.equal(r.rewritten, false);
    assert.deepEqual(r.triggered, []);
  });
}

test('comprovante — o preço da UNIDADE na mesma mensagem continua conferido (R$ 250 errado vira o antecipado, o R$ 150 do comprovante não)', () => {
  const r = aplicarGuardrail('O comprovante mostra R$ 150,00, mas o valor é R$ 250,00 no Pix antecipado — não bate.', CANAA);
  assert.equal(r.text, 'O comprovante mostra R$ 150,00, mas o valor é R$ 200 no Pix antecipado — não bate.');
  assert.deepEqual(r.triggered, ['antecipado_corrigido:250->200']);
});

test('comprovante — o R$ do paciente igual ao preço ERRADO da unidade não "legitima" o preço errado (R$ 200 do paciente, antecipado dito R$ 200 numa unidade de R$ 250)', () => {
  const r = aplicarGuardrail('O comprovante mostra R$ 200, mas o valor antecipado da nossa consulta é R$ 200.', ARAGUAINA);
  assert.equal(r.text, 'O comprovante mostra R$ 200, mas o valor antecipado da nossa consulta é R$ 250.');
});

test('comprovante — "R$ 200,00 — então não bate" é o preço da unidade, não do paciente: o errado continua corrigido', () => {
  const r = aplicarGuardrail('O comprovante é de R$ 150,00, mas o Pix antecipado é R$ 250,00 — então não bate.', CANAA);
  assert.equal(r.text, 'O comprovante é de R$ 150,00, mas o Pix antecipado é R$ 200 — então não bate.');
});

test('comprovante — PEDIDO de comprovante não é relato: "me enviar o comprovante com o valor de R$ 250" continua sob a trava', () => {
  const r = aplicarGuardrail('Pode me enviar o comprovante certinho, com o valor de R$ 250? Assim já garanto seu horário!', CANAA);
  assert.equal(r.text, 'Pode me enviar o comprovante certinho, com o valor de R$ 200? Assim já garanto seu horário!');
  assert.equal(r.rewritten, true);
});

test('comprovante — a palavra "comprovante" numa frase ANTERIOR não esconde o preço da frase seguinte', () => {
  const r = aplicarGuardrail('Recebi o comprovante, obrigada! A consulta com pagamento antecipado é R$ 250.', CANAA);
  assert.equal(r.text, 'Recebi o comprovante, obrigada! A consulta com pagamento antecipado é R$ 200.');
});

test('comprovante — sem comprovante, o antecipado errado segue corrigido como sempre', () => {
  const r = aplicarGuardrail('A consulta é R$ 350 no dia, ou R$ 250 com pagamento antecipado.', CANAA);
  assert.equal(r.text, 'A consulta é R$ 350 no dia, ou R$ 200 com pagamento antecipado.');
});

// ─── 2. Total com sinal: o antecipado, não o "mais próximo" ─────────────────────────────────────────────────────────

test('sinal — "R$ 250 garantindo com sinal de R$ 50 (R$ 50 agora + R$ 200 no dia)" na unidade de R$ 200 vira R$ 200 + R$ 150 (era R$ 150 + R$ 200)', () => {
  const r = aplicarGuardrail('R$ 350 no dia, ou R$ 250 garantindo com sinal de R$ 50 (R$ 50 agora + R$ 200 no dia)', BALSAS);
  assert.equal(r.text, 'R$ 350 no dia, ou R$ 200 garantindo com sinal de R$ 50 (R$ 50 agora + R$ 150 no dia)');
  assert.deepEqual(r.triggered, ['preco_corrigido:250→200/200→150']);
});

test('sinal — "(e os outros R$ 200 no dia)" e "(o restante, R$ 200, no dia)" também fecham a conta', () => {
  assert.equal(
    aplicarGuardrail('A consulta é R$ 350 no dia, ou R$ 250 garantindo com um sinal de R$ 50 antecipado no Pix (e os outros R$ 200 no dia).', BALSAS).text,
    'A consulta é R$ 350 no dia, ou R$ 200 garantindo com um sinal de R$ 50 antecipado no Pix (e os outros R$ 150 no dia).',
  );
  assert.equal(
    aplicarGuardrail('A consulta é R$ 350 no dia, ou R$ 250 garantindo com um sinal de R$ 50 via Pix (o restante, R$ 200, no dia).', BALSAS).text,
    'A consulta é R$ 350 no dia, ou R$ 200 garantindo com um sinal de R$ 50 via Pix (o restante, R$ 150, no dia).',
  );
  assert.equal(
    aplicarGuardrail('A consulta é R$ 350 no dia, ou R$ 250 garantindo com sinal de R$ 50 no Pix (e R$ 200 no dia).', BALSAS).text,
    'A consulta é R$ 350 no dia, ou R$ 200 garantindo com sinal de R$ 50 no Pix (e R$ 150 no dia).',
  );
});

test('sinal — o que já funcionava segue igual: sem o antecipado na frase, R$ 250 → R$ 200', () => {
  const r = aplicarGuardrail('A consulta é R$ 350 no dia, ou R$ 250 garantindo com sinal de R$ 50.', BALSAS);
  assert.equal(r.text, 'A consulta é R$ 350 no dia, ou R$ 200 garantindo com sinal de R$ 50.');
  assert.deepEqual(r.triggered, ['preco_corrigido:250→200']);
});

test('sinal — mensagem CERTA (R$ 200 com sinal de R$ 50, resto R$ 150) não é tocada', () => {
  const certa = 'A consulta é R$ 350 no dia, ou R$ 200 garantindo com sinal de R$ 50 (R$ 50 agora por Pix + R$ 150 no dia) 😊';
  const r = aplicarGuardrail(certa, BALSAS);
  assert.equal(r.text, certa);
  assert.equal(r.rewritten, false);
});

test('sinal — o resto só é corrigido quando o total foi trocado: sem total errado, "+ R$ 200 no dia" fica (nada de regravar à toa)', () => {
  const t = 'Você garante com R$ 50 agora + R$ 200 no dia.';
  assert.equal(aplicarGuardrail(t, BALSAS).text, t);
});
