import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_DIAS_DO_PERIODO, recuperacaoAgenda, registrarRecuperacaoAgenda, type DepsDaRecuperacao } from './recuperacao-agenda.js';
import type { MedicaoDaUnidade } from '../lib/recuperacao-agenda-medicao.js';

const AGORA = new Date('2026-11-26T15:00:00.000Z');
const UNIDADES = [{ id: 'u1', slug: 'doutor-hernia-acailandia' }, { id: 'u2', slug: 'doutor-hernia-serra' }, { id: 'u3', slug: 'doutor-hernia-timbo' }];

const medicao = (slug: string, o: Partial<MedicaoDaUnidade> = {}): MedicaoDaUnidade => ({
  unidade: slug, periodo: { inicio: '', fim: '' }, janelaDias: 30, historicoDesde: '2026-11-27', eventosNoHistorico: 10, listas: { dias: 2, itens: 8, incertos: 0 }, resultado: {}, ...o,
});

function deps(medidas: Record<string, Partial<MedicaoDaUnidade> | Error> = {}): DepsDaRecuperacao & { pedidos: Array<{ slug: string; inicio: string; fim: string; janelaDias: number }> } {
  const pedidos: Array<{ slug: string; inicio: string; fim: string; janelaDias: number }> = [];
  return {
    pedidos,
    agora: () => AGORA,
    unidades: async () => UNIDADES,
    medir: async (a) => {
      pedidos.push({ slug: a.slug, inicio: a.inicio, fim: a.fim, janelaDias: a.janelaDias });
      const m = medidas[a.slug];
      if (m instanceof Error) throw m;
      return medicao(a.slug, m ?? { eventosNoHistorico: 0, listas: { dias: 0, itens: 0, incertos: 0 }, resultado: null, semDado: 'sem histórico' });
    },
  };
}

test('uma unidade (nome curto): período padrão de 60 dias até hoje e janela de 30; traz a base da rede e a ressalva de correlação', async () => {
  const d = deps({ 'doutor-hernia-acailandia': {} });
  const r = await recuperacaoAgenda(d, { unidade: 'acailandia' });
  assert.deepEqual(d.pedidos, [{ slug: 'doutor-hernia-acailandia', inicio: '2026-09-28', fim: '2026-11-26', janelaDias: 30 }]);
  assert.equal((r.baseAntesDaLista as { desmarque: number; falta: number }).desmarque, 0.11);
  assert.equal((r.baseAntesDaLista as { falta: number }).falta, 0.03);
  assert.match(String(r.comoLer), /CORRELAÇÃO/);
  assert.match(String(r.comoLer), /seco/);
});

test('sem unidade: só aparecem as que têm histórico ou lista (30 «sem dado» seriam ruído)', async () => {
  const d = deps({ 'doutor-hernia-acailandia': {} });
  const r = await recuperacaoAgenda(d, {});
  assert.deepEqual((r.porUnidade as MedicaoDaUnidade[]).map((m) => m.unidade), ['doutor-hernia-acailandia']);
});

test('pedindo UMA unidade sem dado: mostra «semDado», nunca um zero', async () => {
  const r = await recuperacaoAgenda(deps(), { unidade: 'serra' });
  const [m] = r.porUnidade as MedicaoDaUnidade[];
  assert.equal(m.unidade, 'doutor-hernia-serra');
  assert.equal(m.resultado, null);
  assert.ok(m.semDado);
});

test('entrada inválida: unidade desconhecida, data inexistente, início depois do fim, período longo, janela fora da faixa', async () => {
  await assert.rejects(recuperacaoAgenda(deps(), { unidade: 'narnia' }), /unidade desconhecida/);
  await assert.rejects(recuperacaoAgenda(deps(), { inicio: '2026-02-30' }), /não é uma data que existe/);
  await assert.rejects(recuperacaoAgenda(deps(), { inicio: '2026-11-20', fim: '2026-11-10' }), /depois do fim/);
  await assert.rejects(recuperacaoAgenda(deps(), { inicio: '2026-01-01', fim: '2026-11-26' }), new RegExp(`${MAX_DIAS_DO_PERIODO} dias`));
  await assert.rejects(recuperacaoAgenda(deps(), { janelaDias: 0 }), /janelaDias/);
  await assert.rejects(recuperacaoAgenda(deps(), { janelaDias: 500 }), /janelaDias/);
});

test('uma unidade que falha não derruba as outras: vai em «unidadesComFalha»', async () => {
  const r = await recuperacaoAgenda(deps({ 'doutor-hernia-acailandia': {}, 'doutor-hernia-serra': new Error('banco fora') }), {});
  assert.deepEqual((r.porUnidade as MedicaoDaUnidade[]).map((m) => m.unidade), ['doutor-hernia-acailandia']);
  assert.deepEqual(r.unidadesComFalha, [{ unidade: 'doutor-hernia-serra', erro: 'banco fora' }]);
});

test('a ferramenta é de LEITURA e se chama recuperacao_agenda; a resposta não leva nome nem telefone', async () => {
  const registradas: Array<{ nome: string; config: { annotations?: { readOnlyHint?: boolean } } }> = [];
  const server = { registerTool: (nome: string, config: never) => registradas.push({ nome, config }) } as never;
  registrarRecuperacaoAgenda(server, deps());
  assert.equal(registradas.length, 1);
  assert.equal(registradas[0].nome, 'recuperacao_agenda');
  assert.equal(registradas[0].config.annotations?.readOnlyHint, true);
  const json = JSON.stringify(await recuperacaoAgenda(deps({ 'doutor-hernia-acailandia': {} }), {}));
  assert.doesNotMatch(json, /\d{5}-?\d{4}|\+55/);
});
