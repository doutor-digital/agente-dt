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

// As listas reais de 05/11/2026 (copiadas das mensagens de erro de `mcp_auditoria`).
const COM_KOMMO = [
  'default', 'doutor-hernia-acailandia', 'doutor-hernia-araguaina', 'doutor-hernia-balsas', 'doutor-hernia-bebedouro', 'doutor-hernia-boa-vista',
  'doutor-hernia-boituva', 'doutor-hernia-canaa', 'doutor-hernia-capivari', 'doutor-hernia-cerquilho', 'doutor-hernia-imperatriz', 'doutor-hernia-maraba',
  'doutor-hernia-mossoro', 'doutor-hernia-olimpia', 'doutor-hernia-parauapebas', 'doutor-hernia-porto', 'doutor-hernia-rioverde', 'doutor-hernia-salto',
  'doutor-hernia-serra', 'doutor-hernia-tatui', 'doutor-hernia-taubate', 'doutor-hernia-timbo', 'hm-tecnologia', 'magalhaes-advocacia',
  'doutor-hernia-caxias', 'doutor-hernia-petropolis',
];
const COM_ASAAS = [
  'doutor-digital', 'doutor-hernia-balsas', 'hm-tecnologia', 'doutor-hernia-araguaina', 'doutor-hernia-canaa', 'doutor-hernia-porto',
  'doutor-hernia-imperatriz', 'default', 'doutor-hernia-maraba', 'magalhaes-advocacia', 'doutor-hernia-parauapebas', 'doutor-hernia-acailandia', 'doutor-hernia-rioverde',
];

test('acharSlug: os nomes que a Suzanne digitou e o conector recusava (espaço, hífen, junto, acento, apelido)', () => {
  for (const [pedido, esperado] of [
    ['rio verde', 'doutor-hernia-rioverde'],
    ['Rio Verde', 'doutor-hernia-rioverde'],
    ['rio-verde', 'doutor-hernia-rioverde'],
    ['rioverde', 'doutor-hernia-rioverde'],
    ['boa vista', 'doutor-hernia-boa-vista'],
    ['boa-vista', 'doutor-hernia-boa-vista'],
    ['boavista', 'doutor-hernia-boa-vista'],
    ['vista', 'doutor-hernia-boa-vista'],
    ['porto nacional', 'doutor-hernia-porto'],
    ['porto', 'doutor-hernia-porto'],
    ['trauma', 'default'],
    ['timbó', 'doutor-hernia-timbo'],
    ['Marabá', 'doutor-hernia-maraba'],
    ['doutor-hernia-marabá', 'doutor-hernia-maraba'],
    ['Doutor Hérnia Rio Verde', 'doutor-hernia-rioverde'],
    ['tatuí', 'doutor-hernia-tatui'],
    ['hm', 'hm-tecnologia'],
    ['hm tecnologia', 'hm-tecnologia'],
  ] as const) {
    assert.equal(acharSlug(COM_KOMMO, pedido), esperado, pedido);
  }
  assert.equal(acharSlug(COM_ASAAS, 'doutor digital'), 'doutor-digital');
  assert.equal(acharSlug(COM_ASAAS, 'Doutor Digital'), 'doutor-digital');
  assert.equal(acharSlug(COM_ASAAS, 'rio verde'), 'doutor-hernia-rioverde');
});

test('acharSlug: ambíguo e desconhecido continuam RECUSADOS (errar de unidade é pior do que recusar)', () => {
  // muitas unidades começam com "doutor-hernia": não é nome de unidade
  for (const pedido of ['doutor', 'doutor hernia', 'doutor-hernia', 'hernia', 'rio', 'verde', 'boa', 'nacional', 'serra talhada', 'tubarao', 'xpto', '', '  ']) {
    assert.equal(acharSlug(COM_KOMMO, pedido), undefined, JSON.stringify(pedido));
  }
  // a clínica existe, mas não tem Asaas: o apelido e o nome curto não inventam conta
  assert.equal(acharSlug(COM_ASAAS, 'taubate'), undefined);
  assert.equal(acharSlug(COM_ASAAS, 'doutor-hernia-taubate'), undefined);
  assert.equal(acharSlug(COM_ASAAS, 'boa vista'), undefined);
  // o apelido só vale se o alvo está na lista da ferramenta
  assert.equal(acharSlug(['doutor-hernia-serra'], 'trauma'), undefined);
  assert.equal(acharSlug(['doutor-hernia-serra'], 'porto nacional'), undefined);
  // dois com o mesmo fim: ambíguo mesmo escrito com espaço
  assert.equal(acharSlug(['doutor-hernia-boa-vista', 'lab-boa-vista'], 'boa vista'), undefined);
  assert.equal(acharSlug(['doutor-hernia-rioverde', 'lab-rio-verde'], 'rio verde'), undefined);
});

test('acharSlug: resgate, financeiro e tratamento não casam por engano com o nome da unidade', () => {
  const comApoio = ['doutor-hernia-imperatriz', 'imperatriz-resgate', 'imperatriz-financeiro', 'imperatriz-tratamento', 'porto-resgate', 'serra-resgate'];
  assert.equal(acharSlug(comApoio, 'imperatriz'), 'doutor-hernia-imperatriz');
  assert.equal(acharSlug(comApoio, 'resgate'), undefined);
  assert.equal(acharSlug(comApoio, 'financeiro'), undefined);
  assert.equal(acharSlug(comApoio, 'tratamento'), undefined);
  // sem a principal na lista, o nome curto NÃO cai no funil de apoio
  assert.equal(acharSlug(['imperatriz-financeiro', 'imperatriz-resgate'], 'imperatriz'), undefined);
  assert.equal(acharSlug(['porto-resgate'], 'porto'), undefined);
  assert.equal(acharSlug(['porto-resgate'], 'porto nacional'), undefined);
  // pelo nome inteiro, quem quer o funil de apoio consegue
  assert.equal(acharSlug(comApoio, 'imperatriz-financeiro'), 'imperatriz-financeiro');
  assert.equal(acharSlug(comApoio, 'Imperatriz Financeiro'), 'imperatriz-financeiro');
  assert.equal(acharSlug(comApoio, 'porto resgate'), 'porto-resgate');
});

test('acharSlug: conta dividida (Petrópolis e Caxias no mesmo Kommo) continua sendo duas unidades', () => {
  const dividida = ['doutor-hernia-petropolis', 'doutor-hernia-caxias', 'doutor-hernia-serra'];
  assert.equal(acharSlug(dividida, 'Petrópolis'), 'doutor-hernia-petropolis');
  assert.equal(acharSlug(dividida, 'caxias'), 'doutor-hernia-caxias');
  assert.equal(acharSlug(dividida, 'petropolis caxias'), undefined);
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
