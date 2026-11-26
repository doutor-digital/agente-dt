/**
 * Vigia de caixa parada: o silêncio só vale com média que o justifique, dentro do horário comercial e com histórico; o Kapso entra como segunda fonte
 * (entrega com erro, número que não recebe) e como diagnóstico; seco não manda nem grava; um aviso por caixa a cada 3 h; texto sem dado de paciente.
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
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
// Parauapebas como está no banco (26/11/2026): seg–sáb, 08:00–18:30, almoço 12–13; o sábado muda (07:00–13:00, sem almoço)
const PARAUAPEBAS = { name: 'Doutor Hérnia Parauapebas', spineEnabled: true, spineAgendaDays: [1, 2, 3, 4, 5, 6], spineAgendaStart: '08:00', spineAgendaEnd: '18:30', spineLunchStart: '12:00', spineLunchEnd: '13:00', spineDayHours: { '6': { start: '07:00', end: '13:00', lunchStart: null, lunchEnd: null } }, businessHoursTimezone: 'America/Sao_Paulo' };
// só abre no sábado de manhã (08–12) — unidade de teste
const SO_SABADO = { name: 'Só sábado', spineEnabled: true, spineAgendaDays: [6], spineAgendaStart: '08:00', spineAgendaEnd: '12:00', spineLunchStart: null, spineLunchEnd: null, businessHoursTimezone: 'America/Sao_Paulo' };

/** `valor` mensagens em TODA hora comercial dos 50 dias (7 semanas) anteriores a `AGORA`, e o que `ajusta` mandar por cima. */
function serie(valor: number, ajusta: (h: number, atual: number) => number = (_h, a) => a, unidade: Parameters<typeof V.horaCheiaComercial>[0] = UNIDADE): Map<number, number> {
  const m = new Map<number, number>();
  for (let t = Math.floor(AGORA / HORA) * HORA - 50 * 24 * HORA; t <= Math.floor(AGORA / HORA) * HORA; t += HORA) {
    m.set(t, ajusta(t, V.horaCheiaComercial(unidade, new Date(t)) ? valor : 0));
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

test('horário comercial: a janela de CADA dia da semana (spineDayHours), sem feriado, almoço INCLUÍDO (a média do mesmo dia/hora já traz o dip) — a mesma fonte de retorno-da-equipe e agenda-tools', () => {
  const brt = (d: number, h: number) => new Date(Date.UTC(2026, 10, d, h + 3));
  assert.equal(V.horaCheiaComercial(UNIDADE, brt(23, 8)), true);
  assert.equal(V.horaCheiaComercial(UNIDADE, brt(23, 17)), true, '17h–18h cabe inteira');
  assert.equal(V.horaCheiaComercial(UNIDADE, brt(23, 18)), false);
  assert.equal(V.horaCheiaComercial(UNIDADE, brt(23, 7)), false);
  assert.equal(V.horaCheiaComercial(UNIDADE, brt(22, 10)), false, 'domingo');
  assert.equal(V.horaCheiaComercial(UNIDADE, brt(20, 10)), false, '20/11 é feriado nacional');
  // Parauapebas de verdade (produção, 26/11): seg–sáb, semana 08:00–18:30 com almoço 12–13, sábado 07:00–13:00 SEM almoço
  assert.equal(V.horaCheiaComercial(PARAUAPEBAS, brt(23, 12)), true, 'almoço da segunda: expectativa menor pela média, não hora desligada (sem ponto cego das 13h às 16h)');
  assert.equal(V.horaCheiaComercial(PARAUAPEBAS, brt(23, 18)), false, '18h–19h passa das 18h30');
  assert.equal(V.horaCheiaComercial(PARAUAPEBAS, brt(21, 7)), true, 'sábado abre às 7h');
  assert.equal(V.horaCheiaComercial(PARAUAPEBAS, brt(21, 12)), true, 'sábado não tem almoço (lunchStart: null)');
  assert.equal(V.horaCheiaComercial(PARAUAPEBAS, brt(21, 13)), false, 'sábado fecha às 13h: a tarde NÃO é de atendimento');
  assert.equal(V.horaCheiaComercial(PARAUAPEBAS, brt(21, 15)), false);
  assert.equal(V.horaCheiaComercial({ ...PARAUAPEBAS, spineEnabled: false }, brt(23, 10)), false, 'agenda desligada: o horário no banco é o padrão que ninguém conferiu');
  assert.equal(V.janelaDoDia(PARAUAPEBAS, 0), null);
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

test('silêncio: sem 3 semanas comparáveis do MESMO dia da semana → não cobra (mesmo com muito histórico de outros dias)', () => {
  const poucos = new Map<number, number>();
  for (let t = ate - 15 * 24 * HORA; t <= ate; t += HORA) poucos.set(t, V.horaCheiaComercial(UNIDADE, new Date(t)) ? 6 : 0); // 2 semanas: só 2 segundas anteriores
  for (const h of [ate - 3 * HORA, ate - 2 * HORA, ate - HORA]) poucos.set(h, 0);
  assert.equal(V.decidirSilencio({ serie: poucos, unidade: UNIDADE, agora: AGORA }).veredito, 'sem-historico');
});

test('SÁBADO compara com SÁBADOS, nunca com a média dos dias úteis: sábado calmo (1/h) com semana movimentada (10/h) NÃO dá alarme; sábado normal parado dá', () => {
  const sab = Date.UTC(2026, 10, 21, 13, 5); // sábado 21/11, 10:05 em Parauapebas — janela 7h–10h
  const sabAte = Math.floor(sab / HORA) * HORA;
  const dow = (h: number) => new Date(h - 3 * HORA).getUTCDay();
  const comoSabadoCalmo = (h: number) => (dow(h) === 6 ? 1 : 10);
  const calmo = serie(10, (h, a) => (a === 0 ? 0 : comoSabadoCalmo(h)), PARAUAPEBAS);
  for (const h of [sabAte - 3 * HORA, sabAte - 2 * HORA, sabAte - HORA]) calmo.set(h, 0);
  const d1 = V.decidirSilencio({ serie: calmo, unidade: PARAUAPEBAS, agora: sab });
  assert.equal(d1.veredito, 'pouco-esperado', `sábado costuma ter ~1/h (esperado ${d1.esperado}): zero não é alarme`);
  assert.ok(d1.esperado < 4, 'a média usada é a dos sábados, não a dos 10/h da semana');
  const movimentado = serie(10, (h, a) => (a === 0 ? 0 : dow(h) === 6 ? 8 : 2), PARAUAPEBAS);
  for (const h of [sabAte - 3 * HORA, sabAte - 2 * HORA, sabAte - HORA]) movimentado.set(h, 0);
  assert.equal(V.decidirSilencio({ serie: movimentado, unidade: PARAUAPEBAS, agora: sab }).veredito, 'silencio', 'sábado que costuma ter 8/h e ficou zero: avisa');
});

test('unidade que SÓ abre no sábado de manhã: sábado à tarde (e qualquer dia de semana) nunca dá alarme de silêncio', () => {
  const sabTarde = Date.UTC(2026, 10, 21, 18, 5); // sábado 15:05
  assert.equal(V.decidirSilencio({ serie: serie(10, () => 0, SO_SABADO), unidade: SO_SABADO, agora: sabTarde }).veredito, 'fora-do-horario');
  assert.equal(V.decidirSilencio({ serie: serie(10, () => 0, SO_SABADO), unidade: SO_SABADO, agora: AGORA }).veredito, 'fora-do-horario', 'segunda');
  // e de manhã, parado de verdade com histórico de sábados movimentados: avisa
  const sabManha = Date.UTC(2026, 10, 21, 15, 5); // 12:05 — janela 9h–12h
  const base = serie(10, undefined, SO_SABADO);
  for (const h of [9, 10, 11]) base.set(Date.UTC(2026, 10, 21, h + 3), 0);
  assert.equal(V.decidirSilencio({ serie: base, unidade: SO_SABADO, agora: sabManha }).veredito, 'silencio');
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

/** Kapso de mentira no formato DOCUMENTADO (docs.kapso.ai): `limit`/`after` na query, `data` + `paging.{cursors.after,next}` na resposta. Array = uma resposta por página (cursor «cN» = página N). */
function kapsoFalso(rotas: Record<string, unknown>) {
  const pedidos: Array<{ url: string; chave: string | null }> = [];
  const f = (async (url: string, init: { headers?: Record<string, string> } = {}) => {
    pedidos.push({ url, chave: init.headers?.['X-API-Key'] ?? null });
    const rota = Object.keys(rotas).find((r) => url.includes(r));
    if (!rota) return { ok: false, status: 404, json: async () => ({}) } as Response;
    let corpo = rotas[rota];
    if (Array.isArray(corpo)) {
      const depois = /[?&]after=(c\d+)/.exec(url)?.[1];
      corpo = corpo[depois ? Number(depois.slice(1)) : 0] ?? { data: [], paging: { cursors: {}, next: null, previous: null } };
    }
    if (corpo instanceof Error) throw corpo;
    return { ok: true, status: 200, json: async () => corpo } as Response;
  }) as unknown as typeof fetch;
  return { f, pedidos };
}
/** o `paging` documentado: há próxima página → `cursors.after` = `next` = «c<n>»; última → `next: null`. */
const pag = (proxima: number | null) => ({ paging: proxima === null ? { cursors: {}, next: null, previous: null } : { cursors: { after: `c${proxima}` }, next: `c${proxima}`, previous: null } });

test('Kapso: entregas — pede SÓ `status=failed` de `meta.messages` com `limit` e cursor (como a doc), conta por número, sem as de fora da janela; a chave só no cabeçalho', async () => {
  const agora = Date.parse('2026-11-23T18:05:00Z');
  const k = kapsoFalso({
    '/webhook_deliveries': { data: [
      { event: 'meta.messages', status: 'failed', phone_number_id: '111', created_at: '2026-11-23T16:00:00Z', failed_at: '2026-11-23T16:05:00Z', response_status: 502, attempt_count: 5 },
      { event: 'meta.messages', status: 'failed', phone_number_id: '111', created_at: '2026-11-23T15:30:00Z', response_status: 500 },
      { event: 'meta.messages', status: 'failed', phone_number_id: '222', created_at: '2026-11-23T16:10:00Z' },
      { event: 'meta.messages', status: 'failed', phone_number_id: '111', created_at: '2026-11-22T10:00:00Z' },
    ], ...pag(null) },
  });
  const erros = await V.kapsoReal('chave-secreta-do-kapso-123', k.f).entregasComErro(agora - 3 * HORA);
  assert.deepEqual([...erros!].map(([k, v]) => [k, v.length]), [['111', 2], ['222', 1]]);
  assert.match(k.pedidos[0]!.url, /\/webhook_deliveries\?status=failed&event=meta\.messages&period=7d&limit=100$/);
  assert.ok(k.pedidos.every((p) => p.chave === 'chave-secreta-do-kapso-123' && !p.url.includes('chave-secreta')), 'a chave só no cabeçalho');
});

test('Kapso: entrega ainda SENDO TENTADA de novo (`pending`, com tentativas e resposta 5xx) ou já entregue NÃO conta — só `status === "failed"`', async () => {
  const agora = Date.parse('2026-11-23T18:05:00Z');
  const k = kapsoFalso({ '/webhook_deliveries': { data: [
    { event: 'meta.messages', status: 'pending', phone_number_id: '111', created_at: '2026-11-23T17:00:00Z', response_status: 503, attempt_count: 2, failed_at: null },
    { event: 'meta.messages', status: 'pending', phone_number_id: '111', created_at: '2026-11-23T17:10:00Z', response_status: 500, failed_at: '2026-11-23T17:11:00Z' },
    { event: 'meta.messages', status: 'delivered', phone_number_id: '111', created_at: '2026-11-23T17:20:00Z', delivered_at: '2026-11-23T17:20:01Z', response_status: 200 },
    { event: 'meta.smb_message_echoes', status: 'failed', phone_number_id: '111', created_at: '2026-11-23T17:30:00Z' },
  ], ...pag(null) } });
  const erros = await V.kapsoReal('chave-do-kapso-1234567', k.f).entregasComErro(agora - 3 * HORA);
  assert.deepEqual([...erros!], [], 'nenhuma falhou de vez');
});

test('Kapso: entregas — segue o CURSOR documentado (`paging.cursors.after`, enquanto `paging.next`) até acabar; no máximo 5 páginas', async () => {
  const agora = Date.parse('2026-11-23T18:05:00Z');
  const falha = (min: number) => ({ event: 'meta.messages', status: 'failed', phone_number_id: '111', created_at: new Date(agora - min * 60_000).toISOString() });
  const k = kapsoFalso({ '/webhook_deliveries': [
    { data: [falha(5), falha(10)], ...pag(1) },
    { data: [falha(20)], ...pag(2) },
    { data: [falha(30)], ...pag(null) },
  ] });
  const erros = await V.kapsoReal('chave-do-kapso-1234567', k.f).entregasComErro(agora - 3 * HORA);
  assert.deepEqual([...erros!].map(([k, v]) => [k, v.length]), [['111', 4]]);
  assert.equal(k.pedidos.length, 3);
  assert.ok(k.pedidos[1]!.url.endsWith('&after=c1') && k.pedidos[2]!.url.endsWith('&after=c2'), 'o cursor de cada página vem do `paging` da anterior');
  const sempre = kapsoFalso({ '/webhook_deliveries': Array.from({ length: 9 }, (_, i) => ({ data: [falha(5)], ...pag(i + 1) })) });
  await V.kapsoReal('chave-do-kapso-1234567', sempre.f).entregasComErro(agora - 3 * HORA);
  assert.equal(sempre.pedidos.length, 5, 'teto de 5 páginas');
});

test('Kapso: o próximo cursor só existe com `paging.next` preenchido', () => {
  assert.equal(V.proximaPagina({ paging: { cursors: { after: 'abc' }, next: 'abc', previous: null } }), 'abc');
  assert.equal(V.proximaPagina({ paging: { cursors: { after: 'abc' }, next: null } }), null, 'última página: o `after` sobra mas `next` é null');
  assert.equal(V.proximaPagina({ paging: { cursors: {}, next: null } }), null);
  assert.equal(V.proximaPagina({ data: [] }), null);
  assert.equal(V.proximaPagina(null), null);
});

test('Kapso: erro de rede não lança, vira null, e a chave não aparece no que se loga', async () => {
  const k = kapsoFalso({ '/webhook_deliveries': new Error('boom chave-secreta-do-kapso-123') });
  const porta = V.kapsoReal('chave-secreta-do-kapso-123', k.f);
  assert.equal(await porta.entregasComErro(0), null);
  assert.equal(await V.kapsoReal('chave-secreta-do-kapso-123', kapsoFalso({}).f).saude('111'), null);
});

test('Kapso: conta as mensagens de paciente recebidas na janela (`direction=inbound`, `limit=100`)', async () => {
  const k = kapsoFalso({ '/messages': { data: [
    { timestamp: String(Date.parse('2026-11-23T16:00:00Z') / 1000), kapso: { direction: 'inbound' } },
    { timestamp: String(Date.parse('2026-11-23T16:30:00Z') / 1000), kapso: { direction: 'outbound' } },
    { timestamp: String(Date.parse('2026-11-23T10:00:00Z') / 1000), kapso: { direction: 'inbound' } },
  ], ...pag(null) } });
  const n = await V.kapsoReal('chave-do-kapso-1234567', k.f).entradas('111', Date.parse('2026-11-23T15:00:00Z'), Date.parse('2026-11-23T17:55:00Z'));
  assert.equal(n, 1);
  assert.match(k.pedidos[0]!.url, /\/whatsapp\/messages\?phone_number_id=111&direction=inbound&limit=100$/);
});

// ── o ciclo de uma caixa ──────────────────────────────────────────────────────────────────────────────────────

function mundo(o: { modo?: 'ligado' | 'seco' | 'desligado'; serie?: Map<number, number> | Error; numero?: string | null; saude?: string[] | null; entregas?: Map<string, number[]> | null; entradas?: number | null; jaAvisou?: boolean; ultimoAviso?: number | null; ignorada?: boolean; envia?: boolean; unidade?: typeof UNIDADE | null } = {}) {
  const c = { enviados: [] as string[], marcas: [] as string[], leituras: 0, kapsoLeituras: 0, jaLogouSeco: false, semAgenda: 0 };
  const deps = {
    estado: () => o.modo ?? 'ligado',
    unidade: async () => (o.unidade === undefined ? UNIDADE : o.unidade),
    serie: async () => { c.leituras++; if (o.serie instanceof Error) throw o.serie; return o.serie ?? serie(6, zeroNasUltimas3); },
    numeroKapso: () => (o.numero === undefined ? '111' : o.numero),
    kapso: { numeros: async () => new Map(), saude: async () => { c.kapsoLeituras++; return o.saude === undefined ? [] : o.saude; }, entregasComErro: async () => null, entradas: async () => { c.kapsoLeituras++; return o.entradas === undefined ? 0 : o.entradas; } },
    cicloKapso: { numeros: new Map([['111', { id: '111', status: 'CONNECTED', recebimentoLigado: true }]]), entregas: o.entregas === undefined ? new Map<string, number[]>() : o.entregas },
    jaAvisou: async () => o.jaAvisou ?? false,
    ultimoAviso: async (_c: number): Promise<number | null> => o.ultimoAviso ?? null,
    semAgenda: async (_c: number, _s: string, _m: string): Promise<void> => { c.semAgenda++; },
    enviar: async (_s: string, t: string) => { c.enviados.push(t); return o.envia ?? true; },
    marcar: async (_c: number, _a: number, r: string) => { c.marcas.push(r); },
    secoRecente: () => c.jaLogouSeco,
    anotarSeco: () => { c.jaLogouSeco = true; },
    ignorada: (_c: number, _s: string) => o.ignorada ?? false,
    cegueira: async (_c: number, _f: 'chatwoot' | 'kapso', _cega: boolean): Promise<void> => undefined,
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
  const a = mundo({ serie: serie(6), entregas: new Map([['111', [AGORA - HORA, AGORA - 2 * HORA]]]) });
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

test('Kapso: entradas — segue o cursor até o começo da janela; se estoura as páginas antes de chegar lá, devolve null (não diagnostica «0»)', async () => {
  const ini = Date.parse('2026-11-23T15:00:00Z');
  const msg = (iso: string) => ({ timestamp: String(Date.parse(iso) / 1000), kapso: { direction: 'inbound' } });
  const cheia = Array.from({ length: 100 }, () => msg('2026-11-23T17:50:00Z'));
  const ok = kapsoFalso({ '/messages': [{ data: cheia, ...pag(1) }, { data: [msg('2026-11-23T16:00:00Z'), msg('2026-11-23T10:00:00Z')], ...pag(2) }, { data: [msg('2026-11-23T16:00:00Z')], ...pag(null) }] });
  assert.equal(await V.kapsoReal('chave-do-kapso-1234567', ok.f).entradas('111', ini, Date.parse('2026-11-23T17:55:00Z')), 101, 'conta a 1ª página inteira e a 2ª; parou ao passar do começo da janela');
  assert.equal(ok.pedidos.length, 2);
  const longe = kapsoFalso({ '/messages': Array.from({ length: 9 }, (_, i) => ({ data: cheia, ...pag(i + 1) })) });
  assert.equal(await V.kapsoReal('chave-do-kapso-1234567', longe.f).entradas('111', ini, Date.parse('2026-11-23T17:55:00Z')), null, 'mais de 5 páginas sem chegar ao começo: sem diagnóstico');
});

test('Kapso: a lista de números é indexada pelo phone_number_id da Meta (o mesmo que a unidade guarda)', async () => {
  const k = kapsoFalso({ '/phone_numbers': { data: [{ id: '1212928641906230', phone_number_id: '1212928641906230', status: 'CONNECTED', inbound_processing_enabled: true }, { id: 'uuid-qualquer', phone_number_id: '555', status: 'DISCONNECTED', inbound_processing_enabled: false }] } });
  const m = await V.kapsoReal('chave-do-kapso-1234567', k.f).numeros();
  assert.deepEqual([...m.keys()], ['1212928641906230', '555']);
  assert.equal(m.get('555')!.status, 'DISCONNECTED');
});

test('ignorados: a unidade CANCELADA (Timbó) já vem na lista, sem configurar nada; CAIXA_VIGIA_IGNORAR soma ids de caixa e slugs; lixo é ignorado', async () => {
  const padrao = V.ignoradas({});
  assert.deepEqual([...padrao.unidades], ['doutor-hernia-timbo']);
  assert.equal(padrao.caixas.size, 0);
  const i = V.ignoradas({ CAIXA_VIGIA_IGNORAR: '2, 7;x,9 doutor-hernia-aposentada,  -3' });
  assert.deepEqual([...i.caixas].sort(), [2, 7, 9], 'vírgula, espaço e ponto-e-vírgula separam');
  assert.deepEqual([...i.unidades].sort(), ['doutor-hernia-aposentada', 'doutor-hernia-timbo'], '«x» (curto) e «-3» não são caixa nem slug: ignorados');
  const reais = V.depsReais({ conta: null } as never, null, {});
  assert.equal(reais.ignorada(9, 'doutor-hernia-timbo'), true, 'Timbó: ignorada de fábrica');
  assert.equal(reais.ignorada(3, 'doutor-hernia-parauapebas'), false);
  const m = mundo({ ignorada: true });
  assert.equal(await V.cicloDaCaixa(m.deps, 9, 'doutor-hernia-timbo'), 'desligado');
  assert.equal(m.c.leituras + m.c.kapsoLeituras, 0);
});

test('JÁ AVISOU nas últimas 3 h: nem o Chatwoot nem o Kapso são lidos (a leitura seria jogada fora)', async () => {
  const m = mundo({ jaAvisou: true });
  assert.equal(await V.cicloDaCaixa(m.deps, 3, 'x'), 'ja-avisou');
  assert.equal(m.c.leituras + m.c.kapsoLeituras, 0);
});

test('memória do processo é a segunda trava: com o banco FALHANDO, depois de um aviso não avisa de novo antes de 3 h', async () => {
  trocarDelegate('chatwootReguaDisparo', { findFirst: async () => { throw new Error('banco fora'); }, create: async () => { throw new Error('banco fora'); } });
  const reais = V.depsReais({ conta: null } as never, null);
  assert.equal(await reais.jaAvisou(3, AGORA), false, 'nunca avisou: avisa');
  await reais.marcar(3, AGORA, 'x');
  assert.equal(await reais.jaAvisou(3, AGORA + HORA), true, '1 h depois: ainda dentro das 3 h');
  assert.equal(await reais.jaAvisou(3, AGORA + 3 * HORA + 1), false, 'passadas as 3 h: pode avisar');
});

test('vigia CEGO por FONTE: 8 varreduras seguidas sem ler o relatório do Chatwoot → UM aviso (só no ligado), mesmo com o Kapso respondendo; as fontes não se misturam; voltar a ler zera', async () => {
  const { logger } = await import('./logger.js');
  const erros = mock.method(logger, 'error', () => undefined);
  const reais = V.depsReais({ conta: null } as never, null);
  _semearParaTeste([{ slug: 'doutor-hernia-parauapebas', automacao: 'chatwoot-vigia', estado: 'ligado' }]);
  const salvo = { ...process.env };
  for (const k of ['EVOLUTION_ALERT_URL', 'EVOLUTION_ALERT_HEADER', 'EVOLUTION_ALERT_VALUE', 'ALERTA_WHATSAPP_NUMERO']) delete process.env[k];
  try {
    for (let i = 1; i < V.VARREDURAS_CEGAS; i++) { await reais.cegueira(3, 'chatwoot', true); await reais.cegueira(3, 'kapso', false); }
    assert.equal(erros.mock.calls.length, 0, 'ainda não completou');
    await reais.cegueira(3, 'chatwoot', true);
    assert.equal(erros.mock.calls.length, 1, 'completou 8 seguidas no Chatwoot, com o Kapso lendo bem');
    assert.match(String(erros.mock.calls[0]!.arguments[1]), /CEGO.*Chatwoot/);
    for (let i = 0; i < 5; i++) await reais.cegueira(3, 'chatwoot', true);
    assert.equal(erros.mock.calls.length, 1, 'só UM aviso por cegueira');
    await reais.cegueira(3, 'chatwoot', false); // voltou a ler
    for (let i = 1; i < V.VARREDURAS_CEGAS; i++) await reais.cegueira(3, 'chatwoot', true);
    assert.equal(erros.mock.calls.length, 1, 'a contagem recomeçou do zero');
    for (let i = 1; i <= V.VARREDURAS_CEGAS; i++) await reais.cegueira(3, 'kapso', true);
    assert.equal(erros.mock.calls.length, 2, 'o Kapso cego é outra fonte, com a sua própria contagem');
    assert.match(String(erros.mock.calls[1]!.arguments[1]), /CEGO.*Kapso/);
    // no SECO a cegueira só loga (nunca manda): estado seco não chama o João — o log de erro continua saindo
  } finally {
    Object.assign(process.env, salvo);
    erros.mock.restore();
  }
});

test('o ciclo: o Chatwoot que FALHA SEMPRE é contado como cego MESMO com o Kapso lendo bem (antes o Kapso escondia a falha); Kapso lendo não vira «ok»', async () => {
  const m = mundo({ serie: new Error('relatório 401'), saude: [], entregas: new Map() });
  const chamadas: Array<[string, boolean]> = [];
  m.deps.cegueira = async (_c, f, cega) => { chamadas.push([f, cega]); };
  const r = await V.cicloDaCaixa(m.deps, 3, 'x');
  assert.deepEqual(chamadas.sort(), [['chatwoot', true], ['kapso', false]], 'Chatwoot cego, Kapso enxergando — cada fonte com a sua saúde');
  assert.equal(r, 'ok', 'sem problema algum a reportar');
  assert.equal(m.c.enviados.length, 0);
});

test('o ciclo: o Chatwoot respondendo e o Kapso fora → o SILÊNCIO continua sendo detectado e só o Kapso conta como cego', async () => {
  const m = mundo({ saude: null, entregas: null, entradas: null });
  const chamadas: Array<[string, boolean]> = [];
  (m.deps as any).cegueira = async (_c: number, f: string, cega: boolean) => { chamadas.push([f, cega]); };
  assert.equal(await V.cicloDaCaixa(m.deps as never, 3, 'x'), 'avisou', 'silêncio detectado');
  assert.deepEqual(chamadas.sort(), [['chatwoot', false], ['kapso', true]]);
  assert.doesNotMatch(m.c.enviados[0]!, /O Kapso (também )?não recebeu|recebeu \d/, 'sem leitura do Kapso o aviso não inventa diagnóstico');
});

test('Kapso de madrugada NÃO acorda ninguém: problema do número / entrega só vira aviso no horário de atendimento da unidade (e é «ok» fora dele)', async () => {
  const mundoAs = (utc: number) => {
    const m = mundo({ serie: serie(6), saude: ['verificação do webhook falhando'], entregas: new Map([['111', [Date.UTC(2026, 10, 23, 22, 0), Date.UTC(2026, 10, 24, 1, 0), Date.UTC(2026, 10, 24, 5, 0)]]]) });
    (m.deps as any).agora = () => utc;
    return m;
  };
  const noite = mundoAs(Date.UTC(2026, 10, 24, 2, 0)); // 23:00 em Parauapebas
  assert.equal(await V.cicloDaCaixa(noite.deps as never, 3, 'x'), 'ok');
  assert.equal(noite.c.enviados.length, 0);
  const dia = mundoAs(Date.UTC(2026, 10, 24, 13, 0)); // 10:00 de terça
  assert.equal(await V.cicloDaCaixa(dia.deps as never, 3, 'x'), 'avisou');
  assert.match(dia.c.enviados[0]!, /Número do WhatsApp com problema/);
  assert.equal(V.emHorarioDeAtendimento(PARAUAPEBAS, Date.UTC(2026, 10, 21, 17, 0)), false, 'sábado 14:00: já fechou (13h)');
  assert.equal(V.emHorarioDeAtendimento(PARAUAPEBAS, Date.UTC(2026, 10, 21, 15, 0)), true, 'sábado 12:00');
});

// ── revisão 2 do sênior: Kapso desde o último FECHAMENTO, agenda desligada que avisa, almoço sem ponto cego ─────────────

test('ultimoFechamento: ao abrir de manhã é o fim do expediente de ontem; no sábado à tarde, o fechamento das 13h; depois do fim de semana, o de sábado', () => {
  const brt = (d: number, h: number, m = 0) => Date.UTC(2026, 10, d, h + 3, m);
  const dentro = (t: number, de: number, ate: number) => t >= de && t <= ate;
  // terça 24/11 08:05 — a clínica fechou segunda 18:30
  assert.ok(dentro(V.ultimoFechamento(PARAUAPEBAS, brt(24, 8, 5)), brt(23, 18, 25), brt(23, 18, 50)));
  // terça 24/11 14:00 (aberta): o fechamento de ontem, não o de hoje
  assert.ok(dentro(V.ultimoFechamento(PARAUAPEBAS, brt(24, 14)), brt(23, 18, 25), brt(23, 18, 50)));
  // sábado 21/11 14:00 (já fechou às 13h): o de sábado 13h
  assert.ok(dentro(V.ultimoFechamento(PARAUAPEBAS, brt(21, 14)), brt(21, 12, 55), brt(21, 13, 20)));
  // segunda 23/11 08:05 (depois do domingo): o de sábado 13h
  assert.ok(dentro(V.ultimoFechamento(PARAUAPEBAS, brt(23, 8, 5)), brt(21, 12, 55), brt(21, 13, 20)));
});

test('entrega que falhou às 23h → o aviso sai NA ABERTURA da clínica (às 8h05), com a contagem desde o último fechamento; antes da abertura não acorda ninguém', async () => {
  const falhas = [Date.UTC(2026, 10, 24, 2, 0)]; // terça 23/11... 23:00 BRT de segunda
  const mundoAs = (utc: number, extra: Parameters<typeof mundo>[0] = {}) => {
    const m = mundo({ serie: serie(6), entregas: new Map([['111', falhas]]), unidade: PARAUAPEBAS as never, ...extra });
    (m.deps as any).agora = () => utc;
    return m;
  };
  const antes = mundoAs(Date.UTC(2026, 10, 24, 10, 30)); // 07:30 de terça: ainda fechada
  assert.equal(await V.cicloDaCaixa(antes.deps as never, 3, 'x'), 'ok');
  assert.equal(antes.c.enviados.length, 0);
  const abriu = mundoAs(Date.UTC(2026, 10, 24, 11, 5)); // 08:05 de terça: a janela de 3 h do silêncio NÃO veria 23h, o Kapso vê
  assert.equal(await V.cicloDaCaixa(abriu.deps as never, 3, 'x'), 'avisou');
  assert.match(abriu.c.enviados[0]!, /1 mensagem\(ns\) de paciente não foram entregues ao CRM pelo Kapso \(desde o último fechamento da clínica\)/);
});

test('depois de avisar, a falha antiga NÃO volta a ser contada: o Kapso conta a partir do ÚLTIMO AVISO quando ele é mais novo que o fechamento', async () => {
  const falha = Date.UTC(2026, 10, 23, 10, 0); // segunda 07:00 BRT, antes de abrir (hoje é segunda 15:05: AGORA)
  const rodar = async (ultimoAviso: number | null) => {
    const m = mundo({ serie: serie(6, undefined, PARAUAPEBAS), entregas: new Map([['111', [falha]]]), unidade: PARAUAPEBAS as never, ultimoAviso });
    return { r: await V.cicloDaCaixa(m.deps as never, 3, 'x'), m };
  };
  assert.equal((await rodar(null)).r, 'avisou', 'sem aviso anterior: a falha da madrugada conta');
  const depois = await rodar(Date.UTC(2026, 10, 23, 11, 30)); // avisado segunda 08:30, 3 h+ atrás
  assert.equal(depois.r, 'ok');
  assert.equal(depois.m.c.enviados.length, 0);
});

test('falha ENTRE o último aviso (17h) e o fechamento (18h30) NÃO se perde: na manhã seguinte conta desde o último aviso, não desde o fechamento', async () => {
  const falhaAntesDeFechar = Date.UTC(2026, 10, 23, 21, 0); // segunda 18:00 BRT
  const m = mundo({ serie: serie(6, undefined, PARAUAPEBAS), entregas: new Map([['111', [falhaAntesDeFechar]]]), unidade: PARAUAPEBAS as never, ultimoAviso: Date.UTC(2026, 10, 23, 20, 0) }); // aviso segunda 17:00
  (m.deps as any).agora = () => Date.UTC(2026, 10, 24, 11, 5); // terça 08:05
  assert.equal(await V.cicloDaCaixa(m.deps as never, 3, 'x'), 'avisou');
  assert.match(m.c.enviados[0]!, /1 mensagem\(ns\) de paciente não foram entregues ao CRM pelo Kapso \(desde o último aviso\)/);
});

test('o catálogo descreve a média como ela é: 6 semanas do mesmo dia da semana (não «2 semanas»)', () => {
  const a = automacaoPorId('chatwoot-vigia')!;
  assert.match(a.oQueFaz, /6 semanas.*MESMO dia da semana/);
  assert.doesNotMatch(a.oQueFaz, /2 semanas/);
});

test('agenda DESLIGADA (spineEnabled=false): o vigia não avalia, devolve «sem-agenda» e AVISA que não avalia (uma vez por dia) — nunca fica mudo', async () => {
  const m = mundo({ unidade: { ...UNIDADE, spineEnabled: false } as never });
  assert.equal(await V.cicloDaCaixa(m.deps as never, 3, 'x'), 'sem-agenda');
  assert.equal(m.c.semAgenda, 1);
  assert.equal(m.c.leituras + m.c.kapsoLeituras + m.c.enviados.length, 0);
});

test('semAgenda real: loga «caixa N sem agenda: vigia não avalia silêncio» UMA vez por dia (de 24 h); só o ligado manda ao João', async () => {
  const { logger } = await import('./logger.js');
  const w = mock.method(logger, 'warn', () => undefined);
  const reais = V.depsReais({ conta: null } as never, null);
  const salvo = { ...process.env };
  for (const k of ['EVOLUTION_ALERT_URL', 'EVOLUTION_ALERT_HEADER', 'EVOLUTION_ALERT_VALUE', 'ALERTA_WHATSAPP_NUMERO']) delete process.env[k];
  try {
    await reais.semAgenda(3, 'doutor-hernia-parauapebas', 'seco');
    await reais.semAgenda(3, 'doutor-hernia-parauapebas', 'seco');
    const sem = w.mock.calls.filter((c) => String(c.arguments[1]).includes('sem agenda: vigia não avalia silêncio'));
    assert.equal(sem.length, 1, 'uma vez por dia, não por varredura');
    await reais.semAgenda(4, 'outra', 'ligado'); // outra caixa: o seu próprio aviso (sem Evolution configurada: só log, não lança)
    assert.equal(w.mock.calls.filter((c) => String(c.arguments[1]).includes('sem agenda: vigia não avalia silêncio')).length, 2);
  } finally {
    Object.assign(process.env, salvo);
    w.mock.restore();
  }
});

test('ALMOÇO não abre ponto cego: às 14h05 (janela 11h–14h, com o almoço 12–13) o silêncio É avaliado, e com a média do almoço menor a expectativa cai (não zera)', () => {
  const t = Date.UTC(2026, 10, 25, 17, 5); // quarta 14:05 BRT
  const tAte = Math.floor(t / HORA) * HORA;
  const dow = (h: number) => new Date(h - 3 * HORA).getUTCHours();
  const comAlmoco = serie(10, (h, a) => (a === 0 ? 0 : dow(h) === 12 ? 1 : a), PARAUAPEBAS);
  for (const h of [tAte - 3 * HORA, tAte - 2 * HORA, tAte - HORA]) comAlmoco.set(h, 0);
  const d = V.decidirSilencio({ serie: comAlmoco, unidade: PARAUAPEBAS, agora: t });
  assert.notEqual(d.veredito, 'fora-do-horario', 'antes: 12h–13h fora do horário = ninguém olhava de 13h às 16h');
  assert.equal(d.veredito, 'silencio');
  assert.equal(Math.round(d.esperado), 21, 'esperado = 10 (11h) + 1 (almoço) + 10 (13h)... a hora do almoço pesa pouco');
});
