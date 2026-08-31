import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonizarFatos } from './fatos-canonicos.js';

test('os quatro nomes de queixa viram um só', () => {
  for (const apelido of ['queixa_principal', 'dor', 'localizacao_dor']) {
    const r = canonizarFatos({ [apelido]: 'lombar' });
    assert.equal(r.queixa, 'lombar', `${apelido} não virou queixa`);
    assert.equal(r[apelido], undefined, `${apelido} continuou existindo`);
  }
});

test('consulta_marcada e agendou são a mesma gaveta', () => {
  assert.equal(canonizarFatos({ consulta_marcada: 'sim' }).agendou, 'sim');
  assert.equal(canonizarFatos({ consulta_agendada: 'Sim' }).agendou, 'Sim');
});

test('o nome canônico ganha do apelido quando os dois vêm juntos', () => {
  // `queixa` vem da tool que grava de propósito; `dor` costuma vir do resumo
  const r = canonizarFatos({ queixa: 'cervical', dor: 'lombar' });
  assert.equal(r.queixa, 'cervical');
});

test('a ordem em que chegam não muda o resultado', () => {
  const a = canonizarFatos({ dor: 'lombar', queixa: 'cervical' });
  const b = canonizarFatos({ queixa: 'cervical', dor: 'lombar' });
  assert.deepEqual(a, b);
});

test('fato vazio não ocupa a gaveta e deixa o apelido preencher', () => {
  const r = canonizarFatos({ queixa: '   ', dor: 'lombar' });
  assert.equal(r.queixa, 'lombar');
});

test('chave desconhecida passa intacta — não invento sinônimo', () => {
  const r = canonizarFatos({ profissao: 'pedreiro', sexo: 'M' });
  assert.equal(r.profissao, 'pedreiro');
  assert.equal(r.sexo, 'M');
});

test('nome com maiúscula ou espaço é normalizado', () => {
  assert.equal(canonizarFatos({ 'Queixa Principal': 'lombar' }).queixa, 'lombar');
  assert.equal(canonizarFatos({ AGENDOU: 'sim' }).agendou, 'sim');
});

test('valor nulo ou vazio não entra', () => {
  assert.deepEqual(canonizarFatos({ nome: null, cidade: '', queixa: '  ' }), {});
});

test('zero e false são valores de verdade, não vazio', () => {
  const r = canonizarFatos({ tentativas: 0, agendou: false });
  assert.equal(r.tentativas, 0);
  assert.equal(r.agendou, false);
});

test('nada entra vira objeto vazio, sem quebrar', () => {
  assert.deepEqual(canonizarFatos(null), {});
  assert.deepEqual(canonizarFatos(undefined), {});
  assert.deepEqual(canonizarFatos({}), {});
});

test('localizacao vira cidade, que é como o resto do sistema chama', () => {
  assert.equal(canonizarFatos({ localizacao: 'Imperatriz' }).cidade, 'Imperatriz');
});

test('idempotente: canonizar duas vezes dá o mesmo', () => {
  const uma = canonizarFatos({ dor: 'lombar', consulta_marcada: 'sim' });
  assert.deepEqual(canonizarFatos(uma), uma);
});
