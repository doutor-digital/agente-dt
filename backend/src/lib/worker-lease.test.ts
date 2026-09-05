import { test } from 'node:test';
import assert from 'node:assert/strict';

import { criarSupervisor, type Reivindicacao } from './worker-lease.js';

/**
 * Dois containers do backend rodaram lado a lado por 18 h (04→05/09/2026) e cada
 * follow-up saiu duas vezes. O supervisor decide, a partir da resposta do banco,
 * se ESTE processo liga ou desliga os workers. O que importa testar é a
 * transição — ligar só uma vez, desligar quando outro assume, e o que acontece
 * quando o banco não responde.
 */

function cenario(respostas: Reivindicacao[], falhasParaAbrir = 3) {
  const fila = [...respostas];
  const chamadas = { iniciar: 0, parar: 0 };
  const sup = criarSupervisor({
    reivindicar: async () => fila.shift() ?? 'de-outro',
    iniciar: () => void (chamadas.iniciar += 1),
    parar: () => void (chamadas.parar += 1),
    dono: 'teste#1',
    falhasParaAbrir,
  });
  return { sup, chamadas };
}

test('quem ganha o lease liga os workers uma vez só, mesmo renovando várias vezes', async () => {
  const { sup, chamadas } = cenario(['minha', 'minha', 'minha']);
  for (let i = 0; i < 3; i++) await sup.tick();
  assert.equal(chamadas.iniciar, 1);
  assert.equal(chamadas.parar, 0);
  assert.equal(sup.estado().lider, true);
  assert.equal(sup.estado().modo, 'lease');
});

test('quem não ganha o lease fica aguardando sem ligar nada', async () => {
  const { sup, chamadas } = cenario(['de-outro', 'de-outro']);
  await sup.tick();
  await sup.tick();
  assert.equal(chamadas.iniciar, 0);
  assert.equal(sup.estado().lider, false);
  assert.equal(sup.estado().modo, 'aguardando');
});

test('perder o lease para outro processo desliga os workers aqui', async () => {
  const { sup, chamadas } = cenario(['minha', 'de-outro', 'minha']);
  await sup.tick();
  await sup.tick();
  assert.equal(chamadas.parar, 1);
  assert.equal(sup.estado().lider, false);
  // e volta a ligar quando recupera
  await sup.tick();
  assert.equal(chamadas.iniciar, 2);
  assert.equal(sup.estado().lider, true);
});

test('erro transitório de banco NÃO derruba o líder', async () => {
  const { sup, chamadas } = cenario(['minha', 'erro', 'erro', 'erro', 'erro', 'minha']);
  for (let i = 0; i < 6; i++) await sup.tick();
  assert.equal(chamadas.parar, 0);
  assert.equal(sup.estado().lider, true);
  assert.equal(sup.estado().modo, 'lease');
  assert.equal(sup.estado().falhasSeguidas, 0);
});

test('sem banco por 3 verificações seguidas, o não-líder liga por precaução (fail-open)', async () => {
  const { sup, chamadas } = cenario(['erro', 'erro', 'erro']);
  await sup.tick();
  await sup.tick();
  assert.equal(chamadas.iniciar, 0, 'duas falhas ainda é cedo');
  await sup.tick();
  assert.equal(chamadas.iniciar, 1);
  assert.equal(sup.estado().lider, true);
  assert.equal(sup.estado().modo, 'sem-lease');
});

test('quem ligou sem lease cede assim que o banco volta e mostra outro dono', async () => {
  const { sup, chamadas } = cenario(['erro', 'erro', 'erro', 'de-outro']);
  for (let i = 0; i < 4; i++) await sup.tick();
  assert.equal(chamadas.parar, 1);
  assert.equal(sup.estado().lider, false);
});

test('quem ligou sem lease e depois consegue o lease só troca o modo, sem religar', async () => {
  const { sup, chamadas } = cenario(['erro', 'erro', 'erro', 'minha']);
  for (let i = 0; i < 4; i++) await sup.tick();
  assert.equal(chamadas.iniciar, 1);
  assert.equal(sup.estado().modo, 'lease');
});

test('o estado devolvido é uma cópia: mexer nele não altera o supervisor', async () => {
  const { sup } = cenario(['minha']);
  const e = await sup.tick();
  e.lider = false;
  assert.equal(sup.estado().lider, true);
});
