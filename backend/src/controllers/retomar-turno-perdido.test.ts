import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Conversation, Unit } from '@prisma/client';

import { retomarTurnoPerdido, unidadeDonaDoTurno, resumoDoPedido, TEXTO_PEDIDO_ILEGIVEL, type DepsRetomada } from './webhook.controller.js';
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

test('pedido do modo widget (trace com input widget_request): NÃO volta para a IA e NÃO é descartado — vira TAREFA', async () => {
  const { w, deps } = mundo();
  const widget = { message: 'quero marcar uma consulta', return_url: 'https://amojo.kommo.com/x', via: 'widget_request' };
  assert.equal(await retomarTurnoPerdido(turno(widget), UNIT, deps), 'tarefa:pedido_via_widget');
  assert.equal(w.agendados.length + w.registrados.length, 0);
});

test('o que não é mensagem de paciente do Kommo (formato desconhecido, sem texto, saída) não volta para a IA e vira TAREFA, nunca descarte mudo', async () => {
  const { w, deps } = mundo();
  assert.equal(await retomarTurnoPerdido(turno({ leadId: 1, text: 'teste' }), UNIT, deps), 'tarefa:pedido_nao_reconhecido');
  assert.equal(await retomarTurnoPerdido(turno(null), UNIT, deps), 'tarefa:pedido_nao_reconhecido');
  assert.equal(await retomarTurnoPerdido(turno(webhook('olá', { type: 'outgoing' })), UNIT, deps), 'tarefa:pedido_nao_reconhecido');
  assert.equal(w.agendados.length, 0);
});

test('resumoDoPedido: webhook leva contato e texto; widget leva o texto de `message` para a recepção ler; o resto, vazio', () => {
  assert.deepEqual(resumoDoPedido(turno(webhook('Bom dia'))), { contato: 'Ana', texto: 'Bom dia' });
  assert.deepEqual(resumoDoPedido(turno({ message: 'quero marcar', via: 'widget_request' })), { contato: null, texto: 'quero marcar' });
  // sem o texto do pedido a tarefa não afirma "áudio, imagem ou figurinha": manda abrir a conversa
  assert.deepEqual(resumoDoPedido(turno({ via: 'widget_request' })), { contato: null, texto: TEXTO_PEDIDO_ILEGIVEL });
  assert.deepEqual(resumoDoPedido(turno({ via: 'widget_request', message: '   ' })), { contato: null, texto: TEXTO_PEDIDO_ILEGIVEL });
  assert.deepEqual(resumoDoPedido(turno(null)), { contato: null, texto: TEXTO_PEDIDO_ILEGIVEL });
  assert.deepEqual(resumoDoPedido(turno({ leadId: 1 })), { contato: null, texto: TEXTO_PEDIDO_ILEGIVEL });
});

// ── a unidade DONA: refeita pela etapa do cartão, não a gravada no trace ───────────────────────────────

function donaDeps(opts: { gravada: Unit | null; dona?: Unit }) {
  const w = { buscouGravada: [] as string[], resolveu: [] as Array<[string, number]> };
  return {
    w,
    deps: {
      unidadeGravada: async (id: string) => {
        w.buscouGravada.push(id);
        return opts.gravada;
      },
      donaPelaEtapa: async (gravada: Unit, leadId: number) => {
        w.resolveu.push([gravada.id, leadId]);
        return opts.dona ?? gravada;
      },
    },
  };
}
const COMERCIAL = { id: 'u1', slug: 'timbo', isActive: true } as unknown as Unit;
const RESGATE = { id: 'u2', slug: 'timbo-resgate', isActive: true } as unknown as Unit;

test('unidadeDonaDoTurno: o cartão mudou de funil — vale a unidade da ETAPA de agora, não a gravada no trace', async () => {
  const { w, deps } = donaDeps({ gravada: COMERCIAL, dona: RESGATE });
  const dona = await unidadeDonaDoTurno(turno(webhook('oi')), deps);
  assert.equal(dona?.id, 'u2');
  assert.deepEqual(w.buscouGravada, ['u1']);
  assert.deepEqual(w.resolveu, [['u1', 5142896]], 'a etapa é resolvida a partir da gravada, para o lead do pedido');
});

test('unidadeDonaDoTurno: unidade gravada inexistente ou inativa, dona inativa e lead inválido → null (fecha sem tarefa)', async () => {
  assert.equal(await unidadeDonaDoTurno(turno(webhook('oi')), donaDeps({ gravada: null }).deps), null);
  assert.equal(await unidadeDonaDoTurno(turno(webhook('oi')), donaDeps({ gravada: { ...COMERCIAL, isActive: false } as Unit, dona: RESGATE }).deps), null, 'gravada inativa não é salva por uma dona ativa');
  assert.equal(await unidadeDonaDoTurno(turno(webhook('oi')), donaDeps({ gravada: COMERCIAL, dona: { ...RESGATE, isActive: false } as Unit }).deps), null);
  const lead = donaDeps({ gravada: COMERCIAL });
  assert.equal(await unidadeDonaDoTurno(turno(webhook('oi'), { leadId: 'abc' }), lead.deps), null);
  assert.equal(await unidadeDonaDoTurno(turno(webhook('oi'), { leadId: '0' }), lead.deps), null);
  assert.deepEqual(lead.w.buscouGravada, [], 'lead inválido nem consulta o banco');
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

test('burst cheio: sem turno paralelo sobre o mesmo paciente, e a recepção fica sabendo (TAREFA)', async () => {
  const { deps } = mundo({ conv: null, status: 'rejected' });
  assert.equal(await retomarTurnoPerdido(turno(webhook('oi')), UNIT, deps), 'tarefa:burst_cheio');
});
