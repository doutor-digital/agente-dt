import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nivelDoGasto, usoDaResposta } from './custo.js';
import { orcamentoDoJoaoof } from './config.js';
import { freioDeTeste } from './teste-util.js';

const cfg = orcamentoDoJoaoof({});

test('níveis: normal < 80% ≤ aviso < 100% ≤ parado', () => {
  assert.equal(nivelDoGasto(100, cfg).nivel, 'normal');
  assert.equal(nivelDoGasto(239.99, cfg).nivel, 'normal');
  assert.equal(nivelDoGasto(240, cfg).nivel, 'aviso');
  assert.equal(nivelDoGasto(299.99, cfg).nivel, 'aviso');
  assert.equal(nivelDoGasto(300, cfg).nivel, 'parado');
});

test('freio: abaixo de 80% deixa passar e não avisa', async () => {
  const { freio, avisos } = freioDeTeste({ gastoUsd: 10 }); // R$ 58
  assert.equal(await freio.permitir(), true);
  assert.equal(avisos.length, 0);
});

test('freio: em 80% segue e avisa UMA vez no mês', async () => {
  const { freio, avisos } = freioDeTeste({ gastoUsd: 42 }); // R$ 243,6
  assert.equal(await freio.permitir(), true);
  assert.equal(await freio.permitir(), true);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0]!, /81%|82%|84%/);
});

test('freio: em 100% PARA, avisa uma vez e continua parado', async () => {
  const { freio, avisos } = freioDeTeste({ gastoUsd: 52 }); // R$ 301,6
  assert.equal(await freio.permitir(), false);
  assert.equal(await freio.permitir(), false);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0]!, /PAROU/);
});

test('freio: falha ao ler o gasto = NÃO chama o modelo (fail-closed)', async () => {
  const { freio } = freioDeTeste({ falhaNaLeitura: true });
  assert.equal(await freio.permitir(), false);
});

test('freio: o gasto desta instância soma antes de o banco refletir (rajada não passa do teto)', async () => {
  const { freio, chamadas } = freioDeTeste({ gastoUsd: 51 }); // R$ 295,8 — perto do teto
  assert.equal(await freio.permitir(), true);
  const custo = await freio.registrar({ papel: 'triagem', modelo: 'm', uso: { entrada: 1_000_000, saida: 200_000, cacheLeitura: 0, cacheEscrita: 0 }, latenciaMs: 5, status: 'success' });
  assert.equal(custo, 2); // US$ 1 + US$ 1
  assert.equal(chamadas.length, 1);
  assert.equal(await freio.permitir(), false); // 51 + 2 = 53 USD → R$ 307
});

test('o teto sobe pela chave: com 600 de teto, R$ 301 ainda passa', async () => {
  const { freio } = freioDeTeste({ gastoUsd: 52 }, { JOAOOF_TETO_BRL: '600' });
  assert.equal(await freio.permitir(), true);
});

test('usoDaResposta lê usage_metadata do LangChain e devolve zeros sem ele', () => {
  assert.deepEqual(usoDaResposta({ usage_metadata: { input_tokens: 10, output_tokens: 4, input_token_details: { cache_read: 3, cache_creation: 2 } } }), { entrada: 10, saida: 4, cacheLeitura: 3, cacheEscrita: 2 });
  assert.deepEqual(usoDaResposta({}), { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 });
  assert.deepEqual(usoDaResposta(null), { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 });
});

test('se a gravação em llm_calls FALHA, o custo continua na conta (o teto não falha aberto)', async () => {
  const { freio, deps } = freioDeTeste({ gastoUsd: 50 }); // R$ 290
  deps.gravarChamada = async () => {
    throw new Error('tabela indisponível');
  };
  assert.equal(await freio.permitir(), true);
  await freio.registrar({ papel: 'triagem', modelo: 'm', uso: { entrada: 1_000_000, saida: 200_000, cacheLeitura: 0, cacheEscrita: 0 }, latenciaMs: 5, status: 'success' }); // US$ 2
  assert.equal(await freio.permitir(), false); // 50 + 2 → R$ 301,6
});

test('custo em voo (ainda não gravado) não some quando o banco é relido', async () => {
  const { freio, deps } = freioDeTeste({ gastoUsd: 51, agora: (() => { let t = new Date('2026-11-27T15:00:00Z').getTime(); return () => new Date((t += 40_000)); })() });
  let liberaGravacao!: () => void;
  deps.gravarChamada = () => new Promise<void>((r) => (liberaGravacao = r));
  assert.equal(await freio.permitir(), true);
  const registro = freio.registrar({ papel: 'triagem', modelo: 'm', uso: { entrada: 1_000_000, saida: 200_000, cacheLeitura: 0, cacheEscrita: 0 }, latenciaMs: 5, status: 'success' });
  // o relógio anda 40 s por consulta: a leitura seguinte vai ao banco, que ainda NÃO tem a chamada em voo
  assert.equal(await freio.permitir(), false);
  liberaGravacao();
  await registro;
});

test('aviso do teto: só é marcado DEPOIS de entregue (Telegram fora = tenta de novo na próxima); em seco o prefixo seco: separa as marcas', async () => {
  const { freio, deps, avisos, estado } = freioDeTeste({ gastoUsd: 42 });
  let entrega = false;
  deps.avisar = async (t) => (avisos.push(t), entrega);
  assert.equal(await freio.permitir(), true);
  assert.equal(estado.size, 0, 'não entregou: não marca');
  entrega = true;
  await freio.permitir();
  assert.equal(estado.size, 1);
  await freio.permitir();
  assert.equal(avisos.length, 2, 'duas tentativas (a 1ª falhou), nenhuma depois de entregue');
  // seco: marca com outro prefixo
  const seco = freioDeTeste({ gastoUsd: 42 });
  seco.deps.prefixoDaChave = () => 'seco:';
  const f2 = (await import('./custo.js')).criarFreio(seco.deps, (await import('./config.js')).orcamentoDoJoaoof({}));
  await f2.permitir();
  assert.ok([...seco.estado][0]!.startsWith('seco:freio:'));
});

test('teto 0 = não gasta nada (para na primeira chamada), não «volta para 300»', async () => {
  const { freio } = freioDeTeste({ gastoUsd: 0 }, { JOAOOF_TETO_BRL: '0' });
  assert.equal(await freio.permitir(), false);
});

test('custo que não gravou fica no mês em que ocorreu (não vaza para o mês seguinte)', async () => {
  let agora = new Date('2026-11-30T15:00:00Z').getTime();
  const { freio, deps } = freioDeTeste({ gastoUsd: 20, agora: () => new Date(agora) });
  deps.gravarChamada = async () => {
    throw new Error('tabela fora');
  };
  await freio.permitir();
  await freio.registrar({ papel: 'triagem', modelo: 'm', uso: { entrada: 6_000_000, saida: 2_000_000, cacheLeitura: 0, cacheEscrita: 0 }, latenciaMs: 5, status: 'success' }); // US$ 16
  assert.equal((await freio.situacao()).gastoBrl > 200, true); // 20 + 16 = 36 US$ ≈ R$ 209 em novembro
  agora = new Date('2026-12-01T15:00:00Z').getTime();
  const dez = await freio.situacao();
  assert.ok(Math.abs(dez.gastoBrl - 20 * 5.8) < 0.01, 'em dezembro só vale o que o banco mostra');
});
