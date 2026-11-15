import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comLimiteDeTempo, esperaDaPrimeiraCarga, manterAtualizado } from './manter-atualizado.js';

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('banco PENDURADO: a carga estoura o tempo, a 1ª carga conta como terminada e a nova tentativa É agendada (e acaba funcionando)', async () => {
  let chamadas = 0;
  let aplicado: string | null = null;
  const avisos: string[] = [];
  const primeira = manterAtualizado(
    () => {
      chamadas++;
      return chamadas === 1 ? new Promise<string>(() => undefined) : Promise.resolve('lista');
    },
    (v) => (aplicado = v),
    'quem escolhe a conta',
    { limiteMs: 40, tentarDeNovoMs: 40, renovarMs: 10_000, log: { warn: (_o, m) => void avisos.push(String(m)) } },
  );
  await primeira; // não fica preso: a 1ª carga termina (por tempo) mesmo com o banco pendurado
  assert.equal(aplicado, null);
  await dormir(150);
  assert.ok(chamadas >= 2, 'a nova tentativa foi agendada');
  assert.equal(aplicado, 'lista');
  assert.ok(avisos.some((a) => /não consegui ler quem escolhe a conta/.test(a)));
});

test('sem o limite de tempo o banco pendurado não agendaria nada: comLimiteDeTempo rejeita e libera o timer', async () => {
  await assert.rejects(comLimiteDeTempo(new Promise(() => undefined), 30, 'lista'), /passou de 30 ms/);
  assert.equal(await comLimiteDeTempo(Promise.resolve(7), 1000, 'x'), 7);
});

test('a espera da 1ª carga acontece UMA vez: depois do prazo, os pedidos seguintes não esperam mais (banco pendurado)', async () => {
  const pendurada = new Promise<void>(() => undefined);
  const aguardar = esperaDaPrimeiraCarga([pendurada], 120);
  const t0 = Date.now();
  const a = aguardar();
  const b = aguardar(); // pedido simultâneo: espera a MESMA espera, não outra de 120 ms
  await Promise.all([a, b]);
  const primeira = Date.now() - t0;
  assert.ok(primeira >= 100 && primeira < 400, `1ª espera ${primeira} ms`);
  const t1 = Date.now();
  await aguardar();
  await aguardar();
  assert.ok(Date.now() - t1 < 30, 'a partir do 2º pedido não há mais espera');
});

test('se as cargas terminam antes do prazo, a espera termina na hora', async () => {
  const aguardar = esperaDaPrimeiraCarga([Promise.resolve(), dormir(30)], 2000);
  const t0 = Date.now();
  await aguardar();
  assert.ok(Date.now() - t0 < 500);
});
