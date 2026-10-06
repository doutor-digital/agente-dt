import test from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import {
  confirmarNaFranquia,
  decidirConfirmacaoNaFranquia,
  textoAlertaConfirmacaoSemFranquia,
  type DepsConfirmarNaFranquia,
} from './confirmacao-d1.js';
import type { ConsultaReconciliada } from '../services/agenda-reconcile.service.js';
import { SPINE_STATUS } from '../services/spine.service.js';

/**
 * Caso que motivou (Açailândia, 06/10/2026, lead 28088906, agendamento 3738045): o paciente
 * respondeu "1" à véspera, o cartão virou "Confirmado", e o sincronizador voltou para "Agendado"
 * 8 minutos depois porque NA FRANQUIA ninguém tinha confirmado.
 */

const consulta = (over: Partial<ConsultaReconciliada> = {}): ConsultaReconciliada => ({
  idSchedule: 3738045,
  quando: '2026-10-07T13:00',
  salvo: '2026-10-07T13:00',
  estado: 'confirmada',
  mudou: false,
  especialista: null,
  idStatus: SPINE_STATUS.AGENDADO,
  ...over,
});

const unidade = (over: Partial<Unit> = {}): Unit =>
  ({ id: 'u1', slug: 'doutor-hernia-acailandia', spineEnabled: true, spineToken: 'tok', ...over }) as Unit;

function deps(over: Partial<DepsConfirmarNaFranquia> = {}) {
  const chamadas = { confirm: [] as number[], esquecidas: 0 };
  const d: DepsConfirmarNaFranquia = {
    confirmSchedule: async (_u, id) => {
      chamadas.confirm.push(id);
      return { ok: true };
    },
    perguntou: async () => true,
    esquecerConsulta: () => {
      chamadas.esquecidas++;
    },
    ...over,
  };
  return { d, chamadas };
}

function kommoFalso() {
  const tarefas: string[] = [];
  return {
    tarefas,
    kommo: {
      createTask: async (a: { text: string }) => {
        tarefas.push(a.text);
        return {} as never;
      },
    },
  };
}

// ── decisão pura ─────────────────────────────────────────────────────────────────────────────

test('decisão: consulta AGENDADA que foi perguntada → confirma na franquia', () => {
  const d = decidirConfirmacaoNaFranquia({ franquiaLigada: true, consulta: consulta(), perguntouEstaConsulta: true });
  assert.deepEqual(d, { acao: 'confirmar', idSchedule: 3738045 });
});

test('decisão: status desconhecido (franquia não mandou) mas consulta achada → confirma', () => {
  const d = decidirConfirmacaoNaFranquia({
    franquiaLigada: true,
    consulta: consulta({ idStatus: null }),
    perguntouEstaConsulta: true,
  });
  assert.equal(d.acao, 'confirmar');
});

test('decisão: unidade sem franquia não chama nada e não avisa', () => {
  const d = decidirConfirmacaoNaFranquia({ franquiaLigada: false, consulta: consulta(), perguntouEstaConsulta: true });
  assert.deepEqual(d, { acao: 'pular', motivo: 'sem_franquia', avisarEquipe: false });
});

test('decisão: já CONFIRMADO na franquia → não chama de novo', () => {
  const d = decidirConfirmacaoNaFranquia({
    franquiaLigada: true,
    consulta: consulta({ idStatus: SPINE_STATUS.CONFIRMADO }),
    perguntouEstaConsulta: true,
  });
  assert.deepEqual(d, { acao: 'pular', motivo: 'ja_confirmada', avisarEquipe: false });
});

test('decisão: ATENDIDO, DESMARCADO, falta ou REMARCADO nunca viram confirmado', () => {
  for (const idStatus of [
    SPINE_STATUS.ATENDIDO,
    SPINE_STATUS.DESMARCADO,
    SPINE_STATUS.NAO_COMPARECEU,
    SPINE_STATUS.REMARCADO,
  ]) {
    const d = decidirConfirmacaoNaFranquia({ franquiaLigada: true, consulta: consulta({ idStatus }), perguntouEstaConsulta: true });
    assert.equal(d.acao, 'pular', String(idStatus));
    assert.equal(d.acao === 'pular' && d.motivo, 'encerrada', String(idStatus));
  }
  const cancelada = decidirConfirmacaoNaFranquia({
    franquiaLigada: true,
    consulta: consulta({ estado: 'cancelada', quando: null }),
    perguntouEstaConsulta: false,
  });
  assert.equal(cancelada.acao === 'pular' && cancelada.motivo, 'encerrada');
});

test('decisão: franquia não devolveu a consulta agora → não confirma e avisa a equipe', () => {
  const d = decidirConfirmacaoNaFranquia({
    franquiaLigada: true,
    consulta: consulta({ estado: 'nao_confirmada' }),
    perguntouEstaConsulta: true,
  });
  assert.deepEqual(d, { acao: 'pular', motivo: 'nao_verificada', avisarEquipe: true });
});

test('decisão: remarcaram entre a pergunta e a resposta → não confirma o horário que ninguém perguntou', () => {
  const d = decidirConfirmacaoNaFranquia({ franquiaLigada: true, consulta: consulta(), perguntouEstaConsulta: false });
  assert.deepEqual(d, { acao: 'pular', motivo: 'outra_consulta', avisarEquipe: true });
});

test('decisão: sem consulta → avisa a equipe', () => {
  const d = decidirConfirmacaoNaFranquia({ franquiaLigada: true, consulta: null, perguntouEstaConsulta: false });
  assert.deepEqual(d, { acao: 'pular', motivo: 'sem_consulta', avisarEquipe: true });
});

// ── efeito: chama a franquia, avisa na falha, nunca lança ─────────────────────────────────────

test('confirmarNaFranquia: confirma o idSchedule certo e limpa o cache da consulta', async () => {
  const { d, chamadas } = deps();
  const { kommo, tarefas } = kommoFalso();
  const r = await confirmarNaFranquia({ unit: unidade(), leadId: 28088906, consulta: consulta(), contactName: 'João', kommo }, d);
  assert.equal(r, 'confirmada');
  assert.deepEqual(chamadas.confirm, [3738045]);
  assert.equal(chamadas.esquecidas, 1);
  assert.equal(tarefas.length, 0);
});

test('confirmarNaFranquia: pergunta pela consulta do horário confirmado', async () => {
  let visto: string | null = null;
  const { d } = deps({
    perguntou: async (_u, _l, quando) => {
      visto = quando;
      return true;
    },
  });
  const { kommo } = kommoFalso();
  await confirmarNaFranquia({ unit: unidade(), leadId: 1, consulta: consulta(), contactName: null, kommo }, d);
  assert.equal(visto, '2026-10-07T13:00');
});

test('confirmarNaFranquia: franquia recusou → devolve "falhou" e abre ALERTA para a equipe', async () => {
  const { d, chamadas } = deps({ confirmSchedule: async () => ({ ok: false, error: 'HTTP 500' }) });
  const { kommo, tarefas } = kommoFalso();
  const r = await confirmarNaFranquia({ unit: unidade(), leadId: 1, consulta: consulta(), contactName: 'João De Deus', kommo }, d);
  assert.equal(r, 'falhou');
  assert.equal(chamadas.esquecidas, 0);
  assert.equal(tarefas.length, 1);
  assert.match(tarefas[0], /^ALERTA · doutor-hernia-acailandia · \[Contato: João De Deus\]/);
  assert.match(tarefas[0], /HTTP 500/);
  assert.match(tarefas[0], /3738045/);
});

test('confirmarNaFranquia: exceção na franquia não escapa (a resposta ao paciente não pode cair)', async () => {
  const { d } = deps({
    confirmSchedule: async () => {
      throw new Error('socket hang up');
    },
  });
  const { kommo, tarefas } = kommoFalso();
  const r = await confirmarNaFranquia({ unit: unidade(), leadId: 1, consulta: consulta(), contactName: null, kommo }, d);
  assert.equal(r, 'falhou');
  assert.equal(tarefas.length, 1);
});

test('confirmarNaFranquia: falha ao criar a tarefa de alerta também não escapa', async () => {
  const { d } = deps({ confirmSchedule: async () => ({ ok: false, error: 'x' }) });
  const kommo = {
    createTask: async () => {
      throw new Error('kommo fora');
    },
  };
  const r = await confirmarNaFranquia({ unit: unidade(), leadId: 1, consulta: consulta(), contactName: null, kommo }, d);
  assert.equal(r, 'falhou');
});

test('confirmarNaFranquia: unidade sem franquia não chama a franquia nem abre tarefa', async () => {
  const { d, chamadas } = deps();
  const { kommo, tarefas } = kommoFalso();
  const r = await confirmarNaFranquia(
    { unit: unidade({ spineEnabled: false }), leadId: 1, consulta: consulta(), contactName: null, kommo },
    d,
  );
  assert.equal(r, 'sem_franquia');
  assert.equal(chamadas.confirm.length, 0);
  assert.equal(tarefas.length, 0);

  const semToken = await confirmarNaFranquia(
    { unit: unidade({ spineToken: null }), leadId: 1, consulta: consulta(), contactName: null, kommo },
    d,
  );
  assert.equal(semToken, 'sem_franquia');
});

test('confirmarNaFranquia: consulta ATENDIDA não é confirmada e não gera tarefa', async () => {
  const { d, chamadas } = deps();
  const { kommo, tarefas } = kommoFalso();
  const r = await confirmarNaFranquia(
    { unit: unidade(), leadId: 1, consulta: consulta({ idStatus: SPINE_STATUS.ATENDIDO }), contactName: null, kommo },
    d,
  );
  assert.equal(r, 'encerrada');
  assert.equal(chamadas.confirm.length, 0);
  assert.equal(tarefas.length, 0);
});

test('confirmarNaFranquia: horário não perguntado → não confirma e avisa', async () => {
  const { d, chamadas } = deps({ perguntou: async () => false });
  const { kommo, tarefas } = kommoFalso();
  const r = await confirmarNaFranquia({ unit: unidade(), leadId: 1, consulta: consulta(), contactName: null, kommo }, d);
  assert.equal(r, 'outra_consulta');
  assert.equal(chamadas.confirm.length, 0);
  assert.equal(tarefas.length, 1);
});

test('textoAlertaConfirmacaoSemFranquia: diz dia, hora, agendamento e o risco do sincronizador', () => {
  const t = textoAlertaConfirmacaoSemFranquia({
    slug: 'doutor-hernia-acailandia',
    nome: 'João',
    quando: '2026-10-07T13:00',
    idSchedule: 3738045,
    motivo: 'erro da franquia',
  });
  assert.match(t, /quarta, 07\/10 às 13:00/);
  assert.match(t, /agendamento 3738045/);
  assert.match(t, /sincronizador/);
});
