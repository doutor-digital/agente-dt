/**
 * Auditoria de Araguaína (21/10/2026), item 2: a pergunta de sinais de alerta repetida a quem responde por áudio.
 *
 * Lead 28659614, 15/10, 10:08–10:21: o paciente contou que "se quebrou" na coluna e respondia tudo por áudio
 * (transcrito: nome, cidade, endereço, valor, dia de vir). A Sofia fez a pergunta de sinais de alerta oito vezes,
 * cada vez com outras palavras e quase sempre fechando com outra frase ("Preciso entender isso com cuidado antes
 * de seguir, tá?", "É importante pra sua segurança!"), e a equipe conversava junto.
 *
 * O #101 já contava "mesma pergunta 2x sem resposta"; aqui ele passa a (1) reconhecer a pergunta de sinais em
 * qualquer frase da mensagem e em qualquer formulação e (2) contar como SEM RESPOSTA o áudio que fala de outra
 * coisa — para esta pergunta, é a resposta que falta para seguir. Na 2ª, para de perguntar e passa para a equipe,
 * pelo mesmo caminho do #101 (sem segundo contador). As falas da IA abaixo são as reais; as do paciente, as
 * transcrições resumidas (os áudios não estão no Kommo como texto).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analisarRepeticao,
  motivoDeHandoff,
  perguntaQueEspera,
  renderRepeticao,
  respondeSinalDeAlerta,
  falasDoHistorico,
  TEMA_SINAL_DE_ALERTA,
  travaDaResposta,
  type Fala,
} from './repeticao.js';
import { ehHandoffPorSinalDeAlerta } from './sinal-de-alerta.js';
import { AIMessage, HumanMessage } from '@langchain/core/messages';

const p = (texto: string): Fala => ({ papel: 'paciente', texto });
const ia = (texto: string): Fala => ({ papel: 'ia', texto });

const PERGUNTA_1 =
  'Nossa, sinto muito que você esteja sentindo essa dor! Mas me conta uma coisa importante antes: você disse que "se ' +
  'quebrou" na coluna — foi uma queda forte ou pancada mesmo? E percebeu alguma fraqueza nas pernas, formigamento, ou ' +
  'dificuldade pra controlar xixi/intestino depois disso?\n\nPreciso entender isso com cuidado antes de seguir, tá?';
const PERGUNTA_2 =
  'A localização é: Rua José de Brito Soares, 754 — Setor Anhangüera, Araguaína/TO\n\nMas antes de você vir, preciso ' +
  'saber: depois dessa pancada na coluna, você sentiu alguma fraqueza na perna, formigamento, ou alguma dificuldade pra ' +
  'segurar xixi ou intestino? É importante pra sua segurança!';
const PERGUNTA_3 =
  'Prazer, João! Vi que você vem de Santa Fé do Araguaia pra Araguaína na segunda — que bom que vai poder vir!\n\nMas ' +
  'antes de qualquer coisa, preciso mesmo saber: depois dessa pancada na coluna ontem, você sentiu alguma fraqueza nas ' +
  'pernas, formigamento, ou alguma dificuldade pra segurar xixi ou intestino? Isso é bem importante pra sua segurança, ' +
  'me conta com calma';
const PERGUNTA_REFORMULADA =
  'Entendi, João — obrigada por me contar! Pra eu entender direito: você sentiu alguma fraqueza na perna, tipo ela ' +
  '"bambear" ou perder a força, ou foi mais um formigamento/dormência? E isso ainda está acontecendo ou já passou?';

const ARAGUAINA: Fala[] = [
  p('Oi! Quero mais informações, por favor.\n\n[áudio do cliente]: tô com uma dor na coluna, eu me quebrei ontem'),
  ia(PERGUNTA_1),
  p('onde fica a clínica de vocês?'),
  ia(PERGUNTA_2),
  p('meu nome é João, eu moro em Santa Fé do Araguaia e vou pra Araguaína na segunda'),
  ia(PERGUNTA_3),
  p('vocês têm consultório em Santa Fé também?'),
];

test('item 2: a pergunta de sinais é achada em qualquer frase da mensagem, não só na última', () => {
  assert.match(perguntaQueEspera(PERGUNTA_1) ?? '', /xixi\/intestino/);
  assert.match(perguntaQueEspera(PERGUNTA_2) ?? '', /segurar xixi ou intestino\?/);
  assert.match(perguntaQueEspera(PERGUNTA_REFORMULADA) ?? '', /fraqueza na perna/);
  // mensagem sem pergunta de sinais: a última frase com "?", como antes
  assert.equal(perguntaQueEspera('Entendi! Onde dói? E há quanto tempo?'), 'E há quanto tempo?');
});

test('item 2: reformulada e fechando com outra frase, é a MESMA pergunta (tema "sinal de alerta")', () => {
  const r = analisarRepeticao(ARAGUAINA);
  assert.equal(r.ultimaPergunta?.tema, TEMA_SINAL_DE_ALERTA);
  assert.equal(r.ultimaPergunta?.vezes, 3);
});

test('item 2: áudio sobre outra coisa não responde a pergunta de sinais — na 2ª, transfere como o #101', () => {
  // até a 2ª pergunta: ainda uma tentativa a mais
  const ate2 = analisarRepeticao(ARAGUAINA.slice(0, 5));
  assert.equal(ate2.ultimaPergunta?.semRespostaSeguidas, 2);
  assert.match(motivoDeHandoff(ate2) ?? '', /conversa travada: pergunta de segurança da coluna/);

  const r = analisarRepeticao(ARAGUAINA);
  assert.equal(r.ultimaPergunta?.semRespostaSeguidas, 3);
  const motivo = motivoDeHandoff(r);
  assert.match(motivo ?? '', /pergunta de segurança da coluna \(força na perna, xixi\/intestino\) 3x sem resposta/);
  const bloco = renderRepeticao(r);
  assert.match(bloco, /CONVERSA TRAVADA/);
  assert.match(bloco, /NÃO pergunte de novo/);
  // o modelo perguntou de novo: o código passa para a equipe
  const t = travaDaResposta(r, PERGUNTA_REFORMULADA, []);
  assert.equal(t?.acao, 'passar_para_equipe');
});

test('item 2: o motivo da transferência não vira "paciente com sinal de alerta" (ninguém confirmou sinal nenhum)', () => {
  const motivo = motivoDeHandoff(analisarRepeticao(ARAGUAINA));
  assert.ok(motivo);
  assert.equal(ehHandoffPorSinalDeAlerta(motivo), false);
});

test('item 2: respondeu à pergunta (sim, não, falou da perna ou do xixi): não é conversa travada', () => {
  for (const resposta of [
    'não, graças a Deus não senti nada disso',
    'Não',
    'sim, a perna direita formigou',
    '[áudio do cliente]: senti um formigamento na perna mas já passou',
    'xixi normal, só a dor mesmo',
    'nenhum desses',
  ]) {
    assert.ok(respondeSinalDeAlerta(resposta), `responde: ${resposta}`);
    const r = analisarRepeticao([...ARAGUAINA.slice(0, -1), p(resposta)]);
    assert.equal(motivoDeHandoff(r), null, `não transfere: ${resposta}`);
  }
  for (const outra of ['onde fica a clínica de vocês?', 'quanto é a consulta?', 'segunda eu vou aí', 'meu nome é João']) {
    assert.ok(!respondeSinalDeAlerta(outra), `não responde: ${outra}`);
  }
});

test('item 2: cumprimento depois das perguntas segue sendo retomada, como no #101', () => {
  const r = analisarRepeticao([...ARAGUAINA.slice(0, -1), p('Bom dia')]);
  assert.equal(motivoDeHandoff(r), null);
  assert.match(renderRepeticao(r), /NÃO repita/);
});

test('item 2: "já te falei" segue não transferindo — a IA é que não leu', () => {
  const r = analisarRepeticao([...ARAGUAINA.slice(0, -1), p('já te falei, moça')]);
  assert.equal(motivoDeHandoff(r), null);
  assert.match(renderRepeticao(r), /JÁ RESPONDEU/);
});

test('item 2: pergunta de sinais que nunca chegou (resposta segurada) não conta como feita', () => {
  // duas perguntas de sinais seguradas (o paciente escrevia enquanto elas nasciam) — ele nunca as leu
  const grafo = [
    new HumanMessage('tô com dor na lombar'),
    new AIMessage({ content: 'Entendi! Há quanto tempo?', id: 'ok-1' }),
    new HumanMessage('uns 3 dias'),
    new AIMessage({ content: PERGUNTA_2, id: 'seg-1' }),
    new HumanMessage('e o valor?'),
    new AIMessage({ content: PERGUNTA_3, id: 'seg-2' }),
    new HumanMessage('moro em Santa Fé'),
  ];
  assert.ok(motivoDeHandoff(analisarRepeticao(falasDoHistorico(grafo))), 'com as seguradas no histórico, transferiria');
  assert.equal(motivoDeHandoff(analisarRepeticao(falasDoHistorico(grafo, ['seg-1', 'seg-2']))), null);
});

test('item 2: as outras perguntas seguem a regra do #101 — fala com conteúdo é resposta', () => {
  const r = analisarRepeticao([
    p('Quero saber do tratamento'),
    ia('Claro! Me conta: onde dói e há quanto tempo você sente isso?'),
    p('onde fica a clínica?'),
    ia('Fica na Rua X. E me conta: onde é essa dor e desde quando?'),
    p('e o valor?'),
  ]);
  assert.equal(r.ultimaPergunta?.vezes, 2);
  assert.equal(motivoDeHandoff(r), null);
});
