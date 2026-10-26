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

test('visita passada ao pronto-socorro não abre a exceção; pergunta de agora abre (achado do Codex)', () => {
  const sugestao = 'Procure o pronto-socorro.';
  for (const fala of ['fui ao pronto-socorro semana passada', 'estive na UPA ontem', 'já fui no pronto socorro e não resolveu']) {
    assert.equal(semProntoSocorro(sugestao, [fala]).texto, '', fala);
  }
  for (const fala of ['já fui no pronto socorro e mandaram pra casa, devo voltar?', 'devo ir ao pronto-socorro?', 'vou na UPA agora', 'é caso de pronto socorro?']) {
    assert.equal(semProntoSocorro(sugestao, [fala]).texto, sugestao, fala);
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
  // frase de reserva neutra: nada de "na consulta" nem "não consigo orientar" para quem pode ter um sinal de alerta
  assert.doesNotMatch(g.text, /consulta|n[aã]o consigo orientar|especialista/i);
  // turno de aviso urgente: no lugar da reserva sai a frase do passe
  const urgente = aplicarGuardrail('Procure o pronto-socorro mais próximo.', clinica, { fraseDeReserva: 'Já avisei a nossa equipe.' });
  assert.equal(urgente.text, 'Já avisei a nossa equipe.');

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

// ── Revisão do sênior (26/10) ───────────────────────────────────────────────────────────────────────────

test('"Av." não é fim de frase: o endereço com UPA como referência passa inteiro (achado do sênior)', () => {
  const t = 'Fica na Av. Brasil, 123, em frente à UPA Central. Quer agendar?';
  assert.equal(semProntoSocorro(t).texto, t);
  // sem a referência, o corte nunca deixa "Fica na Av." solto
  const r = semProntoSocorro('Fica na Av. Brasil, 123. Se piorar, procure a UPA. Quer agendar?');
  assert.equal(r.texto, 'Fica na Av. Brasil, 123. Quer agendar?');
});

test('referência de endereço a PS/UPA e relato do passado não são conselho', () => {
  for (const t of [
    'O endereço é Rua X, 100, ao lado da UPA do Centro.',
    'Fica em frente ao Pronto Socorro Municipal, prédio azul.',
    'Perto do pronto-socorro, na esquina.',
    'Nossa, Arlete, que aflição pra vocês duas — já ter precisado ir à UPA duas vezes por causa da dor mostra que não é pouca coisa 💙.',
  ]) {
    assert.equal(semProntoSocorro(t).texto, t, t);
  }
});

test('"não cirúrgico" e "pós-cirúrgico" não são opinião sobre cirurgia (achado do sênior)', () => {
  for (const t of [
    'O nosso tratamento é não cirúrgico, feito com tecnologia de descompressão.',
    'Nosso foco é o tratamento conservador, não cirúrgico.',
    'É que casos de pós-cirúrgico bem recente a gente não consegue avaliar ainda.',
    'Atendemos pacientes que fizeram cirurgia e ainda sentem dor.',
  ]) {
    assert.equal(semProntoSocorro(t).texto, t, t);
  }
});

test('o corte é por TRECHO: o que vem antes do conselho fica, com ponto final (Canaã, Olímpia, Mossoró)', () => {
  assert.equal(
    semProntoSocorro('Como estamos fora do horário agora, elas continuam seu atendimento por aqui amanhã, segunda-feira, às 8h — se a dor estiver insuportável antes disso, pode procurar um pronto-socorro, viu? 💙').texto,
    'Como estamos fora do horário agora, elas continuam seu atendimento por aqui amanhã, segunda-feira, às 8h. 💙',
  );
  assert.equal(
    semProntoSocorro('Vou chamar agora mesmo alguém da nossa equipe pra falar com você com prioridade — e se piorar ou sentir algo muito forte, procure um pronto-atendimento, combinado?').texto,
    'Vou chamar agora mesmo alguém da nossa equipe pra falar com você com prioridade.',
  );
  // parênteses com PS saem, o resto da frase não vira pedaço solto: sobrou pouco, cai a frase
  assert.equal(
    semProntoSocorro('Entendo 😢 Mas não espere: busquem atendimento de urgência (pronto-socorro/hospital) agora mesmo, viu?').texto,
    'Entendo 😢',
  );
  // sem separador forte, a frase inteira sai (nada de "Por precaução," solto)
  assert.equal(semProntoSocorro('Entendi 🙏 Por precaução, procure o pronto-socorro mais próximo. Tenho horário hoje às 13h.').texto, 'Entendi 🙏 Tenho horário hoje às 13h.');
  // o que sobra depois do " — " em caixa baixa ganha maiúscula
  assert.equal(
    semProntoSocorro('Pra hérnia umbilical o ideal é procurar um cirurgião geral, que avalia o caso — aqui na Doutor Hérnia a gente cuida só da coluna vertebral.').texto,
    'Aqui na Doutor Hérnia a gente cuida só da coluna vertebral.',
  );
});

test('exceção do paciente só para intenção/pergunta de ir AGORA (achado do sênior)', () => {
  const sugestao = 'Procure o pronto-socorro.';
  for (const fala of ['Fui ao pronto-socorro ontem e disseram que preciso de ressonância', 'posso fazer ressonância? já fui na UPA semana passada']) {
    assert.equal(semProntoSocorro(sugestao, [fala]).texto, '', fala);
  }
  for (const fala of ['devo ir ao pronto-socorro?', 'vou na UPA agora', 'é caso de pronto socorro?', 'já fui na UPA ontem, devo voltar?']) {
    assert.equal(semProntoSocorro(sugestao, [fala]).texto, sugestao, fala);
  }
});

test('6. "preciso de pronto socorro?" e "…hoje piorou, volto lá?" abrem a exceção (decisão 2 do João)', () => {
  const sugestao = 'Se você sente que não dá para esperar, pode ir.';
  for (const fala of [
    'preciso de pronto socorro?',
    'será que preciso de uma UPA?',
    'Fui ao pronto socorro ontem, hoje piorou, volto lá?',
    'Fui ao pronto-socorro ontem. Hoje piorou, volto lá?',
  ]) {
    assert.equal(semProntoSocorro(sugestao, [fala]).texto, sugestao, fala);
  }
  // e continua sem abrir para visita passada com "preciso de" outra coisa
  assert.equal(semProntoSocorro('Procure o pronto-socorro.', ['Fui ao PS ontem e disseram que preciso de ressonância']).texto, '');
});
