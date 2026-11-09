import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cartaoDoAgente, chaveDoTrabalhadorConfere, entraSozinha, lerModoClaude, lerResultado, podeMandarPeloPainel } from './suporte-claude.js';

const CHAVE = 'a'.repeat(32);

test('modo: só "ligado" liga; o resto é desligado', () => {
  assert.equal(lerModoClaude({} as NodeJS.ProcessEnv), 'desligado');
  assert.equal(lerModoClaude({ SUPORTE_CLAUDE: ' LIGADO ' } as NodeJS.ProcessEnv), 'ligado');
  assert.equal(lerModoClaude({ SUPORTE_CLAUDE: 'sim' } as NodeJS.ProcessEnv), 'desligado');
});

test('chave do trabalhador: confere em tempo constante; sem chave, curta ou errada = recusa', () => {
  const env = { SUPORTE_CLAUDE_CHAVE: CHAVE } as NodeJS.ProcessEnv;
  assert.equal(chaveDoTrabalhadorConfere(CHAVE, env), true);
  assert.equal(chaveDoTrabalhadorConfere('b'.repeat(32), env), false);
  assert.equal(chaveDoTrabalhadorConfere(undefined, env), false);
  assert.equal(chaveDoTrabalhadorConfere(['x'], env), false);
  assert.equal(chaveDoTrabalhadorConfere('', { SUPORTE_CLAUDE_CHAVE: '' } as NodeJS.ProcessEnv), false);
  assert.equal(chaveDoTrabalhadorConfere('curta', { SUPORTE_CLAUDE_CHAVE: 'curta' } as NodeJS.ProcessEnv), false, 'chave com menos de 24 caracteres não vale');
});

test('entra sozinha na fila: só agente ligado + número verificado pelo grupo + ainda não foi para o agente', () => {
  assert.equal(entraSozinha('ligado', 'grupo', null), true);
  assert.equal(entraSozinha('desligado', 'grupo', null), false);
  assert.equal(entraSozinha('ligado', 'texto', null), false, 'quem só disse a unidade não aciona o agente sozinho');
  assert.equal(entraSozinha('ligado', 'nenhuma', null), false);
  assert.equal(entraSozinha('ligado', 'grupo', 'feito'), false);
});

test('mandar pelo painel: não manda resolvida, nem o que já está na fila/trabalhando; pode mandar de novo depois de feito/falhou', () => {
  assert.deepEqual(podeMandarPeloPainel('aberta', null), { ok: true });
  assert.deepEqual(podeMandarPeloPainel('reaberta', 'feito'), { ok: true });
  assert.deepEqual(podeMandarPeloPainel('aberta', 'falhou'), { ok: true });
  assert.equal(podeMandarPeloPainel('resolvida', null).ok, false);
  assert.equal(podeMandarPeloPainel('aberta', 'fila').ok, false);
  assert.equal(podeMandarPeloPainel('aberta', 'trabalhando').ok, false);
});

test('resultado: só aceita PR deste repositório; corta textos; sem resumo = recusa', () => {
  const bom = lerResultado({ ok: true, resumo: ' feito ', prUrl: 'https://github.com/doutor-digital/agente-dt/pull/250', precisaPessoa: false, oQueFazer: '' });
  assert.ok(bom.ok);
  assert.deepEqual(bom.ok && bom.r, { ok: true, resumo: 'feito', prUrl: 'https://github.com/doutor-digital/agente-dt/pull/250', precisaPessoa: false, oQueFazer: null });
  for (const pr of ['https://github.com/outro/agente-dt/pull/1', 'https://evil.com/doutor-digital/agente-dt/pull/1', 'https://github.com/doutor-digital/agente-dt/pull/1?x', 'javascript:alert(1)']) {
    assert.equal(lerResultado({ resumo: 'r', prUrl: pr }).ok, false, pr);
  }
  assert.equal(lerResultado({ resumo: '' }).ok, false);
  assert.equal(lerResultado(null).ok, false);
  const longo = lerResultado({ resumo: 'x'.repeat(5000), oQueFazer: 'y'.repeat(5000) });
  assert.ok(longo.ok && longo.r.resumo.length === 2000 && longo.r.oQueFazer!.length === 2000);
  assert.equal(lerResultado({ resumo: 'r' }).ok && lerResultado({ resumo: 'r' }).ok, true);
  const semCampos = lerResultado({ resumo: 'r' });
  assert.ok(semCampos.ok && semCampos.r.ok === true && semCampos.r.precisaPessoa === true && semCampos.r.prUrl === null);
});

test('cartão do agente: PR, o que fazer e o lembrete do "Resolvido"', () => {
  const t = cartaoDoAgente(7, { ok: true, resumo: 'Corrigi o filtro.', prUrl: 'https://github.com/doutor-digital/agente-dt/pull/250', precisaPessoa: true, oQueFazer: 'Revisar e mesclar.' });
  assert.match(t, /^🤖 Claude trabalhou na #7\nCorrigi o filtro\./);
  assert.match(t, /PR para revisar e mesclar: https:\/\/github\.com\/doutor-digital\/agente-dt\/pull\/250/);
  assert.match(t, /O que uma pessoa precisa fazer: Revisar e mesclar\./);
  assert.match(t, /marque "Resolvido" no painel/);
  assert.match(cartaoDoAgente(8, { ok: false, resumo: 'x', prUrl: null, precisaPessoa: true, oQueFazer: null }), /#8 \(NÃO concluiu\)/);
});
