import assert from 'node:assert/strict';
import { test } from 'node:test';
import { criarContexto, resolverUnidades } from './contexto.js';
import type { Unidade } from './unidade.js';

const u = (slug: string): Unidade => ({ slug, nome: slug, token: `tok-${slug}`, fuso: 'America/Sao_Paulo', baseUrl: 'https://x' });
const ctx = criarContexto(new Map(['doutor-hernia-rioverde', 'doutor-hernia-boa-vista', 'doutor-hernia-porto', 'doutor-hernia-serra', 'doutor-hernia-taubate'].map((s) => [s, u(s)])));

test('franquia: "rio verde", "boa vista" e "Taubaté" acham a unidade (buscar_agendamentos recusava)', () => {
  assert.deepEqual(resolverUnidades(ctx, 'rio verde').map((x) => x.slug), ['doutor-hernia-rioverde']);
  assert.deepEqual(resolverUnidades(ctx, ['Boa Vista', 'porto nacional', 'serra']).map((x) => x.slug), ['doutor-hernia-boa-vista', 'doutor-hernia-porto', 'doutor-hernia-serra']);
  assert.deepEqual(resolverUnidades(ctx, 'Taubaté').map((x) => x.slug), ['doutor-hernia-taubate']);
});

test('franquia: desconhecido ou ambíguo continua recusado, com a lista das válidas', () => {
  assert.throws(() => resolverUnidades(ctx, 'trauma'), /unidade desconhecida ou ambígua: trauma\. Válidas: doutor-hernia-rioverde/);
  assert.throws(() => resolverUnidades(ctx, 'doutor hernia'), /desconhecida ou ambígua/);
  assert.throws(() => resolverUnidades(ctx, ['serra', 'tubarao']), /tubarao/);
});
