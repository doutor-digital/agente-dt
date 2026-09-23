import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convenioDaUnidade, corrigirPrecoDoConvenio, precoDoConvenio } from './preco-convenio.js';

// Bebedouro: 250 na clínica, 200 no Pix antecipado, 150 só com carteirinha.
const BEBEDOURO = { antecipado: 200, convenio: 150 };
const P = { antecipado: 200 };

test('as duas frases reais que a Sofia mandou ao Dorival em 23/09', () => {
  const a = corrigirPrecoDoConvenio(
    'A consulta é R$ 250 na clínica no dia, ou R$ 150 se pagar antes pela chave Pix.',
    BEBEDOURO,
  );
  assert.equal(a.corrigiu, true);
  assert.equal(a.texto, 'A consulta é R$ 250 na clínica no dia, ou R$ 200 se pagar antes pela chave Pix.');

  const b = corrigirPrecoDoConvenio('O valor antecipado é R$ 150, e pagando antes você garante a vaga.', BEBEDOURO);
  assert.equal(b.corrigiu, true);
  assert.equal(b.texto, 'O valor antecipado é R$ 200, e pagando antes você garante a vaga.');
});

test('mensagem de verdade não perde espaço nem quebra de linha', () => {
  // A primeira versão juntava as frases com join('') e entregava tudo grudado;
  // o chunker do Kommo corta em "\n\n" e ". " e picava a mensagem no meio.
  const entrada =
    'Oi, Dorival! 😊\nA consulta antecipada no Pix fica R$ 150.\n\n' +
    'Chave Pix: 57.492.822/0002-35\nTitular: MEP Clínica.\n\nTe espero!';
  const r = corrigirPrecoDoConvenio(entrada, BEBEDOURO);
  assert.equal(r.corrigiu, true);
  assert.equal(r.texto, entrada.replace('R$ 150', 'R$ 200'));
});

test('citou plano em QUALQUER ponto da mensagem: não encosta', () => {
  // Cobrar mais caro de quem tem direito ao desconto é pior que o bug original.
  for (const t of [
    'Com a carteirinha da Unimed a consulta fica R$ 150.',
    'Se você tiver plano de saúde, o valor muda. Pagando antecipado pelo Pix, fica R$ 150.',
    'Com o cartão do seu plano, pagando antes pelo Pix, fica R$ 150.',
    'Você tem seguro saúde? Então o Pix antecipado é R$ 150.',
    'Com a carteirinha do plano (Unimed, Amil etc.) o Pix fica R$ 150.',
    'A consulta é R$ 250 no dia, ou R$ 200 antecipado no Pix. Com a carteirinha do plano fica R$ 150.',
  ]) {
    const r = corrigirPrecoDoConvenio(t, BEBEDOURO);
    assert.equal(r.corrigiu, false, t);
    assert.equal(r.texto, t);
  }
});

test('frase que já traz o antecipado certo é comparação, não engano', () => {
  const t = 'Você falou R$ 150, mas o Pix antecipado é R$ 200.';
  const r = corrigirPrecoDoConvenio(t, BEBEDOURO);
  assert.equal(r.corrigiu, false);
  assert.equal(r.texto, t);
});

test('parcela não vira preço de consulta', () => {
  const t = 'Dá pra dividir em 2x de R$ 150 pelo Pix.';
  const r = corrigirPrecoDoConvenio(t, BEBEDOURO);
  assert.equal(r.corrigiu, false);
  assert.equal(r.texto, t);
});

test('só conserta a frase errada, não estraga o resto da mensagem', () => {
  const t = 'Oi, Ana! A consulta antecipada no Pix fica R$ 150. Chegue 15 minutos antes, tá?';
  const r = corrigirPrecoDoConvenio(t, BEBEDOURO);
  assert.equal(r.texto, 'Oi, Ana! A consulta antecipada no Pix fica R$ 200. Chegue 15 minutos antes, tá?');
});

test('valor do convênio sozinho, sem falar de Pix, não é mexido', () => {
  const t = 'A consulta sai por R$ 150.';
  assert.equal(corrigirPrecoDoConvenio(t, BEBEDOURO).corrigiu, false);
});

test('não confunde valor que apenas começa igual', () => {
  const t = 'O Pix antecipado é R$ 1500 no pacote.';
  assert.equal(corrigirPrecoDoConvenio(t, BEBEDOURO).texto, t);
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
  assert.equal(precoDoConvenio([ficha], P), 150);
});

test('unidade com TABELA de plano (Serra) fica de fora', () => {
  // Lá o plano tem o próprio antecipado: corrigir subiria o preço de quem tem plano.
  const serra =
    'NO DIA DA CONSULTA: R$ 350 — para qualquer pessoa, com ou sem plano de saúde.\n' +
    '- Com plano de saúde: R$ 200.\n' +
    '- Com PLANO DE SAÚDE: R$ 250 · R$ 220 com pagamento antecipado.';
  assert.equal(precoDoConvenio([serra], { antecipado: 280 }), null);
});

test('só entra na trava a unidade declarada no env', () => {
  // Ler a ficha decide o valor, não decide quem entra: uma edição de texto em
  // qualquer clínica não pode armar isso sozinha.
  const ficha = 'VALOR: R$ 250 no dia, OU R$ 200 antecipado por Pix.\nCom a carteirinha do plano paga R$ 150.';
  const base = {
    id: 'u1', updatedAt: new Date(0), sourceProdutos: ficha, sourceNegocio: null,
    sourcePapel: null, systemPrompt: '', spineBookingRequiresPayment: false,
  };
  assert.equal(convenioDaUnidade({ ...base, slug: 'doutor-hernia-bebedouro' }, P), 150);
  assert.equal(convenioDaUnidade({ ...base, slug: 'doutor-hernia-serra' }, P), null);
});

test('unidade com taxa de reserva fica de fora (o antecipado lá é parte do valor)', () => {
  const ficha = 'VALOR: R$ 250 no dia, OU R$ 200 antecipado por Pix.\nCom a carteirinha do plano paga R$ 150.';
  assert.equal(
    convenioDaUnidade(
      { id: 'u2', slug: 'doutor-hernia-bebedouro', updatedAt: new Date(0), sourceProdutos: ficha,
        sourceNegocio: null, sourcePapel: null, systemPrompt: '', spineBookingRequiresPayment: true },
      P,
    ),
    null,
  );
});

test('a linha anti-alucinação da ficha não desliga a trava', () => {
  const ficha =
    'VALOR: R$ 250 no dia, OU R$ 200 com pagamento antecipado por Pix.\n' +
    'NUNCA invente preço, endereço, horário, chave PIX, vaga, convênio.\n' +
    'Quem apresenta a carteirinha do plano paga R$ 150 na consulta.';
  assert.equal(precoDoConvenio([ficha], P), 150);
});

test('instrução da ficha que repete os preços particulares não conta como tabela', () => {
  // Bebedouro: "sem a carteirinha fica R$ 250, ou R$ 200 pagando antes no Pix"
  // — os valores são os particulares da própria unidade, é recado pra Sofia.
  const ficha =
    'Sem a carteirinha, fica R$ 250, ou R$ 200 pagando antes no Pix.\n' +
    'Quem tem plano de saúde: desconto na consulta de R$ 250 por R$ 150, apresentando a carteirinha.';
  assert.equal(precoDoConvenio([ficha], P), 150);
});

test('sem convênio na ficha, não há valor e a trava fica inerte', () => {
  assert.equal(precoDoConvenio(['VALOR: R$ 350 no dia, ou R$ 250 antecipado por Pix.'], { antecipado: 250 }), null);
});
