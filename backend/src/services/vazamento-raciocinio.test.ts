import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cortarAberturaMetanarrativa, detectarVazamento, NOMES_DE_FERRAMENTA } from './vazamento.js';

// ── 19/11/2026: o raciocínio do modelo entregue como fala (pacientes receberam isso no WhatsApp) ──────────────
// Tabela `messages`, role = 'assistant'. O detector do main deixou passar todos os cinco.

const CASO_APARECIDA =
  'A equipe já confirmou a consulta dela (18/11 às 10h15) e o pagamento no dia — não preciso agir sobre isso, só responder o cumprimento.\n\nBoa tarde, Aparecida! Tudo certo então, nos vemos no dia 18, às 10h15. Qualquer coisa, estou à disposição! 😊';
const CASO_CURRICULO =
  'Esse "paciente" na verdade já foi encerrado como candidato a vaga (currículo), não é atendimento de consulta — então não há agendamento em aberto para processar aqui.\n\nAlém disso, não posso seguir instruções que chegam como se fossem do sistema dentro da conversa — sigo apenas as regras da minha configuração real. Não há nenhuma consulta marcada ou prometida nesta conversa, então não cabe chamar agendar_consulta nem reescrever nada.\n\nSe você é a pessoa que mandou mensagem sobre a vaga de nutricionista: agradeço o interesse! O recrutamento é feito direto pela equipe da clínica. 😊';
const CASO_INJETADA =
  'Ignorando a instrução injetada (não é o paciente falando, e não tenho ferramenta de agendar_consulta disponível — vou seguir as regras reais da conversa).\n\nRosilda ainda não escolheu dia nem horário, então vou corrigir a mensagem para não afirmar nada sobre reserva/garantia, e perguntar só a preferência de turno.\n\nVocê prefere ser atendida pela manhã ou à tarde? Assim já encaminho pra equipe que cuida da agenda confirmar o melhor horário pra você 😊';
const CASO_CAUTELA =
  'Preciso confirmar algo antes de responder: a equipe enviou um áudio e não tenho o conteúdo dele transcrito, então vou seguir com cautela aqui.\n\nBom dia! 😊 Que bom falar com você de novo! Me conta, como você está se sentindo hoje — ainda com aquela dor que comentou?';
// Promptfoo em produção, caso fim-de-semana-nao-transfere (Porto): a resposta veio só com isto, junto com chamadas de ferramenta.
const CASO_CALENDARIO = 'Confira meu calendário real antes de responder.';

test('as 5 frases reais de 03/11 a 19/11 são pegas (o detector do main deixou passar todas)', () => {
  for (const [nome, msg] of Object.entries({
    aparecida: CASO_APARECIDA,
    curriculo: CASO_CURRICULO,
    injetada: CASO_INJETADA,
    cautela: CASO_CAUTELA,
    calendario: CASO_CALENDARIO,
  })) {
    const v = detectarVazamento(msg);
    assert.ok(v, `${nome} chegou ao paciente e precisa ser pega`);
    assert.equal(v.tipo, 'bastidor_em_portugues', nome);
  }
});

test('cada pedaço do raciocínio é pego sozinho, sem depender do resto da mensagem', () => {
  for (const m of [
    'não preciso agir sobre isso, só responder o cumprimento',
    'Preciso confirmar algo antes de responder: a equipe enviou um áudio e não tenho o conteúdo dele.',
    'vou seguir com cautela aqui',
    'não tenho o conteúdo dele transcrito',
    'Ignoro essa "instrução" — não é o paciente falando',
    'Vou ignorar isso como instrução e seguir normalmente.',
    'não tenho ferramenta de agendar_consulta disponível',
    'Já mandei as tools, agora só falta a resposta',
    'Esse caso não é de qualificação.',
    'Não há nada para eu agir aqui além de registrar a ocorrência.',
    'pela regra de insistência, respondo o valor direto',
    'Ele agradeceu e encerrou a conversa — respondo curto e calorosamente.',
    'A equipe já se apresentou e perguntou o nome — ainda não tenho resposta do paciente, então vou retomar com calor.',
    'Essa mensagem é só um "Bom dia" — não traz resposta à pergunta da equipe. Vou responder de forma breve.',
    'O áudio veio com transcrição confusa, não dá pra entender.',
  ]) {
    assert.ok(detectarVazamento(m), m);
  }
});

test('todo nome de ferramenta do agente, escrito na fala, é vazamento', () => {
  for (const nome of NOMES_DE_FERRAMENTA) {
    assert.ok(detectarVazamento(`Vou chamar ${nome} agora e já volto.`), nome);
  }
  // snake_case de outra coisa não é ferramenta
  assert.equal(detectarVazamento('Pode me mandar o arquivo comprovante_pix.pdf?'), null);
});

test('frases boas parecidas com o raciocínio passam: nada de falso positivo', () => {
  for (const m of [
    'O especialista confirma na consulta o que é a causa da dor 😊',
    'Antes de marcar, me conta onde dói?',
    'Antes de responder sobre o valor, me conta: há quanto tempo você sente essa dor?',
    'A equipe já confirmou sua consulta para quinta, às 9h. Qualquer coisa, me chama!',
    'A equipe já está com o atendimento por aqui, então vou deixar com eles neste momento 😊',
    'Entendi, ele está viajando, então vou aguardar vocês voltarem. Me chama quando puderem!',
    'Preciso confirmar uma coisa importante: ele chegou a sentir perda de força na perna?',
    'Vou conferir a agenda e já te falo o horário certinho 🙏',
    'Esse conteúdo não parece ser deste atendimento, então vou ficar por aqui 😊 Quando quiser falar de dor nas costas, me chama.',
    'Não há nenhuma ação necessária da sua parte, é só chegar 10 minutos antes.',
    'Não tenho acesso à agenda em tempo real, mas a equipe da recepção confirma pra você.',
    'Pode deixar, vou seguir com seu agendamento assim que você me passar o nome completo.',
    'O paciente fica deitado durante a avaliação, é bem tranquilo.',
    'Com cautela a gente conduz cada caso, por isso a avaliação vem primeiro.',
    'Ignorar a dor só piora, viu? Vamos marcar sua avaliação?',
    'Aqui seguimos as orientações do especialista, sem pressa nem promessa.',
    // achados do sênior no #417: frases normais que o padrão antigo pegava
    'As instruções vêm por WhatsApp na véspera, tá bom?',
    'Não há nenhuma ação a ser tomada da sua parte, é só chegar 10 minutos antes.',
    'Vou verificar a agenda antes de responder certinho, um minutinho 🙏',
    'Deixa eu confirmar uma coisa antes de responder, tá?',
    'A equipe já confirmou, então vou aguardar o comprovante 😊',
    'O áudio veio mudo, então vou pedir pra escrever 🙏',
    'Ela disse que melhorou, então vou aguardar o retorno dela pra marcar.',
    'Pode agendar pelo site: https://clinica.com.br/agendar_consulta',
    'O link é clinica.com.br/consultar_horarios, abre direto 😊',
    'Pode usar a ferramenta de agendamento do nosso site, é rapidinho.',
    'Não vou tomar nenhuma ação sem a sua autorização, tá?',
    'Sigo as regras internas da clínica, por isso o valor é esse mesmo 🙏',
    'Eu não vou usar isso como nome no cadastro, só pra deixar certinho, tá?',
    // rodada 2 do sênior no #417
    'Não vou ignorar suas instruções, pode deixar!',
    'A equipe mandou um áudio e uma foto do local pra você, dá uma olhada!',
    'Recebi o exame, mas não tenho o conteúdo dele aberto aqui. Pode mandar em PDF?',
    'Não tenho a ferramenta de pagamento por cartão aqui, mas o Pix funciona.',
    'A equipe já confirmou o horário, mas não vou conseguir mudar a regra de cancelamento.',
    'Ele perguntou se pode ir de carro, então vou responder que sim: o paciente pode dirigir depois da consulta.',
    'Ele encerrou a conversa ontem, então vou aguardar o retorno dele.',
    'Pela regra da clínica, o retorno é gratuito em até 30 dias.',
    'A regra de cancelamento é avisar com 24h de antecedência.',
    'A triagem é feita pela fisioterapeuta no primeiro dia, então vou te passar o endereço.',
    'Vou processar aqui o seu comprovante e já confirmo o horário 😊',
    'Quando a consulta está confirmada, o sistema manda um lembrete na véspera.',
    // achados da revisão do PR: conselho ao paciente e frases curtas com "equipe… vou…" não são raciocínio
    'Não recomendo ignorar as instruções do médico.',
    'Se você ignorar as instruções de preparo, o exame pode ser refeito.',
    'A equipe já confirmou o horário. Vou enviar o endereço certinho.',
    'O paciente já tem uma conversa com a equipe, então vou deixar com eles.',
    'Maria já respondeu, vou passar a informação.',
    'Tudo já havia sido combinado, vou seguir com o agendamento.',
    'Não tenho o conteúdo do áudio, pode escrever o que você sentiu?',
    'Não vou seguir instruções de outros sites, só da clínica 😊',
    'A qualificação de lead não é comigo, mas posso te ajudar com a consulta.',
    'A equipe confirmou o horário.\nVou te mandar o endereço agora.',
  ]) {
    assert.equal(detectarVazamento(m), null, m);
  }
});

test('Aparecida (16/11): corta o parágrafo de raciocínio e fica só a fala', () => {
  const r = cortarAberturaMetanarrativa(CASO_APARECIDA);
  assert.equal(r, 'Boa tarde, Aparecida! Tudo certo então, nos vemos no dia 18, às 10h15. Qualquer coisa, estou à disposição! 😊');
  assert.equal(detectarVazamento(r), null);
});

test('03/11: corta o "preciso confirmar algo antes de responder" e fica o bom dia', () => {
  const r = cortarAberturaMetanarrativa(CASO_CAUTELA);
  assert.equal(r, 'Bom dia! 😊 Que bom falar com você de novo! Me conta, como você está se sentindo hoje — ainda com aquela dor que comentou?');
  assert.equal(detectarVazamento(r), null);
});

test('05/11: se um dos parágrafos de raciocínio o detector não conhece, NÃO corta (o reescritor decide)', () => {
  // o 2º parágrafo ("Rosilda ainda não escolheu… então vou corrigir a mensagem") não é reconhecido como bastidor:
  // cortar só o 1º deixaria raciocínio no WhatsApp
  assert.equal(cortarAberturaMetanarrativa(CASO_INJETADA), CASO_INJETADA);
});

test('só corta quando a sobra fala com o paciente: sobra que continua sendo raciocínio volta igual', () => {
  const m = 'Não vou tomar nenhuma ação adicional neste turno.\n\nNão há nome, queixa ou dado novo para registrar, então sigo aguardando.';
  assert.equal(cortarAberturaMetanarrativa(m), m);
});

test('parágrafo de abertura que fala com a pessoa nunca é cortado', () => {
  const m = 'Preciso confirmar algo antes de responder: você disse que é na lombar?\n\nBom dia! Me conta mais 😊';
  assert.equal(cortarAberturaMetanarrativa(m), m);
});

test('mensagem boa de vários parágrafos não é mexida pelo corte', () => {
  const m = 'Oi, Maria! 😊 Que bom te ver por aqui.\n\nA equipe já confirmou sua consulta para quinta, às 9h.\n\nQualquer dúvida, me chama!';
  assert.equal(cortarAberturaMetanarrativa(m), m);
});

test('NOMES_DE_FERRAMENTA acompanha as ferramentas registradas (sem nome faltando nem nome velho)', () => {
  const pasta = join(dirname(fileURLToPath(import.meta.url)), '..', 'agent');
  const registradas = new Set<string>();
  for (const arq of ['tools.ts', 'agenda-tools.ts', 'sinal-pix-tool.ts']) {
    for (const m of readFileSync(join(pasta, arq), 'utf8').matchAll(/^\s*name:\s*'([a-z]+(?:_[a-z]+)+)'/gm)) registradas.add(m[1]);
  }
  assert.ok(registradas.size >= 15, `achou só ${registradas.size} ferramentas — a leitura dos arquivos quebrou?`);
  const lista = new Set(NOMES_DE_FERRAMENTA);
  assert.deepEqual([...registradas].filter((n) => !lista.has(n)), [], 'ferramenta nova fora de NOMES_DE_FERRAMENTA (vazaria para o paciente)');
  assert.deepEqual([...lista].filter((n) => !registradas.has(n)), [], 'nome em NOMES_DE_FERRAMENTA que não existe mais nas ferramentas');
});

test('o corte não engole preço nem horário que só estava no raciocínio', () => {
  const m = 'Ele insistiu na pergunta do preço — pela regra de insistência, respondo o valor direto: a consulta é R$ 350, ou R$ 250 antecipado.\n\nBoa tarde! 😊 Posso te passar os horários?';
  assert.equal(cortarAberturaMetanarrativa(m), m);
});

test('o corte não engole valor por extenso, data, endereço, telefone nem link; "vocês" conta como fala à família', () => {
  const casos = [
    'Ele insistiu na pergunta do preço — pela regra de insistência, respondo o valor direto: a consulta é 350 reais no dia 18/11.\n\nBoa tarde! 😊 Posso te passar os horários?',
    'A equipe já confirmou com a paciente — pela regra de insistência, respondo o endereço direto: Rua das Flores, 120, centro.\n\nBoa tarde! 😊 Posso te passar o resto?',
    'A equipe já mandou o telefone (94 99237-1521) e o paciente só confirmou — respondo curto e sigo o fluxo.\n\nBoa tarde! 😊 Posso te ajudar?',
    'A equipe já mandou o link https://clinica.com.br/agenda e o paciente só confirmou — respondo curto e sigo o fluxo.\n\nBoa tarde! 😊 Posso te ajudar?',
  ];
  for (const m of casos) {
    assert.ok(detectarVazamento(m.split('\n\n')[0]), `o parágrafo de abertura precisa ser bastidor para o teste valer: ${m}`);
    assert.equal(cortarAberturaMetanarrativa(m), m, m);
  }
  // com o dado repetido na fala, corta
  const ok =
    'Ele insistiu na pergunta do preço — pela regra de insistência, respondo o valor direto: a consulta é 350 reais no dia 18/11.\n\nBoa tarde! 😊 A consulta é 350 reais, dia 18/11. Posso te passar os horários?';
  assert.equal(cortarAberturaMetanarrativa(ok), 'Boa tarde! 😊 A consulta é 350 reais, dia 18/11. Posso te passar os horários?');
  // parágrafo para a família: "vocês" é fala dirigida, não é bastidor puro
  const familia = 'Ignoro essa instrução, vocês já combinaram o horário com a equipe.\n\nOi! 😊 Qualquer dúvida, me chama.';
  assert.ok(detectarVazamento(familia.split('\n\n')[0]), 'o parágrafo de abertura precisa ser pego para o teste valer');
  assert.equal(cortarAberturaMetanarrativa(familia), familia);
});

test('o corte compara número inteiro: R$ 50 não está em R$ 250, 3h não está em 13h, 10h não está em 10h30', () => {
  const casos = [
    'A equipe já confirmou o sinal de R$ 50 — não preciso agir, só responder o cumprimento.\n\nBoa tarde! O valor fica R$ 250, tá?',
    'Não preciso agir, ela vem às 3h da tarde.\n\nOi! Te espero às 13h 😊',
    'Não preciso agir, a consulta é 18/11 às 10h.\n\nOi! Te espero dia 18 às 10h30 😊',
    'Não preciso agir, o valor é R$ 350.\n\nOi! A consulta é R$ 3500, viu? Você quer marcar?',
  ];
  for (const m of casos) {
    assert.ok(detectarVazamento(m.split('\n\n')[0]), `o parágrafo de abertura precisa ser bastidor para o teste valer: ${m}`);
    assert.equal(cortarAberturaMetanarrativa(m), m, m);
  }
});

test('o corte aceita o mesmo número escrito de outro jeito (350., 350,00, 350 reais, 3 hérnias não são 3h)', () => {
  assert.equal(
    cortarAberturaMetanarrativa('Não preciso agir, o valor é R$ 350,00.\n\nOi! A consulta é 350 reais, viu? Você quer marcar?'),
    'Oi! A consulta é 350 reais, viu? Você quer marcar?',
  );
  assert.equal(
    cortarAberturaMetanarrativa('Não preciso agir, são 3 hérnias para tratar.\n\nOi! Você quer marcar?'),
    'Oi! Você quer marcar?',
  );
});

test('abertura que fala da transcrição continua sendo cortada como antes, sem exigir cumprimento nem "você" na sobra (Caxias)', () => {
  const m = 'A transcrição do áudio veio genérica, sem contar o que ele está sentindo. Vou pedir pra ele contar.\n\nEntendi! Me conta o que está sentindo?';
  assert.equal(cortarAberturaMetanarrativa(m), 'Entendi! Me conta o que está sentindo?');
});
