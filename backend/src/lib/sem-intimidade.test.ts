import { test } from 'node:test';
import assert from 'node:assert/strict';
import { semIntimidade, temIntimidade } from './sem-intimidade.js';

/** Todas as entradas abaixo são mensagens REAIS que saíram para pacientes em set/2026. */

test('a mensagem de Rio Verde que o João apontou', () => {
  assert.equal(
    semIntimidade('Por nada, Ricardo! Um até logo bem carinhoso pra você 😊 Nos vemos segunda-feira!'),
    'Por nada, Ricardo! Um até logo pra você 😊 Nos vemos segunda-feira!',
  );
});

test('"um beijo" vira "um abraço" e a FRASE CONTINUA INTEIRA', () => {
  // Este teste é o que a primeira versão errava: ela apagava o núcleo da despedida e
  // deixava ". e toda sua família." Uma trava de tom não pode mutilar a frase.
  assert.equal(
    semIntimidade('Vou levar essas suas palavras. Um beijo grande pra você e toda sua família.'),
    'Vou levar essas suas palavras. Um abraço pra você e toda sua família.',
  );
  assert.equal(
    semIntimidade('Qualquer coisa, é só me chamar, tá? Um beijo e melhoras! 💙🙏'),
    'Qualquer coisa, é só me chamar, tá? Um abraço e melhoras! 💙🙏',
  );
  assert.equal(
    semIntimidade('Qualquer coisa é só me chamar, tá bem? Um beijo pro seu esposo e melhoras pra ele! 🤗'),
    'Qualquer coisa é só me chamar, tá bem? Um abraço pro seu esposo e melhoras pra ele! 🤗',
  );
  assert.equal(
    semIntimidade('Eu que agradeço, um beijo grande e que você continue muito bem! 💙'),
    'Eu que agradeço, um abraço e que você continue muito bem! 💙',
  );
  assert.equal(
    semIntimidade('Por nada, Belinha! Um beijo, e conte comigo quando estiver tudo certo pra marcar 💜😊.'),
    'Por nada, Belinha! Um abraço, e conte comigo quando estiver tudo certo pra marcar 💜😊.',
  );
});

test('despedida sozinha não pode virar pontuação solta', () => {
  // "Um beijo!" virando "!" fazia o webhook descartar a resposta (temPalavra) e a paciente
  // ficava sem retorno nenhum. Pior que o tom íntimo.
  assert.equal(semIntimidade('Um beijo!'), 'Um abraço!');
  assert.equal(semIntimidade('Beijos! Até amanhã.'), 'Um abraço! Até amanhã.');
  for (const t of ['Um beijo!', 'Beijos!', 'beijos', 'Um beijo grande!']) {
    assert.match(semIntimidade(t), /\p{L}/u, `sobrou sem letra: ${t}`);
  }
});

test('"com carinho" some sem deixar buraco', () => {
  assert.equal(
    semIntimidade('Já deixo segunda, 21/09 às 13h anotado com carinho aqui pra você.'),
    'Já deixo segunda, 21/09 às 13h anotado aqui pra você.',
  );
  assert.equal(
    semIntimidade('Assim já vou te chamando certinho e te explico tudo com carinho 😊'),
    'Assim já vou te chamando certinho e te explico tudo 😊',
  );
  assert.equal(semIntimidade('Te espero com muito carinho!'), 'Te espero!');
  assert.equal(semIntimidade('Vou olhar seu caso com todo carinho.'), 'Vou olhar seu caso.');
});

test('"com carinho" abrindo linha é assinatura, e a quebra de linha sobrevive', () => {
  // Com \s+ no lugar de [ \t]+ isto virava "me chama., Sofia" — a regra comia o \n.
  assert.equal(
    semIntimidade('Qualquer dúvida me chama.\nCom carinho, Sofia'),
    'Qualquer dúvida me chama.\nUm abraço, Sofia',
  );
});

test('"carinhoso" sai só quando qualifica a despedida', () => {
  assert.equal(
    semIntimidade('Um abraço bem carinhoso pra você também! 💜 Foi ótimo falar por aqui.'),
    'Um abraço pra você também! 💜 Foi ótimo falar por aqui.',
  );
  assert.equal(semIntimidade('Até breve, um abraço carinhoso! 😊🙏'), 'Até breve, um abraço! 😊🙏');
});

test('CARINHO SOBRE O PACIENTE OU A CLÍNICA FICA — não é intimidade indevida', () => {
  // Uma regra solta em /carinhos[ao]/ produzia "A nossa equipe é." e "Que lembrança."
  for (const t of [
    'Que lembrança carinhosa 💙 Deve trazer tantas saudades.',
    'Amém, muito obrigada pelas suas palavras tão carinhosas! 🙏',
    'A nossa equipe é super carinhosa.',
  ]) {
    assert.equal(semIntimidade(t), t, t);
  }
});

test('vocativo íntimo sai, com e sem possessivo, e a maiúscula volta', () => {
  assert.equal(semIntimidade('Oi, querida! Como você está?'), 'Oi! Como você está?');
  assert.equal(semIntimidade('Claro, meu bem, já te explico.'), 'Claro, já te explico.');
  assert.equal(
    semIntimidade('Ai, minha querida, me perdoa o engano! 🙏'),
    'Ai, me perdoa o engano! 🙏',
  );
  assert.equal(
    semIntimidade('Boa tarde, meu querido! 😊 Sua consulta já está certinha para o dia 18/09.'),
    'Boa tarde! 😊 Sua consulta já está certinha para o dia 18/09.',
  );
  assert.equal(
    semIntimidade('Neide, meu bem, meu coração aperta ouvindo tudo isso 🥰'),
    'Neide, meu coração aperta ouvindo tudo isso 🥰',
  );
  // Começo de frase: a próxima palavra recupera a maiúscula.
  assert.equal(
    semIntimidade('Minha querida, isso que a senhora sentiu precisa ser visto.'),
    'Isso que a senhora sentiu precisa ser visto.',
  );
  // Nome próprio não é vocativo íntimo.
  assert.equal(semIntimidade('Oi, Ricardo! Tudo bem?'), 'Oi, Ricardo! Tudo bem?');
});

test('ELOGIO CONTINUA INTEIRO — "linda", "amor" e "que fofa" não são intimidade indevida', () => {
  for (const t of [
    'Que mensagem linda, Maria, muito obrigada!',
    'Que amor de filha, Vanuza 🥰 Cuidar assim de um pai idoso é lindo.',
    'Quer ajudar seu marido a se cuidar, que amor da sua parte! 🥰',
    'Que fofa, muito obrigada! 💜 Um ótimo descanso pra você também.',
    'Bom dia pra você também! 😊💜 Que fofa essa figurinha!',
  ]) {
    assert.equal(semIntimidade(t), t, t);
  }
});

test('não confunde palavra que contém o alvo', () => {
  for (const t of [
    'O Dr. beijou a testa do paciente.',
    'A carinha do exame mostra a curvatura.',
    'Ele é querido por todos os pacientes da clínica.',
    'O tratamento é feito por fisioterapeuta especializada.',
  ]) {
    assert.equal(semIntimidade(t), t, t);
  }
});

test('mensagem limpa passa intacta e não é marcada', () => {
  const t = 'A consulta é R$ 350 no dia, ou R$ 250 pagando antes por Pix. Até breve!';
  assert.equal(semIntimidade(t), t);
  assert.equal(temIntimidade(t), false);
  assert.equal(temIntimidade('Um beijo e até breve!'), true);
});

test('nunca deixa espaço nem pontuação sobrando', () => {
  for (const t of [
    'Te espero com carinho , tá?',
    'Oi, querida ! Como vai?',
    'Claro, meu bem , já te explico.',
  ]) {
    const r = semIntimidade(t);
    assert.doesNotMatch(r, /[ \t]{2,}/, `ficou espaço duplo: ${r}`);
    assert.doesNotMatch(r, /[ \t][,.!?]/, `ficou espaço antes de pontuação: ${r}`);
  }
});

test('texto vazio não quebra', () => {
  assert.equal(semIntimidade(''), '');
});
