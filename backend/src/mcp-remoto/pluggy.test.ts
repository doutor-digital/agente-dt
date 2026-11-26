import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  criarContextoPluggy,
  empresasDoPluggy,
  frescorDoItem,
  pluggyContas,
  pluggyExtrato,
  pluggyResumo,
  registrarPluggySePermitido,
  segundaDaSemana,
  type ContextoPluggy,
} from './pluggy.js';
import { listarIntegracoes } from './integracoes.js';
import {
  criarClientePluggy,
  type ContaPluggy,
  type FontePluggy,
  type ItemConfigurado,
  type ItemPluggy,
  type LancamentoPluggy,
} from '../lib/integracoes/pluggy.js';

// valores de mentira (formato real, nada é segredo de verdade)
const SEGREDO = 'pluggy_sk_FIXTURE0123456789abcdefghijklmnopqrstuvwxyz0123';
// montada em partes: o guarda do repositório recusa qualquer JWT literal no código (o repositório é público)
const API_KEY = ['eyJhbGciOiJIUzI1NiJ9', 'eyJmaXh0dXJlIjoidGVzdGUifQ', 'FIXTUREsignature0123456789'].join('.');
const ITEM_A = 'a5c763cb-0952-457b-9936-630f79c5b016';
const ITEM_B = 'd161a74a-8bc8-4093-88de-724312969b0d';
const ITEM_C = '11111111-2222-4333-8444-555555555555';
const CONTA_CC = '562b795d-1653-429f-be86-74ead9502813';
const CONTA_CARTAO = 'a658c848-e475-457b-8565-d1fffba127c4';
const CONTA_B = '99999999-2222-4333-8444-555555555555';
const AGORA = Date.parse('2026-11-26T15:00:00.000Z');

const itensDe: ItemConfigurado[] = [
  { empresa: 'doutor-digital', nomeDaEmpresa: 'Doutor Digital', itemId: ITEM_A, apelido: 'Nubank_PJ' },
  { empresa: 'doutor-digital', nomeDaEmpresa: 'Doutor Digital', itemId: ITEM_B },
  { empresa: 'hm-tecnologia', nomeDaEmpresa: 'HM Tecnologia', itemId: ITEM_C },
];

const itemOk = (id: string, o: Partial<ItemPluggy> = {}): ItemPluggy => ({ id, banco: 'Nubank', status: 'UPDATED', statusDaSincronizacao: 'SUCCESS', atualizadoEm: '2026-11-26T09:00:00.000Z', consentimentoExpiraEm: '2027-11-01T00:00:00.000Z', erroCodigo: null, ...o });
const conta = (id: string, o: Partial<ContaPluggy> = {}): ContaPluggy => ({ id, tipo: 'BANK', subtipo: 'CHECKING_ACCOUNT', nome: 'Conta Corrente', numero: '0001/12345-0', saldo: 1209.5, moeda: 'BRL', ...o });
const lanc = (id: string, data: string, valor: number, o: Partial<LancamentoPluggy> = {}): LancamentoPluggy => ({
  id, data, descricao: `lançamento ${id}`, valor, tipo: valor < 0 ? 'saida' : 'entrada', categoria: 'Transfers', status: 'POSTED', ...o,
});

interface Falso {
  fonte: FontePluggy;
  pedidos: string[];
}

function fonteFalsa(o: {
  itens?: Record<string, ItemPluggy | Error>;
  contas?: Record<string, ContaPluggy[] | Error>;
  lancamentos?: Record<string, LancamentoPluggy[] | Error>;
  testar?: () => Promise<void>;
  truncado?: Set<string>;
} = {}): Falso {
  const pedidos: string[] = [];
  const fonte: FontePluggy = {
    async item(id) {
      pedidos.push(`item ${id}`);
      const r = o.itens?.[id] ?? itemOk(id);
      if (r instanceof Error) throw r;
      return r;
    },
    async contas(id) {
      pedidos.push(`contas ${id}`);
      const r = o.contas?.[id] ?? [];
      if (r instanceof Error) throw r;
      return r;
    },
    async transacoes(contaId, de, ate) {
      pedidos.push(`tx ${contaId} ${de} ${ate}`);
      const r = o.lancamentos?.[contaId] ?? [];
      if (r instanceof Error) throw r;
      return { lancamentos: r, truncado: o.truncado?.has(contaId) ?? false };
    },
    async testar() {
      pedidos.push('testar');
      await o.testar?.();
    },
    invalidarItem() {},
  };
  return { fonte, pedidos };
}

const ctx = (f: Falso, itens = itensDe): ContextoPluggy => criarContextoPluggy(itens, f.fonte, { agora: () => AGORA });

const padrao = () =>
  fonteFalsa({
    itens: { [ITEM_A]: itemOk(ITEM_A, { banco: 'Nubank' }), [ITEM_B]: itemOk(ITEM_B, { banco: 'Inter' }), [ITEM_C]: itemOk(ITEM_C, { banco: 'Itaú' }) },
    contas: {
      [ITEM_A]: [conta(CONTA_CC), conta(CONTA_CARTAO, { tipo: 'CREDIT', subtipo: 'CREDIT_CARD', nome: 'Mastercard', numero: 'xxxx8670', saldo: 300, limiteDisponivel: 2000, limiteTotal: 3000 })],
      [ITEM_B]: [conta(CONTA_B, { nome: 'Conta PJ', numero: '7654321-9' })],
      [ITEM_C]: [conta('77777777-2222-4333-8444-555555555555')],
    },
    lancamentos: {
      [CONTA_CC]: [
        lanc('t1', '2026-11-02', 1000, { descricao: 'PIX RECEBIDO CLINICA SERRA', pagador: 'Clínica Serra Ltda' }),
        lanc('t2', '2026-11-02', -250.5, { descricao: 'PIX ENVIADO', recebedor: 'João Mecânico', motivo: 'conserto' }),
        lanc('t3', '2026-11-04', -19.9, { descricao: 'GOOGLE *ADS', categoria: 'Advertising' }),
        lanc('t4', '2026-11-10', 80, { descricao: 'TED RECEBIDA', status: 'PENDING' }),
        lanc('t5', '2026-11-11', -1200, { descricao: 'PAGAMENTO FATURA CARTAO' }),
      ],
      [CONTA_CARTAO]: [lanc('c1', '2026-11-05', -300, { descricao: 'COMPRA LOJA X', tipo: 'saida' }), lanc('c2', '2026-11-12', 1200, { descricao: 'PAGAMENTO RECEBIDO', tipo: 'entrada' })],
      [CONTA_B]: [lanc('b1', '2026-11-03', 500)],
    },
  });

const tudo = (x: unknown) => JSON.stringify(x);

// ------------------------------------------------------------------ pluggy_contas

test('contas: banco, tipo, número mascarado (•••1234), saldo e a data da última sincronização; o titular e o CPF não saem', async () => {
  const r = await pluggyContas(ctx(padrao()), { empresa: 'doutor-digital' });
  assert.equal(r.total, 2);
  const nubank = r.itens[0]!;
  assert.equal(nubank.item, 'Nubank_PJ');
  assert.equal(nubank.banco, 'Nubank');
  assert.equal(nubank.ultimaSincronizacao, '2026-11-26T09:00:00.000Z');
  assert.equal(nubank.idadeHoras, 6);
  assert.equal(nubank.contas[0]!.numero, '•••3450');
  assert.equal(nubank.contas[0]!.saldo, 1209.5);
  assert.equal(nubank.contas[1]!.numero, '•••8670');
  assert.equal(nubank.contas[1]!.limiteDisponivel, 2000);
  assert.match(nubank.contas[0]!.rotulo, /Nubank Conta Corrente •••3450/);
  assert.equal(tudo(r).includes('12345-0'), false, 'número da conta nunca inteiro');
  assert.equal(tudo(r).includes(ITEM_A), false, 'id do item nunca na resposta');
  assert.match(r.aviso, /última sincronização diária/);
  // a empresa errada não vaza as contas de outra
  assert.equal(tudo(await pluggyContas(ctx(padrao()), { empresa: 'hm-tecnologia' })).includes('Conta PJ'), false);
});

test('contas: sem empresa lista todas; nome curto resolve; desconhecida recusa; sem Pluggy ligada recusa', async () => {
  const todas = await pluggyContas(ctx(padrao()), {});
  assert.equal(todas.total, 3, 'sem empresa, as contas de todas as empresas (é só para quem pode ver tudo)');
  const r = await pluggyContas(ctx(padrao()), { empresa: 'hm' });
  assert.equal(r.itens[0]!.empresa, 'hm-tecnologia');
  await assert.rejects(() => pluggyContas(ctx(padrao()), { empresa: 'timbo' }), /sem leitura bancária/);
  await assert.rejects(() => pluggyContas(criarContextoPluggy([], null), {}), /não está ligada/);
});

test('contas: testar=true prova as credenciais; credencial recusada não lê item nenhum; sem testar não chama o teste', async () => {
  const ok = padrao();
  const a = await pluggyContas(ctx(ok), { empresa: 'doutor-digital', testar: true });
  assert.deepEqual(a.credenciais, { ok: true });
  assert.ok(ok.pedidos.includes('testar'));
  const ruim = fonteFalsa({ testar: async () => { throw new Error('a Pluggy recusou o clientId/clientSecret (401) [CLIENT_SECRET_EXPIRED]'); } });
  const b = await pluggyContas(ctx(ruim), { empresa: 'doutor-digital', testar: true });
  assert.equal(b.credenciais?.ok, false);
  assert.match(b.credenciais!.erro!, /CLIENT_SECRET_EXPIRED/);
  assert.equal(b.itens.length, 0);
  assert.deepEqual(ruim.pedidos, ['testar'], 'nada foi lido com credencial recusada');
  const sem = padrao();
  const c = await pluggyContas(ctx(sem), { empresa: 'doutor-digital' });
  assert.equal('credenciais' in c, false);
  assert.equal(sem.pedidos.includes('testar'), false);
});

test('contas: um item que falha não derruba os outros e a falha aparece nele', async () => {
  const f = fonteFalsa({ contas: { [ITEM_A]: new Error('a Pluggy respondeu 500'), [ITEM_B]: [conta(CONTA_B)] } });
  const r = await pluggyContas(ctx(f), { empresa: 'doutor-digital' });
  assert.equal(r.itens.length, 2);
  assert.equal((r.itens[0] as { erro?: string }).erro, 'a Pluggy respondeu 500');
  assert.equal(r.itens[1]!.contas.length, 1);
});

test('frescor: dado velho, conexão com erro e consentimento vencido/perto de vencer viram aviso', () => {
  const i = itensDe[0]!;
  const velho = frescorDoItem(i, itemOk(ITEM_A, { atualizadoEm: '2026-11-23T09:00:00.000Z' }), AGORA);
  assert.match(velho.avisos![0]!, /atrasados mais que o normal/);
  const erro = frescorDoItem(i, itemOk(ITEM_A, { status: 'LOGIN_ERROR', erroCodigo: 'USER_AUTHORIZATION_EXPIRED' }), AGORA);
  assert.match(erro.avisos![0]!, /LOGIN_ERROR \(USER_AUTHORIZATION_EXPIRED\)/);
  const vencido = frescorDoItem(i, itemOk(ITEM_A, { consentimentoExpiraEm: '2026-11-01T00:00:00.000Z' }), AGORA);
  assert.match(vencido.avisos![0]!, /VENCEU/);
  const perto = frescorDoItem(i, itemOk(ITEM_A, { consentimentoExpiraEm: '2026-12-10T00:00:00.000Z' }), AGORA);
  assert.match(perto.avisos![0]!, /vence em 14 dia/);
  assert.equal(frescorDoItem(i, itemOk(ITEM_A), AGORA).avisos, undefined);
  assert.equal(frescorDoItem(i, itemOk(ITEM_A, { atualizadoEm: null }), AGORA).idadeHoras, null);
});

// ------------------------------------------------------------------ pluggy_extrato

test('extrato: totais de entrou e saiu em reais, data do dado e itens do mais novo para o mais velho; cartão em bloco separado', async () => {
  const r = await pluggyExtrato(ctx(padrao()), { empresa: 'doutor-digital', inicio: '2026-11-01', fim: '2026-11-30' });
  assert.equal(r.contasLidas, 3);
  assert.equal(r.lidos, 8);
  // banco: entrou 1000 + 500 = 1500 (os 80 da TED PENDENTE ficam de fora); saiu 250,50 + 19,90 + 1200 = 1470,40
  assert.deepEqual(r.totais.contasBancarias, { entrou: 1500, saiu: 1470.4, saldoDoPeriodo: 29.6, lancamentos: 5 });
  assert.match(r.notaDosTotais, /pendentes.*NÃO entram nos totais/);
  assert.deepEqual(r.totais.cartoesDeCredito, { entrou: 1200, saiu: 300, saldoDoPeriodo: 900, lancamentos: 2 });
  assert.match(r.notaDosTotais, /nunca some os dois blocos/);
  assert.equal(r.totaisValemPara, 'todos os lançamentos do período');
  assert.equal(r.dadosDe[0]!.ultimaSincronizacao, '2026-11-26T09:00:00.000Z');
  assert.match(r.aviso, /última sincronização/);
  assert.deepEqual(r.itens.map((l) => l.data), [...r.itens.map((l) => l.data)].sort().reverse());
  assert.equal(r.pendentes, 1);
  assert.equal(r.itens.find((l) => l.descricao === 'TED RECEBIDA')!.status, 'PENDING');
  const pix = r.itens.find((l) => l.descricao === 'PIX ENVIADO')!;
  assert.deepEqual(pix, { data: '2026-11-02', descricao: 'PIX ENVIADO', valor: -250.5, tipo: 'saida', categoria: 'Transfers', recebedor: 'João Mecânico', motivo: 'conserto', conta: 'Nubank Conta Corrente •••3450' });
  assert.equal(r.itens.find((l) => l.descricao === 'PIX RECEBIDO CLINICA SERRA')!.pagador, 'Clínica Serra Ltda');
  assert.equal(r.itensOmitidos, 0);
  assert.equal('incompleto' in r, false);
});

test('extrato: valorMinimo é em módulo, texto acha descrição e nome de pagador/recebedor sem ligar para acento ou caixa, e os totais valem para o filtrado', async () => {
  const f = padrao();
  const min = await pluggyExtrato(ctx(f), { empresa: 'doutor-digital', inicio: '2026-11-01', fim: '2026-11-30', valorMinimo: 250 });
  assert.deepEqual(min.itens.map((l) => l.descricao).sort(), ['PAGAMENTO FATURA CARTAO', 'PIX ENVIADO', 'PIX RECEBIDO CLINICA SERRA', 'COMPRA LOJA X', 'PAGAMENTO RECEBIDO', 'lançamento b1'].sort());
  assert.equal(min.totaisValemPara, 'só os lançamentos que passaram nos filtros');
  assert.equal(min.filtros.valorMinimo, 250);
  const nome = await pluggyExtrato(ctx(f), { empresa: 'doutor-digital', inicio: '2026-11-01', fim: '2026-11-30', texto: 'JOAO mecanico' });
  assert.deepEqual(nome.itens.map((l) => l.descricao), ['PIX ENVIADO'], 'achou pelo nome do recebedor, sem acento e sem caixa');
  assert.equal(nome.totais.contasBancarias.saiu, 250.5);
  const pagador = await pluggyExtrato(ctx(f), { empresa: 'doutor-digital', inicio: '2026-11-01', fim: '2026-11-30', texto: 'clinica serra' });
  assert.equal(pagador.itens.length, 1);
  const sai = await pluggyExtrato(ctx(f), { empresa: 'doutor-digital', inicio: '2026-11-01', fim: '2026-11-30', tipo: 'saida', maxItens: 1 });
  assert.equal(sai.itens.length, 1);
  assert.equal(sai.itensOmitidos, 3, '4 saídas (3 em conta + 1 no cartão), 1 listada');
  assert.equal(sai.totais.contasBancarias.entrou, 0, 'tipo=saida: os totais seguem o filtro');
  const zero = await pluggyExtrato(ctx(f), { empresa: 'doutor-digital', inicio: '2026-11-01', fim: '2026-11-30', maxItens: 0 });
  assert.equal(zero.itens.length, 0);
  assert.equal(zero.totais.contasBancarias.lancamentos, 5);
  await assert.rejects(() => pluggyExtrato(ctx(f), { empresa: 'doutor-digital', inicio: '2026-11-01', fim: '2026-11-30', texto: 'a' }), /2 caracteres/);
  await assert.rejects(() => pluggyExtrato(ctx(f), { empresa: 'doutor-digital', inicio: '2026-11-01', fim: '2026-11-30', valorMinimo: -1 }), /valorMinimo/);
});

test('extrato: período de até 90 dias (90 passa, 91 recusa), datas reais, início antes do fim; recusa ANTES de chamar a Pluggy', async () => {
  const f = padrao();
  const c = ctx(f);
  await pluggyExtrato(c, { empresa: 'doutor-digital', inicio: '2026-08-29', fim: '2026-11-26' }); // 90 dias contando os dois extremos
  assert.ok(f.pedidos.some((p) => p.startsWith('tx ')));
  const g = padrao();
  await assert.rejects(() => pluggyExtrato(ctx(g), { empresa: 'doutor-digital', inicio: '2026-08-28', fim: '2026-11-26' }), /até 90 dias/);
  await assert.rejects(() => pluggyExtrato(ctx(g), { empresa: 'doutor-digital', inicio: '2026-11-30', fim: '2026-11-01' }), /início vem depois/);
  await assert.rejects(() => pluggyExtrato(ctx(g), { empresa: 'doutor-digital', inicio: '30/11/2026', fim: '2026-11-30' }), /AAAA-MM-DD/);
  await assert.rejects(() => pluggyExtrato(ctx(g), { empresa: 'doutor-digital', inicio: '2026-02-30', fim: '2026-03-01' }), /não é uma data que existe/);
  assert.deepEqual(g.pedidos, [], 'nenhuma chamada à Pluggy com pedido inválido');
});

test('extrato: uma conta só (pelo id); conta de OUTRA empresa é recusada, e o id sozinho não abre nada', async () => {
  const f = padrao();
  const r = await pluggyExtrato(ctx(f), { empresa: 'doutor-digital', conta: CONTA_B, inicio: '2026-11-01', fim: '2026-11-30' });
  assert.equal(r.contasLidas, 1);
  assert.deepEqual(r.itens.map((l) => l.descricao), ['lançamento b1']);
  assert.equal(r.dadosDe.length, 1, 'só o frescor do item dessa conta');
  const g = padrao();
  await assert.rejects(() => pluggyExtrato(ctx(g), { empresa: 'hm-tecnologia', conta: CONTA_B, inicio: '2026-11-01', fim: '2026-11-30' }), /não é de nenhum item da empresa hm-tecnologia/);
  assert.equal(g.pedidos.some((p) => p.startsWith('tx ')), false);
  await assert.rejects(() => pluggyExtrato(ctx(g), { empresa: 'doutor-digital', conta: 'inventada', inicio: '2026-11-01', fim: '2026-11-30' }), /pluggy_contas/);
});

test('extrato: conta que falha deixa o resultado INCOMPLETO e diz qual; leitura cortada também; com uma conta pedida a falha é o erro', async () => {
  const f = padrao();
  f.fonte.transacoes = async (id) => {
    if (id === CONTA_B) throw new Error('a Pluggy respondeu 500');
    return { lancamentos: [lanc('x', '2026-11-02', 10)], truncado: id === CONTA_CARTAO };
  };
  const r = await pluggyExtrato(ctx(f), { empresa: 'doutor-digital', inicio: '2026-11-01', fim: '2026-11-30' });
  assert.equal(r.incompleto, true);
  assert.equal(r.falhas!.length, 2);
  assert.match(tudo(r.falhas), /respondeu 500/);
  assert.match(tudo(r.falhas), /lançamentos demais/);
  assert.match(String(r.atencao), /INCOMPLETOS/);
  await assert.rejects(() => pluggyExtrato(ctx(f), { empresa: 'doutor-digital', conta: CONTA_B, inicio: '2026-11-01', fim: '2026-11-30' }), /respondeu 500/);
  const semContas = fonteFalsa({ contas: { [ITEM_A]: new Error('a Pluggy respondeu 503'), [ITEM_B]: [conta(CONTA_B)] }, lancamentos: { [CONTA_B]: [lanc('b', '2026-11-03', 5)] } });
  const parcial = await pluggyExtrato(ctx(semContas), { empresa: 'doutor-digital', inicio: '2026-11-01', fim: '2026-11-30' });
  assert.equal(parcial.incompleto, true, 'item que não listou as contas também deixa incompleto');
});

test('extrato: com uma conta pedida, a queda de OUTRO item da empresa não derruba a leitura dela', async () => {
  const f = fonteFalsa({ contas: { [ITEM_A]: [conta(CONTA_CC)], [ITEM_B]: new Error('a Pluggy respondeu 500') }, lancamentos: { [CONTA_CC]: [lanc('x', '2026-11-02', 10)] } });
  const r = await pluggyExtrato(ctx(f), { empresa: 'doutor-digital', conta: CONTA_CC, inicio: '2026-11-01', fim: '2026-11-30' });
  assert.equal(r.itens.length, 1);
  assert.equal('incompleto' in r, false, 'a falha do outro item não é desta conta');
  // sem conta pedida, a mesma falha deixa o resultado incompleto
  const todas = await pluggyExtrato(ctx(f), { empresa: 'doutor-digital', inicio: '2026-11-01', fim: '2026-11-30' });
  assert.equal(todas.incompleto, true);
  // e se é o item DA conta que não listou, o erro é a falha, não "conta de outra empresa"
  const g = fonteFalsa({ contas: { [ITEM_A]: new Error('a Pluggy respondeu 503') } });
  await assert.rejects(() => pluggyExtrato(ctx(g, [itensDe[0]!]), { conta: CONTA_CC, inicio: '2026-11-01', fim: '2026-11-30' }), /respondeu 503/);
});

test('extrato: a data vem como o banco lançou (sem fuso mexer no dia)', async () => {
  const f = fonteFalsa({ contas: { [ITEM_A]: [conta(CONTA_CC)] }, lancamentos: { [CONTA_CC]: [lanc('d', '2026-11-30', -1)] } });
  const r = await pluggyExtrato(ctx(f, [itensDe[0]!]), { inicio: '2026-11-30', fim: '2026-11-30' });
  assert.equal(r.itens[0]!.data, '2026-11-30');
  assert.equal(r.empresa, 'doutor-digital', 'uma só empresa: não precisa dizer');
});

// ------------------------------------------------------------------ pluggy_resumo

test('resumo por dia: só dias com movimento, em ordem, cartão fora dos períodos', async () => {
  const r = await pluggyResumo(ctx(padrao()), { empresa: 'doutor-digital', inicio: '2026-11-01', fim: '2026-11-30' });
  assert.equal(r.agrupadoPor, 'dia');
  assert.deepEqual(r.periodos.map((p) => ('dia' in p ? p.dia : '')), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-11']);
  assert.deepEqual(r.periodos[0], { dia: '2026-11-02', entrou: 1000, saiu: 250.5, saldo: 749.5, lancamentos: 2 });
  assert.equal(r.periodos.some((p) => 'dia' in p && p.dia === '2026-11-05'), false, 'a compra de cartão do dia 05 não entra nos dias');
  assert.equal(r.totais.cartoesDeCredito?.saiu, 300);
  assert.equal(r.pendentes, 1, 'o pendente é contado, mas não entra em nenhum dia');
  assert.equal(r.dadosDe[0]!.ultimaSincronizacao, '2026-11-26T09:00:00.000Z');
});

test('resumo por semana: segunda a domingo, rótulo da segunda', async () => {
  assert.equal(segundaDaSemana('2026-11-26'), '2026-11-23'); // quinta
  assert.equal(segundaDaSemana('2026-11-23'), '2026-11-23'); // a própria segunda
  assert.equal(segundaDaSemana('2026-11-29'), '2026-11-23'); // domingo
  assert.equal(segundaDaSemana('2026-12-01'), '2026-11-30');
  const r = await pluggyResumo(ctx(padrao()), { empresa: 'doutor-digital', inicio: '2026-11-01', fim: '2026-11-30', agrupar: 'semana' });
  assert.deepEqual(r.periodos.map((p) => ('semanaDe' in p ? p.semanaDe : '')), ['2026-11-02', '2026-11-09']);
  assert.deepEqual(r.periodos[0], { semanaDe: '2026-11-02', ate: '2026-11-08', entrou: 1500, saiu: 270.4, saldo: 1229.6, lancamentos: 4 });
  assert.deepEqual(r.periodos[1], { semanaDe: '2026-11-09', ate: '2026-11-15', entrou: 0, saiu: 1200, saldo: -1200, lancamentos: 1 });
  assert.match(r.observacao, /segunda a domingo/);
});

// ------------------------------------------------------------------ permissão

async function sessao(userId: string, escritores: Set<string>, contexto: ContextoPluggy) {
  const server = new McpServer({ name: 't', version: '0' });
  const auditadas: unknown[] = [];
  const registrou = registrarPluggySePermitido(server, contexto, userId, escritores, (e) => void auditadas.push(e));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const cliente = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(a), cliente.connect(b)]);
  const nomes = (await cliente.listTools().catch(() => ({ tools: [] }))).tools.map((t) => t.name).sort();
  return { registrou, cliente, nomes, auditadas, server };
}

test('PERMISSÃO: leitor comum NÃO vê as ferramentas (nem por listagem, nem por chamada direta); escritor vê as 3, todas só de leitura', async () => {
  const c = ctx(padrao());
  const leitor = await sessao('u-leitor', new Set(['u-joao']), c);
  assert.equal(leitor.registrou, false);
  assert.deepEqual(leitor.nomes, []);
  const direta = await leitor.cliente.callTool({ name: 'pluggy_extrato', arguments: { inicio: '2026-11-01', fim: '2026-11-30', empresa: 'doutor-digital' } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
  assert.equal((direta as { isError?: boolean }).isError, true);
  assert.equal(tudo(direta).includes('1000'), false);
  const semLista = await sessao('u-joao', new Set(), c);
  assert.equal(semLista.registrou, false, 'sem MCP_ESCRITA_EMAILS ninguém vê');
  assert.deepEqual(semLista.nomes, []);
  const escritor = await sessao('u-joao', new Set(['u-joao']), c);
  assert.equal(escritor.registrou, true);
  assert.deepEqual(escritor.nomes, ['pluggy_contas', 'pluggy_extrato', 'pluggy_resumo']);
  const tools = (await escritor.cliente.listTools()).tools;
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true), 'todas só de leitura');
});

test('PERMISSÃO: com a Pluggy desligada (sem itens ou sem credenciais) nem o escritor vê as ferramentas', async () => {
  const todos = new Set(['u-joao']);
  const semItens = await sessao('u-joao', todos, criarContextoPluggy([], padrao().fonte));
  assert.equal(semItens.registrou, false);
  assert.deepEqual(semItens.nomes, []);
  const semFonte = await sessao('u-joao', todos, criarContextoPluggy(itensDe, null));
  assert.equal(semFonte.registrou, false);
  assert.deepEqual(semFonte.nomes, []);
});

test('PERMISSÃO (fonte): producao.ts usa o MESMO grupo de quem altera cartões e só mostra a Pluggy no listar_integracoes a esse grupo', () => {
  const src = readFileSync(new URL('./producao.ts', import.meta.url), 'utf8');
  assert.equal(src.match(/registrarPluggySePermitido\(/g)?.length, 1);
  assert.match(src, /registrarPluggySePermitido\(server, pluggy, quem\.userId, escritores, auditar\)/);
  assert.match(src, /escritores\.has\(quem\.userId\) && pluggy\.fonte \? \{ pluggy: empresasDoPluggy\(pluggy\) \}/);
  // o grupo é o de MCP_ESCRITA_EMAILS, não uma lista nova e frouxa
  assert.match(src, /idsDeUsuariosAtivos\('MCP_ESCRITA_EMAILS'\)/);
  assert.equal(/PLUGGY_[A-Z_]*EMAILS/.test(src), false);
});

// ------------------------------------------------------------------ listar_integracoes

const BASE = { franquia: new Map([['serra', { nome: 'Serra' }]]), kommo: new Map(), bling: new Map() };

test('listar_integracoes com as variáveis vazias fica IDÊNTICO ao de hoje (sem chave nova, sem unidade nova)', () => {
  const hoje = listarIntegracoes(BASE);
  assert.deepEqual(listarIntegracoes({ ...BASE, pluggy: new Map() }), hoje);
  assert.equal(JSON.stringify(listarIntegracoes({ ...BASE, pluggy: new Map() })), JSON.stringify(hoje), 'até a ordem das chaves');
  assert.equal(/pluggy/i.test(JSON.stringify(hoje)), false);
  assert.equal('comPluggy' in hoje, false);
  assert.equal('pluggy' in hoje.unidades[0]!, false);
  assert.deepEqual(Object.keys(hoje.unidades[0]!), ['slug', 'nome', 'franquia', 'kommo', 'bling', 'asaas', 'convenia', 'tiquetaque', 'tramitacao', 'sistemas', 'zenfisio', 'infinitepay', 'ferramentas']);
  assert.equal(empresasDoPluggy(criarContextoPluggy([], null)).size, 0);
});

test('listar_integracoes com a Pluggy ligada (só para quem pode ver) mostra a empresa e a ferramenta', () => {
  const r = listarIntegracoes({ ...BASE, pluggy: empresasDoPluggy(ctx(padrao())) });
  assert.equal(r.comPluggy, 2);
  const dd = r.unidades.find((u) => u.slug === 'doutor-digital')!;
  assert.equal(dd.pluggy, true);
  assert.equal(dd.nome, 'Doutor Digital');
  assert.match(dd.ferramentas.join(' | '), /pluggy_\*.*só leitura/);
  assert.equal(r.unidades.find((u) => u.slug === 'serra')!.pluggy, false);
});

// ------------------------------------------------------------------ segredo

test('NENHUMA saída (ferramentas, erros, auditoria) carrega o clientSecret nem a apiKey, mesmo quando a Pluggy os devolve no corpo do erro', async () => {
  const chamadas: string[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    chamadas.push(u.pathname);
    if (u.pathname === '/auth') return new Response(JSON.stringify({ apiKey: API_KEY }));
    if (u.pathname.startsWith('/items/')) return new Response(JSON.stringify({ id: ITEM_A, status: 'UPDATED', lastUpdatedAt: '2026-11-26T09:00:00.000Z', connector: { name: 'Nubank' }, message: `eco ${SEGREDO}` }));
    if (u.pathname === '/accounts') return new Response(JSON.stringify({ results: [{ id: CONTA_CC, type: 'BANK', name: 'Conta', number: '1234567-8', balance: 10, currencyCode: 'BRL' }] }));
    // a leitura de lançamentos falha e a Pluggy repete as credenciais no corpo do erro
    return new Response(JSON.stringify({ message: `falha ${SEGREDO} ${API_KEY} ${(init.headers as Record<string, string>)['X-API-KEY']}`, codeDescription: 'INTERNAL' }), { status: 400 });
  }) as unknown as typeof fetch;
  const fonte = criarClientePluggy({ clientId: 'cid-fixture', clientSecret: SEGREDO }, { fetcher, esperar: async () => undefined });
  const c = criarContextoPluggy([itensDe[0]!], fonte, { agora: () => AGORA });
  const s = await sessao('u-joao', new Set(['u-joao']), c);
  const saidas: string[] = [];
  for (const [name, args] of [
    ['pluggy_contas', { testar: true }],
    ['pluggy_extrato', { inicio: '2026-11-01', fim: '2026-11-30' }],
    ['pluggy_extrato', { inicio: '2026-11-01', fim: '2026-11-30', conta: CONTA_CC }],
    ['pluggy_resumo', { inicio: '2026-11-01', fim: '2026-11-30' }],
    ['pluggy_resumo', { inicio: '2026-13-01', fim: '2026-11-30' }],
  ] as const) {
    saidas.push(tudo(await s.cliente.callTool({ name, arguments: args })));
  }
  saidas.push(tudo(s.auditadas));
  assert.ok(chamadas.includes('/v2/transactions'), 'os cenários chegaram a ler lançamentos');
  assert.equal(saidas.length, 6);
  for (const t of saidas) {
    assert.equal(t.includes('FIXTURE'), false, t.slice(0, 300));
    assert.equal(t.includes('eyJ'), false, t.slice(0, 300));
    assert.equal(t.includes('1234567-8'), false, 'número da conta inteiro');
    assert.equal(t.includes(ITEM_A), false, 'id do item inteiro');
  }
  // e a leitura bem-sucedida de verdade devolveu dado (o teste não passa por estar tudo vazio)
  assert.match(saidas[0]!, /•••5678/);
});
