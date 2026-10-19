import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeName,
  extractLeadingName,
  detectNameDisclosure,
  askedForName,
  titleCaseName,
} from './name-capture.js';

test('looksLikeName — nomes válidos passam', () => {
  for (const ok of [
    'Ana',
    'Maria Silva',
    'Edna Evangelista Cardoso',
    'João',
    'Maria da Silva',
    'Ana Paula de Souza',
    'João dos Santos',
    "D'Ávila",
    'Ana-Júlia',
  ]) {
    assert.equal(looksLikeName(ok), true, `deveria aceitar: "${ok}"`);
  }
});

test('looksLikeName — NÃO-nomes são rejeitados', () => {
  for (const bad of [
    'um pouco coucuda',
    'um pouco corcunda',
    'diabética',
    'corcunda',
    'aposentada',
    'muita dor',
    'dor na coluna',
    'de imperatriz',
    'sou',
    'bom dia',
    'oi tudo bem',
    'quero saber o preço',
    'quanto é a consulta',
    '',
    '   ',
    'a',
    '123',
    'José123',
    'nome sobrenome mais um monte de palavra',
    'e Silva',
  ]) {
    assert.equal(looksLikeName(bad), false, `deveria REJEITAR: "${bad}"`);
  }
});

test('extractLeadingName — pega só o começo até o stopword', () => {
  assert.equal(extractLeadingName('João e tenho dor'), 'João');
  assert.equal(extractLeadingName('Maria Silva e quero saber o valor'), 'Maria Silva');
  assert.equal(extractLeadingName('um pouco coucuda'), null);
  assert.equal(extractLeadingName('Edna Evangelista Cardoso'), 'Edna Evangelista Cardoso');
  assert.equal(extractLeadingName('diabética'), null);
});

test('detectNameDisclosure — padrões explícitos capturam', () => {
  assert.equal(detectNameDisclosure('meu nome é José'), 'José');
  assert.equal(detectNameDisclosure('me chamo Maria Silva'), 'Maria Silva');
  assert.equal(detectNameDisclosure('meu nome completo é Ana Paula de Souza'), 'Ana Paula de Souza');
  assert.equal(detectNameDisclosure('eu sou João'), 'João');
  assert.equal(detectNameDisclosure('sou a Ana'), 'Ana');
  assert.equal(detectNameDisclosure('pode me chamar de Zé'), 'Zé');
});

test('detectNameDisclosure — o BUG DA EDNA e afins retornam null', () => {
  assert.equal(detectNameDisclosure('eu sou um pouco coucuda'), null);
  assert.equal(
    detectNameDisclosure(
      'Oi bom dia eu gostaria de saber quanto é a consulta por que eu sofro com muita dor na coluna eu sou um pouco coucuda',
    ),
    null,
  );
  assert.equal(detectNameDisclosure('sou diabética'), null);
  assert.equal(detectNameDisclosure('sou aposentada'), null);
  assert.equal(detectNameDisclosure('sou de imperatriz'), null);
  assert.equal(detectNameDisclosure('tenho muita dor na coluna'), null);
  assert.equal(detectNameDisclosure('quanto é a consulta?'), null);
  assert.equal(detectNameDisclosure('quero marcar uma avaliação'), null);
});

test('detectNameDisclosure — nome "pelado" só captura quando a IA perguntou', () => {
  assert.equal(detectNameDisclosure('Edna Evangelista Cardoso'), null);
  assert.equal(
    detectNameDisclosure('Edna Evangelista Cardoso', { nameWasAsked: true }),
    'Edna Evangelista Cardoso',
  );
  assert.equal(
    detectNameDisclosure('pode marcar depois do dia 25 de agosto', { nameWasAsked: true }),
    null,
  );
  assert.equal(detectNameDisclosure('tá bom pode ser', { nameWasAsked: true }), null);
});

test('askedForName — detecta a IA pedindo o nome', () => {
  assert.equal(askedForName('Antes de tudo, como posso te chamar?'), true);
  assert.equal(askedForName('Me passa seu nome completo?'), true);
  assert.equal(askedForName('Qual o seu nome?'), true);
  assert.equal(askedForName('A consulta é R$ 350 no PIX.'), false);
  assert.equal(askedForName(null), false);
});

test('titleCaseName — capitaliza certo', () => {
  assert.equal(titleCaseName('joão silva'), 'João Silva');
  assert.equal(titleCaseName('EDNA CARDOSO'), 'Edna Cardoso');
});

/* ─── Nomes compridos (regressão de produção, 28/08/2026) ─────────────────── */

test('aceita nome brasileiro comprido com conectores', () => {
  // O caso real: Imperatriz, lead 24954279. Tinha 5 palavras e o card ficou vazio.
  assert.equal(looksLikeName('Elzilene de Sales Dias Nogueira'), true);
  assert.equal(looksLikeName('Maria da Silva dos Santos'), true);
  assert.equal(looksLikeName('José Carlos de Almeida Ferreira Neto'), true);
  assert.equal(looksLikeName('Ana Paula e Souza'), true);
});

test('continua recusando frase que o paciente digita no lugar do nome', () => {
  assert.equal(looksLikeName('quero marcar uma consulta pra minha mãe'), false);
  assert.equal(looksLikeName('estou com muita dor na coluna lombar'), false);
  assert.equal(looksLikeName('bom dia gostaria de saber o valor'), false);
});

test('recusa nome longo demais para ser nome de pessoa', () => {
  assert.equal(looksLikeName('Ana Beatriz Carolina Daniela Eduarda Fabiana Gabriela'), false);
});

// ------------------------------------------------- pergunta não é nome

/**
 * Caso real, Serra, 01/09/2026 — lead #20115379.
 *
 * A IA perguntou "como posso te chamar?". A paciente respondeu "Vcs atendem
 * planos de saúde?". A captura leu isso como nome e renomeou o cartão dela
 * para "Vcs Atendem Planos 25/08/2026" — que é o formato exato que o
 * safety-net escreve, `<nome> <data>`.
 *
 * Responder pergunta com pergunta é o comportamento NORMAL do paciente, não a
 * exceção: das 4 mensagens dela, 3 eram perguntas.
 */
test('paciente que responde com outra pergunta não vira nome', () => {
  const perguntas = [
    'Vcs atendem planos de saúde?',
    'Onde vcs ficam?',
    'Quanto custa a consulta?',
    'Vocês aceitam convênio?',
    'Tem horário amanhã?',
  ];
  for (const p of perguntas) {
    assert.equal(detectNameDisclosure(p, { nameWasAsked: true }), null, `virou nome: ${p}`);
  }
});

test('mesmo sem interrogação, verbo de pergunta não vira nome', () => {
  // Muita gente escreve sem pontuação no WhatsApp.
  for (const p of ['Vcs atendem planos de saude', 'vcs aceitam convenio', 'vc trabalha com plano']) {
    assert.equal(detectNameDisclosure(p, { nameWasAsked: true }), null, `virou nome: ${p}`);
  }
});

test('as correções não quebraram os nomes que já funcionavam', () => {
  // "Maria da Silva" quase quebrou: sem acento, o "da" do nome é igual ao verbo
  // "dá". O conector precisa vencer a lista de verbos.
  const nomes: Array<[string, string]> = [
    ['Dayane', 'Dayane'],
    ['José Carlos', 'José Carlos'],
    ['Maria da Silva dos Santos', 'Maria da Silva dos Santos'],
    ['Elzilene de Sales Dias Nogueira', 'Elzilene de Sales Dias Nogueira'],
  ];
  for (const [msg, esperado] of nomes) {
    assert.equal(detectNameDisclosure(msg, { nameWasAsked: true }), esperado);
  }
});

test('"meu nome é X" continua funcionando mesmo com pergunta na frase', () => {
  // O padrão explícito roda ANTES da trava de interrogação, e deve continuar
  // assim: quem diz o nome e emenda uma pergunta está dizendo o nome.
  assert.equal(detectNameDisclosure('meu nome é Dayane, vcs atendem plano?'), 'Dayane');
});

/* ─── Rede de segurança gravando frase como nome (medido 19/10/2026) ───────── */

test('depois de perguntar o nome, frase que só COMEÇA com palavra não vira nome', () => {
  // Respostas reais que viraram título de cartão ("Desculpa 14/10/2026", "Atrapalha …", "Flow …").
  const frases = [
    'Desculpa apertei errado, não tenho problema nenhum',
    'Desculpa',
    'Obg',
    'Obgd',
    'Combinado',
    'Mas hj eu tô de férias',
    'Mas vocês pode me dizer o número o nome da clínica aí que eu posso levar ele aí',
    'Assim eu estou sentindo muita dor não minha parte lombar nas pernas',
    'Tinha o costume em ir em quiropratas, devido a um acidente a anos atras',
    'Atrapalha no meu desempenho no trabalho',
    'Atrapalha no trabalho',
    'Já fiz uma cirurgia de ernia de disco na coluna',
    'Já fiz',
    'Agora não',
    'Depois entro em contato.',
    'Amiga',
    'Então',
    'Era sobre uma dor na coluna',
    'Fui pegar um peso ontem senti uma fisgada nas costas',
    'Achei muito legal esse vídeo',
    'Aí tem ortopedista',
    'Flow responses received',
    'Unable to display this message in CRM. View it in the WhatsApp Business app.',
    'Unable to open this message. Ask the contact to send it in a supported WhatsApp format.',
    'Meu amor ❤️ Paulo +55 94 99115-4449',
  ];
  for (const f of frases) {
    assert.equal(detectNameDisclosure(f, { nameWasAsked: true }), null, `virou nome: ${f}`);
  }
});

test('depois de perguntar o nome, o nome sozinho (com vírgula, ponto ou emoji) continua valendo', () => {
  const casos: Array<[string, string]> = [
    ['Flávio', 'Flávio'],
    ['Flávio Dias Sousa', 'Flávio Dias Sousa'],
    ['Rerison Kenede Silva', 'Rerison Kenede Silva'],
    ['Maria, tenho dor na lombar há 2 anos', 'Maria'],
    ['Ana Paula.', 'Ana Paula'],
    ['Maria 😊', 'Maria'],
    ['Lucilene - mãe do José', 'Lucilene'],
  ];
  for (const [msg, esperado] of casos) {
    assert.equal(detectNameDisclosure(msg, { nameWasAsked: true }), esperado, msg);
  }
});

test('"sou X" só vira nome com X em maiúscula — profissão não é nome', () => {
  assert.equal(detectNameDisclosure('No pescoço.ha uns cinco anos , não posso pegar peso, sou auxiliar de professora'), null);
  assert.equal(detectNameDisclosure('já sou paciente de vocês'), null);
  assert.equal(detectNameDisclosure('sou motorista de aplicativo'), null);
  assert.equal(detectNameDisclosure('eu sou João'), 'João');
  assert.equal(detectNameDisclosure('Oi, sou a Ana'), 'Ana');
  assert.equal(detectNameDisclosure('sou Amanda'), 'Amanda');
});

test('rajada, minúscula com artigo e "X meu nome" — nomes reais que a regra nova não pode perder', () => {
  const casos: Array<[string, string]> = [
    ['Olá bom dia\n\nLindalva', 'Lindalva'],
    ['Sou o jonas', 'jonas'],
    ['Sou a vania', 'vania'],
    ['Sou suzane', 'suzane'],
    ['Gilmar meu nome.', 'Gilmar'],
    ['José Filho', 'José Filho'],
    ['Irma Santos', 'Irma Santos'],
  ];
  for (const [msg, esperado] of casos) {
    assert.equal(detectNameDisclosure(msg, { nameWasAsked: true }), esperado, msg);
  }
  // sem a IA ter perguntado, "sou x" em minúscula e sem artigo não conta
  assert.equal(detectNameDisclosure('Sou suzane'), null);
  assert.equal(detectNameDisclosure('Sou a vania'), 'vania');
});

test('cumprimento, risada e resposta de sistema não viram nome', () => {
  for (const f of ['Oiii', 'Oie', 'Oii bom dia', 'kkkkk', 'Rsrs', 'Número telefone', 'Confirmo horário', 'Opção inválida', 'Sim, sou a doutora da clínica', 'Hola buenos noches doctora', 'Soy venezolana']) {
    assert.equal(detectNameDisclosure(f, { nameWasAsked: true }), null, `virou nome: ${f}`);
  }
});
