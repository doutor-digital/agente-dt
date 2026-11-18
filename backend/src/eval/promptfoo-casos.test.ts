import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BANCO, type Caso } from './banco.js';
import {
  RUBRICA,
  avaliarConferencias,
  conversaLegivel,
  mensagensDaJuiza,
  saidaLegivel,
  testeDoCaso,
  testesDoBanco,
} from './promptfoo-casos.js';

/**
 * Testes da ponte com o Promptfoo — nenhum chama modelo, banco de dados ou o próprio Promptfoo.
 * Servem para a ponte não esconder caso nem aprovar o que o `npm run eval` reprova.
 */

const casoDeExemplo: Caso = {
  id: 'exemplo',
  titulo: 'Título',
  unidade: 'doutor-hernia-porto',
  porque: 'Porque sim',
  historico: [
    { de: 'paciente', texto: 'oi   tudo\nbem? {{nao_e_variavel}}' },
    { de: 'sofia', texto: 'Oi! Como posso ajudar?' },
    { de: 'paciente', texto: 'quanto custa' },
  ],
  espera: { precoDoCatalogo: true },
};

test('todo caso do banco vira exatamente um teste, sem perder nenhum', () => {
  const testes = testesDoBanco();
  assert.equal(testes.length, BANCO.length);
  assert.deepEqual(
    testes.map((t) => t.vars.caso),
    BANCO.map((c) => c.id),
  );
});

test('cada teste tem a conferência fixa E a juíza', () => {
  const t = testeDoCaso(casoDeExemplo);
  assert.deepEqual(
    t.assert.map((a) => a.type),
    ['javascript', 'llm-rubric'],
  );
  assert.equal(t.assert[0]!.value, 'file://conferencias.mjs:conferencias');
  assert.equal(t.assert[1]!.value, RUBRICA);
});

test('a descrição começa pelo id (é por ela que o --filter-pattern acha o caso)', () => {
  const t = testeDoCaso(casoDeExemplo);
  assert.ok(t.description.startsWith('exemplo '));
  assert.ok(t.description.includes('doutor-hernia-porto'));
});

test('a rubrica usa as variáveis do teste, e todas elas existem', () => {
  const t = testeDoCaso(casoDeExemplo);
  const usadas = [...RUBRICA.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!);
  assert.deepEqual(usadas.sort(), ['conversa', 'porque', 'titulo']);
  for (const v of usadas) assert.ok((t.vars as Record<string, string>)[v], `variável ${v} vazia`);
});

test('conversa legível: uma fala por linha, quem falou, espaços colapsados', () => {
  assert.equal(
    conversaLegivel(casoDeExemplo),
    'Paciente: oi tudo bem? {{nao_e_variavel}}\nSofia: Oi! Como posso ajudar?\nPaciente: quanto custa',
  );
});

test('filtro por caso e por unidade, igual ao npm run eval', () => {
  const primeiro = BANCO[0]!;
  assert.deepEqual(
    testesDoBanco({ caso: primeiro.id }).map((t) => t.vars.caso),
    [primeiro.id],
  );
  const daUnidade = testesDoBanco({ unidade: primeiro.unidade });
  assert.ok(daUnidade.length >= 1);
  assert.ok(daUnidade.every((t) => t.vars.unidade === primeiro.unidade));
});

test('filtro que não bate em nada é erro, não "0 testes, tudo verde"', () => {
  assert.throws(() => testesDoBanco({ caso: 'nao-existe' }), /Nenhum caso bate/);
});

test('saída legível mostra as ferramentas chamadas (sem elas a juíza reprovaria "vou ver a agenda")', () => {
  assert.equal(saidaLegivel('Vou ver a agenda', []), 'Vou ver a agenda');
  assert.equal(
    saidaLegivel('Vou ver a agenda', ['consultar_horarios']),
    'Vou ver a agenda\n\n[ferramentas chamadas: consultar_horarios]',
  );
  assert.equal(saidaLegivel('  ', []), '(sem texto)');
});

test('conferências: passa só sem falha; guardrail avisa mas não reprova (igual ao CLI)', () => {
  const ok = avaliarConferencias({ falhas: [], guardrailAgiu: false });
  assert.equal(ok.pass, true);

  const comGuardrail = avaliarConferencias({ falhas: [], guardrailAgiu: true });
  assert.equal(comGuardrail.pass, true);
  assert.match(comGuardrail.reason, /guardrail/);

  const ruim = avaliarConferencias({
    falhas: [{ regra: 'preco_errado', detalhe: 'disse R$ 100' }],
    guardrailAgiu: false,
  });
  assert.equal(ruim.pass, false);
  assert.equal(ruim.score, 0);
  assert.match(ruim.reason, /preco_errado: disse R\$ 100/);
});

test('quando o guardrail reescreve, a razão mostra os gatilhos e o texto de antes (erro do modelo × da reescrita)', () => {
  const r = avaliarConferencias({
    falhas: [],
    guardrailAgiu: true,
    gatilhosDoGuardrail: ['preco_fora_do_catalogo'],
    textoAntesDoGuardrail: 'sinal de   R$ 50\nno Pix',
  });
  assert.equal(r.pass, true);
  assert.match(r.reason, /\(preco_fora_do_catalogo\)/);
  assert.match(r.reason, /Antes do guardrail: "sinal de R\$ 50 no Pix"/);
});

test('conferências sem metadata reprovam (nunca aprovam no escuro)', () => {
  assert.equal(avaliarConferencias(undefined).pass, false);
  assert.equal(avaliarConferencias(null).pass, false);
  assert.equal(avaliarConferencias({}).pass, false);
});

test('mensagens da juíza: o JSON do Promptfoo vira system + user', () => {
  const m = mensagensDaJuiza(
    JSON.stringify([
      { role: 'system', content: 'Você avalia.' },
      { role: 'user', content: 'Resposta: oi' },
    ]),
  );
  assert.equal(m.length, 2);
  assert.equal(m[0]!.getType(), 'system');
  assert.equal(m[0]!.content, 'Você avalia.');
  assert.equal(m[1]!.getType(), 'human');
  assert.equal(m[1]!.content, 'Resposta: oi');
});

test('mensagens da juíza: texto que não é o JSON esperado vira uma mensagem só (degrada, não quebra)', () => {
  for (const prompt of ['avalie isto', '[]', '{"role":"user"}', '[1,2]']) {
    const m = mensagensDaJuiza(prompt);
    assert.equal(m.length, 1, prompt);
    assert.equal(m[0]!.getType(), 'human');
    assert.equal(m[0]!.content, prompt);
  }
});
