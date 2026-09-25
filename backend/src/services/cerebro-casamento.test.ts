import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { chaveTelefone, normalizarNome, parecencaDeNome } from './cerebro.service.js';

/**
 * O casamento entre a franquia e o Kommo.
 *
 * A divisão que sustenta o produto: o CÓDIGO casa pelo telefone (duro, sem opinião) e
 * a IA julga o que sobrou. Se o código começar a adivinhar por nome, ele vira um n8n
 * caro; se a IA for chamada pra decidir o que um telefone resolve, ela vira desperdício.
 * Estes testes travam essa fronteira.
 */

test('o telefone é a medida padrão — e o 9 que ora está ora não está não pode separar a mesma linha', () => {
  const esperado = chaveTelefone('63991021043');
  assert.ok(esperado, 'número válido precisa gerar chave');
  for (const escrito of [
    '+55 63 99102-1043',
    '5563991021043',
    '(63) 99102-1043',
    '63 9102-1043',   // o mesmo número sem o 9
    '63991021043',
  ]) {
    assert.equal(chaveTelefone(escrito), esperado, `"${escrito}" deveria casar`);
  }
});

test('o que não é telefone não vira chave — pior que não casar é casar errado', () => {
  for (const lixo of ['', '   ', '1234', 'não informado', '0000', null, undefined]) {
    assert.equal(chaveTelefone(lixo as string), null, `"${String(lixo)}" não pode virar chave`);
  }
});

test('números diferentes nunca colidem', () => {
  assert.notEqual(chaveTelefone('63991021043'), chaveTelefone('63991021044'));
  assert.notEqual(chaveTelefone('6399102104'), chaveTelefone('9999102104'), 'DDD diferente é gente diferente');
});

test('nome normalizado ignora acento, caixa e pontuação', () => {
  assert.equal(normalizarNome('CÍCERO DE SOUZA REZENDE'), 'cicero de souza rezende');
  assert.equal(normalizarNome('  José   D\'Ávila  '), 'jose d avila');
});

test('a parecença de nome MEDE, não decide', () => {
  // Sobrenome faltando: alta parecença, o agente confirma.
  assert.ok(parecencaDeNome('MARIA HELENA SILVA SOUZA', 'Maria Helena Silva') >= 0.9);
  // Ordem trocada continua sendo a mesma pessoa.
  assert.ok(parecencaDeNome('SILVA, MARIA HELENA', 'Maria Helena Silva') >= 0.9);
  // Gente diferente com sobrenome comum NÃO pode passar como certeza.
  assert.ok(parecencaDeNome('JOAO SILVA', 'MARIA SILVA') < 0.6, 'sobrenome comum não é identidade');
});

test('o caso do sobrenome grudado cai no meio — é candidato, nunca certeza', () => {
  // "VALESOUSA" grudado × "Vale Sousa" separado: só "edson" bate, de dois pedaços.
  // Meio a meio é a definição de ambíguo — o número certo aqui não é alto nem baixo,
  // é o que manda o caso pro agente com os candidatos na mão.
  const p = parecencaDeNome('EDSON DO VALESOUSA', 'Edson do Vale Sousa');
  assert.ok(p >= 0.5 && p < 0.9, `parecença ${p}: precisa virar candidato, sem virar afirmação`);
});

test('parecença de nome NUNCA fecha o casamento sozinha', () => {
  // A regra que sustenta o produto: só `vinculo` e `telefone` carimbam o cartão.
  // Nome só alimenta `candidatos`, pro agente ler o contexto e decidir. Se um dia
  // alguém fizer o código casar por nome, este teste é o aviso.
  const fonte = readFileSync(new URL('./cerebro.service.ts', import.meta.url), 'utf8');
  const atribuicoes = [...fonte.matchAll(/casadoPor\s*=\s*'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(atribuicoes)].sort(), ['telefone', 'vinculo']);
  assert.ok(!/casadoPor\s*=\s*'nome'/.test(fonte), 'casar por nome é trabalho do agente, não do código');
});

test('nome vazio nunca parece com nada', () => {
  assert.equal(parecencaDeNome('', 'Maria'), 0);
  assert.equal(parecencaDeNome('Maria', ''), 0);
  assert.equal(parecencaDeNome('a b', 'c d'), 0, 'pedaço de 1-2 letras não conta como nome');
});
