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
/** Serra com a linha do plano (a ficha real): particular 350 / 280, com plano 250 / 220. */
const SERRA_COM_PLANO = unidade('Consulta particular: R$ 350 no dia · R$ 280 antecipado. Com plano: R$ 250 no dia · R$ 220 antecipado.');

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
    n: '2e controle: o valor AFIRMADO ao lado do negado segue conferido — "não é R$ 450, é R$ 380" vira "é R$ 350"',
    unit: SEM_SINAL,
    entra: 'A consulta não é R$ 450, é R$ 380.',
    sai: 'A consulta não é R$ 450, é R$ 350.',
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
    entra: 'Fica R$ 250 garantindo com sinal de entrada de R$ 250 antecipado.',
    sai: 'Fica R$ 250 garantindo com sinal de entrada de R$ 50 antecipado.',
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
  // ── 5. regressões da 1ª versão do PR (reprovação do sênior, 19/11): o esperado é o que o MAIN faz ──
  {
    n: 'r1 "R$ 250 pagando antes de vir, e no dia fica R$ 350" — "de vir" não é "de R$", e o preço do dia depois da marca não é o antecipado',
    unit: ARAGUAINA,
    entra: 'R$ 250 pagando antes de vir, e no dia fica R$ 350.',
    sai: 'R$ 250 pagando antes de vir, e no dia fica R$ 350.',
  },
  {
    n: 'r1 Serra: o mesmo, com o valor errado (R$ 250 antes de vir) — como no main, vira R$ 280',
    unit: SERRA_COM_PLANO,
    entra: 'R$ 250 pagando antes de vir, e no dia é R$ 350.',
    sai: 'R$ 280 pagando antes de vir, e no dia é R$ 350.',
  },
  {
    n: 'r1 "R$ 250 antecipado: no dia fica R$ 350"',
    unit: ARAGUAINA,
    entra: 'R$ 250 antecipado: no dia fica R$ 350.',
    sai: 'R$ 250 antecipado: no dia fica R$ 350.',
  },
  {
    n: 'r1 Balsas: "R$ 200 pagando antes de vir, e no dia fica R$ 350"',
    unit: BALSAS,
    entra: 'R$ 200 pagando antes de vir, e no dia fica R$ 350.',
    sai: 'R$ 200 pagando antes de vir, e no dia fica R$ 350.',
  },
  {
    n: 'r2 Serra: "R$ 250, mas só pagando antes, senão fica R$ 350 no dia" — o R$ 350 é o preço do dia, então o R$ 250 segue conferido (vira 280)',
    unit: SERRA_COM_PLANO,
    entra: 'A consulta sai R$ 250, mas só pagando antes, senão fica R$ 350 no dia.',
    sai: 'A consulta sai R$ 280, mas só pagando antes, senão fica R$ 350 no dia.',
  },
  {
    n: 'r2 Serra: "R$ 250 antecipado: R$ 50 de sinal e R$ 200 no dia" — o R$ 50 é o sinal, não o antecipado',
    unit: SERRA_COM_PLANO,
    entra: 'R$ 250 antecipado: R$ 50 de sinal e R$ 200 no dia.',
    sai: 'R$ 280 antecipado: R$ 50 de sinal e R$ 220 no dia.',
  },
  {
    n: 'r3 Serra: "São R$ 250 a consulta presencial com pagamento antecipado" — "presencial" não é o preço do dia (vira 280)',
    unit: SERRA_COM_PLANO,
    entra: 'São R$ 250 a consulta presencial com pagamento antecipado.',
    sai: 'São R$ 280 a consulta presencial com pagamento antecipado.',
  },
  {
    n: 'r3 Araguaína: "São R$ 300 a consulta presencial com pagamento antecipado" (vira 250, não 350)',
    unit: ARAGUAINA,
    entra: 'São R$ 300 a consulta presencial com pagamento antecipado.',
    sai: 'São R$ 250 a consulta presencial com pagamento antecipado.',
  },
  {
    n: 'r4 Araguaína: "Com sinal: R$ 250 antecipado (R$ 50 agora + R$ 200 no dia)" é o rótulo do TOTAL, não o sinal',
    unit: ARAGUAINA,
    entra: 'Com sinal: R$ 250 antecipado (R$ 50 agora + R$ 200 no dia).',
    sai: 'Com sinal: R$ 250 antecipado (R$ 50 agora + R$ 200 no dia).',
  },
  {
    n: 'r4 Araguaína: "Total com sinal: R$ 250 antecipado, sendo R$ 50 agora e R$ 200 no dia"',
    unit: ARAGUAINA,
    entra: 'Com sinal: R$ 250 antecipado, sendo R$ 50 agora e R$ 200 no dia.',
    sai: 'Com sinal: R$ 250 antecipado, sendo R$ 50 agora e R$ 200 no dia.',
  },
  {
    n: 'r5 Serra: "Antecipado R$ 280, se não R$ 380 no dia" — "se não" é o "senão" mal escrito, não negação (R$ 380 vira 350)',
    unit: SERRA_COM_PLANO,
    entra: 'Antecipado R$ 280, se não R$ 380 no dia.',
    sai: 'Antecipado R$ 280, se não R$ 350 no dia.',
  },
  // ── 6. rodada 2 do sênior (21 frases): o esperado é o que o MAIN faz — o R$ depois da marca é o preço do dia / data / lugar, ou colado sem contraste ──
  { n: 'r6.01', unit: ARAGUAINA, entra: 'Fica R$ 250 com desconto antecipado de R$ 100.', sai: 'Fica R$ 250 com desconto antecipado de R$ 100.' },
  { n: 'r6.02', unit: SERRA_COM_PLANO, entra: 'R$ 300 com desconto antecipado de R$ 70.', sai: 'R$ 280 com desconto antecipado de R$ 70.' },
  { n: 'r6.03', unit: ARAGUAINA, entra: 'R$ 250, mas só pagando antes, que na hora fica R$ 350.', sai: 'R$ 250, mas só pagando antes, que na hora fica R$ 350.' },
  { n: 'r6.04', unit: ARAGUAINA, entra: 'R$ 250, mas só pagando antes, pagando lá fica R$ 350.', sai: 'R$ 250, mas só pagando antes, pagando lá fica R$ 350.' },
  { n: 'r6.05', unit: ARAGUAINA, entra: 'A consulta sai R$ 250, mas só pagando antes, já que o valor cheio fica R$ 350.', sai: 'A consulta sai R$ 250, mas só pagando antes, já que o valor cheio fica R$ 350.' },
  { n: 'r6.06', unit: ARAGUAINA, entra: 'R$ 250, mas só pagando antes, que o normal é R$ 350.', sai: 'R$ 250, mas só pagando antes, que o normal é R$ 350.' },
  { n: 'r6.07', unit: SERRA_COM_PLANO, entra: 'A consulta sai R$ 280, mas só pagando antes, porque na hora fica R$ 350.', sai: 'A consulta sai R$ 280, mas só pagando antes, porque na hora fica R$ 350.' },
  { n: 'r6.08', unit: BALSAS, entra: 'R$ 200, mas só se pagar antes, que depois fica R$ 350.', sai: 'R$ 200, mas só se pagar antes, que depois fica R$ 350.' },
  { n: 'r6.09', unit: SERRA_COM_PLANO, entra: 'A consulta sai R$ 250, mas só pagando antes, que na hora fica R$ 350.', sai: 'A consulta sai R$ 280, mas só pagando antes, que na hora fica R$ 350.' },
  { n: 'r6.10', unit: ARAGUAINA, entra: 'Fica R$ 300, mas só se pagar antes, do contrário sai R$ 350.', sai: 'Fica R$ 250, mas só se pagar antes, do contrário sai R$ 350.' },
  { n: 'r6.11', unit: ARAGUAINA, entra: 'Fica R$ 250, mas só se pagar antes, do contrário sai R$ 350.', sai: 'Fica R$ 250, mas só se pagar antes, do contrário sai R$ 350.' },
  { n: 'r6.12', unit: SERRA_COM_PLANO, entra: 'Fica R$ 280, mas só pagando antes, quem paga presencialmente fica R$ 350.', sai: 'Fica R$ 280, mas só pagando antes, quem paga presencialmente fica R$ 350.' },
  { n: 'r6.13', unit: ARAGUAINA, entra: 'Fica R$ 300 para o atendimento no dia 21, pagando antecipado.', sai: 'Fica R$ 250 para o atendimento no dia 21, pagando antecipado.' },
  { n: 'r6.14', unit: ARAGUAINA, entra: 'A consulta fica R$ 300 aqui na clínica com pagamento antecipado.', sai: 'A consulta fica R$ 250 aqui na clínica com pagamento antecipado.' },
  { n: 'r6.15', unit: SERRA_COM_PLANO, entra: 'Fica R$ 250 pra sua consulta no dia 21, pagando antes pelo Pix.', sai: 'Fica R$ 280 pra sua consulta no dia 21, pagando antes pelo Pix.' },
  { n: 'r6.16', unit: ARAGUAINA, entra: 'Não seria R$ 400 no total?', sai: 'Não seria R$ 350 no total?' },
  { n: 'r6.17', unit: SERRA_COM_PLANO, entra: 'A consulta é R$ 300 no dia 25, com pagamento antecipado por Pix.', sai: 'A consulta é R$ 280 no dia 25, com pagamento antecipado por Pix.' },
  { n: 'r6.18', unit: ARAGUAINA, entra: 'Te espero no dia 21! A consulta fica R$ 300 pagando antecipado.', sai: 'Te espero no dia 21! A consulta fica R$ 250 pagando antecipado.' },
  { n: 'r6.19', unit: ARAGUAINA, entra: 'Te espero no dia 21, a consulta fica R$ 300 pagando antecipado.', sai: 'Te espero no dia 21, a consulta fica R$ 250 pagando antecipado.' },
  { n: 'r6.20', unit: ARAGUAINA, entra: 'Consulta no dia 21 às 14h: R$ 300 pagando antecipado.', sai: 'Consulta no dia 21 às 14h: R$ 250 pagando antecipado.' },
  { n: 'r6.21', unit: ARAGUAINA, entra: 'Consulta R$ 300 no dia 21 às 14h, pagando antecipado.', sai: 'Consulta R$ 250 no dia 21 às 14h, pagando antecipado.' },
  // ── 7. rodada 3 do sênior (18 frases): o esperado é o que o MAIN faz — sinal depois da marca, R$ colado na marca, valor do paciente, "se não"/pergunta ──
  { n: 'r7.01', unit: ARAGUAINA, entra: 'A consulta fica R$ 350 garantindo com sinal antecipado de R$ 50.', sai: 'A consulta fica R$ 250 garantindo com sinal antecipado de R$ 50.' },
  { n: 'r7.02', unit: BALSAS, entra: 'A consulta fica R$ 350 garantindo com sinal antecipado de R$ 50.', sai: 'A consulta fica R$ 200 garantindo com sinal antecipado de R$ 50.' },
  { n: 'r7.03', unit: ARAGUAINA, entra: 'R$ 350, mas pagando antes fica R$ 50 + R$ 200 no dia.', sai: 'R$ 250, mas pagando antes fica R$ 50 + R$ 200 no dia.' },
  { n: 'r7.04', unit: ARAGUAINA, entra: 'R$ 350 pagando antecipado, fica R$ 250 com o desconto.', sai: 'R$ 250 pagando antecipado, fica R$ 250 com o desconto.' },
  { n: 'r7.05', unit: ARAGUAINA, entra: 'O valor é R$ 350 pagando antecipado.', sai: 'O valor é R$ 250 pagando antecipado.' },
  { n: 'r7.06', unit: SERRA_COM_PLANO, entra: 'O valor é R$ 350 pagando antecipado.', sai: 'O valor é R$ 280 pagando antecipado.' },
  { n: 'r7.07', unit: SERRA_COM_PLANO, entra: 'Você já pagou o restante de R$ 230, tudo certo.', sai: 'Você já pagou o restante de R$ 230, tudo certo.' },
  { n: 'r7.08', unit: SERRA_COM_PLANO, entra: 'Você pagou o total de R$ 230 certinho.', sai: 'Você pagou o total de R$ 230 certinho.' },
  { n: 'r7.09', unit: ARAGUAINA, entra: 'Você já pagou o restante de R$ 230, tudo certo.', sai: 'Você já pagou o restante de R$ 230, tudo certo.' },
  { n: 'r7.10', unit: SERRA_COM_PLANO, entra: 'O Pix de R$ 230 veio certinho aqui.', sai: 'O Pix de R$ 230 veio certinho aqui.' },
  { n: 'r7.11', unit: SERRA_COM_PLANO, entra: 'Seu Pix de R$ 230, veio certinho!', sai: 'Seu Pix de R$ 230, veio certinho!' },
  { n: 'r7.12', unit: SERRA_COM_PLANO, entra: 'Olha, R$ 230, chegou aqui sim.', sai: 'Olha, R$ 230, chegou aqui sim.' },
  { n: 'r7.13', unit: ARAGUAINA, entra: 'O Pix de R$ 230 veio certinho aqui.', sai: 'O Pix de R$ 230 veio certinho aqui.' },
  { n: 'r7.14', unit: SERRA_COM_PLANO, entra: 'O valor que aparece é R$ 230 no print que você mandou.', sai: 'O valor que aparece é R$ 230 no print que você mandou.' },
  { n: 'r7.15', unit: SERRA_COM_PLANO, entra: 'O valor que consta é R$ 230 no extrato do Pix.', sai: 'O valor que consta é R$ 230 no extrato do Pix.' },
  { n: 'r7.16', unit: SERRA_COM_PLANO, entra: 'Antecipado R$ 280, se não é R$ 380 no dia.', sai: 'Antecipado R$ 280, se não é R$ 350 no dia.' },
  { n: 'r7.17', unit: SERRA_COM_PLANO, entra: 'Pagando antes R$ 280, se não fica R$ 380 no dia.', sai: 'Pagando antes R$ 280, se não fica R$ 350 no dia.' },
  { n: 'r7.18', unit: ARAGUAINA, entra: 'Não fica R$ 400 no total?', sai: 'Não fica R$ 350 no total?' },
  // ── 4. valor-do-paciente.ts ──
  {
    n: '4a controle: "R$ 30, que caiu" (com o "que") segue sendo valor do paciente',
    unit: BALSAS,
    entra: 'Recebi o Pix de R$ 30, que caiu agora de manhã.',
    sai: 'Recebi o Pix de R$ 30, que caiu agora de manhã.',
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
  const A = { antecipado: 250, noDia: 350 };
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
  const S = { antecipado: 280, noDia: 350 };
  assert.deepEqual(corrigirValorAntecipado('R$ 350 no dia, mas pagando antes fica R$ 250.', S), { texto: 'R$ 350 no dia, mas pagando antes fica R$ 280.', corrigiu: [250] });
  assert.deepEqual(corrigirValorAntecipado('R$ 350 no dia, mas pagando antes fica em R$ 250.', S), { texto: 'R$ 350 no dia, mas pagando antes fica em R$ 280.', corrigiu: [250] });
  assert.deepEqual(corrigirValorAntecipado('No dia é R$ 350 (o Pix antecipado de R$ 250 é só pra quem paga antes).', S), {
    texto: 'No dia é R$ 350 (o Pix antecipado de R$ 280 é só pra quem paga antes).',
    corrigiu: [250],
  });
  // antecipado certo: nada a fazer; o sinal ao lado (valor liberado) não vira o antecipado; o preço do dia depois da marca não é o slot
  assert.deepEqual(corrigirValorAntecipado('R$ 350 no dia, mas pagando antes fica R$ 280.', S).corrigiu, []);
  // o R$ depois da marca é o SINAL: não é o antecipado, então o R$ de antes segue sendo o slot (como no main)
  assert.deepEqual(corrigirValorAntecipado('Fica R$ 200, mas só pagando antes, e a vaga custa R$ 50 de sinal.', { antecipado: 250, valoresLegitimos: [50] }), {
    texto: 'Fica R$ 250, mas só pagando antes, e a vaga custa R$ 50 de sinal.',
    corrigiu: [200],
  });
  // o R$ depois da marca é o preço do dia (noDia): não é o antecipado, então o R$ de antes segue sendo o slot, como no main
  assert.deepEqual(corrigirValorAntecipado('R$ 250 no dia, mas pagando antes fica R$ 350 na clínica.', S).corrigiu, [250]);
});

test('corrigirValorAntecipado: verbo "é" também traz o antecipado; "de vir" não é "de R$"', () => {
  const S = { antecipado: 280, noDia: 350 };
  assert.deepEqual(corrigirValorAntecipado('R$ 350, mas pagando antes é R$ 250.', S), { texto: 'R$ 350, mas pagando antes é R$ 280.', corrigiu: [250] });
  assert.deepEqual(corrigirValorAntecipado('R$ 250 pagando antes de vir, e no dia fica R$ 350.', S), { texto: 'R$ 280 pagando antes de vir, e no dia fica R$ 350.', corrigiu: [250] });
  // o que a marca traz é o retorno / o restante: outro item, não o antecipado da consulta
  assert.deepEqual(corrigirValorAntecipado('R$ 350, mas pagando antes o restante fica R$ 200.', { antecipado: 250 }).corrigiu, [350]);
});

test('corrigirValorAntecipado: com "no dia" e sem verbo, o ":" colado à marca traz o antecipado e é conferido', () => {
  const S = { antecipado: 280, noDia: 350 };
  assert.deepEqual(corrigirValorAntecipado('R$ 350 no dia, Pix antecipado: R$ 250.', S), { texto: 'R$ 350 no dia, Pix antecipado: R$ 280.', corrigiu: [250] });
  // sem "no dia" o ":" é rótulo do total ("Com sinal: R$ 250 antecipado (R$ 50 + R$ 200)") e não pula nada
  assert.deepEqual(corrigirValorAntecipado('R$ 250 antecipado: R$ 50 de sinal.', { antecipado: 280, valoresLegitimos: [50] }), { texto: 'R$ 280 antecipado: R$ 50 de sinal.', corrigiu: [250] });
});

test('corrigirValorAntecipado: "na hora / no ato" só pulam o R$ de antes quando o antecipado vem conferido depois da marca', () => {
  const S = { antecipado: 280, noDia: 350 };
  assert.deepEqual(corrigirValorAntecipado('R$ 350 na hora e pagando antes fica R$ 250.', S), { texto: 'R$ 350 na hora e pagando antes fica R$ 280.', corrigiu: [250] });
  // sem R$ depois da marca nada pula: como no main, o R$ de antes é o slot
  assert.deepEqual(corrigirValorAntecipado('R$ 250 na hora de reservar, pagando antes.', S), { texto: 'R$ 280 na hora de reservar, pagando antes.', corrigiu: [250] });
});

test('corrigirValorAntecipado: decide por NÚMERO (noDia), não por palavra', () => {
  const U = { antecipado: 200, noDia: 250 };
  // "no dia" + Y que já é o antecipado certo: o R$ de antes é o preço do dia (mesmo diferente do noDia da ficha) e nada é trocado
  assert.deepEqual(corrigirValorAntecipado('A consulta custa R$ 220 no dia, mas se puder pagar por Pix antes, fica R$ 200.', U), {
    texto: 'A consulta custa R$ 220 no dia, mas se puder pagar por Pix antes, fica R$ 200.',
    corrigiu: [],
  });
  // "no dia" explícito e Y: o R$ de antes é o preço do dia (mesmo diferente do noDia da ficha) e nunca vira o antecipado
  assert.deepEqual(corrigirValorAntecipado('R$ 280 no dia, mas pagando antes fica R$ 230.', U).corrigiu, []); // X é pulado (o catálogo olha), Y não é mexido
  assert.deepEqual(corrigirValorAntecipado('R$ 400 no dia, mas pagando antes fica R$ 200.', { antecipado: 250, noDia: 350 }).corrigiu, []); // não vira "R$ 250 no dia"
  // Y é o sinal ("agora"): não vira o antecipado; o R$ de antes é o slot, como no main
  assert.deepEqual(corrigirValorAntecipado('R$ 250, mas pagando antes fica R$ 50 agora.', { ...U, noDia: 300 }), {
    texto: 'R$ 200, mas pagando antes fica R$ 50 agora.',
    corrigiu: [250],
  });
  // "no dia 21" é data, não preço do dia
  assert.deepEqual(corrigirValorAntecipado('Fica R$ 250 no dia 21, pagando antes.', U), { texto: 'Fica R$ 200 no dia 21, pagando antes.', corrigiu: [250] });
  // sem noDia (chamador antigo): o "no dia" explícito + Y ainda pula o R$ de antes; sem isso, como no main
  assert.deepEqual(corrigirValorAntecipado('R$ 350 no dia, mas pagando antes fica R$ 250.', { antecipado: 280 }).corrigiu, []);
  assert.deepEqual(corrigirValorAntecipado('R$ 350, mas pagando antes fica R$ 250.', { antecipado: 280 }).corrigiu, [350]);
});

test('corrigirValorAntecipado: o sinal depois da marca não é o antecipado; o R$ colado na marca é conferido', () => {
  const A = { antecipado: 250, noDia: 350, sinal: 50 };
  assert.deepEqual(corrigirValorAntecipado('A consulta fica R$ 350 garantindo com sinal antecipado de R$ 50.', A), {
    texto: 'A consulta fica R$ 250 garantindo com sinal antecipado de R$ 50.',
    corrigiu: [350],
  });
  assert.deepEqual(corrigirValorAntecipado('R$ 350, mas pagando antes fica R$ 50 + R$ 200 no dia.', A).texto, 'R$ 250, mas pagando antes fica R$ 50 + R$ 200 no dia.');
  // R$ colado na marca ("R$ 350 pagando antecipado, fica R$ 250") É o antecipado: conferido, não pulado
  assert.deepEqual(corrigirValorAntecipado('R$ 350 pagando antecipado, fica R$ 250 com o desconto.', A).texto, 'R$ 250 pagando antecipado, fica R$ 250 com o desconto.');
  // ainda pula quando há algo entre o R$ e a marca
  assert.deepEqual(corrigirValorAntecipado('R$ 350, mas pagando antes fica R$ 250.', A).corrigiu, []);
});

test('corrigirSinalErrado: o antecipado dito pela 1ª vez é o total mal rotulado, não o sinal repetido', () => {
  const S = { sinal: 50, antecipado: 250 };
  const t1 = 'O valor com sinal de R$ 250 antecipado (R$ 50 agora + R$ 200 no dia).';
  assert.equal(corrigirSinalErrado(t1, S).texto, t1);
  assert.equal(corrigirSinalErrado('Fica R$ 250 garantindo com sinal de R$ 250 antecipado no Pix.', S).texto, 'Fica R$ 250 garantindo com sinal de R$ 50 antecipado no Pix.');
  // sem desdobramento depois, "sinal de R$ <antecipado> antecipado" é o erro do sinal: vira R$ 50
  assert.equal(corrigirSinalErrado('Para garantir é só pagar o sinal de R$ 200 antecipado.', { sinal: 50, antecipado: 200 }).texto, 'Para garantir é só pagar o sinal de R$ 50 antecipado.');
  // v diferente do antecipado (o R$ 250 velho na Balsas, onde o antecipado é R$ 200): sempre errado
  assert.equal(corrigirSinalErrado('R$ 250 com sinal de R$ 250 antecipado', { sinal: 50, antecipado: 200 }).texto, 'R$ 250 com sinal de R$ 50 antecipado');
});

test('corrigirValorAntecipado: Y que é diferença de preço ("R$ 100 mais barato") não é o antecipado', () => {
  assert.deepEqual(corrigirValorAntecipado('R$ 350 no dia, mas pagando antes fica R$ 100 mais barato.', { antecipado: 250, noDia: 350 }).corrigiu, []); // X é o noDia e diz "no dia": nada a trocar (e o 100 não vira 250)
});

test('corrigirValorAntecipado: sem sinal de preço do dia o slot segue corrigido', () => {
  const A = { antecipado: 250, noDia: 350 };
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
  assert.deepEqual(corrigirSinalErrado('sinal de R$ 1.500 no Pix antecipado', S), { texto: 'sinal de R$ 50 no Pix antecipado', corrigiu: [1500] });
  assert.equal(corrigirSinalErrado('Com sinal: R$ 250 antecipado (R$ 50 agora + R$ 200 no dia)', S).texto, 'Com sinal: R$ 250 antecipado (R$ 50 agora + R$ 200 no dia)'); // rótulo do total
  assert.equal(corrigirSinalErrado('sinal de entrada de R$ 250 antecipado', S).texto, 'sinal de entrada de R$ 50 antecipado');
  assert.equal(corrigirSinalErrado('O sinal é R$ 250', S).texto, 'O sinal é R$ 250');
  assert.equal(corrigirSinalErrado('Com sinal: R$ 250 antecipado (R$ 50 agora + R$ 200 no dia)', S).texto, 'Com sinal: R$ 250 antecipado (R$ 50 agora + R$ 200 no dia)');
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
  assert.deepEqual(pos('Antecipado R$ 280, se não R$ 380 no dia.'), []); // "senão" mal escrito
  assert.deepEqual(pos('Se não é R$ 380 no dia.'), []); // "se não é" = senão
  assert.deepEqual(pos('Pagando antes R$ 280, se não fica R$ 380 no dia.'), []); // "se não fica" = senão
  assert.deepEqual(pos('Não seria R$ 400 no total?'), []); // pergunta (o "?" fecha o valor) não nega nada
  assert.deepEqual(pos('Não fica R$ 400 no total?'), []);
  assert.deepEqual(pos('Não é R$ 450, viu?'), ['R$ 450']); // real (Boa Vista): vírgula antes do "?" = negação
  assert.deepEqual(pos('Fica R$ 250 no total, e não R$ 450, tudo bem?'), ['R$ 450']); // negação seguida de pergunta de fechamento continua negação
  assert.deepEqual(pos('Não é R$ 450, quer agendar?'), ['R$ 450']);
});

test('valor-do-paciente (como no main): o que o paciente mandou segue escondido', () => {
  for (const t of ['Recebi o Pix de R$ 30, que caiu agora.', 'O valor que consta foi de R$ 30.', 'Você transferiu R$ 30 ontem.', 'Seu Pix de R$ 30 caiu aqui.', 'No comprovante, o valor que aparece é R$ 40.']) {
    assert.equal(posicoesDeValorDoPaciente(t).size, 1, t);
  }
});
