/**
 * Lista de Marabá (21/10/2026): os casos das conversas de 08 a 19/10, presos em teste.
 *
 *  - 28264328: "quero ver se o dr passa uma medicação" — médico/remédio subentendido, sem a pergunta "é médico?".
 *  - 27849922: dor que irradia "pra barriga e virilha… nos testículos" — a Sofia perguntou de sono e trabalho.
 *  - 28253300: "Qual o valor da sessão?" → "Já te expliquei certo, Dária: …".
 *  - 28220160: "Pode ser algum problema na coluna devido o acidente?" sem resposta; acidente de um ano atrás.
 *  - 28072622: paciente em tratamento ouviu oferta de consulta e pedido de nome completo.
 *  - 28466712: "ou é only o joelho mesmo?".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { aplicarGuardrail } from './guardrail.js';
import { corrigirTomDaSaida } from './tom-da-saida.js';
import { perguntasEmAberto, renderPerguntaDoPaciente } from './pergunta-do-paciente.js';
import { falaDePacienteEmTratamento, renderFalaDePaciente } from './fala-de-paciente.js';
import { renderSinalDeAlerta, travaDaRegraDeSinalDeAlerta } from './sinal-de-alerta.js';
import { renderIdentidadeDoutorHernia } from './rede-doutor-hernia.js';
import { renderEtapaLead } from './prompt-composer.js';
import type { Fala } from './repeticao.js';

const clinica = { category: 'saude', sourceProdutos: null, sourcePapel: null, sourceNegocio: null } as unknown as Unit;
const ia = (texto: string): Fala => ({ papel: 'ia', texto });
const paciente = (texto: string): Fala => ({ papel: 'paciente', texto });

// ── saída: inglês e "já te expliquei" ────────────────────────────────────────────────────────────────────────

test('28466712: "only" no meio da frase vira "só"', () => {
  const r = corrigirTomDaSaida('Mas me diz: você sente algo nas costas também, ou é only o joelho mesmo?');
  assert.equal(r.texto, 'Mas me diz: você sente algo nas costas também, ou é só o joelho mesmo?');
  assert.deepEqual(r.trocas, ['ingles:only']);
});

test('inglês do dia a dia fica: ok, online, e-mail, check-up, nome com "Just"', () => {
  const t = 'Ok, Justino! Dá pra mandar por e-mail ou online, e o check-up fica pra depois.';
  assert.deepEqual(corrigirTomDaSaida(t), { texto: t, trocas: [] });
});

test('fala do paciente citada entre aspas não é mexida', () => {
  for (const t of ['Você escreveu "only joelho", né? É só o joelho mesmo?', 'Quando você diz “just a little”, é pouca dor?']) {
    assert.equal(corrigirTomDaSaida(t).texto, t);
  }
});

test('link não é mexido', () => {
  const t = 'Mapa: https://example.com/only/just?also=1 — é só abrir.';
  assert.equal(corrigirTomDaSaida(t).texto, t);
});

test('28253300: "Já te expliquei certo, Dária:" sai e a frase começa com maiúscula', () => {
  const r = corrigirTomDaSaida(
    'Já te expliquei certo, Dária: a consulta é R$ 350 pagos no dia, direto na clínica. ☺\n\nVamos ver um horário pra você?',
  );
  assert.equal(r.texto, 'A consulta é R$ 350 pagos no dia, direto na clínica. ☺\n\nVamos ver um horário pra você?');
  assert.deepEqual(r.trocas, ['ja_expliquei']);
});

test('"como eu disse," no meio do texto também sai', () => {
  const r = corrigirTomDaSaida('Entendi! Como eu disse, a consulta dura 30 minutos. Quer marcar?');
  assert.equal(r.texto, 'Entendi! A consulta dura 30 minutos. Quer marcar?');
});

test('"já falei com a equipe" não é cobrança e fica', () => {
  const t = 'Já falei com a equipe e eles vão te chamar. Posso ajudar em mais alguma coisa?';
  assert.equal(corrigirTomDaSaida(t).texto, t);
});

test('o guardrail aplica a correção e registra', () => {
  const r = aplicarGuardrail('Ou é only o joelho mesmo?', clinica);
  assert.equal(r.text, 'Ou é só o joelho mesmo?');
  assert.equal(r.rewritten, true);
  assert.ok(r.triggered.includes('tom:ingles:only'));
});

// ── trava clínica: "não receitamos remédio" passa ────────────────────────────────────────────────────────────

test('28264328: dizer que NÃO receita remédio não cai na trava de prescrição', () => {
  const t =
    'Somos fisioterapeutas especialistas no tratamento da coluna pelo método Doutor Hérnia. Aqui a gente não receita ' +
    'remédio, Marta — o tratamento é sem remédio e sem cirurgia, e a medicação continua com o seu médico. Posso te ajudar a marcar?';
  const r = aplicarGuardrail(t, clinica);
  assert.equal(r.text, t);
  assert.ok(!r.triggered.some((x) => x.startsWith('clinico:')));
});

test('prescrever continua barrado — e mandar NÃO tomar também', () => {
  for (const t of [
    'Enquanto isso pode tomar um anti-inflamatório pra aliviar.',
    'O especialista vai receitar um remédio mais forte pra você.',
    'Você não precisa tomar remédio nenhum até a consulta.',
  ]) {
    const r = aplicarGuardrail(t, clinica);
    assert.ok(r.triggered.includes('clinico:prescricao'), t);
  }
});

test('regra de médico/remédio subentendido está no prompt da rede', () => {
  const b = renderIdentidadeDoutorHernia();
  assert.ok(b.includes('MÉDICO OU REMÉDIO SUBENTENDIDO'));
  assert.ok(b.includes('quero ver se o dr passa uma medicação'));
});

// ── pergunta direta do paciente ──────────────────────────────────────────────────────────────────────────────

test('28220160: a pergunta do acidente entra no turno', () => {
  const falas = [
    ia('Por nada! Qualquer outra dúvida, pode me chamar.'),
    paciente(
      'Eu sofri um acidente de moto quebrei a tíbia e fraturei a fíbula .tenho placa e parafusos, e ultimamente estou ' +
        'sentindo da minha coluna, confesso que tenho algumas limitações. Pode ser algum problema na coluna devido o acidente?',
    ),
  ];
  assert.deepEqual(perguntasEmAberto(falas), ['Pode ser algum problema na coluna devido o acidente?']);
  const b = renderPerguntaDoPaciente(falas, { clinica: true });
  assert.ok(b.startsWith('<pergunta_do_paciente>'));
  assert.ok(b.includes('pode ter relação, sim'));
});

test('28220160: "vocês atendem" sem o ponto de interrogação também conta', () => {
  const falas = [ia('Essa dor tem atrapalhado seu dia a dia?'), paciente('Como faço pra agendar uma consulta?\nE se essa área vocês pode atender')];
  assert.equal(perguntasEmAberto(falas).length, 2);
});

test('preço, cortesia e "pode ser" de aceite não viram pergunta', () => {
  for (const t of ['Qual o valor da sessão?', 'Tudo bem?', 'Pode ser', 'Pode ser sim', 'Quando eu sento dói muito']) {
    assert.deepEqual(perguntasEmAberto([ia('Oi!'), paciente(t)]), [], t);
  }
});

test('pergunta de uma fala que a IA já respondeu não volta', () => {
  const falas = [paciente('Vocês atendem joelho?'), ia('Atendemos só coluna.'), paciente('Entendi, obrigada')];
  assert.deepEqual(perguntasEmAberto(falas), []);
});

test('"vocês atenderam muito bem" no passado não é pergunta', () => {
  assert.deepEqual(perguntasEmAberto([ia('Oi!'), paciente('Vocês atenderam muito bem a minha mãe')]), []);
});

test('fora de clínica, o bloco não fala de diagnóstico', () => {
  const b = renderPerguntaDoPaciente([ia('Oi!'), paciente('Vocês atendem em Belém?')], { clinica: false });
  assert.ok(b.length > 0);
  assert.ok(!b.includes('diagnosticar'));
});

// ── paciente em tratamento ───────────────────────────────────────────────────────────────────────────────────

test('28072622: "pode confirmar a fisioterapia de hoje" é fala de quem já faz tratamento', () => {
  const falas = [paciente('Bom dia pode confirmar a fisioterapia de hoje por favor. Me mande só o horário.')];
  assert.ok(falaDePacienteEmTratamento(falas));
  const b = renderFalaDePaciente(falas);
  assert.ok(b.includes('NÃO use consultar_horarios'));
  assert.ok(b.includes('NÃO peça nome completo'));
});

test('quem pergunta o preço da sessão ainda não é paciente', () => {
  for (const t of ['Qual o valor da sessão?', 'Quantas sessões são?', 'Faço fisioterapia há anos e não melhorou']) {
    assert.equal(falaDePacienteEmTratamento([paciente(t)]), null, t);
  }
});

test('cartão no funil TRATAMENTO: sessão é com a equipe, sem consulta e sem nome', () => {
  const b = renderEtapaLead({ statusId: 1, nome: 'EM TRATAMENTO', jaAgendadoOuPaciente: true, funilTratamento: true });
  assert.ok(b.includes('ELE ESTÁ EM TRATAMENTO'));
  assert.ok(b.includes('NÃO peça nome completo'));
  const comercial = renderEtapaLead({ statusId: 2, nome: 'AGENDADO', jaAgendadoOuPaciente: true });
  assert.ok(!comercial.includes('ELE ESTÁ EM TRATAMENTO'));
});

// ── sinais de alerta ─────────────────────────────────────────────────────────────────────────────────────────

test('27849922: dor que vai para virilha/testículos pede a pergunta de sinais, começando pela dormência', () => {
  const b = renderSinalDeAlerta(clinica);
  const trecho = b.slice(b.indexOf('DOR QUE VAI PARA A VIRILHA'), b.indexOf('NÃO É sinal de alerta'));
  assert.ok(trecho.includes('testículos'));
  assert.ok(trecho.includes('não pule para sono e trabalho'));
  assert.ok(trecho.includes('dormente'));
  assert.ok(b.indexOf('DOR QUE VAI PARA A VIRILHA') < b.indexOf('SINAIS GRAVES DA COLUNA'));
});

test('28220160: acidente antigo não é sinal de alerta — no bloco e na regra trauma/febre do cadastro', () => {
  const b = renderSinalDeAlerta(clinica);
  assert.ok(b.includes('ACIDENTE, FRATURA OU CIRURGIA ANTIGA'));
  const trava = travaDaRegraDeSinalDeAlerta(
    'Sinal de alerta confirmado pelo paciente (um sinal por pergunta): dor forte depois de queda, pancada ou acidente, ou febre junto com a dor.',
  );
  assert.ok(trava.includes('RECENTE'));
  assert.ok(trava.includes('SINAIS GRAVES DA COLUNA'), 'a trava dos sinais graves continua');
  assert.equal(travaDaRegraDeSinalDeAlerta('Paciente pergunta o endereço'), '');
});

test('a ressalva do trauma antigo não passa por cima de regra com prazo nem de regra que não é sinal de alerta', () => {
  const comPrazo = travaDaRegraDeSinalDeAlerta('Sinal de alerta: dor depois de queda ou acidente, mesmo de anos atrás');
  assert.ok(!comPrazo.includes('RECENTE'));
  assert.equal(travaDaRegraDeSinalDeAlerta('Paciente com sequela de trauma ortopédico ou acidente de trabalho'), '');
});
