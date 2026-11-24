/**
 * As conversas por trás de cada número do painel da Sofia: mesmo filtro do número, uma linha por conversa, motivo em categoria,
 * Pix com situação PAGO/PENDENTE/VENCIDO, teto de linhas, e a leitura SÓ da unidade pedida.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://t:t@localhost:5432/t';

const { MAX_LINHAS_DE_DETALHE, detalheDaUnidade, lerMedida, montarDetalhe, situacaoDoPix } = await import('./agente-detalhe.js');
const { montarPainel } = await import('./agente-painel.js');
const { prisma } = await import('./prisma.js');
const { BASE_LEAD_CHATWOOT } = await import('./chatwoot-lead.js');

const FUSO = 'America/Belem';
const agora = new Date('2026-11-13T18:00:00Z'); // sexta 15h em Belém
const h = (horas: number) => new Date(agora.getTime() - horas * 3_600_000);
const base = { respostas: [], eventos: [], avaliacoes: [], sinais: [], agora, periodo: '7' as const, fuso: FUSO };

test('lerMedida só aceita as medidas conhecidas', () => {
  assert.equal(lerMedida('pix'), 'pix');
  assert.equal(lerMedida('equipe'), 'equipe');
  assert.equal(lerMedida('senha'), null);
  assert.equal(lerMedida(undefined), null);
});

test('respondidas e fora do horário: uma linha por conversa, o número bate com o do painel', () => {
  const respostas = [
    { conversa: 1, criadoEm: h(2) },
    { conversa: 1, criadoEm: h(1) },
    { conversa: 2, criadoEm: h(30) },
    { conversa: 3, criadoEm: new Date('2026-11-13T01:00:00Z') }, // 22h de quinta: fora
    { conversa: 9, criadoEm: h(24 * 9) }, // fora do período
  ];
  const p = montarPainel({ agora, periodo: '7', fuso: FUSO, respostas, marcadas: [], avaliacoes: [], eventos: [] });
  const r = montarDetalhe('respondidas', { ...base, respostas });
  assert.equal(r.total, p.respondidas.agora);
  assert.deepEqual(r.linhas.map((l) => l.conversa), [1, 3, 2], "mais recente primeiro");
  assert.equal(r.linhas[0]!.detalhe, '2 respostas');
  const f = montarDetalhe('fora', { ...base, respostas });
  assert.equal(f.total, 1);
  assert.equal(f.linhas[0]!.conversa, 3);
});

test('marcaram: só consultas de conversas que ela respondeu no período (o filtro do número «Marcaram»)', () => {
  const respostas = [{ conversa: 1, criadoEm: h(2) }];
  const eventos = [
    { conversa: 1, tipo: 'marcou', nome: 'Maria Teste', detalhe: '2026-11-18T09:00', criadoEm: h(1) },
    { conversa: 7, tipo: 'marcou', nome: 'Sem resposta gravada', detalhe: null, criadoEm: h(5) },
  ];
  const r = montarDetalhe('marcaram', { ...base, respostas, eventos });
  assert.deepEqual(r.linhas.map((l) => [l.conversa, l.nome, l.consultaEm]), [[1, 'Maria Teste', '2026-11-18T09:00']]);
});

test('equipe: motivo em categoria, agrupado e contado; sem categoria = «sem motivo registrado» (por último)', () => {
  const eventos = [
    { conversa: 1, tipo: 'equipe', nome: null, detalhe: 'convenio', criadoEm: h(1) },
    { conversa: 2, tipo: 'equipe', nome: null, detalhe: 'convenio', criadoEm: h(2) },
    { conversa: 3, tipo: 'equipe', nome: null, detalhe: 'pediu-pessoa', criadoEm: h(3) },
    { conversa: 4, tipo: 'equipe', nome: null, detalhe: null, criadoEm: h(4) },
    { conversa: 5, tipo: 'equipe', nome: null, detalhe: null, criadoEm: h(5) },
    { conversa: 5, tipo: 'equipe', nome: null, detalhe: 'agenda', criadoEm: h(60) }, // a mesma conversa duas vezes: conta 1 (a mais recente)
  ];
  const r = montarDetalhe('equipe', { ...base, eventos });
  assert.equal(r.total, 5);
  assert.deepEqual(r.grupos!.map((g) => [g.codigo, g.total]), [['convenio', 2], ['pediu-pessoa', 1], ['sem-registro', 2]], '«sem registro» sempre por último');
  assert.equal(r.linhas.find((l) => l.conversa === 4)!.motivo!.rotulo, 'Sem motivo registrado');
  assert.equal(r.linhas.find((l) => l.conversa === 1)!.motivo!.codigo, 'convenio');
  // o total bate com o número do painel (conversas distintas)
  const p = montarPainel({ agora, periodo: '7', fuso: FUSO, respostas: [], marcadas: [], avaliacoes: [], eventos });
  assert.equal(r.total, p.equipe.agora);
});

test('Pix: situação PAGO / PENDENTE / VENCIDO a partir do sinal; sem sinal = sem registro; nunca link nem chave', () => {
  assert.equal(situacaoDoPix({ status: 'pago', venceEm: '2026-11-01' }, '2026-11-13'), 'pago');
  assert.equal(situacaoDoPix({ status: 'expirado', venceEm: '2026-12-01' }, '2026-11-13'), 'vencido');
  assert.equal(situacaoDoPix({ status: 'pendente', venceEm: '2026-11-13' }, '2026-11-13'), 'pendente', 'o último dia ainda vale');
  assert.equal(situacaoDoPix({ status: 'pendente', venceEm: '2026-11-12' }, '2026-11-13'), 'vencido');
  assert.equal(situacaoDoPix({ status: 'criando', venceEm: '2026-11-20' }, '2026-11-13'), 'pendente');
  const lead = (c: number) => String(BASE_LEAD_CHATWOOT + c);
  const eventos = [1, 2, 3, 4].map((c, i) => ({ conversa: c, tipo: 'pix', nome: null, detalhe: null, criadoEm: h(2 + i) }));
  const sinais = [
    { leadId: lead(1), status: 'pago', venceEm: '2026-11-20', valorCentavos: 5000, criadoEm: h(2.1), pagoEm: h(1) },
    { leadId: lead(2), status: 'pendente', venceEm: '2026-11-20', valorCentavos: 5000, criadoEm: h(3.1), pagoEm: null },
    { leadId: lead(3), status: 'pendente', venceEm: '2026-11-01', valorCentavos: 5000, criadoEm: h(4.1), pagoEm: null },
    { leadId: lead(99), status: 'pago', venceEm: '2026-11-20', valorCentavos: 5000, criadoEm: h(5.1), pagoEm: h(1) }, // de outra conversa: nunca casa
  ];
  const r = montarDetalhe('pix', { ...base, eventos, sinais });
  assert.deepEqual(r.situacoes, { pago: 1, pendente: 1, vencido: 1, semRegistro: 1 });
  assert.deepEqual(r.linhas.map((l) => [l.conversa, l.pix!.situacao, l.pix!.valorCentavos]), [[1, 'pago', 5000], [2, 'pendente', 5000], [3, 'vencido', 5000], [4, null, null]]);
  const texto = JSON.stringify(r);
  assert.ok(!/url|linkId|paymentId|chave/i.test(texto), 'nada de link nem chave Pix na resposta');
  const p = montarPainel({ agora, periodo: '7', fuso: FUSO, respostas: [], marcadas: [], avaliacoes: [], eventos });
  assert.equal(r.total, p.pix.agora);
});

test('avaliações: boas e ruins do período, com quem avaliou', () => {
  const avaliacoes = [
    { conversa: 1, nota: 'boa', quemNome: 'Bianca', texto: null, criadoEm: h(1) },
    { conversa: 2, nota: 'ruim', quemNome: 'Rafael', texto: 'Não disse o valor', criadoEm: h(2) },
    { conversa: 3, nota: 'ruim', quemNome: 'Rafael', texto: null, criadoEm: h(24 * 8) },
  ];
  const r = montarDetalhe('avaliacoes', { ...base, avaliacoes });
  assert.deepEqual(r.linhas.map((l) => [l.conversa, l.nota, l.quem]), [[1, 'boa', 'Bianca'], [2, 'ruim', 'Rafael']]);
  assert.equal(r.linhas[1]!.detalhe, 'Não disse o valor');
});

test('teto de linhas, com o total real à parte', () => {
  const respostas = Array.from({ length: MAX_LINHAS_DE_DETALHE + 40 }, (_, i) => ({ conversa: i + 1, criadoEm: new Date(agora.getTime() - (i + 1) * 60_000) }));
  const r = montarDetalhe('respondidas', { ...base, respostas });
  assert.equal(r.linhas.length, MAX_LINHAS_DE_DETALHE);
  assert.equal(r.total, MAX_LINHAS_DE_DETALHE + 40);
});

test('a leitura é SÓ da unidade pedida (slug e unit_id nos filtros), e o sinal não traz o link', async () => {
  const vistos: Array<{ onde: string; where: Record<string, unknown>; select?: Record<string, unknown> }> = [];
  const falso = (onde: string, devolve: unknown[]) => async (a: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
    vistos.push({ onde, where: a.where, select: a.select });
    return devolve;
  };
  const p = prisma as unknown as Record<string, unknown>;
  const modelos = ['sofiaMensagem', 'sofiaEvento', 'sofiaAvaliacao', 'sinalPix'];
  const antes = Object.fromEntries(modelos.map((m) => [m, p[m]]));
  p.sofiaMensagem = { findMany: falso('mensagem', []) };
  p.sofiaEvento = { findMany: falso('evento', [{ conversa: 7, tipo: 'pix', nome: null, detalhe: null, criadoEm: new Date() }]) };
  p.sofiaAvaliacao = { findMany: falso('avaliacao', []) };
  p.sinalPix = { findMany: falso('sinal', []) };
  const unit = { id: 'u-timbo', slug: 'timbo', spineTimezone: FUSO, businessHoursTimezone: FUSO };
  try {
    for (const m of ['respondidas', 'marcaram', 'equipe', 'pix', 'fora', 'avaliacoes'] as const) await detalheDaUnidade(unit, '7', m);
  } finally {
    for (const m of modelos) p[m] = antes[m];
  }
  assert.ok(vistos.length >= 8);
  for (const v of vistos) {
    if (v.onde === 'sinal') {
      assert.equal(v.where.unitId, 'u-timbo');
      assert.ok(!('url' in (v.select ?? {})) && !('linkId' in (v.select ?? {})) && !('paymentId' in (v.select ?? {})), 'o link e a chave não são lidos');
    } else assert.equal(v.where.unitSlug, 'timbo', v.onde);
  }
  assert.ok(vistos.some((v) => v.onde === 'sinal'));
});
