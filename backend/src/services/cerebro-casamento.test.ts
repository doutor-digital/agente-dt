import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { cartaoDoContato, chaveTelefone, normalizarNome, parecencaDeNome } from './cerebro.service.js';

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

/**
 * A busca do Kommo sugere; os dígitos decidem.
 *
 * Contexto de 25/09/2026: o cérebro dizia "sem cartão" para nove pacientes de Marabá que
 * TINHAM cartão. Ele comparava a franquia contra o nosso banco — o vínculo e o telefone
 * de quem conversou com a IA — e nunca perguntava ao Kommo. Quem entrou por ligação ou é
 * anterior à IA não existia pra ele.
 *
 * A correção pergunta ao Kommo. E a correção traz um risco novo, pior que o bug original:
 * o `query` do Kommo é busca textual e difusa, então ela devolve gente que só *parece*
 * com o que pedimos. Apontar o cartão da pessoa errada é pior do que não achar cartão.
 * Estes testes prendem isso.
 */

test('casa quando os dígitos do telefone batem', () => {
  const achado = cartaoDoContato('+55 94 98438-0185', [
    { id: 1, nome: 'Raimundo Gomes Soares', telefone: '+5594984380185', leadIds: [47657012] },
  ]);
  assert.equal(achado?.leadId, 47657012);
});

test('o 9 que ora está ora não está não separa a mesma linha, nem aqui', () => {
  const achado = cartaoDoContato('+5594984380185', [
    { id: 1, nome: 'Raimundo', telefone: '94 8438-0185', leadIds: [47657012] },
  ]);
  assert.equal(achado?.leadId, 47657012);
});

test('NÃO casa quando o Kommo devolve outra pessoa — mesmo sendo o único resultado', () => {
  const achado = cartaoDoContato('+5594984380185', [
    { id: 1, nome: 'Raimundo Gomes Soares', telefone: '+5594999998888', leadIds: [999] },
  ]);
  assert.equal(achado, null, 'nome parecido com telefone diferente não é a mesma pessoa');
});

test('escolhe o certo no meio do lixo que a busca textual trouxe', () => {
  const achado = cartaoDoContato('+5594984380185', [
    { id: 1, nome: 'Raimundo Gomes', telefone: '+5594111112222', leadIds: [111] },
    { id: 2, nome: 'Outro Raimundo', telefone: '+5594984380185', leadIds: [222] },
    { id: 3, nome: 'Raimundo Soares', telefone: '+5594333334444', leadIds: [333] },
  ]);
  assert.equal(achado?.leadId, 222, 'tem de pegar o do telefone certo, não o do nome parecido');
});

test('contato sem lead não é cartão', () => {
  const achado = cartaoDoContato('+5594984380185', [
    { id: 1, nome: 'Raimundo', telefone: '+5594984380185', leadIds: [] },
  ]);
  assert.equal(achado, null, 'contato solto na agenda do Kommo existe, mas não é cartão');
});

test('com vários cartões no mesmo contato, vale o mais novo', () => {
  const achado = cartaoDoContato('+5594984101974', [
    { id: 1, nome: 'Aparecida', telefone: '+5594984101974', leadIds: [35340330, 40277088] },
  ]);
  assert.equal(achado?.leadId, 40277088, 'é o cartão que a recepção está olhando hoje');
});

test('sem telefone do lado da franquia, não casa — vai pro julgamento humano', () => {
  assert.equal(cartaoDoContato(null, [{ id: 1, nome: 'X', telefone: '+5594984380185', leadIds: [7] }]), null);
  assert.equal(cartaoDoContato('', [{ id: 1, nome: 'X', telefone: '+5594984380185', leadIds: [7] }]), null);
  assert.equal(cartaoDoContato('12345', [{ id: 1, nome: 'X', telefone: '+5594984380185', leadIds: [7] }]), null);
});

test('busca sem resultado não inventa cartão', () => {
  assert.equal(cartaoDoContato('+5594984380185', []), null);
});

test('o código continua sem casar por nome — nem depois de perguntar ao Kommo', () => {
  const fonte = readFileSync(new URL('./cerebro.service.ts', import.meta.url), 'utf8');
  const corpo = fonte.slice(fonte.indexOf('export function cartaoDoContato'));
  const fim = corpo.indexOf('\n}\n');
  const funcao = corpo.slice(0, fim);
  assert.ok(
    !/parecencaDeNome|normalizarNome/.test(funcao),
    'cartaoDoContato não pode olhar nome: quem decide é o telefone',
  );
});
