import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Conversation, Unit } from '@prisma/client';

import { retomarTurnoPerdido, type DepsRetomada } from './webhook.controller.js';
import type { TurnoPerdido } from '../lib/recuperar-turnos.js';

/**
 * A origem do canal (`message.add[].origin`) tem de CHEGAR ao turno: `extractContext` → `execucaoDoTurno` → `processAgent({ origem })`.
 * Se um elo se perder, a chave `sofia-so-whatsapp` não calaria ninguém e o log de erros ficaria em zero. Aqui o turno retomado
 * (o mesmo `execucaoDoTurno` do webhook) roda de verdade, com o `processAgent` trocado por um espião.
 */

const UNIT = { id: 'u2', slug: 'doutor-hernia-tatui', isActive: true } as unknown as Unit;

const turno = (origin: string | undefined): TurnoPerdido => ({
  traceId: 'trace-1',
  unitId: 'u2',
  leadId: '5142896',
  criadoEm: new Date('2026-11-24T12:00:00Z'),
  input: {
    account: { id: 1 },
    message: { add: [{ id: 'm1', chat_id: 'c1', talk_id: '9', contact_id: '5', text: 'Oi', type: 'incoming', ...(origin ? { origin } : {}), author: { id: 'a1', name: 'Ana' } }] },
  },
});

async function origemQueChegouAoTurno(origin: string | undefined) {
  const processados: Array<{ origem?: string | null }> = [];
  const agendados: Array<Parameters<DepsRetomada['agendar']>[0]> = [];
  const deps: DepsRetomada = {
    conversa: async () => null as Conversation | null,
    anteriores: async () => [],
    registrar: async () => undefined,
    agendar: (a) => (agendados.push(a), 'started'),
    processar: async (a) => void processados.push(a),
  };
  assert.equal(await retomarTurnoPerdido(turno(origin), UNIT, deps), 'retomado');
  await agendados[0]!.run('Oi', [], [], ['trace-1']);
  assert.equal(processados.length, 1);
  return processados[0]!.origem;
}

test('a origem do webhook chega ao processAgent (instagram_business, facebook, waba)', async () => {
  assert.equal(await origemQueChegouAoTurno('instagram_business'), 'instagram_business');
  assert.equal(await origemQueChegouAoTurno('facebook'), 'facebook');
  assert.equal(await origemQueChegouAoTurno('waba'), 'waba');
});

test('webhook sem origem: o turno segue com origem nula (a chave não cala o que não sabe)', async () => {
  assert.equal(await origemQueChegouAoTurno(undefined), null);
});
