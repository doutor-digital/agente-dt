import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizaTexto,
  similaridade,
  dedupCandidates,
  formatarHistorico,
  ABORDAGENS,
  type Candidato,
} from './strategy-lab.service.js';

const cand = (texto: string, i = 0): Candidato => ({
  abordagem: ABORDAGENS[i % 3].key,
  titulo: ABORDAGENS[i % 3].titulo,
  texto,
  alertas: [],
});

test('normalizaTexto tira acento, caixa e pontuação', () => {
  assert.equal(normalizaTexto('Olá, TUDO bem?'), 'ola tudo bem');
  assert.equal(normalizaTexto('  já   foi  '), 'ja foi');
});

test('similaridade: texto igual = 1, texto sem relação = baixo', () => {
  assert.equal(similaridade('vamos marcar sua consulta', 'vamos marcar sua consulta'), 1);
  assert.ok(similaridade('vamos marcar sua consulta', 'o tempo está bom hoje') < 0.2);
});

test('similaridade não quebra com texto vazio', () => {
  assert.equal(similaridade('', 'qualquer coisa'), 0);
  assert.equal(similaridade('', ''), 0);
});

test('dedup remove candidato praticamente clonado', () => {
  const out = dedupCandidates([
    cand('Consegue vir quinta às 9h?', 0),
    cand('Consegue vir quinta as 9h', 1), // mesmo texto, sem acento/pontuação
    cand('Prefere de manhã ou à tarde?', 2),
  ]);
  assert.equal(out.length, 2);
});

test('dedup mantém opções realmente diferentes', () => {
  const out = dedupCandidates([
    cand('Consegue vir quinta às 9h?', 0),
    cand('Entendo a preocupação com o valor; dá pra parcelar.', 1),
    cand('Prefere de manhã ou à tarde?', 2),
  ]);
  assert.equal(out.length, 3);
});

test('dedup descarta texto vazio', () => {
  const out = dedupCandidates([cand('   ', 0), cand('Texto real aqui', 1)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].texto, 'Texto real aqui');
});

test('formatarHistorico rotula quem falou e corta as mais antigas', () => {
  const msgs = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `msg ${i}`,
  }));
  const out = formatarHistorico(msgs, 5);
  const linhas = out.split('\n');
  assert.equal(linhas.length, 5);
  assert.ok(out.includes('msg 29'));
  assert.ok(!out.includes('msg 10'));
  assert.ok(/Paciente:|Atendente:/.test(out));
});

test('as 3 abordagens são distintas — é a fonte da diversidade', () => {
  const keys = new Set(ABORDAGENS.map((a) => a.key));
  assert.equal(keys.size, 3);
});
