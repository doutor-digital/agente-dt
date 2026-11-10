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
  type DepsDaBaixa,
  type PagamentoDoAsaas,
} from './sinal-pix-worker.js';
import type { LinhaDoSinal } from './sinal-pix.js';

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
      return a.distinct ? sinaisNoBanco.filter((l) => l.status === 'pendente').map((l) => ({ unitId: l.unitId })) : sinaisNoBanco.filter((l) => l.unitId === a.where.unitId && (l.status === 'pendente' || (l.avisadoEm === null && l.status !== 'criando'))).map((l) => ({ ...l }));
    },
    updateMany: async ({ where, data }: any) => {
      const l = sinaisNoBanco.find((x) => x.id === where.id && (!where.status || x.status === where.status));
      if (l) Object.assign(l, data);
      return { count: l ? 1 : 0 };
    },
    update: async ({ where, data }: any) => Object.assign(sinaisNoBanco.find((x) => x.id === where.id)!, data),
  },
  configurable: true,
});
Object.defineProperty(prisma, 'unit', {
  value: { findMany: async (a: any) => { consultasAoBanco.push({ model: 'unit', where: a.where }); return [UNIDADE]; }, findUnique: async () => null },
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
