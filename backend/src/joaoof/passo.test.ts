import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enviarResumoDaHora, passoDoJoaoof, type DepsPasso } from './passo.js';
import { repoEmMemoria } from './repo.js';
import type { ModoJoaoof } from './config.js';

function montar(modo: ModoJoaoof, quando: string) {
  let agora = new Date(quando);
  const repo = repoEmMemoria(() => agora);
  const enviados: string[] = [];
  let lotes = 0;
  const deps: DepsPasso = {
    repo,
    modo: () => modo,
    agora: () => agora,
    enviar: async (t) => {
      enviados.push(t);
      return true;
    },
    alertas: async () => [],
    lote: async () => {
      lotes++;
    },
    registrar: () => {},
  };
  return { repo, deps, enviados, lotes: () => lotes, andar: (q: string) => (agora = new Date(q)) };
}

test('8h de Brasília (11:00Z) manda o resumo UMA vez, mesmo com o passo rodando todo minuto', async () => {
  const { deps, enviados, repo, andar } = montar('ligado', '2026-11-27T11:00:00Z');
  await repo.criarDemanda({ titulo: 'Sofia parou em Parauapebas', prioridade: 'urgente' });
  for (let min = 0; min < 60; min += 1) {
    andar(`2026-11-27T11:${String(min).padStart(2, '0')}:10Z`);
    await passoDoJoaoof(deps);
  }
  assert.equal(enviados.length, 1);
  assert.match(enviados[0]!, /Bom dia, João/);
});

test('fora das 8h e das 18h não manda resumo; o lote roda em todo passo', async () => {
  const { deps, enviados, lotes } = montar('ligado', '2026-11-27T15:00:00Z'); // 12h em Brasília
  await passoDoJoaoof(deps);
  await passoDoJoaoof(deps);
  assert.equal(enviados.length, 0);
  assert.equal(lotes(), 2);
});

test('18h de Brasília = 21:00Z; 18h sem nada para dizer não manda', async () => {
  const vazio = montar('ligado', '2026-11-27T21:05:00Z');
  await passoDoJoaoof(vazio.deps);
  assert.equal(vazio.enviados.length, 0);
  const comDemanda = montar('ligado', '2026-11-27T21:05:00Z');
  await comDemanda.repo.criarDemanda({ titulo: 'Pedido importante da Açailândia', prioridade: 'alta' });
  await passoDoJoaoof(comDemanda.deps);
  assert.match(comDemanda.enviados[0]!, /Fechando o dia/);
});

test('desligado não faz nada; seco registra o resumo sem enviar', async () => {
  const off = montar('desligado', '2026-11-27T11:00:00Z');
  await passoDoJoaoof(off.deps);
  assert.equal(off.enviados.length, 0);
  assert.equal(off.repo._avisos.length, 0);
  assert.equal(off.lotes(), 0);
  const seco = montar('seco', '2026-11-27T11:00:00Z');
  await passoDoJoaoof(seco.deps);
  await passoDoJoaoof(seco.deps);
  assert.equal(seco.enviados.length, 0);
  assert.equal(seco.repo._avisos.length, 1);
  assert.equal(seco.repo._avisos[0]!.seco, true);
});

test('o resumo das 18h conta as resolvidas de hoje', async () => {
  const { deps, repo, enviados } = montar('ligado', '2026-11-27T21:05:00Z');
  const d = await repo.criarDemanda({ titulo: 'Pedido que já resolvi hoje cedo', prioridade: 'alta' });
  await repo.atualizarDemanda(d.numero, { status: 'feita' });
  await enviarResumoDaHora(deps, 18);
  assert.match(enviados[0]!, /Resolvidas hoje: 1/);
});
