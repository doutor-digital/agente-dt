import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cnpjValido, cpfValido, mascararArgumentos, mascararEmail, mascararErro, mascararTexto } from './mascaras.js';

test('arestas da máscara: rota colada a número maior, zeros, número que a máscara não muda, e-mail em campo de documento', () => {
  // número de rota seguido de mais número NÃO é id inteiro: o trecho todo continua sendo tratado como documento
  assert.equal(mascararErro('404 em /v1/clientes/123456789-09'), '404 em /v1/clientes/***.***.***-09');
  // zeros e repetidos passam na conta mas não são documento
  assert.equal(cpfValido('00000000000'), false);
  assert.equal(cnpjValido('00000000000000'), false);
  // número pequeno sob chave de documento: nada a mascarar, continua número
  assert.deepEqual(mascararArgumentos({ cpf: 12, telefone: 123 }), { cpf: 12, telefone: 123 });
  // e-mail dentro de campo de CPF/documento também sai mascarado; sem nada antes do @ não sobra nem a inicial
  assert.equal(mascararArgumentos({ documento: 'maria@exemplo.com' }).documento, 'm***@exemplo.com');
  assert.equal(mascararEmail('@exemplo.com'), '***');
  assert.equal(mascararEmail('a@b.co'), 'a***@b.co');
});

// Revisão do sênior no PR #171 (30/10): ids, números JSON, separador com espaço, e-mail, nome, SQL. Tudo aqui é inventado.

test('mascararErro: id do Asaas (pay_/cus_/sub_/ins_/inv_…) e nossoNumero não viram CPF nem telefone', () => {
  const ids = ['pay_12345678901', 'pay_55119876543210', 'pay_080225913252', 'cus_000005401844', 'sub_1234567890', 'ins_55123456789012', 'inv_12345678901'];
  for (const id of ids) {
    assert.equal(mascararErro(`Asaas 400: duplicada de ${id} fim`), `Asaas 400: duplicada de ${id} fim`, id);
    assert.equal(mascararTexto(`cobrança ${id}`), `cobrança ${id}`, id);
  }
  assert.equal(mascararErro('boleto nossoNumero 1234567890 pronto'), 'boleto nossoNumero 1234567890 pronto');
  // o que parece id mas não tem o prefixo do Asaas continua sendo dado pessoal
  assert.equal(mascararErro('campo cpf_12345678901 e xpay_12345678901'), 'campo cpf_***.***.***-01 e xpay_***.***.***-01');
});

test('mascararErro: número que é id numa rota ou num campo de id (Bling, idClient) fica; o mesmo número solto continua mascarado', () => {
  assert.equal(mascararErro('Bling 404 em /pedidos/vendas/16987654321'), 'Bling 404 em /pedidos/vendas/16987654321');
  assert.equal(mascararErro('Bling 404 em /pedidos/vendas/16987654321/itens?x=1'), 'Bling 404 em /pedidos/vendas/16987654321/itens?x=1');
  assert.equal(mascararErro('Bling 404 em /contatos/16987654321.'), 'Bling 404 em /contatos/16987654321.');
  assert.equal(mascararErro('paciente idClient 1234567890 não achado'), 'paciente idClient 1234567890 não achado');
  assert.equal(mascararErro('idClient=1234567890'), 'idClient=1234567890');
  assert.equal(mascararErro('{"idClient":1234567890}'), '{"idClient":1234567890}');
  assert.equal(mascararErro('lead id: 11987654321 sem cartão'), 'lead id: 11987654321 sem cartão');
  // CPF formatado na rota e CPF/telefone soltos continuam saindo mascarados
  assert.equal(mascararErro('404 em /v1/clientes/123.456.789-09'), '404 em /v1/clientes/***.***.***-09');
  assert.equal(mascararErro('cliente 12345678909 não achado'), 'cliente ***.***.***-09 não achado');
  assert.equal(mascararErro('telefone 11987654321 inválido'), 'telefone (**) *****-4321 inválido');
  assert.equal(mascararErro('busca /clientes/12345678901 e 11987654321'), 'busca /clientes/12345678901 e (**) *****-4321');
});

test('mascararErro: número de rota ou de campo de id que PASSA na conta do CPF/CNPJ é documento e sai mascarado (123.456.789-09, 11.222.333/0001-81)', () => {
  assert.equal(mascararErro('Tramitação 404 em /v1/processos/12345678909: não encontrado'), 'Tramitação 404 em /v1/processos/***.***.***-09: não encontrado');
  assert.equal(mascararErro('404 em /v1/clientes/11222333000181'), '404 em /v1/clientes/**.***.***/****-81');
  assert.equal(mascararErro('idClient 12345678909 não achado'), 'idClient ***.***.***-09 não achado');
  assert.equal(mascararErro('id: 11222333000181'), 'id: **.***.***/****-81');
  // e o mesmo formato, que não passa na conta, é id e fica
  assert.equal(mascararErro('404 em /v1/processos/12345678901'), '404 em /v1/processos/12345678901');
  assert.equal(cpfValido('12345678909'), true);
  assert.equal(cpfValido('11111111111'), false);
  assert.equal(cpfValido('1234567890'), false);
  assert.equal(cnpjValido('11222333000181'), true);
  assert.equal(cnpjValido('11222333000182'), false);
  assert.equal(cnpjValido('11111111111111'), false);
});

test('argumentos: CPF e telefone mandados como NÚMERO não saem inteiros', () => {
  const out = mascararArgumentos({ cpf: 12345678909, telefone: 11987654321, itens: [{ celular: 11987654321, cnpj: 12345678000195 }], busca: 12345678909 });
  assert.deepEqual(out, { cpf: '***.***.***-09', telefone: '(**) *****-4321', itens: [{ celular: '(**) *****-4321', cnpj: '**.***.***/****-95' }], busca: '***.***.***-09' });
  // número que só conta, mede ou identifica fica como número
  const neutro = { limite: 50, leadId: 24405762, idClient: 1234567890, documents_count: 12345678901, valor: 250.5 };
  assert.deepEqual(mascararArgumentos(neutro), neutro);
});

test('argumentos: espaço em volta do separador do CPF também é mascarado', () => {
  for (const v of ['123 . 456 . 789 - 09', '123 .456. 789 -09', '123.456.789 - 09', '123 456 789 09', '123-456-789-09']) {
    assert.equal(mascararArgumentos({ busca: `cpf ${v} ok` }).busca, 'cpf ***.***.***-09 ok', v);
    assert.equal(mascararErro(`falhou ${v} fim`), 'falhou ***.***.***-09 fim', v);
  }
  // não come número vizinho nem texto comum
  assert.equal(mascararTexto('valores 100 200 e 300'), 'valores 100 200 e 300');
  assert.equal(mascararTexto('lote 123 . 456 . 789'), 'lote 123 . 456 . 789');
});

test('argumentos e erro: e-mail sai com a primeira letra e o domínio', () => {
  assert.equal(mascararArgumentos({ busca: 'maria.silva@exemplo.com.br' }).busca, 'm***@exemplo.com.br');
  assert.equal(mascararArgumentos({ filtros: [{ email: 'a@b.co' }] }).filtros[0]!.email, 'a***@b.co');
  assert.equal(mascararErro('cliente maria.silva@exemplo.com não achado'), 'cliente m***@exemplo.com não achado');
  assert.equal(mascararErro('fila, a@b.com; c@d.org'), 'fila, a***@b.com; c***@d.org');
  // sem arroba, nada muda
  assert.equal(mascararErro('versão 1.2 de a.b.c'), 'versão 1.2 de a.b.c');
});

test('argumentos: nome só é abreviado em campo de pessoa; texto livre e outros campos não são tocados', () => {
  assert.deepEqual(mascararArgumentos({ nome: 'Maria da Silva Souza', paciente: 'João Pedro Lima', name: 'Ana Costa', cliente: 'Carlos Alberto' }), {
    nome: 'Maria S.',
    paciente: 'João L.',
    name: 'Ana C.',
    cliente: 'Carlos A.',
  });
  assert.deepEqual(mascararArgumentos({ nome: 'Maria' }), { nome: 'Maria' });
  assert.deepEqual(mascararArgumentos({ cliente: 'cus_000005401844' }), { cliente: 'cus_000005401844' });
  const livre = { busca: 'Maria da Silva Souza', observacao: 'cliente Maria da Silva pediu retorno', unidade: 'serra', texto: 'Nota da Ana Costa' };
  assert.deepEqual(mascararArgumentos(livre), livre);
});

test('argumentos: SQL e texto técnico não são cortados depois de um número de documento', () => {
  const sql = "SELECT nome FROM pacientes WHERE cpf = '12345678909' AND criado_em > '2026-01-01' ORDER BY nome LIMIT 10";
  assert.equal(
    mascararArgumentos({ sql }).sql,
    "SELECT nome FROM pacientes WHERE cpf = '***.***.***-09' AND criado_em > '2026-01-01' ORDER BY nome LIMIT 10",
  );
  const sql2 = "SELECT * FROM t WHERE telefone IN ('11987654321','11912345678') AND status = 'ativo'";
  assert.equal(mascararArgumentos({ sql: sql2 }).sql, "SELECT * FROM t WHERE telefone IN ('(**) *****-4321','(**) *****-5678') AND status = 'ativo'");
  assert.equal(mascararArgumentos({ caminho: '/v1/clientes/123.456.789-09/processos?page=2' }).caminho, '/v1/clientes/***.***.***-09/processos?page=2');
  // texto livre continua em modo célula: CPF + o que vem depois (possível senha) some
  assert.equal(mascararArgumentos({ busca: '12345678909 abc123' }).busca, '[CPF/senha omitido]');
});

test('argumentos: campos que o código lê de volta (chave, ids, conta) só ficam intactos quando têm o formato de id', () => {
  const ok = { conta: 'doutor-hernia-serra', chave: 'aeb5823b37ae1c2727751520c82e2607', clienteId: 'cus_000005401844', cobrancaId: 'pay_12345678901', incerto: true };
  assert.deepEqual(mascararArgumentos(ok), ok);
  const quem = { pediuPor: 'cmvr6c1f00012345678ab', confirmadoPor: 'cmvr6c1f00012345678ab' };
  assert.deepEqual(mascararArgumentos(quem), quem);
  assert.deepEqual(mascararArgumentos({ pediuPor: '11987654321' }), { pediuPor: '(**) *****-4321' });
  // o mesmo nome de campo com um CPF ou telefone dentro NÃO escapa
  assert.deepEqual(mascararArgumentos({ conta: '11987654321', chave: '12345678909', clienteId: '12345678909', cobrancaId: '123.456.789-09' }), {
    conta: '(**) *****-4321',
    chave: '***.***.***-09',
    clienteId: '***.***.***-09',
    cobrancaId: '***.***.***-09',
  });
});

test('argumentos: o ramo cpfCnpj só vale para o campo de documento e não toca nos outros', () => {
  assert.equal(mascararArgumentos({ cpfCnpj: '52998224725' }).cpfCnpj, '***.***.***-25');
  assert.equal(mascararArgumentos({ cpfCnpj: '529.982.247-25' }).cpfCnpj, '***.***.***-25');
  assert.equal(mascararArgumentos({ cpfCnpj: '123456' }).cpfCnpj, '***.***.***-56');
  assert.equal(mascararArgumentos({ documento: '52998224725' }).documento, '***.***.***-25');
  // outro campo com 6 dígitos soltos não vira CPF
  assert.equal(mascararArgumentos({ codigo: '123456' }).codigo, '123456');
});
