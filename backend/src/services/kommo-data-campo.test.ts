import { test } from 'node:test';
import assert from 'node:assert/strict';

import { epochDeCampoData } from './kommo.service.js';

/**
 * O caso real: Cátia (Serra, 24/09/2026) pediu pra ser chamada depois de 05/10.
 * A IA gravou '2026-10-05' e o cartão mostrou 04/10, porque meia-noite UTC em
 * São Paulo ainda é o dia anterior.
 */
test('data pura vira meio-dia UTC — não cai pro dia anterior em fuso negativo', () => {
  const epoch = epochDeCampoData('2026-10-05');
  assert.ok(epoch !== null);

  const emSaoPaulo = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(epoch! * 1000));
  assert.equal(emSaoPaulo, '2026-10-05', 'no fuso da clínica tem que continuar dia 5');

  // o jeito antigo (meia-noite UTC) caía pro dia 4 — é o bug que motivou isto
  const antigo = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.parse('2026-10-05')));
  assert.equal(antigo, '2026-10-04', 'confirma que o jeito antigo errava mesmo');
});

test('aguenta os outros fusos da rede sem virar o dia', () => {
  const epoch = epochDeCampoData('2026-01-01')!;
  for (const tz of ['America/Sao_Paulo', 'America/Belem', 'America/Manaus', 'America/Rio_Branco', 'UTC']) {
    const dia = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(epoch * 1000));
    assert.equal(dia, '2026-01-01', `virou o dia em ${tz}`);
  }
});

test('data COM hora é respeitada como veio', () => {
  assert.equal(
    epochDeCampoData('2026-10-05T14:30:00Z'),
    Math.floor(Date.parse('2026-10-05T14:30:00Z') / 1000),
  );
  assert.equal(
    epochDeCampoData('2026-10-05T14:30:00-03:00'),
    Math.floor(Date.parse('2026-10-05T14:30:00-03:00') / 1000),
  );
});

test('lixo devolve null em vez de gravar data errada', () => {
  assert.equal(epochDeCampoData('depois do dia 5'), null);
  assert.equal(epochDeCampoData(''), null);
  assert.equal(epochDeCampoData('05/10/2026'), null, 'formato brasileiro não é ISO — melhor falhar que gravar mês errado');
});
