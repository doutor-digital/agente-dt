/**
 * Frases plausíveis em que o guardrail do MAIN acertava e a 1ª versão do #412 errava (reprovação do sênior, 18/11/2026). Cada uma tem de sair
 * como o main fazia: a correção nova só vale para o comprovante e para o total com sinal, e em mais nada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { aplicarGuardrail } from './guardrail.js';

function unidade(sourceProdutos: string): Unit {
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
  } as unknown as Unit;
}

/** Balsas / Canaã (ficha de 18/11): R$ 350 no dia, ou R$ 200 com sinal de R$ 50 (R$ 50 agora + R$ 150 no dia). */
const BALSAS = unidade(
  'A CONSULTA presencial: R$ 350 no dia, ou R$ 200 com pagamento antecipado do sinal de R$ 50 (R$ 50 agora por Pix + R$ 150 no dia). Quem preferir pode pagar os R$ 200 inteiros antes, por Pix.',
);
/** Marabá / Imperatriz: R$ 350 no dia, ou R$ 250 com sinal de R$ 50 (R$ 50 agora + R$ 200 no dia). */
const MARABA = unidade('A CONSULTA presencial: R$ 350 no dia, ou R$ 250 com pagamento antecipado do sinal de R$ 50 (R$ 50 agora por Pix + R$ 200 no dia).');
/** Unidade SEM sinal: R$ 350 no dia ou R$ 200 antecipado. */
const SEM_SINAL = unidade('Consulta: R$ 350 no dia, ou R$ 200 com pagamento antecipado.');
/** Serra: R$ 350 no dia ou R$ 280 antecipado. */
const SERRA = unidade('Consulta particular: R$ 350 no dia · R$ 280 antecipado.');

const CASOS: { n: string; unit: Unit; entra: string; sai: string }[] = [
  // ── 1. "sinal" errado não vira o antecipado ──
  {
    n: '01 Marabá: "R$ 80 pra garantir sua vaga" → o sinal (R$ 50), não o antecipado',
    unit: MARABA,
    entra: 'Pix para Attiva Corpo e Mente, R$ 80 pra garantir sua vaga de segunda, 23/11, às 08h 🙏',
    sai: 'Pix para Attiva Corpo e Mente, R$ 50 pra garantir sua vaga de segunda, 23/11, às 08h 🙏',
  },
  {
    n: '02 Canaã: "💳 R$ 80,00 de sinal para reservar o horário" → R$ 50',
    unit: BALSAS,
    entra: 'Dá pra organizar o pagamento assim:\n\n💳 R$ 80,00 de sinal para reservar o horário e os R$ 150,00 restantes no dia do atendimento.',
    sai: 'Dá pra organizar o pagamento assim:\n\n💳 R$ 50 de sinal para reservar o horário e os R$ 150,00 restantes no dia do atendimento.',
  },
  {
    n: '03 "O sinal é de R$ 80 para garantir o horário" → R$ 50',
    unit: BALSAS,
    entra: 'O sinal é de R$ 80 para garantir o horário.',
    sai: 'O sinal é de R$ 50 para garantir o horário.',
  },
  {
    n: '04 Balsas: "Você paga R$ 80 agora pra garantir (e R$ 120 no dia)" → R$ 50 + R$ 150',
    unit: BALSAS,
    entra: 'Você paga R$ 80 agora pra garantir o horário (e R$ 120 no dia).',
    sai: 'Você paga R$ 50 agora pra garantir o horário (e R$ 150 no dia).',
  },
  // ── 2. preço do dia não vira o antecipado ──
  {
    n: '05 "R$ 380 na hora, ou garantindo com sinal" → o preço do dia (R$ 350)',
    unit: BALSAS,
    entra: 'A consulta é R$ 380 na hora, ou garantindo com sinal de R$ 50.',
    sai: 'A consulta é R$ 350 na hora, ou garantindo com sinal de R$ 50.',
  },
  {
    n: '06 "No dia fica R$ 380, e pra reservar…" → R$ 350',
    unit: BALSAS,
    entra: 'No dia fica R$ 380, e pra reservar o horário você paga só o sinal.',
    sai: 'No dia fica R$ 350, e pra reservar o horário você paga só o sinal.',
  },
  {
    n: '07 Imperatriz: "R$ 200 ao invés de R$ 380 — e isso já garante" → R$ 350',
    unit: MARABA,
    entra: 'Pagando por Pix antes do dia da consulta, o valor fica R$ 200 ao invés de R$ 380 — e isso já garante sua vaga reservada 😊',
    sai: 'Pagando por Pix antes do dia da consulta, o valor fica R$ 200 ao invés de R$ 350 — e isso já garante sua vaga reservada 😊',
  },
  {
    n: '14 "A consulta sai por R$ 400, ou você pode garantir com sinal de R$ 50 e fica R$ 200" → R$ 350 (o 400 é o dia errado)',
    unit: BALSAS,
    entra: 'A consulta sai por R$ 400, ou você pode garantir com sinal de R$ 50 e fica R$ 200.',
    sai: 'A consulta sai por R$ 350, ou você pode garantir com sinal de R$ 50 e fica R$ 200.',
  },
  {
    n: '14b "A consulta é R$ 400, ou com sinal de R$ 50 fica R$ 200 no total" → R$ 350',
    unit: BALSAS,
    entra: 'A consulta é R$ 400, ou com sinal de R$ 50 fica R$ 200 no total.',
    sai: 'A consulta é R$ 350, ou com sinal de R$ 50 fica R$ 200 no total.',
  },
  {
    n: '15 "Valor da consulta: R$ 300 reservando agora" → R$ 350',
    unit: BALSAS,
    entra: 'Valor da consulta: R$ 300 reservando agora.',
    sai: 'Valor da consulta: R$ 350 reservando agora.',
  },
  // ── 3. o "resto no dia" não alcança outro item ──
  {
    n: '08 "…Se precisar de raio-x, é mais R$ 120 na clínica" → frase de segurança (nada de inventar preço de raio-x)',
    unit: BALSAS,
    entra:
      'R$ 350 no dia, ou R$ 250 garantindo com sinal de R$ 50 (R$ 50 + R$ 200 no dia). Se precisar de raio-x, é mais R$ 120 na clínica.',
    sai: 'Sobre o valor, deixa eu confirmar direito pra não te passar informação errada 🙏 Já te falo por aqui, tá bem?',
  },
  // ── 4. o comprovante só é do paciente quando o texto diz isso ──
  {
    n: '09 "Fico no aguardo do comprovante de R$ 250 pra confirmar" → R$ 200 (é pedido, o R$ é preço)',
    unit: SEM_SINAL,
    entra: 'Fico no aguardo do comprovante de R$ 250 pra confirmar 😊',
    sai: 'Fico no aguardo do comprovante de R$ 200 pra confirmar 😊',
  },
  {
    n: '10 "Se você já pagou os R$ 250 antecipados, é só me mandar o comprovante" → R$ 200 (condicional)',
    unit: SEM_SINAL,
    entra: 'Se você já pagou os R$ 250 antecipados, é só me mandar o comprovante.',
    sai: 'Se você já pagou os R$ 200 antecipados, é só me mandar o comprovante.',
  },
  {
    n: '11 "Se você já mandou o Pix, fica R$ 300 no dia" → R$ 350 (condicional + preço do dia)',
    unit: BALSAS,
    entra: 'Se você já mandou o Pix, fica R$ 300 no dia.',
    sai: 'Se você já mandou o Pix, fica R$ 350 no dia.',
  },
  {
    n: '12 "O valor que consta aqui é R$ 250 antecipado" → R$ 200 (o texto depois do valor é preço)',
    unit: BALSAS,
    entra: 'O valor que consta aqui é R$ 250 antecipado.',
    sai: 'O valor que consta aqui é R$ 200 antecipado.',
  },
  {
    n: '13 Serra: "O valor foi de R$ 300 a consulta antecipada" → R$ 280',
    unit: SERRA,
    entra: 'O valor foi de R$ 300 a consulta antecipada.',
    sai: 'O valor foi de R$ 280 a consulta antecipada.',
  },
  {
    n: '16 "Você enviou o Pix, ficam R$ 250 no dia" → como no main (o mais próximo, R$ 200)',
    unit: BALSAS,
    entra: 'Você enviou o Pix, ficam R$ 250 no dia.',
    sai: 'Você enviou o Pix, ficam R$ 200 no dia.',
  },
  {
    n: '17 "Você já pagou, então fica R$ 300 na clínica" → R$ 350',
    unit: BALSAS,
    entra: 'Você já pagou, então fica R$ 300 na clínica.',
    sai: 'Você já pagou, então fica R$ 350 na clínica.',
  },
  {
    n: '18 "O valor que aparece na tabela é R$ 300 no dia" → R$ 350',
    unit: BALSAS,
    entra: 'O valor que aparece na tabela é R$ 300 no dia.',
    sai: 'O valor que aparece na tabela é R$ 350 no dia.',
  },
];

for (const c of CASOS) {
  test(`regressão #412 — sai como no main: ${c.n}`, () => {
    // As unidades do teste têm de ler os preços que o caso supõe (senão o teste prova outra coisa).
    assert.equal(aplicarGuardrail(c.entra, c.unit).text, c.sai);
  });
}
