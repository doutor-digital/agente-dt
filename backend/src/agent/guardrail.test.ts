import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aplicarGuardrail } from './guardrail.js';
import type { Unit } from '@prisma/client';

function unit(over: Partial<Unit>): Unit {
  return {
    category: 'saude',
    sourceProdutos: 'A CONSULTA presencial: R$ 350 (à vista no PIX: R$ 150).',
    sourcePapel: null,
    sourceNegocio: null,
    ...over,
  } as Unit;
}

test('clínico: diagnóstico afirmativo é barrado', () => {
  const r = aplicarGuardrail('Pelo que você descreveu, você tem hérnia de disco na L5.', unit({}));
  assert.equal(r.rewritten, true);
  assert.ok(r.triggered.some((t) => t.startsWith('clinico:diagnostico')));
});

test('clínico: prescrição de remédio é barrada', () => {
  const r = aplicarGuardrail('Enquanto isso pode tomar um anti-inflamatório pra aliviar.', unit({}));
  assert.equal(r.rewritten, true);
  assert.ok(r.triggered.some((t) => t.startsWith('clinico:prescricao')));
});

test('clínico: promessa de "não precisa de cirurgia" é barrada', () => {
  const r = aplicarGuardrail('Fica tranquila, no seu caso não precisa de cirurgia.', unit({}));
  assert.equal(r.rewritten, true);
});

test('clínico NÃO roda fora de saúde (ex.: energia solar)', () => {
  const r = aplicarGuardrail('Você tem hérnia de disco.', unit({ category: 'energia_solar' }));
  assert.equal(r.rewritten, false);
});

test('preço fora do catálogo é corrigido, não barrado', () => {
  const r = aplicarGuardrail('A consulta fica R$ 200, pode ser?', unit({}));
  assert.equal(r.rewritten, true);
  assert.ok(r.triggered.some((t) => t.startsWith('preco_corrigido:')));
  assert.equal(r.text, 'A consulta fica R$ 150, pode ser?');
});

test('caso real do José (Porto, 29/08): a confirmação inteira sobrevive', () => {
  const confirmacao =
    '✅ Agendamento confirmado, José!\n⭐ Data: terça-feira, 01/09\n⏰ Horário: 10:00\n' +
    '⭐ Local: Av. Presidente Castelo Branco, 1762, Sala 4 — Centro, Porto Nacional/TO\n' +
    '✨ Valor: R$ 100 no PIX à vista (ou R$ 350)\n⭐ Especialista: Dra. Lays Ribeiro Lopes\n' +
    'PIX: 60.669.336/0001-73';
  const r = aplicarGuardrail(confirmacao, unit({}));

  assert.equal(r.rewritten, true);
  assert.ok(r.text.includes('R$ 150 no PIX'), 'o valor errado vira o do catálogo');
  assert.ok(r.text.includes('ou R$ 350'), 'o valor que já estava certo não é mexido');
  // O que se perdia antes: endereço, horário, especialista e PIX.
  assert.ok(r.text.includes('Castelo Branco'));
  assert.ok(r.text.includes('10:00'));
  assert.ok(r.text.includes('Dra. Lays'));
  assert.ok(r.text.includes('60.669.336/0001-73'));
  assert.ok(!/incômodo|doendo/i.test(r.text), 'não volta a pedir triagem de quem já agendou');
});

test('não repete um valor que já está na mensagem', () => {
  const r = aplicarGuardrail('Fica R$ 350 ou R$ 150 à vista — ou R$ 200 parcelado?', unit({}));
  // 350 e 150 já ocupados: sem substituto pro 200, cai no texto de segurança.
  assert.equal(r.rewritten, true);
  assert.ok(r.triggered.some((t) => t.startsWith('preco:')));
});

test('o texto de segurança não pede triagem', () => {
  const r = aplicarGuardrail('Fica R$ 350 ou R$ 150 à vista — ou R$ 200 parcelado?', unit({}));
  assert.ok(!/incômodo|doendo/i.test(r.text));
});

test('preço do catálogo passa', () => {
  const r = aplicarGuardrail('A avaliação é R$ 350, ou R$ 150 à vista no PIX.', unit({}));
  assert.equal(r.rewritten, false);
});

test('parcela plausível de um valor aprovado passa', () => {
  const r = aplicarGuardrail('Dá pra dividir em 3x de R$ 117.', unit({}));
  assert.equal(r.rewritten, false);
});

test('sem preço cadastrado, a trava de preço fica off (fail-open)', () => {
  const r = aplicarGuardrail('Fica R$ 999.', unit({ sourceProdutos: null, category: 'advocacia' }));
  assert.equal(r.rewritten, false);
});

test('mensagem limpa não é tocada', () => {
  const original = 'Oi! Que bom te ver por aqui 😊 Me conta, onde está doendo?';
  const r = aplicarGuardrail(original, unit({}));
  assert.equal(r.rewritten, false);
  assert.equal(r.text, original);
});
