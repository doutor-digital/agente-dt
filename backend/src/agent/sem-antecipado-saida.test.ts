/**
 * Trava de SAÍDA para unidade sem pagamento antecipado (Timbó, follow-up do #166, 30/10/2026).
 *
 * O prompt, a ferramenta e a régua já param de falar em antecipado; esta trava corta o que o modelo repetir por conta
 * própria (frases e botões antigos). Só atua quando `unidadeSemAntecipado(unit)`; unidade com a flag ligada sai igual,
 * byte a byte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { semOAntecipadoNaSaida } from './sem-antecipado-saida.js';
import { aplicarGuardrail } from './guardrail.js';
import { PAGAMENTO_NO_DIA } from './pagamento-da-unidade.js';

const timbo = {
  category: 'saude',
  acceptsAdvancePayment: false,
  spineBookingRequiresPayment: false,
  pixKey: '51.765.035/0001-52',
  sourceProdutos: 'Consulta: R$ 350 no dia, ou R$ 250 com pagamento antecipado.',
} as unknown as Unit;
const comAntecipado = { ...timbo, acceptsAdvancePayment: true } as unknown as Unit;

const NADA_DE_ANTECIPADO = /antecipad|garant\w+ (?:o |seu )?hor|chave|\[\[botoes: Pix/i;

test('frase real 1: a pergunta "antecipado pelo Pix ou na clínica" sai e vira a forma de pagar no dia', () => {
  const r = semOAntecipadoNaSaida('Perfeito, terça às 10h está ótimo! Você prefere pagar a consulta antecipado pelo Pix ou na clínica, no dia?');
  assert.equal(r.texto, `Perfeito, terça às 10h está ótimo! ${PAGAMENTO_NO_DIA}`);
  assert.equal(r.removidas.length, 1);
});

test('frase real 2: "R$ 250 antecipado pelo Pix (garante seu horário) ou pago no dia" sai', () => {
  const r = semOAntecipadoNaSaida('A consulta é na Rua das Flores, 100. R$ 250 antecipado pelo Pix (garante seu horário) ou pago no dia. Posso marcar?');
  assert.doesNotMatch(r.texto, NADA_DE_ANTECIPADO);
  assert.doesNotMatch(r.texto, /R\$ 250/);
  assert.match(r.texto, /^A consulta é na Rua das Flores, 100\./);
  assert.match(r.texto, /Posso marcar\?$/);
  assert.match(r.texto, /pagamento é feito no dia, na clínica/);
});

test('frase real 3: "podendo ser pago na hora ou antecipado por Pix" sai e a data/hora da frase ficam', () => {
  const r = semOAntecipadoNaSaida('Sua consulta está marcada para terça, dia 4, às 10h, podendo ser pago na hora ou antecipado por Pix. O endereço é Rua das Flores, 100.');
  assert.doesNotMatch(r.texto, /antecipad|pix/i);
  assert.match(r.texto, /Sua consulta está marcada para terça, dia 4, às 10h\./);
  assert.match(r.texto, /O endereço é Rua das Flores, 100\.$/);
});

test('a frase VERDADEIRA do pagamento no dia (com pix como forma) passa intacta, igual byte a byte', () => {
  for (const t of [
    PAGAMENTO_NO_DIA,
    'O pagamento é feito no dia, na clínica (dinheiro, pix, débito ou crédito). Chegue 10 minutos antes 🙏',
    'Para reservar é só me confirmar o nome. Pagamento no dia, pode ser pix ou cartão.',
    'A consulta é R$ 350, paga no dia. Aceitamos dinheiro, pix e cartão.',
  ]) {
    const r = semOAntecipadoNaSaida(t);
    assert.equal(r.texto, t);
    assert.equal(r.removidas.length, 0);
  }
});

test('os botões antigos [[botoes: Pix antecipado | Na clínica]] saem, o resto fica', () => {
  const r = semOAntecipadoNaSaida('Como você prefere pagar?\n[[botoes: Pix antecipado | Na clínica]]');
  assert.doesNotMatch(r.texto, /botoes|antecipad/i);
  const r2 = semOAntecipadoNaSaida('Terça às 10h fica ótimo, o endereço é Rua das Flores, 100.\n\n[[botoes: Pix antecipado | Na clínica]]');
  assert.equal(r2.texto, 'Terça às 10h fica ótimo, o endereço é Rua das Flores, 100.');
  assert.equal(r2.botoesRemovidos, true);
});

test('botões de horário não são tocados', () => {
  const t = 'Tenho estes horários:\n[[botoes: Seg 14h | Seg 16h30]]';
  assert.equal(semOAntecipadoNaSaida(t).texto, t);
});

test('chave Pix para reservar sai; chave enviada pela equipe também', () => {
  const a = semOAntecipadoNaSaida('Marcado! A equipe envia a chave do PIX para garantir a vaga. Qualquer dúvida estou por aqui.');
  assert.doesNotMatch(a.texto, /chave|garantir/i);
  assert.match(a.texto, /Qualquer dúvida estou por aqui\.$/);
  const b = semOAntecipadoNaSaida('Segue a chave Pix para reservar o horário: 51.765.035/0001-52. Te espero terça!');
  assert.doesNotMatch(b.texto, /51\.765|chave/i);
  assert.match(b.texto, /Te espero terça!$/);
});

test('"pagar antes" sem Pix também sai; negado ("não precisa pagar antecipado") fica', () => {
  assert.doesNotMatch(semOAntecipadoNaSaida('Você pode pagar antes e ganhar desconto. Terça às 10h?').texto, /pagar antes/i);
  const verdade = 'Não precisa pagar antecipado: a consulta é paga no dia, na clínica.';
  assert.equal(semOAntecipadoNaSaida(verdade).texto, verdade);
});

test('se a resposta inteira era a oferta, sai a frase do pagamento no dia (nunca vazio)', () => {
  const r = semOAntecipadoNaSaida('Pix antecipado garante seu horário.\n[[botoes: Pix antecipado | Na clínica]]');
  assert.equal(r.texto, PAGAMENTO_NO_DIA);
});

test('quando a resposta já diz o pagamento no dia, a frase cortada não é substituída (sem repetir)', () => {
  const r = semOAntecipadoNaSaida('O pagamento é no dia, na clínica. Se preferir antecipado pelo Pix, a equipe manda a chave. Terça às 10h?');
  assert.equal(r.texto, 'O pagamento é no dia, na clínica. Terça às 10h?');
});

test('guardrail: unidade sem antecipado corta e registra o motivo no rastro (triggered)', () => {
  const r = aplicarGuardrail('Terça às 10h está reservado. Você prefere pagar antecipado pelo Pix ou na clínica?\n[[botoes: Pix antecipado | Na clínica]]', timbo);
  assert.equal(r.rewritten, true);
  assert.ok(r.triggered.some((t) => t.startsWith('sem_antecipado:')), r.triggered.join(','));
  assert.ok(r.triggered.includes('sem_antecipado:botoes'));
  assert.doesNotMatch(r.text, /antecipad|botoes/i);
  assert.match(r.text, /Terça às 10h está reservado\./);
});

test('guardrail: a mesma resposta numa unidade com a flag ligada sai SEM mexer em nada da trava nova', () => {
  const t = 'Terça às 10h. Você prefere pagar antecipado pelo Pix (R$ 250) ou na clínica?\n[[botoes: Pix antecipado | Na clínica]]';
  const r = aplicarGuardrail(t, comAntecipado);
  assert.ok(!r.triggered.some((x) => x.startsWith('sem_antecipado')));
  assert.equal(r.text, t);
  // unidade de teste sem o campo (undefined) = como hoje
  const sem = aplicarGuardrail(t, { ...comAntecipado, acceptsAdvancePayment: undefined } as unknown as Unit);
  assert.equal(sem.text, t);
});

test('guardrail: Boa Vista (flag false + taxa de reserva) NÃO é sem antecipado: a taxa vence e nada é cortado', () => {
  const boaVista = { ...timbo, spineBookingRequiresPayment: true } as unknown as Unit;
  const t = 'Para garantir o horário, a taxa de reserva é por Pix antecipado: R$ 250.';
  const r = aplicarGuardrail(t, boaVista);
  assert.ok(!r.triggered.some((x) => x.startsWith('sem_antecipado')));
});

test('guardrail: resposta sem nada de pagamento passa igual na unidade sem antecipado', () => {
  const t = 'Bom dia! Como posso te ajudar hoje? 😊';
  const r = aplicarGuardrail(t, timbo);
  assert.equal(r.text, t);
  assert.equal(r.rewritten, false);
});
