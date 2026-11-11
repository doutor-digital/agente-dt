import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import {
  composeSystemPrompt,
  composeFlattenedPrompt,
  composeSystemPromptParts,
  tabelaDeEstadosDoInicio,
  TROCAS_DO_CONDUZIR_DIRETO,
} from './prompt-composer.js';
import { renderRajada } from './rajada.js';
import type { Fala } from './repeticao.js';
import { renderSinalDeAlerta } from './sinal-de-alerta.js';
import { renderFaltaParaAgendar } from './falta-para-agendar.js';
import { CONVERSA_PADRAO, jeitoDaConversa, renderConversaDireta } from './conversa-direta.js';

// Pedido da dona de Timbó (10/11/2026) e decisões do João (11/11/2026): três chaves por unidade para tirar o "rodeio".
const CHAVES = ['SEM_PERGUNTA_DE_ALERTA_SLUGS', 'NOME_NA_HORA_DE_MARCAR_SLUGS', 'CONDUZIR_DIRETO_SLUGS'] as const;

function unidade(slug: string, extra: Partial<Unit> = {}): Unit {
  return {
    id: `u-${slug}`,
    slug,
    name: slug,
    category: null,
    personaEmojis: [],
    handoffKeywords: [],
    collectNameEnabled: true,
    sourceProdutos: 'Consulta com o especialista: R$ 250, paga no dia.',
    ...extra,
  } as unknown as Unit;
}

function comChaves<T>(valores: Partial<Record<(typeof CHAVES)[number], string>>, fn: () => T): T {
  const antes = Object.fromEntries(CHAVES.map((k) => [k, process.env[k]]));
  for (const k of CHAVES) {
    if (valores[k] === undefined) delete process.env[k];
    else process.env[k] = valores[k];
  }
  try {
    return fn();
  } finally {
    for (const k of CHAVES) {
      if (antes[k] === undefined) delete process.env[k];
      else process.env[k] = antes[k];
    }
  }
}

const TODAS = {
  SEM_PERGUNTA_DE_ALERTA_SLUGS: 'doutor-hernia-timbo',
  NOME_NA_HORA_DE_MARCAR_SLUGS: 'doutor-hernia-timbo',
  CONDUZIR_DIRETO_SLUGS: 'doutor-hernia-timbo',
};

test('chaves desligadas: o bloco <conversa_direta> não existe e o prompt da rede fica igual', () => {
  assert.equal(renderConversaDireta(CONVERSA_PADRAO, { clinica: true }), '');
  const p = comChaves({}, () => composeSystemPrompt({ unit: unidade('doutor-hernia-timbo') }));
  assert.doesNotMatch(p, /<conversa_direta>/);
  assert.match(p, /faça UMA pergunta com UM sinal só/);
  assert.match(p, /APROFUNDAR O IMPACTO/);
  assert.match(p, /PREÇO NÃO SE ENTREGA DE CARA/);
  assert.match(p, /acolher e pedir o nome\. Só isso\./);
  assert.match(p, /sua PRIMEIRA mensagem deve abrir com saudação calorosa/);
});

test('chaves ligadas só em Timbó: outra unidade não muda', () => {
  comChaves(TODAS, () => {
    assert.deepEqual(jeitoDaConversa(unidade('doutor-hernia-timbo')), {
      semPerguntaDeAlerta: true,
      nomeNaHoraDeMarcar: true,
      conduzirDireto: true,
    });
    assert.deepEqual(jeitoDaConversa(unidade('doutor-hernia-outra')), CONVERSA_PADRAO);
    const outra = composeSystemPrompt({ unit: unidade('doutor-hernia-outra') });
    assert.doesNotMatch(outra, /<conversa_direta>/);
    assert.match(outra, /faça UMA pergunta com UM sinal só/);
  });
});

test('sem-pergunta-de-alerta: some a pergunta, fica a parada quando o paciente CONTA o sinal', () => {
  const b = renderSinalDeAlerta({ category: null }, { semPerguntar: true });
  assert.doesNotMatch(b, /faça UMA pergunta com UM sinal só/);
  assert.doesNotMatch(b, /faça a pergunta de UM sinal/);
  assert.doesNotMatch(b, /fica dormente, adormecida\?/);
  assert.match(b, /VOCÊ NÃO PERGUNTA SINAL NENHUM/);
  // o que é sinal, a parada e o pronto-socorro continuam
  assert.match(b, /CONFIRMADO O SINAL, A IA PARA NA HORA/);
  assert.match(b, /pausar_ia com sinalDeAlerta: true/);
  assert.match(b, /QUANDO A FALA É CLARA/);
  assert.match(b, /você NUNCA sugere pronto-socorro/);
  // sem a opção, texto de sempre
  assert.match(renderSinalDeAlerta({ category: null }), /faça UMA pergunta com UM sinal só/);
  assert.match(renderSinalDeAlerta({ category: null }), /LINGUAGEM DO DIA A DIA/);

  // <falta_para_agendar> deixa de mandar "ANTES DE QUALQUER COISA" perguntar força/xixi
  const fatos = { nome: 'Carol', queixa: 'hérnia com fraqueza na perna' };
  assert.match(renderFaltaParaAgendar(fatos), /ANTES DE QUALQUER COISA/);
  assert.doesNotMatch(renderFaltaParaAgendar(fatos, { semPerguntaDeAlerta: true }), /ANTES DE QUALQUER COISA/);

  const p = comChaves({ SEM_PERGUNTA_DE_ALERTA_SLUGS: 'doutor-hernia-timbo' }, () =>
    composeSystemPrompt({ unit: unidade('doutor-hernia-timbo') }),
  );
  assert.match(p, /<conversa_direta>[\s\S]*SEM PERGUNTA DE SEGURANÇA/);
  assert.doesNotMatch(p, /faça UMA pergunta com UM sinal só/);
  // fora de clínica a chave não tem o que mudar
  assert.equal(
    renderConversaDireta({ ...CONVERSA_PADRAO, semPerguntaDeAlerta: true }, { clinica: false }),
    '',
  );
});

test('nome-na-hora-de-marcar: sem pedido de nome no começo; o nome vai junto do horário', () => {
  const p = comChaves({ NOME_NA_HORA_DE_MARCAR_SLUGS: 'doutor-hernia-timbo' }, () =>
    composeSystemPrompt({ unit: unidade('doutor-hernia-timbo'), isFirstTurn: true }),
  );
  assert.doesNotMatch(p, /sua PRIMEIRA mensagem deve abrir com saudação calorosa/);
  assert.doesNotMatch(p, /Pergunta natural pelo nome do paciente/);
  assert.doesNotMatch(p, /acolher e pedir o nome\. Só isso\./);
  assert.match(p, /NOME SÓ NA HORA DE MARCAR/);

  // checklist: o nome sai da frente; o pedido vai no horário
  const semNome = { queixa: 'lombar', tempo_dor: '1 ano', cidade: 'Timbó' };
  assert.match(renderFaltaParaAgendar(semNome), /Próximo passo: pergunte como pode chamá-lo/);
  const r = renderFaltaParaAgendar(semNome, { nomeNaHoraDeMarcar: true });
  assert.doesNotMatch(r, /como pode chamá-lo/);
  assert.match(r, /quando ele escolher, peça o nome completo/);
  // já escolheu o horário e ainda não tem nome: não diz "já tem tudo"
  const tudoMenosNome = { ...semNome, horario_escolhido: 'amanhã 9h' };
  assert.match(renderFaltaParaAgendar(tudoMenosNome, { nomeNaHoraDeMarcar: true }), /menos o nome/);
});

test('conduzir-direto: valor na hora, sem perguntas de impacto, sem "há quanto tempo" na lista', () => {
  const p = comChaves({ CONDUZIR_DIRETO_SLUGS: 'doutor-hernia-timbo' }, () =>
    composeSystemPrompt({ unit: unidade('doutor-hernia-timbo') }),
  );
  assert.doesNotMatch(p, /PREÇO NÃO SE ENTREGA DE CARA/);
  assert.doesNotMatch(p, /APROFUNDAR O IMPACTO/);
  assert.doesNotMatch(p, /Tem te tirado o sono/);
  assert.match(p, /PERGUNTOU O PREÇO, O VALOR VAI NA HORA/);
  assert.match(p, /é exatamente o que tratamos aqui/);
  assert.match(p, /CONDUZIR DIRETO/);
  // as proibições de sempre ficam
  assert.match(p, /VOCÊ NUNCA DIAGNOSTICA/);

  const fatos = { nome: 'Carol', queixa: 'hérnia' };
  assert.match(renderFaltaParaAgendar(fatos), /tempo de dor/);
  assert.doesNotMatch(renderFaltaParaAgendar(fatos, { conduzirDireto: true }), /tempo de dor/);
});

test('o bloco entra nos três caminhos do compositor e no prompt único escrito à mão', () => {
  comChaves(TODAS, () => {
    const u = unidade('doutor-hernia-timbo');
    assert.match(composeSystemPrompt({ unit: u }), /<conversa_direta>/);
    assert.match(composeFlattenedPrompt({ unit: u }), /<conversa_direta>/);
    const partes = composeSystemPromptParts({ unit: u });
    assert.match(JSON.stringify(partes), /<conversa_direta>/);
    const unico = composeSystemPrompt({
      unit: unidade('doutor-hernia-timbo', { singlePromptMode: true, systemPrompt: 'Pergunte sempre o nome primeiro.' }),
    });
    assert.match(unico, /Pergunte sempre o nome primeiro\.\n\n<conversa_direta>/);
  });
});

// ── Achados do review (11/11/2026) ──────────────────────────────────────────────────────────────────────────────

test('review: prompt único no caminho de produção (composeSystemPromptParts) também recebe o bloco', () => {
  comChaves(TODAS, () => {
    const u = unidade('doutor-hernia-timbo', { singlePromptMode: true, systemPrompt: 'Pergunte sempre o nome primeiro.' });
    const partes = composeSystemPromptParts({ unit: u });
    assert.match(partes.cacheable, /Pergunte sempre o nome primeiro\.\n\n<conversa_direta>/);
  });
  const semChave = comChaves({}, () =>
    composeSystemPromptParts({ unit: unidade('doutor-hernia-timbo', { singlePromptMode: true, systemPrompt: 'X.' }) }),
  );
  assert.doesNotMatch(semChave.cacheable, /<conversa_direta>/);
});

test('review: <rajada_sem_resposta> não manda perguntar sinal com a chave; perna que falhou vira o sinal', () => {
  const falas: Fala[] = [
    { papel: 'ia', texto: 'Oi! Como posso ajudar?' },
    { papel: 'paciente', texto: 'me faltou a perna ontem' },
    { papel: 'paciente', texto: 'Boa noite' },
  ];
  const rede = renderRajada(falas, { clinica: true });
  assert.match(rede, /faça a pergunta de sinais de alerta/);
  const timbo = renderRajada(falas, { clinica: true, semPerguntaDeAlerta: true });
  assert.doesNotMatch(timbo, /faça a pergunta de sinais de alerta/);
  assert.doesNotMatch(timbo, /a perna ficou fraca, sem força\?/);
  assert.match(timbo, /isso JÁ é sinal de alerta/);
});

test('review: sem a pergunta, fala do dia a dia de perna falhando conta como sinal (lado seguro)', () => {
  const b = renderSinalDeAlerta({ category: null }, { semPerguntar: true });
  assert.match(b, /"a perna\s+bambeou"[\s\S]*isso JÁ é o sinal \(a\): pare como acima/);
  assert.match(b, /"travei" de dor \(sem a perna falhar\)/);
  assert.doesNotMatch(b, /a perna ficou fraca, sem força\?"\. Se ele confirmar/);
});

test('review: primeiro turno sem nenhum pedido de nome com a chave (nem no exemplo)', () => {
  comChaves({ NOME_NA_HORA_DE_MARCAR_SLUGS: 'doutor-hernia-timbo' }, () => {
    const p = composeSystemPrompt({ unit: unidade('doutor-hernia-timbo'), isFirstTurn: true });
    const primeiro = p.slice(p.lastIndexOf('<primeiro_turno>'), p.lastIndexOf('</primeiro_turno>'));
    assert.ok(primeiro.length > 0);
    assert.doesNotMatch(primeiro, /como posso te chamar/);
    assert.doesNotMatch(primeiro, /ANTES de pedir o nome/);
    assert.match(primeiro, /o que você está sentindo\?/);
  });
  const rede = comChaves({}, () => composeSystemPrompt({ unit: unidade('doutor-hernia-timbo'), isFirstTurn: true }));
  assert.match(rede, /Antes de tudo, como posso te chamar\? 😊/);
  assert.match(rede, /reconheça com empatia ANTES de pedir o nome/);
});

test('review: conduzir-direto troca TODOS os trechos que seguram o preço (convênio, sequência, etapas)', () => {
  const rede = comChaves({}, () => composeSystemPrompt({ unit: unidade('doutor-hernia-timbo') }));
  for (const [de] of TROCAS_DO_CONDUZIR_DIRETO) assert.ok(rede.includes(de), `o texto da rede mudou, a troca não acha: ${de.slice(0, 60)}`);
  const timbo = comChaves({ CONDUZIR_DIRETO_SLUGS: 'doutor-hernia-timbo' }, () =>
    composeSystemPrompt({ unit: unidade('doutor-hernia-timbo') }),
  );
  for (const [de, para] of TROCAS_DO_CONDUZIR_DIRETO) {
    assert.ok(!timbo.includes(de), `sobrou: ${de.slice(0, 60)}`);
    assert.ok(timbo.includes(para));
  }
  assert.doesNotMatch(timbo, /NÃO emende o valor/);
  assert.doesNotMatch(timbo, /onde dói e há\s+quanto tempo/);
  assert.doesNotMatch(timbo, /Não pule etapas/);
});

test('review: tabela de estados — cada chave sozinha cobre "disse só o nome"; sem cópia da tabela da rede', () => {
  const so = (j: Partial<typeof CONVERSA_PADRAO>) => tabelaDeEstadosDoInicio({ ...CONVERSA_PADRAO, ...j });
  assert.match(so({}), /disse o nome {17}→ {2}investigar: onde dói, há quanto tempo/);
  assert.match(so({ conduzirDireto: true }), /disse o nome {17}→ {2}perguntar o que ele está sentindo/);
  assert.match(so({ conduzirDireto: true }), /acolher e pedir o nome\. Só isso\./);
  assert.doesNotMatch(so({ conduzirDireto: true, nomeNaHoraDeMarcar: true }), /disse o nome/);
  assert.match(so({ nomeNaHoraDeMarcar: true }), /disse o que sente {12}→ {2}investigar/);
  assert.match(so({ nomeNaHoraDeMarcar: true }), /valor construído/);
});

test('review: nome já pedido 2 vezes (semPedirNome) — a chave não volta a pedir junto do horário', () => {
  const semNome = { queixa: 'lombar', tempo_dor: '1 ano', cidade: 'Timbó' };
  const r = renderFaltaParaAgendar(semNome, { nomeNaHoraDeMarcar: true, semPedirNome: true });
  assert.doesNotMatch(r, /nome completo/);
  const tudo = renderFaltaParaAgendar({ ...semNome, horario_escolhido: 'amanhã 9h' }, { nomeNaHoraDeMarcar: true, semPedirNome: true });
  assert.doesNotMatch(tudo, /menos o nome/);
  assert.match(tudo, /Você já tem tudo para marcar/);
});
