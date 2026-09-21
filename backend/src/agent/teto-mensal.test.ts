import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  acaoAoEstourar,
  avaliarNivel,
  contaDaUnidade,
  formatarBrl,
  tetoHabilitado,
  textoDoAviso,
  type VereditoMensal,
} from './teto-mensal.js';
import { inicioDoMesNoFuso, inicioDoProximoMesNoFuso, mesNoFuso, offsetMinutosNoFuso } from '../lib/fuso.js';

test('teto mensal: níveis — ok abaixo de 80 %, aviso de 80 % a 100 %, estourou no teto', () => {
  assert.equal(avaliarNivel(0, 300), 'ok');
  assert.equal(avaliarNivel(239.99, 300), 'ok');
  assert.equal(avaliarNivel(240, 300), 'aviso');
  assert.equal(avaliarNivel(299.99, 300), 'aviso');
  assert.equal(avaliarNivel(300, 300), 'estourou');
  assert.equal(avaliarNivel(1000, 300), 'estourou');
});

test('teto mensal: teto zero, negativo ou gasto inválido nunca bloqueia', () => {
  assert.equal(avaliarNivel(500, 0), 'ok');
  assert.equal(avaliarNivel(500, -1), 'ok');
  assert.equal(avaliarNivel(Number.NaN, 300), 'ok');
});

test('teto mensal: a ação padrão é avisar; só "pausar" corta', () => {
  assert.equal(acaoAoEstourar(undefined), 'avisar');
  assert.equal(acaoAoEstourar(''), 'avisar');
  assert.equal(acaoAoEstourar('bloquear'), 'avisar');
  assert.equal(acaoAoEstourar('pausar'), 'pausar');
  assert.equal(acaoAoEstourar(' PAUSAR '), 'pausar');
});

test('teto mensal: habilitado pra todas quando a variável falta OU está em branco; lista restringe', () => {
  assert.equal(tetoHabilitado('doutor-hernia-serra', undefined), true);
  assert.equal(tetoHabilitado('doutor-hernia-serra', ''), true, 'linha vazia no env não pode desligar a régua da chefe');
  assert.equal(tetoHabilitado('doutor-hernia-serra', '   '), true);
  assert.equal(tetoHabilitado('doutor-hernia-serra', '*'), true);
  assert.equal(tetoHabilitado('doutor-hernia-serra', 'doutor-hernia-serra, doutor-hernia-canaa'), true);
  assert.equal(tetoHabilitado('doutor-hernia-porto', 'doutor-hernia-serra'), false);
});

test('teto mensal: a clínica é a conta Kommo normalizada; sem subdomínio a unidade responde sozinha', () => {
  assert.equal(contaDaUnidade({ id: 'u1', kommoSubdomain: 'drherniaserra' }), 'drherniaserra');
  assert.equal(contaDaUnidade({ id: 'u1', kommoSubdomain: ' DrHerniaSerra ' }), 'drherniaserra');
  assert.equal(contaDaUnidade({ id: 'u1', kommoSubdomain: '  ' }), 'unidade:u1');
  assert.equal(contaDaUnidade({ id: 'u1', kommoSubdomain: null }), 'unidade:u1');
});

test('fuso: o mês começa à meia-noite do dia 1º no fuso da clínica', () => {
  const agora = new Date('2026-09-21T14:00:00Z');
  assert.equal(offsetMinutosNoFuso(agora, 'America/Sao_Paulo'), -180);
  assert.equal(offsetMinutosNoFuso(agora, 'America/Boa_Vista'), -240);
  assert.equal(inicioDoMesNoFuso(agora, 'America/Sao_Paulo').toISOString(), '2026-09-01T03:00:00.000Z');
  assert.equal(inicioDoMesNoFuso(agora, 'America/Boa_Vista').toISOString(), '2026-09-01T04:00:00.000Z');
  assert.equal(mesNoFuso(agora, 'America/Sao_Paulo'), '2026-09');
});

test('fuso: 01:00 UTC do dia 1º ainda é o mês anterior em São Paulo', () => {
  const madrugada = new Date('2026-10-01T01:00:00Z'); // 30/09 22:00 em SP
  assert.equal(mesNoFuso(madrugada, 'America/Sao_Paulo'), '2026-09');
  assert.equal(inicioDoMesNoFuso(madrugada, 'America/Sao_Paulo').toISOString(), '2026-09-01T03:00:00.000Z');
  const manha = new Date('2026-10-01T04:00:00Z'); // 01/10 01:00 em SP
  assert.equal(mesNoFuso(manha, 'America/Sao_Paulo'), '2026-10');
  assert.equal(inicioDoMesNoFuso(manha, 'America/Sao_Paulo').toISOString(), '2026-10-01T03:00:00.000Z');
});

test('fuso: a pausa "até o dia 1º" acaba à meia-noite local do mês seguinte, virando o ano em dezembro', () => {
  assert.equal(inicioDoProximoMesNoFuso(new Date('2026-09-21T14:00:00Z'), 'America/Sao_Paulo').toISOString(), '2026-10-01T03:00:00.000Z');
  assert.equal(inicioDoProximoMesNoFuso(new Date('2026-09-21T14:00:00Z'), 'America/Boa_Vista').toISOString(), '2026-10-01T04:00:00.000Z');
  assert.equal(inicioDoProximoMesNoFuso(new Date('2026-12-15T12:00:00Z'), 'America/Sao_Paulo').toISOString(), '2027-01-01T03:00:00.000Z');
});

test('teto mensal: texto do aviso diz a conta, o valor e o que acontece', () => {
  const aviso: VereditoMensal = { conta: 'drherniaserra', mes: '2026-09', brl: 246.4, teto: 300, fracao: 0.821, nivel: 'aviso' };
  const t80 = textoDoAviso(aviso, 'avisar');
  assert.match(t80.title, /drherniaserra/);
  assert.match(t80.title, /R\$ 246 de R\$ 300/);
  assert.match(t80.title, /82 %/);
  assert.match(t80.message, /só avisa de novo/);
  assert.match(textoDoAviso(aviso, 'pausar').message, /a IA pausa nesta conta até o dia 1º/);

  const estourou: VereditoMensal = { ...aviso, brl: 305, fracao: 1.02, nivel: 'estourou' };
  assert.match(textoDoAviso(estourou, 'avisar').title, /passou do teto do mês: R\$ 305 de R\$ 300/);
  assert.match(textoDoAviso(estourou, 'avisar').message, /continua respondendo/);
  assert.match(textoDoAviso(estourou, 'pausar').message, /pausada nesta conta até o dia 1º/);
  assert.match(textoDoAviso(estourou, 'pausar').message, /só despausar não basta/);
});

test('teto mensal: reais sem centavos, no formato brasileiro', () => {
  assert.equal(formatarBrl(1234.56), 'R$ 1.235');
  assert.equal(formatarBrl(0), 'R$ 0');
});
