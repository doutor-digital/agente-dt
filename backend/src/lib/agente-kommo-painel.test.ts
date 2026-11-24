/**
 * Painel da Sofia no Kommo: a mesma conta do CRM (`montarPainel`) em cima das linhas do rastro de execução e dos Pix.
 * O que importa aqui: pessoa = cartão (não resposta), cobrança de quem sumiu não entra, Pix e equipe são por cartão,
 * lixo (cartão que não é número) é ignorado, e o período anterior sai da mesma leitura.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diasDaLeitura, painelDasLinhas, semAnterior, type LinhaDoRastro } from './agente-kommo-painel.js';

const FUSO = 'America/Sao_Paulo';
const agora = new Date('2026-11-24T18:00:00Z'); // terça, 15h em São Paulo
const h = (horasAtras: number) => new Date(agora.getTime() - horasAtras * 3_600_000);
const resp = (leadId: string, quando: Date): LinhaDoRastro => ({ leadId, criadoEm: quando, tipo: 'resposta', data: null, hora: null });

test('pessoas respondidas = cartões distintos (várias respostas no mesmo cartão contam uma vez), com o período anterior', () => {
  const p = painelDasLinhas(
    {
      linhas: [resp('100', h(1)), resp('100', h(2)), resp('100', h(3)), resp('200', h(30)), resp('300', h(24 * 9)), resp('400', h(24 * 10))],
      pix: [],
    },
    new Map(),
    { agora, periodo: '7', fuso: FUSO },
  );
  assert.equal(p.respondidas.agora, 2, 'cartões 100 e 200');
  assert.equal(p.respostas, 4, 'as 4 respostas do período');
  assert.equal(p.respondidas.antes, 2, 'cartões 300 e 400 no período anterior');
});

test('consulta marcada: nome do cartão, dia e hora da consulta; conversão só conta quem a Sofia respondeu', () => {
  const p = painelDasLinhas(
    {
      linhas: [
        resp('100', h(5)),
        { leadId: '100', criadoEm: h(4), tipo: 'marcou', data: '2026-11-30', hora: '09:00' },
        { leadId: '555', criadoEm: h(3), tipo: 'marcou', data: null, hora: null }, // marcou sem resposta no período: conta em marcadas, não na conversão
        resp('200', h(6)),
      ],
      pix: [],
    },
    new Map([[100, 'Rosa Lima']]),
    { agora, periodo: 'hoje', fuso: FUSO },
  );
  assert.equal(p.marcadas.agora, 2);
  assert.equal(p.conversao.agora, 50, '1 das 2 pessoas respondidas marcou');
  assert.equal(p.ultimasMarcadas[0]?.conversa, 555, 'a mais recente primeiro');
  const rosa = p.ultimasMarcadas.find((m) => m.conversa === 100);
  assert.equal(rosa?.nome, 'Rosa Lima');
  assert.equal(rosa?.agendadoPara, '2026-11-30T09:00');
});

test('equipe e Pix são por cartão (duas pausas ou dois links no mesmo cartão contam uma vez)', () => {
  const p = painelDasLinhas(
    {
      linhas: [
        { leadId: '100', criadoEm: h(2), tipo: 'equipe', data: null, hora: null },
        { leadId: '100', criadoEm: h(1), tipo: 'equipe', data: null, hora: null },
        { leadId: '200', criadoEm: h(1), tipo: 'equipe', data: null, hora: null },
      ],
      pix: [{ leadId: '100', criadoEm: h(2) }, { leadId: '100', criadoEm: h(1) }, { leadId: '300', criadoEm: h(24 * 8) }],
    },
    new Map(),
    { agora, periodo: '7', fuso: FUSO },
  );
  assert.equal(p.equipe.agora, 2);
  assert.equal(p.pix.agora, 1);
  assert.equal(p.pix.antes, 1, 'o Pix de 8 dias atrás é do período anterior');
});

test('à noite e no fim de semana: a hora da resposta no fuso da unidade', () => {
  const p = painelDasLinhas(
    { linhas: [resp('1', new Date('2026-11-24T14:00:00Z')), resp('2', new Date('2026-11-24T10:00:00Z')), resp('3', new Date('2026-11-22T15:00:00Z'))], pix: [] },
    new Map(),
    { agora, periodo: '7', fuso: FUSO },
  );
  // terça 11h (dentro), terça 7h (fora), domingo 12h (fora)
  assert.equal(p.foraDoHorario.respostas, 2);
  assert.equal(p.foraDoHorario.pct, 67);
});

test('cartão que não é número é ignorado (nunca vira «NaN» na tela) e as avaliações ficam zeradas (não existem no Kommo)', () => {
  const p = painelDasLinhas({ linhas: [resp('abc', h(1)), resp('', h(1)), resp('-4', h(1)), resp('7', h(1))], pix: [{ leadId: 'x', criadoEm: h(1) }] }, new Map(), { agora, periodo: 'hoje', fuso: FUSO });
  assert.equal(p.respondidas.agora, 1);
  assert.equal(p.pix.agora, 0);
  assert.equal(p.avaliacoes.pct, null);
  assert.deepEqual(p.avaliacoes, { boas: 0, ruins: 0, pct: null, pctAntes: null });
});

test('o gráfico tem 14 dias + hoje e cada dia conta cartões distintos', () => {
  const p = painelDasLinhas({ linhas: [resp('1', h(1)), resp('1', h(2)), resp('2', h(2)), resp('3', h(26))], pix: [] }, new Map(), { agora, periodo: '7', fuso: FUSO });
  assert.equal(p.porDia.length, 14);
  assert.equal(p.porDia.at(-1)?.dia, '2026-11-24');
  assert.equal(p.porDia.at(-1)?.respondidas, 2);
  assert.equal(p.porDia.at(-2)?.respondidas, 1);
});

test('quanto do passado é lido: 15 dias serve «hoje» e «7 dias»; 30 dias precisa dos 30 anteriores', () => {
  assert.equal(diasDaLeitura('hoje'), 15);
  assert.equal(diasDaLeitura('7'), 15);
  assert.equal(diasDaLeitura('30'), 61);
});

test('sem nada no período anterior (histórico curto) a tela não compara com zero; com algo, compara', () => {
  const so = painelDasLinhas({ linhas: [resp('1', h(1))], pix: [] }, new Map(), { agora, periodo: '7', fuso: FUSO });
  assert.equal(semAnterior(so), true);
  const com = painelDasLinhas({ linhas: [resp('1', h(1)), resp('2', h(24 * 9))], pix: [] }, new Map(), { agora, periodo: '7', fuso: FUSO });
  assert.equal(semAnterior(com), false);
  const soPix = painelDasLinhas({ linhas: [], pix: [{ leadId: '5', criadoEm: h(24 * 9) }] }, new Map(), { agora, periodo: '7', fuso: FUSO });
  assert.equal(semAnterior(soPix), false, 'o Pix do período anterior também é «algo»');
});
