import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { criarContextoAsaas } from './asaas.js';
import { asaasFalso, AGORA, ErroHttp, montar, type Cli } from './asaas-falso.js';
import {
  chaveDeDuplicata, cobrancasPorHora, criarCliente, criarCobranca, criarEscritaAsaas, EVENTO_CLIENTE, EVENTO_COBRANCA, LIMITES_ASAAS, mascararDoc, mascararTelefone,
  unidadesComEscrita, validarCpfCnpj, type PedidoDeCobranca,
} from './asaas-escrita.js';
import { registrarEscritaAsaas, registrarEscritaAsaasSePermitido } from './asaas-ferramentas.js';
import type { Lancamento } from './asaas-limites.js';

const CPF = '529.982.247-25';
const CPF_DIGITOS = '52998224725';
const CNPJ = '11.222.333/0001-81';
const CHAVE_COMPLETA = '$aact_prod_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OjAwMDAwXXYZ';
const VENC = '2026-11-10';
const Q = { id: 'u1', email: 'joao@exemplo.com' };

const COBRANCA: PedidoDeCobranca = { unidade: 'serra', cpfCnpj: CPF, valor: 250, vencimento: VENC, descricao: 'Consulta de avaliação', externalReference: 'pedido-1' };
const EXISTENTE: Cli = { id: 'cus_000005401844', name: 'Maria da Silva', cpfCnpj: CPF_DIGITOS, email: 'maria.silva@exemplo.com', mobilePhone: '63981411248', notificationDisabled: true };
const tudo = (x: unknown) => JSON.stringify(x);
const cobrar = (m: ReturnType<typeof montar>, p: Partial<PedidoDeCobranca> = {}) => criarCobranca(m.ctx, Q, { ...COBRANCA, ...p }, m.registrar) as Promise<any>;

// ------------------------------------------------------------------ validação

test('CPF e CNPJ: dígitos verificadores conferidos; sequência repetida e tamanho errado caem', () => {
  assert.equal(validarCpfCnpj(CPF), CPF_DIGITOS);
  assert.equal(validarCpfCnpj(CNPJ), '11222333000181');
  assert.throws(() => validarCpfCnpj('529.982.247-26'), /CPF inválido/);
  assert.throws(() => validarCpfCnpj('11.222.333/0001-80'), /CNPJ inválido/);
  assert.throws(() => validarCpfCnpj('111.111.111-11'), /CPF inválido/);
  assert.throws(() => validarCpfCnpj('123'), /11 dígitos/);
  assert.equal(mascararDoc(CPF_DIGITOS), '***.***.247-**');
  assert.equal(mascararDoc('11222333000181'), '**.***.333/0001-**');
});

test('limite de cobranças por hora vem do ambiente (padrão 20); 0 e lixo DESLIGAM, não viram o padrão', () => {
  assert.equal(cobrancasPorHora({}), 20);
  assert.equal(cobrancasPorHora({ ASAAS_COBRANCAS_POR_HORA: '5' }), 5);
  assert.equal(cobrancasPorHora({ ASAAS_COBRANCAS_POR_HORA: '  ' }), 20);
  for (const v of ['0', 'abc', '-3', '2.5']) assert.equal(cobrancasPorHora({ ASAAS_COBRANCAS_POR_HORA: v }), 0, `hora ${v}`);
});

test('mascararTelefone: com DDI (12 e 13 dígitos) o DDD certo aparece, sem o 55; curto vira só asteriscos', () => {
  assert.equal(mascararTelefone('(63) 98141-1248'), '(63) *****-1248');
  assert.equal(mascararTelefone('+55 63 98141-1248'), '(63) *****-1248');
  assert.equal(mascararTelefone('556333214455'), '(63) *****-4455');
  assert.equal(mascararTelefone('3321'), '*****');
});

// ------------------------------------------------------------------ cadastrar cliente (direto)

test('cliente: cadastra DIRETO (sem código), SEM aviso por padrão, e o registro sai mascarado', async () => {
  const m = montar();
  const r = (await criarCliente(m.ctx, Q, { unidade: 'serra', nome: 'Maria da Silva', cpfCnpj: CPF, email: 'maria@exemplo.com', telefone: '(63) 98141-1248', endereco: { cep: '77000-000', logradouro: 'Rua A', numero: '10', bairro: 'Centro' } }, m.registrar)) as any;
  assert.equal(r.cadastrado, true);
  assert.deepEqual(r.conta, { unidade: 'doutor-hernia-serra', nomeDaConta: 'Clínica Serra Saúde LTDA', chaveTermina: '…xYZ1' });
  assert.equal(m.f.posts().length, 1);
  const { metodo, caminho, corpo } = m.f.posts()[0]!;
  assert.deepEqual([metodo, caminho], ['POST', '/customers']);
  assert.deepEqual(corpo, { name: 'Maria da Silva', cpfCnpj: CPF_DIGITOS, email: 'maria@exemplo.com', mobilePhone: '63981411248', postalCode: '77000000', address: 'Rua A', addressNumber: '10', province: 'Centro', notificationDisabled: true });
  assert.equal(m.eventos[0]!.evento, EVENTO_CLIENTE);
  assert.equal(m.eventos[0]!.args.pediuPor, 'u1');
  const j = tudo(r) + tudo(m.eventos);
  assert.ok(!j.includes(CPF_DIGITOS) && !j.includes('maria@exemplo.com') && !j.includes('981411248') && !j.includes('aact'), 'dado pessoal vazou');
  assert.match(j, /NÃO vai mandar e-mail nem SMS/);

  const n = montar();
  await criarCliente(n.ctx, Q, { unidade: 'serra', nome: 'Maria da Silva', cpfCnpj: CPF, avisarCliente: true }, n.registrar);
  assert.equal(n.f.posts()[0]!.corpo!.notificationDisabled, false);
});

test('cliente: CPF já cadastrado → devolve o id e NÃO cria outro; dois pedidos juntos criam UM só (fila)', async () => {
  const a = montar({ clientes: [EXISTENTE] });
  const r = (await criarCliente(a.ctx, Q, { unidade: 'serra', nome: 'Maria S', cpfCnpj: CPF }, a.registrar)) as any;
  assert.equal(r.jaCadastrado, true);
  assert.match(String(r.instrucao), /cus_000005401844/);
  assert.equal(a.f.posts().length, 0);
  assert.ok(!tudo(r).includes('maria.silva@exemplo.com'));

  const b = montar();
  const pedido = { unidade: 'serra', nome: 'Joana Souza', cpfCnpj: CNPJ };
  const [x, y] = (await Promise.all([criarCliente(b.ctx, Q, pedido, b.registrar), criarCliente(b.ctx, Q, pedido, b.registrar)])) as any[];
  assert.equal(b.f.posts().length, 1);
  assert.equal([x, y].filter((z) => z.cadastrado).length, 1);
  assert.equal([x, y].filter((z) => z.jaCadastrado).length, 1);
});

test('cliente: CPF inválido, e-mail, telefone e CEP ruins são recusados antes de qualquer coisa', async () => {
  const m = montar();
  const c = (a: object) => criarCliente(m.ctx, Q, { unidade: 'serra', nome: 'Maria', cpfCnpj: CPF, ...a }, m.registrar);
  await assert.rejects(() => c({ cpfCnpj: '529.982.247-26' }), /CPF inválido/);
  await assert.rejects(() => c({ email: 'sem-arroba' }), /e-mail inválido/);
  await assert.rejects(() => c({ telefone: '123' }), /telefone inválido/);
  await assert.rejects(() => c({ endereco: { cep: '123', logradouro: 'Rua A', numero: '1' } }), /CEP/);
  await assert.rejects(() => c({ nome: 'M' }), /nome do cliente/);
  assert.equal(m.f.posts().length, 0);
});

test('cliente: se o Asaas devolver gente que não bate com o CPF buscado, não adivinha nem cria por cima; cliente SEM documento não casa', async () => {
  const m = montar({ clientesTortos: [{ id: 'cus_000009999999', name: 'Outra Pessoa', cpfCnpj: '11222333000181' }] });
  await assert.rejects(() => criarCliente(m.ctx, Q, { unidade: 'serra', nome: 'Maria', cpfCnpj: CPF }, m.registrar), /não batem/);
  assert.equal(m.f.posts().length, 0);
  const semDoc = montar({ clientesTortos: [{ id: 'cus_000008888888', name: 'Maria da Silva', cpfCnpj: '' }] });
  await assert.rejects(() => criarCliente(semDoc.ctx, Q, { unidade: 'serra', nome: 'Maria', cpfCnpj: CPF }, semDoc.registrar), /não batem/);
  assert.equal(semDoc.f.posts().length, 0);
});

test('cliente: cadastro sem resposta ou 2xx sem id é "pode ter sido feito", nunca "cliente (undefined)"', async () => {
  const a = montar({ falhaNoCliente: new ErroHttp('timeout', null) });
  await assert.rejects(() => criarCliente(a.ctx, Q, { unidade: 'serra', nome: 'Maria', cpfCnpj: CPF }, a.registrar), /PODE ter sido feito/);
  assert.equal(a.eventos[0]!.args.incerto, true);
  const b = montar();
  b.f.conta.escrita!.enviar = (async () => ({})) as never;
  await assert.rejects(() => criarCliente(b.ctx, Q, { unidade: 'serra', nome: 'Maria', cpfCnpj: CPF }, b.registrar), /PODE ter sido feito/);
});

// ------------------------------------------------------------------ a conta

test('conta: "todas", lista, vazio, conta sem escrita ou desconhecida são recusados — nada é consultado nem gravado', async () => {
  const { f, ctx, registrar } = montar();
  for (const u of ['todas', 'TODAS', ' todas ', 'serra,maraba', '']) {
    await assert.rejects(() => criarCliente(ctx, Q, { unidade: u, nome: 'Maria', cpfCnpj: CPF }, registrar), /UMA|numa conta só|informe a unidade/, u);
    await assert.rejects(() => criarCobranca(ctx, Q, { ...COBRANCA, unidade: u }, registrar), /UMA|numa conta só|informe a unidade/, u);
  }
  await assert.rejects(() => criarCliente(ctx, Q, { unidade: 'maraba', nome: 'Maria', cpfCnpj: CPF }, registrar), /sem Asaas/);
  const so = montar({ semEscrita: true });
  await assert.rejects(() => criarCliente(so.ctx, Q, { unidade: 'serra', nome: 'Maria', cpfCnpj: CPF }, so.registrar), /não está liberada para escrita/);
  assert.equal(f.chamadas.length + so.f.chamadas.length, 0);
  assert.equal(f.gets.length + so.f.gets.length, 0);
});

test('conta: sem o nome no Asaas usa o nome salvo; sem nenhum, avisa para conferir pelo final da chave', async () => {
  const a = montar({ semNomeDaConta: true });
  const r = (await criarCliente(a.ctx, Q, { unidade: 'serra', nome: 'Maria', cpfCnpj: CPF }, a.registrar)) as any;
  assert.equal(r.conta.nomeDaConta, 'Serra (nome salvo)');
  const b = montar({ semNomeDaConta: true });
  (b.f.conta.escrita as { contaSalva?: string | null }).contaSalva = null;
  const r2 = (await criarCliente(b.ctx, Q, { unidade: 'serra', nome: 'Maria', cpfCnpj: CPF }, b.registrar)) as any;
  assert.equal(r2.conta.nomeDaConta, null);
  assert.match(r2.avisos.join(' '), /final da chave/);
});

test('ASAAS_ESCRITA_UNIDADES: vazia/ausente = desligada em todas; só as listadas; "*" não vale; a recusa diz qual variável configurar', async () => {
  assert.deepEqual([...unidadesComEscrita({})], []);
  assert.deepEqual([...unidadesComEscrita({ ASAAS_ESCRITA_UNIDADES: '' })], []);
  assert.deepEqual([...unidadesComEscrita({ ASAAS_ESCRITA_UNIDADES: '  ,, ' })], []);
  assert.deepEqual([...unidadesComEscrita({ ASAAS_ESCRITA_UNIDADES: '*' })], []);
  assert.deepEqual([...unidadesComEscrita({ ASAAS_ESCRITA_UNIDADES: 'todas,*, doutor-hernia-serra ,Maraba' })].sort(), ['doutor-hernia-serra', 'maraba', 'todas']);
  for (const env of [{}, { ASAAS_ESCRITA_UNIDADES: '' }, { ASAAS_ESCRITA_UNIDADES: '*' }, { ASAAS_ESCRITA_UNIDADES: 'doutor-hernia-maraba' }]) {
    const m = montar({ clientes: [EXISTENTE] }, { unidades: () => unidadesComEscrita(env) });
    await assert.rejects(() => criarCliente(m.ctx, Q, { unidade: 'serra', nome: 'Maria', cpfCnpj: CPF }, m.registrar), /DESLIGADA para doutor-hernia-serra.*ASAAS_ESCRITA_UNIDADES/, tudo(env));
    await assert.rejects(() => cobrar(m), /DESLIGADA para doutor-hernia-serra.*ASAAS_ESCRITA_UNIDADES/, tudo(env));
    assert.equal(m.f.chamadas.length, 0);
  }
  // a variável de verdade, sem injeção: ausente → desligada
  const anterior = process.env.ASAAS_ESCRITA_UNIDADES;
  delete process.env.ASAAS_ESCRITA_UNIDADES;
  try {
    const f = asaasFalso({ clientes: [EXISTENTE] });
    const real = { asaas: criarContextoAsaas(new Map([[f.conta.slug, f.conta]])), esc: criarEscritaAsaas({ agora: () => AGORA }) };
    await assert.rejects(() => criarCobranca(real, Q, COBRANCA, () => undefined), /ASAAS_ESCRITA_UNIDADES/);
    process.env.ASAAS_ESCRITA_UNIDADES = 'doutor-hernia-serra';
    assert.equal(((await criarCobranca(real, Q, COBRANCA, () => undefined)) as any).gerado, true);
  } finally {
    if (anterior === undefined) delete process.env.ASAAS_ESCRITA_UNIDADES;
    else process.env.ASAAS_ESCRITA_UNIDADES = anterior;
  }
});

// ------------------------------------------------------------------ cobrança: boleto

test('boleto de cliente que já existe: grava DIRETO, manda BOLETO e devolve links, linha digitável e o consumo do dia', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  const r = await cobrar(m);
  assert.equal(r.gerado, true);
  assert.equal(m.f.posts().length, 1);
  const { metodo, caminho, corpo } = m.f.posts()[0]!;
  assert.deepEqual([metodo, caminho], ['POST', '/payments']);
  assert.deepEqual(corpo, { customer: 'cus_000005401844', billingType: 'BOLETO', value: 250, dueDate: VENC, description: 'Consulta de avaliação', externalReference: 'pedido-1' });
  assert.match(r.cobranca.id, /^pay_/);
  assert.equal(r.cobranca.forma, 'BOLETO');
  assert.equal(r.cobranca.linkDoBoleto, 'https://www.asaas.com/b/pdf/abc123');
  assert.equal(r.cobranca.linkParaPagar, 'https://www.asaas.com/i/abc123');
  assert.match(r.cobranca.linhaDigitavel, /^34191/);
  assert.equal(r.avisouOCliente, false);
  assert.equal(r.limites.usadoHoje, 'R$ 250,00');
  assert.equal(r.limites.restanteHoje, 'R$ 19.750,00');
  const ev = m.eventos.find((e) => e.evento === EVENTO_COBRANCA)!;
  assert.equal(ev.ok, true);
  assert.equal(ev.args.valor, 250);
  assert.equal(ev.args.pediuPor, 'u1');
  assert.equal(m.avisos.length, 0, 'cobrança pequena não avisa o João');
  assert.ok(!tudo(r).includes(CPF_DIGITOS) && !tudo(r).includes('maria.silva@exemplo.com'));
});

test('boleto sem a linha digitável ainda: o link basta e a resposta não quebra', async () => {
  const m = montar({ clientes: [EXISTENTE], semLinhaDigitavel: true });
  const r = await cobrar(m);
  assert.equal(r.cobranca.linhaDigitavel, null);
  assert.ok(r.cobranca.linkDoBoleto);
});

test('boleto por clienteId funciona; id malformado (caminho de URL) é recusado antes de ir ao Asaas', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  const ok = await cobrar(m, { cpfCnpj: undefined, clienteId: ' cus_000005401844 ', externalReference: 'x-1' });
  assert.equal(ok.cliente.id, 'cus_000005401844');
  for (const ruim of ['../payments', 'cus_1', 'cus_000005401844/../x', 'pay_000005401844']) {
    await assert.rejects(() => cobrar(m, { cpfCnpj: undefined, clienteId: ruim, externalReference: `r-${ruim.length}` }), /clienteId inválido/, ruim);
  }
  await assert.rejects(() => cobrar(m, { cpfCnpj: undefined, clienteId: 'cus_000009999999', externalReference: 'x-2' }), /não existe/);
  await assert.rejects(() => cobrar(m, { clienteId: 'cus_000005401844' }), /clienteId.*OU por cpfCnpj/);
  await assert.rejects(() => cobrar(m, { cpfCnpj: undefined }), /clienteId.*OU por cpfCnpj/);
});

test('boleto com cliente novo: cadastra junto (cliente primeiro, cobrança depois), sem aviso por padrão', async () => {
  const m = montar();
  const r = await cobrar(m, { novoCliente: { nome: 'Maria da Silva', email: 'maria@exemplo.com' } });
  assert.deepEqual(m.f.posts().map((p) => p.caminho), ['/customers', '/payments']);
  assert.equal(m.f.posts()[0]!.corpo!.notificationDisabled, true);
  assert.equal(r.cliente.cadastradoAgora, true);
  assert.equal(m.f.posts()[1]!.corpo!.customer, r.cliente.id);
  assert.ok(m.eventos.some((e) => e.evento === EVENTO_CLIENTE && e.args.junto === 'cobranca'));
});

test('boleto: CPF que não existe e sem novoCliente é recusado; mais de um cadastro com o mesmo CPF não é adivinhado', async () => {
  const a = montar();
  await assert.rejects(() => cobrar(a), /não há cliente com o documento \*\*\*\.\*\*\*\.247-\*\*/);
  const b = montar({ clientes: [EXISTENTE, { ...EXISTENTE, id: 'cus_000005401855' }] });
  await assert.rejects(() => cobrar(b), /2 cadastros com este CPF.*clienteId/);
  assert.equal(a.f.posts().length + b.f.posts().length, 0);
});

test('boleto: cliente novo que falha ao cadastrar não gera cobrança; cobrança que falha depois diz que o cliente FOI cadastrado', async () => {
  const a = montar({ falhaNoCliente: new ErroHttp('Asaas 400: e-mail inválido', 400) });
  await assert.rejects(() => cobrar(a, { novoCliente: { nome: 'Maria da Silva' } }), /não cadastrei o cliente e portanto não gerei/);
  assert.deepEqual(a.f.posts().map((p) => p.caminho), ['/customers'], 'só a tentativa de cadastro; a cobrança nem foi tentada');
  const b = montar({ falhaNoPagamento: new ErroHttp('Asaas 400: valor inválido', 400) });
  await assert.rejects(() => cobrar(b, { novoCliente: { nome: 'Maria da Silva' } }), /O cliente FOI cadastrado \(cus_.*\), mas a cobrança não saiu/);
});

test('boleto: valor zero, negativo, texto, com 3 casas ou infinito é recusado', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  for (const v of [0, -5, 'abc', 10.123, Infinity, NaN, 1e21, 0.001]) {
    await assert.rejects(() => cobrar(m, { valor: v as number }), /valor/, String(v));
  }
  assert.equal(m.f.posts().length, 0);
});

test('boleto: vencimento no passado, depois do limite de dias, data que não existe — hoje e o limite passam', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  await assert.rejects(() => cobrar(m, { vencimento: '2026-10-27' }), /já passou/);
  await assert.rejects(() => cobrar(m, { vencimento: '2026-02-30' }), /não é uma data que existe/);
  await assert.rejects(() => cobrar(m, { vencimento: '10/11/2026' }), /AAAA-MM-DD/);
  assert.equal((await cobrar(m, { vencimento: '2026-10-28', externalReference: 'hoje' })).gerado, true);
  const limite = '2027-01-26'; // 28/10/2026 + 90 dias
  assert.equal((await cobrar(m, { vencimento: limite, externalReference: 'limite' })).gerado, true);
  await assert.rejects(() => cobrar(m, { vencimento: '2027-01-27', externalReference: 'passou' }), new RegExp(`passa de ${LIMITES_ASAAS.maxDiasVencimento} dias`));
});

test('boleto: caso real - em 30/10/2026 o vencimento de 30/12/2026 (61 dias) é aceito; o dia é contado no fuso da clínica', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  m.relogio.t = Date.parse('2026-10-30T10:00:00-03:00');
  assert.equal((await cobrar(m, { vencimento: '2026-12-30' })).gerado, true);
  // 23h30 em São Paulo já é o dia seguinte em UTC: "hoje" continua sendo o de São Paulo
  const n = montar({ clientes: [EXISTENTE] });
  n.relogio.t = Date.parse('2026-10-30T23:30:00-03:00');
  assert.equal((await cobrar(n, { vencimento: '2026-10-30' })).gerado, true);
  await assert.rejects(() => cobrar(n, { vencimento: '2026-10-29', externalReference: 'ontem' }), /já passou/);
  // clínica em outro fuso (Manaus, UTC-4): 22h de 30/10 em Manaus ainda é dia 30
  const man = montar({ clientes: [EXISTENTE], fuso: 'America/Manaus' });
  man.relogio.t = Date.parse('2026-10-30T22:00:00-04:00');
  assert.equal((await cobrar(man, { vencimento: '2026-10-30' })).gerado, true);
});

test('descrição é obrigatória, vai até 500, aceita período de datas e recusa CPF/telefone', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  await assert.rejects(() => cobrar(m, { descricao: '   ' }), /descrição obrigatória/);
  await assert.rejects(() => cobrar(m, { descricao: 'x'.repeat(501) }), /no máximo 500/);
  assert.equal((await cobrar(m, { descricao: 'Mensalidade 28/10/2026 - 27/11/2026', externalReference: 'p1' })).gerado, true);
  await assert.rejects(() => cobrar(m, { descricao: 'Consulta do CPF 529.982.247-25' }), /dígitos seguidos/);
});

// ------------------------------------------------------------------ cobrança: Pix, cartão, parcelado

test('Pix: manda PIX e devolve o copia-e-cola; Pix parcelado é recusado', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  const r = await cobrar(m, { forma: 'PIX' });
  assert.equal(m.f.posts()[0]!.corpo!.billingType, 'PIX');
  assert.equal(r.cobranca.forma, 'PIX');
  assert.match(r.cobranca.pixCopiaECola, /^00020126/);
  assert.equal(r.cobranca.linhaDigitavel, undefined);
  await assert.rejects(() => cobrar(m, { forma: 'PIX', parcelas: 3, externalReference: 'p2' }), /não existe no Pix/);
  assert.equal(m.f.posts().length, 1);
});

test('cartão: sai como LINK de pagamento (CREDIT_CARD, nunca dados de cartão); número, CVV e token no pedido derrubam tudo', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  const r = await cobrar(m, { forma: 'CARTAO' });
  assert.equal(m.f.posts()[0]!.corpo!.billingType, 'CREDIT_CARD');
  assert.equal(r.cobranca.linkParaPagar, 'https://www.asaas.com/i/abc123');
  assert.equal(Object.keys(m.f.posts()[0]!.corpo!).some((k) => /card|cart|cvv/i.test(k) && k !== 'billingType'), false);
  for (const campo of ['numeroDoCartao', 'cvv', 'creditCard', 'creditCardToken', 'creditCardHolderInfo']) {
    await assert.rejects(() => cobrar(m, { forma: 'CARTAO', externalReference: `c-${campo}`, [campo]: campo === 'creditCard' ? { number: '4111111111111111' } : '4111 1111 1111 1111' }), /NUNCA entram pelo chat/, campo);
  }
  assert.equal(m.f.posts().length, 1);
});

test('parcelado: installmentCount + totalValue, id do parcelamento na resposta, de 2 a 12; fora disso recusa', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  const r = await cobrar(m, { forma: 'CARTAO', parcelas: 6, valor: 1200 });
  const corpo = m.f.posts()[0]!.corpo!;
  assert.equal(corpo.installmentCount, 6);
  assert.equal(corpo.totalValue, 1200);
  assert.equal(corpo.value, undefined);
  assert.equal(r.cobranca.parcelamento.parcelas, 6);
  assert.equal(r.cobranca.parcelamento.idDoParcelamento, 'ins_000000123456');
  assert.equal(r.limites.usadoHoje, 'R$ 1.200,00', 'o total do parcelamento conta no teto do dia');
  for (const p of [0, 13, 2.5, 'x']) await assert.rejects(() => cobrar(m, { parcelas: p, externalReference: `par-${p}` }), /parcelas/, String(p));
  const boleto = await cobrar(m, { parcelas: 3, valor: 300, externalReference: 'par-b' });
  assert.equal(boleto.cobranca.parcelamento.parcelas, 3);
  assert.equal(m.f.posts().at(-1)!.corpo!.billingType, 'BOLETO');
});

test('forma que não existe ("a escolher", assinatura, texto solto) é recusada, sem ser ignorada em silêncio', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  for (const f of ['UNDEFINED', 'assinatura', 'DEBIT_CARD', 'x']) await assert.rejects(() => cobrar(m, { forma: f }), /não existe aqui/, f);
  assert.equal(m.f.posts().length, 0);
  assert.equal((await cobrar(m, { forma: 'cartão', externalReference: 'f1' })).cobranca.forma, 'CARTÃO (link de pagamento)');
  assert.equal((await cobrar(m, { forma: 'credit_card', externalReference: 'f2' })).gerado, true);
});

// ------------------------------------------------------------------ aviso ao cliente

test('aviso ao cliente é decisão: cadastro existente com aviso LIGADO recusa se avisarCliente=false; aceita se true; desligado segue', async () => {
  const ligado = montar({ clientes: [{ ...EXISTENTE, notificationDisabled: false }] });
  await assert.rejects(() => cobrar(ligado), /aviso automático do Asaas LIGADO.*asaas_editar_cliente/s);
  assert.equal(ligado.f.posts().length, 0);
  const aceito = await cobrar(ligado, { avisarCliente: true });
  assert.equal(aceito.avisouOCliente, true);
  assert.match(aceito.aviso, /VAI mandar e-mail\/SMS/);
  const desligado = montar({ clientes: [EXISTENTE] });
  assert.equal((await cobrar(desligado)).avisouOCliente, false);
  assert.match((await cobrar(desligado, { avisarCliente: true, externalReference: 'a2' })).aviso, /NÃO vai avisar/);
});

// ------------------------------------------------------------------ travas

test('duplicata: cobrança igual em menos de 10 min é recusada com o id da existente; depois de 10 min passa; forma e parcelas diferentes não são duplicata', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  const sem = { externalReference: undefined };
  const primeira = await cobrar(m, sem);
  await assert.rejects(() => cobrar(m, sem), new RegExp(`cobrança igual.*${primeira.cobranca.id}`));
  assert.equal(m.f.posts().length, 1);
  assert.equal((await cobrar(m, { ...sem, forma: 'PIX' })).gerado, true, 'outra forma não é a mesma cobrança');
  m.relogio.t += 11 * 60_000;
  assert.equal((await cobrar(m, sem)).gerado, true);
});

test('duplicata: externalReference já usada no Asaas é recusada com o id da cobrança; a apagada não conta', async () => {
  const m = montar({ clientes: [EXISTENTE], pagamentos: [{ id: 'pay_0000apagada', status: 'DELETED', value: 1, deleted: true, externalReference: 'pedido-1' }, { id: 'pay_0000viva001', status: 'PENDING', value: 1, externalReference: 'pedido-1' }] });
  await assert.rejects(() => cobrar(m), /já está na cobrança pay_0000viva001/);
  const n = montar({ clientes: [EXISTENTE], pagamentos: [{ id: 'pay_0000apagada', status: 'DELETED', value: 1, deleted: true, externalReference: 'pedido-1' }] });
  assert.equal((await cobrar(n)).gerado, true);
});

test('limite por hora e conta: acima de N cobranças na hora, recusa; passada a hora, libera', async () => {
  let n = 2;
  const m = montar({ clientes: [EXISTENTE] }, { porHora: () => n });
  await cobrar(m, { externalReference: 'h1', valor: 11 });
  await cobrar(m, { externalReference: 'h2', valor: 12 });
  await assert.rejects(() => cobrar(m, { externalReference: 'h3', valor: 13 }), /limite de 2 cobranças por hora/);
  m.relogio.t += 61 * 60_000;
  assert.equal((await cobrar(m, { externalReference: 'h3', valor: 13 })).gerado, true);
  n = 0;
  await assert.rejects(() => cobrar(m, { externalReference: 'h4', valor: 14 }), /DESLIGADA.*ASAAS_COBRANCAS_POR_HORA/);
});

test('histórico da auditoria: depois de um reinício a duplicata e os limites valem; histórico que não carrega = nada é gravado', async () => {
  const chave = chaveDeDuplicata('doutor-hernia-serra', EXISTENTE.id, 250, VENC, 'Consulta de avaliação', 'pedido-1');
  const hist: Lancamento[] = [{ conta: 'doutor-hernia-serra', tipo: 'cobranca', valor: 250, noTeto: 250, em: AGORA - 60_000, chave, id: 'pay_antiga' }];
  const m = montar({ clientes: [EXISTENTE] }, { historico: async () => hist });
  const igual = montar({ clientes: [EXISTENTE] }, { historico: async () => hist });
  await assert.rejects(() => cobrar(igual, { cpfCnpj: undefined, clienteId: EXISTENTE.id }), /cobrança igual.*pay_antiga/s);
  assert.equal(igual.f.posts().length, 0);
  const quebrado = montar({ clientes: [EXISTENTE] }, { historico: async () => { throw new Error('banco fora'); } });
  await assert.rejects(() => cobrar(quebrado), /não consegui conferir as operações recentes/);
  assert.equal(quebrado.f.posts().length, 0);
});

// ------------------------------------------------------------------ erros do Asaas

test('403: chave só de leitura → erro em português claro, sem vazar chave, CPF ou e-mail; a recusa definitiva libera a reserva', async () => {
  const m = montar({ clientes: [EXISTENTE], falhaNoPagamento: new ErroHttp(`o Asaas negou a gravação (403): chave ${CHAVE_COMPLETA} de maria.silva@exemplo.com cpf 52998224725`, 403) });
  const erro = await cobrar(m).then(() => null, (e: Error) => e);
  assert.ok(erro);
  for (const proibido of [CHAVE_COMPLETA, 'aact_prod', CPF_DIGITOS, 'maria.silva@exemplo.com']) assert.ok(!erro.message.includes(proibido), proibido);
  assert.match(erro.message, /A cobrança não saiu/);
  assert.ok(m.esc.livro.somaDoDia('doutor-hernia-serra', AGORA, 'America/Sao_Paulo') === 0, 'recusa definitiva não gasta o teto do dia');
});

test('sem resposta ou 5xx (pode ter criado): a mensagem diz que PODE ter sido gerada, a reserva fica (gasta o teto), o João é avisado', async () => {
  for (const erro of [new ErroHttp('timeout', null), new ErroHttp('Asaas 503', 503)]) {
    const m = montar({ clientes: [EXISTENTE], falhaNoPagamento: erro });
    await assert.rejects(() => cobrar(m), /PODE ter sido gerada/);
    assert.ok(m.esc.livro.somaDoDia('doutor-hernia-serra', AGORA, 'America/Sao_Paulo') === 250, 'a reserva fica');
    assert.equal(m.eventos.find((e) => e.evento === EVENTO_COBRANCA)!.args.incerto, true);
    assert.match(m.avisos.join('\n'), /RESULTADO INCERTO/);
    await assert.rejects(() => cobrar(m), /cobrança igual/, 'repetir o mesmo pedido é barrado');
  }
  const semId = montar({ clientes: [EXISTENTE] });
  semId.f.conta.escrita!.enviar = (async () => ({})) as never;
  await assert.rejects(() => cobrar(semId), /sem o id da cobrança.*PODE ter sido gerada/s);
});

test('o registro de sucesso (duplicata e tetos) sai ANTES da busca da linha digitável, que é melhor esforço', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  let soltar!: (v: unknown) => void;
  const original = m.f.conta.fonte.get.bind(m.f.conta.fonte);
  let pediuLinha!: () => void;
  const chegou = new Promise<void>((r) => (pediuLinha = r));
  (m.f.conta.fonte as { get: unknown }).get = async (caminho: string, q: Record<string, any>) => {
    if (/identificationField$/.test(caminho)) {
      pediuLinha();
      return new Promise((r) => (soltar = r));
    }
    return original(caminho, q);
  };
  const andamento = cobrar(m);
  await chegou;
  const ev = m.eventos.find((e) => e.evento === EVENTO_COBRANCA);
  assert.ok(ev && ev.ok, 'o registro de sucesso tem de existir enquanto a linha digitável ainda é buscada');
  assert.match(String(ev!.args.cobrancaId), /^pay_/);
  soltar({ identificationField: '34191.79001' });
  assert.equal((await andamento).cobranca.linhaDigitavel, '34191.79001');
  assert.equal(m.eventos.filter((e) => e.evento === EVENTO_COBRANCA).length, 1);

  const n = montar({ clientes: [EXISTENTE] }, { esperaLinhaMs: 20 });
  const orig2 = n.f.conta.fonte.get.bind(n.f.conta.fonte);
  (n.f.conta.fonte as { get: unknown }).get = async (caminho: string, q: Record<string, any>) => (/identificationField$/.test(caminho) ? new Promise(() => undefined) : orig2(caminho, q));
  const rn = await cobrar(n);
  assert.equal(rn.cobranca.linhaDigitavel, null);
  assert.ok(rn.cobranca.linkDoBoleto);
});

test('depois de escrever, a leitura em cache (asaas_cobrancas, extrato) da conta é esquecida — e a de outra conta não', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  m.asaas.cache.guardar('cob|doutor-hernia-serra|x', 1, 600_000);
  m.asaas.cache.guardar('ext|doutor-hernia-serra|x', 1, 600_000);
  m.asaas.cache.guardar('cob|outra|x', 1, 600_000);
  await cobrar(m);
  assert.equal(m.asaas.cache.pegar('cob|doutor-hernia-serra|x'), undefined);
  assert.equal(m.asaas.cache.pegar('ext|doutor-hernia-serra|x'), undefined);
  assert.equal(m.asaas.cache.pegar('cob|outra|x'), 1);
});

test('registro: CPF/CNPJ/telefone em externalReference e descrição é recusado, nunca gravado, e a recusa não repete o valor', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  for (const ref of ['52998224725', '529.982.247-25', '529 982 247 25', '11.222.333/0001-81', '63981411248', '6333214455']) {
    const erro = await cobrar(m, { externalReference: ref }).then(() => null, (e: Error) => e);
    assert.ok(erro, ref);
    assert.match(erro.message, /externalReference recusada/);
    assert.ok(!erro.message.includes(ref), 'a recusa repetiu o valor');
  }
  assert.equal((await cobrar(m, { externalReference: 'PED-20261028-N123' })).gerado, true);
  assert.equal(m.f.posts().length, 1);
  assert.ok(!tudo(m.eventos).includes(CPF_DIGITOS));
});

// ------------------------------------------------------------------ pelo protocolo (o que o claude.ai vê)

type Registro = { ferramenta: string; argumentos: any; ok: boolean; erro?: string };

async function conectar(m: ReturnType<typeof montar>, usuario: string, registros: Registro[]) {
  const server = new McpServer({ name: 't', version: '0' });
  registrarEscritaAsaas(server, m.asaas, m.esc, { id: usuario, email: `${usuario}@exemplo.com` }, (r) => registros.push(r as never));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const cliente = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(a), cliente.connect(b)]);
  return cliente;
}
const texto = (r: any) => String(r.content?.[0]?.text ?? '');

const FERRAMENTAS = ['asaas_cancelar_cobranca', 'asaas_cobranca', 'asaas_criar_cliente', 'asaas_criar_cobranca', 'asaas_editar_cliente', 'asaas_editar_cobranca', 'asaas_estornar_cobranca', 'asaas_limites', 'asaas_transferir'];

test('protocolo: as ferramentas são diretas (nada de preparar/confirmar) e NÃO existe nada de banco da clínica, chaves, webhooks, usuários, antecipação, empréstimo ou pagar conta', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  const joao = await conectar(m, 'u-joao', []);
  const nomes = (await joao.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(nomes, FERRAMENTAS);
  assert.ok(!nomes.some((n) => /prepar|confirmar|webhook|chave|token|usuario|antecip|emprest|conta_bancaria|dados_bancarios|pagar|bill|saque/.test(n)));
  const descricoes = (await joao.listTools()).tools.map((t) => t.description ?? '').join('\n');
  assert.match(descricoes, /NUNCA: altera dados bancários da clínica, chaves de API, webhooks ou usuários do Asaas/);
  assert.match(descricoes, /sem pedir confirmação/);
  assert.match(descricoes, /R\$ 5\.000 por operação e R\$ 20\.000 por dia/);
});

test('protocolo: cobrança direta pelo claude.ai grava na hora; o registro sai com argumentos mascarados e o erro sem vazamento', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  const registros: Registro[] = [];
  const joao = await conectar(m, 'u-joao', registros);
  const r = await joao.callTool({ name: 'asaas_criar_cobranca', arguments: { unidade: 'serra', cpfCnpj: CPF, valor: 100, vencimento: VENC, descricao: 'Boleto do paciente', externalReference: 'r1' } });
  assert.notEqual(r.isError, true);
  assert.equal(m.f.posts().length, 1, 'sem passo de confirmação');
  const cli = await joao.callTool({ name: 'asaas_criar_cliente', arguments: { unidade: 'serra', nome: 'Joana Souza', cpfCnpj: CNPJ, email: 'joana@exemplo.com', telefone: '63981411248' } });
  assert.notEqual(cli.isError, true);
  const aud = tudo(registros);
  assert.ok(!aud.includes('11222333000181') && !aud.includes('11.222.333/0001-81') && !aud.includes('joana@exemplo.com') && !aud.includes('981411248') && !aud.includes(CPF_DIGITOS), 'registro com dado por inteiro');
  assert.match(aud, /\*\*\.\*\*\*\.333\/0001-\*\*/);
  assert.ok(!aud.includes('Joana Souza') && aud.includes('Joana S.'), 'nome inteiro no registro');

  const ruim = montar({ clientes: [EXISTENTE], falhaNoPagamento: new ErroHttp(`Asaas 400 em /payments: customer 52998224725 / 529.982.247-25 / 11.222.333/0001-81 ${CHAVE_COMPLETA} maria.silva@exemplo.com`, 400) });
  const regs2: Registro[] = [];
  const c2 = await conectar(ruim, 'u1', regs2);
  const e = await c2.callTool({ name: 'asaas_criar_cobranca', arguments: { unidade: 'serra', cpfCnpj: CPF, valor: 100, vencimento: VENC, descricao: 'Boleto do paciente', externalReference: 'r1' } });
  assert.equal(e.isError, true);
  const saiu = texto(e) + tudo(regs2);
  for (const proibido of [CHAVE_COMPLETA, 'aact_prod', CPF_DIGITOS, '529.982.247-25', '11222333000181', '11.222.333/0001-81', 'maria.silva@exemplo.com']) assert.ok(!saiu.includes(proibido), `vazou: ${proibido}`);
  assert.match(saiu, /\[documento\]/);
});

test('protocolo: dado de cartão no pedido é recusado e nem chega inteiro ao registro; "todas" não vale para gravar', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  const registros: Registro[] = [];
  const joao = await conectar(m, 'u1', registros);
  const r = await joao.callTool({ name: 'asaas_criar_cobranca', arguments: { unidade: 'serra', cpfCnpj: CPF, valor: 100, vencimento: VENC, descricao: 'x', forma: 'CARTAO', numeroDoCartao: '4111111111111111', cvv: '123' } });
  assert.equal(r.isError, true);
  assert.match(texto(r), /NUNCA entram pelo chat/);
  assert.ok(!tudo(registros).includes('4111') && !tudo(registros).includes('"123"'), 'cartão no registro');
  assert.match(tudo(registros), /dadosDeCartaoRecusados/);
  const todas = await joao.callTool({ name: 'asaas_criar_cobranca', arguments: { unidade: 'todas', cpfCnpj: CPF, valor: 100, vencimento: VENC, descricao: 'x' } });
  assert.equal(todas.isError, true);
  assert.match(texto(todas), /numa conta só/);
  assert.equal(m.f.posts().length, 0);
});

test('o portão de quem escreve: fora da lista de escrita as ferramentas nem existem; na lista, são todas', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  const listar = async (usuario: string, escritores: Set<string>) => {
    const server = new McpServer({ name: 't', version: '0' });
    const registrou = registrarEscritaAsaasSePermitido(server, m.asaas, m.esc, usuario, escritores, () => undefined, 'x@y.com');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const cliente = new Client({ name: 'teste', version: '0' });
    await Promise.all([server.connect(a), cliente.connect(b)]);
    return { registrou, cliente, nomes: (await cliente.listTools().catch(() => ({ tools: [] }))).tools.map((t) => t.name).sort() };
  };
  const fora = await listar('u-fora', new Set(['u-joao']));
  assert.equal(fora.registrou, false);
  assert.deepEqual(fora.nomes, []);
  const chamada = await fora.cliente.callTool({ name: 'asaas_criar_cobranca', arguments: { unidade: 'serra', cpfCnpj: CPF, valor: 1, vencimento: VENC, descricao: 'x' } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
  assert.equal((chamada as { isError?: boolean }).isError, true);
  const vazia = await listar('u-joao', new Set());
  assert.equal(vazia.registrou, false, 'sem lista de escrita, ninguém escreve');
  assert.deepEqual(vazia.nomes, []);
  const dentro = await listar('u-joao', new Set(['u-joao']));
  assert.equal(dentro.registrou, true);
  assert.deepEqual(dentro.nomes, FERRAMENTAS);
  assert.equal(m.f.chamadas.length, 0);
});

test('producao.ts liga a escrita SÓ pelo portão testado (lista de escritores), com o Telegram e o histórico da auditoria', () => {
  const src = readFileSync(new URL('./producao.ts', import.meta.url), 'utf8');
  assert.equal(src.match(/registrarEscritaAsaasSePermitido\(/g)?.length, 1);
  assert.match(src, /registrarEscritaAsaasSePermitido\(server, asaas, escritaAsaas, quem\.userId, escritores, auditar, quem\.email\)/);
  // ninguém chama o registrador cru, que não confere quem pode escrever
  assert.equal(src.match(/\bregistrarEscritaAsaas\(/g), null);
  assert.doesNotMatch(src, /import \{[^}]*\bregistrarEscritaAsaas\b[^}]*\} from/);
  // o aviso de cada transferência/estorno/cancelamento sai pelo Telegram de verdade, e o teto do dia vem do banco
  assert.match(src, /criarEscritaAsaas\(\{[^}]*lancamentosRecentesDe\(prisma, conta\)[^}]*alertar: \(texto\) => enviarTelegram\(texto\)/s);
  assert.match(src, /asaasEscrever\(c\.unitId, c\.chave, metodo, caminho, corpo\)/);
});
