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

test('10/11: formigamento SOZINHO não dispara a triagem (regra <sinal_de_alerta>)', () => {
  const b = renderFaltaParaAgendar({ nome: 'Carla', queixa: 'dor lombar que desce pra perna com formigamento' });
  assert.ok(!/ANTES DE QUALQUER COISA/.test(b));
});

test('10/11: a triagem nunca manda repetir a pergunta de segurança', () => {
  const b = renderFaltaParaAgendar({ nome: 'Núbia', queixa: 'dor no pescoço com dormência no braço' });
  assert.match(b, /NÃO repita a pergunta/);
  assert.ok(!/repita a pergunta com gentileza/.test(b));
  assert.match(b, /<sinal_de_alerta>/);
});

test('10/11: formigamento na virilha / região íntima / entre as pernas CONTINUA disparando (cauda equina)', () => {
  for (const q of ['formigamento na virilha', 'formigamento entre as pernas', 'formigamento na região íntima', 'sinto a virilha com formigamento']) {
    const b = renderFaltaParaAgendar({ nome: 'Ana', queixa: q });
    assert.match(b, /ANTES DE QUALQUER COISA/, q);
  }
});

test('10/11: a triagem continua pedindo a força E depois o xixi e o intestino', () => {
  const b = renderFaltaParaAgendar({ nome: 'Ana', queixa: 'dormência na perna' });
  assert.match(b, /primeiro a força, depois o xixi e o intestino/);
  assert.match(b, /pausar_ia com sinalDeAlerta: true/);
});

// ── 27/11/2026: «localizacao» é onde dói, não a cidade ───────────────────────────────────────────────────

test('27/11: «localizacao» (onde dói) NÃO conta como cidade — a lista ainda manda perguntar a cidade antes do horário', () => {
  const b = renderFaltaParaAgendar({ nome: 'Ana', queixa: 'lombar', tempo_dor: '2 anos', localizacao: 'lombar, lado direito' });
  assert.match(b, /Ainda falta, nesta ordem: cidade → horário escolhido/);
  assert.match(b, /Próximo passo: pergunte em qual cidade ele mora, antes de oferecer qualquer horário/);
});

test('27/11: «localizacao» continua contando como queixa (onde dói), só não como cidade', () => {
  const b = renderFaltaParaAgendar({ nome: 'Ana', localizacao: 'lombar' });
  assert.ok(!/falta.*queixa/i.test(b));
  assert.match(b, /cidade/);
});

test('27/11: cidade que veio de apelido mas é parte do corpo (fatos-canonicos grava localizacao como cidade) também não vale', () => {
  for (const lixo of ['lombar', 'coluna cervical', 'costas', 'lado direito', 'região do quadril', 'ciático']) {
    const b = renderFaltaParaAgendar({ nome: 'Ana', queixa: 'dor', tempo_dor: '1 ano', cidade: lixo });
    assert.match(b, /cidade → horário escolhido/, lixo);
  }
});

test('27/11: cidade de verdade conta, de qualquer nome de fato', () => {
  for (const [k, v] of [['cidade', 'Imperatriz'], ['municipio', 'Canaã dos Carajás'], ['cidade_paciente', 'São Paulo'], ['mora_em', 'Marabá']] as const) {
    const b = renderFaltaParaAgendar({ nome: 'Ana', queixa: 'lombar', tempo_dor: '2 anos', [k]: v });
    assert.ok(!/cidade/.test(b), `${k}=${v} deveria contar`);
    assert.match(b, /horário escolhido/);
  }
});

test('27/11: confirmar que consegue vir à unidade também basta; «não» não basta', () => {
  const base = { nome: 'Ana', queixa: 'lombar', tempo_dor: '2 anos' };
  assert.ok(!/cidade/.test(renderFaltaParaAgendar({ ...base, consegue_vir: 'sim' })));
  assert.match(renderFaltaParaAgendar({ ...base, consegue_vir: 'não' }), /cidade → horário escolhido/);
});

test('27/11: sem cidade a lista NÃO diz «você já tem tudo para marcar»', () => {
  const b = renderFaltaParaAgendar({ nome: 'Ana', queixa: 'lombar', tempo_dor: '2 anos', preferencia_horario: 'terça 10h', localizacao: 'lombar' });
  assert.ok(!/já tem tudo/.test(b));
  assert.match(b, /Ainda falta, nesta ordem: cidade/);
});
