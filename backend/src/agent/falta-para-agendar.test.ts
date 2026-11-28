import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cidadeConhecida, renderFaltaParaAgendar } from './falta-para-agendar.js';

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

test('27/11: cidade com nome de parte do corpo (Braço do Norte, Dores do Indaiá) CONTA — o filtro é por valor, não por palavra solta', () => {
  for (const cidade of ['Braço do Norte', 'Dores do Indaiá', 'Lagoa da Prata', 'Costa Rica', 'São José do Rio Preto', 'São João da Boa Vista', 'Campo Grande, Mato Grosso do Sul']) {
    const b = renderFaltaParaAgendar({ nome: 'Ana', queixa: 'lombar', tempo_dor: '2 anos', cidade });
    assert.ok(!/cidade/.test(b), `${cidade} deveria contar`);
  }
  for (const lixo of ['dor na lombar que desce pra perna', 'Lombar', 'Lado direito', 'dores nas costas']) {
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

test('reprovação C: cidade composta em MINÚSCULA continua cidade (as palavras de ligação não são corpo)', () => {
  for (const cidade of ['canaã dos carajás', 'rio de janeiro', 'são josé do rio preto', 'eldorado dos carajás', 'marabá', 'parauapebas', 'são paulo']) {
    const b = renderFaltaParaAgendar({ nome: 'Ana', queixa: 'lombar', tempo_dor: '2 anos', cidade });
    assert.ok(!/cidade/.test(b), `${cidade} deveria contar`);
  }
  // e a frase de dor só de corpo + ligação continua recusada
  for (const lixo of ['dor na lombar', 'dor na lombar que desce pra perna', 'lombar e quadril', 'do lado direito']) {
    const b = renderFaltaParaAgendar({ nome: 'Ana', queixa: 'dor', tempo_dor: '1 ano', cidade: lixo });
    assert.match(b, /cidade → horário escolhido/, lixo);
  }
});

test('reprovação D: cartão ANTIGO com localizacao=cidade de verdade conta; localizacao=lombar não', () => {
  const base = { nome: 'Ana', queixa: 'dor', tempo_dor: '2 anos' };
  assert.ok(!/cidade/.test(renderFaltaParaAgendar({ ...base, localizacao: 'Imperatriz' })));
  assert.ok(cidadeConhecida({ localizacao: 'Imperatriz' }));
  assert.ok(!cidadeConhecida({ localizacao: 'lombar' }));
  assert.match(renderFaltaParaAgendar({ ...base, localizacao: 'lombar' }), /cidade → horário escolhido/);
});

test('nit: consegue_vir "nunca"/"talvez"/"não sei" NÃO conta; "sim"/"consegue" conta', () => {
  for (const v of ['nunca', 'talvez', 'não sei', 'nao', 'depende']) assert.ok(!cidadeConhecida({ consegue_vir: v }), v);
  for (const v of ['sim', 'Sim, consigo', 'consegue', 'true']) assert.ok(cidadeConhecida({ consegue_vir: v }), v);
});

// ── 3ª rodada do sênior (#519) ────────────────────────────────────────────────────────────────────────

test('1: consegue_vir só vale com afirmação CLARA; negação em qualquer lugar vence', () => {
  for (const v of ['claro que não', 'pode ser que não', 'consegue não', 'ok mas moro longe', 'sim mas só aos sábados', 'não consigo', 'nunca', 'talvez', 'depende do horário']) {
    assert.ok(!cidadeConhecida({ consegue_vir: v }), `não deveria contar: ${v}`);
  }
  for (const v of ['sim', 'Sim, consigo', 'consegue', 'true', 'claro', 'com certeza', 'ok', 'tranquilo']) {
    assert.ok(cidadeConhecida({ consegue_vir: v }), `deveria contar: ${v}`);
  }
});

test('2: partes do corpo no plural, com acento, com parênteses ou em frase NÃO são cidade', () => {
  for (const v of [
    'Ombros', 'joelhos', 'glúteos', 'pés', 'hérnia de disco', 'Cabeça', 'nádega', 'cóccix', 'Lombar (L4-L5)', 'lombares', 'costas', 'Pescoço',
    'dores nas costas', 'Hérnia de Disco L4-L5', 'quadris', 'lombar crônica', 'dor no pescoço com formigamento', 'protrusão discal',
  ]) {
    const b = renderFaltaParaAgendar({ nome: 'Ana', queixa: 'dor', tempo_dor: '1 ano', cidade: v });
    assert.match(b, /cidade → horário escolhido/, v);
    assert.ok(!cidadeConhecida({ cidade: v }), v);
  }
});

test('nit: cidade com nome de corpo FRACO em minúscula continua cidade (alta floresta, braço do norte, dores do indaiá)', () => {
  for (const v of ['alta floresta', 'braço do norte', 'dores do indaiá', 'baixa grande', 'Alta Floresta']) {
    assert.ok(cidadeConhecida({ cidade: v }), v);
  }
});

// ── 4ª rodada do sênior (#519) ────────────────────────────────────────────────────────────────────────

test('placeholder e "não sei a cidade" NÃO são cidade (medido em 30 dias de fatos reais)', () => {
  for (const v of [
    'não informado', 'Não informada', 'não especificada', 'nao especificado', 'não sei', 'não sei a cidade', 'sem cidade', 'Sem informação',
    'desconhecida', 'Cidade desconhecida', 'fora de Marabá', 'Fora de Imperatriz', 'Interior do Pará', 'interior', 'outra cidade', 'Outro estado',
    '?', '-', '--', 'n/a', 'N/A', 'NA', 'nenhuma', 'indefinido',
  ]) {
    assert.ok(!cidadeConhecida({ cidade: v }), `não deveria contar: ${v}`);
    assert.match(renderFaltaParaAgendar({ nome: 'Ana', queixa: 'dor', tempo_dor: '1 ano', cidade: v }), /cidade → horário escolhido/, v);
  }
  // cidades de verdade que começam parecido continuam valendo
  for (const v of ['Natal', 'Nova Iguaçu', 'Não-Me-Toque', 'Foz do Iguaçu', 'Fortaleza', 'Interlagos', 'Santa Inês']) {
    assert.ok(cidadeConhecida({ cidade: v }), `deveria contar: ${v}`);
  }
});

test('LIMITE CONHECIDO: "Sem Peixe" (RS) é cidade de verdade, mas começa por "sem" e é recusada junto com "sem cidade"; na dúvida a Sofia pergunta', () => {
  // aceito de propósito: custa uma pergunta a mais a quem mora em Sem Peixe, e evita tratar "sem informação" como cidade (1.015 valores reais medidos)
  assert.ok(!cidadeConhecida({ cidade: 'Sem Peixe' }));
});

test('"Interior de Boa Vista" / "interior do Pará" / "fora de Marabá" são lugar sem nome exato: recusados (limite conhecido)', () => {
  for (const v of ['Interior de Boa Vista', 'interior do Pará', 'Fora de Marabá']) assert.ok(!cidadeConhecida({ cidade: v }), v);
  assert.ok(cidadeConhecida({ cidade: 'Boa Vista' }));
});
