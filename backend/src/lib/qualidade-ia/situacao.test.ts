import { test } from 'node:test';
import assert from 'node:assert/strict';

import { situacaoNaAvaliacao } from './agregar.js';

// A definição de "avaliável" NO MOMENTO DA NOTA, em código puro. O SQL (`consulta.ts`) tem de dar a mesma
// resposta — `consulta.sql.test.ts` confere caso a caso contra um Postgres.

const t = (iso: string) => new Date(iso);
const msg = (role: string, em: string, meta?: unknown) => ({ role, createdAt: t(em), meta });
const NOTA_EM = t('2026-10-25T20:00:00Z');

test('o paciente que sumiu, tirou nota e VOLTOU depois continua "sumiu"', () => {
  const r = situacaoNaAvaliacao(
    [msg('user', '2026-10-25T12:00:00Z'), msg('assistant', '2026-10-25T12:01:00Z', { via: 'salesbot' }), msg('user', '2026-10-26T15:00:00Z')],
    NOTA_EM,
  );
  assert.deepEqual(r, { sofiaFalou: true, pacienteRespondeu: false });
});

test('fala da Sofia depois da nota não conta; resposta antes da 1ª fala não conta', () => {
  assert.deepEqual(
    situacaoNaAvaliacao([msg('user', '2026-10-25T12:00:00Z'), msg('assistant', '2026-10-26T12:01:00Z', { via: 'salesbot' })], NOTA_EM),
    { sofiaFalou: false, pacienteRespondeu: false },
  );
  // o paciente falou ANTES da Sofia e nunca depois: não respondeu a ela
  assert.deepEqual(
    situacaoNaAvaliacao([msg('user', '2026-10-25T12:00:00Z'), msg('assistant', '2026-10-25T12:01:00Z', { via: 'salesbot' })], NOTA_EM),
    { sofiaFalou: true, pacienteRespondeu: false },
  );
  assert.deepEqual(
    situacaoNaAvaliacao([msg('assistant', '2026-10-25T12:01:00Z', { via: 'salesbot' }), msg('user', '2026-10-25T12:02:00Z')], NOTA_EM),
    { sofiaFalou: true, pacienteRespondeu: true },
  );
});

test('resposta que não chegou, equipe, régua, lembrete e confirmação não são a Sofia', () => {
  for (const meta of [
    { via: 'lead_note' },
    { via: 'chat_cartao' },
    { origem: 'kommo_talks', autor: 'equipe' },
    { origem: 'backfill-kommo' },
    { autor: 'equipe' },
    { origem: 'confirmacao_d1' },
    { followUp: 1 },
    { reactivation: 1 },
    { origem: 'lembrete_kommo' },
  ]) {
    const r = situacaoNaAvaliacao(
      [msg('user', '2026-10-25T12:00:00Z'), msg('assistant', '2026-10-25T12:01:00Z', meta), msg('user', '2026-10-25T12:05:00Z')],
      NOTA_EM,
    );
    assert.equal(r.sofiaFalou, false, JSON.stringify(meta));
  }
});
