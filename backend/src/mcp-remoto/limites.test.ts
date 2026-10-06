import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request } from 'express';
import { ipDoCliente, JanelaDeContagem, Semaforo } from './limites.js';

const req = (xff?: string, remoto = '10.0.0.1') => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: remoto } }) as unknown as Request;

test('ipDoCliente: vale o ÚLTIMO do X-Forwarded-For (o que o Traefik acrescentou), não o primeiro', () => {
  assert.equal(ipDoCliente(req('6.6.6.6, 200.1.2.3')), '200.1.2.3'); // o 6.6.6.6 o cliente pode inventar
  assert.equal(ipDoCliente(req('200.1.2.3')), '200.1.2.3');
  assert.equal(ipDoCliente(req()), '10.0.0.1');
});

test('JanelaDeContagem: conta na janela e esquece depois', () => {
  const j = new JanelaDeContagem(3, 1000);
  for (const t of [0, 10, 20]) j.registrar('a', t);
  assert.equal(j.excedido('a', 30), true);
  assert.equal(j.excedido('b', 30), false);
  assert.equal(j.excedido('a', 1011), false); // o primeiro saiu da janela
});

test('JanelaDeContagem: e-mail aleatório a cada tentativa não faz o mapa crescer pra sempre', () => {
  const j = new JanelaDeContagem(8, 1000);
  for (let i = 0; i < 10_000; i++) j.registrar(`aleatorio-${i}@x.com`, 0);
  j.excedido('qualquer', 5000); // passada a janela, a próxima consulta varre
  assert.equal(j.tamanho, 0);
});

test('Semaforo: no máximo N juntos, fila anda, e quem espera demais desiste', async () => {
  const s = new Semaforo(2, 50);
  const a = await s.entrar();
  const b = await s.entrar();
  const c = s.entrar(); // espera
  a();
  a(); // sair duas vezes não abre vaga a mais
  const sairC = await c;
  await assert.rejects(s.entrar(), /ocupado/); // b e c ocupam; esta desiste em 50 ms
  b();
  sairC();
  (await s.entrar())();
});
