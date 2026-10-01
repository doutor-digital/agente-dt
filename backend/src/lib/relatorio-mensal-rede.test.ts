import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fechamentoPosAvaliacao,
  intervaloDoMes,
  janelas,
  medirAderencia,
  mesValido,
  resumirAgenda,
  resumirIa,
  resumirTratamentos,
  resumirWhatsapp,
} from './relatorio-mensal-rede.js';
import type { SpineSchedule, SpineTreatment } from '../services/spine.service.js';

function ag(dia: string, categoria: string, status: string, nome = 'MARIA'): SpineSchedule {
  return {
    idSchedule: 1, idTreatment: null, idStatus: null, statusName: status, clientName: nome, categoryName: categoria,
    physicalTherapist: null, dateAttendanceUtc: `${dia}T12:00:00.000Z`, dateAttendanceLocal: `${dia} 09:00`,
    dayLocal: dia, timeLocal: '09:00', isBusy: true, requiresManualValidation: false,
  };
}
function tr(created: string, nome: string, price: number | null, plano = 'PROTOCOLO 03 MESES'): SpineTreatment {
  return { idTreatment: 1, idClient: 1, clientName: nome, category: plano, local: 'LOMBAR', degree: null, staffName: null, statusName: 'EM ANDAMENTO', price, created: `${created}T10:00:00.000Z` };
}

test('mês: valida e acha o último dia (incl. fevereiro de ano bissexto)', () => {
  assert.equal(mesValido('2026-09'), true);
  assert.equal(mesValido('2026-13'), false);
  assert.equal(mesValido('26-09'), false);
  assert.deepEqual(intervaloDoMes('2026-09'), { de: '2026-09-01', ate: '2026-09-30', dias: 30 });
  assert.equal(intervaloDoMes('2028-02').ate, '2028-02-29');
});

test('janelas: nenhuma passa de 30 dias e juntas cobrem tudo sem buraco', () => {
  const j = janelas('2026-07-03', '2026-09-30');
  assert.ok(j.every((x) => (Date.parse(x.ate) - Date.parse(x.de)) / 86_400_000 <= 29));
  assert.equal(j[0].de, '2026-07-03');
  assert.equal(j[j.length - 1].ate, '2026-09-30');
  for (let i = 1; i < j.length; i++) assert.equal(Date.parse(j[i].de) - Date.parse(j[i - 1].ate), 86_400_000);
});

test('agenda: REAVALIAÇÃO não conta como avaliação; desmarcada e remarcada fora do comparecimento', () => {
  const r = resumirAgenda([
    ag('2026-09-02', 'AVALIAÇÃO', 'ATENDIDO', 'A'),
    ag('2026-09-03', 'AVALIAÇÃO', 'NÃO COMPARECEU', 'B'),
    ag('2026-09-04', 'AVALIAÇÃO', 'DESMARCADO', 'C'),
    ag('2026-09-05', 'AVALIAÇÃO', 'REMARCADO', 'D'),
    ag('2026-09-06', 'AVALIAÇÃO', 'AGENDADO', 'E'),
    ag('2026-09-07', 'REAVALIAÇÃO', 'ATENDIDO', 'F'),
    ag('2026-09-08', 'SESSÃO', 'ATENDIDO', 'A'),
  ]);
  assert.equal(r.avaliacoes.marcadas, 5);
  assert.equal(r.avaliacoes.atendidas, 1);
  assert.equal(r.avaliacoes.faltas, 1);
  assert.equal(r.avaliacoes.desmarcadas, 1);
  assert.equal(r.avaliacoes.remarcadas, 1);
  assert.equal(r.avaliacoes.abertas, 1);
  assert.equal(r.avaliacoes.taxaComparecimento, 0.5);
  assert.equal(r.outras.atendidas, 1); // a reavaliação foi para "outras"
  assert.equal(r.sessoes.atendidas, 1);
  assert.equal(r.pacientesDistintos, 6);
});

test('agenda: sem base não inventa taxa', () => {
  assert.equal(resumirAgenda([ag('2026-09-06', 'AVALIAÇÃO', 'AGENDADO')]).avaliacoes.taxaComparecimento, null);
});

test('tratamentos: só os criados no mês, receita só de preço > 0, e diz quantos vieram sem preço', () => {
  const r = resumirTratamentos([
    tr('2026-09-10', 'A', 3000), tr('2026-09-11', 'B', 0), tr('2026-09-12', 'C', null),
    tr('2026-08-30', 'D', 5000), tr('2026-10-01', 'E', 5000),
  ], '2026-09-01', '2026-09-30');
  assert.equal(r.criadosNoMes, 3);
  assert.equal(r.comPreco, 1);
  assert.equal(r.semPreco, 2);
  assert.equal(r.receita, 3000);
  assert.equal(r.ticketMedio, 3000);
});

test('tratamentos: nenhum com preço → ticket null, não zero', () => {
  assert.equal(resumirTratamentos([tr('2026-09-10', 'A', 0)], '2026-09-01', '2026-09-30').ticketMedio, null);
});

test('fechamento: casa avaliação atendida com tratamento aberto no mesmo dia ou depois, ignorando acento e caixa', () => {
  const r = fechamentoPosAvaliacao(
    [ag('2026-09-02', 'AVALIAÇÃO', 'ATENDIDO', 'João da Silva'), ag('2026-09-03', 'AVALIAÇÃO', 'ATENDIDO', 'Maria'), ag('2026-09-04', 'AVALIAÇÃO', 'NÃO COMPARECEU', 'Pedro')],
    [tr('2026-09-02', 'JOAO DA SILVA', 2000), tr('2026-08-01', 'MARIA', 2000), tr('2026-09-05', 'PEDRO', 1000)],
  );
  assert.equal(r.avaliados, 2);   // Pedro faltou
  assert.equal(r.fecharam, 1);    // Maria tinha tratamento ANTES da avaliação: não conta como fechamento dela
  assert.equal(r.semTratamento, 1);
  assert.equal(r.taxa, 0.5);
});

test('aderência: conta 2, 3 e 5 faltas seguidas', () => {
  const faltas = (nome: string, n: number) => Array.from({ length: n }, (_, i) => ag(`2026-09-${String(i + 1).padStart(2, '0')}`, 'SESSÃO', 'NÃO COMPARECEU', nome));
  const r = medirAderencia([...faltas('A', 2), ...faltas('B', 3), ...faltas('C', 5), ...faltas('D', 1)], '2026-09-30');
  assert.equal(r.comDuasFaltas, 3);
  assert.equal(r.comTresFaltas, 2);
  assert.equal(r.comCincoFaltas, 1);
  assert.equal(r.piores[0].nome, 'C');
});

test('whatsapp: soma por categoria, separa grátis de pago e só converte com câmbio', () => {
  const custos = [
    { pricingCategory: 'MARKETING', pricingType: 'REGULAR', volume: 100, costUsd: '5.5' },
    { pricingCategory: 'UTILITY', pricingType: 'REGULAR', volume: 200, costUsd: 2 },
    { pricingCategory: 'SERVICE', pricingType: 'FREE_CUSTOMER_SERVICE', volume: 700, costUsd: 0 },
  ];
  const tpl = [{ templateName: 'lembrete', templateId: '1', sent: 10, delivered: 9, read: 5, clicked: 1, costUsd: 1 }];
  const sem = resumirWhatsapp(custos, tpl, null);
  assert.equal(sem.mensagens, 1000);
  assert.equal(sem.gratis, 700);
  assert.equal(sem.pagas, 300);
  assert.equal(sem.usd, 7.5);
  assert.equal(sem.brl, null);
  assert.equal(sem.porCategoria[0].categoria, 'MARKETING');
  assert.equal(sem.topTemplates[0].nome, 'lembrete');
  assert.equal(resumirWhatsapp(custos, tpl, 5).brl, 37.5);
});

test('tratamento criado às 22h locais de 30/09 (já 01/10 em UTC) entra em setembro', () => {
  const t = { ...tr('2026-10-01', 'A', 1000), created: '2026-10-01T01:00:00.000Z' };
  assert.equal(resumirTratamentos([t], '2026-09-01', '2026-09-30', 'America/Sao_Paulo').criadosNoMes, 1);
  assert.equal(resumirTratamentos([t], '2026-09-01', '2026-09-30', 'UTC').criadosNoMes, 0);
});

test('aderência: categoria "Sessão" e nome com grafia diferente também contam', () => {
  const s = (dia: string, nome: string) => ({ ...ag(dia, 'Sessão', 'NÃO COMPARECEU', nome) });
  const r = medirAderencia([s('2026-09-01', 'Maria Souza'), s('2026-09-02', 'MARIA SOUZA')], '2026-09-30');
  assert.equal(r.comDuasFaltas, 1);
});

test('whatsapp: campo vazio não vira NaN', () => {
  const r = resumirWhatsapp([], [{ templateName: 'x', templateId: '1', sent: null as unknown as number, delivered: 2, read: 0, clicked: 0, costUsd: 0 }], null);
  assert.equal(r.templates.enviados, 0);
  assert.equal(r.templates.entregues, 2);
});

test('IA: custo a preço de lista pelos tokens (1M de cada = 2+10+0,2+2,5+4)', () => {
  const uso = { chamadas: 1, registradoUsd: 99, entrada: 1e6, saida: 1e6, cacheLeitura: 1e6, cache5m: 1e6, cache1h: 1e6 };
  const r = resumirIa(uso, 5);
  assert.equal(r.listaUsd, 18.7);
  assert.equal(r.listaBrl, 93.5);
  assert.equal(r.registradoUsd, 99); // o gravado no banco segue visível, para quem quiser comparar
  assert.equal(r.tokens.cacheGravado, 2e6);
});

test('IA: sem câmbio não converte', () => {
  assert.equal(resumirIa({ chamadas: 0, registradoUsd: 0, entrada: 0, saida: 0, cacheLeitura: 0, cache5m: 0, cache1h: 0 }, null).listaBrl, null);
});
