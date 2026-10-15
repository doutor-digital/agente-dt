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
];

test('mensagens boas ao paciente passam', () => {
  for (const m of BOAS_PT) {
    assert.equal(detectarVazamento(m), null, `não deveria barrar: ${m.slice(0, 70)}`);
  }
});

test('explicação do bastidor é legível', () => {
  assert.match(explicarVazamento({ tipo: 'bastidor_em_portugues', trecho: 'x' }), /anotação de bastidor/);
});
