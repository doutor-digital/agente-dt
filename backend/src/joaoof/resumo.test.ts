import { test } from 'node:test';
import assert from 'node:assert/strict';
import { montarResumo, paraHoje, hojeIso } from './resumo.js';
import type { Demanda, UnidadeJoaoof } from './repo.js';

const UNIDADES: UnidadeJoaoof[] = [
  { slug: 'doutor-hernia-parauapebas', nome: 'Parauapebas', grupoJid: null, notas: '', ativa: true },
  { slug: 'doutor-hernia-acailandia', nome: 'Açailândia', grupoJid: null, notas: '', ativa: true },
];

let n = 0;
const dem = (o: Partial<Demanda>): Demanda => ({
  id: `d${++n}`,
  numero: n,
  unidadeSlug: 'doutor-hernia-parauapebas',
  solicitante: '',
  titulo: 'Titulo da demanda',
  descricao: '',
  trecho: '',
  categoria: 'pedido',
  prioridade: 'normal',
  status: 'aberta',
  responsavel: 'joao',
  prazo: null,
  prazoTexto: '',
  fonte: 'grupo',
  fonteRefs: [],
  camposDoJoao: [],
  repeticoes: 1,
  motivo: '',
  notaJoao: '',
  vistaEm: new Date('2026-11-26T12:00:00Z'),
  avisadaEm: null,
  resolvidaEm: null,
  criadoEm: new Date(`2026-11-26T12:${String(n).padStart(2, '0')}:00Z`),
  atualizadoEm: new Date('2026-11-26T12:00:00Z'),
  ...o,
});

// sexta, 27/11/2026, 08:00 em Brasília = 11:00Z
const OITO = new Date('2026-11-27T11:00:00Z');

test('hojeIso usa o fuso do João: 02:30Z de sábado ainda é sexta em Brasília', () => {
  assert.equal(hojeIso(new Date('2026-11-28T02:30:00Z')), '2026-11-27');
  assert.equal(hojeIso(new Date('2026-11-28T03:30:00Z')), '2026-11-28');
});

test('8h: ordem por prioridade, separa «só você» de «outra pessoa», conta o que fica sem pressa', () => {
  n = 0;
  const abertas = [
    dem({ titulo: 'Baixa sem prazo', prioridade: 'baixa' }),
    dem({ titulo: 'Sofia parou de responder em Parauapebas', prioridade: 'urgente', solicitante: 'Nycolas' }),
    dem({ titulo: 'Subir arte de Natal', prioridade: 'alta', responsavel: 'lia', unidadeSlug: 'doutor-hernia-acailandia' }),
    dem({ titulo: 'Relatório da semana', prioridade: 'normal', prazo: '2026-11-27', prazoTexto: 'hoje' }),
    dem({ titulo: 'Pedido antigo', prioridade: 'normal', prazo: '2026-11-25' }),
  ];
  const t = montarResumo({ agora: OITO, hora: 8, abertas, unidades: UNIDADES })!;
  assert.match(t, /^☀️ Bom dia, João — sexta, 27\/11/);
  const iUrg = t.indexOf('Sofia parou');
  const iAtr = t.indexOf('Pedido antigo');
  const iHoje = t.indexOf('Relatório da semana');
  assert.ok(iUrg > 0 && iUrg < iAtr && iAtr < iHoje, 'urgente, depois atrasada, depois prazo hoje');
  assert.ok(t.indexOf('SÓ VOCÊ PODE FAZER (3)') < t.indexOf('COM OUTRA PESSOA (1)'));
  assert.match(t, /Subir arte de Natal.*→ lia/);
  assert.match(t, /Sem pressa: 1 aberta/);
  assert.match(t, /"feito 2", "passa a 3 pra Lia"/); // exemplos com os números da própria lista (o #2 é o urgente, o #3 é o de Natal)
  assert.match(t, /atrasada \(25\/11\)/);
  assert.match(t, /Parauapebas · URGENTE — Sofia parou de responder em Parauapebas \(Nycolas\)/);
});

test('8h manda mesmo sem nada (é o sinal de que está vivo); 18h vazio não manda', () => {
  assert.match(montarResumo({ agora: OITO, hora: 8, abertas: [], unidades: UNIDADES })!, /Nada pendente/);
  assert.equal(montarResumo({ agora: new Date('2026-11-27T21:00:00Z'), hora: 18, abertas: [], unidades: UNIDADES }), null);
  // só o que não tem pressa também não rende aviso às 18h
  assert.equal(montarResumo({ agora: new Date('2026-11-27T21:00:00Z'), hora: 18, abertas: [dem({ prioridade: 'baixa' })], unidades: UNIDADES }), null);
});

test('18h conta o que foi resolvido hoje; alerta do próprio Joaoof sobe ao topo', () => {
  n = 0;
  const t = montarResumo({ agora: new Date('2026-11-27T21:00:00Z'), hora: 18, abertas: [dem({ prioridade: 'alta' })], feitasHoje: 3, unidades: UNIDADES, alertas: ['Gasto do Joaoof em 85% do teto.'] })!;
  assert.match(t, /^🌆 Fechando o dia/);
  assert.match(t, /Resolvidas hoje: 3/);
  assert.ok(t.indexOf('⚠️ Gasto') < t.indexOf('SÓ VOCÊ'));
});

test('limita a lista e diz quantas ficaram de fora; unidade repetindo 3x vira «para hoje»', () => {
  n = 0;
  const muitas = Array.from({ length: 11 }, (_, i) => dem({ titulo: `Pedido numero ${i + 1} urgentíssimo`, prioridade: 'alta' }));
  const t = montarResumo({ agora: OITO, hora: 8, abertas: muitas, unidades: UNIDADES })!;
  assert.match(t, /… e mais 3\./);
  assert.equal(paraHoje(dem({ prioridade: 'normal', repeticoes: 3 }), '2026-11-27'), true);
  assert.equal(paraHoje(dem({ prioridade: 'normal' }), '2026-11-27'), false);
});

test('manual (/resumo): às 18h com só demandas sem pressa NÃO devolve null nem «nada pendente»; lista todas', () => {
  n = 0;
  const abertas = [dem({ prioridade: 'baixa', titulo: 'Arte de Natal para as três unidades' }), dem({ prioridade: 'normal', titulo: 'Relatório da semana de Açailândia' })];
  assert.equal(montarResumo({ agora: new Date('2026-11-27T21:00:00Z'), hora: 18, abertas, unidades: UNIDADES }), null); // o automático segue quieto
  const t = montarResumo({ agora: new Date('2026-11-27T21:00:00Z'), hora: 18, abertas, unidades: UNIDADES, manual: true })!;
  assert.match(t, /SEM PRESSA \(2\)/);
  assert.match(t, /"feito 2", "passa a 1 pra Lia"/);
  assert.match(montarResumo({ agora: OITO, hora: 8, abertas: [], unidades: UNIDADES, manual: true })!, /Nada pendente/);
});

test('o prazo escrito pelo modelo aparece como «dito: …» (nunca como se fosse um prazo confirmado)', () => {
  n = 0;
  const t = montarResumo({ agora: OITO, hora: 8, abertas: [dem({ prioridade: 'alta', prazoTexto: 'depois do almoço' })], unidades: UNIDADES })!;
  assert.match(t, /dito: depois do almoço/);
  assert.doesNotMatch(t, /prazo depois do almoço/);
});
