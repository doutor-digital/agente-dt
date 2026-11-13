/**
 * Quais regras entram no prompt (13/11/2026): as escritas pela clínica entram sempre; as demais completam as vagas (mais antigas
 * primeiro); texto repetido ocupa uma vaga só; a ordem final é a de criação.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escolherLicoesDoPrompt } from './lessons.service.js';

let n = 0;
const l = (source: string, content = `regra ${++n}`) => ({ id: `l${++n}`, content, source, createdAt: new Date(Date.UTC(2026, 8, 1) + n * 3_600_000) });

test('com mais de 40 regras da reflexão, a regra nova da unidade entra mesmo assim', () => {
  const reflexao = Array.from({ length: 50 }, () => l('reflexao-auto'));
  const daUnidade = l('unidade', 'Diga o valor antes de perguntar da dor.');
  const r = escolherLicoesDoPrompt([...reflexao, daUnidade], 40);
  assert.equal(r.length, 40);
  assert.ok(r.includes(daUnidade));
  assert.deepEqual(r.slice(0, 39), reflexao.slice(0, 39), 'as demais: as mais antigas primeiro');
  assert.equal(r.at(-1), daUnidade, 'ordem de criação');
});

test('texto repetido (mesmo conteúdo, espaços e maiúsculas à parte) ocupa uma vaga só', () => {
  const a = l('reflexao-auto', 'Peça o nome do paciente.');
  const b = l('reflexao-auto', '  peça o nome   do paciente. ');
  const c = l('manual', 'Outra regra.');
  assert.deepEqual(escolherLicoesDoPrompt([b, a, c]), [a, c]);
});

test('até o teto, nada muda', () => {
  const lista = [l('manual'), l('reflexao-auto'), l('unidade')];
  assert.deepEqual(escolherLicoesDoPrompt(lista), lista);
});

test('regra da clínica igual a uma automática fora do teto: a da clínica fica (achado do sênior)', () => {
  const reflexao = Array.from({ length: 45 }, (_, i) => l('reflexao-auto', `Regra automática ${i}.`));
  const automaticaIgual = l('reflexao-auto', 'Diga o valor antes de perguntar da dor.'); // a 46ª automática, fora do teto
  const daUnidade = l('unidade', '  diga o valor antes de perguntar  da dor. ');
  const r = escolherLicoesDoPrompt([...reflexao, automaticaIgual, daUnidade], 40);
  assert.ok(r.includes(daUnidade), 'a da clínica entra');
  assert.ok(!r.includes(automaticaIgual), 'a cópia automática não ocupa vaga');
  assert.equal(r.length, 40);
});
