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

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { composeSystemPrompt, composeSystemPromptParts, escolherBase } from './prompt-composer.js';
import {
  chamadasDoTurno,
  comLigarAgora,
  falasDoTurno,
  fraseDoPasse,
  pausaDoTurno,
  ehClinicaParaSinalDeAlerta,
  ehTarefaDeSinal,
  ehHandoffPorSinalDeAlerta,
  ETIQUETA_PRIORIDADE,
  renderSinalDeAlerta,
  sinalNaFala,
  soFalaDoPaciente,
  TAREFA_URGENTE,
  textoDoAvisoUrgente,
  textoTelegramSinalDeAlerta,
  travaDoProntoSocorro,
  travarProntoSocorroPorLinha,
} from './sinal-de-alerta.js';
import { pacienteFalouDePs } from './sem-pronto-socorro.js';
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
  for (const category of ['juridico', 'energia_solar']) {
    assert.equal(renderSinalDeAlerta({ category } as Unit), '');
    assert.ok(!composeSystemPrompt({ unit: unidade({ category }) }).includes('<sinal_de_alerta>\n'));
  }
});

test('categoria em branco é clínica para o sinal de alerta (12 unidades ativas estavam sem o bloco)', () => {
  for (const category of [null, '', '  ']) {
    assert.ok(renderSinalDeAlerta({ category } as Unit).includes('<sinal_de_alerta>'), String(category));
    assert.ok(ehClinicaParaSinalDeAlerta({ category } as Unit));
  }
  assert.ok(ehClinicaParaSinalDeAlerta({ category: 'saude' } as Unit));
  assert.ok(!ehClinicaParaSinalDeAlerta({ category: 'juridico' } as Unit));
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
    // Mossoró #5876373 (25/10): a pausa por "conversa travada" não tinha a flag e não avisou ninguém
    'conversa travada: pergunta de segurança da coluna (força na perna, xixi/intestino) 2x sem resposta',
    'suspeita de AVC, braço tremendo',
    'boca torta e fala enrolada',
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
  // Negação ("sem sinal de alerta") e tarefa comum: intactas.
  assert.equal(comLigarAgora('Retorno: paciente sem sinal de alerta, agendar avaliação'), 'Retorno: paciente sem sinal de alerta, agendar avaliação');
  // Já tem: não duplica.
  const ja = textoDoAvisoUrgente({ slug: 's', nome: 'Ana', motivo: 'x' });
  assert.equal(comLigarAgora(ja), ja);
  assert.equal(comLigarAgora('Ligar amanhã para confirmar'), 'Ligar amanhã para confirmar');
});

test('tarefa da regra da unidade com "red flag" também conta como o aviso urgente (sem tarefa em dobro)', () => {
  assert.ok(ehTarefaDeSinal('ALERTA · s · red flag confirmado'));
  assert.ok(ehTarefaDeSinal('ALERTA · s · sinal de alerta clínico'));
  assert.ok(!ehTarefaDeSinal('Ligar amanhã para confirmar'));
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

// ── A rede de segurança em código ───────────────────────────────────────────────────────────────────────

test('sinalNaFala: pega o sinal dito com todas as letras (os casos da conferência da Suzanne)', () => {
  const claros: Array<[string, RegExp]> = [
    ['não estou segurando o xixi', /não segura o xixi/],
    ['ontem eu não segurei o xixi, tô assustada', /não segura o xixi/],
    ['não consigo segurar as fezes', /não segura o xixi ou as fezes/],
    ['perdi o controle da urina', /perdeu o controle/],
    ['tive um escape de urina', /escape de xixi/],
    ['fiz xixi na calça sem sentir', /escape de xixi/],
    ['minha perna está perdendo força', /perda de força/],
    ['perdi a força na perna esquerda', /perda de força/],
    ['minha perna esquerda tá ficando fraca', /perda de força/],
    ['a perna está sem força', /perda de força/],
    ['sinto dormência na região íntima', /dormência na região íntima/],
    ['fica dormente na virilha', /dormência na região íntima/],
    ['dormência entre as pernas', /dormência na região íntima/],
    ['a dor piorou de repente', /piorou de repente/],
    ['estou com febre e muita dor nas costas', /febre junto com a dor/],
  ];
  for (const [fala, esperado] of claros) {
    const r = sinalNaFala([fala]);
    assert.ok(r, `deveria pegar: ${fala}`);
    assert.match(r, esperado, fala);
  }
});

test('sinalNaFala: negação, dor comum e fala vaga NÃO disparam', () => {
  for (const fala of [
    'não tenho perda de força',
    'sem dormência na virilha',
    'não, não perdi o controle do xixi',
    'consigo segurar o xixi normal',
    'minha perna não está fraca',
    'formigamento nas pernas e dormência nas pernas',
    'dor forte na lombar há 3 meses',
    'a dor piorou aos poucos',
    'tive febre mês passado, mas agora estou bem',
    'me faltaram as pernas ontem', // vaga: o modelo pergunta UM sinal
    'perdi a força de vontade de fazer qualquer coisa',
    'oi, vim pelo anúncio',
    '',
  ]) {
    if (/febre/.test(fala)) continue; // febre sem dor no mesmo turno é o caso de baixo
    assert.equal(sinalNaFala([fala]), null, fala);
  }
  assert.equal(sinalNaFala(['tive febre ontem']), null, 'febre sem dor não conta');
  assert.equal(sinalNaFala(['não estou com febre, só dor nas costas']), null);
  assert.equal(sinalNaFala(['sem febre, mas com dor']), null);
});

test('falasDoTurno: só as mensagens do paciente que ainda não tiveram resposta', () => {
  const h = (texto: string) => ({ tipo: 'human', texto });
  const ia = (texto: string) => ({ tipo: 'ai', texto });
  assert.deepEqual(falasDoTurno([h('antiga: perdi a força na perna'), ia('oi'), h('boa noite'), h('queria marcar')]), ['boa noite', 'queria marcar']);
  // depois de ferramentas deste turno
  assert.deepEqual(falasDoTurno([ia('oi'), h('não seguro o xixi'), ia(''), { tipo: 'tool', texto: 'OK' }]), ['não seguro o xixi']);
  assert.deepEqual(falasDoTurno([]), []);
  assert.deepEqual(falasDoTurno([ia('oi')]), []);
});

test('sinalNaFala: a negação só vale quando é do próprio sintoma (achados da revisão)', () => {
  assert.ok(sinalNaFala(['não aguento mais e perdi a força na perna']), '"não aguento" não nega a perda de força');
  assert.ok(sinalNaFala(['fiquei sem aguentar nada, nem andar e perdi a força nas pernas']));
  assert.ok(sinalNaFala(['não sei o que fazer, minha perna está perdendo força']));
  assert.equal(sinalNaFala(['não estou com dormência na virilha']), null);
  assert.equal(sinalNaFala(['nem perdi a força na perna']), null);
  // febre: cada ocorrência vale, e a de outra pessoa não
  assert.ok(sinalNaFala(['não tive febre mas tenho dor nas costas, depois tive febre e dor']));
  assert.equal(sinalNaFala(['meu filho está com febre, eu só tenho dor nas costas']), null);
});

test('sinalNaFala: negação de uma mensagem não cala o sinal da mensagem seguinte (achado do Codex)', () => {
  assert.ok(sinalNaFala(['não tenho dormência na virilha', 'agora estou com dormência na virilha']));
  assert.ok(sinalNaFala(['não tenho dormência', 'agora estou com dormência na virilha']));
  assert.ok(sinalNaFala(['sem febre', 'agora estou com febre e dor nas costas']));
  assert.equal(sinalNaFala(['sem febre, mas com dor nas costas']), null);
});

test('sinalNaFala: dormência no glúteo é ciática comum, e o sinal numa oração nova não é calado pela negação da anterior', () => {
  assert.equal(sinalNaFala(['sinto dormência no glúteo']), null);
  assert.ok(sinalNaFala(['não tenho dormência na virilha, mas perdi a força na perna']));
  assert.ok(sinalNaFala(['não tenho dormência na virilha mas perdi a força na perna']));
});

test('sinalNaFala: perda de força no braço, na mão ou de vontade não é o sinal da coluna', () => {
  for (const f of ['perdi a força no braço', 'perdeu a força na mão direita', 'perdi a força de vontade', 'perda de força nas mãos']) {
    assert.equal(sinalNaFala([f]), null, f);
  }
  for (const f of ['perdi a força nas pernas', 'perdi a força na perna esquerda']) {
    assert.ok(sinalNaFala([f]), f);
  }
});

test('pausaDoTurno: só a pausa que deu OK conta; pausar sem a flag e sem motivo de sinal não é aviso urgente', () => {
  assert.deepEqual(pausaDoTurno([]), { pausou: false, urgente: false });
  assert.deepEqual(pausaDoTurno([{ name: 'pausar_ia', args: { motivo: 'quer falar com humano' }, resultado: 'OK — IA pausada' }]), { pausou: true, urgente: false });
  assert.deepEqual(pausaDoTurno([{ name: 'pausar_ia', args: { motivo: 'x', sinalDeAlerta: true }, resultado: 'OK — IA pausada' }]), { pausou: true, urgente: true });
  assert.deepEqual(pausaDoTurno([{ name: 'pausar_ia', args: { motivo: 'red flag: perda de força' }, resultado: 'OK — IA pausada' }]), { pausou: true, urgente: true });
  // a pausa falhou DEPOIS do aviso: a equipe foi avisada, a IA não parou
  assert.deepEqual(pausaDoTurno([{ name: 'pausar_ia', args: { motivo: 'x', sinalDeAlerta: true }, resultado: 'ERRO ao pausar IA: x' }]), { pausou: false, urgente: true });
  // o safety-net do "sem vaga" recusou a pausa: nem pausou nem avisou
  assert.deepEqual(pausaDoTurno([{ name: 'pausar_ia', args: { motivo: 'sem vaga' }, resultado: 'PAUSA NÃO APLICADA. Você afirmou…' }]), { pausou: false, urgente: false });
  assert.deepEqual(pausaDoTurno([{ name: 'criar_tarefa' }]), { pausou: false, urgente: false });
});

test('chamadasDoTurno junta cada chamada ao resultado da ferramenta; a fala interna do agente não é fala do paciente', () => {
  const msgs = [
    new HumanMessage('antiga'),
    new AIMessage({ content: '', tool_calls: [{ id: 'a', name: 'pausar_ia', args: { motivo: 'x', sinalDeAlerta: true } }] }),
    new ToolMessage({ content: 'OK — IA pausada', tool_call_id: 'a' }),
  ];
  assert.deepEqual(chamadasDoTurno(msgs), [{ name: 'pausar_ia', args: { motivo: 'x', sinalDeAlerta: true }, resultado: 'OK — IA pausada' }]);
  assert.deepEqual(chamadasDoTurno([new HumanMessage('oi')]), []);
  const h = (texto: string) => ({ tipo: 'human', texto });
  assert.deepEqual(falasDoTurno([h('devo ir ao pronto-socorro?'), h('[instrução interna, não é fala do paciente] reescreva sem o hospital')]), ['devo ir ao pronto-socorro?']);
});

test('a frase do passe não promete prazo, não diagnostica e não sugere pronto-socorro', () => {
  for (const r of [{ tipo: 'aberta' as const }, { tipo: 'fechada' as const, quando: 'amanhã (terça-feira) às 8h', hoje: false }, { tipo: 'desconhecido' as const }]) {
    const f = fraseDoPasse(r, false);
    assert.doesNotMatch(f, /pronto|UPA|hospital|instante|já já|logo|minutos/i);
    assert.match(f, /avisei a nossa equipe/);
  }
  assert.match(fraseDoPasse({ tipo: 'fechada', quando: 'amanhã (terça-feira) às 8h', hoje: false }, false), /amanhã \(terça-feira\) às 8h/);
  // O paciente falou em pronto-socorro: não desaconselha.
  assert.match(fraseDoPasse({ tipo: 'aberta' }, true), /se você sentir que não dá para esperar, pode ir/i);
});

test('sinal neurológico (ITZ #28642041: "tive um AVC, tremendo o braço, a boca treme") entra no mesmo fluxo', () => {
  assert.match(sinalNaFala(['Eu tive um AVC, tremendo o braço, a perna direita dura... a boca treme']) ?? '', /neurológico/);
  for (const f of ['a boca entortou', 'minha fala está enrolada', 'o braço está tremendo', 'a boca está torta']) {
    assert.match(sinalNaFala([f]) ?? '', /neurológico/, f);
  }
  // "AVC"/"derrame" sozinhos são história ou outra coisa: ficam com o modelo (revisão de 26/10)
  for (const f of ['minha mãe teve AVC e eu cuido dela', 'tenho derrame no joelho', 'tive um AVC em 2019 e a coluna dói', 'sem derrame nem nada, só dor']) {
    assert.equal(sinalNaFala([f]), null, f);
  }
  // e o prompt manda parar
  assert.match(bloco(composeSystemPrompt({ unit: unidade() })), /teve AVC ou derrame agora[\s\S]*boca torta[\s\S]*fala enrolada/);
});

test('sinalNaFala: "não segurar o xixi" só no sentido de não conseguir (achado da revisão)', () => {
  for (const f of ['não tenho problema para segurar o xixi', 'não sinto nada, consigo segurar o xixi normal', 'não, seguro o xixi normal']) {
    assert.equal(sinalNaFala([f]), null, f);
  }
  for (const f of ['não estou conseguindo segurar o xixi', 'não consigo segurar a urina', 'ontem eu não segurei o xixi', 'não tô segurando o xixi']) {
    assert.ok(sinalNaFala([f]), f);
  }
});

test('texto livre da unidade que manda ao pronto-socorro ganha a ressalva POR LINHA (source_papel, manual, conhecimento)', () => {
  const papel = [
    'Sinais de alerta (perda de forca, perda de controle de xixi/intestino, dormencia em sela, dor apos trauma, febre com dor) -> pronto-atendimento com urgencia + transfere.',
    'A consulta custa R$ 350.',
  ].join('\n');
  const r = travarProntoSocorroPorLinha(papel);
  const [l1, l2] = r.split('\n');
  assert.match(l1, /-> pronto-atendimento com urgencia \+ transfere\. \[REGRA DA REDE: não sugira pronto-socorro/);
  assert.equal(l2, 'A consulta custa R$ 350.', 'a linha sem pronto-socorro passa intacta');
  assert.equal(travarProntoSocorroPorLinha('Consulta de R$ 350.'), 'Consulta de R$ 350.');
  assert.equal(travarProntoSocorroPorLinha(null), '');

  // chega ao prompt pelas fontes oficiais...
  const p = composeSystemPrompt({ unit: unidade({ sourcePapel: papel }) });
  assert.match(p, /-> pronto-atendimento com urgencia \+ transfere\. \[REGRA DA REDE/);
  // ...pela base de conhecimento...
  const comBase = composeSystemPrompt({
    unit: unidade(),
    knowledge: [{ id: 'k', question: 'Sinto formigamento ou dormência, é grave?', answer: 'Se vier junto com perda de força na perna, procure um pronto-atendimento.', score: 1 }] as never,
  });
  assert.match(comBase, /procure um pronto-atendimento\. \[REGRA DA REDE/);
});

test('o manual da unidade (system_prompt, dormente até ligar PROMPT_DA_UNIDADE_SLUGS) também leva a ressalva', () => {
  const manual = 'Se houver sinal de alerta, oriente procurar pronto-atendimento com urgência e transfira.';
  const base = escolherBase(unidade({ systemPrompt: manual }), undefined);
  assert.match(base ?? '', /pronto-atendimento com urgência e transfira\. \[REGRA DA REDE/);
  assert.equal(escolherBase(unidade({ systemPrompt: '' }), undefined), undefined);
});

// ── Revisão do sênior (26/10): falsos positivos, âncoras, só o que o PACIENTE disse ──────────────────────

test('sinalNaFala: queixa de anos não é o sinal de agora; "desde ontem" é', () => {
  assert.equal(sinalNaFala(['não consigo segurar o xixi à noite desde a gravidez faz 10 anos']), null);
  assert.ok(sinalNaFala(['não estou segurando o xixi desde ontem']));
  assert.ok(sinalNaFala(['não consigo segurar o xixi há 2 dias']));
});

test('sinalNaFala: "não aguento mais a perna fraca" não é negação do sintoma', () => {
  assert.ok(sinalNaFala(['não aguento mais a perna fraca']));
  assert.equal(sinalNaFala(['não senti nada de dormência na virilha']), null);
  assert.equal(sinalNaFala(['não estou com dormência na virilha']), null);
});

test('sinalNaFala: brincadeira e figura de linguagem não disparam (achados do sênior)', () => {
  for (const f of [
    'me caguei de medo quando o médico falou em cirurgia',
    'me mijei de rir',
    'a dor de repente melhorou depois do remédio',
    'perdi a força pra trabalhar com essa dor',
    'tô com febre e dor de garganta',
    'fiquei com a boca torta de raiva kkk',
    'meu braço tá tremendo de frio kkk',
    'minha perna está fraca de tanto andar',
    'tenho perna bamba quando subo escada',
  ]) {
    assert.equal(sinalNaFala([f]), null, f);
  }
  // e o que continua disparando: o teste da Suzanne e o caso real de febre com dor nas costas
  assert.ok(sinalNaFala(['minha perna está perdendo força']));
  assert.ok(sinalNaFala(['estou com febre e muita dor nas costas']));
  assert.ok(sinalNaFala(['a dor piorou de repente']));
});

test('soFalaDoPaciente / falasDoTurno: a equipe do <conversa_oficial> não é fala do paciente', () => {
  const bloco = (linhas: string[]) => `<conversa_oficial>\nO que aconteceu no WhatsApp desde a sua última mensagem (rota oficial), em ordem:\n${linhas.join('\n')}\nA EQUIPE HUMANA já falou…\n</conversa_oficial>`;
  // equipe pergunta "sentiu perda de força?", paciente diz "não": NÃO é sinal
  const conteudo = `${bloco(['- 10:01 · Equipe (Ana): "Oi! Você sentiu perda de força nas pernas?"'])}\n\nnão, só dor mesmo`;
  assert.equal(soFalaDoPaciente(conteudo), 'não, só dor mesmo');
  assert.equal(sinalNaFala(falasDoTurno([{ tipo: 'human', texto: conteudo }])), null);
  // a equipe cita pronto-socorro: NÃO abre a exceção da Sofia
  const comPs = `${bloco(['- 10:01 · Equipe (Ana): "se piorar procure o pronto-socorro"'])}\n\nok obrigado`;
  assert.equal(pacienteFalouDePs(falasDoTurno([{ tipo: 'human', texto: comPs }])), false);
  // linhas do PACIENTE dentro do bloco (e áudio transcrito) continuam valendo
  const dele = bloco(['- 10:01 · Equipe (Ana): "Como está?"', '- 10:02 · Paciente: "não estou segurando o xixi"', '- 10:03 · Paciente: [áudio transcrito] "perdi a força na perna"']);
  assert.deepEqual(soFalaDoPaciente(`${dele}\n\noi`), ['não estou segurando o xixi', 'perdi a força na perna', 'oi'].join('\n'));
  assert.ok(sinalNaFala(falasDoTurno([{ tipo: 'human', texto: `${dele}\n\noi` }])));
});

test('motivo da pausa: "sinais de alerta" casa, e AVC/derrame/dormência/febre SEM âncora ou negados não', () => {
  for (const m of ['paciente relatou sinais de alerta', 'sinais de alerta clínicos', 'suspeita de AVC agora', 'sinal neurológico: boca torta']) {
    assert.ok(ehHandoffPorSinalDeAlerta(m), m);
  }
  for (const m of [
    'paciente teve AVC em 2019, quer saber se atende',
    'derrame no joelho, quer saber preço',
    'paciente pediu humano; nega dormência na virilha',
    'sem sinal de alerta, só quer o endereço',
    'febre de 2 dias, quer remarcar',
  ]) {
    assert.equal(ehHandoffPorSinalDeAlerta(m), false, m);
  }
});

test('frase do passe quando NINGUÉM foi avisado: não diz "avisei a equipe"', () => {
  const f = fraseDoPasse({ tipo: 'aberta' }, false, false);
  assert.doesNotMatch(f, /avisei|prioridade|avisada/i);
  assert.match(f, /atendimento segue com a nossa equipe/);
  assert.match(fraseDoPasse({ tipo: 'aberta' }, true, false), /pode ir, tá\?/);
  assert.doesNotMatch(fraseDoPasse({ tipo: 'aberta' }, true, false), /avisad/);
});
