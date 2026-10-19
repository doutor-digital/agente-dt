import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidirNomeDoContato, gravarNomeConfirmadoNoContato, nomeParaContato } from './nome-no-contato.js';
import { _semearParaTeste } from './automacoes-estado.js';

// Pares (contato hoje, nome que a IA confirmou) medidos em Canaã, 19/10/2026.
test('grava quando o contato tem outro nome, apelido, empresa ou sujeira', () => {
  const casos: Array<[string | null, string, string]> = [
    ['Deus Forte', 'Willian Coelho de Sousa', 'Willian Coelho de Sousa'],
    ['ARENA SABOR', 'Alexandre Carlos', 'Alexandre Carlos'],
    ['.', 'Carlos Daniel Pereira', 'Carlos Daniel Pereira'],
    ['não', 'Jocerliana', 'Jocerliana'],
    ['ʲʰᵒⁿᵃʳᶦᵃ', 'Jhonayra', 'Jhonayra'],
    ['', 'Roberta', 'Roberta'],
    [null, 'Roberta', 'Roberta'],
    ['nalldobarros', 'Nalldo Barros', 'Nalldo Barros'],
    ['Dayse Moreira 28/04/25 Sem Origem', 'Dayse', 'Dayse'],
    ['Renato Sousa', 'Renato Sousa dos Santos', 'Renato Sousa dos Santos'],
    ['Cris', 'Cristiane', 'Cristiane'],
    ['Leidilayne', 'Flávio Dias Sousa', 'Flávio Dias Sousa'],
    ['Maria', 'Maria José', 'Maria José'],
  ];
  for (const [atual, confirmado, esperado] of casos) {
    const d = decidirNomeDoContato(atual, confirmado);
    assert.equal(d.gravar, true, `deveria gravar: ${atual} ← ${confirmado}`);
    if (d.gravar) assert.equal(d.nome, esperado);
  }
});

test('não grava quando o contato já tem o nome ou uma versão mais completa dele', () => {
  const casos: Array<[string, string]> = [
    ['Anny Santos', 'Anny'],
    ['Mateus Costa', 'Mateus Costa'],
    ['EZEQUIEL', 'Ezequiel'],
    ['reginaldo', 'Reginaldo'],
    ['Flavio Freitas', 'Flávio'],
    ['Luciana☺️', 'Luciana'],
    ['Maria do Amparo', 'MARIA DO AMPARO'],
    ['Claudio Pereira Souza', 'Claudio Souza'],
    ['José Daires', 'Daires José'],
    ['José morais Morais', 'Morais'],
  ];
  for (const [atual, confirmado] of casos) {
    assert.equal(decidirNomeDoContato(atual, confirmado).gravar, false, `deveria manter: ${atual} ← ${confirmado}`);
  }
});

test('nome que não parece nome nunca vai pro contato', () => {
  for (const lixo of ['Obg', 'Mas', 'Unable', 'Combinado', 'Desculpa']) {
    assert.equal(decidirNomeDoContato('Maria', lixo).gravar, false, lixo);
  }
});

test('caixa: só arruma nome todo maiúsculo ou todo minúsculo', () => {
  assert.equal(nomeParaContato('JOSÉ RODRIGUES PEREIRA'), 'José Rodrigues Pereira');
  assert.equal(nomeParaContato('maria do amparo'), 'Maria do Amparo');
  assert.equal(nomeParaContato("Ana D'Ávila"), "Ana D'Ávila");
  assert.equal(nomeParaContato('  Flávio   Dias '), 'Flávio Dias');
});

function kommoFalso(nomeAtual: string | Error) {
  const gravados: Array<[number, string]> = [];
  return {
    gravados,
    lidos: 0,
    async getContactNome(_id: number) {
      this.lidos++;
      if (nomeAtual instanceof Error) throw nomeAtual;
      return nomeAtual;
    },
    async updateContactName(id: number, nome: string) {
      gravados.push([id, nome]);
    },
  };
}

test('desligada: não lê nem grava nada no Kommo', async () => {
  _semearParaTeste([]);
  const k = kommoFalso('Deus Forte');
  const r = await gravarNomeConfirmadoNoContato({ unit: { slug: 'canaa' }, kommo: k, contatoId: 10, nome: 'Willian', ambiente: '' });
  assert.equal(r.acao, 'desligado');
  assert.equal(k.lidos, 0);
  assert.equal(k.gravados.length, 0);
});

test('ligada: grava; só no papel: diz o que faria e não grava', async () => {
  _semearParaTeste([
    { slug: 'canaa', automacao: 'nome-no-contato', estado: 'ligado' },
    { slug: 'serra', automacao: 'nome-no-contato', estado: 'seco' },
  ]);
  const k1 = kommoFalso('Deus Forte');
  const r1 = await gravarNomeConfirmadoNoContato({ unit: { slug: 'canaa' }, kommo: k1, contatoId: 10, nome: 'Willian' });
  assert.equal(r1.acao, 'gravou');
  assert.deepEqual(k1.gravados, [[10, 'Willian']]);

  const k2 = kommoFalso('Deus Forte');
  const r2 = await gravarNomeConfirmadoNoContato({ unit: { slug: 'serra' }, kommo: k2, contatoId: 10, nome: 'Willian' });
  assert.equal(r2.acao, 'gravaria');
  assert.equal(k2.gravados.length, 0);
  _semearParaTeste([]);
});

test('ligada: contato com nome melhor fica; cartão sem contato não chama o Kommo', async () => {
  _semearParaTeste([{ slug: 'canaa', automacao: 'nome-no-contato', estado: 'ligado' }]);
  const k = kommoFalso('Anny Santos');
  assert.equal((await gravarNomeConfirmadoNoContato({ unit: { slug: 'canaa' }, kommo: k, contatoId: 10, nome: 'Anny' })).acao, 'manteve');
  assert.equal(k.gravados.length, 0);
  const k2 = kommoFalso('x');
  assert.equal((await gravarNomeConfirmadoNoContato({ unit: { slug: 'canaa' }, kommo: k2, contatoId: null, nome: 'Anny' })).acao, 'sem-contato');
  assert.equal(k2.lidos, 0);
  _semearParaTeste([]);
});

test('Kommo falhou na leitura: lança e NÃO grava (falha de leitura não é "contato sem nome")', async () => {
  _semearParaTeste([{ slug: 'canaa', automacao: 'nome-no-contato', estado: 'ligado' }]);
  const k = kommoFalso(new Error('429'));
  await assert.rejects(gravarNomeConfirmadoNoContato({ unit: { slug: 'canaa' }, kommo: k, contatoId: 10, nome: 'Willian' }));
  assert.equal(k.gravados.length, 0);
  _semearParaTeste([]);
});
