/**
 * Pronto-socorro indevido (prioridades da IA, 21/10/2026, item 1).
 *
 * De 01 a 20/10 a Sofia mandou paciente ao pronto-socorro em 44 conversas, ~13 sem sinal de alerta de verdade,
 * algumas com consulta paga e horário livre. Regra decidida pelo João: acolher, marcar o sinal de alerta e passar
 * NA HORA para humano; pronto-socorro só se não houver horário HOJE E o paciente disser que a dor está insuportável.
 *
 * O que estes testes prendem no prompt:
 *  - o bloco <sinal_de_alerta> sai para clínica (e só para clínica) com o critério do pronto-socorro;
 *  - "sim" solto a uma pergunta com vários sinais não confirma nada;
 *  - a regra da unidade que cita pronto-socorro ganha a trava da rede (o cadastro em si não muda por aqui);
 *  - a frase de transferência não promete "um instante".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit, UnitAction } from '@prisma/client';

import { composeSystemPrompt, composeSystemPromptParts } from './prompt-composer.js';
import {
  ehHandoffPorSinalDeAlerta,
  renderSinalDeAlerta,
  textoDoAvisoUrgente,
  travaDoProntoSocorro,
} from './sinal-de-alerta.js';
import { renderFaltaParaAgendar } from './falta-para-agendar.js';

function unidade(over: Partial<Unit> = {}): Unit {
  return {
    id: 'u1',
    slug: 'doutor-hernia-teste',
    name: 'Clínica Teste',
    category: 'saude',
    systemPrompt: null,
    sourcePapel: null,
    sourceProdutos: 'Consulta com o especialista: R$ 350 no dia ou R$ 250 antecipado no Pix.',
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

function acao(conditionDescription: string, actions: Array<{ kind: string; params: Record<string, unknown> }>): UnitAction {
  return { id: 'a1', unitId: 'u1', conditionDescription, actions, actionKind: '', actionParams: {}, notes: null, enabled: true } as unknown as UnitAction;
}

const bloco = (p: string) => p.slice(p.indexOf('<sinal_de_alerta>'), p.indexOf('</sinal_de_alerta>'));

test('clínica recebe o bloco do sinal de alerta, nos dois caminhos do prompt', () => {
  const flat = composeSystemPrompt({ unit: unidade() });
  const { cacheable } = composeSystemPromptParts({ unit: unidade() });
  for (const p of [flat, cacheable]) {
    assert.ok(p.includes('<sinal_de_alerta>'), 'o bloco sumiu do prompt');
    assert.match(bloco(p), /PRONTO-SOCORRO: só cite quando as DUAS coisas forem verdade/);
    assert.match(bloco(p), /não há horário HOJE/);
    assert.match(bloco(p), /dor está insuportável/);
    assert.match(bloco(p), /muito\s+menos quem já tem consulta marcada ou paga/);
  }
});

test('fora de clínica o bloco não entra (advocacia, energia solar, sem categoria)', () => {
  for (const category of ['juridico', 'energia_solar', null]) {
    assert.equal(renderSinalDeAlerta({ category } as Unit), '');
    assert.ok(!composeSystemPrompt({ unit: unidade({ category }) }).includes('<sinal_de_alerta>\n'));
  }
});

test('transfere NA HORA, sem pedir licença, avisando a equipe com urgência', () => {
  const b = bloco(composeSystemPrompt({ unit: unidade() }));
  assert.match(b, /transfira NA HORA, sem pedir licença/);
  assert.match(b, /pausar_ia com sinalDeAlerta: true/);
  assert.match(b, /NUNCA prometa prazo da equipe/);
});

test('"sim" solto a uma pergunta com vários sinais não confirma nada', () => {
  const b = bloco(composeSystemPrompt({ unit: unidade() }));
  assert.match(b, /um sinal por pergunta/);
  assert.match(b, /"sim" solto a uma pergunta com vários sinais não\s+confirma nada/);
  // Dor forte sozinha não é sinal de alerta — foi o que mais virou pronto-socorro sem motivo.
  assert.match(b, /Dor forte, dor que piorou[\s\S]*NÃO são sinal de alerta/);

  const triagem = renderFaltaParaAgendar({ queixa: 'dormência na perna' });
  assert.match(triagem, /UMA coisa por vez/);
  assert.match(triagem, /"sim" solto/);
});

test('a régua de estados da rede não manda mais só "transfira" sem critério', () => {
  const p = composeSystemPrompt({ unit: unidade() });
  assert.doesNotMatch(p, /PARE a condução comercial e transfira/);
  assert.match(p, /sinal de alerta clínico\s+→\s+PARE a venda, acolha e transfira NA HORA —\s+pronto-socorro só sem horário hoje E com dor insuportável/);
});

test('regra da unidade que manda ao pronto-socorro ganha a trava da rede', () => {
  const regra = acao('o paciente relatar sinal de alerta (perda de força, perda de controle do xixi)', [
    { kind: 'respond_with_intent', params: { instruction: 'Pergunte se tem perda de força ou de controle do xixi; se sim, oriente procurar um pronto atendimento.' } },
    { kind: 'send_message', params: { text: 'Por precaução, procure a UPA mais próxima.' } },
    { kind: 'transfer_without_permission', params: {} },
  ]);
  const p = composeSystemPrompt({ unit: unidade(), actions: [regra] });
  const acoes = p.slice(p.indexOf('<acoes>'), p.indexOf('</acoes>'));
  assert.equal(acoes.match(/REGRA DA REDE, vale mais que o texto acima/g)?.length, 2, 'as duas falas com pronto-socorro levam a trava');

  // Orientação sem pronto-socorro passa intacta.
  const outra = acao('o paciente perguntar o endereço', [{ kind: 'respond_with_intent', params: { instruction: 'Mande o endereço da clínica.' } }]);
  assert.doesNotMatch(composeSystemPrompt({ unit: unidade(), actions: [outra] }), /REGRA DA REDE/);
});

test('trava do pronto-socorro: pega as formas do cadastro e só elas', () => {
  for (const t of ['procure o pronto-socorro', 'vá ao pronto atendimento', 'procure a UPA', 'busque a emergência', 'Pronto Socorro']) {
    assert.ok(travaDoProntoSocorro(t), `deveria travar: ${t}`);
  }
  for (const t of ['demonstrou urgência no agendamento', 'a consulta é pronta e rápida', 'pague antecipado', '']) {
    assert.equal(travaDoProntoSocorro(t), '', `não deveria travar: ${t}`);
  }
});

test('a frase de transferência não promete "um instante"', () => {
  for (const handoffKeywords of [[], ['atendente', 'humano']]) {
    const p = composeSystemPrompt({ unit: unidade({ handoffEnabled: true, handoffKeywords }) });
    const h = p.slice(p.indexOf('<handoff>'), p.indexOf('</handoff>'));
    assert.ok(h.length > 0);
    assert.doesNotMatch(h, /Um instante/);
    assert.match(h, /sem prometer\s+prazo/);
  }
});

test('motivo da pausa que é sinal de alerta, mesmo sem a flag', () => {
  for (const m of [
    'sinal de alerta clínico: perda de força na perna',
    'red flag — não segura o xixi',
    'perdendo a força nas pernas',
    'incontinência urinária desde ontem',
    'paciente perdeu o controle das fezes',
    'Bandeira vermelha',
  ]) {
    assert.ok(ehHandoffPorSinalDeAlerta(m), `deveria reconhecer: ${m}`);
  }
  for (const m of ['paciente pediu para falar com um humano', 'dor muito forte, quer encaixe hoje', 'dúvida sobre convênio', '']) {
    assert.equal(ehHandoffPorSinalDeAlerta(m), false, `não deveria reconhecer: ${m}`);
  }
  assert.ok(ehHandoffPorSinalDeAlerta('qualquer motivo', true));
});

test('tarefa urgente no formato que o roteador de alertas lê', () => {
  const t = textoDoAvisoUrgente({ slug: 'doutor-hernia-teste', nome: 'Maria', motivo: 'perda de força na perna' });
  assert.match(t, /^ALERTA · doutor-hernia-teste · \[Contato: Maria\] URGENTE: paciente com sinal de alerta clínico \(perda de força na perna\)/);
  assert.doesNotMatch(t, /pronto/i);
  assert.match(textoDoAvisoUrgente({ slug: 's', nome: null, motivo: 'x' }), /^ALERTA · s · URGENTE/);
});
