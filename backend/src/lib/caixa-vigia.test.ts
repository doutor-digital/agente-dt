/**
 * Vigia de caixa parada: o silêncio só vale com média que o justifique, dentro do horário comercial e com histórico; o Kapso entra como segunda fonte
 * (entrega com erro, número que não recebe) e como diagnóstico; seco não manda nem grava; um aviso por caixa a cada 3 h; texto sem dado de paciente.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const V = await import('./caixa-vigia.js');
const { prisma } = await import('./prisma.js');
const { _esquecerOBancoParaTeste, _semearParaTeste } = await import('./automacoes-estado.js');
const { automacaoPorId, verificarCatalogo } = await import('./automacoes.js');

const HORA = 3_600_000;
const UNIDADE = { name: 'Doutor Hérnia Teste', spineAgendaDays: [1, 2, 3, 4, 5], spineAgendaStart: '08:00', spineAgendaEnd: '18:00', businessHoursTimezone: 'America/Sao_Paulo' };
// segunda-feira 23/11/2026, 15:05 em São Paulo (UTC-3) — as 3 últimas horas cheias (12h, 13h, 14h) são comerciais
const AGORA = Date.UTC(2026, 10, 23, 18, 5);

/** `valor` mensagens em TODA hora comercial dos 20 dias anteriores a `AGORA`, e o que `ajusta` mandar por cima. */
function serie(valor: number, ajusta: (h: number, atual: number) => number = (_h, a) => a): Map<number, number> {
  const m = new Map<number, number>();
  for (let t = Math.floor(AGORA / HORA) * HORA - 20 * 24 * HORA; t <= Math.floor(AGORA / HORA) * HORA; t += HORA) {
    m.set(t, ajusta(t, V.horaCheiaComercial(UNIDADE, new Date(t)) ? valor : 0));
  }
  return m;
}
const ate = Math.floor(AGORA / HORA) * HORA;
const zeroNasUltimas3 = (h: number, a: number) => (h >= ate - 3 * HORA && h < ate ? 0 : a);

test('catálogo: chatwoot-vigia existe, tem seco, NASCE EM SECO em qualquer unidade (inclusive Parauapebas) e o catálogo segue válido', () => {
  const a = automacaoPorId('chatwoot-vigia');
  assert.ok(a && a.temSeco && a.quandoVazio === 'seco' && a.chave === 'CHATWOOT_VIGIA_SLUGS');
  assert.deepEqual(verificarCatalogo(), []);
  _esquecerOBancoParaTeste();
  assert.equal(V.estadoDoVigia('doutor-hernia-parauapebas'), 'seco');
  assert.equal(V.estadoDoVigia('qualquer-outra'), 'seco');
});

test('horário comercial: hora cheia inteira dentro da agenda, dia útil, sem feriado', () => {
  const brt = (d: number, h: number) => new Date(Date.UTC(2026, 10, d, h + 3));
  assert.equal(V.horaCheiaComercial(UNIDADE, brt(23, 8)), true);
  assert.equal(V.horaCheiaComercial(UNIDADE, brt(23, 17)), true, '17h–18h cabe inteira');
  assert.equal(V.horaCheiaComercial(UNIDADE, brt(23, 18)), false);
  assert.equal(V.horaCheiaComercial(UNIDADE, brt(23, 7)), false);
  assert.equal(V.horaCheiaComercial(UNIDADE, brt(22, 10)), false, 'domingo');
  assert.equal(V.horaCheiaComercial(UNIDADE, brt(20, 10)), false, '20/11 é feriado nacional');
  assert.equal(V.horaCheiaComercial({ ...UNIDADE, spineAgendaDays: [1, 2, 3, 4, 5, 6] }, brt(21, 10)), true, 'sábado, se a unidade atende');
});

test('silêncio: zero nas últimas 3 h cheias com média alta (6/h) → avisa, com observado 0 e esperado ~18', () => {
  const d = V.decidirSilencio({ serie: serie(6, zeroNasUltimas3), unidade: UNIDADE, agora: AGORA });
  assert.equal(d.veredito, 'silencio');
  assert.equal(d.observado, 0);
  assert.equal(Math.round(d.esperado), 18);
  assert.equal(d.horas, 3);
});

test('silêncio: entrou UMA mensagem na janela → ok; zero com média baixa (1/h) → pouco-esperado (não cobra)', () => {
  assert.equal(V.decidirSilencio({ serie: serie(6, (h, a) => (h === ate - HORA ? 1 : zeroNasUltimas3(h, a))), unidade: UNIDADE, agora: AGORA }).veredito, 'ok');
  assert.equal(V.decidirSilencio({ serie: serie(1, zeroNasUltimas3), unidade: UNIDADE, agora: AGORA }).veredito, 'pouco-esperado');
});

test('silêncio: a hora em curso não conta (ela ainda está enchendo) e janela que atravessa o fim do expediente não é cobrada', () => {
  // às 15:05 a hora 15h–16h está em curso: zerá-la não muda nada
  assert.equal(V.decidirSilencio({ serie: serie(6, (h, a) => (h === ate ? 0 : a)), unidade: UNIDADE, agora: AGORA }).veredito, 'ok');
  // às 19:05 as 3 últimas horas cheias (16h–19h) incluem 18h: fora do horário
  const noite = Date.UTC(2026, 10, 23, 22, 5);
  assert.equal(V.decidirSilencio({ serie: serie(6, () => 0), unidade: UNIDADE, agora: noite }).veredito, 'fora-do-horario');
  // sábado de manhã (unidade que só abre em dia útil)
  assert.equal(V.decidirSilencio({ serie: serie(6, () => 0), unidade: UNIDADE, agora: Date.UTC(2026, 10, 21, 15, 5) }).veredito, 'fora-do-horario');
});

test('silêncio: sem 5 dias comparáveis de histórico → não cobra', () => {
  const poucos = new Map<number, number>();
  for (let t = ate - 3 * 24 * HORA; t <= ate; t += HORA) poucos.set(t, V.horaCheiaComercial(UNIDADE, new Date(t)) ? 6 : 0);
  for (const h of [ate - 3 * HORA, ate - 2 * HORA, ate - HORA]) poucos.set(h, 0);
  assert.equal(V.decidirSilencio({ serie: poucos, unidade: UNIDADE, agora: AGORA }).veredito, 'sem-historico');
});

test('janela configurável: CAIXA_VIGIA_HORAS de 1 a 12, senão 3', () => {
  assert.equal(V.horasDaJanela({}), 3);
  assert.equal(V.horasDaJanela({ CAIXA_VIGIA_HORAS: '5' }), 5);
  for (const v of ['0', '13', 'abc', '']) assert.equal(V.horasDaJanela({ CAIXA_VIGIA_HORAS: v }), 3, v);
  const d = V.decidirSilencio({ serie: serie(6, (h, a) => (h >= ate - 2 * HORA && h < ate ? 0 : a)), unidade: UNIDADE, agora: AGORA, horas: 2 });
  assert.equal(d.veredito, 'silencio');
});

test('série do relatório do Chatwoot: baldes por hora viram mapa; lixo é ignorado', () => {
  const m = V.serieDosRelatorios([{ value: 3, timestamp: 1795687200 }, { value: 'x', timestamp: 1795690800 }, { value: -1, timestamp: 1 }, null as never, { value: 2, timestamp: 1795694400 }]);
  assert.deepEqual([...m], [[1795687200000, 3], [1795694400000, 2]]);
});

test('Kapso: problemas de RECEBER (conexão, inscrição, verificação, status, recebimento); a saúde de ENVIO não conta', () => {
  assert.deepEqual(V.problemasDeReceber({ checks: { phone_number_connection: { passed: true }, webhook_subscription: { passed: true }, webhook_verified: { passed: true }, messaging_health: { passed: false, overall_status: 'BLOCKED' } } }, { status: 'CONNECTED', recebimentoLigado: true }), [], 'o nome de exibição em análise (Timbó) não impede de receber');
  assert.deepEqual(V.problemasDeReceber({ checks: { webhook_subscription: { passed: false }, webhook_verified: { passed: false } } }), ['inscrição do webhook na Meta falhando', 'verificação do webhook falhando']);
  assert.deepEqual(V.problemasDeReceber(null, { status: 'DISCONNECTED', recebimentoLigado: false }), ['número DISCONNECTED', 'recebimento desligado no Kapso']);
});

function kapsoFalso(rotas: Record<string, unknown>) {
  const pedidos: Array<{ url: string; chave: string | null }> = [];
  const f = (async (url: string, init: { headers?: Record<string, string> } = {}) => {
    pedidos.push({ url, chave: init.headers?.['X-API-Key'] ?? null });
    const rota = Object.keys(rotas).find((r) => url.includes(r));
    if (!rota) return { ok: false, status: 404, json: async () => ({}) } as Response;
    const corpo = rotas[rota];
    if (corpo instanceof Error) throw corpo;
    return { ok: true, status: 200, json: async () => corpo } as Response;
  }) as unknown as typeof fetch;
  return { f, pedidos };
}

test('Kapso: entregas com erro por número (só as de depois do início, sem as entregues); a chave só vai no cabeçalho', async () => {
  const agora = Date.parse('2026-11-23T18:05:00Z');
  const k = kapsoFalso({
    '/webhook_deliveries': { data: [
      { phone_number_id: '111', created_at: '2026-11-23T17:00:00Z', delivered_at: '2026-11-23T17:00:01Z', response_status: 200 },
      { phone_number_id: '111', created_at: '2026-11-23T16:00:00Z', failed_at: '2026-11-23T16:05:00Z', response_status: 502 },
      { phone_number_id: '111', created_at: '2026-11-23T15:30:00Z', response_status: 500 },
      { phone_number_id: '222', created_at: '2026-11-23T16:10:00Z', failed_at: '2026-11-23T16:12:00Z' },
      { phone_number_id: '111', created_at: '2026-11-22T10:00:00Z', failed_at: '2026-11-22T10:05:00Z', response_status: 500 },
    ] },
  });
  const porta = V.kapsoReal('chave-secreta-do-kapso-123', k.f);
  const erros = await porta.entregasComErro(agora - 3 * HORA);
  assert.deepEqual([...erros!], [['111', 2], ['222', 1]]);
  assert.ok(k.pedidos.every((p) => p.chave === 'chave-secreta-do-kapso-123' && !p.url.includes('chave-secreta')), 'a chave só no cabeçalho');
});

test('Kapso: erro de rede não lança, vira null, e a chave não aparece no que se loga', async () => {
  const k = kapsoFalso({ '/webhook_deliveries': new Error('boom chave-secreta-do-kapso-123') });
  const porta = V.kapsoReal('chave-secreta-do-kapso-123', k.f);
  assert.equal(await porta.entregasComErro(0), null);
  assert.equal(await V.kapsoReal('chave-secreta-do-kapso-123', kapsoFalso({}).f).saude('111'), null);
});

test('Kapso: conta as mensagens de paciente recebidas na janela', async () => {
  const k = kapsoFalso({ '/messages': { data: [
    { timestamp: String(Date.parse('2026-11-23T16:00:00Z') / 1000), kapso: { direction: 'inbound' } },
    { timestamp: String(Date.parse('2026-11-23T16:30:00Z') / 1000), kapso: { direction: 'outbound' } },
    { timestamp: String(Date.parse('2026-11-23T10:00:00Z') / 1000), kapso: { direction: 'inbound' } },
  ] } });
  const n = await V.kapsoReal('chave-do-kapso-1234567', k.f).entradas('111', Date.parse('2026-11-23T15:00:00Z'), Date.parse('2026-11-23T17:55:00Z'));
  assert.equal(n, 1);
});

// ── o ciclo de uma caixa ──────────────────────────────────────────────────────────────────────────────────────

function mundo(o: { modo?: 'ligado' | 'seco' | 'desligado'; serie?: Map<number, number> | Error; numero?: string | null; saude?: string[] | null; entregas?: Map<string, number> | null; entradas?: number | null; jaAvisou?: boolean; envia?: boolean; unidade?: typeof UNIDADE | null } = {}) {
  const c = { enviados: [] as string[], marcas: [] as string[], leituras: 0, kapsoLeituras: 0, jaLogouSeco: false };
  const deps = {
    estado: () => o.modo ?? 'ligado',
    unidade: async () => (o.unidade === undefined ? UNIDADE : o.unidade),
    serie: async () => { c.leituras++; if (o.serie instanceof Error) throw o.serie; return o.serie ?? serie(6, zeroNasUltimas3); },
    numeroKapso: () => (o.numero === undefined ? '111' : o.numero),
    kapso: { numeros: async () => new Map(), saude: async () => { c.kapsoLeituras++; return o.saude === undefined ? [] : o.saude; }, entregasComErro: async () => null, entradas: async () => { c.kapsoLeituras++; return o.entradas === undefined ? 0 : o.entradas; } },
    cicloKapso: { numeros: new Map([['111', { id: '111', status: 'CONNECTED', recebimentoLigado: true }]]), entregas: o.entregas === undefined ? new Map<string, number>() : o.entregas },
    jaAvisou: async () => o.jaAvisou ?? false,
    enviar: async (_s: string, t: string) => { c.enviados.push(t); return o.envia ?? true; },
    marcar: async (_c: number, _a: number, r: string) => { c.marcas.push(r); },
    jaLogouSeco: () => { const j = c.jaLogouSeco; c.jaLogouSeco = true; return j; },
    agora: () => AGORA,
  };
  return { c, deps };
}

test('ciclo LIGADO: silêncio com o Kapso tendo recebido → avisa o diagnóstico «entrega falhando», uma marca, texto sem dado de paciente', async () => {
  const m = mundo({ entradas: 4 });
  assert.equal(await V.cicloDaCaixa(m.deps, 3, 'doutor-hernia-parauapebas'), 'avisou');
  assert.equal(m.c.enviados.length, 1);
  assert.match(m.c.enviados[0]!, /Caixa parada — Doutor Hérnia Teste \(caixa 3\)/);
  assert.match(m.c.enviados[0]!, /Zero mensagem de paciente nas últimas 3 h/);
  assert.match(m.c.enviados[0]!, /Kapso recebeu 4 no mesmo período: a entrega ao CRM está falhando/);
  assert.match(m.c.enviados[0]!, /daqui a 3 h/);
  assert.equal(m.c.marcas.length, 1);
  assert.ok(!/\d{8,}/.test(m.c.enviados[0]!), 'sem telefone nem número comprido');
});

test('ciclo: silêncio com o Kapso TAMBÉM sem receber → o diagnóstico é outro (número, Meta, campanhas)', async () => {
  const m = mundo({ entradas: 0 });
  await V.cicloDaCaixa(m.deps, 3, 'x');
  assert.match(m.c.enviados[0]!, /O Kapso também não recebeu nada/);
});

test('ciclo: erro de ENTREGA do Kapso avisa mesmo SEM silêncio; número com problema também', async () => {
  const a = mundo({ serie: serie(6), entregas: new Map([['111', 2]]) });
  assert.equal(await V.cicloDaCaixa(a.deps, 3, 'x'), 'avisou');
  assert.match(a.c.enviados[0]!, /2 mensagem\(ns\) de paciente não foram entregues ao CRM pelo Kapso/);
  const b = mundo({ serie: serie(6), saude: ['verificação do webhook falhando'] });
  assert.equal(await V.cicloDaCaixa(b.deps, 3, 'x'), 'avisou');
  assert.match(b.c.enviados[0]!, /Número do WhatsApp com problema no Kapso: verificação do webhook falhando/);
});

test('ciclo: tudo normal → ok e nenhuma mensagem; Chatwoot fora E Kapso fora → sem-leitura (não avisa nada)', async () => {
  const ok = mundo({ serie: serie(6) });
  assert.equal(await V.cicloDaCaixa(ok.deps, 3, 'x'), 'ok');
  assert.equal(ok.c.enviados.length, 0);
  const fora = mundo({ serie: new Error('Chatwoot fora'), saude: null, entregas: null });
  assert.equal(await V.cicloDaCaixa(fora.deps, 3, 'x'), 'sem-leitura');
  assert.equal(fora.c.enviados.length, 0);
});

test('ciclo: caixa SEM Kapso (Evolution) só tem o silêncio; sem número do Kapso não lê o Kapso', async () => {
  const m = mundo({ numero: null });
  assert.equal(await V.cicloDaCaixa(m.deps, 2, 'x'), 'avisou');
  assert.equal(m.c.kapsoLeituras, 0);
  assert.doesNotMatch(m.c.enviados[0]!, /Kapso/);
});

test('SECO: decide e loga, mas NÃO manda e NÃO grava marca; o mesmo problema não vira log toda varredura', async () => {
  const m = mundo({ modo: 'seco' });
  assert.equal(await V.cicloDaCaixa(m.deps, 3, 'x'), 'seco');
  assert.deepEqual([m.c.enviados, m.c.marcas], [[], []]);
  assert.equal(await V.cicloDaCaixa(m.deps, 3, 'x'), 'ja-avisou', 'trava de memória no seco');
});

test('DESLIGADO não lê nada; unidade que não existe não lê o Chatwoot', async () => {
  const d = mundo({ modo: 'desligado' });
  assert.equal(await V.cicloDaCaixa(d.deps, 3, 'x'), 'desligado');
  assert.equal(d.c.leituras + d.c.kapsoLeituras, 0);
  const s = mundo({ unidade: null });
  assert.equal(await V.cicloDaCaixa(s.deps, 3, 'x'), 'sem-unidade');
  assert.equal(s.c.leituras, 0);
});

test('UM aviso por caixa a cada 3 h: já avisou → não manda; o envio que não saiu NÃO anota (tenta na próxima varredura)', async () => {
  const ja = mundo({ jaAvisou: true });
  assert.equal(await V.cicloDaCaixa(ja.deps, 3, 'x'), 'ja-avisou');
  assert.equal(ja.c.enviados.length, 0);
  const falha = mundo({ envia: false });
  assert.equal(await V.cicloDaCaixa(falha.deps, 3, 'x'), 'nao-saiu');
  assert.equal(falha.c.marcas.length, 0);
});

// ── o aviso (Evolution) e a marca no banco ────────────────────────────────────────────────────────────────────

const ENV_EVO = { EVOLUTION_ALERT_URL: 'https://evo.test/message/sendText/x', EVOLUTION_ALERT_HEADER: 'apikey', EVOLUTION_ALERT_VALUE: 'segredo-evolution', ALERTA_WHATSAPP_NUMERO: '5594999990000' } as NodeJS.ProcessEnv;

test('envio: o João sempre; o grupo da unidade só se CAIXA_VIGIA_DESTINOS tem o slug; sem configuração da Evolution não manda', async () => {
  const salvo = { ...process.env };
  Object.assign(process.env, ENV_EVO);
  try {
    const chamadas: Array<{ numero: string; texto: string }> = [];
    const enviar = (async (a: { numero: string; texto: string }) => { chamadas.push({ numero: a.numero, texto: a.texto }); return 'ok'; }) as never;
    assert.equal(await V.enviarOAviso('doutor-hernia-x', 'texto', { ...ENV_EVO }, enviar), true);
    assert.deepEqual(chamadas.map((c) => c.numero), ['5594999990000'], 'sem grupo: só o João');
    chamadas.length = 0;
    const env = { ...ENV_EVO, CAIXA_VIGIA_DESTINOS: '{"doutor-hernia-x":"1203630000@g.us"}', CAIXA_VIGIA_EVOLUTION_URL: 'https://evo.test/message/sendText/grupos' } as NodeJS.ProcessEnv;
    assert.equal(await V.enviarOAviso('doutor-hernia-x', 'texto', env, enviar), true);
    assert.deepEqual(chamadas.map((c) => c.numero), ['5594999990000', '1203630000@g.us']);
    chamadas.length = 0;
    assert.equal(await V.enviarOAviso('outra-unidade', 'texto', env, enviar), true);
    assert.deepEqual(chamadas.map((c) => c.numero), ['5594999990000'], 'unidade sem grupo cadastrado');
    for (const k of Object.keys(ENV_EVO)) delete process.env[k];
    assert.equal(await V.enviarOAviso('doutor-hernia-x', 'texto', {}, enviar), false, 'sem Evolution do João: nada sai');
    const recusa = (async () => 'recusado') as never;
    Object.assign(process.env, ENV_EVO);
    assert.equal(await V.enviarOAviso('doutor-hernia-x', 'texto', { ...ENV_EVO }, recusa), false);
  } finally {
    for (const k of Object.keys(ENV_EVO)) { if (salvo[k] === undefined) delete process.env[k]; else process.env[k] = salvo[k]; }
  }
});

test('CAIXA_VIGIA_DESTINOS inválido não derruba: só o João recebe', () => {
  assert.equal(V.destinoDoGrupo('x', '{nao-json'), null);
  assert.equal(V.destinoDoGrupo('x', undefined), null);
  assert.equal(V.destinoDoGrupo('x', "'{\"x\":\"123@g.us\"}'"), '123@g.us');
});

const originais: Array<() => void> = [];
function trocarDelegate(nome: string, falso: Record<string, unknown>): void {
  const antes = (prisma as any)[nome];
  Object.defineProperty(prisma, nome, { value: falso, configurable: true, writable: true });
  originais.push(() => Object.defineProperty(prisma, nome, { value: antes, configurable: true, writable: true }));
}
beforeEach(() => { _esquecerOBancoParaTeste(); V.esquecerOSeco(); trocarDelegate('systemLog', { create: async () => ({}) }); trocarDelegate('unitAutomacao', { findMany: async () => [] }); });
afterEach(() => { while (originais.length) originais.pop()!(); _esquecerOBancoParaTeste(); });

test('marca no banco: «já avisou» olha as últimas 3 h da caixa; marcar escreve a regra vigia-caixa (e só o ligado chega aqui)', async () => {
  const criadas: Array<{ data: Record<string, unknown> }> = [];
  let achou = false;
  let filtro: any = null;
  trocarDelegate('chatwootReguaDisparo', { findFirst: async (a: any) => { filtro = a; return achou ? { id: 1 } : null; }, create: async (a: any) => { criadas.push(a); return {}; } });
  const reais = V.depsReais({ conta: null } as never, null);
  assert.equal(await reais.jaAvisou(3, AGORA), false);
  assert.equal(filtro.where.caixa, 3);
  assert.equal(filtro.where.regra, 'vigia-caixa');
  assert.equal(filtro.where.criadoEm.gte.getTime(), AGORA - 3 * HORA);
  achou = true;
  assert.equal(await reais.jaAvisou(3, AGORA), true);
  await reais.marcar(3, AGORA, 'resumo');
  assert.equal(criadas.length, 1);
  assert.deepEqual({ ...criadas[0]!.data, chave: 'x' }, { caixa: 3, conversationId: 0, regra: 'vigia-caixa', chave: 'x', modo: 'ligado', texto: 'resumo' });
});

test('banco fora ao perguntar «já avisou»: assume que NÃO avisou (melhor repetir um aviso que ficar calado)', async () => {
  trocarDelegate('chatwootReguaDisparo', { findFirst: async () => { throw new Error('banco fora'); } });
  assert.equal(await V.depsReais({ conta: null } as never, null).jaAvisou(3, AGORA), false);
});

test('série do Chatwoot: pede o relatório por hora DA CAIXA, só leitura (GET) com o token da conta, e lança se a resposta não presta', async () => {
  const pedidos: Array<{ url: string; metodo?: string; token?: string }> = [];
  const f = (async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
    pedidos.push({ url, metodo: init.method, token: init.headers?.api_access_token });
    return { ok: true, status: 200, json: async () => [{ value: 2, timestamp: 1795687200 }] } as Response;
  }) as unknown as typeof fetch;
  const ctx = { conta: { url: 'https://crm.test', conta: 7, token: 'tk-conta-7' }, fetch: f } as never;
  const s = await V.serieDaCaixa(ctx, 3, AGORA, 'America/Sao_Paulo');
  assert.equal(s.get(1795687200000), 2);
  assert.match(pedidos[0]!.url, /^https:\/\/crm\.test\/api\/v2\/accounts\/7\/reports\?metric=incoming_messages_count&type=inbox&id=3&since=\d+&until=\d+&group_by=hour&timezone_offset=-3$/);
  assert.equal(pedidos[0]!.metodo, undefined, 'GET');
  assert.equal(pedidos[0]!.token, 'tk-conta-7');
  const ruim = { conta: { url: 'https://crm.test', conta: 7, token: 't' }, fetch: (async () => ({ ok: false, status: 401, json: async () => ({}) })) as never } as never;
  await assert.rejects(() => V.serieDaCaixa(ruim, 3, AGORA, 'America/Sao_Paulo'), /401/);
});
