/**
 * Custo estimado, ritmo, máximo de pessoas e teto de gasto por dia do disparo pelo CRM.
 */
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://x:y@127.0.0.1:1/z';
process.env.SESSION_JWT_SECRET ??= 'segredo-de-teste-com-mais-de-32-caracteres-ok';

import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from './prisma.js';
import { FREIOS_PADRAO } from './disparo/freios.js';
import { avisoDoTetoDeGasto, estimarCusto, freiosComTetoDeGasto, mensagensPorGasto, precoDaCategoria, ritmoDaOnda, tetoReaisPorDia, TETO_REAIS_DIA_PADRAO, cambioDoDia, _esquecerCambio, type LinhaDeCusto } from './disparo/chatwoot/custo.js';

const originais = new Map<string, PropertyDescriptor | undefined>();
function falso(modelo: string, metodos: Record<string, unknown>): void {
  if (!originais.has(modelo)) originais.set(modelo, Object.getOwnPropertyDescriptor(prisma, modelo));
  Object.defineProperty(prisma, modelo, { value: metodos, configurable: true, writable: true });
}
afterEach(() => {
  mock.restoreAll();
  for (const [modelo, d] of originais) {
    if (d) Object.defineProperty(prisma, modelo, d);
    else delete (prisma as unknown as Record<string, unknown>)[modelo];
  }
  originais.clear();
  _esquecerCambio();
});

const env = (v: string | undefined) => ({ CHATWOOT_DISPARO_TETO_REAIS_DIA: v }) as NodeJS.ProcessEnv;

test('teto de gasto por dia: padrão R$ 50; valor ilegível, zero, negativo ou absurdo volta ao PADRÃO — nunca «sem teto»', () => {
  assert.equal(TETO_REAIS_DIA_PADRAO, 50);
  assert.equal(tetoReaisPorDia(env(undefined)), 50);
  assert.equal(tetoReaisPorDia(env('')), 50);
  assert.equal(tetoReaisPorDia(env('80')), 80);
  assert.equal(tetoReaisPorDia(env('12,5')), 12.5);
  for (const lixo of ['abc', '0', '-5', 'Infinity', 'NaN', '1e12', '  ', 'sem teto', '*']) assert.equal(tetoReaisPorDia(env(lixo)), 50, lixo);
  assert.equal(avisoDoTetoDeGasto(env(undefined)), null);
  assert.equal(avisoDoTetoDeGasto(env('80')), null);
  assert.match(avisoDoTetoDeGasto(env('abc')) ?? '', /não vale: ficou R\$ 50/);
});

const linha = (o: Partial<LinhaDeCusto> = {}): LinhaDeCusto => ({ pricingCategory: 'MARKETING_LITE', pricingType: 'REGULAR', country: 'BR', volume: 100, costUsd: 6.25, ...o });

test('preço por mensagem: o MAIOR custo diário por mensagem da própria tabela da Meta (a média misturaria dias grátis); só cobrança regular no Brasil; categoria que não está na tabela = null (desconhecido)', () => {
  const linhas = [
    linha({ volume: 100, costUsd: 6.25 }), // 0,0625
    linha({ volume: 100, costUsd: 3 }), // 0,03 (parte grátis)
    linha({ pricingCategory: 'MARKETING', volume: 10, costUsd: 0.625 }), // 0,0625 (MARKETING também é da família)
    linha({ pricingType: 'FREE_ENTRY_POINT', volume: 50, costUsd: 99 }), // grátis/outro tipo: ignorada
    linha({ country: 'US', volume: 10, costUsd: 9 }), // outro país: ignorada
    linha({ volume: 2, costUsd: 1 }), // amostra pequena demais: ignorada
    linha({ pricingCategory: 'UTILITY', volume: 100, costUsd: 0.5 }),
  ];
  const m = precoDaCategoria(linhas, 'MARKETING')!;
  assert.equal(m.usd, 0.0625);
  assert.equal(m.dias, 3);
  assert.equal(precoDaCategoria(linhas, 'utility')!.usd, 0.005);
  assert.equal(precoDaCategoria(linhas, 'AUTHENTICATION'), null, 'a tabela não tem a categoria: desconhecido, nunca um palpite');
  assert.equal(precoDaCategoria(linhas, null), null);
  assert.equal(precoDaCategoria([], 'MARKETING'), null);
});

test('estimativa: conhecido (arredonda o total PARA CIMA ao centavo); sem categoria, sem preço ou sem câmbio = DESCONHECIDO com o motivo', () => {
  const e = estimarCusto({ pessoas: 50, categoria: 'MARKETING', preco: { usd: 0.0625, dias: 30 }, cambio: 5.6 });
  assert.equal(e.conhecido, true);
  assert.equal(e.porMensagemBrl, 0.35);
  assert.equal(e.brl, 17.5);
  assert.match(e.nota, /MARKETING/);
  const cima = estimarCusto({ pessoas: 3, categoria: 'MARKETING', preco: { usd: 0.0625, dias: 1 }, cambio: 5.5555 });
  assert.equal(cima.brl, 1.05, '3 × 0,347 = 1,0416 → 1,05 (nunca para baixo)');
  const semPreco = estimarCusto({ pessoas: 50, categoria: 'AUTHENTICATION', preco: null, cambio: 5.6 });
  assert.deepEqual([semPreco.conhecido, semPreco.brl], [false, null]);
  assert.match(semPreco.nota, /não tem a categoria AUTHENTICATION/);
  const semCambio = estimarCusto({ pessoas: 50, categoria: 'MARKETING', preco: { usd: 0.0625, dias: 1 }, cambio: null });
  assert.deepEqual([semCambio.conhecido, semCambio.brl, semCambio.porMensagemUsd], [false, null, 0.0625]);
  assert.equal(estimarCusto({ pessoas: 5, categoria: null, preco: null, cambio: 5 }).conhecido, false);
});

test('ritmo: o teto por dia, o por hora × a janela e o de gasto — o menor vale; em quantos dias a onda termina; preço desconhecido: o gasto não limita', () => {
  const f = FREIOS_PADRAO; // 30/h, 100/dia, 9h–18h, dias úteis
  const a = ritmoDaOnda({ pessoas: 50, freios: f, tetoReais: 50, porMensagemBrl: 0.35 });
  assert.deepEqual([a.porDia, a.dias, a.limitadoPor, a.soDiasUteis], [100, 1, 'dia', true]);
  const b = ritmoDaOnda({ pessoas: 250, freios: f, tetoReais: 50, porMensagemBrl: 0.35 });
  assert.deepEqual([b.porDia, b.dias], [100, 3]);
  const c = ritmoDaOnda({ pessoas: 100, freios: f, tetoReais: 20, porMensagemBrl: 0.35 });
  assert.deepEqual([c.porDia, c.dias, c.limitadoPor], [57, 2, 'gasto']);
  const d = ritmoDaOnda({ pessoas: 100, freios: { ...f, tetoPorHora: 5 }, tetoReais: 50, porMensagemBrl: null });
  assert.deepEqual([d.porDia, d.limitadoPor], [45, 'hora']);
  assert.equal(ritmoDaOnda({ pessoas: 10, freios: f, tetoReais: 0.1, porMensagemBrl: 0.35 }).dias, Infinity, 'teto menor que uma mensagem: não anda');
});

test('freios com teto de gasto: o teto por 24 h nunca passa de teto ÷ preço; sem preço, só os outros tetos', () => {
  assert.equal(mensagensPorGasto(50, 0.35), 142);
  assert.equal(mensagensPorGasto(50, null), null);
  assert.equal(freiosComTetoDeGasto(FREIOS_PADRAO, 50, 0.35).tetoPorDia, 100, 'o teto de mensagens (100) é menor: vale');
  assert.equal(freiosComTetoDeGasto(FREIOS_PADRAO, 20, 0.35).tetoPorDia, 57);
  assert.equal(freiosComTetoDeGasto(FREIOS_PADRAO, 0.1, 0.35).tetoPorDia, 0);
  assert.equal(freiosComTetoDeGasto(FREIOS_PADRAO, 20, null), FREIOS_PADRAO);
});

test('câmbio: o do Kommo (cotacaoDoDolar), guardado; falha não fica presa por muito tempo', async () => {
  let chamadas = 0;
  const buscar = async () => (chamadas++, 5.5);
  assert.equal(await cambioDoDia(buscar, 1000), 5.5);
  assert.equal(await cambioDoDia(buscar, 2000), 5.5);
  assert.equal(chamadas, 1);
  _esquecerCambio();
  let ok = false;
  const falha = async () => (ok ? 5.6 : null);
  assert.equal(await cambioDoDia(falha, 0), null);
  ok = true;
  assert.equal(await cambioDoDia(falha, 30_000), null, 'a falha vale 1 min');
  assert.equal(await cambioDoDia(falha, 90_000), 5.6);
});

test('o preço vem da tabela de custo da PRÓPRIA unidade (whatsapp_cost_daily) e a leitura filtra unidade, janela de 90 dias e a família da categoria', async () => {
  const { lerPrecoDaUnidade } = await import('./disparo/chatwoot/custo.js');
  const consultas: Array<Record<string, any>> = [];
  falso('whatsappCostDaily', { findMany: async (a: Record<string, any>) => (consultas.push(a), [{ pricingCategory: 'MARKETING_LITE', pricingType: 'REGULAR', country: 'BR', volume: 329, costUsd: '20.5625' }]) });
  const p = await lerPrecoDaUnidade('u1', 'marketing', new Date(Date.UTC(2026, 10, 17)));
  assert.equal(p!.usd, 20.5625 / 329);
  assert.equal(consultas[0]!.where.unitId, 'u1');
  assert.equal(consultas[0]!.where.pricingCategory.startsWith, 'MARKETING');
  assert.equal((consultas[0]!.where.date.gte as Date).toISOString().slice(0, 10), '2026-08-19', '90 dias para trás');
  assert.equal(await lerPrecoDaUnidade('u1', null), null);
});

test('teto de gasto NÃO falha aberto: se o banco ou o câmbio falhar depois de um preço bom, vale o último preço; várias categorias na unidade valem pelo MAIOR preço', async () => {
  const { precoEmReaisDoBanco, maiorPrecoDasOndas, _esquecerPrecosDeGasto } = await import('./disparo/chatwoot/rodada.js');
  const { _definirCambio } = await import('./disparo/chatwoot/custo.js');
  _esquecerPrecosDeGasto();
  _definirCambio(5.6);
  falso('whatsappCostDaily', { findMany: async () => [{ pricingCategory: 'MARKETING_LITE', pricingType: 'REGULAR', country: 'BR', volume: 100, costUsd: '6.25' }] });
  assert.equal(await precoEmReaisDoBanco('u1', 'MARKETING'), 0.35);
  falso('whatsappCostDaily', { findMany: async () => { throw new Error('banco fora'); } });
  assert.equal(await precoEmReaisDoBanco('u1', 'MARKETING'), 0.35, 'o banco caiu: segue o último preço bom');
  _definirCambio(null);
  assert.equal(await precoEmReaisDoBanco('u1', 'MARKETING'), 0.35, 'o câmbio caiu: idem');
  assert.equal(await precoEmReaisDoBanco('u2', 'MARKETING'), null, 'unidade que nunca teve preço: desconhecido');
  const preco = async (_u: string, c: string | null) => (c === 'MARKETING' ? 0.35 : c === 'UTILITY' ? 0.03 : null);
  assert.equal(await maiorPrecoDasOndas(preco, 'u1', ['UTILITY', 'MARKETING', 'MARKETING']), 0.35);
  assert.equal(await maiorPrecoDasOndas(preco, 'u1', ['UTILITY', 'AUTHENTICATION']), 0.03, 'categoria sem preço não zera o teto das outras');
  assert.equal(await maiorPrecoDasOndas(preco, 'u1', ['AUTHENTICATION']), null);
});
