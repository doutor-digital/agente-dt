/**
 * As conversas por trás de cada número do painel da Sofia: mesmo filtro do número, uma linha por conversa,
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
  assert.equal(f.totalRespostas, p.foraDoHorario.respostas, 'o card conta RESPOSTAS fora do horário: o total da lista tem que bater com ele');
  // a mesma conversa respondendo 2 vezes à noite: 1 linha (conversa), 2 respostas (o número do card)
  const dupla = [...respostas, { conversa: 3, criadoEm: new Date('2026-11-13T02:00:00Z') }];
  const f2 = montarDetalhe('fora', { ...base, respostas: dupla });
  assert.equal(f2.total, 1);
  assert.equal(f2.totalRespostas, 2);
  assert.equal(f2.totalRespostas, montarPainel({ agora, periodo: '7', fuso: FUSO, respostas: dupla, marcadas: [], avaliacoes: [], eventos: [] }).foraDoHorario.respostas);
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

test('equipe: uma linha por conversa (a mais recente), o total bate com o número do painel', () => {
  const eventos = [
    { conversa: 1, tipo: 'equipe', nome: null, detalhe: null, criadoEm: h(1) },
    { conversa: 2, tipo: 'equipe', nome: null, detalhe: null, criadoEm: h(2) },
    { conversa: 2, tipo: 'equipe', nome: null, detalhe: null, criadoEm: h(60) }, // a mesma conversa duas vezes: conta 1
    { conversa: 3, tipo: 'equipe', nome: null, detalhe: null, criadoEm: h(24 * 9) }, // fora do período
  ];
  const r = montarDetalhe('equipe', { ...base, eventos });
  assert.deepEqual(r.linhas.map((l) => l.conversa), [1, 2]);
  const p = montarPainel({ agora, periodo: '7', fuso: FUSO, respostas: [], marcadas: [], avaliacoes: [], eventos });
  assert.equal(r.total, p.equipe.agora);
});

test('Pix: situação PAGO / PENDENTE / VENCIDO a partir do sinal; sem sinal = sem registro; nunca link nem chave', () => {
  assert.equal(situacaoDoPix({ status: 'pago', venceEm: '2026-11-01' }, '2026-11-13'), 'pago');
  assert.equal(situacaoDoPix({ status: 'expirado', venceEm: '2026-12-01' }, '2026-11-13'), 'vencido');
  assert.equal(situacaoDoPix({ status: 'pendente', venceEm: '2026-11-13' }, '2026-11-13'), 'pendente', 'o último dia ainda vale');
  assert.equal(situacaoDoPix({ status: 'pendente', venceEm: '2026-11-12' }, '2026-11-13'), 'vencido');
  assert.equal(situacaoDoPix({ status: 'criando', venceEm: '2026-11-20' }, '2026-11-13'), null, 'reserva: não é Pix enviado');
  assert.equal(situacaoDoPix({ status: 'estornado', venceEm: '2026-11-20' }, '2026-11-13'), null, 'status que não conheço nunca vira «para cobrar»');
  const lead = (c: number) => String(BASE_LEAD_CHATWOOT + c);
  const eventos = [1, 2, 3, 4].map((c, i) => ({ conversa: c, tipo: 'pix', nome: null, detalhe: null, criadoEm: c === 3 ? h(24 * 5) : h(2 + i) })); // a 3 saiu há 5 dias
  const sinais = [
    { leadId: lead(1), status: 'pago', venceEm: '2026-11-20', consultaEm: '2026-11-25T09:00', valorCentavos: 5000, criadoEm: h(2.1), pagoEm: h(1) },
    { leadId: lead(2), status: 'pendente', venceEm: '2026-11-20', consultaEm: '2026-11-25T09:00', valorCentavos: 5000, criadoEm: h(3.1), pagoEm: null },
    { leadId: lead(3), status: 'pendente', venceEm: '2026-11-10', consultaEm: '2026-11-10T09:00', valorCentavos: 5000, criadoEm: h(24 * 5 + 0.1), pagoEm: null }, // valia no dia do Pix, e hoje já passou do último dia
    { leadId: lead(99), status: 'pago', venceEm: '2026-11-20', consultaEm: '2026-11-25T09:00', valorCentavos: 5000, criadoEm: h(5.1), pagoEm: h(1) }, // de outra conversa: nunca casa
  ];
  const r = montarDetalhe('pix', { ...base, eventos, sinais });
  assert.deepEqual(r.situacoes, { pago: 1, pendente: 1, vencido: 1, semRegistro: 1 });
  assert.deepEqual(r.linhas.map((l) => [l.conversa, l.pix!.situacao, l.pix!.valorCentavos]), [[1, 'pago', 5000], [2, 'pendente', 5000], [4, null, null], [3, 'vencido', 5000]]);
  // Pix REENVIADO: a Sofia reaproveita o link pendente de dias antes (mesmo sinal, evento novo) e é esse sinal que casa
  const reenvio = montarDetalhe('pix', { ...base, eventos: [{ conversa: 42, tipo: 'pix', nome: null, detalhe: null, criadoEm: h(2) }], sinais: [{ leadId: lead(42), status: 'pendente', venceEm: '2026-11-20', consultaEm: '2026-11-25T09:00', valorCentavos: 5000, criadoEm: h(24 * 3), pagoEm: null }] });
  assert.equal(reenvio.linhas[0]!.pix!.situacao, 'pendente', 'o sinal de 3 dias atrás ainda valia quando o Pix foi reenviado');
  assert.equal(reenvio.linhas[0]!.pix!.valorCentavos, 5000);
  // sinal já VENCIDO na hora do evento não é o do Pix de agora (o Pix de agora tem sinal novo); sem ele, «sem registro»
  const vencido = montarDetalhe('pix', { ...base, eventos: [{ conversa: 44, tipo: 'pix', nome: null, detalhe: null, criadoEm: h(2) }], sinais: [{ leadId: lead(44), status: 'pendente', venceEm: '2026-11-05', consultaEm: '2026-11-05T09:00', valorCentavos: 5000, criadoEm: h(24 * 9), pagoEm: null }] });
  assert.equal(vencido.linhas[0]!.pix!.situacao, null, 'link que já tinha vencido não vale para o Pix de hoje');
  // com dois sinais da mesma conversa vale o mais recente que valia na hora
  const dois = montarDetalhe('pix', { ...base, eventos: [{ conversa: 45, tipo: 'pix', nome: null, detalhe: null, criadoEm: h(2) }], sinais: [
    { leadId: lead(45), status: 'expirado', venceEm: '2026-11-05', consultaEm: '2026-11-05T09:00', valorCentavos: 5000, criadoEm: h(24 * 9), pagoEm: null },
    { leadId: lead(45), status: 'pago', venceEm: '2026-11-20', consultaEm: '2026-11-25T09:00', valorCentavos: 5000, criadoEm: h(2.1), pagoEm: h(1) },
  ] });
  assert.equal(dois.linhas[0]!.pix!.situacao, 'pago');
  // sinal de uma consulta que JÁ PASSOU (mesmo ainda dentro de vence_em) não vale para o Pix de agora
  const passada = montarDetalhe('pix', { ...base, eventos: [{ conversa: 46, tipo: 'pix', nome: null, detalhe: null, criadoEm: h(2) }], sinais: [{ leadId: lead(46), status: 'pago', venceEm: '2026-11-20', consultaEm: '2026-11-10T09:00', valorCentavos: 5000, criadoEm: h(24 * 4), pagoEm: h(24 * 4) }] });
  assert.equal(passada.linhas[0]!.pix!.situacao, null, 'a consulta de 10/11 já tinha passado quando o Pix de 13/11 saiu');
  // reserva «criando» (órfã) não é Pix enviado
  const reserva = montarDetalhe('pix', { ...base, eventos: [{ conversa: 43, tipo: 'pix', nome: null, detalhe: null, criadoEm: h(2) }], sinais: [{ leadId: lead(43), status: 'criando', venceEm: '2026-11-20', consultaEm: '2026-11-25T09:00', valorCentavos: 5000, criadoEm: h(2.05), pagoEm: null }] });
  assert.equal(reserva.linhas[0]!.pix!.situacao, null, '«criando» (reserva órfã) não entra como pendente');
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
    if (v.onde === 'evento') assert.ok(Array.isArray((v.where.tipo as { in: string[] }).in), 'só os tipos de evento que a medida usa');
  }
  assert.ok(vistos.some((v) => v.onde === 'sinal'));
});
