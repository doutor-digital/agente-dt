import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErroHttp, montar, type Cli, type Sub } from './asaas-falso.js';
import { asaasAssinaturas, cancelarAssinatura, cicloValido, criarAssinatura, editarAssinatura, formaDaAssinatura, type PedidoDeAssinatura } from './asaas-assinaturas.js';
import { EVENTO_COBRANCA, EVENTO_OPERACAO } from './asaas-escrita.js';
import { registrarEscritaAsaas } from './asaas-ferramentas.js';
import { asaasEscrever } from '../lib/integracoes/asaas-escrita.js';

const Q = { id: 'u1', email: 'lia@exemplo.com' };
const CNPJ = '11.222.333/0001-81';
const EMPRESA: Cli = { id: 'cus_000005401844', name: 'Biazzi Fisioterapia', cpfCnpj: '11222333000181', notificationDisabled: true };
const pedido = (o: Partial<PedidoDeAssinatura> = {}): PedidoDeAssinatura => ({
  unidade: 'serra', clienteId: EMPRESA.id, valor: 400, primeiroVencimento: '2026-10-28', descricao: 'Mensalidade Doutor Digital', forma: 'CLIENTE_ESCOLHE', ...o,
});

test('forma e ciclo: CLIENTE_ESCOLHE vira UNDEFINED, padrão BOLETO e MENSAL; aceita "mensal" e "a escolher"; o resto recusa', () => {
  assert.equal(formaDaAssinatura(undefined), 'BOLETO');
  assert.equal(formaDaAssinatura('a escolher'), 'CLIENTE_ESCOLHE');
  assert.equal(formaDaAssinatura('cartão'), 'CARTAO');
  assert.throws(() => formaDaAssinatura('cheque'), /não existe/);
  assert.equal(cicloValido(undefined), 'MENSAL');
  assert.equal(cicloValido('mensal'), 'MENSAL');
  assert.equal(cicloValido('YEARLY'), 'ANUAL');
  assert.throws(() => cicloValido('diario'), /não existe/);
});

test('criar: POST /subscriptions com o corpo certo, conta como cobrança no teto, avisa o João e devolve a 1ª cobrança com o link', async () => {
  const m = montar({ clientes: [EMPRESA] });
  const r = (await criarAssinatura(m.ctx, Q, pedido(), m.registrar)) as any;
  assert.equal(r.criada, true);
  const post = m.f.posts().find((p) => p.caminho === '/subscriptions')!;
  assert.deepEqual(post.corpo, { customer: EMPRESA.id, billingType: 'UNDEFINED', value: 400, nextDueDate: '2026-10-28', cycle: 'MONTHLY', description: 'Mensalidade Doutor Digital' });
  assert.equal(r.assinatura.ciclo, 'mensal');
  assert.equal(r.primeiraCobranca.linkParaPagar, 'https://www.asaas.com/i/sub123');
  assert.equal(await m.usado(), 400);
  const ev = m.eventos.find((e) => e.evento === EVENTO_COBRANCA && e.ok)!;
  assert.equal(ev.args.assinatura, true);
  assert.match(String(ev.args.idAsaas), /^sub_/);
  assert.ok(ev.args.intencaoId, 'o resultado resolve a intenção');
  assert.equal(m.avisos.length, 1);
  assert.match(m.avisos[0]!, /ASSINATURA CRIADA/);
  assert.ok(!m.avisos[0]!.includes('Biazzi'), 'nome do cliente fora do Telegram');
});

test('criar: por CPF/CNPJ acha o cadastro; sem cadastro recusa sem chamar o Asaas; dois cadastros não adivinha', async () => {
  const m = montar({ clientes: [EMPRESA] });
  const r = (await criarAssinatura(m.ctx, Q, pedido({ clienteId: undefined, cpfCnpj: CNPJ }), m.registrar)) as any;
  assert.equal(r.cliente.id, EMPRESA.id);
  const n = montar({ clientes: [] });
  await assert.rejects(() => criarAssinatura(n.ctx, Q, pedido({ clienteId: undefined, cpfCnpj: CNPJ }), n.registrar), /asaas_criar_cliente/);
  assert.equal(n.f.posts().length, 0);
  const d = montar({ clientes: [EMPRESA, { ...EMPRESA, id: 'cus_000005409999' }] });
  await assert.rejects(() => criarAssinatura(d.ctx, Q, pedido({ clienteId: undefined, cpfCnpj: CNPJ }), d.registrar), /2 cadastros/);
  await assert.rejects(() => criarAssinatura(m.ctx, Q, pedido({ cpfCnpj: CNPJ }), m.registrar), /um dos dois/);
});

test('criar: igual em 10 min recusa; ativa igual (valor e ciclo) recusa sem permitirOutraIgual; passou do teto recusa sem chamar o Asaas', async () => {
  const m = montar({ clientes: [EMPRESA] });
  await criarAssinatura(m.ctx, Q, pedido(), m.registrar);
  await assert.rejects(() => criarAssinatura(m.ctx, Q, pedido({ descricao: 'Outra descrição' }), m.registrar), /JÁ tem a assinatura ATIVA/);
  const ativa: Sub = { id: 'sub_existente01', customer: EMPRESA.id, value: 400, cycle: 'MONTHLY', nextDueDate: '2026-11-25', billingType: 'BOLETO', description: 'x', status: 'ACTIVE' };
  const n = montar({ clientes: [EMPRESA], assinaturas: [ativa] });
  await assert.rejects(() => criarAssinatura(n.ctx, Q, pedido(), n.registrar), /sub_existente01/);
  const ok = (await criarAssinatura(n.ctx, Q, pedido({ permitirOutraIgual: true }), n.registrar)) as any;
  assert.equal(ok.criada, true);
  assert.match(ok.outraIgual, /criei OUTRA/);
  const t = montar({ clientes: [EMPRESA] }, { tetoOperacao: () => 300 });
  await assert.rejects(() => criarAssinatura(t.ctx, Q, pedido(), t.registrar), /teto/i);
  assert.equal(t.f.posts().length, 0);
  // duplicata exata (sem a trava da ativa: a 1ª falhou com 4xx não conta, mas a de sucesso conta)
  const dup = montar({ clientes: [EMPRESA] });
  await criarAssinatura(dup.ctx, Q, pedido(), dup.registrar);
  dup.f.assinaturas[0]!.status = 'INACTIVE';
  await assert.rejects(() => criarAssinatura(dup.ctx, Q, pedido(), dup.registrar), /menos de 10 minutos/);
});

test('criar: cliente com aviso automático LIGADO exige avisarCliente=true; cartão pelo chat recusa', async () => {
  const m = montar({ clientes: [{ ...EMPRESA, notificationDisabled: false }] });
  await assert.rejects(() => criarAssinatura(m.ctx, Q, pedido(), m.registrar), /LIGADO/);
  const r = (await criarAssinatura(m.ctx, Q, pedido({ avisarCliente: true }), m.registrar)) as any;
  assert.equal(r.avisouOCliente, true);
  await assert.rejects(() => criarAssinatura(m.ctx, Q, pedido({ cardNumber: '4111111111111111' } as any), m.registrar), /cartão NUNCA/);
});

test('criar: sem resposta do Asaas é "PODE ter sido criada" e conta no teto; 4xx não conta; 1ª cobrança ainda não gerada vira atenção', async () => {
  const m = montar({ clientes: [EMPRESA], falhaNaAssinatura: new ErroHttp('timeout', null) });
  await assert.rejects(() => criarAssinatura(m.ctx, Q, pedido(), m.registrar), /PODE ter sido criada/);
  assert.equal(await m.usado(), 400);
  assert.match(m.avisos.join('\n'), /INCERTO/);
  const n = montar({ clientes: [EMPRESA], falhaNaAssinatura: new ErroHttp('Asaas 400: invalid', 400) });
  await assert.rejects(() => criarAssinatura(n.ctx, Q, pedido(), n.registrar), /não foi criada/);
  assert.equal(await n.usado(), 0);
  const s = montar({ clientes: [EMPRESA], assinaturaSemCobranca: true }, { esperaLinhaMs: 50 });
  const r = (await criarAssinatura(s.ctx, Q, pedido(), s.registrar)) as any;
  assert.match(r.atencao, /ainda não apareceu/);
});

test('consultar: lista por cliente e traz as cobranças de uma assinatura', async () => {
  const m = montar({ clientes: [EMPRESA] });
  const c = (await criarAssinatura(m.ctx, Q, pedido(), m.registrar)) as any;
  const lista = (await asaasAssinaturas(m.ctx, { unidade: 'serra', clienteId: EMPRESA.id })) as any;
  assert.equal(lista.assinaturas.length, 1);
  assert.equal(lista.assinaturas[0].forma, 'o cliente escolhe (boleto, Pix ou cartão)');
  const uma = (await asaasAssinaturas(m.ctx, { unidade: 'serra', assinaturaId: c.assinatura.id })) as any;
  assert.equal(uma.cobrancas.length, 1);
  await assert.rejects(() => asaasAssinaturas(m.ctx, { unidade: 'serra', assinaturaId: '../x' }), /assinaturaId inválido/);
});

test('editar: PUT só com o pedido; aumento reserva o acréscimo; avisa o João; cancelar manda DELETE, conta no limite por hora e avisa', async () => {
  const m = montar({ clientes: [EMPRESA] });
  const c = (await criarAssinatura(m.ctx, Q, pedido(), m.registrar)) as any;
  const id = c.assinatura.id;
  const e = (await editarAssinatura(m.ctx, Q, { unidade: 'serra', assinaturaId: id, valor: 450 }, m.registrar)) as any;
  assert.equal(e.alterada, true);
  assert.deepEqual(m.f.posts().find((p) => p.metodo === 'PUT')!.corpo, { value: 450, updatePendingPayments: false });
  assert.equal(await m.usado(), 450);
  const ev = m.eventos.find((x) => x.evento === EVENTO_OPERACAO && x.args.operacao === 'editar_assinatura')!;
  assert.equal(ev.args.noTeto, 50);
  await assert.rejects(() => editarAssinatura(m.ctx, Q, { unidade: 'serra', assinaturaId: id }, m.registrar), /nada para alterar/);
  const x = (await cancelarAssinatura(m.ctx, Q, { unidade: 'serra', assinaturaId: id }, m.registrar)) as any;
  assert.equal(x.cancelada, true);
  assert.ok(m.f.posts().some((p) => p.metodo === 'DELETE' && p.caminho === `/subscriptions/${id}`));
  assert.match(m.avisos.join('\n'), /ASSINATURA EDITADA/);
  assert.match(m.avisos.join('\n'), /ASSINATURA CANCELADA/);
  assert.ok(!m.avisos.join('\n').includes('Mensalidade Doutor Digital'), 'descrição fora do Telegram');
  await assert.rejects(() => cancelarAssinatura(m.ctx, Q, { unidade: 'serra', assinaturaId: id }, m.registrar), /não existe/);
  const n = montar({ clientes: [EMPRESA] }, { cancelamentosPorHora: () => 0 });
  const c2 = (await criarAssinatura(n.ctx, Q, pedido(), n.registrar)) as any;
  await assert.rejects(() => cancelarAssinatura(n.ctx, Q, { unidade: 'serra', assinaturaId: c2.assinatura.id }, n.registrar), /cancelamentos por hora/);
});

test('ferramentas: as 4 de assinatura existem para quem escreve e o pedido com campo de cartão é recusado', async () => {
  const m = montar({ clientes: [EMPRESA] });
  const server = new McpServer({ name: 't', version: '0' });
  registrarEscritaAsaas(server, m.asaas, m.esc, Q, () => true);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const cli = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(a), cli.connect(b)]);
  const nomes = (await cli.listTools()).tools.map((t) => t.name);
  for (const n of ['asaas_criar_assinatura', 'asaas_assinaturas', 'asaas_editar_assinatura', 'asaas_cancelar_assinatura']) assert.ok(nomes.includes(n), n);
  const r = await cli.callTool({ name: 'asaas_criar_assinatura', arguments: { ...pedido(), cvv: '123' } });
  assert.equal(r.isError, true);
  assert.equal(m.f.posts().length, 0);
  await cli.close();
});

test('editar: com atualizarCobrancasPendentes o aumento conta uma vez por cobrança pendente; encerrada não edita; ciclo não é campo da edição', async () => {
  const m = montar({ clientes: [EMPRESA] });
  const c = (await criarAssinatura(m.ctx, Q, pedido(), m.registrar)) as any;
  m.f.pagamentos.push({ id: 'pay_extra0000001', status: 'OVERDUE', customer: EMPRESA.id, value: 400, subscription: c.assinatura.id } as any);
  await editarAssinatura(m.ctx, Q, { unidade: 'serra', assinaturaId: c.assinatura.id, valor: 500, atualizarCobrancasPendentes: true }, m.registrar);
  const ev = m.eventos.find((x) => x.evento === EVENTO_OPERACAO && x.args.operacao === 'editar_assinatura')!;
  assert.equal(ev.args.noTeto, 200);
  assert.equal(m.f.posts().find((p) => p.metodo === 'PUT')!.corpo!.updatePendingPayments, true);
  m.f.assinaturas[0]!.status = 'EXPIRED';
  await assert.rejects(() => editarAssinatura(m.ctx, Q, { unidade: 'serra', assinaturaId: c.assinatura.id, descricao: 'x' }, m.registrar), /encerrada/);
});

test('criar: externalReference já usada em outra assinatura recusa sem chamar o Asaas', async () => {
  const m = montar({ clientes: [EMPRESA] });
  await criarAssinatura(m.ctx, Q, pedido({ externalReference: 'contrato-biazzi' }), m.registrar);
  m.f.assinaturas[0]!.status = 'INACTIVE';
  const antes = m.f.posts().length;
  await assert.rejects(() => criarAssinatura(m.ctx, Q, pedido({ externalReference: 'contrato-biazzi', descricao: 'Outra' }), m.registrar), /já está na assinatura/);
  assert.equal(m.f.posts().length, antes);
});

test('caminho de PRODUÇÃO: criar passa pela lista fechada de rotas (asaasEscrever) e chega ao Asaas uma vez, com a chave só no cabeçalho', async () => {
  const m = montar({ clientes: [EMPRESA] });
  const saidas: Array<{ url: string; method?: string; body?: string }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    saidas.push({ url, method: init.method, body: String(init.body ?? '') });
    return new Response(JSON.stringify({ id: 'sub_VXJBYgP2u0eO', status: 'ACTIVE', value: 400, cycle: 'MONTHLY', nextDueDate: '2026-10-28', billingType: 'UNDEFINED' }), { status: 200 });
  }) as unknown as typeof fetch;
  (m.f.conta as any).escrita.enviar = (metodo: 'POST' | 'PUT' | 'DELETE', caminho: string, corpo?: Record<string, unknown>) => asaasEscrever('c-prod', 'aact_chave_falsa_1234567890', metodo, caminho, corpo, fetcher);
  const r = (await criarAssinatura(m.ctx, Q, pedido(), m.registrar)) as any;
  assert.equal(r.criada, true);
  assert.equal(r.assinatura.id, 'sub_VXJBYgP2u0eO');
  assert.equal(saidas.length, 1);
  assert.equal(saidas[0]!.method, 'POST');
  assert.match(saidas[0]!.url, /\/subscriptions$/);
  assert.equal(JSON.parse(saidas[0]!.body!).billingType, 'UNDEFINED');
  assert.equal(await m.usado(), 400);
  assert.match(m.avisos[0]!, /ASSINATURA CRIADA/);
});
