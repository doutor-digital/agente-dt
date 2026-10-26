/**
 * Os adaptadores do disparo (os que falam com o banco e com a franquia), cobertos com banco e franquia de mentira:
 * as mutações que sobreviveram na revisão do sênior. O comportamento contra um Postgres de verdade foi provado à parte.
 */
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { portoReal, listaDeTesteDoAmbiente } from './disparo/porto.js';
import { SpineService, type SpineUnit } from '../services/spine.service.js';
import { conferenciaDaFranquia, type FranquiaPorta } from './disparo/franquia.js';
import { rodadaDoDisparo, varrerSaidas, _zerarVarreduraDeSair } from './disparo-worker.js';

/** O cliente do Prisma não deixa `mock.method` nos modelos: troca o modelo inteiro por um falso e devolve no fim do teste. */
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

// ── a franquia devolve mais páginas que o teto: a leitura vem marcada como CORTADA ─────────────────────────────

async function franquiaComPaginas(totalPages: number) {
  const pedidos: Array<{ rota: string; corpo: { pagination?: { page?: number; rowsPerPage?: number } } }> = [];
  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => (corpo += c));
    req.on('end', () => {
      pedidos.push({ rota: req.url ?? '', corpo: JSON.parse(corpo || '{}') });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { data: [], totalPages, total: 0 } }));
    });
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const unit = { spineToken: 'tok', spineBaseUrl: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`, spineTimezone: 'America/Sao_Paulo' } as unknown as SpineUnit;
  return { unit, pedidos, fechar: () => new Promise<void>((ok) => servidor.close(() => ok())) };
}

test('searchSchedules: com mais páginas que o teto (40) a leitura vem marcada `truncada`; com poucas, não', async () => {
  const cheia = await franquiaComPaginas(45);
  try {
    const r = await SpineService.searchSchedules(cheia.unit, { initialDate: '2026-10-26', endDate: '2026-11-30', rowsPerPage: 100 });
    assert.ok(r.ok);
    assert.equal(r.data!.truncada, true);
    assert.equal(cheia.pedidos.length, 40, 'leu o teto e parou');
    assert.ok(cheia.pedidos.every((p) => p.corpo.pagination?.rowsPerPage === 100), 'pedindo 100 por página');
  } finally {
    await cheia.fechar();
  }
  const curta = await franquiaComPaginas(3);
  try {
    const r = await SpineService.searchSchedules(curta.unit, { initialDate: '2026-10-26', endDate: '2026-11-30' });
    assert.equal(r.data!.truncada, false);
  } finally {
    await curta.fechar();
  }
});

test('searchTreatments: com mais páginas que o teto a leitura vem marcada `truncada`; com poucas, não', async () => {
  const cheia = await franquiaComPaginas(41);
  try {
    const r = await SpineService.searchTreatments(cheia.unit, {});
    assert.ok(r.ok);
    assert.equal(r.data!.truncada, true);
  } finally {
    await cheia.fechar();
  }
  const curta = await franquiaComPaginas(40);
  try {
    assert.equal((await SpineService.searchTreatments(curta.unit, {})).data!.truncada, false, 'exatamente o teto ainda é leitura completa');
  } finally {
    await curta.fechar();
  }
});

test('a conferência pede a agenda com 100 por página (com 50 o teto de 40 páginas cortava em 2.000)', async () => {
  let pedido: { rowsPerPage?: number } | undefined;
  const porta = {
    searchSchedules: (async (_u: unknown, p: { rowsPerPage?: number }) => {
      pedido = p;
      return { ok: true, data: { schedules: [], pages: 1, total: 0 } };
    }) as unknown as FranquiaPorta['searchSchedules'],
    searchTreatments: (async () => ({ ok: true, data: { treatments: [] } })) as unknown as FranquiaPorta['searchTreatments'],
    idClientDoLead: (async () => null) as unknown as FranquiaPorta['idClientDoLead'],
    getClient: (async () => ({ ok: true })) as unknown as FranquiaPorta['getClient'],
  } satisfies FranquiaPorta;
  await conferenciaDaFranquia({ spineToken: 't', spineTimezone: 'America/Sao_Paulo' } as unknown as Unit, () => new Date(), porta)({ leadId: null, nomeCompleto: 'Fulana', telefone: '5563991021043' });
  assert.equal(pedido?.rowsPerPage, 100);
});

// ── o porto real, com o banco de mentira ───────────────────────────────────────────────────────────────────────

const unidade = (id: string, fone: string | null) => ({ id, slug: `u-${id}`, metaPhoneNumberId: fone }) as unknown as Unit;

test('porto real: a fila de pendentes é ordenada por atualizadoEm (quem foi adiado vai para o fim)', async () => {
  let consulta: { orderBy?: unknown; where?: Record<string, unknown> } | undefined;
  falso('disparoDestinatario', { findMany: async (a: typeof consulta) => ((consulta = a), []) });
  await portoReal(new Map()).pendentes('o1', 'ligado', 10, null);
  assert.deepEqual(consulta!.orderBy, [{ atualizadoEm: 'asc' }, { id: 'asc' }]);
  assert.equal(consulta!.where!.estado, 'pendente');
});

test('porto real: o teto soma TODAS as unidades do mesmo número de WhatsApp; em seco conta o "receberia", em ligado o envio', async () => {
  const consultas: Array<{ where: Record<string, unknown> }> = [];
  falso('unit', { findMany: async () => [{ id: 'a' }, { id: 'b' }] });
  falso('disparoDestinatario', { count: async (a: { where: Record<string, unknown> }) => (consultas.push(a), 7) });
  const porto = portoReal(new Map([['a', unidade('a', '111')]]));
  const desde = new Date(0);
  assert.equal(await porto.contarNaJanela('a', desde, 'ligado'), 7);
  assert.deepEqual(consultas[0]!.where.unitId, { in: ['a', 'b'] }, 'Petrópolis e Caxias somam no mesmo teto');
  assert.ok('enviadoEm' in consultas[0]!.where && !('simuladoEm' in consultas[0]!.where));
  await porto.contarNaJanela('a', desde, 'seco');
  assert.ok('simuladoEm' in consultas[1]!.where && !('enviadoEm' in consultas[1]!.where));
});

test('porto real: unidade sem número cadastrado conta só a si mesma (e nem consulta as outras)', async () => {
  let consultouUnidades = false;
  falso('unit', { findMany: async () => ((consultouUnidades = true), []) });
  let onde: unknown;
  falso('disparoDestinatario', { count: async (a: { where: { unitId: unknown } }) => ((onde = a.where.unitId), 0) });
  await portoReal(new Map([['a', unidade('a', null)]])).contarNaJanela('a', new Date(0), 'ligado');
  assert.deepEqual(onde, { in: ['a'] });
  assert.equal(consultouUnidades, false);
});

test('porto real: o contador de rodadas com limite de taxa é do BANCO e do NÚMERO: duas unidades do mesmo número contam juntas; número diferente, separado; um envio zera', async () => {
  const linhas = new Map<string, number>();
  falso('disparoLimite', {
    upsert: async (a: { where: { unitId: string }; create: { seguidas: number }; update: { seguidas: { increment: number } } }) => {
      const n = (linhas.get(a.where.unitId) ?? 0) + (linhas.has(a.where.unitId) ? a.update.seguidas.increment : a.create.seguidas);
      linhas.set(a.where.unitId, n);
      return { unitId: a.where.unitId, seguidas: n };
    },
    deleteMany: async (a: { where: { unitId: string } }) => (linhas.delete(a.where.unitId), { count: 1 }),
  });
  const todas = new Map([['a', unidade('a', '111')], ['b', unidade('b', '111')], ['c', unidade('c', '222')], ['d', unidade('d', null)]]);
  assert.equal(await portoReal(todas).limiteDeTaxa('a', true), 1);
  assert.equal(await portoReal(todas).limiteDeTaxa('b', true), 2, 'Caxias soma com Petrópolis: é o mesmo número');
  assert.equal(await portoReal(todas).limiteDeTaxa('c', true), 1, 'outro número, outra contagem');
  assert.equal(await portoReal(todas).limiteDeTaxa('d', true), 1, 'sem número: a própria unidade');
  assert.deepEqual([...linhas.keys()].sort(), ['numero:111', 'numero:222', 'unidade:d']);
  assert.equal(await portoReal(todas).limiteDeTaxa('b', false), 0, 'um envio da Caxias zera o contador do número');
  assert.equal(linhas.has('numero:111'), false);
});

test('porto real: pausarNumero pausa as ondas aprovadas de TODAS as unidades do número, zera o contador e devolve as unidades e ondas', async () => {
  const atualizacoes: Array<{ where: { id: { in: string[] }; estado: string }; data: Record<string, unknown> }> = [];
  const apagados: string[] = [];
  let ondasDe: unknown;
  falso('unit', { findMany: async (a: { where: { metaPhoneNumberId?: string; id?: unknown } }) => (a.where.metaPhoneNumberId ? [{ id: 'a' }, { id: 'b' }] : [{ slug: 'u-b' }, { slug: 'u-a' }]) });
  falso('disparoOnda', {
    findMany: async (a: { where: { unitId: { in: string[] } } }) => ((ondasDe = a.where.unitId.in), [{ id: 'oa' }, { id: 'ob' }]),
    updateMany: async (a: (typeof atualizacoes)[number]) => (atualizacoes.push(a), { count: 2 }),
  });
  falso('disparoLimite', { deleteMany: async (a: { where: { unitId: string } }) => (apagados.push(a.where.unitId), { count: 1 }) });
  const r = await portoReal(new Map([['a', unidade('a', '111')]])).pausarNumero('a', 'restrito', 'meta');
  assert.deepEqual(ondasDe, ['a', 'b'], 'busca as ondas das duas unidades do número');
  assert.deepEqual(atualizacoes[0]!.where, { id: { in: ['oa', 'ob'] }, estado: 'aprovada' });
  assert.equal(atualizacoes[0]!.data.estado, 'pausada');
  assert.equal(atualizacoes[0]!.data.pausaCausa, 'meta');
  assert.deepEqual(apagados, ['numero:111'], 'o contador do número recomeça');
  assert.deepEqual(r, { unidades: ['u-a', 'u-b'], ondas: ['oa', 'ob'] });
});

test('aprovar de novo ZERA o contador de limite de taxa do número da unidade', async () => {
  const { impressaoDaOnda } = await import('./disparo/modelo.js');
  const { definicaoDaOnda, aprovarOnda } = await import('./disparo/onda.js');
  const pessoas = [{ chave: 'c1', nome: 'Ana' }];
  const base = { id: 'o1', campanhaId: 'c', unitId: 'a', estado: 'montada', template: 't', idioma: 'pt_BR', textoModelo: 'Oi', variaveis: [], cabecalho: null, oferta: null, total: 1 };
  const impressao = impressaoDaOnda(definicaoDaOnda(base), pessoas);
  const onda = { ...base, impressao, unit: { id: 'a', slug: 'u-a', metaPhoneNumberId: '111' } };
  const apagados: string[] = [];
  falso('disparoOnda', { findUnique: async () => onda, updateMany: async () => ({ count: 1 }) });
  falso('disparoDestinatario', { findMany: async () => pessoas });
  falso('disparoLimite', { deleteMany: async (a: { where: { unitId: string } }) => (apagados.push(a.where.unitId), { count: 1 }) });
  process.env.DISPARO_APROVADORES = 'joao@x.com';
  const r = await aprovarOnda('o1', { por: 'joao@x.com', total: 1, impressao }, async () => ({ ok: true }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(apagados, ['numero:111']);
  // aprovação recusada não mexe no contador
  apagados.length = 0;
  const recusa = await aprovarOnda('o1', { por: 'outro@x.com', total: 1, impressao }, async () => ({ ok: true }));
  assert.equal(recusa.ok, false);
  assert.deepEqual(apagados, []);
});

// ── remontagem e oferta ─────────────────────────────────────────────────────────────────────────────────────────

test('remontar: a recusa DEFINITIVA da Meta (falhou sem enviadoEm) não prende a pessoa numa onda cancelada; o envio INCERTO (com enviadoEm) prende', async () => {
  const { chavesJaNaCampanha, reaproveitarDeOndaCancelada, SEM_ENVIO } = await import('./disparo/publico.js');
  assert.deepEqual(SEM_ENVIO, [{ estado: { in: ['pendente', 'descartado'] } }, { estado: 'falhou', enviadoEm: null }]);
  let where: { NOT?: unknown } | unknown = {};
  falso('disparoDestinatario', {
    findMany: async (a: { where: unknown }) => ((where = a.where), []),
    updateMany: async (a: { where: unknown; data: Record<string, unknown> }) => ((where = a), { count: 1 }),
  });
  await chavesJaNaCampanha('c', 'u');
  assert.deepEqual((where as { NOT?: unknown }).NOT, { onda: { estado: 'cancelada' }, OR: SEM_ENVIO }, 'só sai da lista quem NUNCA recebeu e está em onda cancelada');
  await reaproveitarDeOndaCancelada('c', 'u', 'nova', [{ chave: 'k', telefone: '5563991021043', nome: 'Ana', nomeCompleto: 'Ana', leadId: 1 }]);
  const upd = where as unknown as { where: { OR: unknown; onda: unknown }; data: Record<string, unknown> };
  assert.deepEqual(upd.where.OR, SEM_ENVIO);
  assert.deepEqual(upd.where.onda, { estado: 'cancelada' });
  assert.equal(upd.data.estado, 'pendente');
  assert.equal(upd.data.wamid, null);
});

test('oferta: se o disparo MAIS RECENTE foi um SAIR, a oferta de uma campanha anterior não volta; se foi enviado, vale', async () => {
  const { ofertaDoLead, _zerarGuardaDeOferta } = await import('./disparo/oferta.js');
  let achado: Record<string, unknown> | null = null;
  let consulta: { where: { estado: { in: string[] } }; orderBy: unknown } | undefined;
  falso('disparoDestinatario', { findFirst: async (a: typeof consulta) => (consulta = a, achado) });
  falso('conversation', { findUnique: async () => null });
  const agora = new Date(Date.UTC(2026, 9, 26, 15));
  const dia = (n: number) => new Date(agora.getTime() - n * 86_400_000);
  const ond = { textoModelo: 'Oi {{1}}', variaveis: ['primeiroNome'], oferta: 'R$ 150 até sexta', unit: { name: 'U' }, campanha: { nome: 'Rosa' } };
  _zerarGuardaDeOferta();
  achado = { id: 'x', nome: 'Ana', estado: 'saiu', enviadoEm: dia(1), onda: ond };
  assert.equal(await ofertaDoLead('u', 1001, '5563991021043', agora), null, 'o mais recente é SAIR: sem oferta');
  assert.deepEqual(consulta!.where.estado, { in: ['enviado', 'saiu'] }, 'a busca enxerga o SAIR, senão cairia na campanha anterior');
  assert.deepEqual(consulta!.orderBy, { enviadoEm: 'desc' });
  _zerarGuardaDeOferta();
  achado = { id: 'x', nome: 'Ana', estado: 'enviado', enviadoEm: dia(1), onda: ond };
  assert.equal((await ofertaDoLead('u', 1001, '5563991021043', agora))!.oferta, 'R$ 150 até sexta');
});

// ── lista de teste: "*" misturado não vira "todos" ──────────────────────────────────────────────────────────

test('lista de teste: "slug=*,telefone" NÃO solta a unidade inteira (só vale o telefone); só "slug=*" sozinho solta', () => {
  const v = (s: string) => ({ DISPARO_LISTA_DE_TESTE: s }) as NodeJS.ProcessEnv;
  assert.deepEqual([...listaDeTesteDoAmbiente('u', v('u=*,5563991021043'))!], ['5563991021043']);
  assert.deepEqual([...listaDeTesteDoAmbiente('u', v('u=5563991021043,*'))!], ['5563991021043']);
  assert.deepEqual([...listaDeTesteDoAmbiente('u', v('u=*+5563991021043'))!], ['5563991021043']);
  assert.equal(listaDeTesteDoAmbiente('u', v('u=*,*'))!.size, 0, 'só asteriscos misturados: ninguém');
  assert.equal(listaDeTesteDoAmbiente('u', v('u=*')), null);
  assert.equal(listaDeTesteDoAmbiente('u', v('u= * '))?.size ?? null, null, 'com espaços ao redor, ainda é o "*" sozinho');
});

// ── o worker varre SAIR mesmo sem onda aprovada ─────────────────────────────────────────────────────────────────

test('worker: sem nenhuma onda aprovada a varredura de SAIR roda assim mesmo (onda parada por SAIR e oferta de onda concluída dependem dela)', async () => {
  _zerarVarreduraDeSair();
  let varreu = 0;
  falso('disparoDestinatario', { updateMany: async () => ({ count: 0 }), findMany: async () => (varreu++, []) });
  falso('disparoOnda', { updateMany: async () => ({ count: 0 }), findMany: async () => [] });
  await rodadaDoDisparo();
  assert.equal(varreu, 1, 'a varredura leu os envios mesmo com 0 ondas aprovadas');
});

test('worker: se a varredura de SAIR FALHA, o relógio de 10 minutos não anda e a rodada seguinte tenta de novo', async () => {
  _zerarVarreduraDeSair();
  let tentativas = 0;
  falso('disparoDestinatario', {
    findMany: async () => {
      tentativas++;
      if (tentativas === 1) throw new Error('banco caiu');
      return [];
    },
  });
  const agora = Date.UTC(2026, 9, 26, 15);
  await assert.rejects(() => varrerSaidas(new Map(), agora), /banco caiu/);
  assert.equal(await varrerSaidas(new Map(), agora + 60_000), 0, 'um minuto depois já tenta de novo (e agora passa)');
  assert.equal(tentativas, 2);
  assert.equal(await varrerSaidas(new Map(), agora + 120_000), 0);
  assert.equal(tentativas, 2, 'passou: agora sim espera os 10 minutos');
});
