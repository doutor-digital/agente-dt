import { test } from 'node:test';
import assert from 'node:assert/strict';

const { contasSemAntecipadoDe, contasSemAntecipado, _esquecerCacheDoGuia } = await import('./guia-sem-antecipado.js');

test('conta entra só se TODAS as unidades dela dizem «não aceita antecipado» (false); null, true, conta sem id ou inválida ficam de fora', () => {
  assert.deepEqual(contasSemAntecipadoDe([{ contaId: 3, acceptsAdvancePayment: false }]), [3]);
  assert.deepEqual(contasSemAntecipadoDe([{ contaId: 3, acceptsAdvancePayment: false }, { contaId: 3, acceptsAdvancePayment: true }]), [], 'conta dividida: uma aceita, nenhuma é «sem»');
  assert.deepEqual(contasSemAntecipadoDe([{ contaId: 4, acceptsAdvancePayment: null }, { contaId: null, acceptsAdvancePayment: false }, { contaId: 0, acceptsAdvancePayment: false }, { contaId: -2, acceptsAdvancePayment: false }]), []);
  // taxa de reserva obrigatória (Boa Vista) VENCE: a unidade é «com antecipado» mesmo com accepts=false
  assert.deepEqual(contasSemAntecipadoDe([{ contaId: 5, acceptsAdvancePayment: false, spineBookingRequiresPayment: true }]), []);
  assert.deepEqual(contasSemAntecipadoDe([{ contaId: 5, acceptsAdvancePayment: false, spineBookingRequiresPayment: false }]), [5]);
  assert.deepEqual(contasSemAntecipadoDe([{ contaId: 9, acceptsAdvancePayment: false }, { contaId: 3, acceptsAdvancePayment: false }, { contaId: 2, acceptsAdvancePayment: true }]), [3, 9]);
});

const tick = () => new Promise((r) => setImmediate(r));

test('unidade DESATIVADA não decide a conta: não veta a lista (conta com uma ativa «sem» e uma desativada «com») e conta só de desativadas fica de fora', () => {
  assert.deepEqual(contasSemAntecipadoDe([{ contaId: 3, acceptsAdvancePayment: false, isActive: true }, { contaId: 3, acceptsAdvancePayment: true, isActive: false }]), [3]);
  assert.deepEqual(contasSemAntecipadoDe([{ contaId: 3, acceptsAdvancePayment: false, isActive: false }]), []);
  assert.deepEqual(contasSemAntecipadoDe([{ contaId: 3, acceptsAdvancePayment: false }]), [3], 'sem o campo = ativa');
});

test('lista fresca não relê; lista VELHA volta na hora e renova por trás; erro do banco mantém a última lista boa', async () => {
  _esquecerCacheDoGuia();
  let leituras = 0;
  const ok = async () => (leituras++, [{ contaId: 3, acceptsAdvancePayment: false as boolean | null }]);
  const [a, b] = await Promise.all([contasSemAntecipado(ok, 1_000), contasSemAntecipado(ok, 1_000)]);
  assert.deepEqual([a, b], [[3], [3]]);
  assert.equal(leituras, 1, 'dois pedidos juntos = uma leitura');
  assert.deepEqual(await contasSemAntecipado(ok, 30_000), [3]);
  assert.equal(leituras, 1, 'dentro de 60 s não lê de novo');
  const cai = async (): Promise<never> => { throw new Error('banco fora'); };
  assert.deepEqual(await contasSemAntecipado(cai, 70_000), [3], 'velha: volta na hora (a renovação falha por trás e fica a última lista boa)');
  await tick();
  assert.deepEqual(await contasSemAntecipado(ok, 76_000), [3], 'ainda velha: volta na hora');
  await tick();
  assert.equal(leituras, 2, 'e renovou por trás (depois de ~5 s do erro)');
  _esquecerCacheDoGuia();
  assert.deepEqual(await contasSemAntecipado(cai, 1_000, 50), [], 'sem lista boa antes: nenhuma conta (o guia segue como sempre)');
});

test('leitor que NUNCA responde: o menu não espera (sai com [] no prazo) e a leitura que chegar depois renova a lista; com lista velha nem espera', async () => {
  _esquecerCacheDoGuia();
  let responder!: (l: Array<{ contaId: number; acceptsAdvancePayment: boolean }>) => void;
  const preso = () => new Promise<Array<{ contaId: number; acceptsAdvancePayment: boolean }>>((r) => (responder = r));
  const t0 = Date.now();
  assert.deepEqual(await contasSemAntecipado(preso, 1_000, 30), []);
  assert.ok(Date.now() - t0 < 400, `esperou ${Date.now() - t0} ms: o prazo era 30`);
  // outro pedido enquanto a leitura segue presa: também sai no prazo, sem abrir uma 2ª leitura
  let leituras = 0;
  const outro = async () => (leituras++, []);
  assert.deepEqual(await contasSemAntecipado(outro, 1_100, 30), []);
  assert.equal(leituras, 0, 'não abre outra leitura enquanto uma está presa');
  responder([{ contaId: 3, acceptsAdvancePayment: false }]);
  await tick();
  await tick();
  assert.deepEqual(await contasSemAntecipado(outro, 1_200, 30), [3], 'a leitura atrasada chegou e vale');
  // lista velha + leitor preso: volta na hora com a velha
  const t1 = Date.now();
  assert.deepEqual(await contasSemAntecipado(preso, 1_000_000, 30_000), [3]);
  assert.ok(Date.now() - t1 < 200, 'com lista velha não espera o leitor (o prazo era de 30 s)');
});

test('leitor que LANÇA de forma síncrona não deixa a trava presa: devolve [] e relê depois', async () => {
  _esquecerCacheDoGuia();
  let chamadas = 0;
  const sincrono = (): Promise<never> => { chamadas++; throw new Error('síncrono'); };
  assert.deepEqual(await contasSemAntecipado(sincrono, 1_000, 50), []);
  await tick();
  assert.equal(chamadas, 1);
  assert.deepEqual(await contasSemAntecipado(sincrono, 7_000, 50), []);
  await tick();
  assert.equal(chamadas, 2, 'a trava soltou: leu de novo');
  const ok = async () => [{ contaId: 5, acceptsAdvancePayment: false as boolean | null }];
  assert.deepEqual(await contasSemAntecipado(ok, 14_000, 50), [], 'lista velha (vazia): volta na hora e renova por trás');
  await tick();
  assert.deepEqual(await contasSemAntecipado(ok, 14_500, 50), [5], 'a renovação por trás chegou');
});
