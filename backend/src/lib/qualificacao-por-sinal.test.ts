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
import { classificar, sinaisDosPassos } from './qualificacao-por-sinal.js';

// Títulos COPIADOS de agenda-tools.ts / marcacao-widget.ts: é assim que os passos são gravados em produção.
// O worker procurava 'Decisão: x(' em TOOL_CALL — 0 passos assim para a agenda em todo o banco.
const T = {
  consultaCache: 'consultar_horarios 2026-11-03 (manhã): 4 confirmado(s) — do cache (franquia consultada há 3 min)',
  consultaFranquia: 'consultar_horarios 2026-11-03: 0 confirmado(s) de 2 livre(s) na grade',
  consultaPausada: 'consultar_horarios bloqueado — IA pausada pela recepção',
  agendarRecusado: 'agendar_consulta recusado — faltou confirmar o dia ou a forma de pagamento',
  agendarPausada: 'agendar_consulta recusado — IA pausada pela recepção',
  agendarFalhou: 'agendar_consulta falhou: timeout',
  marcada: 'Consulta marcada: 2026-11-03 09:00 (idSchedule 123)',
  marcadaWidget: 'Consulta marcada na franquia: 2026-11-03 09:00 (idSchedule 123)',
  cadastro: 'cadastrar_paciente "Maria": ok via lead (idClient 9, origem IA)',
  cadastroRecusado: 'cadastrar_paciente RECUSADO: a franquia não aceita 2026-11-03 09:00',
  remarcar: 'remarcar: recusado (sem_consulta)',
  confirmar: 'confirmar_presenca 55: confirmada',
};

test('sinaisDosPassos: pedir horário (TOOL_RESULT real) vira consultar_horarios — a regra "pediu horário = Quente" volta a disparar', () => {
  for (const title of [T.consultaCache, T.consultaFranquia]) {
    const s = sinaisDosPassos([{ kind: 'TOOL_RESULT', title }]);
    assert.deepEqual(s.ferramentas, ['consultar_horarios'], title);
    assert.equal(classificar({ mensagensDoPaciente: 2, ferramentasChamadas: s.ferramentas }).temperatura, 'Quente');
  }
});

test('sinaisDosPassos: agendar, cadastrar, remarcar e confirmar — em TOOL_RESULT ou ERROR', () => {
  assert.deepEqual(sinaisDosPassos([{ kind: 'ERROR', title: T.agendarRecusado }]).ferramentas, ['agendar_consulta']);
  assert.deepEqual(sinaisDosPassos([{ kind: 'ERROR', title: T.agendarFalhou }]).ferramentas, ['agendar_consulta']);
  assert.deepEqual(sinaisDosPassos([{ kind: 'TOOL_RESULT', title: T.cadastro }]).ferramentas, ['cadastrar_paciente']);
  assert.deepEqual(sinaisDosPassos([{ kind: 'ERROR', title: T.cadastroRecusado }]).ferramentas, ['cadastrar_paciente']);
  assert.deepEqual(sinaisDosPassos([{ kind: 'TOOL_RESULT', title: T.remarcar }]).ferramentas, ['remarcar_consulta']);
  assert.deepEqual(sinaisDosPassos([{ kind: 'TOOL_RESULT', title: T.confirmar }]).ferramentas, ['confirmar_presenca']);
});

test('sinaisDosPassos: "Consulta marcada" (IA ou widget) conta como marcação — ferramenta de agenda, não consulta viva', () => {
  for (const title of [T.marcada, T.marcadaWidget]) {
    const s = sinaisDosPassos([{ kind: 'TOOL_RESULT', title }]);
    assert.deepEqual(s.ferramentas, ['agendar_consulta'], title);
    // o passo é histórico: não diz "tem consulta marcada na franquia" (a consulta pode ter sido cancelada depois)
    assert.equal(classificar({ mensagensDoPaciente: 2, ferramentasChamadas: s.ferramentas }).porque.includes('franquia'), false);
  }
});

test('sinaisDosPassos: o prefixo termina onde deve — nome parecido não esquenta', () => {
  for (const title of ['agendar_consultas_antigas: x', 'Consulta marcada hoje? vou ver', 'remarcarX: y', 'consultar_horarios_v2 ok']) {
    assert.deepEqual(sinaisDosPassos([{ kind: 'TOOL_RESULT', title }]).ferramentas, [], title);
  }
});

test('sinaisDosPassos: a pausa da recepção não é intenção do paciente — não esquenta', () => {
  const s = sinaisDosPassos([
    { kind: 'TOOL_RESULT', title: T.consultaPausada },
    { kind: 'ERROR', title: T.agendarPausada },
  ]);
  assert.deepEqual(s.ferramentas, []);
});

test('sinaisDosPassos: o formato antigo "Decisão: x(" em TOOL_CALL continua valendo', () => {
  assert.deepEqual(sinaisDosPassos([{ kind: 'TOOL_CALL', title: 'Decisão: agendar_consulta(2026-11-03)' }]).ferramentas, [
    'agendar_consulta',
  ]);
});

test('sinaisDosPassos: o que não é de agenda não esquenta (nem por título parecido, nem por kind errado)', () => {
  const passos = [
    { kind: 'TOOL_CALL', title: 'Decisão: aplicar tag "x" no lead 1' },
    { kind: 'TOOL_CALL', title: 'Decisão: pausar IA no lead 1 (motivo)' },
    { kind: 'TOOL_RESULT', title: 'buscar_paciente "Maria": 0 resultado(s)' },
    { kind: 'TOOL_RESULT', title: 'cancelar_consulta 5: cancelada' },
    { kind: 'TOOL_RESULT', title: 'Paciente cadastrado na franquia sem consulta: Maria (idClient 9)' },
    { kind: 'THINKING', title: 'consultar_horarios 2026-11-03: 4 confirmado(s)' },
    { kind: 'ERROR', title: '🛡 agendar_consulta tentou marcar para o paciente 9 — este lead é do 8' },
  ];
  const s = sinaisDosPassos(passos);
  assert.deepEqual(s.ferramentas, []);
  assert.equal(classificar({ mensagensDoPaciente: 4, ferramentasChamadas: s.ferramentas }).temperatura, 'Morno');
});

test('sinaisDosPassos: sem repetição e na ordem em que aparecem', () => {
  const s = sinaisDosPassos([
    { kind: 'TOOL_RESULT', title: T.consultaCache },
    { kind: 'TOOL_RESULT', title: T.consultaFranquia },
    { kind: 'TOOL_RESULT', title: T.cadastro },
  ]);
  assert.deepEqual(s.ferramentas, ['consultar_horarios', 'cadastrar_paciente']);
});

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
