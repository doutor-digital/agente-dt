import { test } from 'node:test';
import assert from 'node:assert/strict';

interface Evento {
  type?: string;
  created_by?: number;
  created_at?: number;
}

function primeiraAtividadeHumana(eventos: Evento[]): Evento | null {
  return (
    eventos
      .filter((e) => Number(e.created_by ?? 0) > 0)
      .sort((a, b) => Number(a.created_at ?? 0) - Number(b.created_at ?? 0))[0] ?? null
  );
}

const SISTEMA = 0;
const GIULIA = 15248075;

test('atividade da atendente é reconhecida', () => {
  const e = primeiraAtividadeHumana([
    { type: 'custom_field_value_changed', created_by: SISTEMA, created_at: 100 },
    { type: 'name_field_changed', created_by: GIULIA, created_at: 200 },
  ]);
  assert.ok(e);
  assert.equal(e.created_by, GIULIA);
});

test('só o sistema mexendo NÃO conta como atendimento', () => {
  assert.equal(
    primeiraAtividadeHumana([
      { type: 'custom_field_value_changed', created_by: SISTEMA, created_at: 100 },
      { type: 'lead_status_changed', created_by: SISTEMA, created_at: 300 },
    ]),
    null,
  );
});

test('pega a PRIMEIRA ação humana, não a última', () => {
  const e = primeiraAtividadeHumana([
    { type: 'entity_tag_added', created_by: GIULIA, created_at: 900 },
    { type: 'lead_status_changed', created_by: GIULIA, created_at: 400 },
    { type: 'custom_field_value_changed', created_by: SISTEMA, created_at: 100 },
  ]);
  assert.equal(e?.created_at, 400);
});

test('lead sem evento nenhum não é dado como atendido', () => {
  assert.equal(primeiraAtividadeHumana([]), null);
});

test('caso real da Alessandra: atendente mexeu no cartão depois do handoff', () => {
  const eventos: Evento[] = [
    { type: 'custom_field_2443367_value_changed', created_by: SISTEMA, created_at: 1000 },
    { type: 'name_field_changed', created_by: GIULIA, created_at: 3000 },
    { type: 'lead_status_changed', created_by: GIULIA, created_at: 9000 },
  ];
  const e = primeiraAtividadeHumana(eventos);
  assert.equal(e?.created_by, GIULIA);
  assert.equal(e?.type, 'name_field_changed');
});
