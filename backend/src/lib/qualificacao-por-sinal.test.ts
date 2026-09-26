/**
 * A régua de Quente/Morno/Frio — e as duas coisas que ela garante.
 *
 * 1. Sempre responde. A IA deixava 69% dos leads sem rótulo; uma régua que também
 *    devolve "não sei" não teria resolvido nada.
 * 2. Sempre explica. Campo no CRM sem o porquê ninguém confere, e o que ninguém confere
 *    ninguém corrige.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classificar } from './qualificacao-por-sinal.js';

test('consulta marcada na franquia é o sinal mais forte — vence tudo', () => {
  const c = classificar({ mensagensDoPaciente: 0, ferramentasChamadas: [], temConsultaMarcada: true });
  assert.equal(c.temperatura, 'Quente');
});

test('pedir horário é Quente, mesmo em conversa curta', () => {
  const c = classificar({ mensagensDoPaciente: 2, ferramentasChamadas: ['consultar_horarios'] });
  assert.equal(c.temperatura, 'Quente');
  assert.match(c.porque, /consultar_horarios/);
});

test('uma mensagem e sumiu é Frio — é 34% dos leads e a IA nunca os rotulou', () => {
  assert.equal(classificar({ mensagensDoPaciente: 1, ferramentasChamadas: [] }).temperatura, 'Frio');
  assert.equal(classificar({ mensagensDoPaciente: 0, ferramentasChamadas: [] }).temperatura, 'Frio');
});

test('conversou e não pediu horário é Morno', () => {
  const c = classificar({ mensagensDoPaciente: 5, ferramentasChamadas: ['registrar_campo'] });
  assert.equal(c.temperatura, 'Morno');
});

test('ferramenta que não é de agenda não esquenta o lead', () => {
  for (const f of ['registrar_campo', 'aplicar_tag', 'resumir_lead_para_sdr', 'pausar_ia']) {
    const c = classificar({ mensagensDoPaciente: 3, ferramentasChamadas: [f] });
    assert.equal(c.temperatura, 'Morno', `${f} não devia virar Quente`);
  }
});

test('sempre responde — nenhuma combinação devolve vazio', () => {
  for (const msgs of [0, 1, 2, 9]) {
    for (const fs of [[], ['registrar_campo'], ['agendar_consulta']]) {
      const c = classificar({ mensagensDoPaciente: msgs, ferramentasChamadas: fs });
      assert.ok(['Quente', 'Morno', 'Frio'].includes(c.temperatura));
      assert.ok(c.porque.length > 5, 'sem explicação ninguém confere o campo');
    }
  }
});

test('lead que só mandou uma mensagem MAS pediu horário é Quente', () => {
  // Acontece: o anúncio já leva a pessoa pedindo horário na primeira frase.
  const c = classificar({ mensagensDoPaciente: 1, ferramentasChamadas: ['agendar_consulta'] });
  assert.equal(c.temperatura, 'Quente');
});
