/**
 * Pronto-socorro indevido (prioridades da IA, 21/10/2026, item 1).
 *
 * De 01 a 20/10 a Sofia mandou paciente ao pronto-socorro em 44 conversas, ~13 sem sinal de alerta de verdade,
 * algumas com consulta paga e horário livre. Regra decidida pelo João: acolher, marcar o sinal de alerta e passar
 * NA HORA para humano; pronto-socorro só se não houver horário HOJE E o paciente disser que a dor está insuportável.
 *
 * Ajuste do João (21/10, à tarde): nos sinais graves da coluna (perder o controle do xixi/fezes, dormência na
 * virilha, perna fraca de repente) a Sofia TENTA AGENDAR o horário mais próximo e avisa a equipe na hora, sem
 * pausar antes de tentar. Só transfere se ele recusar, não houver horário até amanhã ou a conversa travar.
 *
 * O que estes testes prendem no prompt:
 *  - o bloco <sinal_de_alerta> sai para clínica (e só para clínica) com o critério do pronto-socorro;
 *  - sinal grave da coluna: agendar + avisar, sem pausar antes; outros sinais: transferir na hora;
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
    assert.match(bloco(p), /o sinal, sozinho, NÃO é motivo de pronto-socorro/);
    assert.match(bloco(p), /Só cite pronto-socorro quando as\s+DUAS coisas forem verdade/);
    assert.match(bloco(p), /não há horário HOJE/);
    assert.match(bloco(p), /dor está insuportável/);
    assert.match(bloco(p), /muito menos para quem já tem consulta marcada ou paga/);
  }
});

test('fora de clínica o bloco não entra (advocacia, energia solar, sem categoria)', () => {
  for (const category of ['juridico', 'energia_solar', null]) {
    assert.equal(renderSinalDeAlerta({ category } as Unit), '');
    assert.ok(!composeSystemPrompt({ unit: unidade({ category }) }).includes('<sinal_de_alerta>\n'));
  }
});

test('sinal grave da coluna: tenta agendar o horário mais próximo e avisa a equipe, sem pausar antes', () => {
  const b = bloco(composeSystemPrompt({ unit: unidade() }));
  const graves = b.slice(b.indexOf('SINAIS GRAVES DA COLUNA'), b.indexOf('OUTROS SINAIS DE ALERTA'));
  assert.match(graves, /perder o controle do xixi ou das fezes/);
  assert.match(graves, /região da sela/);
  assert.match(graves, /perna que ficou fraca de repente/);
  assert.match(graves, /TENTE AGENDAR/);
  assert.match(graves, /horário mais próximo, priorizando hoje e amanhã/);
  assert.match(graves, /chame avisar_sinal_de_alerta/);
  assert.match(graves, /NÃO pausa a IA. Não chame pausar_ia antes de tentar agendar/);
  // A ordem: acolher → agendar → avisar.
  assert.ok(graves.indexOf('(1) acolha') < graves.indexOf('(2) TENTE AGENDAR'));
  assert.ok(graves.indexOf('(2) TENTE AGENDAR') < graves.indexOf('(3) no MESMO turno'));
  // Só transfere se ele recusar, não houver horário até amanhã ou travar.
  assert.match(graves, /Só transfira[\s\S]*se ele recusar[\s\S]*não houver horário até amanhã[\s\S]*a conversa travar/);
});

test('outros sinais de alerta seguem transferindo na hora', () => {
  const b = bloco(composeSystemPrompt({ unit: unidade() }));
  const outros = b.slice(b.indexOf('OUTROS SINAIS DE ALERTA'), b.indexOf('PRONTO-SOCORRO:'));
  assert.match(outros, /queda ou pancada forte/);
  assert.match(outros, /transfira NA HORA, sem pedir licença/);
  assert.match(outros, /pausar_ia com\s+sinalDeAlerta: true/);
});

test('nunca desaconselha o pronto-socorro se o paciente quiser ir, e não promete prazo', () => {
  const b = bloco(composeSystemPrompt({ unit: unidade() }));
  assert.match(b, /Se o próprio paciente disser que vai ao pronto-socorro[\s\S]*NUNCA desaconselhe/);
  assert.match(b, /NUNCA prometa prazo da equipe/);
});

test('"sim" solto a uma pergunta com vários sinais não confirma nada', () => {
  const b = bloco(composeSystemPrompt({ unit: unidade() }));
  assert.match(b, /um sinal por pergunta/);
  assert.match(b, /"sim" solto a uma pergunta com vários sinais não\s+confirma nada/);
  // Dor forte sozinha não é sinal de alerta — foi o que mais virou pronto-socorro sem motivo.
  assert.match(b, /NÃO É sinal de alerta: dor forte, dor que piorou/);

  const triagem = renderFaltaParaAgendar({ queixa: 'dormência na perna' });
  assert.match(triagem, /UMA coisa por vez/);
  assert.match(triagem, /"sim" solto/);
});

test('a régua de estados da rede não manda mais só "transfira" sem critério', () => {
  const p = composeSystemPrompt({ unit: unidade() });
  assert.doesNotMatch(p, /PARE a condução comercial e transfira/);
  assert.match(
    p,
    /sinal de alerta clínico\s+→\s+acolher; sinal grave da coluna: oferecer o\s+horário mais próximo e avisar a equipe; outros\s+sinais: transferir NA HORA\. Pronto-socorro só\s+sem horário hoje E com dor insuportável/,
  );
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
  // A regra disparada por sinal de alerta manda transferir de cara: nos sinais graves, tenta agendar antes.
  assert.match(acoes, /REGRA DA REDE, vale mais que esta regra: nos SINAIS GRAVES DA COLUNA não transfira nem pause antes de\s*tentar agendar/);

  // Orientação sem pronto-socorro, numa regra que não é de sinal de alerta, passa intacta.
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
  // Sinal grave da coluna: a IA segue agendando — a equipe sabe que não foi transferido.
  const agendando = textoDoAvisoUrgente({ slug: 's', nome: 'Ana', motivo: 'não segura o xixi', situacao: 'agendando' });
  assert.match(agendando, /URGENTE: paciente com sinal de alerta clínico \(não segura o xixi\)\. A IA está oferecendo o horário mais próximo/);
  assert.doesNotMatch(agendando, /parou/);
});
