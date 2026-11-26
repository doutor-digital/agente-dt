/**
 * A IA comenta a CHAMADA de ferramenta que ela mesma fez (Salto, lead 5038681, 25/11/2026, 10:38 UTC). A trava da objeção inventada
 * forçou consultar_horarios; a volta do modelo abriu com o juízo sobre a chamada e foi entregue ao paciente:
 *   "Essa chamada de horários foi precipitada, ainda não entendi a queixa. Vou responder corretamente primeiro.\n\nClaro, já te
 *    explico tudo! Antes, me conta: onde é a sua dor e há quanto tempo ela começou? …"
 *
 * Varredura de 28/08 a 26/11 (107.665 respostas da Sofia, main × este PR): SÓ_PREENCHER
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cortarAberturaMetanarrativa, detectarVazamento } from './vazamento.js';

const SALTO =
  'Essa chamada de horários foi precipitada, ainda não entendi a queixa. Vou responder corretamente primeiro.\n\n' +
  'Claro, já te explico tudo! Antes, me conta: onde é a sua dor e há quanto tempo ela começou? Assim consigo te orientar certo, inclusive sobre valores.';

test('a abertura que comenta a própria chamada é bastidor', () => {
  assert.equal(detectarVazamento(SALTO)?.tipo, 'bastidor_em_portugues');
  assert.equal(detectarVazamento('Essa chamada de horários foi precipitada, ainda não entendi a queixa.')?.tipo, 'bastidor_em_portugues');
  assert.equal(detectarVazamento('Vou responder corretamente primeiro.')?.tipo, 'bastidor_em_portugues');
  // a outra resposta real da varredura
  assert.equal(detectarVazamento('Desculpa, acho que me confundi aqui — essa chamada foi um engano meu, sem relação com sua mensagem. 😊')?.tipo, 'bastidor_em_portugues');
  // variações do mesmo comentário
  for (const v of ['Essa chamada da agenda foi desnecessária.', 'Esta chamada de horários era prematura, não vou usar.', 'Essa chamada foi um erro meu.']) {
    assert.equal(detectarVazamento(v)?.tipo, 'bastidor_em_portugues', v);
  }
});

test('o parágrafo do comentário sai sozinho e fica só a fala ao paciente', () => {
  const sai = cortarAberturaMetanarrativa(SALTO);
  assert.ok(sai.startsWith('Claro, já te explico tudo!'), sai);
  assert.doesNotMatch(sai, /chamada|precipitada|corretamente primeiro/i);
  assert.equal(detectarVazamento(sai), null, 'o que sobra tem de estar limpo');
});

test('fala normal sobre horário, consulta e chamada passa (e o corte não mexe)', () => {
  for (const ok of [
    'Vou consultar os horários pra você, um minutinho 😊',
    'A consulta de horários é feita pela recepção, viu? Me conta onde dói?',
    'A chamada de vídeo é feita pelo WhatsApp, é só atender quando tocar.',
    'Essa chamada de vídeo foi rápida, mas já ficou tudo certo, obrigada!',
    'Se a chamada caiu, me avisa que eu te ligo de volta.',
    'Vou responder sua dúvida corretamente: a consulta é R$ 350 no dia.',
    'Vou responder direito sua pergunta primeiro e depois vemos os horários, combinado?',
    'Deixa eu ver a agenda e já te respondo corretamente 😊',
    'Não vou ignorar suas instruções, pode deixar!',
    'Essa chamada foi marcada para amanhã às 10h, tudo bem?',
    'A última chamada que a equipe fez foi ontem; quer que eu peça outra?',
    'A última chamada foi um erro da operadora, vou pedir pra equipe te ligar de novo.',
    'Essa chamada estava errada, desculpa: o número certo é o da recepção.',
    'Pode desconsiderar a última chamada, ela caiu. Me conta onde dói?',
  ]) {
    assert.equal(detectarVazamento(ok), null, `barrou fala legítima: ${ok}`);
    assert.equal(cortarAberturaMetanarrativa(ok), ok);
  }
  const doisParagrafos = 'Vou consultar os horários pra você 😊\n\nOnde é a sua dor e há quanto tempo você sente?';
  assert.equal(cortarAberturaMetanarrativa(doisParagrafos), doisParagrafos);
});

test('comentário que também fala com o paciente fica para o reescritor, não é cortado', () => {
  const t = 'Essa chamada foi um engano meu, sem relação com a sua mensagem.\n\nMe conta onde dói?';
  assert.ok(detectarVazamento(t));
  assert.equal(cortarAberturaMetanarrativa(t), t);
});
