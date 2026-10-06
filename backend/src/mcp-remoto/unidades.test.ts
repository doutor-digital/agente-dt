import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Unidade } from '../franquia-mcp/unidade.js';
import { acharSlug, umaPorChave, umaPorToken } from './unidades.js';

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
    ['acailandia-resgate→doutor-hernia-acailandia', 'imperatriz-resgate→doutor-hernia-imperatriz'],
  );
});

test('laboratório sai SEMPRE, mesmo sozinho na conta (é teste, não franquia)', () => {
  const { ficam } = umaPorToken([u('laboratorio-kommo', 'tok-lab')]);
  assert.equal(ficam.size, 0);
});

test('Kommo: uma conta por franquia; financeiro e tratamento também saem pra principal', () => {
  const kommo = (slug: string, sub: string) => ({ slug, sub });
  const { ficam } = umaPorChave(
    [kommo('imperatriz-financeiro', 'itz'), kommo('doutor-hernia-imperatriz', 'itz'), kommo('imperatriz-tratamento', 'itz'), kommo('default', 'trauma')],
    (k) => k.sub,
  );
  assert.deepEqual([...ficam.keys()], ['default', 'doutor-hernia-imperatriz']);
  assert.deepEqual(ficam.get('doutor-hernia-imperatriz')?.slugsDaFranquia, ['doutor-hernia-imperatriz', 'imperatriz-financeiro', 'imperatriz-tratamento']);
});

test('acharSlug: exato, nome curto, ambíguo', () => {
  const slugs = ['doutor-hernia-serra', 'doutor-hernia-canaa', 'lab-canaa'];
  assert.equal(acharSlug(slugs, 'Serra'), 'doutor-hernia-serra');
  assert.equal(acharSlug(slugs, 'doutor-hernia-serra'), 'doutor-hernia-serra');
  assert.equal(acharSlug(slugs, 'canaa'), undefined);
  assert.equal(acharSlug(slugs, 'xpto'), undefined);
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
