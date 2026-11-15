import assert from 'node:assert/strict';
import { test } from 'node:test';
import { esperaDaPrimeiraCarga, manterAtualizado } from './manter-atualizado.js';

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('banco PENDURADO por 3 ciclos: UMA consulta em curso, nunca mais; a 1ª carga é liberada pelo limite; quando a pendurada termina, aplica e o ciclo segue', async () => {
  let chamadas = 0;
  let aplicado: string | null = null;
  let terminar: (v: string) => void = () => undefined;
  const avisos: string[] = [];
  const primeira = manterAtualizado(
    () => {
      chamadas++;
      return chamadas === 1 ? new Promise<string>((r) => (terminar = r)) : Promise.resolve(`lista-${chamadas}`);
    },
    (v) => (aplicado = v),
    'quem escolhe a conta',
    { limiteMs: 30, tentarDeNovoMs: 30, renovarMs: 10_000, log: { warn: (_o, m) => void avisos.push(String(m)) } },
  );
  await primeira; // não fica preso: o limite libera quem espera
  await dormir(30 * 3 * 3); // bem mais que 3 ciclos de limite + retentativa
  assert.equal(chamadas, 1, 'com a consulta presa, NENHUMA consulta nova é iniciada (1 em curso, nunca mais)');
  assert.equal(aplicado, null);
  assert.ok(avisos.some((a) => /passou de 30 ms/.test(a)));
  terminar('tarde'); // a pendurada finalmente responde: aplica o resultado e o ciclo continua
  await dormir(20);
  assert.equal(aplicado, 'tarde');
});

test('consulta pendurada que acaba em ERRO: depois do erro, a nova tentativa é agendada (e só uma por vez)', async () => {
  let chamadas = 0;
  let falhar: (e: Error) => void = () => undefined;
  let aplicado: string | null = null;
  await manterAtualizado(
    () => {
      chamadas++;
      return chamadas === 1 ? new Promise<string>((_r, rej) => (falhar = rej)) : Promise.resolve('ok');
    },
    (v) => (aplicado = v),
    'lista',
    { limiteMs: 30, tentarDeNovoMs: 30, renovarMs: 10_000, log: { warn: () => undefined } },
  );
  await dormir(120);
  assert.equal(chamadas, 1);
  falhar(new Error('banco caiu'));
  await dormir(150);
  assert.equal(chamadas, 2, 'só depois de a presa terminar é que a nova começa');
  assert.equal(aplicado, 'ok');
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
