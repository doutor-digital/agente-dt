/**
 * Furos que o sênior deixou no guardrail de preço depois de #408 e #412 (19/11/2026). Cada frase abaixo falhava no main e passa agora; os "controles"
 * passavam nos dois e provam que a correção não ficou frouxa.
 *
 *   1. o PREÇO DO DIA contraposto ao antecipado não é o slot do antecipado ("R$ 350, mas pagando antes fica R$ 200")
 *   2. o valor que a Sofia NEGA ("— não R$ 450") não é trocado pelo "aprovado mais próximo"
 *   3. "sinal de R$ 250 antecipado": o valor depois de "sinal de" é o sinal da unidade (R$ 50)
 *   4. formatos de valor-do-paciente.ts que escondiam preço errado, e o comprovante que coincide com o preço
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { aplicarGuardrail } from './guardrail.js';
import { corrigirSinalErrado, corrigirValorAntecipado } from './valor-antecipado.js';
import { posicoesDeValorNegado, posicoesDeValorDoPaciente } from './valor-do-paciente.js';

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
/** Araguaína / Imperatriz / Marabá / Açailândia: R$ 350 no dia, ou R$ 250 com sinal de R$ 50 (R$ 50 agora + R$ 200 no dia). */
const ARAGUAINA = unidade('A CONSULTA presencial: R$ 350 no dia, ou R$ 250 com pagamento antecipado do sinal de R$ 50 (R$ 50 agora por Pix + R$ 200 no dia).');
/** Unidade SEM sinal: R$ 350 no dia ou R$ 200 antecipado. */
const SEM_SINAL = unidade('Consulta: R$ 350 no dia, ou R$ 200 com pagamento antecipado.');
/** Açailândia sem a linha do sinal na ficha: R$ 350 no dia ou R$ 250 antecipado. */
const ACAILANDIA_SEM_SINAL = unidade('Consulta: R$ 350 no dia, ou R$ 250 com pagamento antecipado.');
/** Serra: R$ 350 no dia ou R$ 280 antecipado. */
const SERRA = unidade('Consulta particular: R$ 350 no dia · R$ 280 antecipado.');

const CASOS: { n: string; unit: Unit; entra: string; sai: string }[] = [
  // ── 1. o preço do dia contraposto ao antecipado fica como a Sofia escreveu ──
  {
    n: '1a Açailândia (real 04/11): "R$ 350 no dia, mas com pagamento antecipado no PIX fica R$ 250"',
    unit: ACAILANDIA_SEM_SINAL,
    entra: 'A consulta é R$ 350 no dia, mas com pagamento antecipado no PIX fica R$ 250 e já garante seu horário.',
    sai: 'A consulta é R$ 350 no dia, mas com pagamento antecipado no PIX fica R$ 250 e já garante seu horário.',
  },
  {
    n: '1b Açailândia (real 28/10): sem "no dia" — "é R$ 350, mas com pagamento antecipado no PIX fica R$ 250"',
    unit: ACAILANDIA_SEM_SINAL,
    entra: 'A consulta com nosso especialista é R$ 350, mas com pagamento antecipado no PIX fica R$ 250 e já garante seu horário.',
    sai: 'A consulta com nosso especialista é R$ 350, mas com pagamento antecipado no PIX fica R$ 250 e já garante seu horário.',
  },
  {
    n: '1c Balsas (real 06/11): "é R$ 350, mas se preferir pagar antes, no Pix, fica R$ 200"',
    unit: SEM_SINAL,
    entra: 'A consulta com nosso especialista é R$ 350, mas se preferir pagar antes, no Pix, fica R$ 200 e já garante seu horário.',
    sai: 'A consulta com nosso especialista é R$ 350, mas se preferir pagar antes, no Pix, fica R$ 200 e já garante seu horário.',
  },
  {
    n: '1d Balsas (real 03/11): centavos — "R$ 350,00, mas se você pagar antecipado por PIX, fica em R$ 200,00"',
    unit: SEM_SINAL,
    entra: 'A consulta com nosso especialista é de R$ 350,00, mas se você pagar antecipado por PIX, fica em R$ 200,00 e já garante sua vaga 😉',
    sai: 'A consulta com nosso especialista é de R$ 350,00, mas se você pagar antecipado por PIX, fica em R$ 200,00 e já garante sua vaga 😉',
  },
  {
    n: '1e o exemplo do sênior: "R$ 350 no dia, mas se pagar antes, no Pix, fica R$ 200"',
    unit: SEM_SINAL,
    entra: 'A consulta é R$ 350 no dia, mas se pagar antes, no Pix, fica R$ 200.',
    sai: 'A consulta é R$ 350 no dia, mas se pagar antes, no Pix, fica R$ 200.',
  },
  {
    n: '1f Canaã (real 30/10): "R$ 350 pesa mesmo 🙏 Mas repara: pagando antes pelo PIX fica R$ 200"',
    unit: SEM_SINAL,
    entra: 'Entendo, R$ 350 pesa mesmo 🙏 Mas repara: pagando antes pelo PIX fica R$ 200 — já reserva seu horário.',
    sai: 'Entendo, R$ 350 pesa mesmo 🙏 Mas repara: pagando antes pelo PIX fica R$ 200 — já reserva seu horário.',
  },
  {
    n: '1g Canaã (real 25/10): "no dia, o valor é R$ 350 (o Pix antecipado de R$ 200 é só pra quem paga antes)"',
    unit: SEM_SINAL,
    entra: 'Sobre o pagamento: na clínica, no dia, o valor é R$ 350 (o Pix antecipado de R$ 200 é só pra quem paga antes e garante o horário).',
    sai: 'Sobre o pagamento: na clínica, no dia, o valor é R$ 350 (o Pix antecipado de R$ 200 é só pra quem paga antes e garante o horário).',
  },
  {
    n: '1h Mossoró (real 24/10): "custa R$ 220 no dia, mas se puder pagar por Pix antes, fica R$ 200"',
    unit: unidade('Consulta: R$ 220 no dia, ou R$ 200 antecipado.'),
    entra: 'Olha, a consulta com nosso especialista custa R$ 220 no dia, mas se puder pagar por Pix antes, fica R$ 200 — e com isso já garante seu horário.',
    sai: 'Olha, a consulta com nosso especialista custa R$ 220 no dia, mas se puder pagar por Pix antes, fica R$ 200 — e com isso já garante seu horário.',
  },
  // controles: o slot do antecipado continua sendo corrigido
  {
    n: '1w pulou o preço do dia mas o antecipado que a marca traz está errado (R$ 250 em vez de R$ 280, valor que existe na ficha) e É conferido',
    unit: unidade('Consulta particular: R$ 350 no dia · R$ 280 antecipado. Pacote de sessões: R$ 250.'),
    entra: 'A consulta é R$ 350 no dia, mas pagando antes fica R$ 250.',
    sai: 'A consulta é R$ 350 no dia, mas pagando antes fica R$ 280.',
  },
  {
    n: '1x controle Serra: "R$ 250 antecipado" continua virando R$ 280',
    unit: SERRA,
    entra: 'A consulta é R$ 250 antecipado, ou R$ 350 no dia.',
    sai: 'A consulta é R$ 280 antecipado, ou R$ 350 no dia.',
  },
  {
    n: '1y controle Serra: "R$ 250, mas só pagando antes" (sem outro valor depois) continua virando R$ 280',
    unit: SERRA,
    entra: 'A consulta fica R$ 250, mas só se você pagar antes por Pix.',
    sai: 'A consulta fica R$ 280, mas só se você pagar antes por Pix.',
  },
  {
    n: '1z controle Serra: "R$ 250 à vista no Pix antecipado" / "à vista antecipado" é o antecipado (à vista não é o preço do dia)',
    unit: SERRA,
    entra: 'Na clínica é R$ 350, ou R$ 250 à vista no Pix antecipado. Ou R$ 250 à vista antecipado.',
    sai: 'Na clínica é R$ 350, ou R$ 280 à vista no Pix antecipado. Ou R$ 280 à vista antecipado.',
  },
  // ── 2. valor negado pela Sofia ──
  {
    n: '2a Araguaína (real 11/11): "— não R$ 450" não vira "não R$ 50"',
    unit: ARAGUAINA,
    entra:
      'Pagando TUDO no dia da consulta, na clínica, é R$ 350. Se você garante a vaga antecipado pelo Pix, fica R$ 250 no total (R$ 50 agora + R$ 200 no dia) — não R$ 450 😊',
    sai: 'Pagando TUDO no dia da consulta, na clínica, é R$ 350. Se você garante a vaga antecipado pelo Pix, fica R$ 250 no total (R$ 50 agora + R$ 200 no dia) — não R$ 450 😊',
  },
  {
    n: '2b "e não R$ 450"',
    unit: SEM_SINAL,
    entra: 'O valor é R$ 200 pagando antes, e não R$ 450 como você entendeu.',
    sai: 'O valor é R$ 200 pagando antes, e não R$ 450 como você entendeu.',
  },
  {
    n: '2c "nem R$ 450"',
    unit: SEM_SINAL,
    entra: 'A consulta custa R$ 350 no dia, nem R$ 450 nem R$ 500.',
    sai: 'A consulta custa R$ 350 no dia, nem R$ 450 nem R$ 500.',
  },
  {
    n: '2d "não é R$ 450"',
    unit: SEM_SINAL,
    entra: 'Pode ficar tranquilo: não é R$ 450, é R$ 200 pagando antes.',
    sai: 'Pode ficar tranquilo: não é R$ 450, é R$ 200 pagando antes.',
  },
  {
    n: '2x controle: "ao invés de R$ 380" (preço normal errado, não negação) continua virando R$ 350',
    unit: SEM_SINAL,
    entra: 'Pagando por Pix antes do dia da consulta, o valor fica R$ 200 ao invés de R$ 380 — e isso já garante sua vaga.',
    sai: 'Pagando por Pix antes do dia da consulta, o valor fica R$ 200 ao invés de R$ 350 — e isso já garante sua vaga.',
  },
  {
    n: '2y controle: "não" longe do valor não esconde nada — R$ 450 solto continua trocado',
    unit: SEM_SINAL,
    entra: 'A consulta não custa pouco: fica R$ 450.',
    sai: 'A consulta não custa pouco: fica R$ 350.',
  },
  // ── 3. sinal de R$ X ──
  {
    n: '3a Balsas (real 11/11): "sinal de R$ 250 antecipado" → sinal de R$ 50 (e não R$ 200)',
    unit: BALSAS,
    entra: 'A consulta com o nosso especialista é R$ 350 no dia, ou R$ 250 garantindo com um sinal de R$ 250 antecipado no Pix.',
    sai: 'A consulta com o nosso especialista é R$ 350 no dia, ou R$ 200 garantindo com um sinal de R$ 50 antecipado no Pix.',
  },
  {
    n: '3b Balsas (real 13/11): com o resto no dia',
    unit: BALSAS,
    entra: 'A consulta com o nosso especialista é R$ 350 no dia, ou R$ 250 garantindo com um sinal de R$ 250 antecipado no Pix (e os outros R$ 200 no dia).',
    sai: 'A consulta com o nosso especialista é R$ 350 no dia, ou R$ 200 garantindo com um sinal de R$ 50 antecipado no Pix (e os outros R$ 150 no dia).',
  },
  {
    n: '3c Araguaína (real 16/11): R$ 250 é o antecipado e saía "sinal de R$ 250" como o modelo escreveu',
    unit: ARAGUAINA,
    entra: 'A consulta com o nosso especialista é R$ 350 no dia, ou R$ 250 garantindo com sinal de R$ 250 antecipado no Pix 😊',
    sai: 'A consulta com o nosso especialista é R$ 350 no dia, ou R$ 250 garantindo com sinal de R$ 50 antecipado no Pix 😊',
  },
  {
    n: '3d Marabá (real 16/11): com o desdobramento "(R$ 50 agora + R$ 200 no dia)"',
    unit: ARAGUAINA,
    entra: 'A consulta é R$ 350, pagando na clínica no dia, ou R$ 250 garantindo a vaga com um sinal de R$ 250 antecipado por Pix (R$ 50 agora + R$ 200 no dia) 😊',
    sai: 'A consulta é R$ 350, pagando na clínica no dia, ou R$ 250 garantindo a vaga com um sinal de R$ 50 antecipado por Pix (R$ 50 agora + R$ 200 no dia) 😊',
  },
  {
    n: '3e Araguaína (real 16/11): "só se você fizer o sinal de R$ 250 antecipado pelo Pix"',
    unit: ARAGUAINA,
    entra: 'R$ 350 é pagando no dia. R$ 250 é só se você fizer o sinal de R$ 250 antecipado pelo Pix pra garantir a vaga.',
    sai: 'R$ 350 é pagando no dia. R$ 250 é só se você fizer o sinal de R$ 50 antecipado pelo Pix pra garantir a vaga.',
  },
  {
    n: '3e2 controle: "O sinal de R$ 100 garante a vaga" (sem "antecipado") segue pelo corte de catálogo, como sempre (sinal-pix.test.ts)',
    unit: BALSAS,
    entra: 'O sinal de R$ 300 garante a vaga, pode ser?',
    sai: 'O sinal de R$ 350 garante a vaga, pode ser?',
  },
  {
    n: '3f "sinal de entrada de R$ 250"',
    unit: ARAGUAINA,
    entra: 'Garante com sinal de entrada de R$ 250 antecipado.',
    sai: 'Garante com sinal de entrada de R$ 50 antecipado.',
  },
  {
    n: '3g controle (real, Açailândia 14/11): "o valor com o sinal antecipado é R$ 250 (R$ 50 + R$ 200)" é o TOTAL com sinal e não vira R$ 50',
    unit: ARAGUAINA,
    entra: 'O valor com o sinal antecipado é R$ 250 (R$ 50 agora + R$ 200 no dia), ou R$ 350 se preferir pagar tudo na clínica.',
    sai: 'O valor com o sinal antecipado é R$ 250 (R$ 50 agora + R$ 200 no dia), ou R$ 350 se preferir pagar tudo na clínica.',
  },
  {
    n: '3h controle (probe do sênior): "O total com sinal é R$ 250" segue como no main (→ R$ 350 na Balsas), nunca R$ 50',
    unit: BALSAS,
    entra: 'O total com sinal é R$ 250, sendo R$ 50 agora e R$ 200 depois na clínica.',
    sai: 'O total com sinal é R$ 350, sendo R$ 50 agora e R$ 200 depois na clínica.',
  },
  {
    n: '3x controle: o sinal certo passa intacto',
    unit: BALSAS,
    entra: 'A consulta é R$ 350 no dia, ou R$ 200 garantindo com um sinal de R$ 50 antecipado no Pix (e os outros R$ 150 no dia).',
    sai: 'A consulta é R$ 350 no dia, ou R$ 200 garantindo com um sinal de R$ 50 antecipado no Pix (e os outros R$ 150 no dia).',
  },
  {
    n: '3y controle: R$ do comprovante ("o sinal de R$ 30 que você pagou") não é tocado',
    unit: BALSAS,
    entra: 'Recebi o sinal de R$ 30 que você pagou, mas o sinal é de R$ 50.',
    sai: 'Recebi o sinal de R$ 30 que você pagou, mas o sinal é de R$ 50.',
  },
  // ── 4. valor-do-paciente.ts ──
  {
    n: '4a Balsas: "A consulta fica R$ 300, chegou a ver os horários?" — o preço errado não sai',
    unit: BALSAS,
    entra: 'A consulta fica R$ 300, chegou a ver os horários?',
    sai: 'A consulta fica R$ 350, chegou a ver os horários?',
  },
  {
    n: '4a Canaã: "Fica R$ 250, veio pelo anúncio?"',
    unit: BALSAS,
    entra: 'Fica R$ 250, veio pelo anúncio?',
    sai: 'Fica R$ 200, veio pelo anúncio?',
  },
  {
    n: '4a Serra: "A consulta é R$ 300, chegou a ver nosso endereço?"',
    unit: SERRA,
    entra: 'A consulta é R$ 300, chegou a ver nosso endereço?',
    sai: 'A consulta é R$ 280, chegou a ver nosso endereço?',
  },
  {
    n: '4a controle: "R$ 30, que caiu" (com o "que") segue sendo valor do paciente',
    unit: BALSAS,
    entra: 'Recebi o Pix de R$ 30, que caiu agora de manhã.',
    sai: 'Recebi o Pix de R$ 30, que caiu agora de manhã.',
  },
  {
    n: '4b Serra: "O valor que consta é R$ 300 e você garante pelo Pix." — preço da tabela, não do comprovante',
    unit: SERRA,
    entra: 'O valor que consta é R$ 300 e você garante pelo Pix.',
    sai: 'O valor que consta é R$ 280 e você garante pelo Pix.',
  },
  {
    n: '4b controle: "No comprovante, o valor que aparece é R$ 40" segue sendo o do paciente (com "comprovante" na frase)',
    unit: BALSAS,
    entra: 'No comprovante, o valor que aparece é R$ 40, mas o antecipado é R$ 200.',
    sai: 'No comprovante, o valor que aparece é R$ 40, mas o antecipado é R$ 200.',
  },
  {
    n: '4a controle: "Seu Pix de R$ 30 caiu aqui" (sem "que", sem vírgula) segue sendo do paciente',
    unit: BALSAS,
    entra: 'Seu Pix de R$ 30 caiu aqui, falta R$ 20 pro sinal.',
    sai: 'Seu Pix de R$ 30 caiu aqui, falta R$ 20 pro sinal.',
  },
  {
    n: '4b controle: "O valor que consta foi de R$ 30" (passado) segue sendo valor do paciente',
    unit: BALSAS,
    entra: 'O valor que consta foi de R$ 30 no comprovante, mas o antecipado é R$ 200.',
    sai: 'O valor que consta foi de R$ 30 no comprovante, mas o antecipado é R$ 200.',
  },
  {
    n: '4c Balsas: "Você transferiu e o total R$ 300 fica certo." — o total é preço',
    unit: BALSAS,
    entra: 'Você transferiu e o total R$ 300 fica certo.',
    sai: 'Você transferiu e o total R$ 350 fica certo.',
  },
  {
    n: '4c controle: "Você transferiu R$ 30, faltam R$ 20 pro sinal." segue como no main',
    unit: BALSAS,
    entra: 'Você transferiu R$ 30, faltam R$ 20 pro sinal.',
    sai: 'Você transferiu R$ 30, faltam R$ 20 pro sinal.',
  },
  {
    n: '4d Canaã: "O comprovante mostra R$ 250, que é o valor da consulta antecipada" — o R$ é o preço, e preço errado é conferido',
    unit: BALSAS,
    entra: 'O comprovante mostra R$ 250, que é o valor da consulta antecipada 😊',
    sai: 'O comprovante mostra R$ 200, que é o valor da consulta antecipada 😊',
  },
];

for (const c of CASOS) {
  test(`guardrail de preço 19/11 — ${c.n}`, () => {
    assert.equal(aplicarGuardrail(c.entra, c.unit).text, c.sai);
  });
}

test('triggered: o sinal corrigido aparece como sinal_corrigido, não como antecipado_corrigido', () => {
  const r = aplicarGuardrail('A consulta é R$ 350 no dia, ou R$ 250 garantindo com sinal de R$ 250 antecipado no Pix.', ARAGUAINA);
  assert.ok(r.triggered.includes('sinal_corrigido:250->50'), r.triggered.join(','));
  assert.ok(!r.triggered.some((t) => t.startsWith('antecipado_corrigido')), r.triggered.join(','));
  assert.equal(r.rewritten, true);
});

test('o paciente é quem enviou o sinal: "Você enviou o sinal de R$ 30 antecipado" não é virado em "sinal de R$ 50" (a frase relata o que ELE fez)', () => {
  const r = aplicarGuardrail('Você enviou o sinal de R$ 30 antecipado, faltam R$ 20 pro restante.', BALSAS);
  assert.ok(!r.triggered.some((t) => t.startsWith('sinal_corrigido')), r.triggered.join(','));
});

test('preço do dia contraposto: nada reescrito, nada registrado', () => {
  const r = aplicarGuardrail('A consulta é R$ 350 no dia, mas com pagamento antecipado no PIX fica R$ 250.', ACAILANDIA_SEM_SINAL);
  assert.deepEqual(r.triggered, []);
  assert.equal(r.rewritten, false);
});

// ── funções ──
test('corrigirValorAntecipado: o preço do dia contraposto não é o slot', () => {
  const A = { antecipado: 250 };
  for (const t of [
    'R$ 350 no dia, mas se pagar antes, no Pix, fica R$ 250.',
    'R$ 350 na clínica, mas pagando antes fica R$ 250.',
    'É R$ 350 à vista na hora, mas pagando antes fica R$ 250.',
    'Fica R$ 350, porém pagando antes por Pix fica R$ 250.',
    'No dia é R$ 350 (o Pix antecipado de R$ 250 é só pra quem paga antes).',
  ]) {
    const r = corrigirValorAntecipado(t, A);
    assert.equal(r.texto, t, t);
    assert.deepEqual(r.corrigiu, [], t);
  }
});

test('corrigirValorAntecipado: pulou o preço do dia, mas o valor que a marca traz é conferido', () => {
  const S = { antecipado: 280 };
  assert.deepEqual(corrigirValorAntecipado('R$ 350 no dia, mas pagando antes fica R$ 250.', S), { texto: 'R$ 350 no dia, mas pagando antes fica R$ 280.', corrigiu: [250] });
  assert.deepEqual(corrigirValorAntecipado('No dia é R$ 350 (o Pix antecipado de R$ 250 é só pra quem paga antes).', S), {
    texto: 'No dia é R$ 350 (o Pix antecipado de R$ 280 é só pra quem paga antes).',
    corrigiu: [250],
  });
  // antecipado certo: nada a fazer; o sinal ao lado (valor liberado) não vira o antecipado; o preço do dia depois da marca não é o slot
  assert.deepEqual(corrigirValorAntecipado('R$ 350 no dia, mas pagando antes fica R$ 280.', S).corrigiu, []);
  assert.deepEqual(corrigirValorAntecipado('Fica R$ 200, mas só pagando antes, e a vaga custa R$ 50 de sinal.', { antecipado: 250, valoresLegitimos: [50] }), {
    texto: 'Fica R$ 200, mas só pagando antes, e a vaga custa R$ 50 de sinal.',
    corrigiu: [],
  });
  assert.deepEqual(corrigirValorAntecipado('R$ 250 no dia, mas pagando antes fica R$ 350 na clínica.', S).corrigiu, []);
});

test('corrigirValorAntecipado: sem sinal de preço do dia o slot segue corrigido', () => {
  const A = { antecipado: 250 };
  assert.equal(corrigirValorAntecipado('Fica R$ 200 se pagar antes por PIX.', A).texto, 'Fica R$ 250 se pagar antes por PIX.');
  assert.equal(corrigirValorAntecipado('Fica R$ 200, mas só pagando antes.', A).texto, 'Fica R$ 250, mas só pagando antes.');
  assert.equal(corrigirValorAntecipado('Dá R$ 200 antecipado, mas só até sexta.', A).texto, 'Dá R$ 250 antecipado, mas só até sexta.');
});

test('corrigirSinalErrado: só o valor depois de "sinal de", só quando é diferente do sinal', () => {
  const S = { sinal: 50 };
  assert.deepEqual(corrigirSinalErrado('com sinal de R$ 250 antecipado', S), { texto: 'com sinal de R$ 50 antecipado', corrigiu: [250] });
  assert.deepEqual(corrigirSinalErrado('com um sinal no valor de R$ 200,00 antecipado por Pix', S), {
    texto: 'com um sinal no valor de R$ 50 antecipado por Pix',
    corrigiu: [200],
  });
  assert.deepEqual(corrigirSinalErrado('sinal: R$ 1.500 no Pix antecipado', S), { texto: 'sinal: R$ 50 no Pix antecipado', corrigiu: [1500] });
  assert.equal(corrigirSinalErrado('sinal de entrada de R$ 250 antecipado', S).texto, 'sinal de entrada de R$ 50 antecipado');
  assert.equal(corrigirSinalErrado('O sinal é R$ 250', S).texto, 'O sinal é R$ 250');
  assert.equal(corrigirSinalErrado('O sinal de R$ 100 garante a vaga', S).texto, 'O sinal de R$ 100 garante a vaga'); // sem "antecipado": não é o slot
  assert.equal(corrigirSinalErrado('O valor com o sinal antecipado é R$ 250', S).texto, 'O valor com o sinal antecipado é R$ 250');
  assert.equal(corrigirSinalErrado('Você enviou o sinal de R$ 30 antecipado, faltam R$ 20', S).texto, 'Você enviou o sinal de R$ 30 antecipado, faltam R$ 20');
  assert.equal(corrigirSinalErrado('Recebi o comprovante do sinal de R$ 30 antecipado.', S).texto, 'Recebi o comprovante do sinal de R$ 30 antecipado.');
  for (const t of ['com sinal de R$ 50 antecipado', 'com sinal de R$ 50,00', 'R$ 250 garantindo com sinal', 'sem sinal']) {
    assert.deepEqual(corrigirSinalErrado(t, S), { texto: t, corrigiu: [] }, t);
  }
  // sem sinal, unidade com taxa de reserva ou assunto de plano: a trava não opina
  assert.equal(corrigirSinalErrado('sinal de R$ 250 antecipado', { sinal: 0 }).texto, 'sinal de R$ 250 antecipado');
  assert.equal(corrigirSinalErrado('sinal de R$ 250 antecipado', { sinal: 50, taxaDeReserva: true }).texto, 'sinal de R$ 250 antecipado');
  assert.equal(corrigirSinalErrado('Com plano de saúde, sinal de R$ 250 antecipado', S).texto, 'Com plano de saúde, sinal de R$ 250 antecipado');
});

test('posicoesDeValorNegado: só "não/nem" colado ao valor', () => {
  const pos = (t: string) => [...posicoesDeValorNegado(t)].map((i) => t.slice(i, i + 6));
  assert.deepEqual(pos('fica R$ 250 no total — não R$ 450 😊'), ['R$ 450']);
  assert.deepEqual(pos('é R$ 200, e não R$ 450.'), ['R$ 450']);
  assert.deepEqual(pos('nem R$ 450 nem R$ 500'), ['R$ 450', 'R$ 500']);
  assert.deepEqual(pos('Não é R$ 450'), ['R$ 450']);
  assert.deepEqual(pos('Não, R$ 450 não fecha'), []);
  assert.deepEqual(pos('A consulta não custa pouco: fica R$ 450.'), []);
  assert.deepEqual(pos('Pela campanha fica R$ 150, não R$ 150,99.'), []); // centavos: não é número redondo do paciente
  assert.deepEqual(pos('não R$ 450,00'), ['R$ 450']);
  assert.deepEqual(pos('R$ 200 ao invés de R$ 380'), []);
  assert.deepEqual(pos('R$ 200'), []);
});

test('valor-do-paciente: "R$ 250, veio pelo anúncio?" e "o total R$ 300" não são valor do paciente', () => {
  for (const t of ['Fica R$ 250, veio pelo anúncio?', 'A consulta fica R$ 300, chegou a ver os horários?', 'Você transferiu e o total R$ 300 fica certo.', 'O valor que consta é R$ 300 e você garante pelo Pix.']) {
    assert.equal(posicoesDeValorDoPaciente(t).size, 0, t);
  }
  for (const t of ['Recebi o Pix de R$ 30, que caiu agora.', 'O valor que consta foi de R$ 30.', 'Você transferiu R$ 30 ontem.', 'Seu Pix de R$ 30 caiu aqui.', 'No comprovante, o valor que aparece é R$ 40.']) {
    assert.equal(posicoesDeValorDoPaciente(t).size, 1, t);
  }
});
