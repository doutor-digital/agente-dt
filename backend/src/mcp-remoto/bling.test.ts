import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blingContasReceber, blingPedidos, criarContextoBling, cruzarVendas, type ContaBling } from './bling.js';
import { listarIntegracoes } from './integracoes.js';
import { acharSlug } from './unidades.js';

function contaFalsa(rotas: Record<string, unknown>, chamadas: string[] = []): ContaBling {
  return {
    slug: 'hm-tecnologia',
    nome: 'Hm tecnologia',
    fonte: {
      async get<T>(caminho: string, query?: Record<string, string | number | undefined>): Promise<T> {
        chamadas.push(`${caminho}?${new URLSearchParams(Object.entries(query ?? {}).map(([k, v]): [string, string] => [k, String(v)])).toString()}`);
        if (!(caminho in rotas)) throw new Error(`rota não simulada: ${caminho}`);
        return rotas[caminho] as T;
      },
    },
  };
}

// formato real lido do Bling da HM em 16/10/2026
const PEDIDOS = {
  data: [
    { id: 1, numero: 2433, data: '2026-10-14', total: 189, contato: { id: 18449253320, nome: 'Fernando' }, situacao: { id: 9 } },
    { id: 2, numero: 2432, data: '2026-10-14', total: 189, contato: { id: 2, nome: 'Walvenarques' }, situacao: { id: 9 } },
    { id: 3, numero: 2431, data: '2026-10-13', total: 279.3, contato: { id: 3, nome: 'Mirlene' }, situacao: { id: 6 } },
    { id: 4, numero: 2430, data: '2026-10-12', total: 500, contato: { id: 4, nome: 'X' }, situacao: { id: 12 } },
  ],
};

test('pedidos: situação pelo nome, cancelado fora do total, agrupado por dia', async () => {
  const ctx = criarContextoBling(new Map([['hm-tecnologia', contaFalsa({ '/pedidos/vendas': PEDIDOS, '/situacoes/modulos': { data: [] } })]]));
  const r = await blingPedidos(ctx, { empresa: 'hm', inicio: '2026-10-01', fim: '2026-10-16', agruparPor: 'dia' });
  assert.equal(r.pedidos, 3);
  assert.equal(r.valorTotal, 657.3);
  assert.equal(r.cancelados, 1);
  assert.deepEqual(r.porSituacao['Atendido'], { quantidade: 2, valor: 378 });
  assert.equal(r.porSituacao['Cancelado']!.quantidade, 1);
  assert.deepEqual(r.agrupado!['2026-10-14'], { quantidade: 2, valor: 378 });
});

test('pedidos: situação própria da conta vem de /situacoes; pagina até vir menos de 100', async () => {
  const chamadas: string[] = [];
  const cem = { data: Array.from({ length: 100 }, (_, i) => ({ id: i, numero: i, data: '2026-10-01', total: 1, situacao: { id: 777 } })) };
  let pagina = 0;
  const conta = contaFalsa({ '/situacoes/modulos': { data: [{ id: 98310, nome: 'Vendas' }] }, '/situacoes/modulos/98310': { data: [{ id: 777, nome: 'Aguardando produção' }] } }, chamadas);
  const get = conta.fonte.get.bind(conta.fonte);
  conta.fonte.get = async <T,>(c: string, q?: Record<string, string | number | undefined>) =>
    (c === '/pedidos/vendas' ? (++pagina === 1 ? cem : { data: [] }) : await get(c, q)) as T;
  const ctx = criarContextoBling(new Map([['hm-tecnologia', conta]]));
  const r = await blingPedidos(ctx, { empresa: 'hm-tecnologia', inicio: '2026-10-01', fim: '2026-10-01' });
  assert.equal(r.pedidos, 100);
  assert.equal(r.porSituacao['Aguardando produção']!.quantidade, 100);
  assert.equal(pagina, 2);
});

test('contas a receber: por situação e vencidas em aberto', async () => {
  const ctx = criarContextoBling(new Map([['hm-tecnologia', contaFalsa({ '/contas/receber': { data: [
    { id: 1, situacao: 1, vencimento: '2026-10-09', valor: 10, contato: { nome: 'Sarah' }, origem: { tipoOrigem: 'venda', numero: '2421' } },
    { id: 2, situacao: 2, vencimento: '2026-10-10', valor: 20 },
    { id: 3, situacao: 1, vencimento: '2099-01-01', valor: 5 },
  ] } })]]));
  const r = await blingContasReceber(ctx, { empresa: 'hm', inicio: '2026-10-01', fim: '2026-10-16' });
  assert.deepEqual(r.porSituacao['Em aberto'], { quantidade: 2, valor: 15 });
  assert.deepEqual(r.vencidasEmAberto, { quantidade: 1, valor: 10 });
  assert.equal(r.itens[0]!.origem, 'venda 2421');
});

test('vendas: telefone do Bling "(63) 9925-5715" casa com o do Kommo "+55 63 99925-5715"', () => {
  const r = cruzarVendas({
    leads: [
      { id: 10, origem: 'Instagram', telefone: '+55 63 99925-5715' },
      { id: 11, origem: 'Instagram', telefone: '+55 63 98888-0000' },
      { id: 12, origem: '(sem origem)', telefone: null },
    ],
    pedidos: [
      { numero: 2433, total: 189, telefoneDoCliente: '(63) 9925-5715' },
      { numero: 2440, total: 100, telefoneDoCliente: '63999255715' }, // mesmo cliente, 2º pedido
      { numero: 2432, total: 189, telefoneDoCliente: '(63) 3411-0000' },
      { numero: 2431, total: 50, telefoneDoCliente: null },
    ],
  });
  assert.equal(r.leads, 3);
  assert.equal(r.leadsQueCompraram, 1);
  assert.equal(r.pedidosDeLeadDoKommo, 2);
  assert.equal(r.valorDeLeadDoKommo, 289);
  assert.equal(r.pedidosSemTelefoneNoBling, 1);
  assert.deepEqual(r.porOrigem['Instagram'], { leads: 2, compraram: 1, pedidos: 2, valor: 289 });
  assert.equal(r.conversao, 33.3);
});

test('"hm" acha "hm-tecnologia"; nomes curtos das clínicas continuam funcionando', () => {
  const slugs = ['doutor-hernia-serra', 'doutor-hernia-maraba', 'maraba-resgate', 'hm-tecnologia', 'default'];
  assert.equal(acharSlug(slugs, 'hm'), 'hm-tecnologia');
  assert.equal(acharSlug(slugs, 'serra'), 'doutor-hernia-serra');
  assert.equal(acharSlug(slugs, 'maraba'), 'doutor-hernia-maraba');
  assert.equal(acharSlug(slugs, 'doutor'), undefined);
});

test('integrações: HM aparece com Kommo e Bling, sem franquia', () => {
  const r = listarIntegracoes({
    franquia: new Map([['doutor-hernia-serra', { nome: 'Doutor Hérnia Serra' }]]),
    kommo: new Map([['doutor-hernia-serra', { nome: 'Doutor Hérnia Serra' }], ['hm-tecnologia', { nome: 'Hm tecnologia' }]]),
    bling: new Map([['hm-tecnologia', { nome: 'Hm tecnologia' }]]),
  });
  const hm = r.unidades.find((u) => u.slug === 'hm-tecnologia')!;
  assert.deepEqual([hm.franquia, hm.kommo, hm.bling], [false, true, true]);
  assert.ok(hm.ferramentas.includes('relatorio_vendas'));
  assert.equal(r.comBling, 1);
});
