import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asaasCobrancas, asaasExtrato, asaasSaldo, criarContextoAsaas, resolverContasAsaas, resumirCobrancas, type ContaAsaas } from './asaas.js';
import { listarIntegracoes } from './integracoes.js';

function conta(slug: string, rotas: Record<string, (q: Record<string, unknown>) => unknown>, chamadas: Array<[string, Record<string, unknown>]> = []): ContaAsaas {
  return {
    slug, nome: slug,
    fonte: {
      async get<T>(caminho: string, query?: Record<string, string | number | undefined>): Promise<T> {
        chamadas.push([caminho, { ...(query ?? {}) }]);
        const r = rotas[caminho];
        if (!r) throw new Error(`rota não simulada: ${caminho}`);
        return r(query ?? {}) as T;
      },
    },
  };
}

const COBRANCAS = [
  { id: 'pay_1', value: 250, netValue: 248.01, status: 'RECEIVED', billingType: 'PIX', dueDate: '2026-10-10', paymentDate: '2026-10-10' },
  { id: 'pay_2', value: 250, netValue: 248.01, status: 'CONFIRMED', billingType: 'CREDIT_CARD', dueDate: '2026-10-11' },
  { id: 'pay_3', value: 150, netValue: 0, status: 'PENDING', billingType: 'PIX', dueDate: '2026-10-20' },
  { id: 'pay_4', value: 3800, netValue: 0, status: 'OVERDUE', billingType: 'BOLETO', dueDate: '2026-10-05' },
];

test('cobranças: recebidas (bruto e líquido), aguardando e vencidas; filtro de data vai com colchetes', async () => {
  const chamadas: Array<[string, Record<string, unknown>]> = [];
  const ctx = criarContextoAsaas(new Map([['doutor-hernia-serra', conta('doutor-hernia-serra', { '/payments': () => ({ data: COBRANCAS, hasMore: false }) }, chamadas)]]));
  const r = await asaasCobrancas(ctx, { unidade: 'serra', inicio: '2026-10-01', fim: '2026-10-31', agruparPor: 'forma' });
  const u = r.porUnidade['doutor-hernia-serra'] as Extract<(typeof r.porUnidade)[string], { ok: true }>;
  assert.equal(u.ok, true);
  assert.deepEqual(u.recebidas, { quantidade: 2, valor: 500, liquido: 496.02 });
  assert.deepEqual(u.aguardando, { quantidade: 1, valor: 150 });
  assert.deepEqual(u.vencidas, { quantidade: 1, valor: 3800 });
  assert.deepEqual(u.porForma['Pix'], { quantidade: 2, valor: 400 });
  assert.equal(chamadas[0]![1]['dueDate[ge]'], '2026-10-01');
  assert.equal(chamadas[0]![1]['dueDate[le]'], '2026-10-31');
  assert.equal(chamadas[0]![1].limit, 100);
});

test('paginação do Asaas segue hasMore', async () => {
  let n = 0;
  const ctx = criarContextoAsaas(new Map([['x', conta('x', { '/payments': (q) => { n++; return { data: [COBRANCAS[0]], hasMore: Number(q.offset) < 200 }; } })]]));
  const r = await asaasCobrancas(ctx, { unidade: 'x', inicio: '2026-10-01', fim: '2026-10-31' });
  assert.equal(n, 3);
  assert.equal((r.porUnidade['x'] as { cobrancas: number }).cobrancas, 3);
});

test('várias clínicas: uma com erro fica fora da rede, as outras somam', async () => {
  const ok = conta('doutor-hernia-serra', { '/payments': () => ({ data: COBRANCAS, hasMore: false }) });
  const quebrada = conta('doutor-hernia-maraba', { '/payments': () => { throw new Error('o Asaas recusou a chave (401)'); } });
  const ctx = criarContextoAsaas(new Map([[ok.slug, ok], [quebrada.slug, quebrada]]));
  const r = await asaasCobrancas(ctx, { unidade: 'todas', inicio: '2026-10-01', fim: '2026-10-31' });
  assert.equal(r.rede!.recebidas, 500);
  assert.deepEqual(r.rede!.unidadesForaDoTotal, ['doutor-hernia-maraba']);
  assert.equal(r.porUnidade['doutor-hernia-maraba']!.ok, false);
});

test('extrato: entradas, saídas, saldo no fim e por tipo', async () => {
  const lanc = [
    { id: 'ft_2', value: -1.99, balance: 248.02, type: 'PAYMENT_FEE', date: '2026-10-10' },
    { id: 'ft_1', value: 250, balance: 250.01, type: 'PAYMENT_RECEIVED', date: '2026-10-10' },
    { id: 'ft_3', value: -200, balance: 48.02, type: 'TRANSFER', date: '2026-10-12' },
  ];
  const ctx = criarContextoAsaas(new Map([['x', conta('x', { '/financialTransactions': () => ({ data: lanc, hasMore: false }) })]]));
  const r = await asaasExtrato(ctx, { unidade: 'x', inicio: '2026-10-01', fim: '2026-10-31' });
  assert.deepEqual(r.entradas, { quantidade: 1, valor: 250 });
  assert.deepEqual(r.saidas, { quantidade: 2, valor: -201.99 });
  assert.equal(r.saldoNoFim, 48.02);
  assert.equal(r.porTipo['PAYMENT_RECEIVED']!.valor, 250);
});

test('saldo, nome curto e erro claro sem Asaas', async () => {
  const ctx = criarContextoAsaas(new Map([['doutor-hernia-serra', conta('doutor-hernia-serra', { '/finance/balance': () => ({ balance: 1234.5 }) })]]));
  const r = await asaasSaldo(ctx, { unidade: 'serra' });
  assert.deepEqual(r.porUnidade['doutor-hernia-serra'], { ok: true, saldo: 1234.5 });
  assert.throws(() => resolverContasAsaas(ctx, 'maraba'), /sem Asaas/);
  assert.throws(() => resolverContasAsaas(criarContextoAsaas(new Map()), 'serra'), /painel de integrações/);
});

test('resumo por mês usa a data escolhida', () => {
  const r = resumirCobrancas(COBRANCAS, 'mes', 'dueDate');
  assert.deepEqual(r.agrupado, { '2026-10': { quantidade: 4, valor: 4450 } });
});

test('integrações mostram o Asaas', () => {
  const r = listarIntegracoes({ franquia: new Map([['doutor-hernia-serra', { nome: 'Serra' }]]), kommo: new Map(), bling: new Map(), asaas: new Map([['doutor-hernia-serra', { nome: 'Serra' }]]) });
  assert.equal(r.unidades[0]!.asaas, true);
  assert.equal(r.comAsaas, 1);
});
