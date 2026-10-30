import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartaoExiste, consultaViva, montarAlvos, sinaisDoAlvo } from './preenche-campos-worker.js';
import { classificar } from './qualificacao-por-sinal.js';
import type { KommoLead } from '../services/kommo.service.js';

const temperaturaDe = (a: ReturnType<typeof montarAlvos>[number]) => classificar(sinaisDoAlvo(a)).temperatura;

test('montarAlvos: lead em AGENDADO que estava Morno vira Quente — pelo vínculo com a franquia', () => {
  // Timbó 30/10: 12 cartões em AGENDADO estavam Morno porque o worker nunca passava temConsultaMarcada.
  const [a] = montarAlvos([{ lead_id: '10', msgs: 6n }], [], [10]);
  assert.equal(a.temConsultaMarcada, true);
  assert.equal(temperaturaDe(a), 'Quente');
});

test('montarAlvos: o passo "Consulta marcada" esquenta (Quente), mas NÃO afirma consulta viva — o vínculo é que diz isso', () => {
  // consulta marcada e depois cancelada: o vínculo foi zerado, o passo antigo continua no histórico
  const [a] = montarAlvos(
    [{ lead_id: '10', msgs: 3n }],
    [{ kind: 'TOOL_RESULT', leadId: '10', title: 'Consulta marcada: 2026-11-03 09:00 (idSchedule 1)' }],
    [],
  );
  assert.equal(a.temConsultaMarcada, false);
  assert.deepEqual(a.ferramentas, ['agendar_consulta']);
  assert.equal(temperaturaDe(a), 'Quente');
  assert.doesNotMatch(classificar(sinaisDoAlvo(a)).porque, /consulta marcada na franquia/);
});

test('montarAlvos: pediu horário (TOOL_RESULT real) sem consulta marcada é Quente', () => {
  const [a] = montarAlvos(
    [{ lead_id: '11', msgs: 2n }],
    [{ leadId: '11', kind: 'TOOL_RESULT', title: 'consultar_horarios 2026-11-03: 4 confirmado(s) de 6 livre(s) na grade' }],
    [],
  );
  assert.equal(a.temConsultaMarcada, false);
  assert.equal(temperaturaDe(a), 'Quente');
});

test('montarAlvos: passos e vínculos de OUTRO lead não vazam', () => {
  const alvos = montarAlvos(
    [
      { lead_id: '20', msgs: 5n },
      { lead_id: '21', msgs: 1n },
    ],
    [{ leadId: '20', kind: 'TOOL_RESULT', title: 'consultar_horarios 2026-11-03: 4 confirmado(s)' }],
    [20],
  );
  const por = new Map(alvos.map((x) => [x.leadId, temperaturaDe(x)]));
  assert.equal(por.get(20), 'Quente');
  assert.equal(por.get(21), 'Frio');
});

test('montarAlvos: Morno e Frio continuam iguais — conversa sem sinal de agenda', () => {
  const alvos = montarAlvos(
    [
      { lead_id: '30', msgs: 5n }, // conversou
      { lead_id: '31', msgs: 1n }, // mandou uma e sumiu
      { lead_id: '32', msgs: 0n },
      { lead_id: '33', msgs: 4n }, // passos que não são de agenda
      { lead_id: '34', msgs: 3n }, // pausa da recepção
    ],
    [
      { leadId: '33', kind: 'TOOL_CALL', title: 'Decisão: aplicar tag "x" no lead 33' },
      { leadId: '33', kind: 'TOOL_RESULT', title: 'buscar_paciente "Ana": 1 achado(s), 1 com telefone batendo' },
      { leadId: '34', kind: 'TOOL_RESULT', title: 'consultar_horarios bloqueado — IA pausada pela recepção' },
    ],
    [],
  );
  assert.deepEqual(
    alvos.map((a) => [a.leadId, temperaturaDe(a)]),
    [
      [30, 'Morno'],
      [31, 'Frio'],
      [32, 'Frio'],
      [33, 'Morno'],
      [34, 'Morno'],
    ],
  );
});

test('montarAlvos: as mensagens do paciente chegam como vieram — 1 mensagem e vários passos é Frio, não Morno', () => {
  // ANTES: o LEFT JOIN LATERAL repetia cada mensagem uma vez por passo "Decisão", então 1 mensagem + 3 passos
  // chegava como msgs=3 e virava Morno. Agora a contagem não depende dos passos.
  const [a] = montarAlvos(
    [{ lead_id: '40', msgs: 1n }],
    [
      { leadId: '40', kind: 'TOOL_CALL', title: 'Decisão: aplicar tag "a" no lead 40' },
      { leadId: '40', kind: 'TOOL_CALL', title: 'Decisão: aplicar tag "b" no lead 40' },
      { leadId: '40', kind: 'TOOL_CALL', title: 'Decisão: aplicar tag "c" no lead 40' },
    ],
    [],
  );
  assert.equal(a.mensagensDoPaciente, 1);
  assert.equal(temperaturaDe(a), 'Frio');
});

test('sinaisDoAlvo: leva temConsultaMarcada ao classificador', () => {
  const s = sinaisDoAlvo({ leadId: 1, mensagensDoPaciente: 0, ferramentas: [], temConsultaMarcada: true });
  assert.equal(s.temConsultaMarcada, true);
  assert.equal(classificar(s).temperatura, 'Quente');
});

test('cartaoExiste: o 204 vazio do Kommo (cartão apagado ou juntado) não é um cartão com campos em branco', () => {
  // o axios entrega '' quando o Kommo responde 204 — era isso que virava "tudo vazio, vamos preencher"
  assert.equal(cartaoExiste(''), false);
  assert.equal(cartaoExiste(null), false);
  assert.equal(cartaoExiste(undefined), false);
  assert.equal(cartaoExiste({} as KommoLead), false);
  assert.equal(cartaoExiste({ id: 24703143, name: 'Maria', custom_fields_values: null } as unknown as KommoLead), true);
});

test('consultaViva: consulta por vir vale; a que já passou (NÃO COMPARECEU mantém o vínculo) não; sem data, vale', () => {
  const agora = '2026-11-03T15:00';
  assert.equal(consultaViva('2026-11-03T16:30', agora), true);
  assert.equal(consultaViva('2026-12-01T09:00', agora), true);
  assert.equal(consultaViva('2026-11-03T16:30:00', agora), true);
  assert.equal(consultaViva(null, agora), true);
  assert.equal(consultaViva(undefined, agora), true);
  // quem está na clínica agora, ou acabou de sair, não perde o sinal (folga de 4 h de `consultaNoPassado`)
  assert.equal(consultaViva('2026-11-03T15:00', agora), true);
  assert.equal(consultaViva('2026-11-03T14:40', agora), true);
  assert.equal(consultaViva('2026-11-03T11:30', agora), true);
  assert.equal(consultaViva('2026-11-03T10:30', agora), false);
  assert.equal(consultaViva('2026-10-30T09:00', agora), false);
});
