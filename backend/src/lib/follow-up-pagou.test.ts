import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pagouOAntecipado } from './follow-up-worker.js';

/**
 * A trava que impede cobrar quem ja pagou.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 * ---------------------------
 * Pagar o antecipado NAO move o lead de etapa: ele continua em AGENDADO, so com
 * o campo do cartao marcado. Medido na Imperatriz em 02/09/2026: dos 25 leads
 * parados naquela etapa, 8 ja tinham pago. Sem esta funcao, o degrau de 5 minutos
 * mandaria "corre para garantir sua vaga" para quem acabou de mandar comprovante.
 *
 * O nome do campo muda por conta da Kommo e a replicacao entre unidades nao
 * preserva id, entao a leitura e por NOME — e por isso ela precisa aguentar as
 * variacoes de simbolo e de grafia que existem em producao.
 */

const campo = (nome: string, valor: unknown) => [{ field_name: nome, values: [{ value: valor }] }];

// ─── Os nomes reais, conferidos em producao ─────────────────────────────────

for (const nome of ['✓ Consulta pg antecipado', 'consulta pg antecipado', 'Consulta paga antecipado']) {
  test(`reconhece o campo de PAGAMENTO FEITO "${nome}"`, () => {
    assert.equal(pagouOAntecipado(campo(nome, 'Sim')), true);
  });
}

/**
 * O caso que quebrou em producao. O lead 25277743 escolheu pagar antecipado, o
 * campo da FORMA veio "Sim", e ele ficou uma hora sem receber nada porque a
 * trava concluiu que o dinheiro tinha entrado. Escolher nao e pagar.
 */
for (const nome of ['¤ Pagamento antecipado', 'Pagamento antecipado']) {
  test(`campo de FORMA escolhida "${nome}" NAO conta como pago`, () => {
    assert.equal(pagouOAntecipado(campo(nome, 'Sim')), false);
  });
}

test('cartao real do lead 25277743: escolheu antecipado, nao pagou', () => {
  const cartao = [
    { field_name: '⚑ Origem', values: [{ value: 'Meta-Instagram' }] },
    { field_name: '¤ Pagamento antecipado', values: [{ value: 'Sim' }] },
  ];
  assert.equal(pagouOAntecipado(cartao), false);
});

// ─── Os formatos que o Kommo devolve para "marcado" ─────────────────────────

for (const v of [true, 'true', '1', 1, 'Sim', 'sim', 'SIM']) {
  test(`entende ${JSON.stringify(v)} como pago`, () => {
    assert.equal(pagouOAntecipado(campo('✓ Consulta pg antecipado', v)), true);
  });
}

/** O campo monetario nao guarda "Sim": guarda quanto entrou. */
for (const v of [150, '150', '250,00', '1250.50']) {
  test(`valor monetario ${JSON.stringify(v)} conta como pago`, () => {
    assert.equal(pagouOAntecipado(campo('✓ Consulta pg antecipado', v)), true);
  });
}

test('valor monetario zerado nao conta como pago', () => {
  assert.equal(pagouOAntecipado(campo('✓ Consulta pg antecipado', 0)), false);
  assert.equal(pagouOAntecipado(campo('✓ Consulta pg antecipado', '0')), false);
});

// ─── O campo que diz o CONTRARIO ────────────────────────────────────────────

/**
 * "Consulta pg no dia" e o oposto de ter pago antecipado. Ele nao contem a
 * palavra "antecipado", mas a regra do prompt manda preencher os dois juntos,
 * entao vale travar explicitamente: marcar que paga no dia nao pode calar a
 * cobranca de quem ainda nao pagou.
 */
test('"Consulta pg no dia" marcado NAO conta como antecipado', () => {
  assert.equal(pagouOAntecipado(campo('Consulta pg no dia', 'Sim')), false);
});

test('"Pagamento antecipado no dia" tambem nao conta', () => {
  assert.equal(pagouOAntecipado(campo('Pagamento antecipado no dia', 'Sim')), false);
});

// ─── Ausencia e sujeira: na duvida, false ───────────────────────────────────

test('campo ausente devolve false', () => {
  assert.equal(pagouOAntecipado([]), false);
  assert.equal(pagouOAntecipado(null), false);
  assert.equal(pagouOAntecipado(undefined), false);
});

test('outro campo qualquer nao conta', () => {
  assert.equal(pagouOAntecipado(campo('⚑ Origem', 'Meta-Instagram')), false);
  assert.equal(pagouOAntecipado(campo('Pausar IA', 'true')), false);
});

for (const v of ['Nao', 'não', '', null, undefined, 'false', '0']) {
  test(`valor ${JSON.stringify(v)} no campo certo nao conta como pago`, () => {
    assert.equal(pagouOAntecipado(campo('✓ Consulta pg antecipado', v)), false);
  });
}

// ─── Cartao real ────────────────────────────────────────────────────────────

test('acha o campo no meio do cartao inteiro', () => {
  const cartao = [
    { field_name: '⚑ Origem', values: [{ value: 'Meta-Facebook' }] },
    { field_name: 'Consulta pg no dia', values: [{ value: 'Nao' }] },
    { field_name: '✓ Consulta pg antecipado', values: [{ value: 'Sim' }] },
    { field_name: '⌂ Campanha', values: [{ value: 'ENG | WPP' }] },
  ];
  assert.equal(pagouOAntecipado(cartao), true);
});

test('cartao completo sem pagamento devolve false', () => {
  const cartao = [
    { field_name: '⚑ Origem', values: [{ value: 'Meta-Facebook' }] },
    { field_name: 'Consulta pg no dia', values: [{ value: 'Sim' }] },
    { field_name: '✓ Consulta pg antecipado', values: [{ value: 'Nao' }] },
  ];
  assert.equal(pagouOAntecipado(cartao), false);
});
