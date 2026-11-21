/**
 * Rede de segurança do título do cartão: o que NÃO pode virar nome, e o que continua virando.
 *
 * O banco de casos é a produção de 05–21/11/2026 (rede toda): 317 trocas «[safety-net] IA esqueceu de chamar atualizar_titulo_lead —
 * corrigido». Das 76 que tiraram o cartão de «Lead #N» / «Lead dd/mm/aaaa», ~2/3 eram lixo: marcador de mídia ("Imagem Do Cliente" 9×,
 * "Áudio Do Cliente" 2×), link ("Https" 4×), cumprimento cortado ("Ol", "Td Bem"), palavra solta depois de «como posso te chamar?»
 * ("Lomba", "Esim", "Canaense", "Nego Lindo", "Aonde Faca") e cauda de frase colada ao nome ("Daniel E Falo Do Análise").
 * Mais as respostas à pergunta do nome que a revisão achou nas 4.799 respostas reais («Mim Chamou Rodrigo», «Nome De Valdete…»).
 *
 * As falas são as reais, enxutas; sobrenome de gente foi trocado por outro (o teste só depende da FORMA), e o primeiro nome fica.
 * Áudio SOZINHO chega à IA sem a marca "[áudio do cliente]" (webhook.controller.ts, ~1454): os casos de áudio abaixo estão nos dois formatos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capturaRigidaLigada, detectNameDisclosure, looksLikeName, nomeCorroborado, tituloJaTrazONome } from './name-capture.js';

interface Caso {
  caso: string;
  fala: string;
  /** A IA tinha acabado de perguntar o nome. */
  perguntou?: boolean;
}

// ---------------------------------------------------------------------------------------------------- lixo: não grava nada

const LIXO: Caso[] = [
  // marcador de mídia e descrição de imagem (a IA recebe "[imagem do cliente]: <o que o modelo de visão viu>")
  { caso: 'Imagem Do Cliente (figurinha de bom dia)', perguntou: true, fala: '[imagem do cliente]: Essa imagem é uma ilustração de flores e árvores, acompanhada da frase "Bom dia, Ótima Terça-Feira". É decorativa.' },
  { caso: 'Imagem Do Cliente (recusa do modelo)', fala: '[imagem do cliente]: Desculpe, não posso ajudar com isso.' },
  { caso: 'Imagem Do Cliente (texto + foto)', perguntou: true, fala: 'Sinto esses sintomas aqui!\n\n[imagem do cliente]: A imagem apresenta uma ilustração sobre o nervo ciático, destacando a dor.' },
  { caso: 'Imagem Do Cliente (documento)', perguntou: true, fala: '[imagem do cliente]: O documento é uma orientação sobre a Emenda Constitucional nº 138/2025, que trata da acumulação.' },
  { caso: 'Imagem Do Cliente (descrição com parágrafo)', perguntou: true, fala: '[imagem do cliente]: Cartão de visita.\n\nMaria Souza\n\nMeu nome é Ana Paula' },
  { caso: 'Imagem Do Cliente (sem nada)', perguntou: true, fala: '[imagem do cliente]:' },
  { caso: 'Áudio Do Cliente (vazio)', perguntou: true, fala: '[áudio do cliente]:' },
  // link
  { caso: 'Https (facebook)', perguntou: true, fala: 'https://www.facebook.com/share/r/1CFkWFyHUi/' },
  { caso: 'Https (instagram)', perguntou: true, fala: 'https://www.instagram.com/p/Dc3g-Q4sAEQ/' },
  // transcrição de áudio: frase solta, não a resposta à pergunta do nome (COM a marca…)
  { caso: 'Mulher', perguntou: true, fala: '[áudio do cliente]: Mulher, eu tenho vontade de fazer essa fisioterapia, aí porque a minha coluna está um S bem fechado e eu sinto muita dor' },
  { caso: 'Parada Da', fala: '[áudio do cliente]: parada da' },
  { caso: 'Good Morning', perguntou: true, fala: '[áudio do cliente]: Good morning, doctor. Buona noite.' },
  { caso: 'Iniciate', perguntou: true, fala: '[áudio do cliente]: Iniciate, eu tenho um recado pra você. Você não precisa...' },
  { caso: 'Pedreiro', perguntou: true, fala: '[áudio do cliente]: Boa tarde. Pois é, eu sou pedreiro. Aí eu trabalhei uma época numa obra, fui com uma obra.' },
  { caso: 'Ainda Disse', fala: '[áudio do cliente]: É, meu nome é ainda disse que é uma hérnia que se descobre da falta de ar, esqueci o nome' },
  { caso: 'Daqui De São José', perguntou: true, fala: '[áudio do cliente]: É, eu salvei aqui, mas são muito longe, são de Taubaté e eu sou daqui de São José dos Campos' },
  // …e SEM a marca (áudio sozinho): o nome da IA de Salto e cumprimento falado com a atendente
  { caso: 'Aline (nome da IA de Salto) falada no áudio', perguntou: true, fala: 'Aline, boa tarde, queria o valor da consulta' },
  { caso: 'Sara (IA de Tatuí) falada no áudio', perguntou: true, fala: 'Sara, bom dia, eu queria marcar uma consulta pra minha mãe' },
  { caso: 'Maria falada no áudio (cumprimento + pedido)', perguntou: true, fala: 'Maria, boa tarde, queria saber quanto custa a consulta' },
  { caso: 'Mulher (áudio sem marca)', perguntou: true, fala: 'Mulher, eu tenho vontade de fazer essa fisioterapia, aí porque a minha coluna está um S bem fechado' },
  // cumprimento e palavra solta depois de "como posso te chamar?"
  { caso: 'Ol', perguntou: true, fala: 'Ol\n\nPk\n\nOk' },
  { caso: 'Td Bem', perguntou: true, fala: 'Olá bom dia\n\nTd bem' },
  { caso: 'Whats App', perguntou: true, fala: 'Whats app' },
  { caso: 'Esim', perguntou: true, fala: 'Esim' },
  { caso: 'Lomba', perguntou: true, fala: 'Lomba' },
  { caso: 'Canaense', perguntou: true, fala: 'Canaense' },
  { caso: 'Nego Lindo', perguntou: true, fala: 'Nego lindo' },
  { caso: 'Aonde Faca', perguntou: true, fala: 'Aonde faca' },
  { caso: 'Três Ou Quatro Meses', perguntou: true, fala: 'Três ou quatro meses' },
  { caso: 'Atendente Unimed', perguntou: true, fala: 'Atendente Unimed' },
  { caso: 'Algo Do Tipo', perguntou: true, fala: 'Queria saber como funciona\n\nMarcar um horário\n\nAlgo do tipo' },
  { caso: 'Lado Esquerda', perguntou: true, fala: 'Dor na coluna\n\nLado esquerda\n\nMe machuquei com peso' },
  { caso: 'Deu Nada', perguntou: true, fala: 'Sim tenho ressonância da coluna\n\nDeu nada' },
  { caso: 'Chave', perguntou: true, fala: 'vou enviar o pix de 50,00\n\nchave' },
  { caso: 'Pindorama Do Tocantins', perguntou: true, fala: 'Pindorama do Tocantins' },
  { caso: 'Cuanto Saldra Una Cirugia', perguntou: true, fala: 'Cuanto saldra una cirugia de vecicula' },
  { caso: 'Dese', perguntou: true, fala: 'Sim\n\nDese' },
  { caso: 'Ko', perguntou: true, fala: 'Oii\n\nKo\n\nFaoa' },
  { caso: 'Renovações (resposta automática de outra empresa)', perguntou: true, fala: 'Olá, queridos clientes! 😊\nEsta mensagem é automática.\n\n⏰ Renovações: segunda a sábado, das 09h às 21h.' },
  { caso: 'Saiu', fala: 'Saiu com o meu nome aí' },
  // as respostas à pergunta do nome que a revisão achou em 4.799 respostas reais: a 1ª palavra tem que ser nome
  { caso: 'Mim Chamou Rodrigo', perguntou: true, fala: 'Mim chamou Rodrigo' },
  { caso: 'Chame Ana Mesmo', perguntou: true, fala: 'Chame Ana mesmo' },
  { caso: 'Nome De Valdete…', perguntou: true, fala: 'Nome de Valdete Lopes de Oliveira dos Anjos' },
  { caso: 'Nome E Maria Inês', perguntou: true, fala: 'Nome e Maria Inês' },
  { caso: 'Vanila Sodré E Letícia Sodré (cortada em « e »)', perguntou: true, fala: 'Vanila Sodré e Letícia Sodré' },
  { caso: 'Data De Nascimento', perguntou: true, fala: 'Data de nascimento: 10/01/1974' },
  { caso: 'Alguns Dias (termina em sobrenome, mas 2 palavras e a 1ª não é nome)', perguntou: true, fala: 'Alguns dias' },
  { caso: 'Rua com sobrenome', perguntou: true, fala: 'Rua Maria da Silva' },
  // "sou X" / "aqui é o X" que não é nome
  { caso: 'Analista', fala: 'Bom dia, sou o analista aqui da doutor digital, queria saber mais detalhe sobre o problema na impressora pra eu poder te auxiliar' },
  { caso: 'Favor Do Arquivo E Colocar', perguntou: true, fala: 'Tais em casa no dia da loja de lá estão as coisas que você quer e o nome do livro 📖 eu sou a favor do arquivo e colocar o nome da minha esposa que eu te mandei' },
  { caso: 'Arapay (robô de outra empresa)', fala: 'Olá, sou a Arapay assistente da AranetPlay.\n\nPara eu te ajudar, *informe seu CPF ou CNPJ.*' },
  { caso: 'Sofia (nome da IA da rede, «Eu sou a Sofia»)', perguntou: true, fala: 'Eu sou a Sofia' },
  { caso: 'Web Designer (duas palavras sem prova)', perguntou: true, fala: 'Sou Web Designer' },
  // lugar não é nome (padrão explícito)
  { caso: 'Meu nome é Goiânia', fala: 'Meu nome é Goiânia' },
  { caso: 'Me chamo Parauapebas', perguntou: true, fala: 'Me chamo Parauapebas' },
];

test('lixo do banco de produção: nenhum vira nome', () => {
  for (const c of LIXO) {
    assert.equal(detectNameDisclosure(c.fala, { nameWasAsked: !!c.perguntou, rigido: true }), null, `virou nome: ${c.caso}`);
  }
});

// ---------------------------------------------------------------------------------------------------- cauda colada ao nome

test('frase colada depois do nome é cortada: fica só o nome', () => {
  const casos: Array<[string, string]> = [
    ['Bom dia, me chamo Daniel e falo do Análise Laboratório Clínico, tudo bem?', 'Daniel'],
    ['Bom dia, tudo bem?\nSou a Sandy e trabalho com planos de saúde da Unimed. Gostaria de conhecer melhor nossos planos?', 'Sandy'],
    ['Olá Boa tarde tudo bem? Meu nome é Bruno Pires da IA2GO quem me passou seu contato foi a Karen gestora da unidade.', 'Bruno Pires'],
    ['oii\n\naqui é o breno da reunião\n\nesqueci seu nome pra colocar aqui na ata', 'breno'],
    ['Boa noite,sou Marcos Nunes Recife-pe. Gostaria de saber se está havendo uma seleção do grupo de vocês', 'Marcos Nunes'],
    ['Olá, tudo bem? Meu nome é Thais Pinto sou consultora digital e vou lhe auxiliar hoje.', 'Thais Pinto'],
    ['Meu nome é Mateus exatamente como está no cadastro', 'Mateus'],
    ['Meu nome é Erica ⏎ Há mais ou menos 5 dias'.replace(' ⏎ ', '\n'), 'Erica'],
  ];
  for (const [fala, esperado] of casos) {
    assert.equal(detectNameDisclosure(fala, { rigido: true }), esperado, fala);
  }
});

test('«de/da/do» só segue se vier sobrenome: «Ana da Recepção» é a Ana', () => {
  const casos: Array<[string, string]> = [
    ['Meu nome é Vilazio pereira da silva', 'Vilazio pereira da silva'],
    ['Olá! Meu nome é Rafael do Nascimento dos Santos, moro em Canaã dos Carajás e estou com dor nas costas', 'Rafael do Nascimento dos Santos'],
    ['Meu nome é FLAVIO DE PAIVA RODRIGUES \n\nFui presenteado com o voucher', 'FLAVIO DE PAIVA RODRIGUES'],
    ['Boa tarde!\nMeu nome é Maria de Jesus Souza Araujo.', 'Maria de Jesus Souza Araujo'],
    ['Me chamo maria de fatima', 'maria de fatima'],
    ['[áudio do cliente]: Me chamo Suellen de Oliveira Souza.', 'Suellen de Oliveira Souza'],
    ['Oi boa tarde sou Jorge Luiz da Silva vou mandar meus documentos', 'Jorge Luiz da Silva'],
    // não é sobrenome
    ['Oi, aqui é a Ana da recepção', 'Ana'],
    ['Oi, aqui é a Ana da Recepção', 'Ana'],
    ['Aqui é o Carlos do Banco', 'Carlos'],
  ];
  for (const [fala, esperado] of casos) {
    assert.equal(detectNameDisclosure(fala, { rigido: true }), esperado, fala);
  }
});

// ---------------------------------------------------------------------------------------------------- reais: continuam passando

const REAIS: Array<Caso & { nome: string }> = [
  // frase explícita
  { caso: 'Maiara', nome: 'Maiara', fala: 'Oii Claudinei bom diaa! 😊 Tudo bem?\nMe chamo Maiara e vou iniciar seu atendimento.\nComo posso te ajudar?' },
  { caso: 'Alana', nome: 'Alana', fala: 'Meu nome é Alana, sou sócia-proprietária da REVO Films, uma produtora audiovisual de Timbó' },
  { caso: 'Emanuel', nome: 'Emanuel', fala: 'Olá, tudo bem?\n\nMeu nome é Emanuel, sou fisioterapeuta, pós-graduado em Fisioterapia Ortopédica e Esportiva.' },
  { caso: 'Júlia', nome: 'Júlia', fala: '*Meu nome é Júlia e se me permita, caso precise futuramente de camisetas nos colocamos a disposição*!!!!' },
  { caso: 'Alexia', nome: 'Alexia', fala: 'Boa tarde: meu nome é Alexia, trabalho com planos odontológico Bradesco dental e Unimed odonto' },
  { caso: 'Wanderlene', nome: 'wanderlene', fala: 'Me chamo wanderlene sou fisioterapeuta e vi um anúncio p enviar currículo' },
  { caso: 'Paloma (sobrenome composto)', nome: 'Paloma Silva Souza', fala: 'Olá, bom dia! Tudo bem?\nMeu nome é Paloma Silva Souza, sou fisioterapeuta, formada recentemente' },
  { caso: 'Lúcia', nome: 'Lúcia', fala: 'Sou a Lúcia, assistente virtual da Stone, tudo certo por aqui 😄' },
  { caso: 'Fábio (aqui é o)', nome: 'Fábio', fala: 'Olá, eu sou o Fábio, especialista em tráfego pago para Google, Facebook e Instagram.' },
  { caso: 'Lucas (aqui é o)', nome: 'Lucas', fala: 'Bom dia, tudo bem? Aqui é o Lucas, da ROX. Estou precisando falar com alguém de operações' },
  { caso: 'João (aqui é o, sobrenome)', nome: 'João Almeida', fala: 'Oi, tudo bem? Aqui é o João Almeida, da SVI Company. Vi no Google que Doutor Hérnia tem mais de 170 avaliações' },
  { caso: 'Wellington (áudio com marca)', nome: 'Wellington', fala: '[áudio do cliente]: Então, Sofia, boa noite, eu me chamo Wellington, lá de Senador La Roque, Maranhão.' },
  { caso: 'Wellington (áudio sem marca)', nome: 'Wellington', fala: 'Então, Sofia, boa noite, eu me chamo Wellington, lá de Senador La Roque, Maranhão.' },
  { caso: 'Sandra (áudio)', nome: 'Sandra', fala: '[áudio do cliente]: Bom dia, Dani, eu me chamo Sandra e eu gostaria de saber quanto que é a consulta' },
  { caso: 'Aderval (áudio, nome raro, explícito)', nome: 'Aderval', fala: '[áudio do cliente]: Minha dor faz mais de dois anos já, eu trabalho com caminhão. Meu nome é Aderval.' },
  { caso: 'Larissa (nome no meio do texto)', nome: 'Larissa', fala: 'Olá! Tudo bem? Você consegue repassar uma mensagem para o responsável pelo escritório, por favor?\n\nSou a Larissa, da Previdência Mais.', perguntou: true },
  { caso: 'Idelci (sou X maiúsculo depois da pergunta)', nome: 'Idelci', perguntou: true, fala: 'Sou Idelci' },
  { caso: 'Formulário do anúncio', nome: 'Gianna', fala: 'Olá! Meu nome é Gianna, moro em Parauapebas e estou com dor que desce para a perna (ciático). Vim pelo formulário' },
  { caso: 'Gilmar meu nome', nome: 'Gilmar', fala: 'Gilmar é o meu nome' },
  // só o nome, depois de "como posso te chamar?" — primeiro nome comum
  { caso: 'Francisca', nome: 'Francisca', perguntou: true, fala: 'Francisca' },
  { caso: 'Selene', nome: 'Selene', perguntou: true, fala: 'Selene' },
  { caso: 'Rozana', nome: 'Rozana', perguntou: true, fala: 'Rozana' },
  { caso: 'Rosária', nome: 'Rosária', perguntou: true, fala: 'Rosária' },
  { caso: 'Isabel', nome: 'Isabel', perguntou: true, fala: 'Isabel' },
  { caso: 'Fábio (sozinho)', nome: 'Fábio', perguntou: true, fala: 'Fábio' },
  { caso: 'Edite (depois do número)', nome: 'Edite', perguntou: true, fala: 'Pode me chamar no meu PV 98 970014442\nEdite' },
  { caso: 'Josué (rajada)', nome: 'Josué', fala: 'Bom dia Sofia\n\nMe chamo Josué' },
  { caso: 'Carlos Roberto', nome: 'Carlos Roberto', perguntou: true, fala: 'Carlos Roberto' },
  { caso: 'Maria Helena', nome: 'Maria Helena', perguntou: true, fala: 'Maria Helena' },
  { caso: 'Maria, com dor depois', nome: 'Maria', perguntou: true, fala: 'Maria, tenho dor na lombar há 2 anos' },
  { caso: 'Eliana', nome: 'Eliana', perguntou: true, fala: 'Eliana' },
  // nome completo com primeiro nome raro: termina em sobrenome comum
  { caso: 'Adeilma Gomes Lima', nome: 'Adeilma Gomes Lima', perguntou: true, fala: 'Adeilma Gomes Lima' },
  { caso: 'Edna com sobrenome incomum no meio', nome: 'Edna Evangelista Cardoso', perguntou: true, fala: 'Edna Evangelista Cardoso' },
  { caso: 'Cauda sem prova é cortada, o nome fica', nome: 'Mateus', perguntou: true, fala: 'Mateus beckmam' },
  { caso: 'Vanila Sodré e Letícia — corta em « e »', nome: 'Maria', perguntou: true, fala: 'Maria e Joana' },
];

test('reais do banco de produção: continuam virando nome', () => {
  for (const c of REAIS) {
    assert.equal(detectNameDisclosure(c.fala, { nameWasAsked: !!c.perguntou, rigido: true }), c.nome, `perdeu o nome: ${c.caso}`);
  }
});

/**
 * O que a regra nova PERDE, de propósito: palavra solta, nome raro, fora da lista de primeiros nomes e sem «meu nome é». Nada é gravado
 * errado; o cartão fica como estava e a IA ainda pode chamar atualizar_titulo_lead (que confere com o que o paciente disse).
 */
test('perda conhecida: nome raro, dito sozinho — não grava; com «meu nome é» passa', () => {
  assert.equal(detectNameDisclosure('Itanarraira', { nameWasAsked: true, rigido: true }), null);
  assert.equal(detectNameDisclosure('Ildes', { nameWasAsked: true, rigido: true }), null);
  assert.equal(detectNameDisclosure('Florzinha de Jesus.', { nameWasAsked: true, rigido: true }), null);
  assert.equal(detectNameDisclosure('Aqui é o jozivam', { nameWasAsked: true, rigido: true }), null);
  assert.equal(detectNameDisclosure('Meu nome é Ildes', { nameWasAsked: true, rigido: true }), 'Ildes');
  assert.equal(detectNameDisclosure('Me chamo Itanarraira', { rigido: true }), 'Itanarraira');
});

test('a lista de primeiros nomes não tem o nome das IAs da rede nem palavra comum', () => {
  for (const x of ['Aline', 'Sara', 'Cíntia', 'Sophia', 'Sofia', 'Irma', 'Clara', 'Aurora', 'Domingos', 'Rosa', 'Socorro', 'Salvador', 'Marco']) {
    assert.equal(nomeCorroborado(x), false, x);
  }
  for (const x of ['Ana', 'Maria', 'José', 'Eliane', 'William', 'Igor']) assert.equal(nomeCorroborado(x), true, x);
});

// ---------------------------------------------------------------------------------------------------- peças

test('nomeCorroborado — só a 1ª palavra prova; cauda sem prova não passa', () => {
  assert.equal(nomeCorroborado('Francisca'), true);
  assert.equal(nomeCorroborado('Maria da Silva'), true);
  assert.equal(nomeCorroborado('Lomba'), false);
  assert.equal(nomeCorroborado('Mim Chamou Rodrigo'), false); // Rodrigo está na lista, mas não é a 1ª palavra
  assert.equal(nomeCorroborado('Adeilma Gomes Lima'), true); // nome completo terminando em sobrenome comum
  assert.equal(nomeCorroborado('Alguns Dias'), false);
});

test('tituloJaTrazONome — a rede não regrava por cima do título que já tem o nome', () => {
  assert.equal(tituloJaTrazONome('Antônio Souza 16/11/2026', 'Antônio'), true);
  assert.equal(tituloJaTrazONome('Florzinha de Jesus 04/11/2026', 'Florzinha De Jesus'), true);
  assert.equal(tituloJaTrazONome('Maria do Perpétuo Socorro Cunha Araújo 18/11/2026', 'Maria'), true);
  assert.equal(tituloJaTrazONome('Mariana 16/11/2026', 'Maria'), false); // palavra inteira
  assert.equal(tituloJaTrazONome('Lead #123', 'Maria'), false);
  assert.equal(tituloJaTrazONome('Lead 16/11/2026', 'Maria'), false);
  assert.equal(tituloJaTrazONome('Qualquer', ''), false);
});

test('as palavras novas só valem na captura da rede: looksLikeName(x) — atualizar_titulo_lead e o contato — segue como era', () => {
  for (const x of ['Ainda Disse', 'Nome Completo', 'Mim Chamou', 'Rua Maria']) {
    assert.equal(looksLikeName(x), true, `mudou para a IA: ${x}`);
    assert.equal(looksLikeName(x, true), false, `a rede deixou passar: ${x}`);
  }
  assert.equal(looksLikeName('Maria da Silva', true), true);
});

test('segundo nome comum depois de primeiro nome provado: «Maria Clara», «Ana Sophia», «Maria da Penha»', () => {
  assert.equal(detectNameDisclosure('Maria Clara', { nameWasAsked: true, rigido: true }), 'Maria Clara');
  assert.equal(detectNameDisclosure('Ana Sophia', { nameWasAsked: true, rigido: true }), 'Ana Sophia');
  assert.equal(detectNameDisclosure('Meu nome é maria da penha', { rigido: true }), 'maria da penha');
  assert.equal(detectNameDisclosure('Sophia', { nameWasAsked: true, rigido: true }), null); // sozinho não prova (nome de IA)
});

test('áudio COM a marca e mais de 3 palavras não é a resposta ao nome; nome do meio sem maiúscula não passa pela ponta', () => {
  assert.equal(detectNameDisclosure('[áudio do cliente]: Mariana, queria saber o valor da consulta', { nameWasAsked: true, rigido: true }), null);
  assert.equal(detectNameDisclosure('[áudio do cliente]: Mariana', { nameWasAsked: true, rigido: true }), 'Mariana');
  assert.equal(detectNameDisclosure('Maria quero reis', { nameWasAsked: true, rigido: true }), null);
  assert.equal(detectNameDisclosure('Maria Julgamento Reis', { nameWasAsked: true, rigido: true }), 'Maria Julgamento Reis');
  assert.equal(detectNameDisclosure('Maria julgamento reis', { nameWasAsked: true, rigido: true }), 'Maria');
});

test('interruptor de emergência — TITULO_CAPTURA_RIGIDA=off|false|0 devolve tudo ao que era', () => {
  assert.equal(capturaRigidaLigada(undefined), true);
  assert.equal(capturaRigidaLigada(''), true);
  assert.equal(capturaRigidaLigada('on'), true);
  for (const v of ['off', 'OFF', ' off ', 'false', 'False', '0']) assert.equal(capturaRigidaLigada(v), false, v);
  // desligado, a palavra solta volta a valer (é o que a chave desfaz)
  assert.equal(detectNameDisclosure('Lomba', { nameWasAsked: true, rigido: false }), 'Lomba');
  assert.equal(detectNameDisclosure('Lomba', { nameWasAsked: true, rigido: true }), null);
  const antes = process.env.TITULO_CAPTURA_RIGIDA;
  try {
    process.env.TITULO_CAPTURA_RIGIDA = 'off';
    assert.equal(detectNameDisclosure('Lomba', { nameWasAsked: true }), 'Lomba');
    process.env.TITULO_CAPTURA_RIGIDA = 'on';
    assert.equal(detectNameDisclosure('Lomba', { nameWasAsked: true }), null);
  } finally {
    if (antes === undefined) delete process.env.TITULO_CAPTURA_RIGIDA;
    else process.env.TITULO_CAPTURA_RIGIDA = antes;
  }
});
