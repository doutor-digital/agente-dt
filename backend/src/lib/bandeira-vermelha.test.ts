import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from './prisma.js';
import {
  BANDEIRA_DIAS,
  CHAVE_BANDEIRA,
  CHAVE_ETIQUETA_CONFIRMADA,
  confirmarEtiqueta,
  cartaoComBandeira,
  ehEtiquetaDeBandeira,
  esquecerContas,
  esquecerReconciliacoes,
  foraDasBandeiras,
  leadsComBandeira,
  livroDaConta,
  reconciliarBandeiras,
  registrarBandeira,
  temBandeira,
  unidadesDaConta,
  vigente,
} from './bandeira-vermelha.js';

type Linha = { leadId: string; ruleKey: string; createdAt: Date };
let consultas: Array<{ where: { unitId: unknown; ruleKey: unknown; createdAt?: { gte: Date } } }> = [];
let rows: Linha[] = [];
let falhar = false;
let deletadas: Array<{ where: { leadId: { in: string[] }; unitId: { in: string[] }; createdAt: { lte: Date } } }> = [];
const irmas = ['u1', 'u1-resgate'];
const gravadas: Array<{ unitId: string; leadId: string; ruleKey: string }> = [];
Object.defineProperty(prisma, 'cardAlert', {
  value: {
    findMany: async (q: (typeof consultas)[number]) => {
      consultas.push(q);
      if (falhar) throw new Error('banco fora');
      return rows;
    },
    deleteMany: async (q: (typeof deletadas)[number]) => {
      deletadas.push(q);
      return { count: 1 };
    },
    upsert: async ({ create }: { create: { unitId: string; leadId: string; ruleKey: string } }) => {
      if (falhar) throw new Error('banco fora');
      gravadas.push(create);
      return {};
    },
  },
  configurable: true,
});
Object.defineProperty(prisma, 'unitCrmCompartilhado', { value: { findMany: async () => [] }, configurable: true });
Object.defineProperty(prisma, 'unit', {
  value: { findUnique: async () => ({ kommoSubdomain: 'conta-x' }), findMany: async () => irmas.map((id) => ({ id })) },
  configurable: true,
});

const AGORA = new Date('2026-11-03T12:00:00Z');
const antes = (min: number) => new Date(AGORA.getTime() - min * 60_000);
const bandeira = (leadId: string, min: number): Linha => ({ leadId, ruleKey: CHAVE_BANDEIRA, createdAt: antes(min) });
const etiqueta = (leadId: string, min: number): Linha => ({ leadId, ruleKey: CHAVE_ETIQUETA_CONFIRMADA, createdAt: antes(min) });

beforeEach(() => {
  esquecerContas();
  esquecerReconciliacoes();
  consultas = [];
  deletadas = [];
  rows = [];
  falhar = false;
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

test('registrarBandeira e confirmarEtiqueta gravam chaves permanentes (não a de 24 h do aviso)', async () => {
  assert.equal(await registrarBandeira('u1', 6153423), true);
  assert.equal(await confirmarEtiqueta('u1', 6153423), true);
  assert.deepEqual(gravadas.map((g) => [g.unitId, g.leadId, g.ruleKey]), [
    ['u1', '6153423', CHAVE_BANDEIRA],
    ['u1', '6153423', CHAVE_ETIQUETA_CONFIRMADA],
  ]);
  assert.equal(CHAVE_BANDEIRA, 'bandeira-vermelha');
});

test('registrar e confirmar devolvem false (e não lançam) quando o banco falha: quem chama grita no rastro', async () => {
  falhar = true;
  assert.equal(await registrarBandeira('u1', 1), false);
  assert.equal(await confirmarEtiqueta('u1', 1), false);
});

test('leadsComBandeira: a CONTA inteira, as duas chaves, a janela de BANDEIRA_DIAS', async () => {
  rows = [bandeira('10', 5), etiqueta('10', 5), bandeira('11', 60)];
  assert.deepEqual((await leadsComBandeira('u1', AGORA))?.sort(), ['10', '11']);
  const q = consultas[0];
  assert.deepEqual(q.where.unitId, { in: ['u1', 'u1-resgate'] }, 'a conta inteira, não só a unidade');
  assert.deepEqual(q.where.ruleKey, { in: [CHAVE_BANDEIRA, CHAVE_ETIQUETA_CONFIRMADA] });
  assert.equal(q.where.createdAt?.gte.getTime(), AGORA.getTime() - BANDEIRA_DIAS * 24 * 3600_000);
});

test('falha do banco: null (o worker pula a unidade; não segue sem a exclusão)', async () => {
  falhar = true;
  assert.equal(await leadsComBandeira('u1'), null);
});

test('foraDasBandeiras: sem bandeira não filtra; com bandeira vira notIn', () => {
  assert.deepEqual(foraDasBandeiras([]), {});
  assert.deepEqual(foraDasBandeiras(['1', '2']), { leadId: { notIn: ['1', '2'] } });
});

test('as unidades da conta: o livro vale para quem divide o Kommo (resgate e principal)', async () => {
  assert.deepEqual((await unidadesDaConta('u1')).sort(), ['u1', 'u1-resgate']);
  rows = [bandeira('7', 1)];
  assert.equal(await temBandeira('u1-resgate', 7, { agora: AGORA }), true);
  assert.deepEqual((consultas[0].where.unitId as { in: string[] }).in.sort(), ['u1', 'u1-resgate']);
});

test('vigência: etiqueta no cartão vale; sem ela, o que o Kommo aceitou foi solto pela equipe e o que nunca aceitou segura; sem ver o cartão, o livro decide', () => {
  const linha = (min: number, etiquetada: boolean) => ({ em: antes(min), etiquetada });
  assert.equal(vigente(null, true, AGORA), true, 'etiqueta sem linha no livro');
  assert.equal(vigente(null, false, AGORA), false);
  assert.equal(vigente(linha(60, true), false, AGORA), false, 'etiqueta aceita e depois tirada: a equipe soltou');
  assert.equal(vigente(linha(60, false), false, AGORA), true, 'a etiqueta nunca foi aceita: o livro segura');
  assert.equal(vigente(linha(3 * 24 * 60, true), undefined, AGORA), true, 'não deu para ver o cartão');
  assert.equal(vigente(linha((BANDEIRA_DIAS + 1) * 24 * 60, false), undefined, AGORA), false, 'venceu');
});

test('temBandeira: sem linha = não; etiqueta confirmada + cartão sem ela = solto; confirmação ANTERIOR à bandeira não vale (alerta novo, etiqueta falhou); banco fora = segura', async () => {
  assert.equal(await temBandeira('u1', 1, { agora: AGORA }), false, 'sem linha');
  rows = [bandeira('1', 120), etiqueta('1', 119)];
  assert.equal(await temBandeira('u1', 1, { noCartao: false, agora: AGORA }), false, 'equipe soltou, sem SQL');
  assert.equal(await temBandeira('u1', 1, { noCartao: true, agora: AGORA }), true);
  assert.equal(await temBandeira('u1', 1, { agora: AGORA }), true, 'sem olhar o cartão o livro segura');
  rows = [etiqueta('1', 500), bandeira('1', 5)]; // a bandeira foi renovada depois da confirmação antiga: a etiqueta desta vez falhou
  assert.equal(await temBandeira('u1', 1, { noCartao: false, agora: AGORA }), true);
  rows = [bandeira('1', (BANDEIRA_DIAS + 1) * 24 * 60)];
  assert.equal(await temBandeira('u1', 1, { agora: AGORA }), false, 'venceu');
  falhar = true;
  assert.equal(await temBandeira('u1', 1, { agora: AGORA }), true, 'banco fora: segura');
});

test('reconciliar: só olha quem teve a etiqueta CONFIRMADA; apaga quem a equipe soltou; sem etiqueta confirmada, lead ausente e Kommo fora ficam', async () => {
  rows = [
    bandeira('10', 60), etiqueta('10', 59), // continua com a etiqueta
    bandeira('11', 60), etiqueta('11', 59), // a equipe tirou
    bandeira('12', 60), etiqueta('12', 59), // o Kommo não devolveu (apagado/outra conta)
    bandeira('13', 60), // a etiqueta nunca foi aceita: nem é olhado
  ];
  let pedidos: number[] = [];
  const kommo = {
    listLeadsPorIds: async (ids: number[]) => {
      pedidos = ids;
      return [
        { id: 10, _embedded: { tags: [{ name: ' PRIORIDADE' }] } },
        { id: 11, _embedded: { tags: [{ name: 'Quente' }] } },
      ];
    },
  } as never;
  const soltos = await reconciliarBandeiras({ id: 'u1', slug: 'u1' }, kommo, AGORA);
  assert.deepEqual(soltos, ['11']);
  assert.deepEqual(pedidos.sort(), [10, 11, 12], 'o 13 não foi olhado');
  const d = deletadas[0];
  assert.deepEqual(d.where.leadId.in, ['11']);
  assert.deepEqual(d.where.unitId.in.sort(), ['u1', 'u1-resgate']);
  assert.equal(d.where.createdAt.lte.getTime(), AGORA.getTime(), 'só apaga o que foi gravado até o início da conferência (alerta novo no meio do caminho fica)');
  // no máximo uma vez a cada 5 min
  assert.deepEqual(await reconciliarBandeiras({ id: 'u1' }, kommo, new Date(AGORA.getTime() + 60_000)), []);
});

test('reconciliar com o Kommo fora do ar: nada é apagado e a próxima varredura tenta de novo (não queima os 5 min)', async () => {
  rows = [bandeira('10', 60), etiqueta('10', 59)];
  const fora = { listLeadsPorIds: async () => { throw new Error('429'); } } as never;
  assert.deepEqual(await reconciliarBandeiras({ id: 'u1' }, fora, AGORA), []);
  assert.equal(deletadas.length, 0);
  const ok = { listLeadsPorIds: async () => [{ id: 10, _embedded: { tags: [] } }] } as never;
  assert.deepEqual(await reconciliarBandeiras({ id: 'u1' }, ok, new Date(AGORA.getTime() + 1000)), ['10']);
});
