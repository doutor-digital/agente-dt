import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corrigirPrecoDoConvenio } from './preco-convenio.js';

// Bebedouro: 250 na clínica, 200 no Pix antecipado, 150 só com carteirinha.
const BEBEDOURO = { antecipado: 200, convenio: 150 };

test('as duas frases reais que a Sofia mandou ao Dorival em 23/09', () => {
  const a = corrigirPrecoDoConvenio(
    'A consulta é R$ 250 na clínica no dia, ou R$ 150 se pagar antes pela chave Pix.',
    BEBEDOURO,
  );
  assert.equal(a.corrigiu, true);
  assert.match(a.texto, /R\$ 200 se pagar antes/);
  assert.doesNotMatch(a.texto, /R\$ ?150/);

  const b = corrigirPrecoDoConvenio(
    'A chave Pix é 57.492.822/0002-35, Dorival — o valor antecipado é R$ 150, e pagando antes você garante a vaga.',
    BEBEDOURO,
  );
  assert.equal(b.corrigiu, true);
  assert.match(b.texto, /valor antecipado é R\$ 200/);
});

test('com carteirinha na frase, o valor menor está CERTO e não é tocado', () => {
  for (const frase of [
    'Com a carteirinha da Unimed a consulta fica R$ 150.',
    'Não atendemos pelo convênio, mas quem leva a carteirinha do plano paga R$ 150.',
    'Pagando na clínica com a carteirinha, fica R$ 150.',
  ]) {
    const r = corrigirPrecoDoConvenio(frase, BEBEDOURO);
    assert.equal(r.corrigiu, false, frase);
    assert.equal(r.texto, frase);
  }
});

test('mensagem com os três valores em frases separadas passa intacta', () => {
  const t =
    'A consulta é R$ 250 no dia, ou R$ 200 com Pix antecipado. ' +
    'Se você tiver plano de saúde, apresentando a carteirinha fica R$ 150.';
  const r = corrigirPrecoDoConvenio(t, BEBEDOURO);
  assert.equal(r.corrigiu, false);
  assert.equal(r.texto, t);
});

test('só conserta a frase errada, não estraga o resto da mensagem', () => {
  const t = 'Oi, Ana! A consulta antecipada no Pix fica R$ 150. Chegue 15 minutos antes, tá?';
  const r = corrigirPrecoDoConvenio(t, BEBEDOURO);
  assert.match(r.texto, /Pix fica R\$ 200/);
  assert.match(r.texto, /Chegue 15 minutos antes/);
});

test('valor do convênio sozinho, sem falar de Pix, não é mexido', () => {
  const t = 'A consulta sai por R$ 150.';
  assert.equal(corrigirPrecoDoConvenio(t, BEBEDOURO).corrigiu, false);
});

test('unidade sem desconto de convênio nunca sofre correção', () => {
  const t = 'O valor antecipado é R$ 200 no Pix.';
  const r = corrigirPrecoDoConvenio(t, { antecipado: 200, convenio: 200 });
  assert.equal(r.corrigiu, false);
  assert.equal(r.texto, t);
});

test('texto vazio não quebra', () => {
  assert.equal(corrigirPrecoDoConvenio('', BEBEDOURO).texto, '');
});
