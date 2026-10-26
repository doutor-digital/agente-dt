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
import { portoReal, listaDeTesteDoAmbiente, _zerarLimites } from './disparo/porto.js';
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

test('porto real: o contador de rodadas com limite de taxa sobrevive entre rodadas (o porto nasce a cada rodada) e zera quando passa um envio', async () => {
  _zerarLimites();
  assert.equal(await portoReal(new Map()).limiteDeTaxa('a', true), 1);
  assert.equal(await portoReal(new Map()).limiteDeTaxa('a', true), 2);
  assert.equal(await portoReal(new Map()).limiteDeTaxa('b', true), 1, 'por unidade');
  assert.equal(await portoReal(new Map()).limiteDeTaxa('a', false), 0);
  assert.equal(await portoReal(new Map()).limiteDeTaxa('a', true), 1);
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
