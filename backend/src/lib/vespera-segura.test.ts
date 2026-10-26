import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { MensagemOficial } from '../services/kommo-talks-normalizar.js';
import { desistenciaEscrita, etapaSemVespera, pareceConfirmacao, pareceDesistencia, textoTarefaDesistencia } from './vespera-segura.js';
import { primeiroNomeDoPaciente } from './ponte-respostas.js';

let n = 0;
function msg(em: string, direcao: 'entrada' | 'saida', texto: string, autor: MensagemOficial['autor'] = direcao === 'entrada' ? 'paciente' : 'equipe'): MensagemOficial {
  return { id: String(++n), em: new Date(em), direcao, autor, autorNome: '', texto, anexo: null, status: null };
}

const MILENA = 'Boa tarde \nPeço desculpas, mas tive um imprevisto, não vou poder comparecer à consulta. \nQuando eu tiver disponibilidade vou estar passando na clínica.';

test('desistência: as frases de quem não vem', () => {
  assert.ok(pareceDesistencia(MILENA), 'o caso de Canaã, 17/10');
  for (const t of [
    'Não vou conseguir ir amanhã',
    'nao vamos poder comparecer',
    'n vou poder ir',
    'Preciso remarcar',
    'quero desmarcar',
    'pode cancelar minha consulta',
    'Tem como reagendar?',
    'Pode ser outro dia?',
    'não vai dar pra ir',
    'não poderei comparecer',
  ]) assert.ok(pareceDesistencia(t), t);
});

test('desistência: "não" solto e conversa comum não contam', () => {
  for (const t of [
    'Não',
    'Não tenho convênio',
    'não vou conseguir pagar antes, pago aí',
    'Ok obrigada',
    'Vou sim',
    'Qual o endereço?',
    'Não sei se tenho o exame',
  ]) assert.ok(!pareceDesistencia(t), t);
});

test('confirmação: botão, "1" e por extenso', () => {
  for (const t of ['1', 'Confirmo', 'confirmado!', 'Vou sim', 'estarei lá', 'Pode confirmar']) assert.ok(pareceConfirmacao(t), t);
  for (const t of ['10 anos de dor', 'Ok', MILENA]) assert.ok(!pareceConfirmacao(t), t);
});

test('Milena (Canaã, 28071358): desistiu depois de marcar e a equipe respondeu — segura a véspera', () => {
  const marcadaEm = new Date('2026-10-13T11:57:50Z');
  const msgs = [
    msg('2026-10-13T12:01:22Z', 'entrada', 'Tudo certo'),
    msg('2026-10-17T15:28:42Z', 'saida', ''),
    msg('2026-10-17T15:53:48Z', 'entrada', MILENA),
    msg('2026-10-17T18:32:42Z', 'saida', 'Entendemos que imprevisto podem acontecer. Podemos reagendar para quinta às 11h30?'),
  ];
  assert.equal(desistenciaEscrita(msgs, marcadaEm)?.texto, MILENA);
});

test('confirmou depois de desistir: a véspera sai', () => {
  const msgs = [
    msg('2026-10-17T15:53:48Z', 'entrada', 'não vou poder ir'),
    msg('2026-10-17T16:10:00Z', 'entrada', 'Ah, consegui resolver. Confirmo, vou sim'),
  ];
  assert.equal(desistenciaEscrita(msgs, new Date('2026-10-13T00:00:00Z')), null);
});

test('desistência ANTES de a consulta atual ser gravada não cala o lembrete da nova', () => {
  const msgs = [
    msg('2026-10-17T15:53:48Z', 'entrada', MILENA),
    msg('2026-10-17T18:40:00Z', 'entrada', 'Quinta 11h30 está ótimo'),
  ];
  assert.equal(desistenciaEscrita(msgs, new Date('2026-10-17T18:45:00Z')), null, 'remarcada às 18:45');
});

test('só a fala do paciente conta: a equipe escrevendo "remarcar" não segura', () => {
  const msgs = [
    msg('2026-10-17T15:00:00Z', 'entrada', 'Ok'),
    msg('2026-10-17T15:10:00Z', 'saida', 'Se precisar remarcar é só avisar', 'equipe'),
    msg('2026-10-17T15:11:00Z', 'saida', 'Qualquer imprevisto me chama', 'sofia'),
  ];
  assert.equal(desistenciaEscrita(msgs, new Date('2026-10-13T00:00:00Z')), null);
});

test('etapa: perdido, cancelado, desistência e em espera seguram; agendado não', () => {
  assert.equal(etapaSemVespera({ statusId: 143, nome: 'Perdido' }), 'perdido');
  assert.equal(etapaSemVespera({ statusId: 1, nome: 'TRATAMENTO CANCELADO' }), 'etapa');
  assert.equal(etapaSemVespera({ statusId: 2, nome: 'EM ESPERA' }), 'etapa');
  assert.equal(etapaSemVespera({ statusId: 3, nome: 'Desistência' }), 'etapa');
  assert.equal(etapaSemVespera({ statusId: 106813991, nome: 'AGENDADO' }), null);
  assert.equal(etapaSemVespera({ statusId: 4, nome: null }), null);
});

test('nome da véspera: do título, nunca do perfil do WhatsApp', () => {
  assert.equal(primeiroNomeDoPaciente('Milena/Leomar dos Santos', null), 'Milena');
  assert.equal(primeiroNomeDoPaciente('Lead #28222940', null), null, 'sem nome no título → "Oi!"');
});

test('tarefa da desistência diz o dia, o que o paciente escreveu e o que fazer', () => {
  const t = textoTarefaDesistencia({ slug: 'doutor-hernia-canaa', nome: 'Milena', quando: '2026-10-19T08:00', etapa: 'AGENDADO', mensagem: MILENA });
  assert.match(t, /^ALERTA · doutor-hernia-canaa · \[Contato: Milena\]/);
  assert.match(t, /19\/10 às 08:00/);
  assert.match(t, /imprevisto/);
  assert.match(t, /cartão em AGENDADO/);
});

test('a véspera é superconjunto do detector da régua e da Sofia: o que cala um nunca deixa a véspera sair', () => {
  for (const t of ['Cancelei.', 'pode desmarcar', 'Não vou poder ir amanhã', 'Tive um imprevisto', 'não vai dar pra mim ir hoje', 'vou ter que desistir da vaga']) {
    assert.ok(pareceDesistencia(t), t);
  }
});

test('a véspera NÃO deixa de sair para quem quer manter a consulta ou fala de outra (achado do sênior, #132)', () => {
  for (const t of ['Não quero remarcar, quero manter', 'cancela não', 'consegui me organizar, não vou mais faltar', 'cancela a do meu filho, a minha mantém', 'cancela a minha de terça e deixa a de quinta']) {
    assert.equal(pareceDesistencia(t), false, t);
  }
});

test('pareceConfirmacao não casa "não vou lá não, pode cancelar" (o "vou lá" é negado)', () => {
  assert.equal(pareceConfirmacao('não vou lá não, pode cancelar'), false);
  assert.equal(pareceConfirmacao('n vou la, cancela'), false);
  assert.equal(pareceConfirmacao('vou lá sim'), true);
  assert.equal(pareceConfirmacao('estarei la'), true);
});
