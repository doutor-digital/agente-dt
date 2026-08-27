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
