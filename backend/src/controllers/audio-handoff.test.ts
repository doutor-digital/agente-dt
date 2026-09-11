import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instrucaoAudioNaoTranscrito } from './webhook.controller.js';

// Boa Vista está na API NÃO OFICIAL do WhatsApp: o áudio não chega num formato
// que a gente consiga baixar, então a transcrição falha SEMPRE. Pedir pro
// paciente digitar funciona quando a falha é eventual; quando é estrutural,
// vira a mesma frase toda vez e o paciente é quem paga por um problema nosso.
//
// Cuidado ao escrever asserção aqui: os dois textos contêm instruções NEGATIVAS
// ("NÃO peça pra ele gravar de novo"), então procurar o substring solto acusa
// falso positivo. Teste o que a frase MANDA fazer, não que a palavra sumiu.

test('unidade que consegue ouvir: pede pra repetir ou escrever', () => {
  const t = instrucaoAudioNaoTranscrito(false);
  assert.match(t, /Peça com gentileza pra ele gravar de novo ou escrever/i);
  assert.doesNotMatch(t, /pausar_ia/);
});

test('unidade que não consegue ouvir: pausa e passa pra equipe', () => {
  const t = instrucaoAudioNaoTranscrito(true);
  assert.match(t, /Chame pausar_ia/);
  assert.match(t, /algu[ée]m da equipe/i);
  assert.match(t, /Não siga a conversa/i);
});

test('unidade que não consegue ouvir: proíbe pedir pro paciente escrever', () => {
  const t = instrucaoAudioNaoTranscrito(true);
  assert.match(t, /NÃO peça pra ele gravar de novo nem pra escrever/);
  // não pode sobrar um pedido POSITIVO de repetir
  assert.doesNotMatch(t, /Peça com gentileza/i);
});

test('nenhum dos dois culpa o idioma do paciente', () => {
  // o texto pode citar "português" — desde que seja pra PROIBIR a culpa
  assert.match(instrucaoAudioNaoTranscrito(false), /NÃO diga que ele falou em outro idioma/);
  assert.doesNotMatch(instrucaoAudioNaoTranscrito(true), /idioma|portugu[eê]s/i);
});

test('os dois caminhos assumem a falha como nossa, não do paciente', () => {
  assert.match(instrucaoAudioNaoTranscrito(false), /nossa capta[çc][ãa]o/i);
  assert.match(instrucaoAudioNaoTranscrito(true), /a gente não consegue ouvir/i);
});
