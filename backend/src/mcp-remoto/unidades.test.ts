import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Unidade } from '../franquia-mcp/unidade.js';
import { umaPorToken } from './unidades.js';

const u = (slug: string, token: string): Unidade => ({ slug, nome: slug, token, fuso: 'America/Sao_Paulo', baseUrl: 'https://x' });

test('a mesma franquia (mesmo token) entra UMA vez, pela unidade principal — o caso real de 06/10', () => {
  const { ficam, descartadas } = umaPorToken([
    u('imperatriz-resgate', 'tok-itz'),
    u('laboratorio-kommo', 'tok-itz'),
    u('doutor-hernia-imperatriz', 'tok-itz'),
    u('acailandia-resgate', 'tok-acl'),
    u('doutor-hernia-acailandia', 'tok-acl'),
    u('doutor-hernia-serra', 'tok-serra'),
  ]);
  assert.deepEqual([...ficam.keys()], ['doutor-hernia-acailandia', 'doutor-hernia-imperatriz', 'doutor-hernia-serra']);
  assert.deepEqual(
    descartadas.map((d) => `${d.slug}→${d.mesmaFranquiaQue}`).sort(),
    ['acailandia-resgate→doutor-hernia-acailandia', 'imperatriz-resgate→doutor-hernia-imperatriz', 'laboratorio-kommo→doutor-hernia-imperatriz'],
  );
});

test('franquia que só existe como resgate continua aparecendo (não some do relatório)', () => {
  const { ficam } = umaPorToken([u('so-resgate', 'tok-1')]);
  assert.deepEqual([...ficam.keys()], ['so-resgate']);
});

test('tokens diferentes nunca se juntam, mesmo com nome parecido', () => {
  const { ficam, descartadas } = umaPorToken([u('doutor-hernia-petropolis', 'a'), u('doutor-hernia-caxias', 'b')]);
  assert.equal(ficam.size, 2);
  assert.equal(descartadas.length, 0);
});
