import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pediuParaParar, ehSoCumprimento } from './pediu-para-parar.js';
import { semBlocoOficial } from './conversa-oficial.js';

/**
 * Todas as frases abaixo são mensagens REAIS de pacientes, tiradas do banco em 26/09/2026.
 * As da seção "NÃO É PEDIDO" são as armadilhas que quase entraram na regra.
 */

test('a frase da Glória, que começou tudo', () => {
  assert.equal(
    pediuParaParar(
      'Desculpa, mas nao gosto de insistência, principalmente quando se trata de saúde. Falei que ia analisar, e hoje já vem uma mensagem.',
    ),
    'irritacao',
  );
});

test('irritação de verdade cala a régua para sempre', () => {
  for (const t of [
    'Sabe vcs enche o saco já falei que de manhã',
    'Meu Deus do céu ja falei . Que sim. Que saber esquece. Acho que e golpe Esquece',
    'Vou bloquear e amanhã chegamos aí',
    'me deixa em paz',
    'não me manda mais mensagem',
    'pare de me ligar por favor',
    'vocês são muito chatos',
    'me tira dessa lista',
  ]) {
    assert.equal(pediuParaParar(t), 'irritacao', t);
  }
});

test('adiamento apenas ADIA — é lead bom pedindo tempo', () => {
  for (const t of [
    'Vou analisar',
    'Certo vou analisar aqui',
    'Vou analisar e te aviso obg',
    'Vou pensar, e retorno.',
    'Depois te retorno',
    'Amanhã eu retorno',
    'Qualquer coisa eu entro em contato.',
    'vou ver certinho, vou conversar com meus pais qualquer coisa eu retorno',
    'Vou conversar com meu esposo',
    'Eu vou conversar com ele e volto a falar com vcs',
    'Tá bom depois eu vou conversar com meu cunhado',
    'Vou ver te falo',
    'Vou ver com ele',
    'Vou ver se consigo ir amanhã',
    'Deixa vou ver aqui depois entro em contato com vc.',
    'Não consegui sair do trabalho ainda.. Mas vou verificar',
  ]) {
    assert.equal(pediuParaParar(t), 'adiamento', t);
  }
});

test('NÃO É PEDIDO PARA PARAR — as armadilhas que eu quase programei', () => {
  for (const t of [
    // "para de" não é pedido: aqui significa "para a tarde", "não cessa"
    'Para de tarde',
    'Tá atrapalhando tudo e não para de doer já tomei todo tipo de injeção',
    'Todos dias trabalho porque não posso para de trabalhar',
    // "já falei" é o paciente repetindo informação, não reclamando
    'Como ja falei na lombar e incomoda muito',
    'Já falei da dor e meu nome',
    'Já falei q e difícil melhorar em 3 sessões',
    'Já falei',
    'Eu já falei tudo',
    'Desculpa já falei  To sem grana',
    // "spam" é a paciente ajudando
    'olha em spam tbm',
    // "vou ver" dando informação AGORA, não adiando
    'Ele tem plano, vou ver o nome aqui.',
    // conversa normal
    'Estou sofrendo com o nervo ciático',
    'Meu nome é Mário',
    'Me manda o Pix pra fazer Pix',
    'Teria algum convênio para desconto?',
  ]) {
    assert.equal(pediuParaParar(t), null, t);
  }
});

test('irritação vence adiamento quando os dois aparecem', () => {
  // A frase da Glória tem "ia analisar" E "não gosto de insistência". A irritação manda.
  assert.equal(pediuParaParar('Falei que ia analisar e vocês são chatos'), 'irritacao');
});

test('texto vazio não é pedido', () => {
  assert.equal(pediuParaParar(''), null);
  assert.equal(pediuParaParar('   '), null);
});

test('só cumprimento — o caso que fez a Glória desistir', () => {
  for (const t of ['Bom dia', 'bom dia!', 'Boa tarde 😊', 'Oi', 'Oii', 'Olá!', 'oi, tudo bem?', 'Boa noite 🙏💙']) {
    assert.equal(ehSoCumprimento(t), true, t);
  }
});

test('cumprimento COM assunto não é só cumprimento — aí a IA conduz normal', () => {
  for (const t of [
    'Bom dia, queria saber o valor',
    'Oi, tenho hérnia na cervical',
    'Boa tarde! Não vou ter como ir',
    'Bom dia, pode marcar pra quinta?',
    'Olá! Tenho interesse e queria mais informações, por favor.',
  ]) {
    assert.equal(ehSoCumprimento(t), false, t);
  }
});

test('vazio não é cumprimento', () => {
  assert.equal(ehSoCumprimento(''), false);
  assert.equal(ehSoCumprimento('   '), false);
});

test('suspeita no PASSADO não é irritação — ela deixou de achar que era golpe', () => {
  assert.equal(pediuParaParar('Eu achava que isso e golpe'), null);
  assert.equal(pediuParaParar('pensei que era golpe, mas vi que é sério'), null);
  // presente continua pegando
  assert.equal(pediuParaParar('Acho que e golpe'), 'irritacao');
  assert.equal(pediuParaParar('E golpe'), 'irritacao');
});

test('a mensagem que anuncia o bloqueio é o caso mais grave', () => {
  assert.equal(
    pediuParaParar(
      'Se eu agradeci e nao demonstrei mais interesse, nao fiquem mandando msg, pois perdem potênciais clientes devido insistência chata. Bloqueando em 3,2,1',
    ),
    'irritacao',
  );
});

// ── falsos positivos achados pelo review (28/09/2026), antes de subir ──

test('"meu retorno" é quem quer AGENDAR — não pode calar a régua dela', () => {
  // Os pronomes de "(eu) (te) retorno" eram opcionais, então o substantivo casava. Em clínica de
  // coluna "retorno" é a consulta de volta antes de ser verbo, e essa paciente está pedindo horário.
  for (const frase of [
    'quero marcar meu retorno',
    'Preciso agendar o retorno com a doutora',
    'quando é o meu retorno?',
    'oi, gostaria de remarcar o retorno',
  ]) {
    assert.equal(pediuParaParar(frase), null, frase);
  }
});

test('"eu te retorno" continua sendo adiamento — o verbo não se perdeu na correção', () => {
  for (const frase of ['depois eu te retorno', 'eu retorno amanhã', 'te retorno mais tarde']) {
    assert.equal(pediuParaParar(frase), 'adiamento', frase);
  }
});

test('"dor insistente" é sintoma, não irritação', () => {
  for (const frase of [
    'minha dor está insistente',
    'é uma dor insistente na lombar',
    'a dor anda insistente esses dias',
  ]) {
    assert.equal(pediuParaParar(frase), null, frase);
  }
});

test('mas "vocês são insistentes" continua sendo irritação', () => {
  for (const frase of ['vocês são muito insistentes', 'vcs tão insistentes demais']) {
    assert.equal(pediuParaParar(frase), 'irritacao', frase);
  }
});

test('o bloco da conversa oficial não pode esconder o cumprimento da Glória', () => {
  // O HumanMessage chega com <conversa_oficial> pregado na frente. Se `ehSoCumprimento` receber a
  // string inteira, ela nunca reconhece "bom dia" — e a regra morre no caso que a criou.
  const bloco =
    '<conversa_oficial>\nO que aconteceu no WhatsApp desde a sua última mensagem:\n' +
    '- 09:12 · Equipe (Júlia): "bom dia, conseguiu ver os horários?"\n</conversa_oficial>';
  assert.equal(ehSoCumprimento(`${bloco}\n\nbom dia`), false, 'com o bloco grudado, some o cumprimento');
  assert.equal(ehSoCumprimento(semBlocoOficial(`${bloco}\n\nbom dia`)!), true, 'sem o bloco, reconhece');
});
