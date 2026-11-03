/**
 * As sondas do sênior no PR #194 (reprovado), portadas como testes que têm de PASSAR: o ataque tem de FALHAR.
 *   1. estornos parciais somando mais que o valor da cobrança (coberto em asaas-operacoes.test.ts; aqui o caso exato do sênior, 800 = 500 + 400)
 *   2. duas instâncias do servidor (deploy start-first, zumbi do Swarm) com o mesmo banco: o teto do dia e a duplicata valem entre elas
 *   3. rotas de escrita que não podem existir
 *   4. campo de cartão com outro nome; agência com dígito
 * Mais: contas que usam a MESMA chave do Asaas dividem o teto do dia.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { rotaPermitida } from '../lib/integracoes/asaas-escrita.js';
import { criarContextoAsaas } from './asaas.js';
import { asaasFalso, AGORA, BancoFalso, montar, porteiroEmMemoria, type Pg } from './asaas-falso.js';
import { criarEscritaAsaas } from './asaas-escrita.js';
import { registrarEscritaAsaas } from './asaas-ferramentas.js';
import { lerDestinos } from './asaas-limites.js';
import { estornarCobranca, transferir } from './asaas-operacoes.js';

const Q = { id: 'u1', email: 'j@x.com' };
const PAGA: Pg = { id: 'pay_paga00000001', customer: 'cus_000005401844', status: 'RECEIVED', value: 800, billingType: 'PIX' };
const DESTINOS = (slugs: string[]) => (slug: string) =>
  lerDestinos(slug, { ASAAS_TRANSFERENCIA_DESTINOS: JSON.stringify(Object.fromEntries(slugs.map((s) => [s, [{ nome: 'F', apelido: 'f', chave_pix: '11222333000181', tipo_chave: 'CNPJ' }]]))) });

test('SONDA 1: estornos parciais de 500 e 400 numa cobrança de R$ 800 — o segundo NÃO passa', async () => {
  const m = montar({ pagamentos: [{ ...PAGA }] });
  await estornarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id, valor: 500 }, m.registrar);
  await assert.rejects(() => estornarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id, valor: 400 }, m.registrar), /resta/);
  const enviados = m.f.pagamentos[0]!.refunds!.map((r) => r.value);
  assert.deepEqual(enviados, [500]);
  assert.ok(enviados.reduce((a, b) => a + b, 0) <= 800);
});

/** Duas instâncias do servidor sobre o MESMO banco (e a mesma trava de banco), cada uma com a sua memória, fila e relógio. */
function duasInstancias(opcoes: { tetoDia?: number } = {}) {
  const banco = new BancoFalso();
  const t = { v: AGORA };
  const mk = () => montar({ saldo: 1e9 }, { banco, agora: () => t.v, destinos: DESTINOS(['doutor-hernia-serra']), tetoDia: () => opcoes.tetoDia ?? 20000 });
  return { banco, t, A: mk(), B: mk() };
}

test('SONDA 2: duas instâncias, 8 transferências de R$ 5.000 alternadas — o teto do dia (R$ 20.000) vale para as duas juntas', async () => {
  const { t, A, B } = duasInstancias();
  let total = 0;
  const recusas: string[] = [];
  for (let i = 0; i < 8; i++) {
    const m = i % 2 ? B : A;
    t.v += 60_000;
    try {
      await transferir(m.ctx, Q, { unidade: 'serra', destino: 'f', valor: 5000 - i, descricao: `p${i}` }, m.registrar);
      total += 5000 - i;
    } catch (e) {
      recusas.push((e as Error).message);
    }
  }
  assert.ok(total <= 20000, `passaram R$ ${total}`);
  assert.ok(recusas.length >= 4);
  assert.ok(recusas.every((r) => /teto do dia|transferência igual/.test(r)), recusas.join(' | '));
  // a instância NOVA, depois do deploy, enxerga tudo
  const C = montar({ saldo: 1e9 }, { banco: A.banco, agora: () => t.v, destinos: DESTINOS(['doutor-hernia-serra']) });
  assert.equal(await C.usado(), total);
});

test('SONDA 2b: as duas instâncias disparando AO MESMO TEMPO (a trava de banco é o que segura) — nunca passa do teto', async () => {
  const { A, B } = duasInstancias();
  const pedidos = Array.from({ length: 12 }, (_, i) => {
    const m = i % 2 ? B : A;
    return transferir(m.ctx, Q, { unidade: 'serra', destino: 'f', valor: 4000 + i }, m.registrar);
  });
  const r = await Promise.allSettled(pedidos);
  const feitas = r.filter((x) => x.status === 'fulfilled').length;
  const somaEnviada = [...A.f.posts(), ...B.f.posts()].reduce((s, p) => s + (p.corpo!.value as number), 0);
  assert.ok(somaEnviada <= 20000, `o Asaas recebeu R$ ${somaEnviada}`);
  assert.equal(feitas, A.f.posts().length + B.f.posts().length);
  assert.ok(feitas <= 4);
});

test('a duplicata de 10 minutos também vale ENTRE instâncias (mesma trava)', async () => {
  const { t, A, B } = duasInstancias();
  await transferir(A.ctx, Q, { unidade: 'serra', destino: 'f', valor: 300 }, A.registrar);
  t.v += 60_000;
  await assert.rejects(() => transferir(B.ctx, Q, { unidade: 'serra', destino: 'f', valor: 300, descricao: 'outro texto' }, B.registrar), /transferência igual para f/);
  assert.equal(B.f.posts().length, 0);
  // e simultâneas: só uma sai
  const { A: C, B: D } = duasInstancias();
  const r = await Promise.allSettled([transferir(C.ctx, Q, { unidade: 'serra', destino: 'f', valor: 77 }, C.registrar), transferir(D.ctx, Q, { unidade: 'serra', destino: 'f', valor: 77 }, D.registrar)]);
  assert.deepEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
});

test('contas que usam a MESMA chave do Asaas somam no teto do dia; chave diferente é outro teto', async () => {
  const banco = new BancoFalso();
  const t = { v: AGORA };
  const mk = (slug: string, chaveGrupo: string) => asaasFalso({ slug, chaveGrupo, saldo: 1e9 });
  const [serra, maraba, outra] = [mk('doutor-hernia-serra', 'chave-X'), mk('doutor-hernia-maraba', 'chave-X'), mk('doutor-hernia-canaa', 'chave-Y')];
  const asaas = criarContextoAsaas(new Map([serra, maraba, outra].map((f) => [f.conta.slug, f.conta])));
  const esc = criarEscritaAsaas({
    agora: () => t.v,
    unidades: () => new Set([serra, maraba, outra].map((f) => f.conta.slug)),
    destinos: DESTINOS(['doutor-hernia-serra', 'doutor-hernia-maraba', 'doutor-hernia-canaa']),
    tetoEspecifico: () => ({ operacao: Infinity, dia: Infinity }),
    tetoDia: () => 10000,
    tetoOperacao: () => 5000,
    porteiro: porteiroEmMemoria(banco, () => t.v),
    alertar: async () => true,
  });
  const registrar = (ev: string, a: Record<string, unknown>, ok: boolean, erro?: string) => banco.gravar({ ferramenta: ev, argumentos: a, ok, erro }, t.v);
  const ctx = { asaas, esc };
  await transferir(ctx, Q, { unidade: 'doutor-hernia-serra', destino: 'f', valor: 4000 }, registrar);
  t.v += 60_000;
  await transferir(ctx, Q, { unidade: 'doutor-hernia-maraba', destino: 'f', valor: 5000 }, registrar);
  t.v += 60_000;
  // a Serra e a Marabá usam a mesma chave: 4000 + 5000 já foram; mais 1001 passa de 10000 em QUALQUER das duas
  for (const u of ['doutor-hernia-serra', 'doutor-hernia-maraba']) {
    await assert.rejects(() => transferir(ctx, Q, { unidade: u, destino: 'f', valor: 1001 }, registrar), /teto do dia.*já foram R\$ 9\.000,00/s);
  }
  assert.equal(((await transferir(ctx, Q, { unidade: 'doutor-hernia-maraba', destino: 'f', valor: 1000 }, registrar)) as any).transferido, true);
  // outra chave: teto próprio, intocado
  assert.equal(((await transferir(ctx, Q, { unidade: 'doutor-hernia-canaa', destino: 'f', valor: 5000 }, registrar)) as any).transferido, true);
  // o registro leva a impressão da chave, nunca a chave
  const gravadas = banco.linhas.map((l) => l.argumentos.chaveAsaas).filter(Boolean);
  assert.ok(gravadas.includes('chave-X') && gravadas.includes('chave-Y'));
});

test('SONDA 3: rotas que não podem existir continuam fora (e o id exige o prefixo certo)', () => {
  const nao: Array<[string, string]> = [
    ['POST', '/payments/anticipations'], ['PUT', '/payments/pay_x/../../x'], ['POST', '/transfers?x=1'], ['DELETE', '/customers/cus_abc123'], ['POST', '/bill'],
    ['PUT', '/customers/myAccount'], ['DELETE', '/payments/webhook'], ['POST', '/payments/receiveInCash'], ['POST', '/payments/pay_abcdef123/receiveInCash'],
    ['POST', '/payments/pay_abc/refund'], ['PUT', '/payments/cus_000005401844'], ['PUT', '/customers/pay_000005401844'], ['DELETE', '/payments/tra_000005401844'],
    ['POST', '/payments/abcdef123456/refund'], ['POST', '/accounts'], ['POST', '/myAccount/webhook'],
  ];
  for (const [m, c] of nao) assert.equal(rotaPermitida(m, c), false, `${m} ${c}`);
  const sim: Array<[string, string]> = [['POST', '/payments/pay_abcdef123/refund'], ['DELETE', '/payments/pay_080225913252'], ['PUT', '/customers/cus_000005401844'], ['POST', '/transfers']];
  for (const [m, c] of sim) assert.equal(rotaPermitida(m, c), true, `${m} ${c}`);
});

type Registro = { ferramenta: string; argumentos: any; ok: boolean; erro?: string };

test('SONDA 4a: campo de cartão com QUALQUER nome (cardNumber, expiryMonth, ccv, number, securityCode…) RECUSA o pedido; nada grava; o número não vai à auditoria', async () => {
  const m = montar({ clientes: [{ id: 'cus_000005401844', name: 'Maria', cpfCnpj: '52998224725', notificationDisabled: true }] });
  const server = new McpServer({ name: 't', version: '1' });
  const reg: Registro[] = [];
  registrarEscritaAsaas(server, m.asaas, m.esc, { id: 'u1' }, (r) => void reg.push(r as Registro));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const cli = new Client({ name: 'c', version: '1' });
  await cli.connect(b);
  const base = { unidade: 'serra', clienteId: 'cus_000005401844', forma: 'CARTAO', valor: 10, vencimento: '2026-11-10', descricao: 'x', externalReference: 'r1' };
  const casos: Array<Record<string, unknown>> = [
    { cardNumber: '4111111111111111', expiryMonth: '12' },
    { ccv: '123' },
    { number: '4111 1111 1111 1111' },
    { securityCode: '123', holderName: 'Maria' },
    { creditCardToken: 'tok_abc' },
    { campoQualquer: 'x' },
  ];
  for (const extra of casos) {
    const r: any = await cli.callTool({ name: 'asaas_criar_cobranca', arguments: { ...base, ...extra } });
    assert.equal(r.isError, true, JSON.stringify(extra));
    assert.match(String(r.content?.[0]?.text), /NUNCA entram pelo chat|não existem nesta ferramenta/, JSON.stringify(extra));
  }
  assert.equal(m.f.posts().length, 0);
  assert.ok(!JSON.stringify(reg).includes('4111'), 'número de cartão na auditoria');
  assert.ok(!JSON.stringify(reg).includes('"123"'), 'CVV na auditoria');
  // o pedido limpo continua passando (o esquema aberto não derrubou nada)
  const ok: any = await cli.callTool({ name: 'asaas_criar_cobranca', arguments: base });
  assert.notEqual(ok.isError, true, String(ok.content?.[0]?.text));
  assert.equal(m.f.posts().length, 1);
  assert.equal(m.f.posts()[0]!.corpo!.billingType, 'CREDIT_CARD');
});
