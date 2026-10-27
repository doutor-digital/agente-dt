/**
 * Auditoria de Araguaína (21/10/2026), item 1: respondeu só ao fim da rajada e ignorou a dor.
 *
 * Lead 28681456, 15/10, 17:50–17:53: "Na cintura", "Ai desce pras pernas", "Ja tem mas ou menos umas duas semanas",
 * "Quer sinto dor as uns três dias atrás", "Mim falou as pernas" (= me faltaram as pernas), "Quer não andei"
 * (= quase não andei), "Boa noite", "Tudo bem", "Comigo tudo a não ser essa dor", "Esta tudo bem graças a Deus".
 * Às 17:54 saiu: "Que bom, Selma, graças a Deus mesmo! Agora vamos cuidar dessa dor também… você mora aqui em
 * Araguaína?". Nenhuma resposta saiu entre 17:50 e 17:54.
 *
 * O coalescer junta tudo o que chega na janela num turno só (agent-coalescer.test.ts) e encadeia o que chega
 * enquanto a IA responde. O que se perdia: com o paciente escrevendo sem parar, cada resposta do meio era SEGURADA
 * (temPendentes) — não saía, mas ficava no histórico do grafo como se tivesse saído. A divisão exata dos turnos não
 * está no Kommo; a reconstrução abaixo segue as horas das mensagens, e as respostas seguradas são inventadas.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { Unit } from '@prisma/client';

import {
  guardarRespostaSegurada,
  idDaUltimaResposta,
  limparNaoEntregues,
  marcarNaoEntregue,
  consumirNaoEntregueDetalhe,
  renderEntregaFalha,
  respostasSeguradas,
  VALIDADE_SEGURADA_MS,
} from './entrega-falha.js';
import { falasDoHistorico, type Fala } from './repeticao.js';
import {
  linhasSemResposta,
  queixasEsquecidas,
  renderRajada,
  soCortesia,
  temLimitacao,
  temQueixaClinica,
  turnosSemResposta,
} from './rajada.js';
import { renderSinalDeAlerta } from './sinal-de-alerta.js';
import { composeSystemPromptParts } from './prompt-composer.js';

const p = (texto: string): Fala => ({ papel: 'paciente', texto });
const ia = (texto: string): Fala => ({ papel: 'ia', texto });
const CLINICA = { clinica: true };

function unidade(over: Partial<Unit> = {}): Unit {
  return {
    id: 'u-aragua',
    slug: 'doutor-hernia-araguaina',
    name: 'Doutor Hérnia Araguaína',
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

const SEGURADA_1 = 'Entendi, Selma! E essa dor na cintura fica só ali ou desce pra perna?';
const SEGURADA_2 = 'Duas semanas com essa dor descendo pras pernas não é fácil, viu? Ela piorou de uns dias pra cá?';
const SEGURADA_3 = 'Selma, quando você diz que faltaram as pernas: a perna ficou fraca, sem força?';
const SEGURADA_4 = 'Boa noite, Selma! Tudo bem sim, e com você?';

/** A conversa como fica no grafo: as respostas do meio estão lá, mas nenhuma saiu. */
const GRAFO = [
  new HumanMessage('Boa tarde\n\nTudo bem'),
  new AIMessage('Oiê! Eu sou a Sofia, da Doutor Hérnia Araguaína! Como posso te chamar?'),
  new HumanMessage('Boa tarde\n\nMim chamo selma\n\nEu gostaria de saber'),
  new AIMessage('Boa tarde, Selma! Me conta, o que está te incomodando? Onde você sente a dor e há quanto tempo?'),
  new HumanMessage('Na cintura'),
  new AIMessage({ content: SEGURADA_1, id: 'seg-1' }),
  new HumanMessage('Ai desce pras pernas\n\nJa tem mas ou menos umas duas semanas'),
  new AIMessage({ content: SEGURADA_2, id: 'seg-2' }),
  new HumanMessage('Quer sinto dor as uns três dias atrás\n\nMim falou as pernas'),
  new AIMessage({ content: SEGURADA_3, id: 'seg-3' }),
  new HumanMessage('Quer não andei\n\nBoa noite\n\nTudo bem'),
  new AIMessage({ content: SEGURADA_4, id: 'seg-4' }),
  new HumanMessage('Comigo tudo a não ser essa dor\n\nEsta tudo bem graças a Deus'),
];
/** Os ids das mensagens seguradas, como o webhook guarda (idDaUltimaResposta). */
const SEGURADAS = ['seg-1', 'seg-2', 'seg-3', 'seg-4'];

beforeEach(() => limparNaoEntregues());

// ── (a) a rajada inteira chega ao modelo ────────────────────────────────────────────────────────────────────

test('item 1a: com as respostas seguradas no histórico, a última "rajada" era só o fim — a dor ficava para trás', () => {
  const antes = linhasSemResposta(falasDoHistorico(GRAFO));
  assert.deepEqual(antes, ['Comigo tudo a não ser essa dor', 'Esta tudo bem graças a Deus']);
  assert.ok(!antes.includes('Mim falou as pernas'));
});

test('item 1a: sem as seguradas, todas as mensagens desde a última resposta que ela LEU entram no turno', () => {
  const linhas = linhasSemResposta(falasDoHistorico(GRAFO, SEGURADAS));
  assert.deepEqual(linhas, [
    'Na cintura',
    'Ai desce pras pernas',
    'Ja tem mas ou menos umas duas semanas',
    'Quer sinto dor as uns três dias atrás',
    'Mim falou as pernas',
    'Quer não andei',
    'Boa noite',
    'Tudo bem',
    'Comigo tudo a não ser essa dor',
    'Esta tudo bem graças a Deus',
  ]);
});

test('item 1a: a resposta segurada fica guardada por conversa, na ordem, e some depois de um dia', () => {
  const t = Date.now();
  guardarRespostaSegurada('u1', 100, 'seg-1', t);
  guardarRespostaSegurada('u1', 100, 'seg-2', t + 1_000);
  assert.deepEqual(respostasSeguradas('u1', 100, t + 2_000), ['seg-1', 'seg-2']);
  // não consome: o turno pode passar pelo modelo mais de uma vez (ferramentas)
  assert.deepEqual(respostasSeguradas('u1', 100, t + 2_000), ['seg-1', 'seg-2']);
  assert.deepEqual(respostasSeguradas('u1', 200, t), [], 'outro lead não vê');
  assert.deepEqual(respostasSeguradas('u2', 100, t), [], 'outra unidade não vê');
  assert.deepEqual(respostasSeguradas('u1', 100, t + 1_000 + VALIDADE_SEGURADA_MS + 1), []);
  guardarRespostaSegurada('u1', 100, '   ', t);
  guardarRespostaSegurada('u1', 100, null, t);
  assert.deepEqual(respostasSeguradas('u1', 100, t), []);
});

test('item 1a: tira pelo id da mensagem — a mesma frase que depois SAIU continua contando (achado do Codex)', () => {
  const msgs = [
    new HumanMessage('oi'),
    new AIMessage({ content: 'Como posso te chamar?', id: 'a1' }),
    new HumanMessage('👍'),
    new AIMessage({ content: 'Como posso te chamar?', id: 'a2' }),
    new HumanMessage('Ana'),
  ];
  assert.deepEqual(falasDoHistorico(msgs, ['a1']), [p('oi'), p('👍'), ia('Como posso te chamar?'), p('Ana')]);
  assert.deepEqual(falasDoHistorico(msgs, ['a2']), [p('oi'), ia('Como posso te chamar?'), p('👍'), p('Ana')]);
  assert.deepEqual(falasDoHistorico(msgs, ['outro']), falasDoHistorico(msgs));
  // o webhook guarda o id da última fala da IA do estado do grafo
  assert.equal(idDaUltimaResposta(msgs), 'a2');
  assert.equal(idDaUltimaResposta([new HumanMessage('oi')]), null);
  assert.equal(idDaUltimaResposta(undefined), null);
});

test('item 1a: o aviso da resposta atropelada pede TODAS as mensagens desde a última resposta lida, dor antes', () => {
  marcarNaoEntregue('u1', 100, SEGURADA_4, Date.now(), 'atropelada');
  const presa = consumirNaoEntregueDetalhe('u1', 100);
  const b = renderEntregaFalha(presa!.texto, presa!.motivo);
  assert.match(b, /a TODAS as mensagens dele desde a última resposta que ele recebeu/);
  assert.match(b, /não só à última/);
  assert.match(b, /Dor, limitação ou sinal clínico vem antes de\s+cumprimento/);
});

test('item 1a: mais de um turno sem resposta lida — o bloco lista tudo e diz que as do meio não saíram', () => {
  const falas = falasDoHistorico(GRAFO, SEGURADAS);
  assert.equal(turnosSemResposta(falas), 5);
  const b = renderRajada(falas, CLINICA);
  assert.match(b, /Desde a última resposta que ele RECEBEU, ele mandou tudo isto/);
  assert.match(b, /As respostas que você escreveu no meio NÃO saíram/);
  assert.match(b, /> "Na cintura"[\s\S]*> "Mim falou as pernas"[\s\S]*> "Esta tudo bem graças a Deus"/);
  assert.match(b, /Responda a TODAS numa mensagem só, na ordem em que vieram — não só à última/);
  // vale para qualquer unidade (a parte da queixa, só para clínica)
  const fora = renderRajada([ia('Oi! Como posso ajudar?'), p('quero saber do contrato'), p('Boa noite')], { clinica: false });
  assert.match(fora, /Responda a TODAS/);
  assert.doesNotMatch(fora, /Acolha ISSO primeiro/);
  // um turno só, sem queixa esquecida: nada
  assert.equal(renderRajada([ia('Oi!'), p('quero saber do contrato')], { clinica: false }), '');
});

// ── (b) a queixa vem antes do "tudo bem" ────────────────────────────────────────────────────────────────────

test('item 1b: o caso real gera o bloco com a dor e a limitação, e manda a pergunta de sinais de alerta', () => {
  const falas = falasDoHistorico(GRAFO, SEGURADAS);
  const queixas = queixasEsquecidas(falas);
  assert.ok(queixas.includes('Mim falou as pernas'));
  assert.ok(queixas.includes('Quer não andei'));
  assert.ok(queixas.includes('Comigo tudo a não ser essa dor'));
  const b = renderRajada(falas, CLINICA);
  assert.match(b, /<rajada_sem_resposta>/);
  assert.match(b, /> "Mim falou as pernas"/);
  assert.match(b, /> "Quer não andei"/);
  assert.match(b, /Acolha ISSO primeiro/);
  assert.match(b, /NUNCA responda só ao "tudo bem"/);
  assert.match(b, /pergunta de sinais de alerta, UM sinal\s+por vez/);
  assert.match(b, /<sinal_de_alerta>/);
  assert.doesNotMatch(b, /avaliação/);
});

test('item 1b: a rajada que coube num turno só (texto juntado pelo coalescer) também é pega', () => {
  const b = renderRajada([
    ia('Onde você sente a dor e há quanto tempo?'),
    p('Na cintura\n\nMim falou as pernas\n\nQuer não andei\n\nBoa noite\n\nTudo bem'),
  ], CLINICA);
  assert.match(b, /> "Mim falou as pernas"/);
});

test('item 1b: sem queixa, ou terminando em pergunta, não há bloco (bloco que aparece sempre vira ruído)', () => {
  assert.equal(renderRajada([ia('Oi!'), p('Boa noite\n\nTudo bem')], CLINICA), '');
  assert.equal(renderRajada([ia('Oi!'), p('Tenho dor na lombar\n\nQual o valor?')], CLINICA), '');
  assert.equal(renderRajada([ia('Oi!'), p('Dói muito a lombar')], CLINICA), '', 'uma linha só: é a própria mensagem');
  // a queixa contada ANTES da última resposta que ela leu já foi acolhida
  assert.equal(renderRajada([p('Dói a lombar'), ia('Entendi! Há quanto tempo?'), p('Boa noite\n\nTudo bem')], CLINICA), '');
  assert.equal(renderRajada([], CLINICA), '');
  assert.equal(renderRajada(undefined, CLINICA), '');
});

test('item 1b: perna que faltou, não andar, travar — em linguagem do dia a dia e com erro de digitação', () => {
  for (const t of [
    'Mim falou as pernas',
    'me faltaram as pernas',
    'me faltou a perna ontem',
    'as pernas falharam',
    'falhou a perna',
    'a perna bambeou',
    'Quer não andei',
    'quase não andei',
    'não consigo andar direito',
    'mal consigo andar',
    'travei a coluna',
    'fiquei sem força na perna',
  ]) {
    assert.ok(temLimitacao(t), `limitação: ${t}`);
    assert.ok(temQueixaClinica(t), `queixa: ${t}`);
  }
  for (const t of ['Na cintura', 'Ai desce pras pernas', 'Comigo tudo a não ser essa dor', 'Caí da escada']) {
    assert.ok(temQueixaClinica(t), `queixa: ${t}`);
  }
  for (const t of ['Boa noite', 'Tudo bem', 'Ja tem mas ou menos umas duas semanas', 'Eu gostaria de saber']) {
    assert.ok(!temQueixaClinica(t), `não é queixa: ${t}`);
  }
});

test('item 1b: cortesia é cumprimento, "tudo bem", "graças a Deus" — com dor junto, não é', () => {
  for (const t of ['Boa noite', 'Tudo bem', 'Esta tudo bem graças a Deus', 'tudo bem e vc?', 'Amém 🙏', 'Obrigada']) {
    assert.ok(soCortesia(t), `cortesia: ${t}`);
  }
  for (const t of ['Comigo tudo a não ser essa dor', 'Qual o valor?', 'Moro em Bielândia', 'tudo bem, mas dói muito', '?', '🙏']) {
    assert.ok(!soCortesia(t), `não é só cortesia: ${t}`);
  }
});

test('item 1b: no prompt — a rajada entra e o "só um cumprimento" NÃO entra quando a dor veio antes do "boa noite"', () => {
  // o turno em que a última mensagem é só cumprimento, com a dor nas mensagens das respostas seguradas
  const historico = falasDoHistorico(GRAFO.slice(0, 11), SEGURADAS);
  const { dynamic } = composeSystemPromptParts({
    unit: unidade(),
    leadId: 28681456,
    userMessage: 'Boa noite\n\nTudo bem',
    historico,
  });
  assert.match(dynamic, /<rajada_sem_resposta>[\s\S]*Mim falou as pernas/);
  assert.doesNotMatch(dynamic, /SÓ um cumprimento/);

  // controle: "boa noite" sozinho, sem nada pendente, continua só cumprimento
  const so = composeSystemPromptParts({
    unit: unidade(),
    leadId: 1,
    userMessage: 'Boa noite',
    historico: [p('Dói a lombar'), ia('Entendi! Há quanto tempo?'), p('Boa noite')],
  });
  assert.match(so.dynamic, /SÓ um cumprimento/);
  assert.doesNotMatch(so.dynamic, /<rajada_sem_resposta>/);
});

test('item 1b: fora de clínica não entra', () => {
  const { dynamic } = composeSystemPromptParts({
    unit: unidade({ category: 'advocacia' } as Partial<Unit>),
    leadId: 1,
    userMessage: 'Tudo bem',
    historico: [ia('Oi!'), p('Travei as costas\n\nTudo bem')],
  });
  assert.doesNotMatch(dynamic, /<rajada_sem_resposta>/);
});

test('item 1b: o bloco <sinal_de_alerta> manda ler a rajada inteira e traz os exemplos em linguagem popular', () => {
  const b = renderSinalDeAlerta(unidade());
  assert.match(b, /VÁRIAS MENSAGENS SEGUIDAS: leia todas antes de responder/);
  assert.match(b, /nunca responda só ao "tudo bem" ou ao "boa noite" do fim/);
  for (const ex of ['me faltou/faltaram as pernas', String.raw`mim\s+falou as pernas`, 'as pernas falharam', 'quase não andei', 'quer não andei', 'não consigo andar', 'travei']) {
    assert.match(b, new RegExp(ex), `exemplo: ${ex}`);
  }
  assert.match(b, /pergunta de UM sinal/);
  // 26/10: a fala vaga pergunta UM sinal; a fala clara (e o sinal confirmado) manda parar — ver o bloco inteiro
  assert.ok(b.indexOf('CONFIRMADO O SINAL') < b.indexOf('LINGUAGEM DO DIA A DIA'));
});
