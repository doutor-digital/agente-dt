/**
 * "Prometeu e não marcou": o detector de frases, a decisão de avisar e o dedupe.
 *
 * As frases são de produção (mensagens da IA de set–out/2026), com o nome do paciente trocado quando
 * aparecia. As positivas são a IA AFIRMANDO consulta; as negativas são o "reservado" do dia a dia —
 * oferta, pergunta, condição, preço, negação — que não pode virar alarme.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cartaoTemConsulta } from './agendamento-perdido-worker.js';
import {
  Lembranca,
  PALAVRAS_DO_FILTRO,
  UM_POR_LEAD_MS,
  algumaDesde,
  consultaDoRastro,
  consultasVivasDoRastro,
  decidir,
  detectarPromessa,
  mensagemDaIA,
  proximoPasso,
  quandoCitado,
  textoDoAlerta,
  trechos,
  type Evidencias,
} from './prometeu-sem-marcar.js';

// ── os casos que motivaram ─────────────────────────────────────────────────────────────────────────

test('caso resgate 10824318 (05/10): "Quinta, 08/10, às 8h30 fica reservado pro seu nome"', () => {
  const p = detectarPromessa(
    'Combinado, Teste! Quinta, 08/10, às 8h30 fica reservado pro seu nome 😊 A consulta é R$ 350 pago na clínica no dia, ' +
      'ou R$ 250 se você antecipar por Pix — o Pix já garante sua vaga. Como prefere?',
  );
  assert.ok(p);
  assert.equal(p.trecho, 'Quinta, 08/10, às 8h30 fica reservado pro seu nome 😊');
  assert.equal(p.quando, 'quinta 08/10 8h30');
});

test('caso Giovanni 27957957 (05/10): a afirmação emendada numa pergunta pelo travessão ainda conta', () => {
  const p = detectarPromessa('Combinado então! 😊 Deixo reservado pra sexta, 09/10 — só me confirma: prefere vir de manhã ou à tarde nesse dia?');
  assert.ok(p);
  assert.equal(p.trecho, 'Deixo reservado pra sexta, 09/10');
  assert.equal(p.quando, 'sexta 09/10');
});

test('caso Sergio 27774111 (03/10): "Sua consulta está reservada pra quarta-feira, 07/10, às 10h"', () => {
  const p = detectarPromessa(
    'Pronto, Sergio! 🎉 Sua consulta está reservada pra quarta-feira, 07/10, às 10h, aqui na Rua São Raimundo, 375, Centro. ' +
      'Se quiser garantir com o valor de R$ 250 no Pix antes, é só me avisar que te passo os dados. Combinado assim?',
  );
  assert.ok(p);
  assert.equal(p.quando, 'quarta 07/10 10h');
  assert.ok(detectarPromessa('Combinado, vou deixar reservado pra você: quarta, 07/10, às 10h 🎉 Pra eu confirmar certo, me diz seu nome completo, por favor?'));
});

test('caso Taubaté 4851114: só PERGUNTAS de confirmação — não é afirmação (o que faltou lá foi marcar)', () => {
  assert.equal(detectarPromessa('Pra eu deixar certo reservado, Paulo: você consegue vir amanhã, terça-feira, dia 06/10, às 7h da manhã? 😊'), null);
  assert.equal(
    detectarPromessa('Desculpa a demora aí, Paulo! 😊 Então, me confirma uma coisa: você vai vir amanhã, terça-feira, dia 06/10, às 7h da manhã — pode deixar reservado assim pra você?'),
    null,
  );
});

// ── afirmações (devem pegar) ───────────────────────────────────────────────────────────────────────

const AFIRMA: string[] = [
  'Perfeito, então fica marcado quinta-feira, 24/09, às 9h!',
  'Sua consulta está confirmada para quinta-feira, 10/09, às 15h.',
  'Mateus, você já tem sua consulta certinha marcada pra amanhã, quarta-feira 16/09 às 08:00! 😊 Você quer remarcar?',
  'Combinado então, Lindomar! 😊 Te espero amanhã às 9h aqui na clínica. Qualquer coisa antes disso, é só me chamar.',
  'Nos vemos quinta, 24/09 às 15h.',
  '✅ Agendamento confirmado, Rosângela! ⭐ Data: terça-feira, 06/10/2026 ⏰ Horário: 08:00 ⭐ Local: Rua X, 10',
  'Prontinho, remarcado com sucesso! 🎉 ⭐ Data: terça-feira, 22/09 ⏰ Horário: 17:00',
  'Vou deixar reservado o horário das 10h de amanhã, terça (06/10), no seu nome enquanto você confirma.',
  'Seu horário de terça-feira, 06/10, às 10h30, fica reservado esperando sua confirmação.',
  'Letícia, seu horário de segunda às 14h continua reservado 💙 Se preferir mudar, também tenho vaga terça às 10h ou às 15h.',
  'Fico com esse horário reservado no seu nome, tá? Assim que o pagamento cair, é só me avisar.',
  '😊 Sua consulta é amanhã, terça-feira 06/10, às 08:30.',
  'Sua vaga de amanhã às 14h está reservada.',
  'Perfeito, deixei reservado terça-feira, 29/09, às 08:00 no seu nome, Mércia!',
  'Seu horário de terça, 29/09 às 15h está garantido.',
  'Então ele remarcou a dele pro dia 7 😊 Perfeito, 14h30 de sexta fica reservado pra você!',
  'Deixo reservado o horário de sexta, 02/10 às 16h mesmo, e quando puder confirmar é só me avisar, tá bem?',
  // "ou" que não é escolha de horário não vira oferta
  'Sua consulta está marcada para sexta, 09/10, às 9h, chegando uns 10 ou 15 minutinhos antes.',
  // a negação, a condição e a oferta de OUTRA oração não calam a afirmação (revisão de 07/10)
  'Não se preocupe, sua consulta está marcada para sexta às 9h.',
  'Fique tranquila, não vai perder: sua consulta está garantida sexta às 9h.',
  'Sua consulta está marcada para sexta às 9h, qualquer dúvida me chama.',
  'Tenho uma ótima notícia: sua consulta está marcada para sexta às 9h.',
  // sem particípio nenhum ("sua consulta é/fica pra") e o "lhe esperamos"
  'Combinado! Sua avaliação ficou pra segunda, 12/10, às 14h.',
  'Perfeito, Dona Maria, lhe esperamos amanhã às 8h.',
];

for (const frase of AFIRMA) {
  test(`afirma: ${frase.slice(0, 70)}`, () => {
    assert.ok(detectarPromessa(frase), `deveria pegar: ${frase}`);
  });
}

// ── conversa normal (não pode pegar) ───────────────────────────────────────────────────────────────

const NAO_AFIRMA: string[] = [
  // preço: o Pix "garante o horário reservado"
  'A consulta com o especialista custa R$ 250 se pagar antecipado no Pix (isso já garante o horário reservado), ou R$ 350 se preferir pagar no dia, na clínica.',
  'Mas se preferir, pagando antes por Pix o valor é R$ 250 — e já garante sua vaga reservada 😊 Pra manhã de quarta, 07/10, me diga: você consegue vir às 8h ou prefere às 10h?',
  // pergunta / oferta
  'Quer que eu já deixe reservado nesse horário? 🙏💜',
  'Consegui aqui, Paulo! Pra segunda-feira, 05/10, tenho às 7h ou às 16h disponíveis com o especialista 😊 Qual fica melhor pra você?',
  'Perfeito! 😊 Tenho horário quarta, 07/10, às 9h ou quinta, 08/10, às 8h30, ambos pela manhã. Qual fica melhor pra você?',
  'Willames, deixei os dois horários de quarta reservados aqui: 09:00 ou 11:00 🙏 Me diz qual prefere que eu já confirmo pra você 😊',
  'Márcio, deixo reservados dois horários pra quarta à tarde: 14h ou 17h.',
  'Posso deixar reservado? Só preciso do seu nome completo 😊',
  // condição
  'Quando quiser marcar, é só me chamar que eu já deixo seu horário reservado.',
  'Assim que você definir o dia certo, me avisa que eu já deixo reservado pra você, tá bem?',
  'Se quiser, já deixo um horário reservado com o Ezequiel pra essa semana.',
  'o horário das 11:30 de segunda, 05/10, fica reservado exclusivamente pra você assim que eu confirmar.',
  'Agora me confirma seu nome completo e um telefone com DDD que eu já deixo essa segunda às 08h reservada pra você.',
  'Dona Cecília, aqui na nossa unidade o horário fica garantido mesmo só com o antecipado de R$ 100 confirmado 🙏',
  // negação / passado / dúvida
  '😊 Verifiquei aqui e não encontrei nenhuma consulta marcada no seu nome com a gente.',
  'Como você já tinha uma consulta marcada aqui com a gente pra dia 10/09 às 14h, é bom eu entender: você ainda quer manter?',
  'Ih, antes de confirmar eu preciso achar seu horário marcado aqui — pra eu te ajudar certo, me diz seu nome completo? 🙏',
  'Sua vaga está reservada, porém ainda não confirmada.',
  // sinal grave, narração interna, explicação
  'o ideal é você procurar um pronto-atendimento agora, sem esperar consulta marcada, tá bom?',
  'Movi o Alain para "Em Espera" com retorno agendado para 01/10, já que ele quer a consulta mas só pode pagar depois.',
  'Aqui é diferente: as consultas são marcadas de 30 em 30 minutos e cada horário é reservado só pra você, então às 09:00 é você quem entra.',
  // o tique do follow-up: "um horário" qualquer, sem dia
  'Fico com um horário reservadinho aqui pra sua avaliação',
  'Vou deixar um horário reservado por aqui pra você, sem compromisso.',
  // espera a resposta, não o paciente
  'Fica combinado então, te espero dia 23 pra sua resposta!',
  // sessão de tratamento: quem marca é a clínica
  'Sua próxima sessão está marcada para terça-feira, 15/09, às 08:00.',
  // hérnia "confirmada" não é consulta
  'Já que sua hérnia está confirmada por exame, vale a pena aproveitar pra marcar sua consulta com o especialista.',
  // outro sujeito antes do verbo, mesmo com data no trecho ou no vizinho (revisão de 07/10)
  'Pelo seu laudo, a hérnia foi confirmada na ressonância de 12/09.',
  'O valor de R$ 250 fica garantido até sexta.',
  'A agenda de sexta já está toda marcada 😕',
  'Seu Pix foi confirmado! Sexta às 9h então.',
  // "com horário marcado" é como a clínica atende (FAQ), não uma consulta
  'Atendemos somente com horário marcado, de segunda a sexta, das 7h às 19h.',
  'O atendimento é com horário agendado, de segunda a sexta das 7h às 19h.',
  // duração não é horário
  'Sua consulta é feita em 1h, com calma.',
  // explicação de preço, "confirmei a agenda", e a condição depois da vírgula que não é cortesia
  'Só uma coisa: pra eu conseguir segurar um horário pra você, não precisa pagar antes não — a vaga fica reservada e você paga só no dia da consulta (R$ 220) ou, se preferir, pagando antes por Pix o valor fica R$ 200.',
  'Olha, André, confirmei aqui e na segunda-feira, 28/09, o único horário livre mesmo é às 11h 🙏',
  'Fico com o horário reservadinho, é só me chamar quando quiser aproveitar a consulta particular.',
  // a cortesia sai só até a vírgula: a condição depois dela continua valendo
  'Fico por aqui, mas se quiser garantir sua vaga é só me chamar que eu já deixo reservada 💜',
];

for (const frase of NAO_AFIRMA) {
  test(`não afirma: ${frase.slice(0, 70)}`, () => {
    assert.equal(detectarPromessa(frase), null, `não deveria pegar: ${frase}`);
  });
}

test('filtro do banco: toda afirmação real tem uma palavra do ILIKE (sem tirar acento) — senão o vigia nem a vê', () => {
  const ilike = (frase: string) => PALAVRAS_DO_FILTRO.some((p) => frase.toLowerCase().includes(p.toLowerCase()));
  for (const frase of AFIRMA) assert.ok(ilike(frase), `o filtro do banco perderia: ${frase}`);
});

test('mensagem vazia ou nula não quebra', () => {
  assert.equal(detectarPromessa(''), null);
  assert.equal(detectarPromessa(null), null);
  assert.equal(detectarPromessa(undefined), null);
});

// ── peças do detector ──────────────────────────────────────────────────────────────────────────────

test('trechos: frase, travessão e emoji seguido de maiúscula separam; emoji solto some', () => {
  assert.deepEqual(trechos('Combinado então! 😊 Deixo reservado pra sexta, 09/10 — só me confirma: manhã ou tarde?'), [
    'Combinado então!',
    'Deixo reservado pra sexta, 09/10',
    'só me confirma: manhã ou tarde?',
  ]);
  assert.deepEqual(trechos('Fica reservado terça, 06/10 às 08:30 💙 Você confirma que consegue vir?'), [
    'Fica reservado terça, 06/10 às 08:30 💙',
    'Você confirma que consegue vir?',
  ]);
});

test('quandoCitado: dia, data e hora compactos', () => {
  assert.equal(quandoCitado('Quinta, 08/10, às 8h30 fica reservado'), 'quinta 08/10 8h30');
  assert.equal(quandoCitado('te espero amanhã às 08:00'), 'amanha 8h');
  assert.equal(quandoCitado('sua consulta é dia 5/10 às 14:30'), '05/10 14h30');
  assert.equal(quandoCitado('fica reservado no seu nome'), null);
});

test('mensagemDaIA: fala da equipe, confirmação de véspera, cartão de chegada e nota interna ficam de fora', () => {
  assert.equal(mensagemDaIA({ via: 'salesbot' }), true);
  assert.equal(mensagemDaIA({ followUp: 2 }), true);
  assert.equal(mensagemDaIA(null), true);
  assert.equal(mensagemDaIA({ origem: 'kommo_talks', autor: 'equipe' }), false);
  assert.equal(mensagemDaIA({ origem: 'backfill-kommo' }), false);
  assert.equal(mensagemDaIA({ origem: 'confirmacao_d1', via: 'salesbot' }), false);
  assert.equal(mensagemDaIA({ via: 'chat_cartao' }), false);
  assert.equal(mensagemDaIA({ via: 'lead_note' }), false);
});

// ── "tem consulta?" ────────────────────────────────────────────────────────────────────────────────

test('consultaDoRastro lê os dois títulos de sucesso e só eles', () => {
  assert.equal(consultaDoRastro('Consulta marcada: 2026-10-09 07:00 (idSchedule 3738045)'), '2026-10-09T07:00');
  assert.equal(consultaDoRastro('Consulta marcada na franquia: 2026-10-09 07:00 (idSchedule 1)'), '2026-10-09T07:00');
  assert.equal(consultaDoRastro('agendar_consulta falhou: horário ocupado'), null);
  assert.equal(consultaDoRastro('agendar_consulta recusado — 07:00 está ocupado'), null);
});

test('consultasVivasDoRastro: consulta cancelada ou trocada pela remarcação não conta mais', () => {
  const titulos = [
    'Consulta marcada: 2026-10-09 07:00 (idSchedule 100)',
    'cancelar_consulta 100: cancelada',
    'Consulta marcada: 2026-10-12 10:00 (idSchedule 200)',
    'Consulta marcada: 2026-10-13 10:00 (idSchedule 300)',
    'remarcar: trocada (antiga 200)',
    'Consulta marcada: 2026-10-14 08:00 (idSchedule 400)',
    'cancelar_consulta 400: Erro 500 da franquia',
    'remarcar: vaga_presa (antiga 300)',
  ];
  assert.deepEqual(consultasVivasDoRastro(titulos), ['2026-10-13T10:00', '2026-10-14T08:00']);
  assert.deepEqual(consultasVivasDoRastro([]), []);
});

test('cartão: folga de 1 h — "faltou às 8h, às 10h30 prometeu amanhã" não se esconde atrás da consulta velha', () => {
  const cartao = (iso: string) => ({ custom_fields_values: [{ field_id: 1, field_name: '◷ Data da Consulta', values: [{ value: Date.parse(iso) / 1000 }] }] });
  const promessa = new Date('2026-10-07T13:30:00Z'); // 10:30 BRT
  const hora = 60 * 60_000;
  assert.equal(cartaoTemConsulta(cartao('2026-10-07T11:00:00Z'), promessa, hora), false, 'consulta das 8h BRT já passou');
  assert.equal(cartaoTemConsulta(cartao('2026-10-07T11:00:00Z'), promessa), true, 'o vigia de agendamento perdido segue com 4 h');
  assert.equal(cartaoTemConsulta(cartao('2026-10-07T13:00:00Z'), promessa, hora), true, '"te espero às 10h" dito às 10h30 ainda conta');
  assert.equal(cartaoTemConsulta(cartao('2026-10-08T11:00:00Z'), promessa, hora), true);
});

test('algumaDesde: consulta de outro ciclo (antes da promessa) não conta', () => {
  const desde = '2026-10-05T14:30';
  assert.equal(algumaDesde(['2026-10-09T07:00'], desde), true);
  assert.equal(algumaDesde(['2026-10-05T14:30'], desde), true, 'mesmo minuto conta');
  assert.equal(algumaDesde(['2026-09-20T10:00', null, undefined, 'lixo'], desde), false);
  assert.equal(algumaDesde([], desde), false);
});

// ── decisão ────────────────────────────────────────────────────────────────────────────────────────

const nada: Evidencias = { marcouNoRastro: false, vinculoFuturo: false, cartaoComConsulta: false, franquiaComConsulta: false };

test('decidir: qualquer fonte com consulta cala o alerta', () => {
  assert.equal(decidir({ ...nada, marcouNoRastro: true }).avisar, false);
  assert.equal(decidir({ ...nada, vinculoFuturo: true }).avisar, false);
  assert.equal(decidir({ ...nada, cartaoComConsulta: true }).avisar, false);
  assert.equal(decidir({ ...nada, franquiaComConsulta: true }).avisar, false);
});

test('decidir: nenhuma fonte com consulta = avisa (franquia sem resposta não segura)', () => {
  assert.equal(decidir(nada).avisar, true);
  const semFranquia = decidir({ ...nada, franquiaComConsulta: null });
  assert.equal(semFranquia.avisar, true);
  assert.match(semFranquia.motivo, /paciente não achado pelo telefone/);
});

test('decidir: cartão ilegível adia em vez de avisar no escuro', () => {
  const d = decidir({ ...nada, cartaoComConsulta: null });
  assert.equal(d.avisar, false);
  assert.equal(!d.avisar && d.adiar, true);
  // mas se o rastro já mostra a consulta, não precisa do cartão
  const r = decidir({ ...nada, marcouNoRastro: true, cartaoComConsulta: null });
  assert.equal(!r.avisar && r.adiar, undefined);
});

// ── próximo passo e dedupe ─────────────────────────────────────────────────────────────────────────

const agora = new Date('2026-10-07T15:00:00Z');
const semConsulta = decidir(nada);
const comConsulta = decidir({ ...nada, cartaoComConsulta: true });

test('proximoPasso: ligado e sem alerta recente = abre a tarefa', () => {
  assert.equal(proximoPasso({ estado: 'ligado', decisao: semConsulta, ultimoAvisoEm: null, agora }), 'alertar');
});

test('proximoPasso: só no papel nunca abre tarefa — registra "alertaria"', () => {
  assert.equal(proximoPasso({ estado: 'seco', decisao: semConsulta, ultimoAvisoEm: null, agora }), 'alertaria');
  // nem o dedupe atrapalha a medição
  assert.equal(proximoPasso({ estado: 'seco', decisao: semConsulta, ultimoAvisoEm: new Date(agora.getTime() - 60_000), agora }), 'alertaria');
});

test('proximoPasso: consulta existe = confere; cartão ilegível = adia', () => {
  assert.equal(proximoPasso({ estado: 'ligado', decisao: comConsulta, ultimoAvisoEm: null, agora }), 'confere');
  assert.equal(proximoPasso({ estado: 'ligado', decisao: decidir({ ...nada, cartaoComConsulta: null }), ultimoAvisoEm: null, agora }), 'adiar');
});

test('dedupe: um alerta por cartão a cada 24 h', () => {
  const ha23h = new Date(agora.getTime() - 23 * 3600_000);
  const ha25h = new Date(agora.getTime() - 25 * 3600_000);
  assert.equal(proximoPasso({ estado: 'ligado', decisao: semConsulta, ultimoAvisoEm: ha23h, agora }), 'ja-avisado');
  assert.equal(proximoPasso({ estado: 'ligado', decisao: semConsulta, ultimoAvisoEm: ha25h, agora }), 'alertar');
  assert.equal(UM_POR_LEAD_MS, 24 * 3600_000);
});

test('dedupe: a mesma mensagem não é relida enquanto está na janela, e a memória esquece sozinha', () => {
  const m = new Lembranca();
  const t0 = 1_000_000;
  m.lembrar('msg-1', 60_000, t0);
  assert.equal(m.sabe('msg-1', t0 + 59_999), true);
  assert.equal(m.sabe('msg-2', t0), false);
  assert.equal(m.sabe('msg-1', t0 + 60_000), false);
  m.esquecerVencidas(t0 + 60_000);
  assert.equal(m.tamanho, 0);
});

// ── o texto que a SDR lê ───────────────────────────────────────────────────────────────────────────

test('textoDoAlerta: formato do roteador de alertas, paciente, trecho e o que fazer', () => {
  const t = textoDoAlerta({
    slug: 'acailandia-resgate',
    nome: 'Giovanni',
    trecho: 'Deixo reservado pra sexta, 09/10',
    quando: 'sexta 09/10',
  });
  assert.equal(
    t,
    'ALERTA · acailandia-resgate · [Contato: Giovanni] ⚠️ A IA disse ao paciente que a consulta está marcada (sexta 09/10): ' +
      '"Deixo reservado pra sexta, 09/10". A consulta NÃO está na agenda — ligue ou mande mensagem e marque.',
  );
});

test('textoDoAlerta: sem nome não põe [Contato], e trecho longo é cortado', () => {
  const t = textoDoAlerta({ slug: 'doutor-hernia-serra', nome: null, trecho: 'x'.repeat(400), quando: null });
  assert.ok(t.startsWith('ALERTA · doutor-hernia-serra · ⚠️'));
  assert.ok(!t.includes('[Contato:'));
  assert.ok(t.length < 330);
  assert.ok(t.includes('…'));
});
