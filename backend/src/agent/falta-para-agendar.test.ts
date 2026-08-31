import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderFaltaParaAgendar } from './falta-para-agendar.js';

test('conversa nova: cobra o nome primeiro', () => {
  const b = renderFaltaParaAgendar({ interesse: 'sim' });
  assert.match(b, /nome/);
  assert.match(b, /Próximo passo/);
});

test('aceita os vários nomes que a IA inventa pra mesma coisa', () => {
  // em produção convivem queixa, queixa_principal, dor e localizacao_dor
  for (const chave of ['queixa', 'queixa_principal', 'dor', 'localizacao_dor']) {
    const b = renderFaltaParaAgendar({ nome: 'Ana', [chave]: 'lombar' });
    assert.ok(!/falta.*queixa/i.test(b), `${chave} deveria contar como queixa`);
  }
});

test('caso da Núbia: dormência sem resposta vira a prioridade', () => {
  const b = renderFaltaParaAgendar({ nome: 'Núbia', queixa: 'dor no pescoço com dormência no braço' });
  assert.match(b, /ANTES DE QUALQUER COISA/);
  assert.match(b, /espere a\s+resposta/i);
});

test('com a resposta do red flag registrada, para de cobrar', () => {
  const b = renderFaltaParaAgendar({
    nome: 'Núbia', queixa: 'dor com dormência', perda_forca: 'não',
  });
  assert.ok(!/ANTES DE QUALQUER COISA/.test(b));
});

test('queixa sem sinal neurológico não dispara triagem', () => {
  const b = renderFaltaParaAgendar({ nome: 'Ana', queixa: 'dor lombar ao levantar peso' });
  assert.ok(!/ANTES DE QUALQUER COISA/.test(b));
});

test('quem já agendou não recebe cobrança nenhuma', () => {
  assert.equal(renderFaltaParaAgendar({ nome: 'Ana', agendou: 'Sim' }), '');
  assert.equal(renderFaltaParaAgendar({ nome: 'Ana', consulta_marcada: 'sim' }), '');
});

test('tudo preenchido e ainda não agendou: manda fechar', () => {
  const b = renderFaltaParaAgendar({
    nome: 'Ana', queixa: 'lombar', tempo_dor: '2 anos', cidade: 'Imperatriz',
    preferencia_horario: 'terça 10h',
  });
  assert.match(b, /já tem tudo para marcar/);
});

test('sem fatos nenhum, não polui o prompt', () => {
  assert.equal(renderFaltaParaAgendar({}), '');
  assert.equal(renderFaltaParaAgendar(null), '');
});

test('fato vazio conta como ausente', () => {
  const b = renderFaltaParaAgendar({ nome: '   ', queixa: 'lombar' });
  assert.match(b, /nome/);
});
