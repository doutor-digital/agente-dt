/**
 * Auditoria de Araguaína (21/10/2026), item 4: a pergunta do preço das SESSÕES ficou sem resposta.
 *
 * Lead 28743362, 17/10: "Sinto dor do pescoço descendo pro braço", "Queria saber quanto custa as sessões", "?".
 * A Sofia perguntou há quanto tempo, disse "Claro, já te explico tudinho!", perguntou da dor de novo e, depois que
 * a paciente contou das três hérnias, foi para "Você é de Araguaína mesmo ou de outra cidade?". Nunca respondeu.
 *
 * Regra do João (21/10): nunca ignorar. Se as fontes da unidade têm o valor das sessões/do tratamento, dizer esse
 * valor; se não, dizer com franqueza que o plano e o valor do tratamento são definidos na consulta com o nosso
 * especialista, depois que ele examina — e dar o valor da consulta. E o bloco do preço insistido (#101) não pode
 * responder "sessões" com o valor da consulta como se fosse a mesma coisa.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import {
  perguntaPreco,
  perguntaPrecoDasSessoes,
  precoDasSessoesEmAberto,
  renderPrecoDasSessoes,
  renderPrecoInsistido,
} from './preco-insistido.js';
import { composeSystemPrompt, composeSystemPromptParts } from './prompt-composer.js';
import type { Fala } from './repeticao.js';

const p = (texto: string): Fala => ({ papel: 'paciente', texto });
const ia = (texto: string): Fala => ({ papel: 'ia', texto });

const FRASE = 'R$ 350 no dia, ou R$ 250 pagando antes no Pix';

/** A conversa real, turno a turno (a rajada das 17:28–17:29 chegou num turno só). */
const ARAGUAINA: Fala[] = [
  p('Boa tarde'),
  ia('Boa tarde! Que bom ter você por aqui na Doutor Hérnia Araguaína! Como posso te chamar?'),
  p('Thayane'),
  ia('Prazer, Thayane! Me conta: onde você está sentindo dor e há quanto tempo isso vem incomodando você?'),
  p('Sinto dor do pescoço descendo pro braço\n\nQueria saber quanto custa as sessões\n\n?'),
];

function unidade(over: Partial<Unit> = {}): Unit {
  return {
    id: 'u-aragua',
    slug: 'doutor-hernia-araguaina',
    name: 'Doutor Hérnia Araguaína',
    category: 'saude',
    systemPrompt: null,
    sourcePapel: null,
    sourceProdutos: 'Consulta com o especialista: R$ 350 no dia ou R$ 250 antecipado no Pix. Atendimento particular.',
    sourceNegocio: null,
    sourceDemografia: null,
    personaCompanyName: null,
    personaTone: null,
    personaGreeting: null,
    personaResponseLength: 'normal',
    personaLanguage: 'pt-BR',
    personaEmojis: [],
    handoffKeywords: [],
    handoffEnabled: false,
    pipelineIntents: null,
    spineEnabled: false,
    qualificationEnabled: false,
    triageEnabled: false,
    collectNameEnabled: false,
    ...over,
  } as unknown as Unit;
}

test('item 4: o que é pergunta do preço das sessões (e não da consulta)', () => {
  for (const t of [
    'Queria saber quanto custa as sessões',
    'qual o valor das sessões?',
    'Quanto é cada sessão',
    'quanto fica o tratamento?',
    'e o valor do tratamento?',
    'Quanto custa a consulta e as sessões?',
  ]) {
    assert.ok(perguntaPreco(t), `é pergunta de preço: ${t}`);
    assert.ok(perguntaPrecoDasSessoes(t), `é das sessões: ${t}`);
  }
  for (const t of ['Quanto custa a consulta?', 'Qual o valor?', 'Quantas sessões são?', 'o tratamento dói?']) {
    assert.ok(!perguntaPrecoDasSessoes(t), `não é preço das sessões: ${t}`);
  }
});

test('item 4: o caso real — a pergunta fica em aberto, e ela já contou da dor', () => {
  const aberto = precoDasSessoesEmAberto(ARAGUAINA);
  assert.ok(aberto);
  assert.equal(aberto.pergunta, 'Queria saber quanto custa as sessões');
  assert.equal(aberto.jaContouADor, true);
  assert.equal(aberto.ignorada, false);

  const b = renderPrecoDasSessoes(ARAGUAINA, { frase: FRASE });
  assert.match(b, /<preco_das_sessoes>/);
  assert.match(b, /> "Queria saber quanto custa as sessões"/);
  assert.match(b, /NUNCA ignore esta pergunta/);
  assert.match(b, /Se as suas fontes trazem o valor das sessões ou do tratamento, diga ESSE valor/);
  assert.match(b, /o plano e o valor do tratamento são definidos na consulta com o nosso\s+especialista, depois que ele examina/);
  assert.match(b, /A consulta com o nosso especialista é R\$ 350 no dia, ou R\$ 250 pagando antes no Pix/);
  assert.match(b, /PRIMEIRA frase/, 'já sabe da dor: responde agora');
  assert.doesNotMatch(b, /avaliação/);
});

test('item 4: ignorada uma vez, continua em aberto no turno seguinte e cobra a resposta já', () => {
  const falas = [
    ...ARAGUAINA,
    ia('Entendi, Thayane, isso parece bem incômodo mesmo. Há quanto tempo você sente isso, e tem te atrapalhado em alguma coisa?'),
    p('Tá atrapalhando dormir'),
  ];
  const aberto = precoDasSessoesEmAberto(falas);
  assert.equal(aberto?.ignorada, true);
  assert.match(renderPrecoDasSessoes(falas, { frase: FRASE }), /JÁ ficou sem resposta\. Responda AGORA/);
  // falar de "tratamento" sem falar de valor não é responder ("na consulta a especialista avalia… o foco é o
  // tratamento conservador", a fala real das 17:31)
  const semValor = [
    ...falas,
    ia('Mas se acalma: na consulta a especialista explica o que está acontecendo — aqui o foco é o tratamento conservador. Você é de Araguaína?'),
    p('Sou sim'),
  ];
  assert.ok(precoDasSessoesEmAberto(semValor));
});

test('item 4: respondida (valor do tratamento definido na consulta), o bloco some', () => {
  const falas = [
    ...ARAGUAINA,
    ia('Thayane, o plano e o valor do tratamento são definidos na consulta com o nosso especialista, depois que ele examina. A consulta é R$ 350 no dia, ou R$ 250 antecipado no Pix. Quer que eu veja um horário?'),
    p('Quero sim'),
  ];
  assert.equal(precoDasSessoesEmAberto(falas), null);
  assert.equal(renderPrecoDasSessoes(falas, { frase: FRASE }), '');
});

test('item 4: primeira pergunta, sem saber da dor: "dor primeiro", mas sem ignorar', () => {
  const falas = [p('Boa tarde'), ia('Boa tarde! Como posso te chamar?'), p('Ana. Quanto custa as sessões?')];
  const b = renderPrecoDasSessoes(falas, { frase: FRASE });
  assert.match(b, /diga numa frase que já explica o valor do tratamento e faça UMA pergunta\s+sobre a dor/);
  assert.match(b, /Na resposta seguinte, responda o valor sem falta/);
  assert.doesNotMatch(b, /PRIMEIRA frase/);
});

test('item 4: o bloco do preço insistido não responde "sessões" com o valor da consulta', () => {
  const falas = [
    ...ARAGUAINA,
    ia('Claro, já te explico tudinho! Só pra eu te orientar certo: há quanto tempo você sente essa dor?'),
    p('Já tem duas semanas. Mas quanto custa as sessões?'),
  ];
  assert.equal(renderPrecoInsistido(falas, { frase: FRASE }), '', 'quem responde é o bloco das sessões');
  assert.match(renderPrecoDasSessoes(falas, { frase: FRASE }), /<preco_das_sessoes>/);
  // pergunta de preço da CONSULTA repetida segue no bloco de sempre
  const consulta = [p('Qual o valor da consulta?'), ia('Claro! Onde dói?'), p('Qual o valor da consulta??')];
  assert.match(renderPrecoInsistido(consulta, { frase: FRASE }), /<preco_insistido>/);
  assert.equal(renderPrecoDasSessoes(consulta, { frase: FRASE }), '');
});

test('item 4: sem o valor da consulta nas fontes, manda dizer o que está nas fontes (sem número inventado)', () => {
  const b = renderPrecoDasSessoes(ARAGUAINA, { frase: null });
  assert.match(b, /o valor da consulta com o nosso especialista que está nas suas fontes/);
  assert.doesNotMatch(b, /R\$/);
});

test('item 4: no prompt do turno, só para clínica, nos dois caminhos', () => {
  const unit = unidade();
  const { dynamic } = composeSystemPromptParts({ unit, leadId: 28743362, userMessage: ARAGUAINA[4].texto, historico: ARAGUAINA });
  assert.match(dynamic, /<preco_das_sessoes>[\s\S]*A consulta com o nosso especialista é R\$ 350 no dia, ou R\$ 250 pagando antes no Pix/);
  assert.match(composeSystemPrompt({ unit, historico: ARAGUAINA }), /<preco_das_sessoes>/);
  const fora = composeSystemPromptParts({ unit: unidade({ category: 'advocacia' } as Partial<Unit>), leadId: 1, historico: ARAGUAINA });
  assert.doesNotMatch(fora.dynamic, /<preco_das_sessoes>/);
});
