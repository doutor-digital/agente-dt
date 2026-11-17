import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErroDeYaml, lerYaml, lerYamlOuJson } from './yaml-minimo.js';

test('mapas, listas de valores e de mapas, escalares e comentários', () => {
  const r = lerYaml(`
# comentário
versao: 1
unidade:
  nome: "Doutor Hérnia: Parauapebas"   # comentário no fim
  uf: 'PA'
  ativo: true
  nada: null
  vazio:
dias: [1, 2, "3"]
atendentes:
  - nome: Ana
    email: ana@example.com
    funcao: gerente
  - nome: Bia
    email: bia@example.com
tags:
  - a
  - 'b # c'
numero: 12.5
`);
  assert.deepEqual(r, {
    versao: 1,
    unidade: { nome: 'Doutor Hérnia: Parauapebas', uf: 'PA', ativo: true, nada: null, vazio: null },
    dias: [1, 2, '3'],
    atendentes: [
      { nome: 'Ana', email: 'ana@example.com', funcao: 'gerente' },
      { nome: 'Bia', email: 'bia@example.com' },
    ],
    tags: ['a', 'b # c'],
    numero: 12.5,
  });
});

test('lista no mesmo recuo da chave, mapa dentro de mapa dentro de lista e bloco de texto', () => {
  const r = lerYaml(`
a:
- x: 1
  y:
    z: 2
- x: 3
texto: |
  linha 1
    linha 2

  linha 4
depois: ok
`);
  assert.deepEqual(r, { a: [{ x: 1, y: { z: 2 } }, { x: 3 }], texto: 'linha 1\n  linha 2\n\nlinha 4\n', depois: 'ok' });
});

test('número com zero à esquerda e telefone ficam texto; endereço com vírgula e traço é texto', () => {
  const r = lerYaml('tel: 0944\ncep: 68515-000\nend: Rua C, 455-A — Cidade Nova\n') as Record<string, unknown>;
  assert.equal(r.tel, '0944');
  assert.equal(r.cep, '68515-000');
  assert.equal(r.end, 'Rua C, 455-A — Cidade Nova');
});

test('erros claros, com a linha: tabulação, chave repetida, âncora, aspas, indentação', () => {
  assert.throws(() => lerYaml('a:\n\tb: 1\n'), (e: unknown) => e instanceof ErroDeYaml && e.linha === 2);
  assert.throws(() => lerYaml('a: 1\na: 2\n'), /chave repetida/);
  assert.throws(() => lerYaml('a: &x 1\n'), /não suportado/);
  assert.throws(() => lerYaml('a: "aberta\n'), /aspas duplas/);
  assert.throws(() => lerYaml('a: 1\n   b: 2\n'), /indentação|fora do lugar/);
  assert.throws(() => lerYaml('__proto__: 1\n'), /chave repetida/);
  assert.throws(() => lerYaml('   \n# só comentário\n'), /vazio/);
  assert.throws(() => lerYaml('a: {x: 1}\n'), /não suportado/);
});

test('JSON também vale', () => {
  assert.deepEqual(lerYamlOuJson('{"a": [1, 2]}'), { a: [1, 2] });
  assert.deepEqual(lerYamlOuJson('a: 1\n'), { a: 1 });
});
