/** Tetos por ORIGEM (conector, caixa, sofia) dentro da mesma unidade: uma nunca bloqueia a outra. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import type { PedidoDeLink } from '../lib/integracoes/infinitepay.js';
import { criarContextoInfinitepay, type ContaInfinitepay } from './infinitepay.js';
import { PADROES_POR_ORIGEM, criarEscritaInfinitepay, criarLink, linksPorHora, tetoPorDiaInfinitepay, tetoPorLink } from './infinitepay-escrita.js';
import { armazemEmMemoria } from './infinitepay-falso.js';

const UNI = 'doutor-hernia-acailandia';
const AGORA = Date.parse('2026-11-26T15:00:00Z');
const Q = { id: 'u' };

function montar(env: NodeJS.ProcessEnv = {}) {
  const pedidos: Array<Omit<PedidoDeLink, 'handle'>> = [];
  const conta: ContaInfinitepay = {
    slug: UNI, nome: 'Açailândia', chaveFinal: '…rstu', temHandle: false,
    fonte: { consultar: async () => ({ sucesso: true, pago: true }), testar: async () => undefined, criarLink: async (p) => (pedidos.push(p), { url: `https://checkout.infinitepay.io/dd/${p.orderNsu}` }) },
  };
  const armazem = armazemEmMemoria();
  const ctx = criarContextoInfinitepay(new Map([[UNI, conta]]), armazem);
  // os tetos vêm do AMBIENTE por origem (o padrão de produção), não de um número fixo
  const esc = criarEscritaInfinitepay({
    armazem, agora: () => AGORA, unidades: () => new Set([UNI]), alertar: async () => true,
    tetoLink: (o) => tetoPorLink(env, o), tetoDia: (o) => tetoPorDiaInfinitepay(env, o), porHora: (o) => linksPorHora(env, o),
  });
  return { ctx, esc, armazem, pedidos };
}

test('padrões: Sofia R$ 100 por link e R$ 1.000 por dia; Caixa R$ 5.000 e R$ 20.000; conector como sempre; 20 por hora cada', () => {
  assert.deepEqual(PADROES_POR_ORIGEM.sofia, { tetoOperacao: 100, tetoDia: 1000, porHora: 20 });
  assert.deepEqual(PADROES_POR_ORIGEM.caixa, { tetoOperacao: 5000, tetoDia: 20000, porHora: 20 });
  assert.deepEqual(PADROES_POR_ORIGEM.conector, { tetoOperacao: 5000, tetoDia: 20000, porHora: 20 });
  assert.equal(tetoPorLink({}, 'sofia'), 100);
  assert.equal(tetoPorDiaInfinitepay({}, 'sofia'), 1000);
  assert.equal(tetoPorLink({}), 5000, 'sem origem = conector');
});

test('configurável por origem no ambiente (sufixo _SOFIA / _CAIXA; o conector segue sem sufixo); 0 ou lixo no por-hora desliga SÓ aquela origem', () => {
  const e = { INFINITEPAY_TETO_OPERACAO_REAIS_SOFIA: '150', INFINITEPAY_TETO_DIA_REAIS_CAIXA: '9000', INFINITEPAY_LINKS_POR_HORA_CAIXA: '3', INFINITEPAY_TETO_OPERACAO_REAIS: '4000', INFINITEPAY_LINKS_POR_HORA_SOFIA: 'lixo' };
  assert.equal(tetoPorLink(e, 'sofia'), 150);
  assert.equal(tetoPorDiaInfinitepay(e, 'caixa'), 9000);
  assert.equal(linksPorHora(e, 'caixa'), 3);
  assert.equal(tetoPorLink(e, 'conector'), 4000);
  assert.equal(tetoPorLink(e, 'caixa'), 5000, 'a variável do conector não vale para o Caixa');
  assert.equal(linksPorHora(e, 'sofia'), 0, 'lixo desliga a Sofia');
  assert.equal(linksPorHora(e, 'conector'), 20);
});

test('o Caixa gasta o teto do DIA dele e a Sofia ainda emite um sinal de R$ 50 (e o conector também segue livre)', async () => {
  const m = montar();
  // o Caixa usa os R$ 20.000 do dia dele: 4 links de R$ 5.000
  for (let i = 0; i < 4; i++) await criarLink(m.ctx, m.esc, Q, { valor: 5000, descricao: `Caixa pacote ${i}`, origem: 'caixa' });
  await assert.rejects(() => criarLink(m.ctx, m.esc, Q, { valor: 5, descricao: 'Caixa um a mais', origem: 'caixa' }), /teto do dia de caixa/);
  // a Sofia não é tocada
  const sofia = await criarLink(m.ctx, m.esc, Q, { valor: 50, descricao: 'Sinal da consulta', origem: 'sofia' });
  assert.equal(sofia.criado, true);
  // o conector também
  assert.equal((await criarLink(m.ctx, m.esc, Q, { valor: 100, descricao: 'Conector livre' })).criado, true);
  assert.deepEqual(['caixa', 'caixa', 'caixa', 'caixa', 'sofia', 'conector'], m.armazem.linhas.map((l) => (l as { origem?: string }).origem));
});

test('e ao contrário: a Sofia esgota o dia dela (R$ 1.000) e o Caixa segue emitindo; os tetos da Sofia são os dela (R$ 100 por link)', async () => {
  const m = montar();
  await assert.rejects(() => criarLink(m.ctx, m.esc, Q, { valor: 101, descricao: 'Sinal grande', origem: 'sofia' }), /teto por link de sofia/);
  for (let i = 0; i < 10; i++) await criarLink(m.ctx, m.esc, Q, { valor: 100, descricao: `Sinal ${i}`, origem: 'sofia' });
  await assert.rejects(() => criarLink(m.ctx, m.esc, Q, { valor: 1, descricao: 'Sinal 11', origem: 'sofia' }), /teto do dia de sofia/);
  assert.equal((await criarLink(m.ctx, m.esc, Q, { valor: 3000, descricao: 'Caixa ainda livre', origem: 'caixa' })).criado, true);
});

test('o limite de 20 por hora também é por origem', async () => {
  const m = montar({ INFINITEPAY_LINKS_POR_HORA_CAIXA: '2' });
  await criarLink(m.ctx, m.esc, Q, { valor: 10, descricao: 'Link aaa', origem: 'caixa' });
  await criarLink(m.ctx, m.esc, Q, { valor: 10, descricao: 'Link bbb', origem: 'caixa' });
  await assert.rejects(() => criarLink(m.ctx, m.esc, Q, { valor: 10, descricao: 'Link ccc', origem: 'caixa' }), /limite de 2 links por hora \(caixa\)/);
  assert.equal((await criarLink(m.ctx, m.esc, Q, { valor: 10, descricao: 'Link ddd', origem: 'sofia' })).criado, true);
  assert.equal((await criarLink(m.ctx, m.esc, Q, { valor: 10, descricao: 'Link eee' })).criado, true);
});

test('origem desconhecida é recusada; a ferramenta do claude.ai nunca escolhe a origem', async () => {
  const m = montar();
  await assert.rejects(() => criarLink(m.ctx, m.esc, Q, { valor: 10, descricao: 'x', origem: 'hacker' as never }), ErroDeEntrada);
  // a ferramenta registrada força `conector` e descarta origem/origemRef/cliente do pedido dela
  const { registrarEscritaInfinitepay } = await import('./infinitepay-escrita.js');
  let tratador: ((a: Record<string, unknown>) => Promise<unknown>) | undefined;
  registrarEscritaInfinitepay({ registerTool: (_n: string, _d: unknown, fn: never) => (tratador = fn) } as never, m.ctx, m.esc, Q, (() => undefined) as never);
  await tratador!({ valor: 20, descricao: 'pela ferramenta', origem: 'caixa', origemRef: 'cx-1', cliente: { nome: 'X Y' } });
  const l = m.armazem.linhas.at(-1) as { origem?: string; origemRef?: string | null };
  assert.equal(l.origem, 'conector');
  assert.equal(l.origemRef ?? null, null);
});
