import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Conversation, Unit } from '@prisma/client';

import { retomarTurnoPerdido, type DepsRetomada } from './webhook.controller.js';
import type { TurnoPerdido } from '../lib/recuperar-turnos.js';

/**
 * `retomarTurnoPerdido` refaz UM pedido que o deploy matou (lib/recuperar-turnos.ts decide SE refaz; aqui é o COMO).
 * Sem banco e sem Kommo: as dependências são trocadas; o coalescer e o processAgent não rodam de verdade.
 */

const UNIT = { id: 'u2', slug: 'timbo-resgate', isActive: true } as unknown as Unit;
const CRIADO = new Date('2026-10-30T20:01:05Z');

const webhook = (texto: string, extra: Record<string, unknown> = {}) => ({
  account: { id: 1 },
  message: { add: [{ id: 'm1', chat_id: 'c1', talk_id: '9', contact_id: '5', text: texto, type: 'incoming', author: { id: 'a1', name: 'Ana' }, ...extra }] },
});

const turno = (input: unknown, extra: Partial<TurnoPerdido> = {}): TurnoPerdido => ({
  traceId: 'trace-1',
  unitId: 'u1', // a GRAVADA: a que decide é a que vem por parâmetro
  leadId: '5142896',
  criadoEm: CRIADO,
  input,
  ...extra,
});

function mundo(opts: { conv?: Partial<Conversation> | null; anteriores?: Array<{ role: string; content: string; createdAt: Date }>; status?: 'started' | 'joined' | 'rejected' } = {}) {
  const w = {
    registrados: [] as string[],
    agendados: [] as Array<Parameters<DepsRetomada['agendar']>[0]>,
    processados: [] as Array<Parameters<DepsRetomada['processar']>[0]>,
  };
  const deps: DepsRetomada = {
    conversa: async () => (opts.conv === null ? null : ({ id: 'conv-1', ...opts.conv } as Conversation)),
    anteriores: async () => opts.anteriores ?? [],
    registrar: async (t) => {
      w.registrados.push(t.traceId);
    },
    agendar: (args) => {
      w.agendados.push(args);
      return opts.status ?? 'started';
    },
    processar: async (args) => {
      w.processados.push(args);
    },
  };
  return { w, deps };
}

test('pedido normal: volta para o coalescer na unidade DONA, marcado como retomada, na hora em que chegou', async () => {
  const { w, deps } = mundo({ conv: null });
  const r = await retomarTurnoPerdido(turno(webhook('Bom dia, queria marcar')), UNIT, deps);
  assert.equal(r, 'retomado');
  assert.equal(w.agendados.length, 1);
  const a = w.agendados[0]!;
  assert.equal(a.unitSlug, 'timbo-resgate', 'a unidade dona, não a gravada no trace');
  assert.equal(a.leadId, 5142896);
  assert.equal(a.traceId, 'trace-1');
  assert.equal(a.humanMessage, 'Bom dia, queria marcar');
  assert.deepEqual(a.retomada, { chegouEm: CRIADO.getTime() });
  assert.deepEqual(w.registrados, ['trace-1']);
});

test('o turno que o coalescer roda é marcado como retomada (não mexe na etapa) e usa a unidade dona', async () => {
  const { w, deps } = mundo({ conv: null });
  await retomarTurnoPerdido(turno(webhook('oi')), UNIT, deps);
  await w.agendados[0]!.run('oi', [], [], ['trace-1']);
  assert.equal(w.processados.length, 1);
  assert.equal(w.processados[0]!.retomada, true);
  assert.equal(w.processados[0]!.unit.id, 'u2');
  assert.equal(w.processados[0]!.traceId, 'trace-1');
});

test('unidade inativa ou lead inválido: não agenda, não registra', async () => {
  const { w, deps } = mundo();
  assert.equal(await retomarTurnoPerdido(turno(webhook('oi')), { ...UNIT, isActive: false } as Unit, deps), 'descartado:unidade_inativa');
  assert.equal(await retomarTurnoPerdido(turno(webhook('oi'), { leadId: 'abc' }), UNIT, deps), 'descartado:lead_invalido');
  assert.equal(await retomarTurnoPerdido(turno(webhook('oi'), { leadId: '0' }), UNIT, deps), 'descartado:lead_invalido');
  assert.equal(w.agendados.length + w.registrados.length, 0);
});

test('o que não é mensagem de paciente do Kommo (widget, sem texto, saída) não volta para a IA', async () => {
  const { w, deps } = mundo();
  assert.equal(await retomarTurnoPerdido(turno({ leadId: 1, text: 'teste do widget' }), UNIT, deps), 'descartado:nao_e_mensagem_do_kommo');
  assert.equal(await retomarTurnoPerdido(turno(null), UNIT, deps), 'descartado:nao_e_mensagem_do_kommo');
  assert.equal(await retomarTurnoPerdido(turno(webhook('olá', { type: 'outgoing' })), UNIT, deps), 'descartado:nao_e_mensagem_do_kommo');
  assert.equal(w.agendados.length, 0);
});

test('"sim"/"1" que pode ser resposta à confirmação de véspera: TAREFA, a IA não responde', async () => {
  const { w, deps } = mundo({ conv: { confirmacaoD1EnviadaEm: new Date(CRIADO.getTime() - 3600_000), confirmacaoD1Resposta: null } });
  const r = await retomarTurnoPerdido(turno(webhook('sim')), UNIT, deps);
  assert.equal(r, 'tarefa:pode_ser_resposta_a_lembrete');
  assert.equal(w.agendados.length, 0);
  assert.equal(w.registrados.length, 0);
});

test('a janela da véspera conta a partir de quando o pedido CHEGOU, não de agora', async () => {
  // Enviada há 3 dias da chegada: já não é resposta de véspera, então "sim" segue para a IA.
  const { deps } = mundo({ conv: { confirmacaoD1EnviadaEm: new Date(CRIADO.getTime() - 3 * 86_400_000), confirmacaoD1Resposta: null } });
  assert.equal(await retomarTurnoPerdido(turno(webhook('sim')), UNIT, deps), 'retomado');
});

test('encerramento repetido ("obrigada" de novo, a IA já se despediu): descartado', async () => {
  const { w, deps } = mundo({
    conv: {},
    anteriores: [
      { role: 'user', content: 'Ok obrigada', createdAt: new Date(CRIADO.getTime() - 120_000) },
      { role: 'assistant', content: 'Por nada! Qualquer dúvida é só chamar.', createdAt: new Date(CRIADO.getTime() - 100_000) },
    ],
  });
  assert.equal(await retomarTurnoPerdido(turno(webhook('obrigada 🙏')), UNIT, deps), 'descartado:encerramento_repetido');
  assert.equal(w.agendados.length, 0);
});

test('burst cheio: descartado (nada de turno paralelo sobre o mesmo paciente)', async () => {
  const { deps } = mundo({ conv: null, status: 'rejected' });
  assert.equal(await retomarTurnoPerdido(turno(webhook('oi')), UNIT, deps), 'descartado:burst_cheio');
});
