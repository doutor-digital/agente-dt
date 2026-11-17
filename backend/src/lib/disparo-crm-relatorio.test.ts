/**
 * Relatório do disparo pelo CRM: as definições (enviadas, entregues, lidas, responderam em 72 h, pediram para sair, falharam), a varredura que
 * grava as marcas (entregue/lida/respondeu) e a rota por campanha.
 */
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://x:y@127.0.0.1:1/z';
process.env.SESSION_JWT_SECRET ??= 'segredo-de-teste-com-mais-de-32-caracteres-ok';

import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from './prisma.js';
import { criarContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { enviosPorHora, JANELA_DA_RESPOSTA_MS, numerosDoRelatorio, percentual, taxasDoRelatorio, type LinhaDoRelatorio } from './disparo/chatwoot/relatorio.js';
import { varrerRespostasDoCrm } from './disparo/chatwoot/rodada.js';

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
});

const AGORA = new Date(Date.UTC(2026, 9, 21, 15, 0)); // 12h em São Paulo
const h = (n: number) => new Date(AGORA.getTime() - n * 3_600_000);
const linha = (o: Partial<LinhaDoRelatorio> = {}): LinhaDoRelatorio => ({ estado: 'enviado', wamid: 'cw:1', enviadoEm: h(10), simuladoEm: null, entregueEm: null, lidaEm: null, respondeuEm: null, ...o });

test('números: cada marca é contada pela sua definição, e SAIR não conta como «respondeu»', () => {
  const n = numerosDoRelatorio([
    linha({ wamid: 'cw:1' }), // enviada, nada mais
    linha({ wamid: 'cw:2', entregueEm: h(9) }), // entregue
    linha({ wamid: 'cw:3', entregueEm: h(9), lidaEm: h(8) }), // lida
    linha({ wamid: 'cw:4', lidaEm: h(8) }), // lida implica entregue, mesmo sem a marca de entregue
    linha({ wamid: 'cw:5', entregueEm: h(9), lidaEm: h(8), respondeuEm: h(7) }), // respondeu
    linha({ wamid: 'cw:6', estado: 'saiu', entregueEm: h(9), respondeuEm: h(7) }), // pediu SAIR: não é «responderam»
    linha({ wamid: 'cw:7', estado: 'falhou' }), // o CRM aceitou, a entrega falhou
    linha({ wamid: null, estado: 'falhou', enviadoEm: null }), // o CRM recusou
    linha({ wamid: null, estado: 'falhou', respondeuEm: h(7) }), // INCERTA (tentou, sem id): à parte; a resposta dela não infla «responderam»
    linha({ wamid: null, estado: 'pendente', enviadoEm: null }),
    linha({ wamid: null, estado: 'descartado', enviadoEm: null }),
    linha({ wamid: null, estado: 'saiu', enviadoEm: null }), // pediu SAIR ANTES do envio: barrada, não conta como «pediu SAIR depois de receber»
    linha({ wamid: null, estado: 'pendente', enviadoEm: null, simuladoEm: h(1) }), // seco
  ]);
  assert.deepEqual(n, { selecionadas: 13, enviadas: 7, tentadas: 8, entregues: 5, lidas: 3, responderam: 1, pediramSair: 1, falharam: 2, incertas: 1, naFila: 2, descartadas: 2, receberiam: 1 });
});

test('resposta só vale até 72 h depois do envio (e nunca antes dele)', () => {
  const enviadoEm = h(100);
  const n = numerosDoRelatorio([
    linha({ enviadoEm, respondeuEm: new Date(enviadoEm.getTime() + JANELA_DA_RESPOSTA_MS) }), // no limite: vale
    linha({ enviadoEm, respondeuEm: new Date(enviadoEm.getTime() + JANELA_DA_RESPOSTA_MS + 1) }), // 1 ms depois: não
    linha({ enviadoEm, respondeuEm: new Date(enviadoEm.getTime() - 1) }), // antes do envio: não
  ]);
  assert.equal(n.responderam, 1);
});

test('taxas: sobre as ENVIADAS; sem enviadas não há percentual (null, não 0); a falha é sobre enviadas + falhas', () => {
  assert.equal(percentual(1, 3), 33);
  assert.equal(percentual(0, 0), null);
  const t = taxasDoRelatorio({ selecionadas: 10, enviadas: 8, tentadas: 10, entregues: 6, lidas: 4, responderam: 2, pediramSair: 1, falharam: 2, incertas: 0, naFila: 0, descartadas: 0, receberiam: 0 });
  assert.deepEqual(t, { entregues: 75, lidas: 50, responderam: 25, pediramSair: 13, falharam: 20 });
  assert.deepEqual(taxasDoRelatorio(numerosDoRelatorio([])), { entregues: null, lidas: null, responderam: null, pediramSair: null, falharam: null });
});

test('taxa de falha: quem falhou DEPOIS de o CRM aceitar já está em «enviadas» — a base conta cada pessoa uma vez (10 aceitas, 4 delas falharam = 40%, não 29%)', () => {
  const linhas = [
    ...Array.from({ length: 6 }, (_, i) => linha({ wamid: `cw:${i + 1}` })),
    ...Array.from({ length: 4 }, (_, i) => linha({ wamid: `cw:${i + 10}`, estado: 'falhou' })),
  ];
  const n = numerosDoRelatorio(linhas);
  assert.deepEqual([n.enviadas, n.tentadas, n.falharam], [10, 10, 4]);
  assert.equal(taxasDoRelatorio(n).falharam, 40);
  // a recusada pelo CRM (sem id) soma na base uma vez
  const com = numerosDoRelatorio([...linhas, linha({ wamid: null, estado: 'falhou', enviadoEm: null })]);
  assert.deepEqual([com.enviadas, com.tentadas, com.falharam], [10, 11, 5]);
  assert.equal(taxasDoRelatorio(com).falharam, 45);
});

test('envios por hora: só o que o CRM aceitou, no fuso da unidade, em ordem', () => {
  const r = enviosPorHora(
    [
      { wamid: 'cw:1', enviadoEm: new Date(Date.UTC(2026, 9, 21, 12, 5)) }, // 09h em SP
      { wamid: 'cw:2', enviadoEm: new Date(Date.UTC(2026, 9, 21, 12, 40)) },
      { wamid: 'cw:3', enviadoEm: new Date(Date.UTC(2026, 9, 21, 13, 1)) }, // 10h
      { wamid: null, enviadoEm: new Date(Date.UTC(2026, 9, 21, 13, 2)) }, // recusada: não conta
    ],
    'America/Sao_Paulo',
  );
  assert.deepEqual(r, [{ hora: '2026-10-21 09', enviadas: 2 }, { hora: '2026-10-21 10', enviadas: 1 }]);
});

// ── a varredura grava as marcas ─────────────────────────────────────────────────────────────────────────────────

const msg = (id: number, tipo: number, o: Record<string, unknown> = {}) => ({ id, tipo, privada: false, conteudo: '', criadaEm: h(9), status: null, erro: null, ...o });

test('varredura: grava entregue/lida/respondeu uma vez (a hora é a da varredura, a da resposta é a da mensagem); não regrava o que já tem; resposta fora das 72 h não vale', async () => {
  const dest = (id: string, conversa: number, o: Record<string, unknown> = {}) => ({ id, estado: 'enviado', wamid: `cw:${9000 + conversa}`, conversaChatwoot: conversa, enviadoEm: h(10), entregueEm: null, lidaEm: null, respondeuEm: null, onda: { contaChatwoot: 1, unit: { slug: 'u' } }, ...o });
  const atualizacoes: Array<{ id: string; data: Record<string, unknown> }> = [];
  falso('disparoDestinatario', {
    findMany: async () => [
      dest('a', 1), // lida + respondeu
      dest('b', 2), // só entregue
      dest('c', 3, { entregueEm: h(9), lidaEm: h(9), respondeuEm: h(8), decididoEm: h(9) }), // já tem tudo: nada a gravar
      dest('d', 4, { enviadoEm: h(200) }), // resposta 100 h depois: fora da janela
      dest('e', 5, { estado: 'saiu' }), // pediu SAIR: as marcas ainda são gravadas
    ],
    updateMany: async (a: { where: { id: string }; data: Record<string, unknown> }) => (atualizacoes.push({ id: a.where.id, data: a.data }), { count: 1 }),
  });
  const porConversa: Record<number, unknown[]> = {
    1: [msg(9001, 1, { status: 'read' }), msg(1, 0, { conteudo: 'quero marcar', criadaEm: h(5) }), msg(2, 0, { conteudo: 'e o preço?', criadaEm: h(4) })],
    2: [msg(9002, 1, { status: 'delivered' })],
    3: [msg(9003, 1, { status: 'read' }), msg(3, 0, { conteudo: 'oi', criadaEm: h(3) })],
    4: [msg(9004, 1, { status: 'sent' }), msg(4, 0, { conteudo: 'oi', criadaEm: h(1) })],
    5: [msg(9005, 1, { status: 'delivered' }), msg(5, 0, { conteudo: 'sair', criadaEm: h(2) })],
  };
  const r = await varrerRespostasDoCrm({ ctx: () => criarContextoChatwoot({ url: 'https://x.test', conta: 1, token: 't' }), mensagens: (async (_c: unknown, conversa: number) => porConversa[conversa] ?? []) as never, agora: () => AGORA.getTime() });
  const por = Object.fromEntries(atualizacoes.map((a) => [a.id, a.data]));
  assert.deepEqual(Object.keys(por['a']!).sort(), ['decididoEm', 'entregueEm', 'lidaEm', 'respondeuEm']);
  assert.deepEqual(por['a']!.respondeuEm, h(5), 'a primeira resposta, com a hora da MENSAGEM');
  assert.deepEqual(por['a']!.lidaEm, AGORA, 'a hora da varredura');
  assert.deepEqual(Object.keys(por['b']!).sort(), ['decididoEm', 'entregueEm']);
  assert.equal(por['c'], undefined, 'quem já tem as marcas não é regravado');
  assert.equal(por['d'], undefined, 'resposta 100 h depois do envio não vale');
  assert.deepEqual(Object.keys(por['e']!).sort(), ['decididoEm', 'entregueEm', 'respondeuEm'], 'quem já saiu ainda ganha as marcas');
  assert.equal(r.saiu, 0, 'e não é contado de novo como SAIR');
});

test('varredura: a resposta é da ÚLTIMA mensagem nossa antes dela — o disparo mais novo na mesma conversa não herda a resposta ao mais velho, e o mais velho não leva a resposta ao novo', async () => {
  const dest = (id: string, wamid: string, enviadoEm: Date) => ({ id, estado: 'enviado', wamid, conversaChatwoot: 7, enviadoEm, entregueEm: h(1), lidaEm: h(1), respondeuEm: null, onda: { contaChatwoot: 1, unit: { slug: 'u' } } });
  const atualizacoes: Array<{ id: string; data: Record<string, unknown> }> = [];
  falso('disparoDestinatario', {
    findMany: async () => [dest('velho', 'cw:9001', h(30)), dest('novo', 'cw:9002', h(10))],
    updateMany: async (a: { where: { id: string }; data: Record<string, unknown> }) => (atualizacoes.push({ id: a.where.id, data: a.data }), { count: 1 }),
  });
  const conversa = [msg(9001, 1, { status: 'read', criadaEm: h(30) }), msg(1, 0, { conteudo: 'quero marcar', criadaEm: h(20) }), msg(9002, 1, { status: 'read', criadaEm: h(10) }), msg(2, 0, { conteudo: 'e o preço?', criadaEm: h(5) })];
  await varrerRespostasDoCrm({ ctx: () => criarContextoChatwoot({ url: 'https://x.test', conta: 1, token: 't' }), mensagens: (async () => conversa) as never, agora: () => AGORA.getTime() });
  const por = Object.fromEntries(atualizacoes.map((a) => [a.id, a.data.respondeuEm]));
  assert.deepEqual(por['velho'], h(20), 'a resposta de 20 h atrás (antes do novo disparo) é do velho');
  assert.deepEqual(por['novo'], h(5), 'a de 5 h atrás é do novo');
});

test('varredura: quem pode MUDAR de estado vem antes de quem já saiu; quem já saiu e já tem as marcas nem é lido', async () => {
  const dest = (id: string, conversa: number, o: Record<string, unknown> = {}) => ({ id, estado: 'enviado', wamid: `cw:${9000 + conversa}`, conversaChatwoot: conversa, enviadoEm: h(10), entregueEm: null, lidaEm: null, respondeuEm: null, onda: { contaChatwoot: 1, unit: { slug: 'u' } }, ...o });
  falso('disparoDestinatario', {
    findMany: async () => [dest('s1', 1, { estado: 'saiu' }), dest('s2', 2, { estado: 'saiu', entregueEm: h(9), respondeuEm: h(8) }), dest('e1', 3)],
    updateMany: async () => ({ count: 1 }),
  });
  const lidas: number[] = [];
  const r = await varrerRespostasDoCrm({ ctx: () => criarContextoChatwoot({ url: 'https://x.test', conta: 1, token: 't' }), mensagens: (async (_c: unknown, n: number) => (lidas.push(n), [])) as never, agora: () => AGORA.getTime() });
  assert.deepEqual(lidas, [3, 1], 'o «enviado» primeiro; o «saiu» completo (conversa 2) nem foi lido');
  assert.equal(r.conferidos, 2);
});

test('varredura: pediu SAIR depois do envio continua virando «saiu» no mesmo passo em que ganha as marcas', async () => {
  const atualizacoes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  falso('disparoDestinatario', {
    findMany: async () => [{ id: 'a', estado: 'enviado', wamid: 'cw:9001', conversaChatwoot: 1, enviadoEm: h(10), entregueEm: null, lidaEm: null, respondeuEm: null, onda: { contaChatwoot: 1, unit: { slug: 'u' } } }],
    updateMany: async (a: (typeof atualizacoes)[number]) => (atualizacoes.push(a), { count: 1 }),
  });
  const r = await varrerRespostasDoCrm({
    ctx: () => criarContextoChatwoot({ url: 'https://x.test', conta: 1, token: 't' }),
    mensagens: (async () => [msg(9001, 1, { status: 'delivered' }), msg(1, 0, { conteudo: 'SAIR', criadaEm: h(2) })]) as never,
    agora: () => AGORA.getTime(),
  });
  assert.equal(r.saiu, 1);
  assert.ok(atualizacoes.some((a) => a.data.estado === 'saiu'));
  assert.ok(atualizacoes.some((a) => 'entregueEm' in a.data));
});

// ── o mesmo cálculo, no banco ───────────────────────────────────────────────────────────────────────────────────

test('SQL × função pura: as MESMAS 17 linhas dão os mesmos números (o SQL de `relatorio-banco.ts` foi rodado no Postgres de produção, só leitura, sobre VALUES com estas linhas; 17 selecionadas|enviadas|tentadas|entregues|lidas|responderam|pediram_sair|falharam|incertas|na_fila|descartadas|receberiam = 17|10|11|5|3|2|1|2|2|2|2|1)', async () => {
  const { numerosDaLinha, SQL_DOS_NUMEROS } = await import('./disparo/chatwoot/relatorio-banco.js');
  const agoraSql = new Date(); // o SQL usou now(): as horas são relativas, como aqui
  const hh = (n: number) => new Date(agoraSql.getTime() - n * 3_600_000);
  const l = (estado: string, wamid: string | null, env: number | null, sim: number | null, ent: number | null, lid: number | null, resp: number | null): LinhaDoRelatorio => ({
    estado, wamid, enviadoEm: env === null ? null : hh(env), simuladoEm: sim === null ? null : hh(sim), entregueEm: ent === null ? null : hh(ent), lidaEm: lid === null ? null : hh(lid), respondeuEm: resp === null ? null : hh(resp),
  });
  const linhas = [
    l('enviado', 'cw:1', 10, null, null, null, null), l('enviado', 'cw:2', 10, null, 9, null, null), l('enviado', 'cw:3', 10, null, 9, 8, null), l('enviado', 'cw:4', 10, null, null, 8, null),
    l('enviado', 'cw:5', 10, null, 9, 8, 7), l('saiu', 'cw:6', 10, null, 9, null, 7), l('falhou', 'cw:7', 10, null, null, null, null), l('falhou', null, null, null, null, null, null),
    l('pendente', null, null, null, null, null, null), l('descartado', null, null, null, null, null, null), l('saiu', null, null, null, null, null, null), l('pendente', null, null, 1, null, null, null),
    l('enviado', 'cw:8', 100, null, null, null, 28), // 72 h exatas: vale
    l('enviado', 'cw:9', 100, null, null, null, 27), // 73 h: não
    l('enviado', 'cw:10', 100, null, null, null, 101), // antes do envio: não
    l('falhou', null, 10, null, null, null, 7), // incerta que respondeu: nem «falharam» nem «responderam»
    l('saiu', null, 10, null, null, null, 6), // era incerta e pediu SAIR: INCERTA (não divide por «enviadas»)
  ];
  // o que o Postgres devolveu para estas linhas
  const doPostgres = numerosDaLinha({ onda_id: 'o', selecionadas: 17, enviadas: 10, tentadas: 11, entregues: 5, lidas: 3, responderam: 2, pediram_sair: 1, falharam: 2, incertas: 2, na_fila: 2, descartadas: 2, receberiam: 1 });
  assert.deepEqual(numerosDoRelatorio(linhas), doPostgres);
  assert.match(SQL_DOS_NUMEROS, /FILTER/);
});

test('relatório no banco: uma consulta agrupada por onda; onda sem destinatários vem zerada; sem ondas nem consulta', async () => {
  const { lerNumerosDosDisparos } = await import('./disparo/chatwoot/relatorio-banco.js');
  const consultas: string[] = [];
  falso('$queryRaw', (async (q: { sql?: string }) => (consultas.push(q.sql ?? ''), [{ onda_id: 'a', selecionadas: 2, enviadas: 2, tentadas: 2, entregues: 1, lidas: 0, responderam: 0, pediram_sair: 0, falharam: 0, incertas: 0, na_fila: 0, descartadas: 0, receberiam: 0 }])) as never);
  assert.equal((await lerNumerosDosDisparos([])).size, 0);
  assert.equal(consultas.length, 0);
  const m = await lerNumerosDosDisparos(['a', 'b']);
  assert.equal(consultas.length, 1);
  assert.equal(m.get('a')!.enviadas, 2);
  assert.equal(m.get('b')!.selecionadas, 0, 'sem linha: zerada');
});

test('varredura: entregue/lida e falha DECIDEM o envio (`decididoEm`) para o freio de falhas; envio ainda «sent» não decide', async () => {
  const dest = (id: string, conversa: number) => ({ id, estado: 'enviado', wamid: `cw:${9000 + conversa}`, conversaChatwoot: conversa, enviadoEm: h(10), entregueEm: null, lidaEm: null, respondeuEm: null, decididoEm: null, onda: { unitId: 'u1', contaChatwoot: 1, unit: { slug: 'u' } } });
  const atualizacoes: Array<{ id: string; data: Record<string, unknown> }> = [];
  falso('disparoDestinatario', {
    findMany: async () => [dest('ok', 1), dest('falha', 2), dest('pendente', 3)],
    updateMany: async (a: { where: { id: string }; data: Record<string, unknown> }) => (atualizacoes.push({ id: a.where.id, data: a.data }), { count: 1 }),
  });
  const porConversa: Record<number, unknown[]> = { 1: [msg(9001, 1, { status: 'delivered' })], 2: [msg(9002, 1, { status: 'failed', erro: 'x' })], 3: [msg(9003, 1, { status: 'sent' })] };
  await varrerRespostasDoCrm({ ctx: () => criarContextoChatwoot({ url: 'https://x.test', conta: 1, token: 't' }), mensagens: (async (_c: unknown, c: number) => porConversa[c]) as never, agora: () => AGORA.getTime() });
  const por = (id: string) => atualizacoes.filter((a) => a.id === id).map((a) => a.data);
  assert.ok(por('ok').some((d) => d.decididoEm instanceof Date), 'entregue = sucesso decidido');
  assert.ok(por('falha').some((d) => d.estado === 'falhou' && d.decididoEm instanceof Date), 'falha da Meta = decidida');
  assert.deepEqual(por('pendente'), [], '«sent» ainda não decide nada');
});

test('SAIR de quem estava INCERTO não entra em «pediram SAIR» (dividiria por enviadas e passaria de 100%); a base da taxa de falha não leva incertas', () => {
  const n = numerosDoRelatorio([linha({ wamid: 'cw:1' }), linha({ wamid: null, estado: 'saiu' }), linha({ wamid: null, estado: 'saiu' }), linha({ wamid: null, estado: 'falhou' })]);
  assert.deepEqual([n.enviadas, n.pediramSair, n.incertas, n.falharam, n.tentadas], [1, 0, 3, 0, 1]);
  const t = taxasDoRelatorio(n);
  assert.equal(t.pediramSair, 0);
  assert.ok((t.pediramSair ?? 0) <= 100);
  assert.equal(t.falharam, 0, 'incertas fora do denominador');
});
