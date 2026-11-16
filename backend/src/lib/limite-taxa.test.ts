import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarLimitador, ipDoCliente } from './limite-taxa.js';

test('deixa passar até o máximo, recusa o resto dizendo quanto esperar, e reabre na próxima janela', () => {
  let t = 1_000_000;
  const l = criarLimitador({ max: 3, janelaMs: 60_000, agora: () => t });
  assert.deepEqual([1, 2, 3].map(() => l.tentar('a').ok), [true, true, true]);
  const r = l.tentar('a');
  assert.equal(r.ok, false);
  assert.equal(r.esperarSeg, 60);
  t += 30_000;
  assert.equal(l.tentar('a').esperarSeg, 30);
  assert.equal(l.tentar('b').ok, true, 'outra chave não é afetada');
  t += 30_000;
  assert.equal(l.tentar('a').ok, true, 'janela nova');
});

test('espiar não conta, e mostra se a chave já está bloqueada', () => {
  const l = criarLimitador({ max: 2, janelaMs: 60_000 });
  assert.equal(l.espiar('a').ok, true);
  l.tentar('a');
  l.tentar('a');
  assert.equal(l.espiar('a').ok, false, 'no limite: a PRÓXIMA tentativa seria recusada');
  assert.equal(l.espiar('a').ok, false);
  assert.equal(l.espiar('b').ok, true);
});

test('encher a tabela com muitos IPs não apaga o bloqueio de quem já estourou', () => {
  let t = 0;
  const l = criarLimitador({ max: 2, janelaMs: 1_000_000, agora: () => t, maxChaves: 20 });
  for (let i = 0; i < 2; i++) l.tentar('mau');
  assert.equal(l.espiar('mau').ok, false);
  for (let i = 0; i < 500; i++) {
    t += 1;
    l.tentar(`ip${i}`);
  }
  assert.equal(l.espiar('mau').ok, false, 'o bloqueio sobrevive');
});

test('a tabela não cresce sem fim sob muitos IPs', () => {
  let t = 0;
  const l = criarLimitador({ max: 1, janelaMs: 1_000_000, agora: () => t, maxChaves: 50 });
  for (let i = 0; i < 5000; i++) {
    t += 1;
    assert.equal(l.tentar(`ip${i}`).ok, true);
  }
  // o mais recente continua contado; um IP antigo, já descartado, volta a poder tentar (preferimos isso a crescer sem fim)
  assert.equal(l.tentar('ip4999').ok, false);
});

test('IP do cliente: vale o ÚLTIMO do X-Forwarded-For (o que o proxy acrescentou), não o que o cliente escreveu', () => {
  const req = (xff: string | string[] | undefined, remoto = '10.0.0.9') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remoto } }) as never;
  assert.equal(ipDoCliente(req('9.9.9.9, 203.0.113.7')), '203.0.113.7');
  assert.equal(ipDoCliente(req('203.0.113.7')), '203.0.113.7');
  assert.equal(ipDoCliente(req(['1.1.1.1', '203.0.113.8'])), '203.0.113.8');
  assert.equal(ipDoCliente(req(undefined)), '10.0.0.9');
  assert.equal(ipDoCliente(req('')), '10.0.0.9');
});
