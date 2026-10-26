import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filtroDeMontagemMorta, MONTAGEM_SEM_BATIDA_MS, MONTAGEM_TETO_MS, montagemMorta } from './disparo/montagem.js';

const AGORA = Date.UTC(2026, 9, 26, 15);
const antes = (ms: number) => new Date(AGORA - ms);

test('montagem VIVA que já passou de 30 minutos (unidade grande) NÃO é cancelada enquanto dá batida', () => {
  assert.equal(montagemMorta({ criadoEm: antes(2 * 3_600_000), atualizadoEm: antes(30_000) }, AGORA), null);
  assert.equal(montagemMorta({ criadoEm: antes(MONTAGEM_SEM_BATIDA_MS + 60_000), atualizadoEm: antes(10_000) }, AGORA), null);
});

test('montagem que parou de dar batida há mais de 30 minutos morreu (deploy): é cancelada', () => {
  assert.equal(montagemMorta({ criadoEm: antes(3_600_000), atualizadoEm: antes(MONTAGEM_SEM_BATIDA_MS + 1000) }, AGORA), 'sem-batida');
  assert.equal(montagemMorta({ criadoEm: antes(60_000), atualizadoEm: antes(MONTAGEM_SEM_BATIDA_MS - 1000) }, AGORA), null);
});

test('batida sem fim não prende a montagem para sempre: passou do teto de idade, cancela', () => {
  assert.equal(montagemMorta({ criadoEm: antes(MONTAGEM_TETO_MS + 1000), atualizadoEm: antes(5_000) }, AGORA), 'passou-do-teto');
});

test('o filtro do banco é o mesmo critério (montando E (sem batida OU passou do teto))', () => {
  const f = filtroDeMontagemMorta(AGORA);
  assert.equal(f.estado, 'montando');
  assert.deepEqual(f.OR, [{ atualizadoEm: { lt: antes(MONTAGEM_SEM_BATIDA_MS) } }, { criadoEm: { lt: antes(MONTAGEM_TETO_MS) } }]);
});
