import test from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { portaPilotoDeNumeros, pilotoDeNumerosEstado, telefoneNaLista } from './ia-so-numeros-de-teste.js';
import { listaDeTesteDoAmbiente } from './disparo/porto.js';

const unit = { id: 'u1', slug: 'magalhaes-advocacia' } as Unit;
const JOAO = '5563991234567';
const LISTA = listaDeTesteDoAmbiente('magalhaes-advocacia', { DISPARO_LISTA_DE_TESTE: `magalhaes-advocacia=${JOAO}` } as NodeJS.ProcessEnv);
const args = { unit, leadId: 1, contactId: '5' };

test('a lista é a do disparo: slug=telefones; sem entrada ninguém; slug=* todos', () => {
  assert.deepEqual([...(LISTA ?? [])], [JOAO]);
  assert.equal(listaDeTesteDoAmbiente('magalhaes-advocacia', { DISPARO_LISTA_DE_TESTE: 'outra=5563991234567' } as NodeJS.ProcessEnv)?.size, 0);
  assert.equal(listaDeTesteDoAmbiente('magalhaes-advocacia', { DISPARO_LISTA_DE_TESTE: 'magalhaes-advocacia=*' } as NodeJS.ProcessEnv), null);
});

test('chave desligada (o padrão): nem lê o telefone, a IA responde todo mundo', async () => {
  let leu = 0;
  const r = await portaPilotoDeNumeros(args, { estado: 'desligado', lista: LISTA, telefone: async () => (leu++, '5511999990000') });
  assert.equal(r, null);
  assert.equal(leu, 0);
});

test('ligada: o número do João passa, o resto fica sem resposta', async () => {
  const joao = await portaPilotoDeNumeros(args, { estado: 'ligado', lista: LISTA, telefone: async () => JOAO });
  assert.equal(joao?.naLista, true);
  const outro = await portaPilotoDeNumeros(args, { estado: 'ligado', lista: LISTA, telefone: async () => '5563988887777' });
  assert.equal(outro?.naLista, false);
  assert.equal(outro?.semTelefone, false);
});

test('com e sem o nono dígito é a mesma pessoa; formatação do Kommo não atrapalha', () => {
  assert.equal(telefoneNaLista(LISTA, '+55 (63) 99123-4567'), true);
  assert.equal(telefoneNaLista(LISTA, '556391234567'), true); // 12 dígitos, sem o 9
  assert.equal(telefoneNaLista(LISTA, '63991234567'), true); // sem o 55
  assert.equal(telefoneNaLista(LISTA, '5563991234568'), false);
});

test('ligada e o telefone não dá para ler (vazio, lixo ou erro): NÃO responde, porque o piloto protege gente de verdade', async () => {
  for (const t of [null, '', 'abc']) {
    const r = await portaPilotoDeNumeros(args, { estado: 'ligado', lista: LISTA, telefone: async () => t });
    assert.equal(r?.naLista, false, String(t));
    assert.equal(r?.semTelefone, true, String(t));
  }
  const erro = await portaPilotoDeNumeros(args, {
    estado: 'ligado',
    lista: LISTA,
    telefone: async () => {
      throw new Error('429');
    },
  });
  assert.equal(erro?.naLista, false);
  assert.equal(erro?.semTelefone, true);
});

test('lista vazia (unidade fora da lista): ninguém é respondido; slug=*: todos, sem nem ler o telefone', async () => {
  const vazia = await portaPilotoDeNumeros(args, { estado: 'ligado', lista: new Set(), telefone: async () => JOAO });
  assert.equal(vazia?.naLista, false);
  let leu = 0;
  const todos = await portaPilotoDeNumeros(args, { estado: 'ligado', lista: null, telefone: async () => (leu++, JOAO) });
  assert.equal(todos, null);
  assert.equal(leu, 0);
});

test('só no papel: devolve quem ficaria de fora (o webhook registra e responde)', async () => {
  const r = await portaPilotoDeNumeros(args, { estado: 'seco', lista: LISTA, telefone: async () => '5563988887777' });
  assert.equal(r?.estado, 'seco');
  assert.equal(r?.naLista, false);
});

test('a chave nasce desligada e liga pela lista do ambiente, só na unidade listada', () => {
  assert.equal(pilotoDeNumerosEstado('magalhaes-advocacia', undefined), 'desligado');
  assert.equal(pilotoDeNumerosEstado('magalhaes-advocacia', 'magalhaes-advocacia'), 'ligado');
  assert.equal(pilotoDeNumerosEstado('doutor-hernia-salto', 'magalhaes-advocacia'), 'desligado');
});
