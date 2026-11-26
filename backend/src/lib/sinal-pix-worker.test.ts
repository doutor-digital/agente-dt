/**
 * Baixa do sinal sem webhook (lib/sinal-pix-worker.ts): casar o Pix pago com o link, ignorar tudo que não é dele, vencer o link sem
 * cobrar o paciente e marcar o cartão uma vez só. Sem banco, sem Asaas e sem Kommo reais.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from './prisma.js';
import { env } from './env.js';
import { cifrar } from './integracoes/cofre.js';
import type { Unit } from '@prisma/client';
import {
  DIAS_PARA_DESISTIR,
  unidadesComBaixaPendente,
  varrerUnidade,
  CAMPO_PAGO,
  conciliar,
  marcarPagoNoCartao,
  notaDoPagamento,
  notaDoVencimento,
  pagamentosDesde,
  valoresDoSim,
  baixarSinalDoLinkPago,
  _esquecerChavesRecusadas,
  decidirInfinitepay,
  type DepsDaBaixa,
  type PagamentoDoAsaas,
} from './sinal-pix-worker.js';
import { somarDias, type LinhaDoSinal } from './sinal-pix.js';
import type { LinkGuardado } from '../mcp-remoto/infinitepay.js';
import { registrarInfinitepayDoServidor } from './infinitepay-servidor.js';
import { confirmarSinalAoPaciente, type DepsDaConfirmacao } from './sinal-confirmacao-paciente.js';
import type { LinkPago } from './link-pago.js';

const linha = (over: Partial<LinhaDoSinal> = {}): LinhaDoSinal => ({
  id: 's1', unitId: 'u1', clinica: 'doutor-hernia-araguaina', consultaEm: '2026-11-14T09:00', leadId: '28000001', linkId: '725104409743', url: 'https://www.asaas.com/c/725104409743', valorCentavos: 5000,
  venceEm: '2026-11-13', status: 'pendente', paymentId: null, criadoEm: new Date('2026-11-10T15:00:00Z'), pagoEm: null, avisadoEm: null, ...over,
});
const pag = (over: Partial<PagamentoDoAsaas> = {}): PagamentoDoAsaas => ({ id: 'pay_1', paymentLink: '725104409743', status: 'RECEIVED', value: 50, billingType: 'PIX', ...over });

test('conciliar: casa pelo paymentLink do link; RECEIVED e CONFIRMED pagam', () => {
  for (const status of ['RECEIVED', 'CONFIRMED']) {
    const d = conciliar([linha()], [pag({ status })], '2026-11-11');
    assert.equal(d.length, 1);
    assert.equal(d[0]!.tipo, 'pago');
    assert.equal(d[0]!.tipo === 'pago' && d[0]!.paymentId, 'pay_1');
  }
});

test('conciliar: ignora cobrança de OUTRA origem (Caixa, outro link, sem link), pendente, vencida, cancelada e de valor menor', () => {
  const outras: PagamentoDoAsaas[] = [
    pag({ id: 'pay_a', paymentLink: null }),
    pag({ id: 'pay_b', paymentLink: undefined }),
    pag({ id: 'pay_c', paymentLink: '999999999999' }),
    pag({ id: 'pay_d', status: 'PENDING' }),
    pag({ id: 'pay_e', status: 'OVERDUE' }),
    pag({ id: 'pay_f', status: 'REFUNDED' }),
    pag({ id: 'pay_g', value: 49.99 }),
    pag({ id: 'pay_h', billingType: 'BOLETO' }),
  ];
  assert.deepEqual(conciliar([linha()], outras, '2026-11-11'), []);
  // valor maior que o sinal (o pagador não muda, mas se vier, é dinheiro que entrou) quita
  assert.equal(conciliar([linha()], [pag({ value: 50.0 })], '2026-11-11').length, 1);
});

test('conciliar: mistura de links — cada pagamento quita só o link dele', () => {
  const a = linha({ id: 'a', leadId: '1', linkId: 'A' });
  const b = linha({ id: 'b', leadId: '2', linkId: 'B' });
  const c = linha({ id: 'c', leadId: '3', linkId: 'C' });
  const d = conciliar([a, b, c], [pag({ id: 'pay_B', paymentLink: 'B' }), pag({ id: 'pay_Z', paymentLink: 'Z' })], '2026-11-11');
  assert.deepEqual(d.map((x) => `${x.tipo}:${x.linha.id}`), ['pago:b']);
});

test('conciliar: link vencido só expira depois de 2 dias de carência e nunca se foi pago; não repete o que já saiu de pendente', () => {
  assert.deepEqual(conciliar([linha()], [], '2026-11-13'), []);
  assert.deepEqual(conciliar([linha()], [], '2026-11-15'), []);
  const venceu = conciliar([linha()], [], '2026-11-16');
  assert.deepEqual(venceu.map((x) => x.tipo), ['expirou']);
  // pago no último dia da carência vale mais que o vencimento
  assert.deepEqual(conciliar([linha()], [pag()], '2026-11-16').map((x) => x.tipo), ['pago']);
  assert.deepEqual(conciliar([linha({ status: 'pago' }), linha({ id: 'x', status: 'expirado' })], [pag()], '2026-12-01'), []);
});

test('pagamentosDesde: só GET /payments (PIX, RECEIVED e CONFIRMED, desde a data), paginado', async () => {
  const chamadas: Array<{ caminho: string; query: Record<string, unknown> }> = [];
  const ler = async (caminho: string, query: Record<string, string | number | undefined>) => {
    chamadas.push({ caminho, query });
    const pagina = Number(query.offset) / 100;
    if (query.status === 'RECEIVED') return { data: [pag({ id: `r${pagina}` })], hasMore: pagina < 1 };
    return { data: [pag({ id: 'c0', status: 'CONFIRMED' })], hasMore: false };
  };
  const { pagamentos: todos, completa } = await pagamentosDesde(ler, '2026-11-09');
  assert.deepEqual(todos.map((p) => p.id), ['r0', 'r1', 'c0']);
  assert.equal(completa, true);
  assert.equal(chamadas.length, 3);
  for (const c of chamadas) {
    assert.equal(c.caminho, '/payments');
    assert.equal(c.query.billingType, 'PIX');
    assert.equal(c.query['dateCreated[ge]'], '2026-11-09');
  }
});

test('leitura cortada no teto de páginas: avisa que não é completa e o link NÃO vence (o pagamento pode estar nas páginas que não vieram), mas a baixa continua', async () => {
  const sempreMais = async (_c: string, q: Record<string, string | number | undefined>) => ({ data: [pag({ id: `x${q.offset}`, paymentLink: 'outro' })], hasMore: true });
  const { pagamentos, completa } = await pagamentosDesde(sempreMais, '2026-11-09');
  assert.equal(completa, false);
  assert.ok(pagamentos.length > 0);
  // vencido há dias + leitura incompleta = nada de "expirou"
  assert.deepEqual(conciliar([linha()], pagamentos, '2026-12-01', completa), []);
  assert.deepEqual(conciliar([linha()], [], '2026-12-01', true).map((x) => x.tipo), ['expirou']);
  // mas se o pagamento DESTE link veio, a baixa acontece mesmo com a leitura cortada
  assert.deepEqual(conciliar([linha()], [...pagamentos, pag()], '2026-12-01', completa).map((x) => x.tipo), ['pago']);
});

test('valoresDoSim: caixa de seleção e lista com "Sim"; outro tipo, ou lista sem "Sim", não grava', () => {
  assert.deepEqual(valoresDoSim({ type: 'checkbox', enums: [] }), [{ value: true }]);
  assert.deepEqual(valoresDoSim({ type: 'select', enums: [{ id: 7, value: 'Não' }, { id: 8, value: 'Sim' }] }), [{ enum_id: 8 }]);
  assert.equal(valoresDoSim({ type: 'select', enums: [{ id: 7, value: 'Talvez' }] }), null);
  assert.equal(valoresDoSim({ type: 'text', enums: [] }), null);
});

function kommoFalso(opts: { campos?: Array<{ id: number; name: string; type: string; enums: Array<{ id: number; value: string }> }>; lead?: unknown | null | Error } = {}) {
  const gravou: Array<{ leadId: number; campos: unknown }> = [];
  const notas: Array<{ leadId: number; texto: string }> = [];
  const campos = opts.campos ?? [{ id: 555, name: CAMPO_PAGO, type: 'select', enums: [{ id: 1, value: 'Sim' }, { id: 2, value: 'Não' }] }];
  const deps: DepsDaBaixa = {
    kommo: {
      getLead: (async () => {
        if (opts.lead instanceof Error) throw opts.lead;
        return opts.lead === undefined ? { id: 1, name: 'x', custom_fields_values: [] } : opts.lead;
      }) as unknown as DepsDaBaixa['kommo']['getLead'],
      listarCamposDoCartao: (async () => campos) as unknown as DepsDaBaixa['kommo']['listarCamposDoCartao'],
      gravarCamposDoLead: (async (leadId: number, c: unknown) => void gravou.push({ leadId, campos: c })) as unknown as DepsDaBaixa['kommo']['gravarCamposDoLead'],
      addLeadNote: (async (leadId: number, texto: string) => void notas.push({ leadId, texto })) as unknown as DepsDaBaixa['kommo']['addLeadNote'],
    },
  };
  return { deps, gravou, notas };
}

test('marcarPagoNoCartao: grava "✓ Consulta pg antecipado" = Sim e a nota — e NADA além disso', async () => {
  const k = kommoFalso();
  const nota = notaDoPagamento(linha(), 'pay_1');
  assert.equal(await marcarPagoNoCartao(k.deps, 28000001, nota), true);
  assert.deepEqual(k.gravou, [{ leadId: 28000001, campos: [{ field_id: 555, values: [{ enum_id: 1 }] }] }]);
  assert.deepEqual(k.notas, [{ leadId: 28000001, texto: '💸 Sinal de R$ 50,00 pago no Asaas (pay_1). O restante é pago no dia da consulta.' }]);
});

test('marcarPagoNoCartao: campo já marcado não é regravado (só a nota); cartão apagado não trava a fila; erro do Kommo sobe', async () => {
  const marcado = kommoFalso({ lead: { id: 1, name: 'x', custom_fields_values: [{ field_id: 555, field_name: CAMPO_PAGO, values: [{ value: 'Sim' }] }] } });
  assert.equal(await marcarPagoNoCartao(marcado.deps, 1, 'n'), true);
  assert.equal(marcado.gravou.length, 0);
  assert.equal(marcado.notas.length, 1);
  const sumiu = kommoFalso({ lead: new Error('Kommo 404 not found') });
  assert.equal(await marcarPagoNoCartao(sumiu.deps, 1, 'n'), false);
  assert.equal(sumiu.notas.length, 0);
  const fora = kommoFalso({ lead: new Error('Kommo 502') });
  await assert.rejects(() => marcarPagoNoCartao(fora.deps, 1, 'n'), /502/);
  // conta sem o campo / campo de tipo que não sabemos gravar: só a nota, sem derrubar
  const semCampo = kommoFalso({ campos: [] });
  assert.equal(await marcarPagoNoCartao(semCampo.deps, 1, 'n'), true);
  assert.equal(semCampo.gravou.length, 0);
  assert.equal(semCampo.notas.length, 1);
});

test('as notas dizem o que aconteceu, sem cobrar o paciente', () => {
  assert.match(notaDoPagamento(linha(), 'pay_9'), /Sinal de R\$ 50,00 pago no Asaas \(pay_9\)/);
  const venceu = notaDoVencimento(linha());
  assert.match(venceu, /venceu em 13\/11 sem pagamento/);
  assert.match(venceu, /Nada foi cobrado do paciente/);
});

// ── a varredura (prisma e Asaas falsos) ──────────────────────────────────────────────────────────────────────────────────────────
const sinaisNoBanco: LinhaDoSinal[] = [];
const consultasAoBanco: Array<{ model: string; where: any }> = [];
Object.defineProperty(prisma, 'sinalPix', {
  value: {
    findMany: async (a: any) => {
      consultasAoBanco.push({ model: 'sinalPix', where: a.where });
      return a.distinct ? sinaisNoBanco.filter((l) => l.status === 'pendente').map((l) => ({ unitId: l.unitId })) : sinaisNoBanco.filter((l) => l.unitId === a.where.unitId && (l.status === 'pendente' || (l.avisadoEm === null && l.status !== 'criando') || (l.status === 'pago' && !l.confirmacaoEm))).map((l) => ({ ...l }));
    },
    updateMany: async ({ where, data }: any) => {
      const l = sinaisNoBanco.find((x) => x.id === where.id && (!where.status || x.status === where.status) && (!('confirmacaoEm' in where) || (x.confirmacaoEm ?? null) === where.confirmacaoEm));
      if (l) Object.assign(l, data);
      return { count: l ? 1 : 0 };
    },
    update: async ({ where, data }: any) => Object.assign(sinaisNoBanco.find((x) => x.id === where.id)!, data),
    findFirst: async ({ where }: any) => sinaisNoBanco.find((l) => l.unitId === where.unitId && l.linkId === where.linkId && (l.via ?? 'asaas') === where.via) ?? null,
  },
  configurable: true,
});
const simulacoes: Array<{ alvo: string; motivo: string }> = [];
Object.defineProperty(prisma, 'automacaoSimulacao', {
  value: { upsert: async ({ create }: any) => void simulacoes.push({ alvo: create.alvo, motivo: create.motivo }), deleteMany: async () => ({ count: 0 }) },
  configurable: true,
});
Object.defineProperty(prisma, 'unit', {
  value: { findMany: async (a: any) => { consultasAoBanco.push({ model: 'unit', where: a.where }); return [UNIDADE]; }, findUnique: async (a: any) => (a?.where?.slug === 'doutor-hernia-araguaina' ? UNIDADE : null) },
  configurable: true,
});
Object.defineProperty(prisma, 'chaveDeIntegracao', {
  value: { findUnique: async () => ({ id: 'k', unitId: 'u1', chaveCifrada: cifrar('$aact_chave_de_teste_000000000000', process.env.INTEGRACOES_CHAVE_MESTRA || env.SESSION_JWT_SECRET), unit: { slug: 'doutor-hernia-araguaina', isActive: true } }) },
  configurable: true,
});
const UNIDADE = { id: 'u1', slug: 'doutor-hernia-araguaina', name: 'Araguaína', spineTimezone: 'America/Sao_Paulo', kommoAccessToken: 'tok', kommoSubdomain: 'x' } as unknown as Unit;
const idas: string[] = [];
let statusAsaas = 403;
globalThis.fetch = (async (url: string) => {
  idas.push(String(url));
  return new Response(JSON.stringify(statusAsaas === 200 ? { data: [], hasMore: false } : { errors: [{ description: 'sem permissão' }] }), { status: statusAsaas });
}) as typeof fetch;

test('a baixa varre quem tem sinal PENDENTE mesmo com a flag da unidade desligada (a consulta ao banco não filtra por sinal_pix_centavos)', async () => {
  sinaisNoBanco.length = 0;
  consultasAoBanco.length = 0;
  sinaisNoBanco.push(linha({ id: 'p1' }));
  const units = await unidadesComBaixaPendente();
  assert.deepEqual(units.map((u) => u.slug), ['doutor-hernia-araguaina']);
  const q = consultasAoBanco.find((c) => c.model === 'unit')!;
  assert.deepEqual(q.where.id.in, ['u1']);
  assert.ok(!('sinalPixCentavos' in q.where), 'sem filtro pela flag');
  sinaisNoBanco.length = 0;
  assert.deepEqual(await unidadesComBaixaPendente(), []);
});

test('403 permanente do Asaas: a unidade fica 1 h sem ser relida (não bate a cada 5 min), e o pendente muito antigo sai da fila', async () => {
  sinaisNoBanco.length = 0;
  idas.length = 0;
  statusAsaas = 403;
  const hoje = new Date().toISOString().slice(0, 10);
  sinaisNoBanco.push(linha({ id: 'p1', venceEm: hoje, criadoEm: new Date() }));
  await varrerUnidade(UNIDADE, false);
  const primeira = idas.length;
  assert.ok(primeira >= 1, 'tentou ler');
  await varrerUnidade(UNIDADE, false);
  assert.equal(idas.length, primeira, 'segunda varredura não tentou de novo');
  // pendente que passou de DIAS_PARA_DESISTIR do fim: expirado sem nota (avisadoEm marcado), nunca mais na fila
  const antigo = new Date(Date.now() - (DIAS_PARA_DESISTIR + 3) * 86_400_000).toISOString().slice(0, 10);
  sinaisNoBanco.length = 0;
  sinaisNoBanco.push(linha({ id: 'velho', venceEm: antigo, criadoEm: new Date(Date.now() - 60 * 86_400_000) }));
  await varrerUnidade(UNIDADE, false);
  assert.equal(sinaisNoBanco[0]!.status, 'expirado');
  assert.ok(sinaisNoBanco[0]!.avisadoEm);
});


// ── o sinal por LINK DA INFINITEPAY (via = 'infinitepay') ─────────────────────────────────────────────────────────────────────────

const HOJE = new Date().toISOString().slice(0, 10);
const doLivro = (over: Partial<LinkGuardado> = {}): LinkGuardado => ({
  orderNsu: 'sinal-abc-1', unidade: 'doutor-hernia-araguaina', status: 'pago', url: 'https://checkout.infinitepay.io/x', valorCentavos: 5000, descricao: 'Sinal', validoAte: null, criadoPor: 'usuario:sofia-sinal',
  criadoEm: '2026-11-10T15:00:00.000Z', invoiceSlug: 'fat-1', transactionNsu: 'tx-uuid-1', formaPagamento: 'pix', parcelas: null, valorPagoCentavos: 5000, reciboUrl: null, revisao: null, pagoEm: null, liquidadoEm: null, ultimoEvento: 'paid', erro: null, ...over,
});
const ip = (over: Partial<LinhaDoSinal> = {}) => linha({ id: 'ip1', via: 'infinitepay', linkId: 'sinal-abc-1', url: 'https://checkout.infinitepay.io/x', venceEm: '2026-11-13', ...over });
const livroCom = (l: LinkGuardado | null | Error) => async () => {
  if (l instanceof Error) throw l;
  return l;
};
const evento = (over: Partial<LinkPago> = {}): LinkPago => ({ unidade: 'doutor-hernia-araguaina', orderNsu: 'sinal-abc-1', valorCentavos: 5000, descricao: 'Sinal', transactionNsu: 'tx-uuid-1', invoiceSlug: 'fat-1', pagoEm: new Date(), ...over });

test('decidirInfinitepay: link PAGO no livro = baixa (com o nsu da transação); nunca por link não pago nem de valor menor', async () => {
  const d = await decidirInfinitepay('doutor-hernia-araguaina', [ip()], '2026-11-12', livroCom(doLivro()));
  assert.equal(d.length, 1);
  assert.equal(d[0]!.tipo, 'pago');
  assert.equal((d[0] as { paymentId: string }).paymentId, 'tx-uuid-1');
  assert.deepEqual(await decidirInfinitepay('x', [ip()], '2026-11-12', livroCom(doLivro({ status: 'criado', transactionNsu: null }))), [], 'criado, ainda não pago');
  assert.deepEqual(await decidirInfinitepay('x', [ip()], '2026-11-12', livroCom(doLivro({ status: 'intencao' }))), []);
  assert.deepEqual(await decidirInfinitepay('x', [ip()], '2026-11-12', livroCom(doLivro({ valorCentavos: 1000 }))), [], 'link de valor menor que o sinal não quita');
  assert.deepEqual(await decidirInfinitepay('x', [ip({ status: 'pago' })], '2026-11-12', livroCom(doLivro())), [], 'só pendente');
});

test('decidirInfinitepay: vence como o Pix do Asaas (fim do link + 2 dias de carência), e NUNCA vence se não deu para ler o livro', async () => {
  const naoPago = doLivro({ status: 'criado', transactionNsu: null });
  assert.deepEqual(await decidirInfinitepay('x', [ip()], '2026-11-15', livroCom(naoPago)), [], 'dentro da carência (13/11 + 2 = 15/11)');
  const v = await decidirInfinitepay('x', [ip()], '2026-11-16', livroCom(naoPago));
  assert.deepEqual(v.map((x) => x.tipo), ['expirou']);
  assert.deepEqual(await decidirInfinitepay('x', [ip()], '2026-11-16', livroCom(new Error('banco fora'))), [], 'livro ilegível: decide depois');
  // o link pago que ainda não tinha sido baixado vence menos que a data: a baixa vem primeiro
  assert.deepEqual((await decidirInfinitepay('x', [ip()], '2026-11-16', livroCom(doLivro()))).map((x) => x.tipo), ['pago']);
});

test('as notas do sinal da InfinitePay dizem onde foi pago e mandam conferir o app quando o link vence; as do Asaas seguem iguais', () => {
  assert.equal(notaDoPagamento(ip(), 'tx-uuid-1'), '💸 Sinal de R$ 50,00 pago no InfinitePay (tx-uuid-1). O restante é pago no dia da consulta.');
  assert.match(notaDoVencimento(ip()), /Confira no app da InfinitePay se ele pagou mesmo assim/);
  assert.equal(notaDoPagamento(linha(), 'pay_9'), '💸 Sinal de R$ 50,00 pago no Asaas (pay_9). O restante é pago no dia da consulta.');
  assert.doesNotMatch(notaDoVencimento(linha()), /InfinitePay/);
});

test('link pago (evento): marca "✓ Consulta pg antecipado" e a nota no cartão, vira pago e avisado — igual ao Pix do Asaas', async () => {
  process.env.SINAL_PIX_SLUGS = 'doutor-hernia-araguaina';
  sinaisNoBanco.length = 0;
  sinaisNoBanco.push(ip());
  const k = kommoFalso();
  await baixarSinalDoLinkPago(evento(), null, k.deps.kommo);
  assert.deepEqual(k.gravou, [{ leadId: 28000001, campos: [{ field_id: 555, values: [{ enum_id: 1 }] }] }]);
  assert.equal(k.notas.length, 1);
  assert.match(k.notas[0]!.texto, /pago no InfinitePay \(tx-uuid-1\)/);
  assert.equal(sinaisNoBanco[0]!.status, 'pago');
  assert.equal(sinaisNoBanco[0]!.paymentId, 'tx-uuid-1');
  assert.ok(sinaisNoBanco[0]!.pagoEm);
  assert.ok(sinaisNoBanco[0]!.avisadoEm, 'o cartão foi avisado: a varredura não repete');
  // o mesmo aviso de novo (entrega repetida): nada de segunda nota
  await baixarSinalDoLinkPago(evento(), null, k.deps.kommo);
  assert.equal(k.notas.length, 1);
  assert.equal(k.gravou.length, 1);
});

test('link pago (evento): o que NÃO é sinal, está desligado, é seco ou vale menos que o sinal não escreve nada', async () => {
  sinaisNoBanco.length = 0;
  const k = kommoFalso();
  // link do conector, não é sinal
  await baixarSinalDoLinkPago(evento({ orderNsu: 'dd-do-conector' }), null, k.deps.kommo);
  // automação sinal-pix desligada
  sinaisNoBanco.push(ip());
  process.env.SINAL_PIX_SLUGS = '';
  await baixarSinalDoLinkPago(evento(), null, k.deps.kommo);
  // link que vale menos que o sinal
  process.env.SINAL_PIX_SLUGS = 'doutor-hernia-araguaina';
  await baixarSinalDoLinkPago(evento({ valorCentavos: 1000 }), null, k.deps.kommo);
  // sinal de unidade que não existe
  await baixarSinalDoLinkPago(evento({ unidade: 'outra-unidade' }), null, k.deps.kommo);
  assert.equal(k.gravou.length + k.notas.length, 0);
  assert.equal(sinaisNoBanco[0]!.status, 'pendente');
});

test('link pago DEPOIS de a varredura dar o sinal como vencido: o dinheiro vale mais que o «venceu» — reabre e dá a baixa', async () => {
  process.env.SINAL_PIX_SLUGS = 'doutor-hernia-araguaina';
  sinaisNoBanco.length = 0;
  sinaisNoBanco.push(ip({ status: 'expirado', avisadoEm: new Date() }));
  const k = kommoFalso();
  await baixarSinalDoLinkPago(evento(), null, k.deps.kommo);
  assert.equal(sinaisNoBanco[0]!.status, 'pago');
  assert.equal(k.gravou.length, 1);
  assert.match(k.notas[0]!.texto, /pago no InfinitePay/);
  // em seco/desligado a linha vencida não é reaberta
  sinaisNoBanco.length = 0;
  sinaisNoBanco.push(ip({ status: 'expirado', avisadoEm: new Date() }));
  process.env.SINAL_PIX_SLUGS = '';
  await baixarSinalDoLinkPago(evento(), null, k.deps.kommo);
  assert.equal(sinaisNoBanco[0]!.status, 'expirado');
  process.env.SINAL_PIX_SLUGS = 'doutor-hernia-araguaina';
});

test('baixa em modo SECO: só registra «gravaria» (com o nome certo do provedor) e não toca no cartão nem no banco', async () => {
  sinaisNoBanco.length = 0;
  sinaisNoBanco.push(ip({ leadId: '28000777' }));
  const k = kommoFalso();
  const antes = simulacoes.length;
  registrarInfinitepayDoServidor({ ctx: {} as never, esc: { armazem: { porOrderNsu: async () => doLivro() } } as never });
  idas.length = 0;
  await varrerUnidade(UNIDADE, true);
  registrarInfinitepayDoServidor(null);
  assert.equal(k.gravou.length + k.notas.length, 0);
  assert.equal(sinaisNoBanco[0]!.status, 'pendente');
  assert.equal(idas.length, 0, 'link da InfinitePay nunca vai ler o Asaas');
  await new Promise((r) => setImmediate(r));
  assert.equal(simulacoes.length, antes + 1);
  assert.match(simulacoes.at(-1)!.motivo, /sinal pago no InfinitePay \(tx-uuid-1\)/);
});

test('varredura: sem o conector da InfinitePay carregado, o link da InfinitePay NÃO vence nem baixa (e o Asaas não é lido por causa dele)', async () => {
  sinaisNoBanco.length = 0;
  sinaisNoBanco.push(ip({ venceEm: somarDias(HOJE, -5), criadoEm: new Date() })); // passou da carência (2 dias), mas não dos 30 de desistir
  registrarInfinitepayDoServidor(null);
  idas.length = 0;
  await varrerUnidade(UNIDADE, false);
  assert.equal(sinaisNoBanco[0]!.status, 'pendente');
  assert.equal(idas.length, 0);
});



// ── a confirmação ao paciente nas DUAS rotas de pagamento: uma mensagem por sinal ───────────────────────────────────────────────

/** A confirmação de verdade (mesma lógica e MESMA reserva do banco falso), com o Kommo, as pausas e a janela falsos. */
function confirmacaoFalsa(o: { janela?: boolean; pausa?: string | null; estado?: 'ligado' | 'seco' | 'desligado' } = {}) {
  const enviados: string[] = [];
  const notas: string[] = [];
  const simulacoesDaConfirmacao: string[] = [];
  const deps: DepsDaConfirmacao = {
    estado: () => o.estado ?? 'ligado',
    agora: () => new Date(),
    reservar: async (id) => (await (prisma as any).sinalPix.updateMany({ where: { id, confirmacaoEm: null }, data: { confirmacaoEm: new Date() } })).count === 1,
    concluir: async (id, desfecho) => void (await (prisma as any).sinalPix.updateMany({ where: { id }, data: { confirmacao: desfecho } })),
    pausadoPor: async () => o.pausa ?? null,
    janelaAberta: async () => o.janela ?? true,
    temRota: () => true,
    // dá tempo de a outra chamada chegar: a reserva é o que impede o segundo envio, não a pressa
    enviar: async (_u, _l, t) => (await new Promise((r) => setImmediate(r)), enviados.push(t), 'enviado'),
    gravarMensagem: async () => undefined,
    nota: async (_u, _l, t) => void notas.push(t),
    simular: (_u, s) => void simulacoesDaConfirmacao.push(String(s.valor)),
  };
  return { enviados, notas, simulacoesDaConfirmacao, confirmar: (l: LinhaDoSinal) => confirmarSinalAoPaciente(UNIDADE, l, deps) };
}

test('sinal pago no ASAAS (varredura): o paciente recebe UMA confirmação, e a varredura seguinte não manda outra', async () => {
  process.env.SINAL_PIX_SLUGS = 'doutor-hernia-araguaina';
  sinaisNoBanco.length = 0;
  sinaisNoBanco.push(linha({ id: 'asaas1', venceEm: somarDias(new Date().toISOString().slice(0, 10), 3), criadoEm: new Date() }));
  const k = kommoFalso();
  const c = confirmacaoFalsa();
  const antes = statusAsaas;
  statusAsaas = 200;
  _esquecerChavesRecusadas();
  const asaasPagou = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: 'pay_1', paymentLink: '725104409743', status: 'RECEIVED', value: 50, billingType: 'PIX' }], hasMore: false }), { status: 200 })) as typeof fetch;
  try {
    await varrerUnidade(UNIDADE, false, null, c.confirmar, k.deps.kommo);
    assert.equal(sinaisNoBanco[0]!.status, 'pago');
    assert.equal(k.gravou.length, 1, 'o cartão foi marcado como sempre');
    assert.equal(c.enviados.length, 1);
    assert.match(c.enviados[0]!, /^Recebemos seu sinal de R\$ 50 ✅ Sua consulta está confirmada/);
    await varrerUnidade(UNIDADE, false, null, c.confirmar, k.deps.kommo);
    await varrerUnidade(UNIDADE, false, null, c.confirmar, k.deps.kommo);
    assert.equal(c.enviados.length, 1, 'uma só, não importa quantas varreduras');
    assert.equal(k.notas.length, 1, 'e uma nota de pagamento só');
  } finally {
    globalThis.fetch = asaasPagou;
    statusAsaas = antes;
  }
});

test('sinal pago na INFINITEPAY (aviso do link): o paciente recebe UMA confirmação', async () => {
  process.env.SINAL_PIX_SLUGS = 'doutor-hernia-araguaina';
  sinaisNoBanco.length = 0;
  sinaisNoBanco.push(ip({ criadoEm: new Date() }));
  const k = kommoFalso();
  const c = confirmacaoFalsa();
  await baixarSinalDoLinkPago(evento(), null, k.deps.kommo, c.confirmar);
  assert.equal(sinaisNoBanco[0]!.status, 'pago');
  assert.equal(c.enviados.length, 1);
  // a InfinitePay reentrega o aviso: nada de segunda mensagem
  await baixarSinalDoLinkPago(evento(), null, k.deps.kommo, c.confirmar);
  assert.equal(c.enviados.length, 1);
});

test('aviso da InfinitePay e varredura ao MESMO tempo: UMA confirmação só (a reserva do banco decide quem manda)', async () => {
  process.env.SINAL_PIX_SLUGS = 'doutor-hernia-araguaina';
  sinaisNoBanco.length = 0;
  sinaisNoBanco.push(ip({ criadoEm: new Date() }));
  registrarInfinitepayDoServidor({ ctx: {} as never, esc: { armazem: { porOrderNsu: async () => doLivro() } } as never });
  const k = kommoFalso();
  const c = confirmacaoFalsa();
  try {
    await Promise.all([baixarSinalDoLinkPago(evento(), null, k.deps.kommo, c.confirmar), varrerUnidade(UNIDADE, false, null, c.confirmar, k.deps.kommo)]);
    await varrerUnidade(UNIDADE, false, null, c.confirmar, k.deps.kommo);
  } finally {
    registrarInfinitepayDoServidor(null);
  }
  assert.equal(sinaisNoBanco[0]!.status, 'pago');
  assert.equal(c.enviados.length, 1);
  assert.equal(k.notas.filter((n) => /pago no InfinitePay/.test(n.texto)).length, 1, 'e a nota de pagamento também é uma só');
});

test('retry: o Kommo falhou ao marcar o cartão no aviso — a varredura marca e confirma, e a confirmação continua sendo uma', async () => {
  process.env.SINAL_PIX_SLUGS = 'doutor-hernia-araguaina';
  sinaisNoBanco.length = 0;
  sinaisNoBanco.push(ip({ criadoEm: new Date() }));
  const falha = kommoFalso({ lead: new Error('Kommo 502') });
  const c = confirmacaoFalsa();
  await baixarSinalDoLinkPago(evento(), null, falha.deps.kommo, c.confirmar);
  assert.equal(sinaisNoBanco[0]!.status, 'pago');
  assert.equal(sinaisNoBanco[0]!.avisadoEm ?? null, null, 'o cartão ficou sem marca');
  assert.equal(c.enviados.length, 0, 'sem o cartão marcado a confirmação espera a varredura');
  const bom = kommoFalso();
  await varrerUnidade(UNIDADE, false, null, c.confirmar, bom.deps.kommo);
  await varrerUnidade(UNIDADE, false, null, c.confirmar, bom.deps.kommo);
  assert.equal(bom.gravou.length, 1);
  assert.equal(c.enviados.length, 1);
});

test('fora da janela de 24 h (as duas rotas): só a nota no cartão, nenhuma mensagem', async () => {
  process.env.SINAL_PIX_SLUGS = 'doutor-hernia-araguaina';
  sinaisNoBanco.length = 0;
  sinaisNoBanco.push(ip({ criadoEm: new Date() }));
  const k = kommoFalso();
  const c = confirmacaoFalsa({ janela: false });
  await baixarSinalDoLinkPago(evento(), null, k.deps.kommo, c.confirmar);
  await varrerUnidade(UNIDADE, false, null, c.confirmar, k.deps.kommo);
  assert.deepEqual(c.enviados, []);
  assert.deepEqual(c.notas.length, 1);
  assert.match(c.notas[0]!, /confirmação não enviada: fora da janela de 24 h/);
  assert.equal(sinaisNoBanco[0]!.confirmacao, 'fora-da-janela');
});

test('IA pausada no cartão: só a nota, nenhuma mensagem', async () => {
  process.env.SINAL_PIX_SLUGS = 'doutor-hernia-araguaina';
  sinaisNoBanco.length = 0;
  sinaisNoBanco.push(ip({ criadoEm: new Date() }));
  const k = kommoFalso();
  const c = confirmacaoFalsa({ pausa: '«Pausar IA» marcado no cartão' });
  await baixarSinalDoLinkPago(evento(), null, k.deps.kommo, c.confirmar);
  assert.deepEqual(c.enviados, []);
  assert.match(c.notas[0]!, /a IA está pausada/);
  assert.equal(sinaisNoBanco[0]!.status, 'pago', 'o cartão foi marcado do mesmo jeito: pausa só cala a mensagem');
  assert.equal(k.gravou.length, 1);
});

test('só no papel (padrão): o sinal é baixado normalmente, a confirmação é só registrada — nada vai ao paciente e nenhuma nota extra', async () => {
  process.env.SINAL_PIX_SLUGS = 'doutor-hernia-araguaina';
  sinaisNoBanco.length = 0;
  sinaisNoBanco.push(ip({ criadoEm: new Date() }));
  const k = kommoFalso();
  const c = confirmacaoFalsa({ estado: 'seco' });
  await baixarSinalDoLinkPago(evento(), null, k.deps.kommo, c.confirmar);
  await varrerUnidade(UNIDADE, false, null, c.confirmar, k.deps.kommo);
  assert.equal(sinaisNoBanco[0]!.status, 'pago');
  assert.deepEqual(c.enviados, []);
  assert.deepEqual(c.notas, []);
  assert.equal(c.simulacoesDaConfirmacao.length, 1, 'registrou o que mandaria, uma vez');
  assert.equal(sinaisNoBanco[0]!.confirmacaoEm ?? null, null, 'e a reserva continua livre para quando a chave ligar');
  assert.equal(k.notas.length, 1, 'só a nota de pagamento de sempre');
});

