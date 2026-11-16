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
import * as custoMod from './disparo/chatwoot/custo.js';
import { avisoDoTetoDeGasto, estimarCusto, mensagensQueCabem, freiosComTetoDeGasto, mensagensPorGasto, precoDaCategoria, ritmoDaOnda, tetoReaisPorDia, TETO_REAIS_DIA_PADRAO, cambioDoDia, _esquecerCambio, type LinhaDeCusto } from './disparo/chatwoot/custo.js';

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
  const semPreco = estimarCusto({ pessoas: 50, categoria: 'AUTHENTICATION', preco: null, cambio: 5.6, env: {} });
  assert.deepEqual([semPreco.conhecido, semPreco.reserva, semPreco.brl, semPreco.porMensagemBrl], [false, true, 12.5, 0.25]);
  assert.match(semPreco.nota, /preço de reserva \(sem histórico da Meta\).*não tem a categoria AUTHENTICATION/);
  const semCambio = estimarCusto({ pessoas: 50, categoria: 'MARKETING', preco: { usd: 0.0625, dias: 1 }, cambio: null, env: {} });
  assert.deepEqual([semCambio.conhecido, semCambio.reserva, semCambio.brl, semCambio.porMensagemUsd], [false, true, 100, 0.0625]);
  const semCategoria = estimarCusto({ pessoas: 5, categoria: null, preco: null, cambio: 5, env: {} });
  assert.deepEqual([semCategoria.conhecido, semCategoria.reserva, semCategoria.porMensagemBrl], [false, true, 2], 'categoria desconhecida usa a reserva MAIS CARA');
  assert.equal(e.reserva, false);
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
  // (freios, já mandadas nas 24 h, ainda cabem em reais): o teto de 24 h é «já mandadas + cabem», nunca passa do teto de mensagens
  assert.equal(freiosComTetoDeGasto(FREIOS_PADRAO, 0, 142).tetoPorDia, 100, 'o teto de mensagens (100) é menor: vale');
  assert.equal(freiosComTetoDeGasto(FREIOS_PADRAO, 0, 57).tetoPorDia, 57);
  assert.equal(freiosComTetoDeGasto(FREIOS_PADRAO, 30, 20).tetoPorDia, 50, 'já mandou 30; cabem mais 20: teto de 50 nas 24 h');
  assert.equal(freiosComTetoDeGasto(FREIOS_PADRAO, 25, 0).tetoPorDia, 25, 'cabem 0: o teto é o que já saiu — nada mais sai');
  assert.equal(freiosComTetoDeGasto(FREIOS_PADRAO, 0, null), FREIOS_PADRAO);
  assert.equal(mensagensQueCabem(50, 50, 0.25), 0);
  assert.equal(mensagensQueCabem(50, 60, 0.25), 0, 'gasto acima do teto: zero, nunca negativo');
  assert.equal(mensagensQueCabem(50, 45, 2), 2);
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
  const { precoEmReaisDoBanco, maiorPrecoDasOndas, _esquecerPrecosDeGasto } = await import('./disparo/chatwoot/gasto.js');
  const { _definirCambio } = await import('./disparo/chatwoot/custo.js');
  _esquecerPrecosDeGasto();
  _definirCambio(5.6);
  falso('whatsappCostDaily', { findMany: async () => [{ pricingCategory: 'MARKETING_LITE', pricingType: 'REGULAR', country: 'BR', volume: 100, costUsd: '6.25' }] });
  assert.equal(await precoEmReaisDoBanco('u1', 'MARKETING'), 0.35);
  falso('whatsappCostDaily', { findMany: async () => { throw new Error('banco fora'); } });
  assert.equal(await precoEmReaisDoBanco('u1', 'MARKETING'), 0.35, 'o banco caiu: segue o último preço bom');
  _definirCambio(null);
  assert.equal(await precoEmReaisDoBanco('u1', 'MARKETING'), 0.35, 'o câmbio caiu: idem');
  assert.equal(await precoEmReaisDoBanco('u2', 'MARKETING'), 2, 'unidade que nunca teve preço: o preço de RESERVA, nunca «sem teto»');
  const preco = async (_u: string, c: string | null) => (c === 'MARKETING' ? 0.35 : c === 'UTILITY' ? 0.03 : 0.25);
  assert.equal(await maiorPrecoDasOndas(preco, 'u1', ['UTILITY', 'MARKETING', 'MARKETING']), 0.35);
  assert.equal(await maiorPrecoDasOndas(preco, 'u1', ['UTILITY', 'AUTHENTICATION']), 0.25);
  assert.equal(await maiorPrecoDasOndas(async () => { throw new Error('x'); }, 'u1', ['UTILITY']), 0.25, 'a leitura quebrou: a reserva da categoria, nunca sem teto');
});

test('preço de RESERVA: padrões conservadores por categoria (marketing R$ 2, utilidade R$ 0,25, autenticação R$ 0,25), ajustáveis por env; ilegível, zero ou negativo volta ao padrão — nunca «sem preço»', () => {
  const { precoDeReservaBrl, avisosDoPrecoDeReserva, PRECO_RESERVA_PADRAO_BRL } = custoMod;
  assert.deepEqual({ ...PRECO_RESERVA_PADRAO_BRL }, { MARKETING: 2, UTILITY: 0.25, AUTHENTICATION: 0.25 });
  assert.equal(precoDeReservaBrl('MARKETING_LITE', {}), 2);
  assert.equal(precoDeReservaBrl('marketing', {}), 2);
  assert.equal(precoDeReservaBrl('UTILITY', {}), 0.25);
  assert.equal(precoDeReservaBrl('AUTHENTICATION', {}), 0.25);
  assert.equal(precoDeReservaBrl('SERVICE', {}), 2, 'categoria fora das três: a mais cara');
  assert.equal(precoDeReservaBrl(null, {}), 2);
  const e = (marketing: string | undefined) => ({ CHATWOOT_DISPARO_PRECO_RESERVA_MARKETING: marketing }) as NodeJS.ProcessEnv;
  assert.equal(precoDeReservaBrl('MARKETING', e('0,5')), 0.5);
  assert.equal(precoDeReservaBrl('MARKETING', e('0.8')), 0.8);
  for (const lixo of ['abc', '0', '-1', 'NaN', 'Infinity', '99999', '  ']) assert.equal(precoDeReservaBrl('MARKETING', e(lixo)), 2, lixo);
  assert.deepEqual(avisosDoPrecoDeReserva({}), []);
  assert.deepEqual(avisosDoPrecoDeReserva(e('0,5')), []);
  assert.match(avisosDoPrecoDeReserva(e('abc'))[0] ?? '', /PRECO_RESERVA_MARKETING="abc" não vale: ficou R\$ 2 por mensagem/);
});

test('ritmo com preço de reserva: o teto de gasto limita mesmo sem histórico (R$ 50 ÷ R$ 2 = 25 por dia)', () => {
  const e = estimarCusto({ pessoas: 100, categoria: 'MARKETING', preco: null, cambio: 5.6, env: {} });
  const r = ritmoDaOnda({ pessoas: 100, freios: FREIOS_PADRAO, tetoReais: 50, porMensagemBrl: e.porMensagemBrl });
  assert.deepEqual([r.porDia, r.dias, r.limitadoPor], [25, 4, 'gasto']);
});

test('o último preço bom EXPIRA em 24 h: depois disso, com a leitura falhando, vale a RESERVA (nunca um preço velho para sempre)', async () => {
  const { precoEmReaisDoBanco, _esquecerPrecosDeGasto, VALIDADE_DO_ULTIMO_PRECO_MS } = await import('./disparo/chatwoot/gasto.js');
  const { _definirCambio } = await import('./disparo/chatwoot/custo.js');
  _esquecerPrecosDeGasto();
  _definirCambio(5.6);
  const t0 = Date.now();
  falso('whatsappCostDaily', { findMany: async () => [{ pricingCategory: 'MARKETING_LITE', pricingType: 'REGULAR', country: 'BR', volume: 100, costUsd: '6.25' }] });
  assert.equal(await precoEmReaisDoBanco('u1', 'MARKETING'), 0.35);
  falso('whatsappCostDaily', { findMany: async () => { throw new Error('banco fora'); } });
  const agora = mock.method(Date, 'now', () => t0 + VALIDADE_DO_ULTIMO_PRECO_MS - 60_000);
  assert.equal(await precoEmReaisDoBanco('u1', 'MARKETING'), 0.35, 'falha com 23 h: o último preço bom');
  agora.mock.mockImplementation(() => t0 + VALIDADE_DO_ULTIMO_PRECO_MS + 60_000);
  assert.equal(await precoEmReaisDoBanco('u1', 'MARKETING'), 2, 'falha depois de 24 h: a reserva');
});

test('o gasto das 24 h é a soma POR CATEGORIA (envios × preço da categoria) e a conta que sobra usa o preço da onda atual; a leitura é agrupada no banco, no número todo', async () => {
  const { orcamentoDeGasto, enviosPorCategoriaNoBanco } = await import('./disparo/chatwoot/gasto.js');
  const preco = async (_u: string, c: string | null) => (c === 'MARKETING' ? 2 : 0.25);
  const o = await orcamentoDeGasto({ unitId: 'u1', agora: new Date(), tetoReais: 50, precoAtual: 0.25, preco, ler: async () => [{ categoria: 'MARKETING', envios: 20 }, { categoria: 'UTILITY', envios: 40 }] });
  assert.equal(o.gastoBrl, 50, '20 × 2,00 + 40 × 0,25');
  assert.equal(o.cabem, 0);
  const o2 = await orcamentoDeGasto({ unitId: 'u1', agora: new Date(), tetoReais: 50, precoAtual: 0.25, preco, ler: async () => [{ categoria: 'MARKETING', envios: 10 }] });
  assert.equal(o2.cabem, 120);
  // a leitura real: agrupa por onda no banco (do número: todas as unidades que o dividem) e junta a categoria de cada onda
  const consultas: Array<Record<string, any>> = [];
  falso('unitChatwoot', { findUnique: async () => ({ kapsoPhoneNumberId: 'n1' }), findMany: async () => [{ unitId: 'u1' }, { unitId: 'u2' }] });
  falso('disparoDestinatario', { groupBy: async (a: Record<string, any>) => (consultas.push(a), [{ ondaId: 'a', _count: { _all: 20 } }, { ondaId: 'b', _count: { _all: 5 } }, { ondaId: 'c', _count: { _all: 3 } }]) });
  falso('disparoOnda', { findMany: async () => [{ id: 'a', categoriaModelo: 'MARKETING' }, { id: 'b', categoriaModelo: 'MARKETING' }, { id: 'c', categoriaModelo: null }] });
  const lido = await enviosPorCategoriaNoBanco('u1', new Date(0));
  assert.deepEqual(lido, [{ categoria: 'MARKETING', envios: 25 }, { categoria: null, envios: 3 }]);
  assert.deepEqual(consultas[0]!.where.unitId.in.sort(), ['u1', 'u2']);
  assert.equal(consultas[0]!.where.onda.origem, 'chatwoot');
});

test('a leitura do preço filtra no banco (regular, Brasil, amostra mínima, custo > 0), então o dia mais caro nunca fica de fora de um corte sem ordem', async () => {
  const { lerPrecoDaUnidade } = await import('./disparo/chatwoot/custo.js');
  const consultas: Array<Record<string, any>> = [];
  falso('whatsappCostDaily', { findMany: async (a: Record<string, any>) => (consultas.push(a), []) });
  await lerPrecoDaUnidade('u1', 'MARKETING');
  const w = consultas[0]!.where;
  assert.deepEqual(w.pricingType, { equals: 'REGULAR', mode: 'insensitive' }, 'sem diferenciar caixa, como o cálculo em JS');
  assert.deepEqual(w.OR, [{ country: { equals: 'BR', mode: 'insensitive' } }, { country: '' }]);
  assert.deepEqual(w.volume, { gte: 5 });
  assert.deepEqual(w.costUsd, { gt: 0 });
  assert.deepEqual(consultas[0]!.orderBy, { date: 'desc' });
});

test('o aviso do teto de gasto sai UMA vez por dia DA UNIDADE (a data no fuso dela, não em UTC) e só quando o que parou foi o teto de gasto, sem ler texto de `parou`', async () => {
  const { avisarSeParouPeloGasto, _esquecerAvisosDeGasto } = await import('./disparo/chatwoot/rodada.js');
  _esquecerAvisosDeGasto();
  const avisos: string[] = [];
  const avisar = async (t: string) => void avisos.push(t);
  const parou = { slug: 'x', unitId: 'u1', parou: 'teto atingido (3/h, 25/24h)', noDiaDepois: 25, tetoEfetivoDia: 25, tetoDoTierDia: 100, tetoReais: 50, gastoBrl: 50 };
  await avisarSeParouPeloGasto(parou, avisar, '2026-11-17');
  await avisarSeParouPeloGasto(parou, avisar, '2026-11-17');
  assert.equal(avisos.length, 1);
  await avisarSeParouPeloGasto(parou, avisar, '2026-11-18');
  assert.equal(avisos.length, 2, 'dia seguinte da unidade: avisa de novo');
  // parou pelo teto de MENSAGENS (o teto efetivo é o do tier) ou pela hora (ainda não chegou no teto de 24 h): não é o gasto
  await avisarSeParouPeloGasto({ ...parou, unitId: 'u2', tetoEfetivoDia: 100, noDiaDepois: 100 }, avisar, '2026-11-17');
  await avisarSeParouPeloGasto({ ...parou, unitId: 'u3', noDiaDepois: 10 }, avisar, '2026-11-17');
  await avisarSeParouPeloGasto({ ...parou, unitId: 'u4', parou: 'fora da janela de horário' }, avisar, '2026-11-17');
  assert.equal(avisos.length, 2);
  assert.match(avisos[0]!, /POR NÚMERO/);
});

test('se o avisador FALHA, o aviso do teto de gasto não conta como dado: a rodada seguinte tenta de novo', async () => {
  const { avisarSeParouPeloGasto, _esquecerAvisosDeGasto } = await import('./disparo/chatwoot/rodada.js');
  _esquecerAvisosDeGasto();
  const parou = { slug: 'x', unitId: 'u1', parou: 'teto atingido (0/h, 25/24h)', noDiaDepois: 25, tetoEfetivoDia: 25, tetoDoTierDia: 100, tetoReais: 50, gastoBrl: 50 };
  let tentativas = 0;
  await avisarSeParouPeloGasto(parou, async () => { tentativas++; throw new Error('telegram fora'); }, '2026-11-17');
  await avisarSeParouPeloGasto(parou, async () => { tentativas++; }, '2026-11-17');
  await avisarSeParouPeloGasto(parou, async () => { tentativas++; }, '2026-11-17');
  assert.equal(tentativas, 2, 'falhou, tentou de novo, saiu; depois disso, nada mais no dia');
});

test('o preço é lido no máximo uma vez a cada 5 minutos por unidade e categoria (a rodada roda toda hora)', async () => {
  const { precoEmReaisDoBanco, _esquecerPrecosDeGasto } = await import('./disparo/chatwoot/gasto.js');
  const { _definirCambio } = await import('./disparo/chatwoot/custo.js');
  _esquecerPrecosDeGasto();
  _definirCambio(5.6);
  let leituras = 0;
  falso('whatsappCostDaily', { findMany: async () => (leituras++, [{ pricingCategory: 'MARKETING_LITE', pricingType: 'REGULAR', country: 'BR', volume: 100, costUsd: '6.25' }]) });
  await precoEmReaisDoBanco('u1', 'MARKETING');
  await precoEmReaisDoBanco('u1', 'MARKETING');
  await precoEmReaisDoBanco('u1', 'UTILITY');
  assert.equal(leituras, 2, 'uma por categoria');
});

test('unidades que dividem o MESMO número: o preço da categoria é o MAIOR entre elas (uma sem histórico não baixa o teto; um preço alto não é ignorado)', async () => {
  const { precoEmReaisDoBanco, _esquecerPrecosDeGasto } = await import('./disparo/chatwoot/gasto.js');
  const { _definirCambio } = await import('./disparo/chatwoot/custo.js');
  _esquecerPrecosDeGasto();
  _definirCambio(5.6);
  falso('unitChatwoot', { findUnique: async () => ({ kapsoPhoneNumberId: 'n1' }), findMany: async () => [{ unitId: 'u1' }, { unitId: 'u2' }, { unitId: 'u3' }] });
  // u1: US$ 0,0625 (R$ 0,35); u2: US$ 0,3217 (R$ 1,80); u3: sem histórico (reserva R$ 2,00)
  falso('whatsappCostDaily', { findMany: async (a: { where: { unitId: string } }) => (a.where.unitId === 'u1' ? [{ pricingCategory: 'MARKETING_LITE', pricingType: 'REGULAR', country: 'BR', volume: 100, costUsd: '6.25' }] : a.where.unitId === 'u2' ? [{ pricingCategory: 'MARKETING_LITE', pricingType: 'REGULAR', country: 'BR', volume: 100, costUsd: '32.17' }] : []) });
  assert.equal(await precoEmReaisDoBanco('u1', 'MARKETING'), 2, 'u3 sem histórico: a reserva é o maior');
  _esquecerPrecosDeGasto();
  falso('unitChatwoot', { findUnique: async () => ({ kapsoPhoneNumberId: 'n1' }), findMany: async () => [{ unitId: 'u1' }, { unitId: 'u2' }] });
  assert.equal(await precoEmReaisDoBanco('u1', 'MARKETING'), 1.80152, 'u2 cobra R$ 1,80: u1 não usa o preço baixo só dela');
  _esquecerPrecosDeGasto();
  falso('unitChatwoot', { findUnique: async () => null });
  assert.equal(await precoEmReaisDoBanco('u1', 'MARKETING'), 0.35, 'número só dela: o preço dela');
  _esquecerPrecosDeGasto();
  falso('unitChatwoot', { findUnique: async () => { throw new Error('banco fora'); } });
  assert.equal(await precoEmReaisDoBanco('u1', 'MARKETING'), 0.35, 'não consegui ler o número: só a própria unidade');
});

test('CRM sem categoria no modelo: tratado como MARKETING de forma explícita (e logado uma vez), nunca «categoria desconhecida»', async () => {
  const { modeloDaCaixa, CATEGORIA_QUANDO_O_CRM_NAO_DIZ } = await import('./disparo/chatwoot/canal.js');
  const cru = (extra: Record<string, unknown>) => ({ name: 'parau_x', language: 'pt_BR', status: 'APPROVED', components: [{ type: 'BODY', text: 'Oi {{1}}' }], ...extra });
  assert.equal(CATEGORIA_QUANDO_O_CRM_NAO_DIZ, 'MARKETING');
  assert.equal(modeloDaCaixa(cru({}) as never)!.categoria, 'MARKETING', 'sem categoria: marketing');
  assert.equal(modeloDaCaixa(cru({ category: '  ' }) as never)!.categoria, 'MARKETING', 'categoria em branco: marketing');
  assert.equal(modeloDaCaixa(cru({ category: 'utility' }) as never)!.categoria, 'UTILITY', 'a categoria dita pelo CRM vale, em maiúsculas');
});

test('categoria ASSUMIDA (o CRM não a informou) vale como marketing para o preço, mas NÃO prova reclassificação: modelo congelado como UTILIDADE não pausa só porque o CRM omitiu o campo', async () => {
  const { modeloDaCaixa } = await import('./disparo/chatwoot/canal.js');
  const cru = { name: 'parau_x', language: 'pt_BR', status: 'APPROVED', components: [{ type: 'BODY', text: 'Oi {{1}}' }] };
  assert.equal(modeloDaCaixa(cru as never)!.categoriaAssumida, true);
  assert.equal(modeloDaCaixa({ ...cru, category: 'UTILITY' } as never)!.categoriaAssumida, false);
});

test('falha ao ler as unidades do número NÃO fica guardada 5 min como «número só dela» (baixaria o preço do teto): vale a última lista conhecida', async () => {
  const { precoEmReaisDoBanco, _esquecerPrecosDeGasto } = await import('./disparo/chatwoot/gasto.js');
  const { _definirCambio } = await import('./disparo/chatwoot/custo.js');
  _esquecerPrecosDeGasto();
  _definirCambio(5.6);
  falso('whatsappCostDaily', { findMany: async (a: { where: { unitId: string } }) => [{ pricingCategory: 'MARKETING_LITE', pricingType: 'REGULAR', country: 'BR', volume: 100, costUsd: a.where.unitId === 'u2' ? '32.17' : '6.25' }] });
  let falha = false;
  falso('unitChatwoot', { findUnique: async () => { if (falha) throw new Error('banco fora'); return { kapsoPhoneNumberId: 'n1' }; }, findMany: async () => [{ unitId: 'u1' }, { unitId: 'u2' }] });
  assert.equal(await precoEmReaisDoBanco('u1', 'MARKETING'), 1.80152);
  // 5 min depois a lista envelheceu e a leitura falha: vale a lista conhecida (u1 + u2), não «só u1»
  const t0 = Date.now();
  const agora = mock.method(Date, 'now', () => t0 + 6 * 60_000);
  falha = true;
  assert.equal(await precoEmReaisDoBanco('u1', 'MARKETING'), 1.80152, 'a falha de leitura não vira «número só dela»');
  agora.mock.restore();
});

test('categoria assumida: a estimativa segue pelo preço de marketing, mas deixa de ser «conhecida» — a tela avisa e a aprovação exige confirmação', () => {
  const e = custoMod.comCategoriaAssumida(estimarCusto({ pessoas: 50, categoria: 'MARKETING', preco: { usd: 0.0625, dias: 30 }, cambio: 5.6, env: {} }), true);
  assert.deepEqual([e.conhecido, e.categoriaAssumida, e.brl, e.porMensagemBrl], [false, true, 17.5, 0.35]);
  assert.equal(e.nota, custoMod.NOTA_CATEGORIA_ASSUMIDA);
  assert.equal(e.nota, 'categoria não informada pelo CRM: estimativa pelo preço de marketing');
  const semHistorico = custoMod.comCategoriaAssumida(estimarCusto({ pessoas: 10, categoria: 'MARKETING', preco: null, cambio: 5.6, env: {} }), true);
  assert.match(semHistorico.nota, /^categoria não informada pelo CRM: estimativa pelo preço de marketing \(e sem histórico da Meta: preço de reserva\)$/);
  const normal = estimarCusto({ pessoas: 50, categoria: 'MARKETING', preco: { usd: 0.0625, dias: 30 }, cambio: 5.6, env: {} });
  assert.equal(custoMod.comCategoriaAssumida(normal, false), normal, 'categoria informada: nada muda');
});

test('a lista de unidades do número guardada serve também à contagem do gasto: uma leitura só para preço e envios', async () => {
  const { precoEmReaisDoBanco, enviosPorCategoriaNoBanco, _esquecerPrecosDeGasto } = await import('./disparo/chatwoot/gasto.js');
  const { _definirCambio } = await import('./disparo/chatwoot/custo.js');
  _esquecerPrecosDeGasto();
  _definirCambio(5.6);
  let leituras = 0;
  falso('unitChatwoot', { findUnique: async () => (leituras++, { kapsoPhoneNumberId: 'n1' }), findMany: async () => [{ unitId: 'u1' }, { unitId: 'u2' }] });
  falso('whatsappCostDaily', { findMany: async () => [] });
  falso('disparoDestinatario', { groupBy: async () => [] });
  await precoEmReaisDoBanco('u1', 'MARKETING');
  await enviosPorCategoriaNoBanco('u1', new Date(0));
  assert.equal(leituras, 1);
});
