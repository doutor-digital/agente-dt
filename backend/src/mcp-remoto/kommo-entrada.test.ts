import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { KommoApiError, createKommoClientSemFreio, type ConversaNaEntrada } from '../services/kommo.service.js';
import { criarContextoKommo, kommoEntrada, kommoLeads, registrarFerramentasKommo, type FonteKommo, type UnidadeKommo } from './kommo.js';
import { fonteFalsa, leadFalso, unidadeKommo } from './kommo-falso.js';

const t = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const conversa = (n: number, iso: string, extra: Partial<ConversaNaEntrada> = {}): ConversaNaEntrada => ({
  uid: `u${n}`,
  leadId: 1000 + n,
  contatoId: 2000 + n,
  pipelineId: 1,
  categoria: 'chats',
  criadoEm: t(iso),
  nome: `Cliente ${n}`,
  telefone: `55119${String(90000000 + n)}`,
  origem: 'WhatsApp Business',
  canal: 'waba',
  ...extra,
});

const CONVERSAS = [
  conversa(1, '2026-08-10T15:00:00Z'),
  conversa(2, '2026-09-05T15:00:00Z', { canal: 'whatsapp', origem: 'Instagram' }),
  // 22h30 de SP no dia 30/09 = 01h30 UTC de 01/10: é de setembro
  conversa(3, '2026-10-01T01:30:00Z'),
  conversa(4, '2026-10-01T12:00:00Z', { nome: null, telefone: null, origem: null, canal: null, pipelineId: 99 }),
  conversa(5, '2026-10-20T12:00:00Z'),
];

/** Fonte com a caixa de entrada: devolve do mais novo ao mais velho, como o Kommo, e guarda os pedidos. */
function comEntrada(todas: ConversaNaEntrada[], pedidos: Array<[number, number, number]> = [], subdominio = 'magalhaesadv2025'): FonteKommo {
  return {
    ...fonteFalsa([]),
    subdominio,
    async entrada(de, ate, maxPaginas) {
      pedidos.push([de, ate, maxPaginas]);
      return { itens: todas.filter((c) => c.criadoEm >= de && c.criadoEm <= ate).sort((a, b) => b.criadoEm - a.criadoEm), truncado: false };
    },
  };
}

const ctxCom = (fonte: FonteKommo, slug = 'magalhaes-advocacia') => criarContextoKommo(new Map([[slug, unidadeKommo(slug, fonte)]]));

test('kommo_entrada: período no fuso da unidade, mais novo primeiro, com nome, telefone, funil e link do cartão', async () => {
  const pedidos: Array<[number, number, number]> = [];
  const r = (await kommoEntrada(ctxCom(comEntrada(CONVERSAS, pedidos)), { unidade: 'magalhaes', inicio: '2026-09-01', fim: '2026-09-30' })) as Record<string, any>;
  const s = r.porUnidade['magalhaes-advocacia'];
  assert.equal(s.ok, true);
  assert.equal(s.total, 2); // a das 22h30 do dia 30 entra; a de 01/10 meio-dia não
  assert.deepEqual(s.itens.map((i: any) => i.leadId), [1003, 1002]);
  assert.deepEqual(s.itens[0], {
    leadId: 1003,
    contatoId: 2003,
    nome: 'Cliente 3',
    telefone: '5511990000003',
    canal: 'waba',
    origem: 'WhatsApp Business',
    recebidoEm: '2026-09-30T22:30:00',
    funil: 'Comercial',
    link: 'https://magalhaesadv2025.kommo.com/leads/detail/1003',
  });
  assert.equal(new Date(pedidos[0]![0] * 1000).toISOString(), '2026-09-01T03:00:00.000Z');
  assert.equal(pedidos[0]![2], 4);
  assert.match(r.aviso, /NÃO aceitas/);
  assert.match(r.aviso, /kommo_leads/);
});

test('kommo_entrada: agrupa por dia, mes, origem, canal e funil; campo ausente vira "(sem …)", funil desconhecido sai pelo id', async () => {
  const ctx = ctxCom(comEntrada(CONVERSAS));
  const g = async (agruparPor: string) =>
    ((await kommoEntrada(ctx, { unidade: 'magalhaes', inicio: '2026-08-01', fim: '2026-10-31', agruparPor })) as Record<string, any>).porUnidade['magalhaes-advocacia'].agrupado;
  assert.deepEqual(await g('mes'), { '2026-08': 1, '2026-09': 2, '2026-10': 2 });
  assert.deepEqual(Object.keys(await g('dia')), ['2026-08-10', '2026-09-05', '2026-09-30', '2026-10-01', '2026-10-20']);
  assert.deepEqual(await g('origem'), { 'WhatsApp Business': 3, Instagram: 1, '(sem origem)': 1 });
  assert.deepEqual(await g('canal'), { waba: 3, '(sem canal)': 1, whatsapp: 1 });
  assert.deepEqual(await g('funil'), { Comercial: 4, '99': 1 });
  await assert.rejects(g('etapa'), ErroDeEntrada);
});

test('kommo_entrada: maxItens, pular e itensOmitidos; várias unidades devolvem só totais; rede soma e a que falha fica fora, com o erro', async () => {
  const quebrada: FonteKommo = { ...comEntrada([]), entrada: async () => { throw new Error('401 do Kommo'); } };
  const ctx = criarContextoKommo(
    new Map([
      ['magalhaes-advocacia', unidadeKommo('magalhaes-advocacia', comEntrada(CONVERSAS))],
      ['doutor-hernia-canaa', unidadeKommo('doutor-hernia-canaa', quebrada)],
    ]),
  );
  const um = (await kommoEntrada(ctx, { unidade: 'magalhaes', inicio: '2026-08-01', fim: '2026-10-31', maxItens: 2, pular: 1 })) as Record<string, any>;
  const s = um.porUnidade['magalhaes-advocacia'];
  assert.deepEqual(s.itens.map((i: any) => i.leadId), [1004, 1003]);
  assert.equal(s.itensOmitidos, 2); // 5 conversas, pulou 1, mostrou 2
  assert.equal(um.rede, undefined);

  const r = (await kommoEntrada(ctx, { unidade: 'todas', inicio: '2026-08-01', fim: '2026-10-31', agruparPor: 'mes' })) as Record<string, any>;
  assert.equal(r.rede.total, 5);
  assert.deepEqual(r.rede.unidadesSomadas, ['magalhaes-advocacia']);
  assert.deepEqual(r.rede.unidadesForaDoTotal, ['doutor-hernia-canaa']);
  assert.deepEqual(r.rede.agrupado, { '2026-08': 1, '2026-09': 2, '2026-10': 2 });
  assert.equal(r.porUnidade['doutor-hernia-canaa'].ok, false);
  assert.match(r.porUnidade['doutor-hernia-canaa'].erro, /401/);
  assert.deepEqual(r.porUnidade['magalhaes-advocacia'].itens, []); // várias unidades: só totais por padrão
});

test('kommo_entrada: leitura incompleta (truncado) vai marcada, na unidade e na rede, e não fica no cache', async () => {
  let chamadas = 0;
  const cortada: FonteKommo = { ...comEntrada(CONVERSAS), entrada: async () => { chamadas++; return { itens: [CONVERSAS[4]!], truncado: true }; } };
  const ctx = criarContextoKommo(new Map([['a', unidadeKommo('a', cortada)], ['b', unidadeKommo('b', comEntrada(CONVERSAS))]]));
  const r = (await kommoEntrada(ctx, { unidade: ['a', 'b'], inicio: '2026-08-01', fim: '2026-10-31' })) as Record<string, any>;
  assert.equal(r.porUnidade.a.truncado, true);
  assert.match(r.porUnidade.a.aviso, /INCOMPLETO/);
  assert.deepEqual(r.rede.unidadesIncompletas, ['a']);
  await kommoEntrada(ctx, { unidade: 'a', inicio: '2026-08-01', fim: '2026-10-31' });
  assert.equal(chamadas, 2, 'o truncado não vira a resposta por 10 minutos');
});

test('kommo_entrada: pedido inválido, conta sem a leitura e conta dividida são recusados (a dividida não entrega paciente da irmã)', async () => {
  const ctx = ctxCom(comEntrada(CONVERSAS));
  await assert.rejects(kommoEntrada(ctx, { unidade: 'magalhaes', inicio: '2026-10-31', fim: '2026-10-01' }), /depois do fim/);
  await assert.rejects(kommoEntrada(ctx, { unidade: 'magalhaes', inicio: 'ontem', fim: '2026-10-01' }), ErroDeEntrada);
  const sem = (await kommoEntrada(ctxCom(fonteFalsa([])), { unidade: 'magalhaes', inicio: '2026-09-01', fim: '2026-09-30' })) as Record<string, any>;
  assert.match(sem.porUnidade['magalhaes-advocacia'].erro, /não tem a leitura da caixa de entrada/);

  const dividida: UnidadeKommo = { ...unidadeKommo('doutor-hernia-caxias', comEntrada(CONVERSAS)), conta: 'doutor-hernia-petropolis', divisao: { rotulo: 'Caxias', membros: [{ slug: 'doutor-hernia-caxias', rotulo: 'Caxias' }, { slug: 'doutor-hernia-petropolis', rotulo: 'Petrópolis' }] } };
  const d = (await kommoEntrada(criarContextoKommo(new Map([[dividida.slug, dividida]])), { unidade: 'caxias', inicio: '2026-08-01', fim: '2026-10-31' })) as Record<string, any>;
  assert.equal(d.porUnidade['doutor-hernia-caxias'].ok, false);
  assert.match(d.porUnidade['doutor-hernia-caxias'].erro, /divide o Kommo/);
});

test('kommo_entrada: 403 do Kommo vira texto em português com o dono do conserto; o resto passa como veio', async () => {
  const f403: FonteKommo = { ...comEntrada([]), entrada: async () => { throw new KommoApiError('lerEntrada(p1): Request failed with status code 403', 403, { title: 'Forbidden' }); } };
  const r = (await kommoEntrada(ctxCom(f403), { unidade: 'magalhaes', inicio: '2026-09-01', fim: '2026-09-30' })) as Record<string, any>;
  assert.match(r.porUnidade['magalhaes-advocacia'].erro, /token de administrador/);
  assert.match(r.porUnidade['magalhaes-advocacia'].erro, /403/);
  const f500: FonteKommo = { ...comEntrada([]), entrada: async () => { throw new KommoApiError('lerEntrada(p1): Request failed with status code 500', 500, undefined); } };
  const r5 = (await kommoEntrada(ctxCom(f500), { unidade: 'magalhaes', inicio: '2026-09-01', fim: '2026-09-30' })) as Record<string, any>;
  assert.match(r5.porUnidade['magalhaes-advocacia'].erro, /500/);
  assert.doesNotMatch(r5.porUnidade['magalhaes-advocacia'].erro, /administrador/);
});

test('kommo_leads: acrescenta naEntrada por unidade e na rede, com o aviso; entrada que falha não derruba o kommo_leads', async () => {
  const leads = [leadFalso(1, '2026-09-01T12:00:00Z')];
  const comLeads: FonteKommo = { ...fonteFalsa(leads), subdominio: 'x', entrada: comEntrada(CONVERSAS).entrada };
  const entradaQuebrada: FonteKommo = { ...fonteFalsa(leads), entrada: async () => { throw new Error('boom'); } };
  const ctx = criarContextoKommo(new Map([['a', unidadeKommo('a', comLeads)], ['b', unidadeKommo('b', entradaQuebrada)], ['c', unidadeKommo('c', fonteFalsa(leads))]]));
  const r = (await kommoLeads(ctx, { unidade: ['a', 'b', 'c'], inicio: '2026-09-01', fim: '2026-09-30' })) as Record<string, any>;
  assert.equal(r.porUnidade.a.total, 1);
  assert.equal(r.porUnidade.a.naEntrada, 2);
  assert.match(r.porUnidade.a.avisoEntrada, /kommo_entrada/);
  assert.equal(r.porUnidade.b.ok, true);
  assert.equal(r.porUnidade.b.total, 1);
  assert.equal(r.porUnidade.b.naEntrada, null);
  assert.match(r.porUnidade.b.avisoEntrada, /boom/);
  assert.equal('naEntrada' in r.porUnidade.c, false, 'fonte sem a leitura da entrada não ganha o campo');
  assert.equal(r.rede.naEntrada, 2);
  assert.equal(r.rede.naEntradaIncompleta, true); // b não leu: o número da rede é um mínimo
  // com data="atualizacao" o período não casa com a data de entrada: não conta
  const at = (await kommoLeads(ctx, { unidade: 'a', inicio: '2026-09-01', fim: '2026-09-30', data: 'atualizacao' })) as Record<string, any>;
  assert.equal('naEntrada' in at.porUnidade.a, false);
  // entrada vazia: o número vem (0) e o aviso não
  const vazia = (await kommoLeads(criarContextoKommo(new Map([['a', unidadeKommo('a', comEntrada([]))]])), { unidade: 'a', inicio: '2026-09-01', fim: '2026-09-30' })) as Record<string, any>;
  assert.equal(vazia.porUnidade.a.naEntrada, 0);
  assert.equal('avisoEntrada' in vazia.porUnidade.a, false);
});

test('kommo_entrada registrada: só leitura, aparece na lista, passa pela auditoria e recusa agruparPor desconhecido', async () => {
  const server = new McpServer({ name: 't', version: '0' });
  const auditoria: string[] = [];
  registrarFerramentasKommo(server, ctxCom(comEntrada(CONVERSAS)), (r) => auditoria.push(`${r.ferramenta}:${r.ok}`));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), c.connect(b)]);
  const { tools } = await c.listTools();
  const ferramenta = tools.find((x) => x.name === 'kommo_entrada')!;
  assert.equal(ferramenta.annotations?.readOnlyHint, true);
  assert.match(ferramenta.description!, /NÃO aceitas|NINGUÉM aceitou/);
  assert.match(ferramenta.description!, /kommo_conversa/);
  const ok = await c.callTool({ name: 'kommo_entrada', arguments: { unidade: 'magalhaes', inicio: '2026-09-01', fim: '2026-09-30', agruparPor: 'mes' } });
  assert.notEqual(ok.isError, true);
  const corpo = JSON.parse((ok.content as Array<{ text: string }>)[0]!.text);
  assert.equal(corpo.porUnidade['magalhaes-advocacia'].total, 2);
  const ruim = await c.callTool({ name: 'kommo_entrada', arguments: { unidade: 'magalhaes', inicio: '2026-09-01', fim: '2026-09-30', agruparPor: 'etapa' } });
  assert.equal(ruim.isError, true);
  assert.deepEqual(auditoria, ['kommo_entrada:true']);
  await c.close();
});

// ─── o cliente do Kommo: o que vai pela rede ───────────────────────────────────────────────────

const UNIT = {
  kommoSubdomain: 'magalhaesadv2025', kommoAccessToken: 't', kommoSalesbotId: null, kommoReplyFieldId: null,
  kommoBypassSalesbot: false, kommoSalesbotExecuteEnabled: false,
} as never;

function redeFalsa(resposta: (config: InternalAxiosRequestConfig, n: number) => { status: number; corpo?: unknown }) {
  const pedidos: InternalAxiosRequestConfig[] = [];
  const adapter: AxiosAdapter = async (config) => {
    pedidos.push(config);
    const { status, corpo } = resposta(config, pedidos.length);
    const response = { data: corpo ?? '', status, statusText: '', headers: {}, config };
    if (status >= 400) throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, null, response);
    return response;
  };
  return { adapter, pedidos };
}

const AGORA = 1_800_000_000;
const bruto = (n: number, criado = AGORA - n * 60) => ({
  uid: `u${n}`, source_uid: 's', source_name: 'Linha 1', category: 'chats', pipeline_id: 7, created_at: criado,
  metadata: { from: '5511999990000', to: '5511888880000', service: 'waba', client: { name: `Nome ${n}`, avatar: null }, last_message_text: 12345, source_name: 'WhatsApp Magalhães' },
  _embedded: { leads: [{ id: 5000 + n }], contacts: [{ id: 6000 + n }], companies: [] },
});

test('cliente: lerEntrada lê nome/telefone/canal/origem, GET só em /leads/unsorted e nunca o texto da mensagem', async () => {
  const rede = redeFalsa(() => ({ status: 200, corpo: { _embedded: { unsorted: [bruto(1), { ...bruto(2), metadata: undefined, source_name: 'Raiz' }, { uid: '', created_at: 1 }] } } }));
  const kommo = createKommoClientSemFreio(UNIT, { adapter: rede.adapter });
  const r = await kommo.lerEntrada(0, AGORA);
  assert.equal(r.truncado, false);
  assert.deepEqual(r.itens[0], {
    uid: 'u1', leadId: 5001, contatoId: 6001, pipelineId: 7, categoria: 'chats', criadoEm: AGORA - 60,
    nome: 'Nome 1', telefone: '5511999990000', origem: 'WhatsApp Magalhães', canal: 'waba',
  });
  assert.equal(r.itens.length, 2, 'item sem uid é ignorado');
  assert.deepEqual({ nome: r.itens[1]!.nome, origem: r.itens[1]!.origem }, { nome: null, origem: 'Raiz' });
  assert.ok(!JSON.stringify(r).includes('12345'), 'last_message_text não sai');
  assert.deepEqual(rede.pedidos.map((p) => [p.method, p.url]), [['get', '/leads/unsorted']]);
  assert.equal((rede.pedidos[0]!.params as Record<string, unknown>)['order[created_at]'], 'desc');
});

test('cliente: lerEntrada pagina até a página curta e pára ao passar do início da janela (sem ler a caixa inteira)', async () => {
  const cheia = (pagina: number) => Array.from({ length: 250 }, (_, i) => bruto(pagina * 1000 + i, AGORA - (pagina * 250 + i) * 60));
  const rede = redeFalsa((cfg) => ({ status: 200, corpo: { _embedded: { unsorted: cheia((cfg.params as { page: number }).page - 1) } } }));
  const kommo = createKommoClientSemFreio(UNIT, { adapter: rede.adapter });
  // janela dentro da 2ª página: a 3ª nem é pedida
  const de = AGORA - 300 * 60;
  const r = await kommo.lerEntrada(de, AGORA, 4);
  assert.equal(rede.pedidos.length, 2);
  assert.equal(r.truncado, false);
  assert.equal(r.itens.length, 301); // 0..300 minutos atrás, inclusive
  // janela que o teto não alcança: avisa que é incompleto
  const rede2 = redeFalsa((cfg) => ({ status: 200, corpo: { _embedded: { unsorted: cheia((cfg.params as { page: number }).page - 1) } } }));
  const k2 = createKommoClientSemFreio(UNIT, { adapter: rede2.adapter });
  const r2 = await k2.lerEntrada(0, AGORA, 2);
  assert.equal(r2.truncado, true);
  assert.equal(r2.itens.length, 500);
  assert.equal(rede2.pedidos.length, 2);
});

test('cliente: lerEntrada — caixa vazia (204) é lista vazia; erro do Kommo LANÇA (nunca vira "caixa vazia")', async () => {
  const vazia = createKommoClientSemFreio(UNIT, { adapter: redeFalsa(() => ({ status: 204 })).adapter });
  assert.deepEqual(await vazia.lerEntrada(0, AGORA), { itens: [], truncado: false });
  const quebrada = createKommoClientSemFreio(UNIT, { adapter: redeFalsa(() => ({ status: 403, corpo: { title: 'Forbidden' } })).adapter });
  await assert.rejects(() => quebrada.lerEntrada(0, AGORA), (e: unknown) => e instanceof KommoApiError && e.status === 403);
});
