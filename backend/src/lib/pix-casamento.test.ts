import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ehPix, chaveDoNome, compararNomes, compararTokens, entradasDoBanco, nivelPixPessoa, nomeDaDescricao, tokensDoNome, valoresDaOperacaoInvalidos, valoresDaUnidade } from './pix-casamento.js';
import type { LancamentoPluggy } from './integracoes/pluggy.js';

// nomes e documentos INVENTADOS (o repositório é público)
const lanc = (id: string, descricao: string, valor: number, o: Partial<LancamentoPluggy> & { contaTipo?: string } = {}): LancamentoPluggy & { contaTipo?: string } => ({
  id, data: '2026-11-25', descricao, valor, tipo: valor < 0 ? 'saida' : 'entrada', categoria: null, status: 'POSTED', ...o,
});

test('nome: sem acento, sem «da/de/do», sem inicial solta; uma palavra só nunca identifica ninguém', () => {
  assert.deepEqual(tokensDoNome('MARIA da Conceição  d. Silva'), ['maria', 'conceicao', 'silva']);
  assert.equal(chaveDoNome('MARIA DA CONCEIÇÃO SILVA'), 'maria silva');
  assert.equal(chaveDoNome('Maria'), null);
  assert.equal(chaveDoNome(null), null);
  assert.equal(chaveDoNome('Lead 123'), null);
});

test('comparar nomes: primeiro + último iguais é «igual» (o meio e o acento não contam); nome cortado pelo banco é «parecido»; o resto é «nenhum»', () => {
  assert.equal(compararNomes('MARIA CONCEICAO SILVA', 'Maria da Conceição Alves Silva'), 'igual');
  assert.equal(compararNomes('Joao Pedro Santos', 'JOÃO SANTOS'), 'igual');
  assert.equal(compararNomes('MARIA CONCEICAO SIL', 'Maria Conceição Silva'), 'parecido', 'o banco cortou o último nome');
  assert.equal(compararNomes('Maria Silva', 'Maria Souza'), 'nenhum');
  assert.equal(compararNomes('Maria Silva', 'Mariana Silva'), 'nenhum', 'primeiro nome diferente nunca casa');
  assert.equal(compararNomes('Maria', 'Maria Silva'), 'nenhum', 'um nome sem sobrenome nunca casa');
  assert.equal(compararNomes('Maria', 'Maria'), 'nenhum');
});

test('Pix: o nome vem do campo do pagador E da descrição; descrição de empresa (número) não dá nome', () => {
  assert.equal(nomeDaDescricao('Pix MARIA SILVA'), 'MARIA SILVA');
  assert.equal(nomeDaDescricao('pix recebido Ana Souza'), 'Ana Souza');
  assert.equal(nomeDaDescricao('Pix 12.345.678 EMPRESA LTDA'), null);
  assert.equal(nomeDaDescricao('Vendas Mastercard'), null);
  assert.equal(nivelPixPessoa({ nomes: ['Fulana Outra', 'MARIA SILVA'] }, 'Maria Aparecida Silva'), 'igual');
  assert.equal(nivelPixPessoa({ nomes: [] }, 'Maria Silva'), 'nenhum');
});

test('entradas do banco: Pix com nome, vendas de maquininha e o resto separados; pendente, saída e cartão de crédito ficam de fora', () => {
  const r = entradasDoBanco([
    lanc('p1', 'Pix MARIA SILVA', 250, { pagadorTipoDocumento: 'PF' }),
    lanc('p2', 'Pix JOAO SOUZA', 50.5, { pagador: 'João Souza' }),
    lanc('p3', 'Pix 12.345.678 CLINICA TESTE LTDA', 100, { pagadorTipoDocumento: 'PJ' }),
    lanc('v1', 'Vendas Mastercard Crédito', 800),
    lanc('v2', 'Vendas Visa Débito', 200.1),
    lanc('t1', 'TED recebida', 1000),
    lanc('x1', 'Pix ANA PENDENTE', 250, { status: 'PENDING' }),
    lanc('s1', 'Pix enviado FULANO', -250),
    lanc('c1', 'Pix CARTAO', 250, { contaTipo: 'CREDIT' }),
  ]);
  assert.deepEqual(r.pix.map((p) => p.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(r.pix[0], { id: 'p1', dia: '2026-11-25', centavos: 25000, nomes: ['MARIA SILVA'], empresa: false });
  assert.deepEqual(r.pix[1]!.nomes, ['João Souza'], 'o mesmo nome (sem acento/caixa) no campo do pagador e na descrição vale uma vez');
  assert.equal(r.pix[1]!.centavos, 5050, 'centavos exatos, sem erro de ponto flutuante');
  assert.equal(r.pix[2]!.empresa, true);
  assert.deepEqual(r.cartaoVendas, { lancamentos: 2, centavos: 100010 });
  assert.deepEqual(r.outras, { lancamentos: 1, centavos: 100000 });
});

test('valores da unidade: o sinal cadastrado + os R$ do texto de produtos (20 a 1000); a lista da operação manda; nada fora da faixa', () => {
  const texto = 'A CONSULTA presencial: R$ 350 no dia, ou R$ 250 com pagamento antecipado do sinal de R$ 50 (R$ 50 agora por Pix + R$ 200 no dia). Pacote de sessões: R$ 3.500,00. Taxa R$ 5.';
  assert.deepEqual(valoresDaUnidade({ slug: 'a', textoDeProdutos: texto }), [5000, 20000, 25000, 35000]);
  assert.deepEqual(valoresDaUnidade({ slug: 'a', sinalPixCentavos: 7500, textoDeProdutos: 'consulta R$ 150,50' }), [7500, 15050]);
  assert.deepEqual(valoresDaUnidade({ slug: 'a', textoDeProdutos: texto, env: '{"a":[50,250.5],"b":[10]}' }), [5000, 25050], 'a lista da operação troca tudo');
  assert.deepEqual(valoresDaUnidade({ slug: 'c', textoDeProdutos: 'A consulta custa R$ 100.', env: '{"a":[50]}' }), [10000], 'unidade fora da lista cai no texto');
  assert.deepEqual(valoresDaUnidade({ slug: 'a', env: 'isto não é json' }), []);
  assert.deepEqual(valoresDaUnidade({ slug: 'a' }), []);
});

test('valores da unidade: só saem de frases de consulta/sinal/antecipado/taxa — sessão, pacote, retorno e tratamento ficam de fora', () => {
  const texto = 'Sessão de fisioterapia: R$ 150. Pacote de 10 sessões: R$ 600. Consulta de retorno: R$ 100. A consulta custa R$ 300 no dia, ou R$ 200 antecipado.\nTratamento completo R$ 900.\nReserva do horário: R$ 50.';
  assert.deepEqual(valoresDaUnidade({ slug: 'a', textoDeProdutos: texto }), [5000, 20000, 30000]);
  assert.deepEqual(valoresDaUnidade({ slug: 'a', textoDeProdutos: 'Pacote R$ 600. Sessão R$ 150.' }), [], 'sem frase de consulta não sai valor nenhum');
});

test('variável da operação preenchida e quebrada é detectada (para o log avisar); vazia ou boa não', () => {
  assert.equal(valoresDaOperacaoInvalidos(undefined), false);
  assert.equal(valoresDaOperacaoInvalidos('  '), false);
  assert.equal(valoresDaOperacaoInvalidos('{"a":[50,250]}'), false);
  assert.equal(valoresDaOperacaoInvalidos('{"a":[50,250]'), true, 'faltou a chave');
  assert.equal(valoresDaOperacaoInvalidos('[50,250]'), true, 'lista solta, sem unidade');
});

test('comparar por tokens dá o mesmo resultado que comparar por nome (a versão indexada do ROI)', () => {
  for (const [a, b] of [['Maria da Silva Costa', 'MARIA COSTA'], ['Joao Souza', 'Joao Sousa'], ['Pedro Dias Henr', 'Pedro Henrique Dias'], ['Ana', 'Ana Lima']] as const) {
    assert.equal(compararTokens(tokensDoNome(a), tokensDoNome(b)), compararNomes(a, b));
  }
});

test('É PIX pelo método de pagamento que a Pluggy manda (PIX); a descrição só vale quando o banco não informa o método', () => {
  const r = entradasDoBanco([
    lanc('a', 'MARIA SILVA', 250, { metodoDePagamento: 'PIX' }), // descrição SEM o prefixo «Pix»
    lanc('b', 'Transferência recebida JOANA LIMA', 150, { metodoDePagamento: 'PIX', pagador: 'Joana Lima' }),
    lanc('c', 'Pix FULANO TESTE', 99, { metodoDePagamento: 'TED' }), // a descrição diz Pix mas o método é TED: não é Pix
    lanc('g', 'Pix BEATRIZ TESTE', 60, { metodoDePagamento: 'OTHER' }), // método genérico: vale o «Pix NOME» da descrição
    lanc('d', 'Pix ANA COSTA', 80), // sem método: vale a descrição
    lanc('e', 'Vendas Visa Débito', 500, { metodoDePagamento: 'OTHER' }),
    lanc('f', 'Pix 12.345.678 CLINICA TESTE LTDA', 70, { metodoDePagamento: 'PIX', pagadorTipoDocumento: 'PJ' }),
  ]);
  assert.deepEqual(r.pix.map((p) => p.id), ['a', 'b', 'g', 'd', 'f']);
  assert.deepEqual(r.pix[0]!.nomes, ['MARIA SILVA'], 'sem prefixo, o texto inteiro da descrição é o nome');
  assert.equal(r.pix[1]!.nomes[0], 'Joana Lima', 'o campo do pagador vem primeiro; o resto da descrição é só mais um candidato (e não casa com ninguém)');
  assert.equal(r.pix[4]!.empresa, true);
  assert.deepEqual(r.outras, { lancamentos: 1, centavos: 9900 }, 'o TED com descrição «Pix» não é Pix');
  assert.deepEqual(r.cartaoVendas, { lancamentos: 1, centavos: 50000 });
  assert.equal(ehPix({ descricao: 'qualquer', metodoDePagamento: 'PIX' }), true);
  assert.equal(ehPix({ descricao: 'Pix X', metodoDePagamento: 'OTHER' }), true, 'método genérico: vale a descrição «Pix NOME»');
  assert.equal(ehPix({ descricao: 'Pix X', metodoDePagamento: 'TRANSFER' }), true);
  assert.equal(ehPix({ descricao: 'Vendas Visa', metodoDePagamento: 'OTHER' }), false);
  assert.equal(ehPix({ descricao: 'Pix X', metodoDePagamento: 'BOLETO' }), false);
  assert.equal(ehPix({ descricao: 'Pix X' }), true);
  assert.equal(ehPix({ descricao: 'Boleto X' }), false);
});
