import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corrigirPrecoDoConvenio, precoDoConvenio } from './preco-convenio.js';

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

test('lê o desconto único da ficha de Bebedouro e Olímpia', () => {
  const ficha =
    'VALOR: R$ 250 no dia, pago na clínica, OU R$ 200 com pagamento antecipado por Pix.\n' +
    'CONVÊNIO: a clínica NÃO atende plano de saúde.\n' +
    'Mas quem apresenta a carteirinha do plano paga R$ 150 na consulta.';
  assert.equal(precoDoConvenio([ficha], { antecipado: 200, noDia: 250 }), 150);
});

test('unidade com TABELA de plano (Serra) fica de fora', () => {
  // Lá o plano tem o próprio antecipado: corrigir subiria o preço de quem tem plano.
  const serra =
    'NO DIA DA CONSULTA: R$ 350 — para qualquer pessoa, com ou sem plano de saúde.\n' +
    '- Com plano de saúde: R$ 200.\n' +
    '- Com PLANO DE SAÚDE: R$ 250 · R$ 220 com pagamento antecipado.';
  assert.equal(precoDoConvenio([serra], { antecipado: 280, noDia: 350 }), null);
});

test('a linha anti-alucinação da ficha não desliga a trava', () => {
  // Quase toda ficha tem essa linha; ela cita PIX e convênio sem ser tabela de preço.
  const ficha =
    'VALOR: R$ 250 no dia, OU R$ 200 com pagamento antecipado por Pix.\n' +
    'NUNCA invente preço, endereço, horário, chave PIX, vaga, convênio.\n' +
    'Quem apresenta a carteirinha do plano paga R$ 150 na consulta.';
  assert.equal(precoDoConvenio([ficha], { antecipado: 200, noDia: 250 }), 150);
});

test('sem convênio na ficha, não há valor e a trava fica inerte', () => {
  assert.equal(precoDoConvenio(['VALOR: R$ 350 no dia, ou R$ 250 antecipado por Pix.'], { antecipado: 250, noDia: 350 }), null);
});

test('instrução da ficha que repete os preços particulares não conta como tabela', () => {
  // Bebedouro: "sem a carteirinha fica R$ 250, ou R$ 200 pagando antes no Pix"
  // — os valores são os particulares da própria unidade, é recado pra Sofia.
  const ficha =
    'Sem a carteirinha, fica R$ 250, ou R$ 200 pagando antes no Pix.\n' +
    'Quem tem plano de saúde: desconto na consulta de R$ 250 por R$ 150, apresentando a carteirinha.';
  assert.equal(precoDoConvenio([ficha], { antecipado: 200, noDia: 250 }), 150);
});
