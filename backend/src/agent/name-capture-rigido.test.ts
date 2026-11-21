/**
 * Rede de segurança do título do cartão: o que NÃO pode virar nome, e o que continua virando.
 *
 * O banco de casos é a produção de 05–21/11/2026 (rede toda): 317 trocas «[safety-net] IA esqueceu de chamar atualizar_titulo_lead —
 * corrigido». Das 76 que tiraram o cartão de «Lead #N» / «Lead dd/mm/aaaa», ~2/3 eram lixo: marcador de mídia ("Imagem Do Cliente" 9×,
 * "Áudio Do Cliente" 2×), link ("Https" 4×), cumprimento cortado ("Ol", "Td Bem"), palavra solta depois de «como posso te chamar?»
 * ("Lomba", "Esim", "Canaense", "Nego Lindo", "Aonde Faca") e cauda de frase colada ao nome ("Daniel E Falo Do Análise").
 *
 * As falas são as reais, enxutas; sobrenome de gente foi trocado por outro (o teste só depende da FORMA), e o primeiro nome fica.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capturaRigidaLigada, detectarNome, detectNameDisclosure, nomeCorroborado, tituloJaTrazONome } from './name-capture.js';

interface Caso {
  caso: string;
  fala: string;
  /** A IA tinha acabado de perguntar o nome. */
  perguntou?: boolean;
  /** Nome do contato no WhatsApp (author.name do webhook). */
  perfil?: string;
}

// ---------------------------------------------------------------------------------------------------- lixo: não grava nada

const LIXO: Caso[] = [
  // marcador de mídia e descrição de imagem (a IA recebe "[imagem do cliente]: <o que o modelo de visão viu>")
  { caso: 'Imagem Do Cliente (figurinha de bom dia)', perguntou: true, fala: '[imagem do cliente]: Essa imagem é uma ilustração de flores e árvores, acompanhada da frase "Bom dia, Ótima Terça-Feira". É decorativa.' },
  { caso: 'Imagem Do Cliente (recusa do modelo)', fala: '[imagem do cliente]: Desculpe, não posso ajudar com isso.' },
  { caso: 'Imagem Do Cliente (texto + foto)', perguntou: true, fala: 'Sinto esses sintomas aqui!\n\n[imagem do cliente]: A imagem apresenta uma ilustração sobre o nervo ciático, destacando a dor.' },
  { caso: 'Imagem Do Cliente (documento)', perguntou: true, fala: '[imagem do cliente]: O documento é uma orientação sobre a Emenda Constitucional nº 138/2025, que trata da acumulação.' },
  { caso: 'Imagem Do Cliente (sem nada)', perguntou: true, fala: '[imagem do cliente]:' },
  { caso: 'Áudio Do Cliente (vazio)', perguntou: true, fala: '[áudio do cliente]:' },
  // link
  { caso: 'Https (facebook)', perguntou: true, fala: 'https://www.facebook.com/share/r/1CFkWFyHUi/' },
  { caso: 'Https (instagram)', perguntou: true, fala: 'https://www.instagram.com/p/Dc3g-Q4sAEQ/' },
  // transcrição de áudio: frase solta, não a resposta à pergunta do nome
  { caso: 'Mulher', perguntou: true, fala: '[áudio do cliente]: Mulher, eu tenho vontade de fazer essa fisioterapia, aí porque a minha coluna está um S bem fechado e eu sinto muita dor' },
  { caso: 'Parada Da', fala: '[áudio do cliente]: parada da' },
  { caso: 'Good Morning', perguntou: true, fala: '[áudio do cliente]: Good morning, doctor. Buona noite.' },
  { caso: 'Iniciate', perguntou: true, fala: '[áudio do cliente]: Iniciate, eu tenho um recado pra você. Você não precisa...' },
  { caso: 'Pedreiro', perguntou: true, fala: '[áudio do cliente]: Boa tarde. Pois é, eu sou pedreiro. Aí eu trabalhei uma época numa obra, fui com uma obra.' },
  { caso: 'Ainda Disse', fala: '[áudio do cliente]: É, meu nome é ainda disse que é uma hérnia que se descobre da falta de ar, esqueci o nome' },
  { caso: 'Daqui De São José', perguntou: true, fala: '[áudio do cliente]: É, eu salvei aqui, mas são muito longe, são de Taubaté e eu sou daqui de São José dos Campos' },
  // cumprimento e palavra solta depois de "como posso te chamar?"
  { caso: 'Ol', perguntou: true, fala: 'Ol\n\nPk\n\nOk' },
  { caso: 'Td Bem', perguntou: true, fala: 'Olá bom dia\n\nTd bem' },
  { caso: 'Whats App', perguntou: true, fala: 'Whats app' },
  { caso: 'Esim', perguntou: true, fala: 'Esim' },
  { caso: 'Lomba', perguntou: true, fala: 'Lomba' },
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
  // "sou X" / "aqui é o X" que não é nome
  { caso: 'Analista', fala: 'Bom dia, sou o analista aqui da doutor digital, queria saber mais detalhe sobre o problema na impressora pra eu poder te auxiliar' },
  { caso: 'Favor Do Arquivo E Colocar', perguntou: true, fala: 'Tais em casa no dia da loja de lá estão as coisas que você quer e o nome do livro 📖 eu sou a favor do arquivo e colocar o nome da minha esposa que eu te mandei' },
  { caso: 'Arapay (robô de outra empresa)', fala: 'Olá, sou a Arapay assistente da AranetPlay.\n\nPara eu te ajudar, *informe seu CPF ou CNPJ.*' },
];

test('lixo do banco de produção: nenhum vira nome', () => {
  for (const c of LIXO) {
    assert.equal(
      detectNameDisclosure(c.fala, { nameWasAsked: !!c.perguntou, nomeDoPerfil: c.perfil, rigido: true }),
      null,
      `virou nome: ${c.caso}`,
    );
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
  ];
  for (const [fala, esperado] of casos) {
    assert.equal(detectNameDisclosure(fala, { rigido: true }), esperado, fala);
  }
});

test('sobrenome depois de "de/da/do" continua inteiro', () => {
  const casos: Array<[string, string]> = [
    ['Meu nome é Vilazio pereira da silva', 'Vilazio pereira da silva'],
    ['Olá! Meu nome é Rafael do Nascimento dos Santos, moro em Canaã dos Carajás e estou com dor nas costas', 'Rafael do Nascimento dos Santos'],
    ['Meu nome é FLAVIO DE PAIVA RODRIGUES \n\nFui presenteado com o voucher', 'FLAVIO DE PAIVA RODRIGUES'],
    ['Boa tarde!\nMeu nome é Maria de Jesus Souza Araujo.', 'Maria de Jesus Souza Araujo'],
    ['Me chamo maria de fatima', 'maria de fatima'],
    ['[áudio do cliente]: Me chamo Suellen de Oliveira Souza.', 'Suellen de Oliveira Souza'],
    ['Oi boa tarde sou Jorge Luiz da Silva vou mandar meus documentos', 'Jorge Luiz da Silva'],
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
  { caso: 'Wellington (áudio)', nome: 'Wellington', fala: '[áudio do cliente]: Então, Sofia, boa noite, eu me chamo Wellington, lá de Senador La Roque, Maranhão.' },
  { caso: 'Sandra (áudio)', nome: 'Sandra', fala: '[áudio do cliente]: Bom dia, Dani, eu me chamo Sandra e eu gostaria de saber quanto que é a consulta' },
  { caso: 'Aderval (áudio, nome raro, explícito)', nome: 'Aderval', fala: '[áudio do cliente]: Minha dor faz mais de dois anos já, eu trabalho com caminhão. Meu nome é Aderval.' },
  { caso: 'Larissa (nome no meio do texto)', nome: 'Larissa', fala: 'Olá! Tudo bem? Você consegue repassar uma mensagem para o responsável pelo escritório, por favor?\n\nSou a Larissa, da Previdência Mais.', perguntou: true },
  { caso: 'Jozivam (perfil prova)', nome: 'jozivam', perguntou: true, perfil: 'jozivambatista834', fala: 'Aqui é o jozivam\n\nSinto muito dores na coluna' },
  { caso: 'Rai Barros (sou X maiúsculo depois da pergunta)', nome: 'Rai Barros', perguntou: true, fala: 'Sim\n\nSou Rai Barros' },
  { caso: 'Idelci (sou X maiúsculo depois da pergunta)', nome: 'Idelci', perguntou: true, fala: 'Sou Idelci' },
  { caso: 'Formulário do anúncio', nome: 'Gianna', fala: 'Olá! Meu nome é Gianna, moro em Parauapebas e estou com dor que desce para a perna (ciático). Vim pelo formulário' },
  // só o nome, depois de "como posso te chamar?" — primeiro nome comum
  { caso: 'Francisca', nome: 'Francisca', perguntou: true, perfil: 'Edvan', fala: 'Francisca' },
  { caso: 'Selene', nome: 'Selene', perguntou: true, fala: 'Selene' },
  { caso: 'Rozana', nome: 'Rozana', perguntou: true, fala: 'Rozana' },
  { caso: 'Rosária', nome: 'Rosária', perguntou: true, fala: 'Rosária' },
  { caso: 'Isabel', nome: 'Isabel', perguntou: true, fala: 'Isabel' },
  { caso: 'Fábio (sozinho)', nome: 'Fábio', perguntou: true, perfil: 'Jaqueline', fala: 'Fábio' },
  { caso: 'Edite (depois do número)', nome: 'Edite', perguntou: true, fala: 'Pode me chamar no meu PV 98 970014442\nEdite' },
  { caso: 'Josué (rajada)', nome: 'Josué', fala: 'Bom dia Sofia\n\nMe chamo Josué' },
  { caso: 'Carlos Roberto', nome: 'Carlos Roberto', perguntou: true, fala: 'Carlos Roberto' },
  { caso: 'Maria Helena', nome: 'Maria Helena', perguntou: true, fala: 'Maria Helena' },
  { caso: 'Liz Rivera (perfil não prova, lista prova)', nome: 'Liz Rivera', perguntou: true, perfil: 'A L E G Ó N G O R A', fala: 'Liz Rivera' },
  // só o nome, nome fora da lista: o perfil do WhatsApp prova
  { caso: 'Mateus (perfil igual)', nome: 'Mateus beckmam', perguntou: true, perfil: 'mateus beckmam', fala: 'Mateus beckmam' },
  { caso: 'Eliana (perfil é e-mail)', nome: 'Eliana', perguntou: true, perfil: 'elianamello650@gmail.com', fala: 'Eliana' },
  { caso: 'Orfenildes (perfil por prefixo)', nome: 'Orfenildes', perguntou: true, perfil: 'Orfenildes S', fala: 'Orfenildes' },
];

test('reais do banco de produção: continuam virando nome', () => {
  for (const c of REAIS) {
    assert.equal(
      detectNameDisclosure(c.fala, { nameWasAsked: !!c.perguntou, nomeDoPerfil: c.perfil, rigido: true }),
      c.nome,
      `perdeu o nome: ${c.caso}`,
    );
  }
});

/**
 * O que a regra nova PERDE, de propósito: palavra solta, nome raro, sem «meu nome é» e sem o mesmo nome no perfil do WhatsApp.
 * Nada é gravado errado; o cartão fica como estava e a IA ainda pode chamar atualizar_titulo_lead (que confere com o que o paciente
 * disse). Medido no banco: 6 de 262 reais (Florzinha de Jesus, Itanarraira, Jheneff, Orfenildes, Ildes, Josy).
 */
test('perda conhecida: nome raro, dito sozinho, sem prova — não grava', () => {
  assert.equal(detectNameDisclosure('Itanarraira', { nameWasAsked: true, nomeDoPerfil: '', rigido: true }), null);
  assert.equal(detectNameDisclosure('Ildes', { nameWasAsked: true, nomeDoPerfil: 'Anna Karoline', rigido: true }), null);
  assert.equal(detectNameDisclosure('Florzinha de Jesus.', { nameWasAsked: true, nomeDoPerfil: 'Cleony', rigido: true }), null);
  // com «meu nome é» a mesma pessoa passa
  assert.equal(detectNameDisclosure('Meu nome é Ildes', { nameWasAsked: true, nomeDoPerfil: 'Anna Karoline', rigido: true }), 'Ildes');
});

// ---------------------------------------------------------------------------------------------------- peças

test('nomeCorroborado — lista de primeiros nomes ou palavra do perfil', () => {
  assert.equal(nomeCorroborado('Francisca'), true);
  assert.equal(nomeCorroborado('Maria da Silva'), true);
  assert.equal(nomeCorroborado('Lomba'), false);
  assert.equal(nomeCorroborado('Lomba', 'Lomba Transportes'), true);
  assert.equal(nomeCorroborado('Lomba', 'Lombardi Transportes'), false); // prefixo curto é coincidência
  assert.equal(nomeCorroborado('Jozivam', 'jozivambatista834'), true);
  assert.equal(nomeCorroborado('Xan', 'Xanadu'), false); // prefixo só a partir de 4 letras
  assert.equal(nomeCorroborado('Jo', 'Jo'), false);
});

test('detectarNome — só pede o perfil quando um nome rejeitado por falta de prova poderia passar com ele', () => {
  assert.deepEqual(detectarNome('Itanarraira', { nameWasAsked: true, rigido: true }), { nome: null, precisaPerfil: true });
  assert.deepEqual(detectarNome('Itanarraira', { nameWasAsked: true, nomeDoPerfil: 'Itanarraira Souza', rigido: true }), { nome: 'Itanarraira', precisaPerfil: false });
  assert.deepEqual(detectarNome('Francisca', { nameWasAsked: true, rigido: true }), { nome: 'Francisca', precisaPerfil: false }); // a lista já prova
  assert.deepEqual(detectarNome('Meu nome é Itanarraira', { rigido: true }), { nome: 'Itanarraira', precisaPerfil: false }); // frase explícita
  assert.deepEqual(detectarNome('Olá, bom dia', { nameWasAsked: true, rigido: true }), { nome: null, precisaPerfil: false });
  assert.deepEqual(detectarNome('Itanarraira', { nameWasAsked: false, rigido: true }), { nome: null, precisaPerfil: false }); // IA não perguntou
  assert.deepEqual(detectarNome('Itanarraira', { nameWasAsked: true, rigido: false }), { nome: 'Itanarraira', precisaPerfil: false });
});

test('texto escrito DEPOIS da descrição da imagem continua valendo; a descrição não', () => {
  assert.equal(detectNameDisclosure('[imagem do cliente]: A imagem mostra um exame de ressonância.\n\nMeu nome é Ana', { rigido: true }), 'Ana');
  assert.equal(detectNameDisclosure('[imagem do cliente]: A imagem mostra um exame de ressonância.\n\nFrancisca', { nameWasAsked: true, rigido: true }), 'Francisca');
  assert.equal(detectNameDisclosure('[imagem do cliente]: Cartão com o texto Meu nome é Ana Paula', { rigido: true }), null);
});

test('"Gilmar é o meu nome" e "Gilmar meu nome" continuam valendo no modo rígido', () => {
  assert.equal(detectNameDisclosure('Gilmar é o meu nome', { rigido: true }), 'Gilmar');
  assert.equal(detectNameDisclosure('Gilmar meu nome.', { rigido: true }), 'Gilmar');
  assert.equal(detectNameDisclosure('Saiu com o meu nome aí', { rigido: true }), null);
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

test('interruptor de emergência — TITULO_CAPTURA_RIGIDA=off volta ao comportamento antigo', () => {
  assert.equal(capturaRigidaLigada(undefined), true);
  assert.equal(capturaRigidaLigada(''), true);
  assert.equal(capturaRigidaLigada('on'), true);
  assert.equal(capturaRigidaLigada('off'), false);
  assert.equal(capturaRigidaLigada(' OFF '), false);
  // desligado, a palavra solta volta a valer (é o que a chave desfaz)
  assert.equal(detectNameDisclosure('Lomba', { nameWasAsked: true, rigido: false }), 'Lomba');
  assert.equal(detectNameDisclosure('Lomba', { nameWasAsked: true, rigido: true }), null);
  // e sem `rigido` explícito vale o env
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
