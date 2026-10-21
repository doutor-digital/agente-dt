import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regraDoNome } from './follow-up.js';
import { nomeApresentavel } from '../lib/nome-apresentavel.js';

// O degrau da régua (e a reativação) é escrito pelo modelo; a instrução diz qual nome usar — ou que não use nenhum.

test('régua: com nome no título, o modelo só pode usar esse nome', () => {
  const r = regraDoNome(nomeApresentavel('CRISTINA REGIA 15/10/26', 'Cris 💅'));
  assert.match(r, /use só "Cristina"/);
  assert.match(r, /Nenhum outro nome, apelido ou nome de perfil/);
});

test('régua: perfil "Meu Único Amigo É Deus" sem nome no título → não chama pelo nome', () => {
  const r = regraDoNome(nomeApresentavel('Lead #28659614', 'Meu Único Amigo É Deus'));
  assert.match(r, /NÃO chame o paciente pelo nome/);
  assert.match(r, /\("Oi!"\)/);
});
