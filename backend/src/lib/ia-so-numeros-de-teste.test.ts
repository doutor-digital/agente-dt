import test from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { listaDoPiloto, portaPilotoDeNumeros, pilotoDeNumerosEstado, telefoneNaLista, temEntradaNoPiloto } from './ia-so-numeros-de-teste.js';
import { _esquecerOBancoParaTeste, _semearParaTeste } from './automacoes-estado.js';

const unit = { id: 'u1', slug: 'magalhaes-advocacia' } as Unit;
const JOAO = '5563991234567';
const env = (v: string) => ({ IA_NUMEROS_DE_TESTE: v }) as NodeJS.ProcessEnv;
const LISTA = listaDoPiloto('magalhaes-advocacia', env(`magalhaes-advocacia=${JOAO}`));
const args = { unit, leadId: 1, contactId: '5' };

test('a lista é PRÓPRIA (IA_NUMEROS_DE_TESTE): slug=telefones; sem entrada ninguém', () => {
  assert.deepEqual([...LISTA], [JOAO]);
  assert.equal(listaDoPiloto('magalhaes-advocacia', env('outra=5563991234567')).size, 0);
  assert.equal(listaDoPiloto('magalhaes-advocacia', {} as NodeJS.ProcessEnv).size, 0);
  assert.equal(temEntradaNoPiloto('magalhaes-advocacia', env(`magalhaes-advocacia=${JOAO}`)), true);
  assert.equal(temEntradaNoPiloto('magalhaes-advocacia', env('outra=1')), false);
  assert.equal(temEntradaNoPiloto('magalhaes-advocacia', env(`doutor-hernia-canaa=${JOAO}/magalhaes-advocacia=${JOAO}`)), true, '"/" separa como ";" (formato do .env): a unidade depois da barra fica protegida');
  assert.deepEqual([...listaDoPiloto('magalhaes-advocacia', env(`doutor-hernia-canaa=5563992021043/magalhaes-advocacia=${JOAO}`))], [JOAO]);
});

test('`*` NÃO ABRE a IA: nem em IA_NUMEROS_DE_TESTE (vira lista vazia) nem pela lista do disparo (DISPARO_LISTA_DE_TESTE é ignorada)', async () => {
  assert.equal(listaDoPiloto('magalhaes-advocacia', env('magalhaes-advocacia=*')).size, 0);
  const antes = process.env.DISPARO_LISTA_DE_TESTE;
  process.env.DISPARO_LISTA_DE_TESTE = 'magalhaes-advocacia=*';
  try {
    const r = await portaPilotoDeNumeros(args, { estado: 'ligado', telefone: async () => '5563988887777' });
    assert.equal(r?.naLista, false, 'abrir o disparo não abriu a IA');
    assert.equal(listaDoPiloto('magalhaes-advocacia').size, 0);
  } finally {
    if (antes === undefined) delete process.env.DISPARO_LISTA_DE_TESTE;
    else process.env.DISPARO_LISTA_DE_TESTE = antes;
  }
  const todos = await portaPilotoDeNumeros(args, { estado: 'ligado', lista: listaDoPiloto('magalhaes-advocacia', env('magalhaes-advocacia=*')), telefone: async () => JOAO });
  assert.equal(todos?.naLista, false);
  // a ÚNICA forma de abrir é a chave
  assert.equal(await portaPilotoDeNumeros(args, { estado: 'desligado', lista: LISTA, telefone: async () => '5563988887777' }), null);
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

test('lista vazia (unidade fora da lista): ninguém é respondido', async () => {
  const vazia = await portaPilotoDeNumeros(args, { estado: 'ligado', lista: new Set(), telefone: async () => JOAO });
  assert.equal(vazia?.naLista, false);
});

test('só no papel: devolve quem ficaria de fora (o webhook registra e responde)', async () => {
  const r = await portaPilotoDeNumeros(args, { estado: 'seco', lista: LISTA, telefone: async () => '5563988887777' });
  assert.equal(r?.estado, 'seco');
  assert.equal(r?.naLista, false);
});

test('a chave nasce desligada e liga pela lista do ambiente, só na unidade listada', () => {
  _semearParaTeste([]); // o banco respondeu e a tela nunca falou
  try {
    assert.equal(pilotoDeNumerosEstado('magalhaes-advocacia', undefined), 'desligado');
    assert.equal(pilotoDeNumerosEstado('magalhaes-advocacia', 'magalhaes-advocacia'), 'ligado');
    assert.equal(pilotoDeNumerosEstado('doutor-hernia-salto', 'magalhaes-advocacia'), 'desligado');
  } finally {
    _esquecerOBancoParaTeste();
  }
});

test('BANCO FORA não abre o piloto: com entrada na lista e o banco mudo, a chave vale ligada mesmo com o .env vazio', () => {
  const antes = process.env.IA_NUMEROS_DE_TESTE;
  process.env.IA_NUMEROS_DE_TESTE = `magalhaes-advocacia=${JOAO}`;
  try {
    _esquecerOBancoParaTeste();
    assert.equal(pilotoDeNumerosEstado('magalhaes-advocacia', undefined), 'ligado');
    assert.equal(pilotoDeNumerosEstado('doutor-hernia-salto', undefined), 'desligado', 'outra unidade não muda');
    // o banco respondeu e a tela pôs desligado de propósito (ir ao ar): vale o que ele disse
    _semearParaTeste([{ slug: 'magalhaes-advocacia', automacao: 'ia-so-numeros-de-teste', estado: 'desligado' }]);
    assert.equal(pilotoDeNumerosEstado('magalhaes-advocacia', undefined), 'desligado');
  } finally {
    if (antes === undefined) delete process.env.IA_NUMEROS_DE_TESTE;
    else process.env.IA_NUMEROS_DE_TESTE = antes;
    _esquecerOBancoParaTeste();
  }
});

test('ORDEM no webhook: pausa da unidade → piloto → cliente → só então Whisper, visão, "paciente insistiu" e fora do horário (quem está fora não gera custo)', async () => {
  const { readFileSync } = await import('node:fs');
  const fonte = readFileSync(new URL('../controllers/webhook.controller.ts', import.meta.url), 'utf8');
  const turno = fonte.slice(fonte.indexOf('async function processarTurno'));
  const pos = (t: string) => {
    const i = turno.indexOf(t);
    assert.ok(i > 0, `não achei ${t}`);
    return i;
  };
  const ordem = [pos('if (emPausa(unit))'), pos('await portaPilotoDeNumeros('), pos('await portaClienteDoEscritorio('), pos('await transcribeAudio('), pos('checkBusinessHours(unit)')];
  assert.deepEqual([...ordem].sort((a, b) => a - b), ordem, 'as portas têm de vir antes de qualquer custo');
});
