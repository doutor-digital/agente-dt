import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from './prisma.js';
import { BANDEIRA_DIAS, CHAVE_BANDEIRA, cartaoComBandeira, ehEtiquetaDeBandeira, foraDasBandeiras, leadsComBandeira, registrarBandeira, temBandeira } from './bandeira-vermelha.js';

let consultas: unknown[] = [];
let linhas: Array<{ leadId: string }> = [];
let falhar = false;
let linhaUnica: { createdAt: Date } | null = null;
const gravadas: Array<{ unitId: string; leadId: string; ruleKey: string }> = [];
Object.defineProperty(prisma, 'cardAlert', {
  value: {
    findMany: async (q: unknown) => {
      consultas.push(q);
      if (falhar) throw new Error('banco fora');
      return linhas;
    },
    findUnique: async () => {
      if (falhar) throw new Error('banco fora');
      return linhaUnica;
    },
    upsert: async ({ create }: { create: { unitId: string; leadId: string; ruleKey: string } }) => {
      if (falhar) throw new Error('banco fora');
      gravadas.push(create);
      return {};
    },
  },
  configurable: true,
});

beforeEach(() => {
  consultas = [];
  linhas = [];
  falhar = false;
  linhaUnica = null;
  gravadas.length = 0;
});

test('reconhece a etiqueta como o Kommo a devolve: sem emoji, com espaço na frente, e a da regra da unidade', () => {
  for (const nome of [' PRIORIDADE', 'PRIORIDADE', '🔴 PRIORIDADE', 'Alerta · Bandeira vermelha', 'alerta bandeira vermelha']) {
    assert.equal(ehEtiquetaDeBandeira(nome), true, nome);
  }
  for (const nome of ['Quente', 'IA · Sofia atendeu', 'Origem: Anuncio pago', 'prioridade de marketing', 'Sem bandeira vermelha', 'Bandeira vermelha resolvida', '', null, undefined]) {
    assert.equal(ehEtiquetaDeBandeira(nome), false, String(nome));
  }
});

test('cartaoComBandeira lê as etiquetas do cartão que o chamador já tem', () => {
  assert.equal(cartaoComBandeira({ _embedded: { tags: [{ name: 'Quente' }, { name: ' PRIORIDADE' }] } }), true);
  assert.equal(cartaoComBandeira({ _embedded: { tags: [{ name: 'Quente' }] } }), false);
  assert.equal(cartaoComBandeira({ _embedded: { tags: null } }), false);
  assert.equal(cartaoComBandeira(undefined), false);
});

test('registrarBandeira grava a chave permanente (não a de 24 h do aviso)', async () => {
  assert.equal(await registrarBandeira('u1', 6153423), true);
  assert.equal(gravadas.length, 1);
  assert.deepEqual([gravadas[0].unitId, gravadas[0].leadId, gravadas[0].ruleKey], ['u1', '6153423', CHAVE_BANDEIRA]);
  assert.equal(CHAVE_BANDEIRA, 'bandeira-vermelha');
});

test('leadsComBandeira pergunta só pela unidade, pela chave e pela janela de BANDEIRA_DIAS', async () => {
  linhas = [{ leadId: '10' }, { leadId: '11' }];
  const agora = new Date('2026-11-03T12:00:00Z');
  const r = await leadsComBandeira('u1', agora);
  assert.deepEqual(r, ['10', '11']);
  const q = consultas[0] as { where: { unitId: string; ruleKey: string; createdAt: { gte: Date } } };
  assert.equal(q.where.unitId, 'u1');
  assert.equal(q.where.ruleKey, CHAVE_BANDEIRA);
  assert.equal(q.where.createdAt.gte.getTime(), agora.getTime() - BANDEIRA_DIAS * 24 * 3600_000);
});

test('falha do banco: null (o worker pula a unidade; não segue sem a exclusão)', async () => {
  falhar = true;
  assert.equal(await leadsComBandeira('u1'), null);
});

test('foraDasBandeiras: sem bandeira não filtra; com bandeira vira notIn', () => {
  assert.deepEqual(foraDasBandeiras([]), {});
  assert.deepEqual(foraDasBandeiras(['1', '2']), { leadId: { notIn: ['1', '2'] } });
});

test('registrarBandeira devolve false (e não lança) quando o banco falha: quem chama grita no rastro', async () => {
  falhar = true;
  assert.equal(await registrarBandeira('u1', 1), false);
});

test('temBandeira: vale dentro da janela, solta depois dela, e na dúvida (banco fora) SEGURA', async () => {
  const agora = new Date('2026-11-03T12:00:00Z');
  assert.equal(await temBandeira('u1', 1, agora), false, 'sem linha');
  linhaUnica = { createdAt: new Date(agora.getTime() - 5 * 24 * 3600_000) };
  assert.equal(await temBandeira('u1', 1, agora), true);
  linhaUnica = { createdAt: new Date(agora.getTime() - (BANDEIRA_DIAS + 1) * 24 * 3600_000) };
  assert.equal(await temBandeira('u1', 1, agora), false, 'venceu');
  falhar = true;
  assert.equal(await temBandeira('u1', 1, agora), true, 'banco fora: segura');
});
