import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { previewComposedPrompt, precosDaConsulta } from './prompt-composer.js';

/**
 * O preço que o bloco <conversao> anuncia.
 *
 * Até 24/09/2026 ele saía do MENOR e do MAIOR "R$" encontrados no cadastro, sem saber a
 * que condição cada número pertencia. Nos prompts reais de produção isso virou:
 *
 *   Serra      "R$ 350, ou R$ 220 no PIX"  — 220 é convênio; particular antecipado é 250
 *   Boa Vista  "R$ 450, ou R$ 100"         — 450 saiu de "se perguntar se paga R$ 450,
 *                                             responda que NÃO"; o real é 350 no total
 *
 * Agora vem de `precosDaConsulta`, o mesmo parser que manda no cartão de confirmação.
 */

const base = {
  slug: 'teste', name: 'Teste', category: 'saude',
  personaCompanyName: 'Clínica Teste',
  spineBookingRequiresPayment: false,
  sourcePapel: null, sourceNegocio: null, sourceDemografia: null,
  systemPrompt: null,
} as unknown as Unit;

const comProdutos = (txt: string, extra: Partial<Unit> = {}) =>
  ({ ...base, sourceProdutos: txt, ...extra }) as Unit;

test('Serra: anuncia o antecipado do PARTICULAR, não o do convênio', () => {
  // Texto real do cadastro da Serra (24/09/2026), encurtado só no que não tem R$.
  const unit = comProdutos(
    'VALOR DA CONSULTA PARTICULAR: R$ 250 com pagamento antecipado por Pix, ou R$ 350 no dia, pago na clínica.\n' +
    'NO DIA DA CONSULTA: R$ 350 para quem é particular, e R$ 250 para quem tem plano de saúde.\n' +
    'PAGO ANTES, por Pix, com pelo menos 24 horas de antecedência:\n' +
    '- Particular: R$ 250\n- Com plano de saúde: R$ 220',
  );
  assert.deepEqual(precosDaConsulta(unit), { antecipado: 250, noDia: 350 });
  const prompt = previewComposedPrompt(unit);
  assert.ok(prompt.includes('R$ 250'), 'o antecipado do particular precisa aparecer');
  // O 220 continua nas Fontes Oficiais (é verdade pra quem tem plano); o que não pode
  // é ele virar O preço que o bloco de conversão manda anunciar.
  const bloco = prompt.match(/<conversao>[\s\S]*?<\/conversao>/)?.[0] ?? '';
  assert.ok(!bloco.includes('R$ 220'), 'o preço de convênio não pode ser o preço anunciado');
});

test('Boa Vista: o sinal é PARTE do total, e o número da negação não entra', () => {
  // Texto real do cadastro de Boa Vista (24/09/2026).
  const unit = comProdutos(
    'A CONSULTA presencial com o especialista: R$ 350 no total, pagos em duas partes — ' +
    'R$ 100 antecipados para garantir o horário e R$ 250 no dia da consulta. ' +
    'Os R$ 100 NÃO são um acréscimo: eles abatem do valor. ' +
    'Se o paciente perguntar se paga R$ 450, responda que não, são R$ 350 no total.',
    { spineBookingRequiresPayment: true } as Partial<Unit>,
  );
  const bloco = previewComposedPrompt(unit).match(/<conversao>[\s\S]*?<\/conversao>/)?.[0] ?? '';
  assert.ok(bloco, 'o bloco de conversão precisa existir');
  assert.ok(!bloco.includes('R$ 450'), 'número dentro de uma negação nunca é preço');
  assert.ok(bloco.includes('R$ 350'), 'a âncora é o total (sinal + o do dia)');
  assert.ok(bloco.includes('R$ 100'), 'o sinal é o que garante o horário');
});

test('"à vista" não sai do bloco — o paciente entende como "à vista na clínica"', () => {
  const unit = comProdutos('VALOR: R$ 250 no dia, pago na clínica, OU R$ 200 com pagamento antecipado por Pix');
  const prompt = previewComposedPrompt(unit);
  assert.ok(!/à vista/i.test(prompt), 'a própria regra da unidade proíbe "à vista"');
});

test('sem par legível, o bloco cala em vez de chutar', () => {
  const unit = comProdutos('A consulta tem valor. Fale com a equipe.');
  assert.equal(precosDaConsulta(unit), null);
  const prompt = previewComposedPrompt(unit);
  assert.ok(!/<conversao>/.test(prompt), 'sem preço confiável, o bloco de conversão não entra');
});
