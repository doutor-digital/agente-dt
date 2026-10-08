/**
 * Açailândia, 08/10/2026 11:43, cartão de teste 28340326 em TRATAMENTO CANCELADO (143 do funil
 * TRATAMENTO 14304315): o paciente tocou em "Financeiro" e a Sofia de RESGATE respondeu oferecendo a
 * consulta. O roteador achou a `acailandia-resgate` porque a allowlist dela tem 143 — o PERDIDO do
 * COMERCIAL 13795975 — e o Kommo usa o mesmo 143 em todo funil.
 *
 * Os funis abaixo são os da conta da Açailândia (Kommo, 08/10/2026), e as allowlists, as das duas
 * unidades dela no banco.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { montarEsquema } from './kommo-schema.js';
import { etapaPermitida, precisaDoFunil } from './etapa-permitida.js';

const COMERCIAL = 13795975;
const TRATAMENTO = 14304315;
const funis = montarEsquema([], [
  {
    id: COMERCIAL,
    name: 'COMERCIAL',
    statuses: [
      { id: 106446875, name: 'Etapa de leads de entrada' },
      { id: 106809907, name: 'EM QUALIFICAÇÃO' },
      { id: 111237819, name: 'EM ESPERA' },
      { id: 106809915, name: 'AGENDADO' },
      { id: 142, name: 'GANHO / CONCLUIDO' },
      { id: 143, name: 'PERDIDO' },
    ],
  },
  {
    id: TRATAMENTO,
    name: 'TRATAMENTO',
    statuses: [
      { id: 110468755, name: 'EM TRATAMENTO' },
      { id: 142, name: 'ALTA' },
      { id: 143, name: 'TRATAMENTO CANCELADO' },
    ],
  },
]);

const RESGATE = [143, 111237819];
const COMERCIAL_ALLOW = [106446875, 106809907, 106809915, 111237819];

test('esquema: 142/143 não dizem o funil; os outros ids dizem', () => {
  assert.equal(funis.pipelineDoStatus(143), null);
  assert.equal(funis.pipelineDoStatus(142), null);
  assert.equal(funis.pipelineDoStatus(111237819), COMERCIAL);
  assert.equal(funis.pipelineDoStatus(110468755), TRATAMENTO);
  assert.equal(funis.nomeDoFunil(TRATAMENTO), 'TRATAMENTO');
});

test('o caso de 08/10: TRATAMENTO CANCELADO não é etapa da IA de resgate', () => {
  assert.equal(etapaPermitida(RESGATE, 143, TRATAMENTO, funis), false);
  // o que ela atende continua igual
  assert.equal(etapaPermitida(RESGATE, 143, COMERCIAL, funis), true, 'PERDIDO do COMERCIAL');
  assert.equal(etapaPermitida(RESGATE, 111237819, COMERCIAL, funis), true, 'EM ESPERA');
  assert.equal(etapaPermitida(RESGATE, 106809907, COMERCIAL, funis), false, 'EM QUALIFICAÇÃO é da comercial');
});

test('roteador: em TRATAMENTO CANCELADO nenhuma IA é dona — fica com a de entrada, onde vale a Sofia calada', () => {
  const conta = [
    { slug: 'doutor-hernia-acailandia', allow: COMERCIAL_ALLOW },
    { slug: 'acailandia-resgate', allow: RESGATE },
  ];
  const dona = (sid: number, pid: number) => conta.find((u) => etapaPermitida(u.allow, sid, pid, funis))?.slug ?? null;
  assert.equal(dona(143, TRATAMENTO), null);
  assert.equal(dona(143, COMERCIAL), 'acailandia-resgate');
  assert.equal(dona(106809907, COMERCIAL), 'doutor-hernia-acailandia');
});

test('sem conseguir ler os funis, vale a regra antiga (falha de leitura não cala a resgate em PERDIDO)', () => {
  assert.equal(etapaPermitida(RESGATE, 143, TRATAMENTO, null), true);
  assert.equal(etapaPermitida(RESGATE, 143, undefined, funis), true);
});

test('allowlist só com 143 (sem outro id para ancorar): decide pelo nome do funil', () => {
  assert.equal(etapaPermitida([143], 143, TRATAMENTO, funis), false);
  assert.equal(etapaPermitida([143], 143, COMERCIAL, funis), true);
});

test('fora da lista continua fora; id comum não precisa do esquema', () => {
  assert.equal(etapaPermitida(RESGATE, 110468755, TRATAMENTO, funis), false);
  assert.equal(etapaPermitida(RESGATE, null, COMERCIAL, funis), false);
  assert.equal(precisaDoFunil(RESGATE, 143), true);
  assert.equal(precisaDoFunil(RESGATE, 111237819), false);
  assert.equal(precisaDoFunil(COMERCIAL_ALLOW, 143), false, 'quem não tem 143 na lista nem lê o esquema');
});

test('roteador e trava da allowlist usam a regra com funil (webhook.controller.ts)', () => {
  const src = readFileSync(new URL('../controllers/webhook.controller.ts', import.meta.url), 'utf8');
  assert.match(src, /account\.find\(\(u\) => etapaPermitida\(u\.kommoAllowedStatusIds \?\? \[\], sid, pid, funis\)\)/);
  assert.match(src, /allowedStatusIds\.length > 0 && !etapaPermitida\(allowedStatusIds, sid, pid, funis\)/);
  assert.doesNotMatch(src, /kommoAllowedStatusIds \?\? \[\]\)\.includes\(sid/, 'voltou a casar 143 só pelo id');
});
