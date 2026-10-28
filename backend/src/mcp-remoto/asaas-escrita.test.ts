import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { criarContextoAsaas, type ContaAsaas } from './asaas.js';
import {
  chaveDeDuplicata, confirmarCliente, confirmarCobranca, criarEscritaAsaas, EVENTO_COBRANCA, EVENTO_CLIENTE, mascararDoc, prepararCliente, prepararCobranca,
  registrarEscritaAsaas, tetoDaCobranca, cobrancasPorHora, validarCpfCnpj, type PedidoDeCobranca, type RegistroDeCobranca,
} from './asaas-escrita.js';

const CPF = '529.982.247-25';
const CPF_DIGITOS = '52998224725';
const CNPJ = '11.222.333/0001-81';
const CHAVE_COMPLETA = '$aact_prod_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OjAwMDAwXXYZ';
const AGORA = Date.parse('2026-10-28T15:00:00-03:00');
const VENC = '2026-11-10';

class ErroHttp extends Error {
  constructor(msg: string, readonly status: number | null) {
    super(msg);
  }
}

interface Cli { id: string; name: string; cpfCnpj: string; email?: string; mobilePhone?: string; notificationDisabled?: boolean; deleted?: boolean }

interface Opc {
  clientes?: Cli[];
  pagamentos?: Array<{ id: string; externalReference?: string }>;
  falhaNoPagamento?: Error;
  falhaNoCliente?: Error;
  semNomeDaConta?: boolean;
  semEscrita?: boolean;
  semLinhaDigitavel?: boolean;
  /** o Asaas devolve estes clientes para QUALQUER busca por documento (resposta fora do combinado) */
  clientesTortos?: Cli[];
}

function asaasFalso(o: Opc = {}) {
  const clientes = [...(o.clientes ?? [])];
  const pagamentos = [...(o.pagamentos ?? [])];
  const posts: Array<[string, Record<string, any>]> = [];
  const gets: string[] = [];
  let seq = 0;
  const conta: ContaAsaas = {
    slug: 'doutor-hernia-serra',
    nome: 'Serra',
    fonte: {
      async get<T>(caminho: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
        gets.push(caminho);
        if (caminho === '/myAccount/commercialInfo') {
          if (o.semNomeDaConta) throw new ErroHttp('Asaas 404', 404);
          return { companyName: 'Clínica Serra Saúde LTDA' } as T;
        }
        if (caminho === '/customers') {
          const doc = String(query.cpfCnpj ?? '');
          if (o.clientesTortos) return { data: o.clientesTortos } as T;
          return { data: clientes.filter((c) => !c.deleted && c.cpfCnpj.replace(/\D/g, '') === doc) } as T;
        }
        const m = caminho.match(/^\/customers\/(.+)$/);
        if (m) {
          const c = clientes.find((x) => x.id === m[1]);
          if (!c) throw new ErroHttp('Asaas 404 em /customers', 404);
          return c as T;
        }
        if (caminho === '/payments') return { data: pagamentos.filter((p) => p.externalReference === query.externalReference) } as T;
        if (/^\/payments\/.+\/identificationField$/.test(caminho)) {
          if (o.semLinhaDigitavel) throw new ErroHttp('Asaas 404', 404);
          return { identificationField: '34191.79001 01043.510047 91020.150008 5 87650026000' } as T;
        }
        throw new Error(`rota não simulada: ${caminho}`);
      },
    },
    ...(o.semEscrita
      ? {}
      : {
          escrita: {
            chaveFinal: '…xYZ1',
            contaSalva: 'Serra (nome salvo)',
            async post<T>(caminho: string, corpo: Record<string, unknown>): Promise<T> {
              posts.push([caminho, corpo]);
              if (caminho === '/customers') {
                if (o.falhaNoCliente) throw o.falhaNoCliente;
                const c: Cli = { id: `cus_00000${++seq}1234`, name: String(corpo.name), cpfCnpj: String(corpo.cpfCnpj), notificationDisabled: corpo.notificationDisabled === true };
                clientes.push(c);
                return c as T;
              }
              if (o.falhaNoPagamento) throw o.falhaNoPagamento;
              const p = { id: `pay_${++seq}0000000001`, status: 'PENDING', ...corpo, bankSlipUrl: 'https://www.asaas.com/b/pdf/abc123', invoiceUrl: 'https://www.asaas.com/i/abc123' };
              pagamentos.push({ id: p.id, externalReference: corpo.externalReference as string | undefined });
              return p as T;
            },
          },
        }),
  };
  return { conta, clientes, posts, gets, pagamentos };
}

function montar(o: Opc = {}, op: { historico?: (c: string) => Promise<RegistroDeCobranca[]>; tetoReais?: () => number; porHora?: () => number } = {}) {
  const f = asaasFalso(o);
  const relogio = { t: AGORA };
  const esc = criarEscritaAsaas({ agora: () => relogio.t, ...op });
  const asaas = criarContextoAsaas(new Map([[f.conta.slug, f.conta]]));
  const eventos: Array<{ evento: string; args: Record<string, any>; ok: boolean; erro?: string }> = [];
  const registrar = (evento: string, args: Record<string, unknown>, ok: boolean, erro?: string) => eventos.push({ evento, args, ok, erro });
  return { f, esc, asaas, ctx: { asaas, esc }, relogio, eventos, registrar };
}

const COBRANCA: PedidoDeCobranca = { unidade: 'serra', cpfCnpj: CPF, valor: 250, vencimento: VENC, descricao: 'Consulta de avaliação', externalReference: 'pedido-1' };
const EXISTENTE: Cli = { id: 'cus_000005401844', name: 'Maria da Silva', cpfCnpj: CPF_DIGITOS, email: 'maria.silva@exemplo.com', mobilePhone: '63981411248', notificationDisabled: true };
const tudo = (x: unknown) => JSON.stringify(x);

// ------------------------------------------------------------------ validação

test('CPF e CNPJ: dígitos verificadores conferidos; sequência repetida e tamanho errado caem', () => {
  assert.equal(validarCpfCnpj(CPF), CPF_DIGITOS);
  assert.equal(validarCpfCnpj(CNPJ), '11222333000181');
  assert.throws(() => validarCpfCnpj('529.982.247-26'), /CPF inválido/);
  assert.throws(() => validarCpfCnpj('11.222.333/0001-80'), /CNPJ inválido/);
  assert.throws(() => validarCpfCnpj('111.111.111-11'), /CPF inválido/);
  assert.throws(() => validarCpfCnpj('123'), /11 dígitos/);
  assert.equal(mascararDoc(CPF_DIGITOS), '***.982.247-**');
});

test('limites vêm do ambiente, com padrão 5000 e 20 por hora; valor inválido volta ao padrão', () => {
  assert.equal(tetoDaCobranca({}), 5000);
  assert.equal(tetoDaCobranca({ ASAAS_COBRANCA_MAX_REAIS: '1200' }), 1200);
  assert.equal(tetoDaCobranca({ ASAAS_COBRANCA_MAX_REAIS: 'abc' }), 5000);
  assert.equal(tetoDaCobranca({ ASAAS_COBRANCA_MAX_REAIS: '-3' }), 5000);
  assert.equal(cobrancasPorHora({}), 20);
  assert.equal(cobrancasPorHora({ ASAAS_COBRANCAS_POR_HORA: '5' }), 5);
});

// ------------------------------------------------------------------ cadastrar cliente

test('cliente: a prévia NÃO grava, mostra a conta (nome e final da chave) e mascara documento, e-mail e telefone', async () => {
  const { f, ctx } = montar();
  const r = await prepararCliente(ctx, 'u1', { unidade: 'serra', nome: 'Maria da Silva', cpfCnpj: CPF, email: 'maria.silva@exemplo.com', telefone: '(63) 98141-1248' });
  assert.equal(f.posts.length, 0);
  assert.equal(r.jaCadastrado, false);
  assert.deepEqual(r.conta, { unidade: 'doutor-hernia-serra', nomeDaConta: 'Clínica Serra Saúde LTDA', chaveTermina: '…xYZ1' });
  assert.match(String(r.confirmacao), /^[0-9A-F]{12}$/);
  const j = tudo(r);
  assert.ok(!j.includes(CPF_DIGITOS) && !j.includes('529.982.247-25'), 'CPF inteiro vazou');
  assert.ok(!j.includes('maria.silva@exemplo.com') && !j.includes('98141-1248') && !j.includes('981411248'), 'e-mail/telefone inteiros vazaram');
  assert.ok(!j.includes('aact'), 'chave');
  assert.match(j, /NÃO vai mandar e-mail nem SMS/);
});

test('cliente: CPF já cadastrado → "já cadastrado", devolve o id e NÃO cria outro nem gera código', async () => {
  const { f, ctx } = montar({ clientes: [EXISTENTE] });
  const r = await prepararCliente(ctx, 'u1', { unidade: 'serra', nome: 'Maria S', cpfCnpj: CPF });
  assert.equal(r.jaCadastrado, true);
  assert.equal(r.confirmacao, null);
  assert.match(String(r.instrucao), /cus_000005401844/);
  assert.equal(f.posts.length, 0);
  assert.ok(!tudo(r).includes('maria.silva@exemplo.com'));
});

test('cliente: CPF inválido, e-mail, telefone e CEP ruins são recusados antes de qualquer coisa', async () => {
  const { f, ctx } = montar();
  await assert.rejects(() => prepararCliente(ctx, 'u1', { unidade: 'serra', nome: 'Maria', cpfCnpj: '529.982.247-26' }), /CPF inválido/);
  await assert.rejects(() => prepararCliente(ctx, 'u1', { unidade: 'serra', nome: 'Maria', cpfCnpj: CPF, email: 'sem-arroba' }), /e-mail inválido/);
  await assert.rejects(() => prepararCliente(ctx, 'u1', { unidade: 'serra', nome: 'Maria', cpfCnpj: CPF, telefone: '123' }), /telefone inválido/);
  await assert.rejects(() => prepararCliente(ctx, 'u1', { unidade: 'serra', nome: 'Maria', cpfCnpj: CPF, endereco: { cep: '123', logradouro: 'Rua A', numero: '1' } }), /CEP/);
  await assert.rejects(() => prepararCliente(ctx, 'u1', { unidade: 'serra', nome: 'M', cpfCnpj: CPF }), /nome do cliente/);
  assert.equal(f.posts.length, 0);
});

test('cliente: confirmar cria SEM aviso (notificationDisabled=true), com avisarCliente=true liga, e o registro sai mascarado', async () => {
  const { f, ctx, registrar, eventos } = montar();
  const p = await prepararCliente(ctx, 'u1', { unidade: 'serra', nome: 'Maria da Silva', cpfCnpj: CPF, email: 'maria@exemplo.com', telefone: '63981411248', endereco: { cep: '77000-000', logradouro: 'Rua A', numero: '10', bairro: 'Centro' } });
  const r = (await confirmarCliente(ctx, 'u1', { confirmacao: String(p.confirmacao).toLowerCase() }, registrar)) as any;
  assert.equal(r.cadastrado, true);
  assert.equal(f.posts.length, 1);
  const [caminho, corpo] = f.posts[0]!;
  assert.equal(caminho, '/customers');
  assert.deepEqual(corpo, { name: 'Maria da Silva', cpfCnpj: CPF_DIGITOS, email: 'maria@exemplo.com', mobilePhone: '63981411248', postalCode: '77000000', address: 'Rua A', addressNumber: '10', province: 'Centro', notificationDisabled: true });
  assert.equal(eventos[0]!.evento, EVENTO_CLIENTE);
  assert.equal(eventos[0]!.args.pediuPor, 'u1');
  assert.equal(eventos[0]!.args.confirmadoPor, 'u1');
  assert.ok(!tudo(eventos).includes(CPF_DIGITOS) && !tudo(r).includes(CPF_DIGITOS));

  const m2 = montar();
  const p2 = await prepararCliente(m2.ctx, 'u1', { unidade: 'serra', nome: 'Maria da Silva', cpfCnpj: CPF, avisarCliente: true });
  assert.match(tudo(p2), /PODE mandar e-mail/);
  await confirmarCliente(m2.ctx, 'u1', { confirmacao: String(p2.confirmacao) }, m2.registrar);
  assert.equal(m2.f.posts[0]![1].notificationDisabled, false);
});

test('cliente: confirmação dupla (em fila ou junta) cria UM só; código de outro usuário, vencido ou de boleto não serve', async () => {
  const { f, ctx, relogio, registrar } = montar();
  const p = await prepararCliente(ctx, 'u1', { unidade: 'serra', nome: 'Maria da Silva', cpfCnpj: CPF });
  await assert.rejects(() => confirmarCliente(ctx, 'u2', { confirmacao: String(p.confirmacao) }, registrar), /outro usuário/);
  const [a, b] = await Promise.allSettled([confirmarCliente(ctx, 'u1', { confirmacao: String(p.confirmacao) }, registrar), confirmarCliente(ctx, 'u1', { confirmacao: String(p.confirmacao) }, registrar)]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.match(String((b as PromiseRejectedResult).reason.message), /já usado/);
  assert.equal(f.posts.length, 1);
  await assert.rejects(() => confirmarCliente(ctx, 'u1', { confirmacao: String(p.confirmacao) }, registrar), /já usado/);

  const p2 = await prepararCliente(ctx, 'u1', { unidade: 'serra', nome: 'Joana Souza', cpfCnpj: CNPJ });
  relogio.t += 16 * 60_000;
  await assert.rejects(() => confirmarCliente(ctx, 'u1', { confirmacao: String(p2.confirmacao) }, registrar), /venceu/);
  assert.equal(f.posts.length, 1);

  const cob = await prepararCobranca(ctx, 'u1', { ...COBRANCA, cpfCnpj: undefined, clienteId: f.clientes[0]!.id, externalReference: 'x-9', vencimento: VENC });
  await assert.rejects(() => confirmarCliente(ctx, 'u1', { confirmacao: String(cob.confirmacao) }, registrar), /boleto/);
});

test('cliente: se alguém cadastrou entre a prévia e o ok, o confirmar não cria outro', async () => {
  const { f, ctx, registrar } = montar();
  const p = await prepararCliente(ctx, 'u1', { unidade: 'serra', nome: 'Maria da Silva', cpfCnpj: CPF });
  f.clientes.push(EXISTENTE);
  const r = (await confirmarCliente(ctx, 'u1', { confirmacao: String(p.confirmacao) }, registrar)) as any;
  assert.equal(r.jaCadastrado, true);
  assert.equal(f.posts.length, 0);
});

// ------------------------------------------------------------------ a conta

test('conta: "todas", lista, vazio, conta sem escrita ou desconhecida são recusados — nada é consultado nem gravado', async () => {
  const { f, ctx } = montar();
  for (const u of ['todas', 'TODAS', ' todas ', 'serra,maraba', '']) {
    await assert.rejects(() => prepararCliente(ctx, 'u1', { unidade: u, nome: 'Maria', cpfCnpj: CPF }), /UMA|numa conta só|informe a unidade/, u);
    await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, unidade: u }), /UMA|numa conta só|informe a unidade/, u);
  }
  await assert.rejects(() => prepararCliente(ctx, 'u1', { unidade: 'maraba', nome: 'Maria', cpfCnpj: CPF }), /sem Asaas/);
  const so = montar({ semEscrita: true });
  await assert.rejects(() => prepararCliente(so.ctx, 'u1', { unidade: 'serra', nome: 'Maria', cpfCnpj: CPF }), /não está liberada para escrita/);
  assert.equal(f.posts.length + so.f.posts.length, 0);
  assert.equal(f.gets.length + so.f.gets.length, 0);
});

test('conta: sem o nome no Asaas usa o nome salvo; sem nenhum, avisa para conferir pelo final da chave', async () => {
  const a = montar({ semNomeDaConta: true });
  const r = await prepararCliente(a.ctx, 'u1', { unidade: 'serra', nome: 'Maria', cpfCnpj: CPF });
  assert.equal(r.conta.nomeDaConta, 'Serra (nome salvo)');
  const b = montar({ semNomeDaConta: true });
  (b.f.conta.escrita as { contaSalva?: string | null }).contaSalva = null;
  const r2 = await prepararCliente(b.ctx, 'u1', { unidade: 'serra', nome: 'Maria', cpfCnpj: CPF });
  assert.equal(r2.conta.nomeDaConta, null);
  assert.match(r2.avisos.join(' '), /final da chave/);
});

// ------------------------------------------------------------------ boleto

test('boleto de cliente que já existe: prévia mostra tudo e NÃO grava; confirmar manda BOLETO e devolve os links', async () => {
  const { f, ctx, registrar, eventos } = montar({ clientes: [EXISTENTE] });
  const p = await prepararCobranca(ctx, 'u1', COBRANCA);
  assert.equal(f.posts.length, 0);
  assert.equal(p.cliente.situacao, 'já cadastrado');
  assert.equal(p.conta.chaveTermina, '…xYZ1');
  assert.match(p.boleto.valor, /^R\$ 250,00$/);
  assert.match(p.boleto.vencimento, /^10\/11\/2026/);
  assert.equal(p.aviso.vaiAvisar, false);
  const j = tudo(p);
  assert.ok(!j.includes(CPF_DIGITOS) && !j.includes('maria.silva@exemplo.com') && !j.includes('981411248'));

  const r = (await confirmarCobranca(ctx, 'u1', { confirmacao: String(p.confirmacao) }, registrar)) as any;
  assert.equal(f.posts.length, 1, 'só o pagamento: o cliente já existia');
  assert.deepEqual(f.posts[0], ['/payments', { customer: 'cus_000005401844', billingType: 'BOLETO', value: 250, dueDate: VENC, description: 'Consulta de avaliação', externalReference: 'pedido-1' }]);
  assert.equal(r.gerado, true);
  assert.match(r.cobranca.id, /^pay_/);
  assert.equal(r.cobranca.linkDoBoleto, 'https://www.asaas.com/b/pdf/abc123');
  assert.equal(r.cobranca.linkDaFatura, 'https://www.asaas.com/i/abc123');
  assert.match(r.cobranca.linhaDigitavel, /^34191/);
  assert.equal(r.avisouOCliente, false);
  const ev = eventos.find((e) => e.evento === EVENTO_COBRANCA)!;
  assert.equal(ev.ok, true);
  assert.equal(ev.args.pediuPor, 'u1');
  assert.equal(ev.args.confirmadoPor, 'u1');
  assert.equal(ev.args.cobrancaId, r.cobranca.id);
  assert.ok(!tudo(eventos).includes(CPF_DIGITOS));
});

test('boleto sem a linha digitável ainda: o link basta e a resposta não quebra', async () => {
  const { ctx, registrar } = montar({ clientes: [EXISTENTE], semLinhaDigitavel: true });
  const p = await prepararCobranca(ctx, 'u1', COBRANCA);
  const r = (await confirmarCobranca(ctx, 'u1', { confirmacao: String(p.confirmacao) }, registrar)) as any;
  assert.equal(r.cobranca.linhaDigitavel, null);
  assert.ok(r.cobranca.linkDoBoleto);
});

test('boleto por clienteId funciona e id malformado (caminho de URL) é recusado antes de ir ao Asaas', async () => {
  const { f, ctx } = montar({ clientes: [EXISTENTE] });
  const p = await prepararCobranca(ctx, 'u1', { ...COBRANCA, cpfCnpj: undefined, clienteId: 'cus_000005401844' });
  assert.equal((p.cliente as { id?: string }).id, 'cus_000005401844');
  await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, cpfCnpj: undefined, clienteId: 'cus_1/../../myAccount' }), /clienteId inválido/);
  await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, cpfCnpj: undefined, clienteId: 'cus_999999999' }), /não existe/);
  await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, cpfCnpj: undefined }), /clienteId .* OU por cpfCnpj/);
  await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, clienteId: 'cus_000005401844' }), /clienteId .* OU por cpfCnpj/);
  assert.equal(f.posts.length, 0);
});

test('boleto com cliente novo: cadastra junto (cliente primeiro, boleto depois), sem aviso por padrão', async () => {
  const { f, ctx, registrar, eventos } = montar();
  const p = await prepararCobranca(ctx, 'u1', { ...COBRANCA, novoCliente: { nome: 'Maria da Silva', email: 'maria@exemplo.com' } });
  assert.match(p.cliente.situacao, /SERÁ CADASTRADO/);
  assert.equal(f.posts.length, 0);
  const r = (await confirmarCobranca(ctx, 'u1', { confirmacao: String(p.confirmacao) }, registrar)) as any;
  assert.deepEqual(f.posts.map((x) => x[0]), ['/customers', '/payments']);
  assert.equal(f.posts[0]![1].notificationDisabled, true);
  assert.equal(f.posts[1]![1].customer, r.cliente.id);
  assert.equal(r.cliente.cadastradoAgora, true);
  assert.deepEqual(eventos.map((e) => e.evento), [EVENTO_CLIENTE, EVENTO_COBRANCA]);
});

test('boleto: CPF que não existe e sem novoCliente é recusado; mais de um cadastro com o mesmo CPF não é adivinhado', async () => {
  const { f, ctx } = montar();
  await assert.rejects(() => prepararCobranca(ctx, 'u1', COBRANCA), /não há cliente.*novoCliente/);
  const dup = montar({ clientes: [EXISTENTE, { ...EXISTENTE, id: 'cus_000009999999' }] });
  await assert.rejects(() => prepararCobranca(dup.ctx, 'u1', COBRANCA), /2 cadastros.*clienteId/);
  assert.equal(f.posts.length + dup.f.posts.length, 0);
});

test('boleto: cliente novo que falha ao cadastrar não gera boleto; boleto que falha depois diz que o cliente FOI cadastrado', async () => {
  const a = montar({ falhaNoCliente: new ErroHttp('Asaas 400 em /customers: dados inválidos', 400) });
  const pa = await prepararCobranca(a.ctx, 'u1', { ...COBRANCA, novoCliente: { nome: 'Maria da Silva' } });
  await assert.rejects(() => confirmarCobranca(a.ctx, 'u1', { confirmacao: String(pa.confirmacao) }, a.registrar), /não cadastrei o cliente e portanto não gerei/);
  assert.deepEqual(a.f.posts.map((x) => x[0]), ['/customers']);

  const b = montar({ falhaNoPagamento: new ErroHttp('Asaas 400 em /payments: valor mínimo', 400) });
  const pb = await prepararCobranca(b.ctx, 'u1', { ...COBRANCA, novoCliente: { nome: 'Maria da Silva' } });
  await assert.rejects(() => confirmarCobranca(b.ctx, 'u1', { confirmacao: String(pb.confirmacao) }, b.registrar), /cliente FOI cadastrado \(cus_.*boleto não saiu/);
});

test('boleto: teto por cobrança (5000 passa, 5000,01 não; teto do ambiente manda) — recusa e manda para o painel', async () => {
  const { f, ctx } = montar({ clientes: [EXISTENTE] });
  await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, valor: 5000.01 }), /teto de R\$ 5\.000,00.*painel do Asaas/);
  await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, valor: 12000 }), /teto/);
  assert.ok((await prepararCobranca(ctx, 'u1', { ...COBRANCA, valor: 5000 })).confirmacao);
  const baixo = montar({ clientes: [EXISTENTE] }, { tetoReais: () => 300 });
  await assert.rejects(() => prepararCobranca(baixo.ctx, 'u1', { ...COBRANCA, valor: 300.5 }), /teto de R\$ 300,00/);
  // o teto vale de novo no confirmar (foi baixado depois da prévia)
  const m = montar({ clientes: [EXISTENTE] });
  let teto = 5000;
  const esc2 = criarEscritaAsaas({ agora: () => AGORA, tetoReais: () => teto });
  const ctx2 = { asaas: m.asaas, esc: esc2 };
  const p = await prepararCobranca(ctx2, 'u1', { ...COBRANCA, valor: 1000 });
  teto = 500;
  await assert.rejects(() => confirmarCobranca(ctx2, 'u1', { confirmacao: String(p.confirmacao) }, m.registrar), /teto/);
  assert.equal(f.posts.length + m.f.posts.length, 0);
});

test('boleto: valor zero, negativo, texto, com 3 casas ou infinito é recusado', async () => {
  const { ctx } = montar({ clientes: [EXISTENTE] });
  for (const v of [0, -10, 10.005, Number.POSITIVE_INFINITY, Number.NaN, '250' as unknown as number]) {
    await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, valor: v }), /valor/, String(v));
  }
});

test('boleto: vencimento no passado, depois de 60 dias, data que não existe — hoje e +60 passam', async () => {
  const { ctx } = montar({ clientes: [EXISTENTE] });
  await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, vencimento: '2026-10-27' }), /já passou/);
  await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, vencimento: '2026-12-28' }), /passa de 60 dias/);
  await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, vencimento: '2026-02-30' }), /não é uma data que existe/);
  await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, vencimento: '10/11/2026' }), /AAAA-MM-DD/);
  assert.ok((await prepararCobranca(ctx, 'u1', { ...COBRANCA, vencimento: '2026-10-28', externalReference: 'hoje' })).confirmacao);
  assert.ok((await prepararCobranca(ctx, 'u1', { ...COBRANCA, vencimento: '2026-12-27', externalReference: 'mais60' })).confirmacao);
});

test('boleto: o dia virou entre a prévia e o ok → vencimento que já passou não sai', async () => {
  const { f, ctx, relogio, registrar } = montar({ clientes: [EXISTENTE] });
  relogio.t = Date.parse('2026-10-28T23:55:00-03:00');
  const p = await prepararCobranca(ctx, 'u1', { ...COBRANCA, vencimento: '2026-10-28' });
  relogio.t = Date.parse('2026-10-29T00:03:00-03:00');
  await assert.rejects(() => confirmarCobranca(ctx, 'u1', { confirmacao: String(p.confirmacao) }, registrar), /já passou/);
  assert.equal(f.posts.length, 0);
});

test('boleto: descrição é obrigatória e vai até 500', async () => {
  const { ctx } = montar({ clientes: [EXISTENTE] });
  await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, descricao: '   ' }), /descrição obrigatória/);
  await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, descricao: 'x'.repeat(501) }), /500/);
  assert.ok((await prepararCobranca(ctx, 'u1', { ...COBRANCA, descricao: 'x'.repeat(500) })).confirmacao);
});

test('boleto: Pix, cartão, UNDEFINED, parcelamento e assinatura são recusados; BOLETO explícito passa', async () => {
  const { f, ctx } = montar({ clientes: [EXISTENTE] });
  for (const forma of ['PIX', 'CREDIT_CARD', 'UNDEFINED', 'DEBIT_CARD', 'pix', '']) {
    await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, billingType: forma }), /SOMENTE boleto/, `billingType ${forma}`);
    await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, formaDePagamento: forma }), /SOMENTE boleto/, `forma ${forma}`);
  }
  await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, parcelas: 3 }), /parcelamento/);
  await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, installmentCount: 2 }), /parcelamento/);
  await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, assinatura: true }), /assinatura/);
  await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, recorrencia: 'mensal' }), /assinatura/);
  assert.ok((await prepararCobranca(ctx, 'u1', { ...COBRANCA, billingType: 'boleto', parcelas: 1, assinatura: false })).confirmacao);
  assert.equal(f.posts.length, 0);
});

test('aviso ao cliente é decisão: cadastro existente com aviso LIGADO recusa se avisarCliente=false; aceita se true; desligado segue', async () => {
  const ligado = montar({ clientes: [{ ...EXISTENTE, notificationDisabled: false }] });
  await assert.rejects(() => prepararCobranca(ligado.ctx, 'u1', COBRANCA), /aviso automático do Asaas LIGADO/);
  const p = await prepararCobranca(ligado.ctx, 'u1', { ...COBRANCA, avisarCliente: true });
  assert.equal(p.aviso.vaiAvisar, true);
  assert.match(p.aviso.texto, /VAI mandar/);
  const r = (await confirmarCobranca(ligado.ctx, 'u1', { confirmacao: String(p.confirmacao) }, ligado.registrar)) as any;
  assert.equal(r.avisouOCliente, true);

  const semCampo = montar({ clientes: [{ ...EXISTENTE, notificationDisabled: undefined }] });
  await assert.rejects(() => prepararCobranca(semCampo.ctx, 'u1', COBRANCA), /LIGADO/, 'sem o campo, o Asaas avisa: tratar como ligado');

  const desligado = montar({ clientes: [EXISTENTE] });
  const p2 = await prepararCobranca(desligado.ctx, 'u1', { ...COBRANCA, avisarCliente: true });
  assert.equal(p2.aviso.vaiAvisar, false);
  assert.match(p2.aviso.texto, /NÃO vai avisar/);
});

test('aviso: cliente novo sai com notificationDisabled=true no padrão e false com avisarCliente=true', async () => {
  const a = montar();
  const pa = await prepararCobranca(a.ctx, 'u1', { ...COBRANCA, novoCliente: { nome: 'Maria' }, avisarCliente: true });
  assert.equal(pa.aviso.vaiAvisar, true);
  await confirmarCobranca(a.ctx, 'u1', { confirmacao: String(pa.confirmacao) }, a.registrar);
  assert.equal(a.f.posts[0]![1].notificationDisabled, false);
});

test('boleto: confirmar duas vezes o MESMO código cria uma cobrança só (em fila ou junto)', async () => {
  const { f, ctx, registrar } = montar({ clientes: [EXISTENTE] });
  const p = await prepararCobranca(ctx, 'u1', COBRANCA);
  const rs = await Promise.allSettled([confirmarCobranca(ctx, 'u1', { confirmacao: String(p.confirmacao) }, registrar), confirmarCobranca(ctx, 'u1', { confirmacao: String(p.confirmacao) }, registrar)]);
  assert.deepEqual(rs.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.equal(f.posts.filter((x) => x[0] === '/payments').length, 1);
  await assert.rejects(() => confirmarCobranca(ctx, 'u1', { confirmacao: String(p.confirmacao) }, registrar), /já usado/);
});

test('boleto: código de outro usuário não serve e não é gasto; vencido não grava', async () => {
  const { f, ctx, relogio, registrar } = montar({ clientes: [EXISTENTE] });
  const p = await prepararCobranca(ctx, 'u1', COBRANCA);
  await assert.rejects(() => confirmarCobranca(ctx, 'u2', { confirmacao: String(p.confirmacao) }, registrar), /outro usuário/);
  assert.equal(f.posts.length, 0);
  relogio.t += 15 * 60_000 + 1;
  await assert.rejects(() => confirmarCobranca(ctx, 'u1', { confirmacao: String(p.confirmacao) }, registrar), /venceu/);
  await assert.rejects(() => confirmarCobranca(ctx, 'u1', { confirmacao: 'ABCDEF123456' }, registrar), /desconhecido/);
  assert.equal(f.posts.length, 0);
});

test('duplicata: mesmo cliente + valor + vencimento + descrição em menos de 10 min é recusada com o id da existente; depois de 10 min passa', async () => {
  const { f, ctx, relogio, registrar } = montar({ clientes: [EXISTENTE] });
  const pedido = { ...COBRANCA, externalReference: undefined };
  const p1 = await prepararCobranca(ctx, 'u1', pedido);
  const r1 = (await confirmarCobranca(ctx, 'u1', { confirmacao: String(p1.confirmacao) }, registrar)) as any;
  relogio.t += 5 * 60_000;
  await assert.rejects(() => prepararCobranca(ctx, 'u1', pedido), new RegExp(`cobrança igual.*${r1.cobranca.id}`));
  // valor ou descrição diferentes não são duplicata
  assert.ok((await prepararCobranca(ctx, 'u1', { ...pedido, valor: 251 })).confirmacao);
  assert.ok((await prepararCobranca(ctx, 'u1', { ...pedido, descricao: 'Outra coisa' })).confirmacao);
  // e a trava também vale no confirmar (duas prévias antes do primeiro ok)
  const m = montar({ clientes: [EXISTENTE] });
  const a = await prepararCobranca(m.ctx, 'u1', pedido);
  const b = await prepararCobranca(m.ctx, 'u1', pedido);
  await confirmarCobranca(m.ctx, 'u1', { confirmacao: String(a.confirmacao) }, m.registrar);
  await assert.rejects(() => confirmarCobranca(m.ctx, 'u1', { confirmacao: String(b.confirmacao) }, m.registrar), /cobrança igual/);
  assert.equal(m.f.posts.filter((x) => x[0] === '/payments').length, 1);
  relogio.t += 6 * 60_000;
  assert.ok((await prepararCobranca(ctx, 'u1', pedido)).confirmacao);
  assert.equal(f.posts.filter((x) => x[0] === '/payments').length, 1);
});

test('duplicata: externalReference já usada no Asaas é recusada com o id da cobrança', async () => {
  const { f, ctx } = montar({ clientes: [EXISTENTE], pagamentos: [{ id: 'pay_5550000000001', externalReference: 'pedido-1' }] });
  await assert.rejects(() => prepararCobranca(ctx, 'u1', COBRANCA), /externalReference "pedido-1" já está na cobrança pay_5550000000001/);
  assert.equal(f.posts.length, 0);
  const semRef = await prepararCobranca(ctx, 'u1', { ...COBRANCA, externalReference: undefined });
  assert.match(semRef.avisos.join(' '), /sem externalReference/);
});

test('teto por hora e por conta: acima de N boletos na hora, recusa; passada a hora, libera; vale também no confirmar', async () => {
  const { f, ctx, relogio, registrar } = montar({ clientes: [EXISTENTE] }, { porHora: () => 2 });
  for (let i = 1; i <= 2; i++) {
    const p = await prepararCobranca(ctx, 'u1', { ...COBRANCA, externalReference: `ref-${i}`, valor: 100 + i });
    await confirmarCobranca(ctx, 'u1', { confirmacao: String(p.confirmacao) }, registrar);
  }
  await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, externalReference: 'ref-3', valor: 103 }), /limite de 2 cobranças por hora/);
  relogio.t += 61 * 60_000;
  const p = await prepararCobranca(ctx, 'u1', { ...COBRANCA, externalReference: 'ref-3', valor: 103, vencimento: '2026-11-20' });
  assert.ok(p.confirmacao);
  assert.equal(f.posts.length, 2);

  const m = montar({ clientes: [EXISTENTE] }, { porHora: () => 1 });
  const a = await prepararCobranca(m.ctx, 'u1', { ...COBRANCA, externalReference: 'a', valor: 10 });
  const b = await prepararCobranca(m.ctx, 'u1', { ...COBRANCA, externalReference: 'b', valor: 20 });
  await confirmarCobranca(m.ctx, 'u1', { confirmacao: String(a.confirmacao) }, m.registrar);
  await assert.rejects(() => confirmarCobranca(m.ctx, 'u1', { confirmacao: String(b.confirmacao) }, m.registrar), /limite de 1 cobranças por hora/);
});

test('histórico da auditoria: depois de um reinício o teto e a duplicata valem; histórico que não carrega = nada é gravado', async () => {
  const pedido = { ...COBRANCA, externalReference: undefined };
  const chave = chaveDeDuplicata('doutor-hernia-serra', 'cus_000005401844', 250, VENC, 'Consulta de avaliação');
  const recente: RegistroDeCobranca[] = [{ conta: 'doutor-hernia-serra', chave, em: AGORA - 3 * 60_000, cobrancaId: 'pay_antes0001' }];
  const a = montar({ clientes: [EXISTENTE] }, { historico: async () => recente });
  await assert.rejects(() => prepararCobranca(a.ctx, 'u1', pedido), /cobrança igual.*pay_antes0001/);

  const cheio: RegistroDeCobranca[] = Array.from({ length: 20 }, (_, i) => ({ conta: 'doutor-hernia-serra', chave: `k${i}`, em: AGORA - 20 * 60_000 }));
  const b = montar({ clientes: [EXISTENTE] }, { historico: async () => cheio });
  await assert.rejects(() => prepararCobranca(b.ctx, 'u1', pedido), /limite de 20 cobranças por hora/);

  const c = montar({ clientes: [EXISTENTE] }, { historico: async () => { throw new Error('banco fora'); } });
  await assert.rejects(() => prepararCobranca(c.ctx, 'u1', pedido), /não consegui conferir as cobranças recentes/);
  assert.equal(a.f.posts.length + b.f.posts.length + c.f.posts.length, 0);
});

test('403: chave só de leitura → erro em português claro, sem vazar chave, CPF ou e-mail; a recusa definitiva libera a reserva', async () => {
  const { ctx, registrar, eventos } = montar({
    clientes: [EXISTENTE],
    falhaNoPagamento: new ErroHttp(`o Asaas negou a gravação (403): a chave desta conta é só de leitura. cpf 52998224725 email maria.silva@exemplo.com chave ${CHAVE_COMPLETA}`, 403),
  });
  const p = await prepararCobranca(ctx, 'u1', COBRANCA);
  const erro = await confirmarCobranca(ctx, 'u1', { confirmacao: String(p.confirmacao) }, registrar).then(() => null, (e: Error) => e);
  assert.ok(erro);
  assert.match(erro.message, /só de leitura/);
  const tudoQueSaiu = erro.message + tudo(eventos);
  assert.ok(!tudoQueSaiu.includes(CHAVE_COMPLETA) && !tudoQueSaiu.includes('aact_prod'), 'chave vazou');
  assert.ok(!tudoQueSaiu.includes(CPF_DIGITOS) && !tudoQueSaiu.includes('maria.silva@exemplo.com'), 'documento/e-mail vazaram');
  assert.equal(eventos.at(-1)!.ok, false);
  // 4xx: o Asaas não criou nada, então o mesmo boleto pode ser tentado de novo
  assert.ok((await prepararCobranca(ctx, 'u1', COBRANCA)).confirmacao);
});

test('sem resposta do Asaas (pode ter criado): a reserva fica e repetir o mesmo boleto é barrado', async () => {
  const { ctx, registrar, eventos } = montar({ clientes: [EXISTENTE], falhaNoPagamento: new ErroHttp('sem resposta do Asaas em /payments: a gravação pode ter acontecido', null) });
  const p = await prepararCobranca(ctx, 'u1', { ...COBRANCA, externalReference: undefined });
  await assert.rejects(() => confirmarCobranca(ctx, 'u1', { confirmacao: String(p.confirmacao) }, registrar), /pode ter acontecido/);
  assert.equal(eventos.at(-1)!.args.incerto, true);
  await assert.rejects(() => prepararCobranca(ctx, 'u1', { ...COBRANCA, externalReference: undefined }), /cobrança igual/);
});

// ------------------------------------------------------------------ pelo protocolo (o que o claude.ai vê)

async function conectar(m: ReturnType<typeof montar>, usuario: string, registros: Array<{ ferramenta: string; argumentos: any; ok: boolean; erro?: string }>) {
  const server = new McpServer({ name: 't', version: '0' });
  registrarEscritaAsaas(server, m.asaas, m.esc, usuario, (r) => registros.push(r as never));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const cliente = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(a), cliente.connect(b)]);
  return cliente;
}
const texto = (r: any) => String(r.content?.[0]?.text ?? '');

test('protocolo: só as 4 ferramentas de escrita (nada de cancelar/estornar/transferir); registro com argumentos mascarados; erro sem vazamento', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  const registros: Array<{ ferramenta: string; argumentos: any; ok: boolean; erro?: string }> = [];
  const joao = await conectar(m, 'u-joao', registros);
  const nomes = (await joao.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(nomes, ['asaas_confirmar_cliente', 'asaas_confirmar_cobranca', 'asaas_preparar_cliente', 'asaas_preparar_cobranca']);
  assert.ok(!nomes.some((n) => /cancel|estorn|delete|exclu|transfer|saque|antecip|editar|alterar/.test(n)));

  const prep = await joao.callTool({ name: 'asaas_preparar_cliente', arguments: { unidade: 'serra', nome: 'Joana Souza', cpfCnpj: CNPJ, email: 'joana@exemplo.com', telefone: '63981411248' } });
  const dados = JSON.parse(texto(prep));
  assert.equal(m.f.posts.length, 0);
  const aud = tudo(registros);
  assert.ok(!aud.includes('11222333000181') && !aud.includes('11.222.333/0001-81') && !aud.includes('joana@exemplo.com') && !aud.includes('981411248'), 'registro com dado por inteiro');
  assert.match(aud, /\*\*\.222\.333\/0001-\*\*/);
  assert.ok(!aud.includes('Joana Souza') && aud.includes('Joana S.'), 'nome inteiro no registro');

  const outro = await conectar(m, 'u-outro', []);
  const negado = await outro.callTool({ name: 'asaas_confirmar_cliente', arguments: { confirmacao: dados.confirmacao } });
  assert.equal(negado.isError, true);
  assert.match(texto(negado), /outro usuário/);
  const ok = await joao.callTool({ name: 'asaas_confirmar_cliente', arguments: { confirmacao: dados.confirmacao } });
  assert.notEqual(ok.isError, true);
  assert.equal(m.f.posts.length, 1);
  assert.ok(registros.some((r) => r.ferramenta === EVENTO_CLIENTE && r.ok));
  const reuso = await joao.callTool({ name: 'asaas_confirmar_cliente', arguments: { confirmacao: dados.confirmacao } });
  assert.equal(reuso.isError, true);
  assert.equal(m.f.posts.length, 1);
});

test('protocolo: forma de pagamento Pix é recusada mesmo pelo esquema da ferramenta (nada é ignorado em silêncio)', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  const joao = await conectar(m, 'u1', []);
  const r = await joao.callTool({ name: 'asaas_preparar_cobranca', arguments: { unidade: 'serra', cpfCnpj: CPF, valor: 100, vencimento: VENC, descricao: 'x', billingType: 'PIX' } });
  assert.equal(r.isError, true);
  assert.match(texto(r), /SOMENTE boleto/);
  const todas = await joao.callTool({ name: 'asaas_preparar_cobranca', arguments: { unidade: 'todas', cpfCnpj: CPF, valor: 100, vencimento: VENC, descricao: 'x' } });
  assert.equal(todas.isError, true);
  assert.match(texto(todas), /numa conta só/);
  assert.equal(m.f.posts.length, 0);
});

test('protocolo: erro com chave e documento no texto sai limpo na resposta e no registro', async () => {
  const m = montar({
    clientes: [EXISTENTE],
    falhaNoPagamento: new ErroHttp(`Asaas 400 em /payments: customer 52998224725 / 529.982.247-25 / 11.222.333/0001-81 ${CHAVE_COMPLETA} maria.silva@exemplo.com`, 400),
  });
  const registros: Array<{ ferramenta: string; argumentos: any; ok: boolean; erro?: string }> = [];
  const joao = await conectar(m, 'u1', registros);
  const prep = JSON.parse(texto(await joao.callTool({ name: 'asaas_preparar_cobranca', arguments: { unidade: 'serra', cpfCnpj: CPF, valor: 100, vencimento: VENC, descricao: `Boleto do CPF ${CPF}`, externalReference: 'r1' } })));
  const r = await joao.callTool({ name: 'asaas_confirmar_cobranca', arguments: { confirmacao: prep.confirmacao } });
  assert.equal(r.isError, true);
  const saiu = texto(r) + tudo(registros);
  for (const proibido of [CHAVE_COMPLETA, 'aact_prod', CPF_DIGITOS, '529.982.247-25', '11222333000181', '11.222.333/0001-81', 'maria.silva@exemplo.com']) {
    assert.ok(!saiu.includes(proibido), `vazou: ${proibido}`);
  }
  assert.match(saiu, /\[documento\]/);
});

test('fila: dois códigos DIFERENTES do mesmo boleto com cliente novo, confirmados juntos → um cliente e uma cobrança só', async () => {
  const { f, ctx, registrar } = montar();
  const pedido = { ...COBRANCA, externalReference: undefined, novoCliente: { nome: 'Maria da Silva' } };
  const a = await prepararCobranca(ctx, 'u1', pedido);
  const b = await prepararCobranca(ctx, 'u1', pedido);
  const rs = await Promise.allSettled([confirmarCobranca(ctx, 'u1', { confirmacao: String(a.confirmacao) }, registrar), confirmarCobranca(ctx, 'u1', { confirmacao: String(b.confirmacao) }, registrar)]);
  assert.deepEqual(rs.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.equal(f.posts.filter((x) => x[0] === '/customers').length, 1);
  assert.equal(f.posts.filter((x) => x[0] === '/payments').length, 1);
});

test('cliente: se o Asaas devolver gente que não bate com o CPF buscado, não adivinha nem cria por cima', async () => {
  const torto: Cli = { id: 'cus_000007777777', name: 'Outra Pessoa', cpfCnpj: '11222333000181' };
  const a = montar({ clientesTortos: [torto] });
  await assert.rejects(() => prepararCliente(a.ctx, 'u1', { unidade: 'serra', nome: 'Maria', cpfCnpj: CPF }), /não batem com o CPF\/CNPJ buscado/);
  await assert.rejects(() => prepararCobranca(a.ctx, 'u1', { ...COBRANCA, novoCliente: { nome: 'Maria' } }), /não batem/);
  assert.equal(a.f.posts.length, 0);
});

test('boleto: um id de cobrança do Asaas (pay_…) nunca é confundido com documento nos erros', async () => {
  const m = montar({ clientes: [EXISTENTE], falhaNoPagamento: new ErroHttp('Asaas 400: duplicada de pay_12345678901 do cliente cus_000005401844', 400) });
  const p = await prepararCobranca(m.ctx, 'u1', COBRANCA);
  await assert.rejects(() => confirmarCobranca(m.ctx, 'u1', { confirmacao: String(p.confirmacao) }, m.registrar), /pay_12345678901.*cus_000005401844/);
});

test('cliente novo junto do boleto: a chave de duplicata gravada usa o id criado, então a trava sobrevive a um reinício', async () => {
  const a = montar();
  const pedido = { ...COBRANCA, externalReference: undefined, novoCliente: { nome: 'Maria da Silva' } };
  const p = await prepararCobranca(a.ctx, 'u1', pedido);
  await confirmarCobranca(a.ctx, 'u1', { confirmacao: String(p.confirmacao) }, a.registrar);
  const ev = a.eventos.find((e) => e.evento === EVENTO_COBRANCA)!;
  assert.equal(ev.args.chave, chaveDeDuplicata('doutor-hernia-serra', ev.args.clienteId, 250, VENC, 'Consulta de avaliação'));
  // "reinício": a auditoria volta como histórico e o cliente (agora existente) é achado pelo CPF
  const b = montar({ clientes: [{ ...a.f.clientes[0]!, cpfCnpj: CPF_DIGITOS }] }, { historico: async () => [{ conta: 'doutor-hernia-serra', chave: ev.args.chave, em: AGORA - 60_000, cobrancaId: ev.args.cobrancaId }] });
  await assert.rejects(() => prepararCobranca(b.ctx, 'u1', { ...COBRANCA, externalReference: undefined }), /cobrança igual/);
});

test('cadastro do cliente sem resposta: NÃO diz que nada foi criado, manda conferir e marca incerto', async () => {
  const falha = new ErroHttp('sem resposta do Asaas em /customers: a gravação pode ter acontecido', null);
  const a = montar({ falhaNoCliente: falha });
  const p = await prepararCliente(a.ctx, 'u1', { unidade: 'serra', nome: 'Maria da Silva', cpfCnpj: CPF });
  await assert.rejects(() => confirmarCliente(a.ctx, 'u1', { confirmacao: String(p.confirmacao) }, a.registrar), /PODE ter sido feito.*asaas_cliente/);
  assert.equal(a.eventos.at(-1)!.args.incerto, true);
  const b = montar({ falhaNoCliente: falha });
  const pb = await prepararCobranca(b.ctx, 'u1', { ...COBRANCA, novoCliente: { nome: 'Maria da Silva' } });
  const erro = await confirmarCobranca(b.ctx, 'u1', { confirmacao: String(pb.confirmacao) }, b.registrar).then(() => null, (e: Error) => e);
  assert.match(erro!.message, /PODE ter sido feito/);
  assert.doesNotMatch(erro!.message, /não cadastrei/);
  assert.deepEqual(b.f.posts.map((x) => x[0]), ['/customers']);
});

test('Asaas responde 2xx sem o id da cobrança: erro claro, registro "incerto" e a reserva fica (nada de TypeError)', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  (m.f.conta.escrita as { post: unknown }).post = async (caminho: string) => {
    m.f.posts.push([caminho, {}]);
    return null;
  };
  const p = await prepararCobranca(m.ctx, 'u1', { ...COBRANCA, externalReference: undefined });
  await assert.rejects(() => confirmarCobranca(m.ctx, 'u1', { confirmacao: String(p.confirmacao) }, m.registrar), /sem o id da cobrança.*PODE ter sido gerado/);
  assert.equal(m.eventos.at(-1)!.args.incerto, true);
  await assert.rejects(() => prepararCobranca(m.ctx, 'u1', { ...COBRANCA, externalReference: undefined }), /cobrança igual/);
});

test('externalReference: uma cobrança apagada no começo da lista não esconde a viva', async () => {
  const m = montar({ clientes: [EXISTENTE], pagamentos: [{ id: 'pay_apagada001', externalReference: 'pedido-1' }, { id: 'pay_viva0000001', externalReference: 'pedido-1' }] });
  const original = m.f.conta.fonte.get.bind(m.f.conta.fonte);
  (m.f.conta.fonte as { get: unknown }).get = async (caminho: string, query: Record<string, any>) => {
    const r: any = await original(caminho, query);
    return caminho === '/payments' ? { data: [{ id: 'pay_apagada001', deleted: true }, ...r.data.slice(1)].slice(0, Number(query.limit ?? 100)) } : r;
  };
  await assert.rejects(() => prepararCobranca(m.ctx, 'u1', COBRANCA), /pay_viva0000001/);
});

test('registro de preparação: nome abreviado e descrição só em tamanho (pode trazer motivo de tratamento)', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  const registros: Array<{ ferramenta: string; argumentos: any; ok: boolean; erro?: string }> = [];
  const joao = await conectar(m, 'u1', registros);
  await joao.callTool({ name: 'asaas_preparar_cobranca', arguments: { unidade: 'serra', cpfCnpj: CPF, valor: 100, vencimento: VENC, descricao: 'Tratamento de hérnia de disco L5', externalReference: 'r9', novoCliente: { nome: 'Maria da Silva Souza' } } });
  const aud = tudo(registros);
  assert.ok(!aud.includes('hérnia de disco') && !aud.includes('Maria da Silva Souza'), aud);
  assert.match(aud, /"descricaoCaracteres":32/);
  assert.match(aud, /Maria S\./);
});
