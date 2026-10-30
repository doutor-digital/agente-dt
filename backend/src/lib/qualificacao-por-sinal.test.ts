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
import { readFileSync } from 'node:fs';
import { classificar, PREFIXOS_DE_PASSO, sinaisDosPassos } from './qualificacao-por-sinal.js';

// Títulos COPIADOS de agenda-tools.ts / marcacao-widget.ts: é assim que os passos são gravados em produção.
// O worker procurava 'Decisão: x(' em TOOL_CALL — 0 passos assim para a agenda em todo o banco.
const T = {
  consultaCache: 'consultar_horarios 2026-11-03 (manhã): 4 confirmado(s) — do cache (franquia consultada há 3 min)',
  consultaFranquia: 'consultar_horarios 2026-11-03: 0 confirmado(s) de 2 livre(s) na grade',
  consultaPausada: 'consultar_horarios bloqueado — IA pausada pela recepção',
  agendarPausada: 'agendar_consulta recusado — IA pausada pela recepção',
  agendarFalhou: 'agendar_consulta falhou: timeout',
  marcada: 'Consulta marcada: 2026-11-03 09:00 (idSchedule 123)',
  marcadaWidget: 'Consulta marcada na franquia: 2026-11-03 09:00 (idSchedule 123)',
  cadastro: 'cadastrar_paciente "Maria": ok via lead (idClient 9, origem IA)',
  remarcar: 'remarcar: trocada (antiga 55)',
  confirmar: 'confirmar_presenca 55: confirmada',
};

/**
 * Cada título que agenda-tools.ts grava com o nome de uma ferramenta de agenda, COPIADO do código, e se ele prova
 * que o paciente ESCOLHEU (esquenta) ou não (a IA só tentou). `fonte` é o trecho exato no código: se alguém mudar
 * o texto, o teste de contrato (abaixo) falha; se alguém criar um título novo, o teste de cobertura falha até ele
 * ser classificado aqui — recusa nova não vira Quente por padrão.
 */
const TITULOS: Array<{ fonte: string; exemplo: string; kind: 'TOOL_RESULT' | 'ERROR'; esquenta: boolean; ferramenta?: string }> = [
  // --- consultar_horarios
  { fonte: 'consultar_horarios ${cursor}${turno ? ', exemplo: T.consultaCache, kind: 'TOOL_RESULT', esquenta: true, ferramenta: 'consultar_horarios' },
  { fonte: 'consultar_horarios bloqueado — IA pausada pela recepção', exemplo: T.consultaPausada, kind: 'TOOL_RESULT', esquenta: false },
  // --- agendar_consulta: recusas SEM escolha do paciente ou por idClient errado NÃO esquentam
  { fonte: 'agendar_consulta recusado — faltou confirmar o dia', exemplo: 'agendar_consulta recusado — faltou confirmar o dia', kind: 'ERROR', esquenta: false },
  { fonte: 'agendar_consulta recusado — faltou confirmar o dia ou a forma de pagamento', exemplo: 'agendar_consulta recusado — faltou confirmar o dia ou a forma de pagamento', kind: 'ERROR', esquenta: false },
  { fonte: 'agendar_consulta recusado — IA pausada pela recepção', exemplo: T.agendarPausada, kind: 'ERROR', esquenta: false },
  { fonte: 'agendar_consulta recusado — idClient ${args.idClient} não existe', exemplo: 'agendar_consulta recusado — idClient 123 não existe', kind: 'ERROR', esquenta: false },
  { fonte: 'agendar_consulta recusado — idClient ${args.idClient} é de outra pessoa', exemplo: 'agendar_consulta recusado — idClient 123 é de outra pessoa', kind: 'ERROR', esquenta: false },
  // --- agendar_consulta: houve escolha (dia confirmado, horário pedido)
  { fonte: 'agendar_consulta recusado — ${args.hora} está ${slot.status}', exemplo: 'agendar_consulta recusado — 09:00 está ocupado', kind: 'ERROR', esquenta: true, ferramenta: 'agendar_consulta' },
  { fonte: 'agendar_consulta recusado — já tem consulta na clínica em ${quando}', exemplo: 'agendar_consulta recusado — já tem consulta na clínica em 2026-11-03T09:00 (Agendado)', kind: 'ERROR', esquenta: true, ferramenta: 'agendar_consulta' },
  { fonte: 'agendar_consulta falhou: ${r.error}', exemplo: T.agendarFalhou, kind: 'ERROR', esquenta: true, ferramenta: 'agendar_consulta' },
  { fonte: 'agendar_consulta: possível cadastro em dobro (idClient ', exemplo: 'agendar_consulta: possível cadastro em dobro (idClient 7, 8) — nome parecido, não igual; nada foi vinculado', kind: 'ERROR', esquenta: true, ferramenta: 'agendar_consulta' },
  { fonte: 'agendar_consulta: ${args.hora} ocupado por um possível cadastro em dobro', exemplo: 'agendar_consulta: 09:00 ocupado por um possível cadastro em dobro do paciente (idClient 7) — não ofereci outro horário', kind: 'ERROR', esquenta: true, ferramenta: 'agendar_consulta' },
  { fonte: 'agendar_consulta: ${args.hora} ocupado e não consegui conferir', exemplo: 'agendar_consulta: 09:00 ocupado e não consegui conferir os cadastros do paciente — não ofereci outro horário', kind: 'ERROR', esquenta: true, ferramenta: 'agendar_consulta' },
  { fonte: 'Consulta marcada: ${args.data} ${args.hora}', exemplo: T.marcada, kind: 'TOOL_RESULT', esquenta: true, ferramenta: 'agendar_consulta' },
  // --- cadastrar_paciente: recusas de ANTES da escolha do horário NÃO esquentam
  { fonte: 'cadastrar_paciente RECUSADO: ${quando.motivo}', exemplo: 'cadastrar_paciente RECUSADO: não veio o horário escolhido pelo paciente.', kind: 'TOOL_RESULT', esquenta: false },
  { fonte: 'cadastrar_paciente RECUSADO: ${quando.motivo}', exemplo: 'cadastrar_paciente RECUSADO: "amanhã de manhã" não é um horário concreto (esperado AAAA-MM-DD HH:MM).', kind: 'TOOL_RESULT', esquenta: false },
  { fonte: 'cadastrar_paciente RECUSADO: ${quando.motivo}', exemplo: 'cadastrar_paciente RECUSADO: "2026-13-45 10:00" não é uma data válida.', kind: 'TOOL_RESULT', esquenta: false },
  { fonte: 'cadastrar_paciente RECUSADO: ${quando.motivo}', exemplo: 'cadastrar_paciente RECUSADO: 2026-10-01 10:00 já passou.', kind: 'TOOL_RESULT', esquenta: false },
  // --- cadastrar_paciente: horário escolhido e válido
  { fonte: 'cadastrar_paciente RECUSADO: a franquia não aceita ${diaEscolhido} ${horaEscolhida}', exemplo: 'cadastrar_paciente RECUSADO: a franquia não aceita 2026-11-03 09:00', kind: 'TOOL_RESULT', esquenta: true, ferramenta: 'cadastrar_paciente' },
  { fonte: 'cadastrar_paciente RECUSADO: ${motivo}', exemplo: 'cadastrar_paciente RECUSADO: o telefone (ou o cartão) é de outro paciente da clínica, com outro nome (idClient 4)', kind: 'TOOL_RESULT', esquenta: true, ferramenta: 'cadastrar_paciente' },
  { fonte: 'cadastrar_paciente RECUSADO: ${motivo}', exemplo: 'cadastrar_paciente RECUSADO: o telefone é de mais de um paciente da clínica', kind: 'TOOL_RESULT', esquenta: true, ferramenta: 'cadastrar_paciente' },
  { fonte: 'cadastrar_paciente: já existia (${existente.idClient}, achado por ${existente.por})', exemplo: 'cadastrar_paciente: já existia (9, achado por telefone)', kind: 'TOOL_RESULT', esquenta: true, ferramenta: 'cadastrar_paciente' },
  { fonte: 'cadastrar_paciente: já existia (${igual.idClient})', exemplo: 'cadastrar_paciente: já existia (9)', kind: 'TOOL_RESULT', esquenta: true, ferramenta: 'cadastrar_paciente' },
  { fonte: 'cadastrar_paciente "${args.nome}": falhou', exemplo: 'cadastrar_paciente "Maria Souza": falhou', kind: 'TOOL_RESULT', esquenta: true, ferramenta: 'cadastrar_paciente' },
  { fonte: 'cadastrar_paciente "${args.nome}": ok via', exemplo: T.cadastro, kind: 'TOOL_RESULT', esquenta: true, ferramenta: 'cadastrar_paciente' },
  // --- confirmar_presenca / remarcar
  { fonte: 'confirmar_presenca ${atual.idSchedule}: ', exemplo: T.confirmar, kind: 'TOOL_RESULT', esquenta: true, ferramenta: 'confirmar_presenca' },
  { fonte: 'remarcar: recusado (${alvo.tipo})', exemplo: 'remarcar: recusado (sem_consulta)', kind: 'TOOL_RESULT', esquenta: false },
  { fonte: 'remarcar: ${desfecho.tipo} (antiga ${alvo.idSchedule})', exemplo: T.remarcar, kind: 'TOOL_RESULT', esquenta: true, ferramenta: 'remarcar_consulta' },
  { fonte: 'remarcar: ${desfecho.tipo} (antiga ${alvo.idSchedule})', exemplo: 'remarcar: vaga_presa (antiga 55)', kind: 'ERROR', esquenta: true, ferramenta: 'remarcar_consulta' },
];

test('sinaisDosPassos: pedir horário (TOOL_RESULT real) vira consultar_horarios — a regra "pediu horário = Quente" volta a disparar', () => {
  for (const title of [T.consultaCache, T.consultaFranquia]) {
    const s = sinaisDosPassos([{ kind: 'TOOL_RESULT', title }]);
    assert.deepEqual(s.ferramentas, ['consultar_horarios'], title);
    assert.equal(classificar({ mensagensDoPaciente: 2, ferramentasChamadas: s.ferramentas }).temperatura, 'Quente');
  }
});

test('sinaisDosPassos: agendar, cadastrar, remarcar e confirmar — em TOOL_RESULT ou ERROR', () => {
  assert.deepEqual(sinaisDosPassos([{ kind: 'ERROR', title: T.agendarFalhou }]).ferramentas, ['agendar_consulta']);
  assert.deepEqual(sinaisDosPassos([{ kind: 'TOOL_RESULT', title: T.cadastro }]).ferramentas, ['cadastrar_paciente']);
  assert.deepEqual(sinaisDosPassos([{ kind: 'TOOL_RESULT', title: T.remarcar }]).ferramentas, ['remarcar_consulta']);
  assert.deepEqual(sinaisDosPassos([{ kind: 'TOOL_RESULT', title: T.confirmar }]).ferramentas, ['confirmar_presenca']);
});

test('falso Quente (#178): lead de 1 mensagem cujo ÚNICO passo é recusa por falta de escolha/idClient errado continua Frio', () => {
  for (const t of TITULOS.filter((x) => !x.esquenta)) {
    const s = sinaisDosPassos([{ kind: t.kind, title: t.exemplo }]);
    assert.deepEqual(s.ferramentas, [], `"${t.exemplo}" não prova escolha do paciente`);
    assert.equal(classificar({ mensagensDoPaciente: 1, ferramentasChamadas: s.ferramentas }).temperatura, 'Frio', t.exemplo);
    assert.equal(classificar({ mensagensDoPaciente: 4, ferramentasChamadas: s.ferramentas }).temperatura, 'Morno', t.exemplo);
  }
});

test('cada título em que houve escolha do paciente esquenta — e para a ferramenta certa', () => {
  for (const t of TITULOS.filter((x) => x.esquenta)) {
    const s = sinaisDosPassos([{ kind: t.kind, title: t.exemplo }]);
    assert.deepEqual(s.ferramentas, [t.ferramenta], t.exemplo);
    assert.equal(classificar({ mensagensDoPaciente: 1, ferramentasChamadas: s.ferramentas }).temperatura, 'Quente', t.exemplo);
  }
});

test('recusa NOVA (título que ninguém classificou) não esquenta por padrão', () => {
  for (const title of [
    'agendar_consulta recusado — motivo que ainda não existe',
    'agendar_consulta recusado — 9h está ocupado',
    'agendar_consulta algo novo',
    'cadastrar_paciente RECUSADO: motivo novo',
    'cadastrar_paciente motivo novo',
    'remarcar: recusado (novo_tipo)',
    'remarcar: novo_desfecho (antiga 1)',
    'confirmar_presenca sem número',
    'consultar_horarios sem data',
    'consultar_horarios bloqueado — motivo novo',
  ]) {
    for (const kind of ['TOOL_RESULT', 'ERROR']) {
      assert.deepEqual(sinaisDosPassos([{ kind, title }]).ferramentas, [], `${kind} "${title}"`);
    }
  }
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

test('sinaisDosPassos: "Decisão: x(" em TOOL_CALL não esquenta — é o registro da chamada, não de uma escolha (e a agenda nunca o gravou)', () => {
  assert.deepEqual(sinaisDosPassos([{ kind: 'TOOL_CALL', title: 'Decisão: agendar_consulta(2026-11-03)' }]).ferramentas, []);
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

const agenda = readFileSync(new URL('../agent/agenda-tools.ts', import.meta.url), 'utf8');
const widget = readFileSync(new URL('./marcacao-widget.ts', import.meta.url), 'utf8');

test('contrato: os títulos que a régua lê ainda são os que a agenda grava (se alguém mudar o texto, este teste avisa)', () => {
  // A régua casa pelo começo do título (não há campo estruturado). Se agenda-tools.ts ou marcacao-widget.ts passarem a
  // gravar outro texto, "pediu horário = Quente" volta a nunca disparar — sem erro, sem alerta. Este teste é o alerta.
  for (const t of TITULOS) assert.ok(agenda.includes(t.fonte), `agenda-tools.ts não grava mais "${t.fonte}"`);
  assert.ok(agenda.includes('IA pausada pela recepção'));
  assert.ok(widget.includes('`Consulta marcada na franquia: '), 'marcacao-widget.ts não grava mais "Consulta marcada na franquia: "');
  assert.deepEqual(sinaisDosPassos([{ kind: 'TOOL_RESULT', title: T.marcadaWidget }]).ferramentas, ['agendar_consulta']);
  // e o filtro do banco cobre todos os prefixos que a régua reconhece
  for (const t of TITULOS.filter((x) => x.esquenta)) {
    assert.ok(PREFIXOS_DE_PASSO.some((p) => t.exemplo.startsWith(p)), `o filtro do banco não traz "${t.exemplo}"`);
  }
  for (const p of ['Consulta marcada:', 'Consulta marcada na franquia:']) assert.ok(PREFIXOS_DE_PASSO.includes(p), p);
  // o formato antigo "Decisão: x(" saiu
  assert.ok(!PREFIXOS_DE_PASSO.some((p) => p.startsWith('Decisão')));
});

test('cobertura: todo título de agenda que o código grava está classificado em TITULOS (título novo falha aqui até alguém decidir se esquenta)', () => {
  // Para cada `title:` de agenda-tools.ts, pega os literais que começam com o nome de uma ferramenta de agenda.
  const gravados = new Set<string>();
  for (const m of agenda.matchAll(/title:/g)) {
    const janela = agenda.slice((m.index ?? 0) + 6, (m.index ?? 0) + 6 + 260);
    for (const l of janela.matchAll(/[`']((?:consultar_horarios|agendar_consulta|cadastrar_paciente|confirmar_presenca|remarcar:|Consulta marcada)[^`'\n]*)/g)) {
      gravados.add(l[1]);
    }
  }
  assert.ok(gravados.size >= 20, `a extração dos títulos parou de funcionar (achou ${gravados.size})`);
  const semClasse = [...gravados].filter((g) => !TITULOS.some((t) => t.fonte.startsWith(g) || g.startsWith(t.fonte) || t.fonte === g));
  assert.deepEqual(semClasse, [], 'título de agenda gravado e não classificado em TITULOS');
});
