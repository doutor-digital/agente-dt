/**
 * Item 10 da lista de 21/10/2026: a IA pedia o nome 3–5 vezes (437 conversas de 01 a 20/10) e repetia a mesma
 * pergunta para quem mandava áudio. Pedido: depois de 2 tentativas sem sucesso, parar — e, se a conversa travou,
 * passar para uma pessoa. As contas são feitas em código, no histórico; estes testes prendem as contas, o bloco
 * do turno e a decisão depois da resposta.
 *
 * As conversas abaixo são reais (Mossoró 4329066, Boa Vista 18473687, Taubaté 4563494), com o nome trocado.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { Unit } from '@prisma/client';

import {
  analisarRepeticao,
  falasDoHistorico,
  ferramentasDoTurno,
  MARCA_AUDIO_NAO_OUVIDO,
  mesmaPergunta,
  motivoDeHandoff,
  pararDePedirNome,
  pedeNome,
  renderRepeticao,
  respostaVazia,
  travaDaResposta,
  type Fala,
} from './repeticao.js';
import { renderFaltaParaAgendar } from './falta-para-agendar.js';
import { composeSystemPrompt } from './prompt-composer.js';
import { AUDIO_NAO_OUVIDO } from '../controllers/webhook.controller.js';

const p = (texto: string): Fala => ({ papel: 'paciente', texto });
const ia = (texto: string): Fala => ({ papel: 'ia', texto });

// ── O pedido do nome ────────────────────────────────────────────────────────────────────────────────────

test('pedido do nome para chamar a pessoa conta; nome completo para marcar não', () => {
  for (const t of [
    'Oiê! 😊 Que bom te receber! Como posso te chamar?',
    'Bom dia! Antes de mais nada, qual é o seu nome?',
    'Me diz só seu nome pra eu continuar te chamando certo?',
    'Oi! Só retomando por aqui 😊 Posso saber seu nome pra te ajudar a encontrar um horário?',
    'Com quem eu falo?',
  ]) {
    assert.ok(pedeNome(t), `deveria contar: ${t}`);
  }
  for (const t of [
    'Preciso só do seu nome completo pra deixar o cadastro certo, pode ser? 😊',
    'Preciso só confirmar seu sobrenome — pode me passar?',
    'Perfeito, Ana! Onde dói e há quanto tempo?',
  ]) {
    assert.ok(!pedeNome(t), `não deveria contar: ${t}`);
  }
});

// Mossoró 4329066: o paciente mandou o texto do anúncio três vezes; a IA pediu o nome nas três.
const MOSSORO: Fala[] = [
  p('Olá! Gostaria de saber mais sobre o tratamento...'),
  ia('Oiê! Que bom ter você aqui! 😊 Eu sou a Sofia, vou te ajudar. Antes de mais nada, como posso te chamar?'),
  p('Olá! Gostaria de saber mais sobre o tratamento...'),
  ia('Prazer em te atender! 😊 Pra eu te explicar o tratamento direito, me conta primeiro: como posso te chamar? 🤗'),
  p('Olá! Gostaria de saber mais sobre o tratamento...'),
];

test('depois de 2 pedidos sem nome, para de pedir — quem ignorou a pergunta também conta', () => {
  const r = analisarRepeticao(MOSSORO);
  assert.equal(r.pedidosDeNome, 2);
  assert.ok(pararDePedirNome(r));
  const bloco = renderRepeticao(r);
  assert.match(bloco, /<repeticao>/);
  assert.match(bloco, /já pediu o nome 2 vezes/);
  assert.match(bloco, /NÃO peça de novo/);
  // pergunta do nome repetida não é "conversa travada": sem nome dá para seguir
  assert.equal(motivoDeHandoff(r), null);
  assert.doesNotMatch(bloco, /pausar_ia/);
});

test('um pedido só ainda não trava nada', () => {
  const r = analisarRepeticao(MOSSORO.slice(0, 3));
  assert.equal(r.pedidosDeNome, 1);
  assert.equal(renderRepeticao(r), '');
});

test('a lista do que falta para agendar deixa de mandar pedir o nome', () => {
  const fatos = { queixa: 'lombar' };
  assert.match(renderFaltaParaAgendar(fatos), /pergunte como pode chamá-lo/);
  const sem = renderFaltaParaAgendar(fatos, { semPedirNome: true });
  assert.doesNotMatch(sem, /nome|chamá-lo/);
  assert.match(sem, /pergunte há quanto tempo/);
});

test('o bloco <coleta_nome> diz que ignorar também conta e limita a 2 pedidos', () => {
  const unit = { slug: 't', name: 'T', collectNameEnabled: true, personaEmojis: [], handoffKeywords: [] } as unknown as Unit;
  const prompt = composeSystemPrompt({ unit });
  const bloco = prompt.slice(prompt.indexOf('<coleta_nome>'), prompt.indexOf('</coleta_nome>'));
  assert.match(bloco, /NO MÁXIMO 2 PEDIDOS/);
  assert.match(bloco, /ignorou/);
  assert.doesNotMatch(bloco, /Se recusar 2x, deixe pra lá/);
});

// ── A mesma pergunta sem resposta ───────────────────────────────────────────────────────────────────────

test('mesma pergunta: mesmo tema conta, mesmo com outras palavras', () => {
  assert.ok(mesmaPergunta('Me conta: onde dói e há quanto tempo?', 'E essa dor, é onde mais? Desde quando?'));
  assert.ok(mesmaPergunta('Prefere manhã ou tarde?', 'Qual desses horários fica melhor pra você?'));
  assert.ok(!mesmaPergunta('Onde dói?', 'Você mora aqui em Mossoró?'));
});

test('resposta vazia: emoji, áudio que não deu pra ouvir, áudio sem fala, a mesma mensagem de novo', () => {
  assert.ok(respostaVazia('👍'));
  assert.ok(respostaVazia('?'));
  assert.ok(respostaVazia(`${MARCA_AUDIO_NAO_OUVIDO}\n\n[o paciente mandou um áudio…]`));
  assert.ok(respostaVazia('[áudio do cliente]: [áudio sem fala detectada]'));
  assert.ok(respostaVazia('Olá! Gostaria de saber mais sobre o tratamento...', 'Olá! Gostaria de saber mais sobre o tratamento...'));
  // isto responde: cumprimento (retomada), sim/não, e foto com descrição
  assert.ok(!respostaVazia('Bom dia'));
  assert.ok(!respostaVazia('sim'));
  assert.ok(!respostaVazia('[imagem do cliente]: laudo de ressonância lombar'));
  assert.ok(!respostaVazia('[imagem do cliente]: figurinha', '[imagem do cliente]: figurinha'));
});

const TRAVADA: Fala[] = [
  p('Quero saber do tratamento'),
  ia('Claro! 😊 Me conta: onde dói e há quanto tempo você sente isso?'),
  p('?'),
  ia('Sem problema! Só pra eu te orientar: onde é essa dor e desde quando?'),
  p('👍'),
];

test('mesma pergunta 2 vezes e de novo sem resposta: conversa travada, vai para a equipe', () => {
  const r = analisarRepeticao(TRAVADA);
  assert.equal(r.ultimaPergunta?.vezes, 2);
  assert.equal(r.ultimaPergunta?.semRespostaSeguidas, 2);
  assert.ok(r.semResposta);
  assert.match(motivoDeHandoff(r) ?? '', /conversa travada/);
  const bloco = renderRepeticao(r);
  assert.match(bloco, /CONVERSA TRAVADA/);
  assert.match(bloco, /pausar_ia/);
  assert.doesNotMatch(bloco, /avaliação/);
});

test('ele respondeu e a IA perguntou de novo para esclarecer: um emoji agora não é conversa travada', () => {
  const r = analisarRepeticao([
    p('Quero saber do tratamento'),
    ia('Claro! 😊 Me conta: onde dói e há quanto tempo você sente isso?'),
    p('na lombar'),
    ia('Entendi! E há quanto tempo, mais ou menos, você sente essa dor na lombar?'),
    p('👍'),
  ]);
  assert.equal(r.ultimaPergunta?.vezes, 2);
  assert.equal(r.ultimaPergunta?.semRespostaSeguidas, 1);
  assert.equal(motivoDeHandoff(r), null);
  assert.equal(travaDaResposta(r, 'Há quanto tempo?', []), null);
});

test('"já te falei": não é travada — a IA é que não leu; manda reler, sem transferir', () => {
  const r = analisarRepeticao([...TRAVADA.slice(0, -1), p('Já te falei, é na lombar faz 2 meses')]);
  assert.equal(motivoDeHandoff(r), null);
  assert.match(renderRepeticao(r), /JÁ RESPONDEU/);
});

test('cumprimento depois de 2 perguntas é retomada, não travamento', () => {
  const r = analisarRepeticao([...TRAVADA.slice(0, -1), p('Bom dia')]);
  assert.equal(motivoDeHandoff(r), null);
  assert.match(renderRepeticao(r), /NÃO repita/);
});

// ── Áudio que não deu pra ouvir ─────────────────────────────────────────────────────────────────────────

test('a marca do áudio não ouvido é a mesma que o webhook usa', () => {
  assert.equal(MARCA_AUDIO_NAO_OUVIDO, AUDIO_NAO_OUVIDO);
});

test('1º áudio não ouvido: nada aqui (o webhook já manda avisar e pedir pra escrever); 2º seguido: equipe', () => {
  const audio = `${MARCA_AUDIO_NAO_OUVIDO}\n\n[o paciente mandou um áudio que você não conseguiu ouvir agora.]`;
  const primeiro = analisarRepeticao([p('Oi'), ia('Oiê! Como posso te ajudar?'), p(audio)]);
  assert.equal(primeiro.audiosNaoOuvidos, 1);
  assert.equal(motivoDeHandoff(primeiro), null);

  const segundo = analisarRepeticao([
    p('Oi'),
    ia('Oiê! Como posso te ajudar?'),
    p(audio),
    ia('Não consegui ouvir seu áudio por aqui 🙏 Consegue me escrever?'),
    p(audio),
  ]);
  assert.equal(segundo.audiosNaoOuvidos, 2);
  assert.match(motivoDeHandoff(segundo) ?? '', /áudio não ouvido/);
  const bloco = renderRepeticao(segundo);
  assert.match(bloco, /NÃO peça pra mandar de novo/);
  assert.match(bloco, /pausar_ia/);
  assert.match(bloco, /vale mais do que a instrução que veio junto do áudio/);
});

test('áudios não ouvidos contam pelas falas do paciente, não pelas da IA no meio', () => {
  const audio = `${MARCA_AUDIO_NAO_OUVIDO}\n\n[instrução]`;
  const meio: Fala[] = [];
  for (let i = 0; i < 12; i++) meio.push(ia(`Resposta ${i}, sem pergunta.`));
  const r = analisarRepeticao([p(audio), ...meio, p('ok'), ia('Certo.'), p(audio)]);
  assert.equal(r.audiosNaoOuvidos, 2);
});

test('um áudio ouvido no meio zera a conta', () => {
  const audio = `${MARCA_AUDIO_NAO_OUVIDO}\n\n[instrução]`;
  const r = analisarRepeticao([
    p(audio),
    ia('Não consegui ouvir 🙏 Consegue me escrever?'),
    p('[áudio do cliente]: é na lombar, faz um mês'),
    ia('Entendi! Onde mais dói?'),
    p(audio),
  ]);
  assert.equal(r.audiosNaoOuvidos, 1);
});

// ── Depois da resposta: o modelo obedeceu? ──────────────────────────────────────────────────────────────

test('travada e o modelo não transferiu: o código passa para a equipe', () => {
  const r = analisarRepeticao(TRAVADA);
  const t = travaDaResposta(r, 'Me conta onde dói? 😊', []);
  assert.equal(t?.acao, 'passar_para_equipe');
  if (t?.acao === 'passar_para_equipe') {
    assert.match(t.frase, /alguém da nossa equipe/);
    assert.doesNotMatch(t.frase, /em instantes|avaliação/);
  }
  // só anotou (tag, campo): ainda não andou com a conversa
  assert.equal(travaDaResposta(r, 'Me conta onde dói?', ['aplicar_tag'])?.acao, 'passar_para_equipe');
  // transferiu ou andou com a conversa: nada a fazer
  assert.equal(travaDaResposta(r, 'Vou chamar alguém da equipe 🙏', ['pausar_ia']), null);
  assert.equal(travaDaResposta(r, 'Tenho terça às 10h. Serve?', ['consultar_horarios']), null);
});

test('pediu o nome pela 3ª vez: refaz sem o pedido; sem pedir, segue', () => {
  const r = analisarRepeticao(MOSSORO);
  assert.equal(travaDaResposta(r, 'Claro! 😊 Só preciso de uma coisa antes: como posso te chamar?', [])?.acao, 'refazer_sem_nome');
  assert.equal(travaDaResposta(r, 'A gente cuida de coluna: hérnia, ciático, lombar. Onde dói?', []), null);
  // o nome completo para marcar não é barrado
  assert.equal(travaDaResposta(r, 'Pra marcar, me passa seu nome completo?', []), null);
});

// ── Do grafo para falas ─────────────────────────────────────────────────────────────────────────────────

test('falas do histórico: tira o bloco da conversa oficial, ignora ferramenta e IA sem texto', () => {
  const msgs = [
    new HumanMessage('<conversa_oficial>\nEQUIPE: oi\n</conversa_oficial>\n\nQual o valor?'),
    new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'aplicar_tag', args: {} }] }),
    new ToolMessage({ content: 'ok', tool_call_id: 't1' }),
    new AIMessage({ content: [{ type: 'text', text: 'Claro! Onde dói?' }] }),
    new HumanMessage('nas costas'),
  ];
  assert.deepEqual(falasDoHistorico(msgs), [p('Qual o valor?'), ia('Claro! Onde dói?'), p('nas costas')]);
  assert.deepEqual(ferramentasDoTurno(msgs), []);
  assert.deepEqual(
    ferramentasDoTurno([...msgs, new AIMessage({ content: '', tool_calls: [{ id: 't2', name: 'pausar_ia', args: {} }] })]),
    ['pausar_ia'],
  );
});

test('o bloco <repeticao> entra no prompt do turno quando há histórico', () => {
  const unit = { slug: 't', name: 'T', collectNameEnabled: true, personaEmojis: [], handoffKeywords: [] } as unknown as Unit;
  assert.doesNotMatch(composeSystemPrompt({ unit }), /<repeticao>/);
  assert.match(composeSystemPrompt({ unit, historico: MOSSORO }), /<repeticao>[\s\S]*já pediu o nome 2 vezes/);
});
