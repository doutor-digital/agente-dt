/**
 * Sinal de alerta e pronto-socorro (decisão do João, 26/10/2026 — itens 1 e 2 da conferência da Suzanne).
 *
 * Substitui as regras de 21/10 ("tentar agendar antes", "pronto-socorro só sem horário hoje + dor insuportável"):
 *  - sinal de alerta (perder força na perna, não segurar xixi/fezes, dormência entre as pernas, dor que piorou de
 *    repente, febre com dor, queda/pancada recente) → a IA PARA na hora: resumir + pausar_ia com sinalDeAlerta;
 *  - a Sofia NUNCA sugere pronto-socorro/UPA/hospital/emergência, nem opina sobre médico ou cirurgia;
 *  - se o próprio paciente perguntar se deve ir, ou disser que vai, ela não desaconselha.
 *
 * O que estes testes prendem no prompt:
 *  - o bloco <sinal_de_alerta> sai para clínica (e só para clínica);
 *  - confirmado o sinal, a ordem é parar (nada de agendar antes);
 *  - "sim" solto a uma pergunta com vários sinais não confirma nada (fala VAGA pergunta um sinal só);
 *  - a regra da unidade e a mensagem pronta que citam pronto-socorro ganham a trava da rede;
 *  - a frase de transferência não promete "um instante".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit, UnitAction } from '@prisma/client';

import { composeSystemPrompt, composeSystemPromptParts } from './prompt-composer.js';
import {
  comLigarAgora,
  ehHandoffPorSinalDeAlerta,
  ETIQUETA_PRIORIDADE,
  renderSinalDeAlerta,
  TAREFA_URGENTE,
  textoDoAvisoUrgente,
  textoTelegramSinalDeAlerta,
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
    assert.match(bloco(p), /decisão do João, 26\/10/);
  }
});

test('fora de clínica o bloco não entra (advocacia, energia solar, sem categoria)', () => {
  for (const category of ['juridico', 'energia_solar', null]) {
    assert.equal(renderSinalDeAlerta({ category } as Unit), '');
    assert.ok(!composeSystemPrompt({ unit: unidade({ category }) }).includes('<sinal_de_alerta>\n'));
  }
});

test('confirmado o sinal, a IA para na hora: resumir, pausar com a flag, uma frase — sem tentar agendar', () => {
  const b = bloco(composeSystemPrompt({ unit: unidade() }));
  // Os sinais da decisão de 26/10.
  assert.match(b, /perdeu força na perna/);
  assert.match(b, /não consegue segurar o xixi ou as fezes/);
  assert.match(b, /dormência ou adormecimento na virilha, entre as pernas ou na região íntima/);
  assert.match(b, /PIOROU DE REPENTE/);
  assert.match(b, /febre junto com a dor/);
  assert.match(b, /queda,\s+pancada ou acidente RECENTE/);
  const parar = b.slice(b.indexOf('CONFIRMADO O SINAL'), b.indexOf('QUANDO A FALA É CLARA'));
  assert.match(parar, /A IA PARA NA HORA/);
  assert.match(parar, /Nada de oferecer horário, de "tentar agendar antes"/);
  assert.match(parar, /pausar_ia com sinalDeAlerta: true/);
  assert.match(parar, /🔴 PRIORIDADE/);
  assert.match(parar, /LIGAR AGORA/);
  assert.match(parar, /Não chame consultar_horarios nem agendar_consulta/);
  // A ordem: resumir → pausar → responder.
  assert.ok(parar.indexOf('(1) resumir_lead_para_sdr') < parar.indexOf('(2) pausar_ia'));
  assert.ok(parar.indexOf('(2) pausar_ia') < parar.indexOf('(3) responda UMA frase'));
  // O que saiu em 26/10 não pode voltar.
  assert.doesNotMatch(b, /TENTE AGENDAR|avisar_sinal_de_alerta|OUTROS SINAIS DE ALERTA|SINAIS GRAVES DA COLUNA/);
  assert.doesNotMatch(b, /dor está insuportável|não há horário HOJE/);
});

test('pronto-socorro: a Sofia nunca sugere; se o paciente perguntar ou disser que vai, não desaconselha', () => {
  const b = bloco(composeSystemPrompt({ unit: unidade() }));
  assert.match(b, /NUNCA sugere pronto-socorro, UPA, hospital, SAMU ou emergência por conta própria/);
  assert.match(b, /Não há exceção sua/);
  assert.match(b, /Se o PRÓPRIO paciente perguntar se deve ir ao pronto-socorro, ou disser que vai: NUNCA desaconselhe/);
  assert.match(b, /se ele sente que não dá para esperar, pode ir, e que a equipe já foi avisada/);
  assert.match(b, /NUNCA prometa prazo da equipe/);
});

test('nunca opina sobre médico nem sobre cirurgia (nem "caminho cirúrgico")', () => {
  const p = composeSystemPrompt({ unit: unidade() });
  assert.match(bloco(p), /MÉDICO E CIRURGIA: você NUNCA opina sobre médico[\s\S]*nem sobre cirurgia[\s\S]*"caminho cirúrgico"/);
  // O funil de vendas também: a frase "muita gente chega achando que é cirurgia e não é" era opinião sobre cirurgia.
  assert.doesNotMatch(p, /achando\s+que é cirurgia e não é/);
  assert.match(p, /nem fala em "caminho cirúrgico", nem opina sobre\s+médico/);
  assert.match(p, /Sugerir pronto-socorro, UPA, hospital ou emergência, ou opinar sobre médico ou cirurgia/);
});

test('"sim" solto a uma pergunta com vários sinais não confirma nada', () => {
  const b = bloco(composeSystemPrompt({ unit: unidade() }));
  assert.match(b, /UM sinal só/);
  assert.match(b, /"sim" solto a uma\s+pergunta com vários sinais não confirma nada/);
  // Fala clara não pergunta de novo: "não estou segurando o xixi" já é o sinal.
  assert.match(b, /"não estou segurando o xixi", "minha perna está perdendo força"\), é sinal\s+confirmado: não pergunte de novo, pare/);
  // Dor forte sozinha não é sinal de alerta — foi o que mais virou pronto-socorro sem motivo.
  assert.match(b, /NÃO É sinal de alerta: dor forte, dor que piorou aos poucos/);

  const triagem = renderFaltaParaAgendar({ queixa: 'dormência na perna' });
  assert.match(triagem, /UMA coisa por vez/);
  assert.match(triagem, /"sim" solto/);
});

test('a régua de estados da rede manda parar, sem exceção de pronto-socorro', () => {
  const p = composeSystemPrompt({ unit: unidade() });
  assert.doesNotMatch(p, /PARE a condução comercial e transfira/);
  assert.match(
    p,
    /sinal de alerta clínico\s+→\s+acolher em UMA frase e PARAR: resumir e\s+pausar_ia com sinalDeAlerta: true\. Nunca\s+sugira pronto-socorro/,
  );
  assert.doesNotMatch(p, /Pronto-socorro só\s+sem horário hoje/);
});

test('regra da unidade que manda ao pronto-socorro ganha a trava da rede', () => {
  const regra = acao('o paciente relatar sinal de alerta (perda de força, perda de controle do xixi)', [
    { kind: 'respond_with_intent', params: { instruction: 'Pergunte se tem perda de força ou de controle do xixi; se sim, oriente procurar um pronto atendimento.' } },
    { kind: 'send_message', params: { text: 'Por precaução, procure a UPA mais próxima.' } },
    { kind: 'transfer_without_permission', params: {} },
  ]);
  const p = composeSystemPrompt({ unit: unidade(), actions: [regra] });
  const acoes = p.slice(p.indexOf('<acoes>\n'), p.indexOf('</acoes>'));
  assert.equal(acoes.match(/REGRA DA REDE, vale mais que o texto acima/g)?.length, 2, 'as duas falas com pronto-socorro levam a trava');
  assert.match(acoes, /NUNCA sugira pronto-socorro, UPA, hospital ou emergência por conta própria/);
  assert.doesNotMatch(acoes, /insuportável/, 'a exceção de 21/10 saiu');
  // A regra disparada por sinal de alerta manda transferir de cara: agora a ordem da rede é parar, sem agendar antes.
  assert.match(acoes, /REGRA DA REDE, vale mais que esta regra: confirmado o sinal, PARE na hora — nada de tentar agendar nem\s+de oferecer horário antes/);
  assert.match(acoes, /pausar_ia com\s+sinalDeAlerta: true \(isso etiqueta 🔴 PRIORIDADE e cria a tarefa LIGAR AGORA\)/);
  assert.doesNotMatch(acoes, /avisar_sinal_de_alerta/);

  // Orientação sem pronto-socorro, numa regra que não é de sinal de alerta, passa intacta.
  const outra = acao('o paciente perguntar o endereço', [{ kind: 'respond_with_intent', params: { instruction: 'Mande o endereço da clínica.' } }]);
  assert.doesNotMatch(composeSystemPrompt({ unit: unidade(), actions: [outra] }), /REGRA DA REDE/);
});

test('a regra da unidade de febre/dormência/dor de repente também ganha a ordem de parar', () => {
  for (const condicao of ['o paciente relatar febre junto com a dor', 'houver dormência na região íntima', 'a dor piorar de repente']) {
    const regra = acao(condicao, [{ kind: 'transfer_without_permission', params: {} }]);
    const p = composeSystemPrompt({ unit: unidade(), actions: [regra] });
    assert.match(p.slice(p.indexOf('<acoes>\n'), p.indexOf('</acoes>')), /confirmado o sinal, PARE na hora/, condicao);
  }
});

test('trava do pronto-socorro: pega as formas do cadastro e só elas', () => {
  for (const t of ['procure o pronto-socorro', 'vá ao pronto atendimento', 'procure a UPA', 'busque a emergência', 'Pronto Socorro', 'ligue para o SAMU']) {
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
    'não está segurando o xixi',
    'dormência na região íntima',
    'a dor piorou de repente',
    'febre com dor lombar',
  ]) {
    assert.ok(ehHandoffPorSinalDeAlerta(m), `deveria reconhecer: ${m}`);
  }
  for (const m of ['paciente pediu para falar com um humano', 'dor muito forte, quer encaixe hoje', 'dúvida sobre convênio', '']) {
    assert.equal(ehHandoffPorSinalDeAlerta(m), false, `não deveria reconhecer: ${m}`);
  }
  assert.ok(ehHandoffPorSinalDeAlerta('qualquer motivo', true));
});

test('tarefa urgente no formato que o roteador de alertas lê, com LIGAR AGORA', () => {
  const t = textoDoAvisoUrgente({ slug: 'doutor-hernia-teste', nome: 'Maria', motivo: 'perda de força na perna' });
  assert.match(t, /^ALERTA · doutor-hernia-teste · \[Contato: Maria\] LIGAR AGORA — URGENTE: paciente com sinal de alerta clínico \(perda de força na perna\)/);
  assert.match(t, /A IA parou e passou o atendimento para a equipe — ligar para o paciente agora\./);
  assert.doesNotMatch(t, /pronto/i);
  assert.match(textoDoAvisoUrgente({ slug: 's', nome: null, motivo: 'x' }), /^ALERTA · s · LIGAR AGORA — URGENTE/);
  // A tarefa continua casando com a regra que evita duas tarefas urgentes no mesmo turno.
  assert.ok(TAREFA_URGENTE.test(t));
});

test('tarefa de sinal de alerta escrita pela regra da unidade ganha o LIGAR AGORA no fim', () => {
  assert.equal(
    comLigarAgora('ALERTA · s · [Contato: Ana] URGENTE: paciente com sinal de alerta clínico'),
    'ALERTA · s · [Contato: Ana] URGENTE: paciente com sinal de alerta clínico — LIGAR AGORA',
  );
  // Já tem: não duplica. Tarefa comum: intacta.
  const ja = textoDoAvisoUrgente({ slug: 's', nome: 'Ana', motivo: 'x' });
  assert.equal(comLigarAgora(ja), ja);
  assert.equal(comLigarAgora('Ligar amanhã para confirmar'), 'Ligar amanhã para confirmar');
});

test('Telegram do João diz LIGAR AGORA e leva o link do cartão', () => {
  const t = textoTelegramSinalDeAlerta({ unidade: 'Olímpia', subdominio: 'dholimpia', leadId: 5878155, nome: 'Lizie', motivo: 'escape de urina' });
  assert.match(t, /^🚑 Sinal de alerta · Olímpia · LIGAR AGORA/);
  assert.match(t, /Lizie — escape de urina\. A IA parou e passou para a equipe\./);
  assert.match(t, /https:\/\/dholimpia\.kommo\.com\/leads\/detail\/5878155/);
});

test('a etiqueta é a que a Suzanne confere', () => {
  assert.equal(ETIQUETA_PRIORIDADE, '🔴 PRIORIDADE');
});
