/**
 * A Sofia não sugere pronto-socorro e não opina sobre médico nem cirurgia (decisão do João, 26/10/2026).
 * Marabá #28653386 #28843076, ITZ #28642041, Canaã #28971656, Taubaté #5795803.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { aplicarGuardrail } from './guardrail.js';
import { semProntoSocorro } from './sem-pronto-socorro.js';

const clinica = { category: 'saude', sourceProdutos: 'Consulta: R$ 350 no dia ou R$ 250 antecipado no Pix.' } as unknown as Unit;

test('a frase que manda ao pronto-socorro sai e o resto da mensagem fica', () => {
  const r = semProntoSocorro(
    'Sinto muito que esteja passando por isso 🙏 Por precaução, procure o pronto-socorro mais próximo. A equipe já foi avisada.',
  );
  assert.equal(r.texto, 'Sinto muito que esteja passando por isso 🙏 A equipe já foi avisada.');
  assert.equal(r.removidas.length, 1);
  assert.match(r.removidas[0], /pronto-socorro/);
});

test('as 5 frases reais de 22 a 25/10 (depois da regra de 21/10) não chegam ao paciente', () => {
  const reais: Array<[string, string]> = [
    ['Marabá #28653386', 'Se piorar muito antes disso e você sentir que não dá pra esperar, pode procurar um pronto-socorro, viu?'],
    ['Marabá #28843076', 'Mas não espere: busquem atendimento de urgência (pronto-socorro/hospital) agora mesmo, viu?'],
    ['ITZ #28642041', 'Quero me certificar de que você vai ter o cuidado certo - tem alguém que possa te ajudar a chegar num pronto-socorro ou neurologista agora?'],
    ['Canaã #28971656', 'Como estamos fora do horário agora, elas continuam seu atendimento por aqui amanhã, segunda-feira, às 8h - se a dor estiver insuportável antes disso, pode procurar um pronto-socorro, viu?'],
    ['Taubaté #5795803', 'Como seu caso já está sendo visto como cirúrgico com o médico, faz sentido você seguir esse caminho com ele.'],
  ];
  for (const [quem, frase] of reais) {
    const r = semProntoSocorro(`Entendi 🙏 ${frase} A equipe já foi avisada.`, ['bom dia, estou com dor']);
    assert.ok(r.removidas.length >= 1, `${quem}: nada saiu`);
    assert.doesNotMatch(r.texto, /pronto|cir[uú]rgic|hospital|neurologista/i, quem);
    assert.match(r.texto, /A equipe já foi avisada\./, `${quem}: o resto da mensagem fica`);
  }
});

test('pega as formas: UPA, pronto atendimento, emergência, SAMU, ambulância, "vá ao hospital"', () => {
  for (const t of [
    'Procure a UPA agora.',
    'Vá a um pronto atendimento.',
    'Isso pode ser uma emergência.',
    'Em caso de urgência, ligue para o SAMU.',
    'Chame uma ambulância.',
    'Vá ao hospital mais perto.',
    'Corra para o Hospital Regional agora.',
    'Procure um serviço de urgência.',
  ]) {
    const r = semProntoSocorro(`Entendi. ${t}`);
    assert.equal(r.texto, 'Entendi.', t);
  }
});

test('endereço com nome de hospital e a palavra "urgente" no sentido comercial passam', () => {
  for (const t of [
    'Ficamos na Av. Brasil, 100, em frente ao Hospital Regional.',
    'Estacionamento ao lado do hospital.',
    'O endereço correto é Rua X, 100, ao lado do Hospital Municipal.',
    'O doutor vai atender você no consultório perto do Hospital São José.',
    'Quero resolver isso com urgência, e você?',
    'O atendimento é rápido.',
  ]) {
    assert.equal(semProntoSocorro(t).texto, t, t);
  }
});

test('opinião sobre cirurgia e sobre médico sai: "caminho cirúrgico", "vai precisar de cirurgia", "procure um neurologista"', () => {
  for (const t of [
    'Esse caso costuma seguir o caminho cirúrgico.',
    'Você vai precisar de cirurgia.',
    'Talvez precise operar.',
    'Parece que há indicação cirúrgica.',
    'Isso precisa de cirurgia.',
    'Procure um neurologista antes.',
    'Recomendo um ortopedista de confiança.',
    'É caso de cirurgia.',
  ]) {
    assert.equal(semProntoSocorro(`Entendi. ${t} Vamos marcar?`).texto, 'Entendi. Vamos marcar?', t);
  }
});

test('falar de cirurgia sem opinar passa (a consulta é onde se descobre)', () => {
  for (const t of [
    'Na consulta o especialista avalia se precisa de cirurgia ou não.',
    'Isso quem responde é o especialista, na consulta.',
    'Sua cirurgia antiga pode ter relação, sim — é isso que o especialista examina.',
    'A consulta é com o nosso especialista.',
  ]) {
    assert.equal(semProntoSocorro(t).texto, t, t);
  }
});

test('se o PRÓPRIO paciente falou em pronto-socorro, a resposta pode tratar disso', () => {
  const resposta = 'Se você sente que não dá para esperar, pode ir ao pronto-socorro. A nossa equipe já foi avisada.';
  for (const fala of ['devo ir ao pronto socorro?', 'vou na UPA agora', 'acho que vou pro hospital', 'chamo a ambulância?']) {
    assert.equal(semProntoSocorro(resposta, ['oi', fala]).texto, resposta, fala);
  }
  // Sem o paciente ter falado, a mesma frase sai.
  assert.equal(semProntoSocorro(resposta, ['minha perna está perdendo força']).texto, 'A nossa equipe já foi avisada.');
  // E opinião sobre cirurgia sai mesmo quando o paciente falou de pronto-socorro.
  assert.equal(
    semProntoSocorro('Pode ir, sim. Você vai precisar de cirurgia.', ['devo ir ao pronto-socorro?']).texto,
    'Pode ir, sim.',
  );
});

test('"hospital" que o paciente citou de passagem não libera a sugestão de pronto-socorro', () => {
  for (const fala of ['trabalho num hospital', 'já fui no hospital semana passada', 'minha mãe está no hospital']) {
    assert.equal(semProntoSocorro('Procure o pronto-socorro.', [fala]).texto, '', fala);
  }
});

test('dizer que a dúvida sobre cirurgia é do especialista não é opinar', () => {
  for (const t of [
    'A consulta serve para avaliar se você vai precisar de cirurgia.',
    'O especialista vai ver se precisa de cirurgia ou não.',
    'Na consulta se descobre se há indicação cirúrgica.',
  ]) {
    assert.equal(semProntoSocorro(t).texto, t, t);
  }
});

test('no guardrail: só clínica, e a mensagem que sobraria vazia vira texto neutro', () => {
  const g = aplicarGuardrail('Procure o pronto-socorro mais próximo. Vá agora à UPA.', clinica);
  assert.equal(g.rewritten, true);
  assert.ok(g.triggered.some((t) => t.startsWith('pronto_socorro_ou_cirurgia')));
  assert.doesNotMatch(g.text, /pronto|UPA/i);
  assert.match(g.text, /nosso especialista/);

  const parcial = aplicarGuardrail('Entendi 🙏 Procure o pronto-socorro. A equipe já foi avisada.', clinica);
  assert.equal(parcial.text, 'Entendi 🙏 A equipe já foi avisada.');

  // O paciente perguntou: a resposta fica.
  const pediu = aplicarGuardrail('Se sentir que não dá para esperar, pode ir ao pronto-socorro.', clinica, {
    mensagensDoPaciente: ['devo ir ao pronto-socorro?'],
  });
  assert.equal(pediu.rewritten, false);

  // Fora de clínica a trava não age.
  const adv = aplicarGuardrail('Procure o pronto-socorro.', { category: 'juridico' } as unknown as Unit);
  assert.equal(adv.text, 'Procure o pronto-socorro.');
});
