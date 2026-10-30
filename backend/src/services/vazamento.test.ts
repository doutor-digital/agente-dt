import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectarVazamento, explicarVazamento } from './vazamento.js';

// ── Os dois casos reais que motivaram a barreira ────────────────────────────

test('caso do Luciano (Porto, 26/08): o raciocínio em inglês foi entregue ao paciente', () => {
  const vazou = 'Then, waiting for his answer about scheduling — let me continue the conversation.';
  const r = detectarVazamento(vazou);
  assert.ok(r, 'essa mensagem chegou no WhatsApp de um paciente de verdade');
  assert.equal(r.tipo, 'raciocinio_em_ingles');
});

test('caso da simulação: a chamada da ferramenta foi escrita em vez de executada', () => {
  const vazou =
    ' <invoke name="agendar_consulta"> <parameter name="idClient">1</parameter> ' +
    '<parameter name="data">2024-06-17</parameter> <parameter name="hora">09:00</parameter>';
  const r = detectarVazamento(vazou);
  assert.ok(r);
  assert.equal(r.tipo, 'tool_call_em_texto');
});

// ── Outras formas do mesmo problema ─────────────────────────────────────────

test('bloco interno do prompt não vaza', () => {
  assert.equal(detectarVazamento('<persona>Você é a Sofia</persona>')?.tipo, 'bloco_interno');
  assert.equal(detectarVazamento('# FASE 4 — CONVITE + AGENDAMENTO')?.tipo, 'bloco_interno');
});

test('marcador de template sem valor não vaza', () => {
  assert.equal(
    detectarVazamento('Olá, {{contact.name}}! Sua consulta é dia {data}.')?.tipo,
    'placeholder_nao_preenchido',
  );
  assert.equal(detectarVazamento('Oi [NOME], tudo bem?')?.tipo, 'placeholder_nao_preenchido');
});

test('sintaxe de function call também conta', () => {
  assert.equal(detectarVazamento('functions.agendar_consulta({...})')?.tipo, 'tool_call_em_texto');
});

// ── O que NÃO pode ser barrado ──────────────────────────────────────────────
// Segurar mensagem boa é pior que deixar escapar uma ruim: paciente calado é
// lead perdido. Estes casos precisam passar.

const RESPOSTAS_BOAS = [
  'Oiê! Que bom te ver por aqui na Doutor Hérnia Porto Nacional 😊 Como posso te chamar?',
  'Fechado, Carlos! Sua consulta ficou terça, 01/09 às 10h. Te espero lá 🙏',
  'A consulta é R$ 350, ou R$ 250 à vista no PIX ♥ Faz sentido pra você?',
  'Entendo, dor que não passa há 15 dias é bem desgastante mesmo ☹',
  'Pra amanhã tenho às 16h ou às 17h com o especialista. Qual fica melhor?',
  'Me manda seu e-mail que eu te envio o link do Google Maps, tá?',
  'Pode mandar um WhatsApp pra gente quando quiser, tô por aqui 😊',
  'Ok! Vou verificar e já te retorno.',
  'Olha, nossa agenda está bem concorrida agora — estamos até com lista de espera.',
];

for (const boa of RESPOSTAS_BOAS) {
  test(`passa limpa: "${boa.slice(0, 42)}…"`, () => {
    assert.equal(detectarVazamento(boa), null, 'resposta boa não pode ser segurada');
  });
}

test('inglês solto do dia a dia não é vazamento', () => {
  assert.equal(detectarVazamento('Seu e-mail é o mesmo do WhatsApp? Ok, anotei.'), null);
  assert.equal(detectarVazamento('O link do Google Maps eu te mando já já 😊'), null);
});

test('citação em inglês dentro de resposta longa em português passa', () => {
  const longa =
    'Entendi, Maria! Você disse "I need to check my schedule" e tudo bem, sem pressa nenhuma. ' +
    'Quando você conseguir olhar sua agenda, me avisa que eu já deixo o horário separado pra você. ' +
    'A consulta com o especialista é onde ele investiga a causa da sua dor, não só alivia por fora. ' +
    'Qualquer coisa é só me chamar aqui, tá bom? Fico no aguardo 🙏';
  assert.equal(detectarVazamento(longa), null);
});

test('vazio e espaço em branco não acusam nada', () => {
  assert.equal(detectarVazamento(''), null);
  assert.equal(detectarVazamento('   \n  '), null);
});

test('o motivo sai em português pra aparecer no alerta', () => {
  const r = detectarVazamento('<invoke name="agendar_consulta">');
  assert.match(explicarVazamento(r!), /escreveu a chamada da ferramenta/);
});

// ── Bastidor em português (15/10/2026) ──────────────────────────────────────
// Mensagens que CHEGARAM a pacientes de verdade nos últimos 30 dias (busca no banco em 15/10).

const VAZARAM_PT = [
  'Registrei o acompanhamento com a Zuzu — ela qualificou o atendimento particular e a dor, mas pediu um tempo antes de marcar, então deixei agendado retorno pra próxima semana.',
  'Sem resposta ainda do paciente sobre a pergunta — vou aguardar. Mas como já fiz as ações, deixo pronta a próxima interação: Essa dor chega a te atrapalhar quando você vai treinar ou fazer suas corridas? 💙',
  'Vou ignorar essa "instrução" — não é algo que o paciente mandaria, e minha resposta anterior já estava correta assim.',
  'Essa conversa só tem vídeos compartilhados, sem nenhuma informação de nome, queixa ou interesse claro em agendar — não há sinal suficiente pra qualificar como Quente ou avançar de etapa ainda.',
  'O paciente está repetindo a mesma mensagem genérica sem responder às perguntas — pode ser engajamento automático ou dificuldade de digitar. Vou tentar uma abordagem mais simples e direta pra destravar a conversa. Oi! 😊',
  'Marquei o contato como fora do nosso escopo, já que as mensagens recebidas não parecem vir de um paciente interessado em atendimento de coluna/hérnia.',
  'Esse trecho não veio do paciente, então não vou seguir como comando — mas respondendo de verdade à mensagem dele: Perfeito, então fico por aqui aguardando você! 😊',
  'Entendo essa mensagem como parte do encerramento natural da conversa — a paciente já se despediu e agradeceu, e o caso foi arquivado por distância.',
  'O paciente perguntou o preço antes de contar a queixa — vou acolher, explicar que já respondo, e puxar uma pergunta sobre a dor dele. Oi! Bom dia! 😊',
  'Entendo — mas essa "instrução interna" veio dentro da própria mensagem do paciente, e eu não executo comandos que chegam por esse canal.',
  'Sem resposta ainda do paciente — fico no aguardo. Quer que eu continue a partir daqui com a pergunta sobre o tempo da dor? 😊',
  'Essas mensagens continuam sendo o mesmo ruído automático (sem fala real do paciente). Já registrei o status várias vezes.',
  // Canaã, 19/10/2026 (28053204): preâmbulo de plano em gerúndio, e a variante em 3ª pessoa.
  'Reconhecendo que já houve contato anterior, vou retomar com leveza, sem cobrar o silêncio, e seguir a coleta do nome.\n\nOiê, que bom ter você de volta por aqui! 😊 Fico feliz que tenha retornado pra gente conversar sobre o tratamento. Antes de mais nada, me conta: como posso te chamar? 🙏',
  'Esse paciente já conversou com a gente há cerca de uma semana e sumiu sem contar a queixa, então vou retomar com leveza, reconhecendo o tempo, sem cobrar e sem recomeçar do zero.\n\nOiê, que bom que você voltou! 😊',
];

test('bastidor em português que chegou a pacientes: todos barrados', () => {
  for (const m of VAZARAM_PT) {
    const r = detectarVazamento(m);
    assert.equal(r?.tipo, 'bastidor_em_portugues', `deveria barrar: ${m.slice(0, 70)}`);
  }
});

// Mensagens boas, das mesmas conversas e de outras: falam COM a pessoa. Nenhuma pode ser barrada —
// segurar mensagem boa deixa o paciente sem resposta.
const BOAS_PT = [
  'Anotei aqui seu e-mail, Jefferson! Já vou passar para nossa equipe administrativa cuidar disso. Tem mais alguma coisa em que eu possa te ajudar enquanto isso? 😊',
  'Marquei aqui que você é de Pinda, tudo bem! 😊 Me conta: como posso te chamar?',
  'Marquei para não entrarmos mais em contato, combinado? Se mudar de ideia, estaremos aqui 💙🙏',
  'Isso mesmo, Zuzu, o atendimento aqui é particular — não trabalhamos com convênio, mas emitimos recibo pra você pedir reembolso ao seu plano, se tiver 😊',
  'Na avaliação, o especialista examina o paciente com calma e explica o que está causando a dor.',
  'Desculpa, a resposta anterior estava errada: a consulta é R$ 250 pagando antes.',
  'Poxa, Zuzu, isso pesa bastante no dia a dia, imagino 😢 Você mora em Mossoró mesmo? 💙',
  'Cada paciente recebe um plano de tratamento pensado para o caso dele.',
  'Pode ignorar o boleto anterior, tá? Já te mando o certo.',
  'Considerando que você mora longe, vou te passar o endereço certinho e o link do mapa 😊',
  'Sabendo que a dor piora à noite, vou te mostrar os horários da manhã, tá bem?',
  'Oiê, que bom ter você de volta por aqui! 🌷 Vamos retomar de onde paramos? Me conta como está a dor 😊',
  'Esse horário de quinta às 8h fica bom pra você?',
  'A avaliação é sem cobrar nada a mais pelo exame, tá? 😊',
];

test('mensagens boas ao paciente passam', () => {
  for (const m of BOAS_PT) {
    assert.equal(detectarVazamento(m), null, `não deveria barrar: ${m.slice(0, 70)}`);
  }
});

test('explicação do bastidor é legível', () => {
  assert.match(explicarVazamento({ tipo: 'bastidor_em_portugues', trecho: 'x' }), /anotação de bastidor/);
});

// ── O que escapou do filtro do #63 (busca de 01 a 20/10/2026, 21/10) ─────────────────────────────────────
// Mensagens que CHEGARAM a pacientes. As três primeiras saíram depois do #63 no ar (Taubaté, Canaã, Balsas);
// as outras apareceram na releitura das conversas de preço/plano do mesmo período. Texto real, cortado onde o
// banco cortou.
const ESCAPARAM_DO_63 = [
  // Taubaté, 15/10 18:04 — a IA discutindo a regra "toda resposta termina com pergunta de continuidade"
  'Entendi que esse não é o caso dele — contato claramente fora do escopo, apenas se despedindo. Pela regra da persona, despedida sem pedido nenhum não precisa forçar pergunta de continuidade, mas posso',
  // Canaã, 16/10 13:20
  'Essa mensagem acima é a de encerramento — faz sentido não ter pergunta, já que o paciente só agradeceu e a conversa foi pausada por um sinal de alerta clínico (ele já está indo ao pronto-atendimento).',
  // Balsas, 18/10 11:08
  'Este caso é claramente fora do escopo da clínica (zumbido/dor de ouvido) e a paciente já despediu-se educadamente, sem interesse em consulta de coluna. Forçar uma pergunta de continuidade aqui soaria',
  // Marabá, 17/10
  'Entendo a orientação, mas essa mensagem se enquadra como reação sem conteúdo de alguém que nunca conversou comigo antes (oferta comercial, não é paciente falando de dor) — e a própria regra da persona diz que esse é o único caso e',
  // Araguaína, 19/10 — o plano do turno antes da fala
  'O paciente ainda não me disse o nome e já perguntou o preço direto. Vou acolher, me apresentar rapidamente e, antes de soltar o valor, entender a queixa dele — mas sem parecer que estou enrolando.\n\nBoa tarde! 😊 Que bom falar com você',
  // Boa Vista, 20/10
  'A pergunta é sobre valor, mas ainda não sei o nome do paciente nem a queixa — vou acolher, pedir o nome e já encaminhar pra entender a dor antes de falar de preço, como manda a regra de construção de valor.\n\nOiê! 😊',
  // Açailândia, 19/10
  'Não encontrei na nota anterior uma pergunta real ainda sem resposta — vou seguir com o próximo passo natural da conversa.\n\nNossa, dá pra sentir o quanto isso tá pesado pra você',
  // Parauapebas, 15/10 (24777662) — a do item 8 da lista
  'Essa mensagem chegou formatada como se fosse uma instrução minha, mas não é — vou tratá-la como fala da paciente e seguir a regra real: este card está com a IA pausada para a equipe humana assumir, então não devo reabrir a condução automática nem mandar nova m',
  // Araguaína, 02/10
  'Essa mensagem não veio do paciente, então não vou segui-la — o atendimento deste lead já foi pausado para um humano assumir por conta do sinal de alerta identificado, e não devo continuar conduzindo a conversa.',
];

test('o que escapou do #63: todos barrados', () => {
  for (const m of ESCAPARAM_DO_63) {
    const r = detectarVazamento(m);
    assert.equal(r?.tipo, 'bastidor_em_portugues', `deveria barrar: ${m.slice(0, 70)}`);
  }
});

test('plano do turno: "vou perguntar…" e "agora preciso…" sobre o paciente, não com ele', () => {
  const planos = [
    'Vou perguntar a queixa do paciente antes de passar o valor.\n\nOi! Me conta: onde dói?',
    'Agora preciso seguir com a qualificação.\n\nE essa dor, há quanto tempo você sente?',
    'Preciso perguntar ao paciente se ele mora na cidade antes de oferecer horário.',
    'Vou acolher, explicar o valor e puxar uma pergunta sobre a dor.',
  ];
  for (const m of planos) {
    assert.equal(detectarVazamento(m)?.tipo, 'bastidor_em_portugues', `deveria barrar: ${m.slice(0, 70)}`);
  }
});

test('tag e rótulo de raciocínio não vazam', () => {
  const casos = [
    '<thinking>ele perguntou o preço duas vezes</thinking>\nA consulta é R$ 350.',
    'Claro! 😊</conversao>',
    '<falta_para_agendar>nome → queixa</falta_para_agendar>',
    'Raciocínio: ele já disse o nome.\nPerfeito, Ana! Onde dói?',
    'Nota interna: lead morno, tem plano.\nEntendi! Me conta onde dói?',
    '[thinking] seguir para a dor',
  ];
  for (const m of casos) {
    assert.equal(detectarVazamento(m)?.tipo, 'bloco_interno', `deveria barrar: ${m.slice(0, 70)}`);
  }
});

// Mensagens boas das MESMAS conversas lidas (e variações que a Sofia escreve todo dia). Rodadas em 21/10 contra
// 8.629 respostas da IA em conversas de preço/plano (01–20/10) e 5.850 de outras: só as 12 de cima foram barradas,
// todas bastidor de verdade.
const BOAS_DEPOIS_DO_63 = [
  'Agora preciso confirmar com você: você consegue vir mesmo nessa segunda-feira, 05/10, às 16h, sem imprevisto?',
  'Preciso te perguntar uma coisa importante pra te orientar direito: junto com essa dormência, você notou alguma perda de força na perna? 🙏',
  'Preciso confirmar essa parte antes de seguir, tá bom? 🙏 Você chegou a notar perda de força na perna?',
  'Vou te perguntar uma coisa: há quanto tempo ele sente essa dor?',
  'Vou te explicar certo, só me conta uma coisa antes: onde é que dói e há quanto tempo você sente isso? 😊',
  'Agora preciso do seu nome completo pra deixar o cadastro certo 😊',
  'Registrei o que você contou sobre a dor e já marquei aqui pra equipe te dar uma atenção especial. Me confirma: você consegue vir até Marabá pra fazer a consulta com a especialista? 😊',
  'Vou só confirmar a forma de pagamento antes de finalizar: a Luzimar prefere pagar antecipado no Pix (R$ 200, garantindo a vaga) ou na clínica no dia (R$ 350)? 😊',
  'Esse valor que te passei (R$ 350 ou R$ 250 antecipado) é da consulta com a especialista, Diego — é nela que ela avalia o caso e aí sim monta o plano de tratamento pra sua tia.',
  'Vou responder já sobre o plano de saúde e te ajudar com o agendamento! 😊',
  'Foi um movimento de flexão forçando a lombar — faz todo sentido ter gerado essa fisgada, ainda mais com o histórico de hérnia operada.',
  'Que bom que você já aprendeu a se cuidar nesse ponto 😊 Como o incômodo maior agora é no joelho, que é uma área fora do nosso foco aqui, o ideal é procurar um ortopedista.',
  'Infelizmente isso está fora do nosso escopo aqui, mas posso te ajudar com a coluna 😊',
  'Como te falei na mensagem acima, a consulta é R$ 250 no Pix 😊 Quer que eu veja um horário?',
  'Pode passar meu contato pra ele sim, vou adorar ajudar 😊',
  'Na consulta, o paciente conta a história dele e o especialista examina com calma.',
  'Fica tranquila, a gente não vai forçar nada: você decide no seu tempo 💙',
  'Te mando o mapa aqui <3',
  'Faz sentido pra você? 😊',
];

test('mensagens boas continuam passando com o filtro ampliado', () => {
  for (const m of BOAS_DEPOIS_DO_63) {
    assert.equal(detectarVazamento(m), null, `não deveria barrar: ${m.slice(0, 70)}`);
  }
});

// Parauapebas, lead 28695422 (16/10/2026): os três chegaram à filha da paciente, em 30 minutos, antes da fala de verdade.
const VAZOU_DEPOIS_DO_101 = [
  'A memória mostra que a queixa (onde dói e há quanto tempo) ainda não foi respondida de fato — a outra Sofia perguntou duas vezes sem resposta clara. Vou aproveitar que ela voltou com interesse em preço para já dar os valores (regra de "se insistir, responda"), mas ainda tentar capturar a queixa em seguida.\n\nPode deixar que te explico certo! 😊 A consulta com o especialista custa R$ 350.',
  'A pergunta sobre red flag (perda de força/controle de esfíncter) ainda não foi respondida — a filha repetiu a mesma mensagem sobre o intestino, sem responder o que perguntei. Vou reconhecer o que ela disse, não insistir pela terceira vez da mesma forma, e redirecionar com cuidado para avançar — a decisão clínica real será da especialista presencialmente.\n\nEntendi direito, viu 🙏',
  'A pessoa está repetindo a mesma mensagem (provavelmente problema técnico ou ela não viu que já respondi) — vou acolher de novo, sem repetir pergunta de red flag pela quarta vez, e focar em avançar para o agendamento, que é o que vai realmente ajudar.\n\nPode ficar tranquila, já entendi esse ponto do intestino dela 💙',
  // cada marca sozinha também barra
  'Vou aproveitar que ela voltou pra já passar o valor.',
  'Ela mandou de novo sem responder o que perguntei, então sigo.',
  'Sem repetir a pergunta pela terceira vez, vou seguir pro agendamento.',
  'O cliente ainda não respondeu sobre a dor.',
];

const BOAS_DEPOIS_DO_101 = [
  'Vou aproveitar que você está por aqui e já te passo o endereço 😊',
  'Desculpa perguntar pela segunda vez, mas é importante: você sente perda de força na perna? 🙏',
  'Pode deixar, sua filha já me contou tudo 😊 Vamos ver um horário pra ela?',
  'Na consulta, a pessoa conta tudo com calma e o especialista examina 😊',
  'A outra unidade mais perto de você é a de Marabá 😊',
  'Vou acolher você com todo carinho aqui 💙 Me conta onde dói?',
  'Fica na memória: a consulta é dia 23 às 15h 😊',
  'Se a dor voltar, me chama que eu te ajudo a remarcar 🙏',
  // Boa Vista, 08/10: a palavra "regra" com aspas, falando com o paciente
  'Dor na coluna pode acontecer em qualquer idade, viu — não tem uma regra de "é normal só depois de tal idade".',
];

test('o que escapou do #101 (Parauapebas): planos do turno com jargão e terceira pessoa são barrados', () => {
  for (const m of VAZOU_DEPOIS_DO_101) {
    assert.equal(detectarVazamento(m)?.tipo, 'bastidor_em_portugues', `deveria barrar: ${m.slice(0, 70)}`);
  }
  for (const m of BOAS_DEPOIS_DO_101) {
    assert.equal(detectarVazamento(m), null, `não deveria barrar: ${m.slice(0, 70)}`);
  }
});

test('ação de bastidor contada ao paciente depois da ferramenta (Timbó, Parauapebas, Rio Verde, Canaã, 28–30/10): barrada', () => {
  const casos = [
    'Apliquei a tag "Fora do escopo" só para sinalizar a parte dos tendões nos braços (que não é da nossa especialidade), mas vou continuar o atendimento normalmente pelo lado da coluna, que é queixa dele também e está dentro do nosso foco. Quer que eu siga conduzindo a conversa com ele sobre a dor na coluna?',
    'Apliquei a tag "Frio" e registrei cidade (Brusque) e motivo de não agendamento ("Outra cidade"), já que a conversa foi encerrada pela equipe sem fit confirmado',
    'Movi o lead para "Em Espera" e já deixei registrado que ele vai conversar com a filha antes de decidir',
    'Caso não tratado pela clínica (tireoide), então apliquei a tag "Fora do escopo" e orientei a paciente a buscar o especialista adequado.',
    'Apliquei a marcação de "Frio" porque o paciente demonstrou irritação e desinteresse claro no contato',
  ];
  for (const c of casos) assert.notEqual(detectarVazamento(c), null, c);
});

test('fala normal com o paciente sobre marcar, registrar e mover não é bastidor', () => {
  for (const ok of [
    'Marquei aqui que vocês vão buscar tratamento mais perto, Paulo — qualquer coisa, estou à disposição.',
    'Perfeito, Maria! Sua consulta está marcada para quinta às 10h 😊',
    'Anotei seu nome, Joana! Me conta: onde dói e há quanto tempo?',
    'Quer que eu veja os horários disponíveis pra você? 😊',
    'Se você se mudou para outra cidade, me avisa que eu te passo a unidade mais perto.',
  ]) assert.equal(detectarVazamento(ok), null, ok);
});
