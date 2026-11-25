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

test('cache de 60 s, uma leitura por vez; erro do banco = a última lista boa (ou nenhuma), sem lançar', async () => {
  _esquecerCacheDoGuia();
  let leituras = 0;
  const ok = async () => (leituras++, [{ contaId: 3, acceptsAdvancePayment: false as boolean | null }]);
  const [a, b] = await Promise.all([contasSemAntecipado(ok, 1_000), contasSemAntecipado(ok, 1_000)]);
  assert.deepEqual([a, b], [[3], [3]]);
  assert.equal(leituras, 1, 'dois pedidos juntos = uma leitura');
  assert.deepEqual(await contasSemAntecipado(ok, 30_000), [3]);
  assert.equal(leituras, 1, 'dentro de 60 s não lê de novo');
  const cai = async (): Promise<never> => { throw new Error('banco fora'); };
  assert.deepEqual(await contasSemAntecipado(cai, 70_000), [3], 'banco caiu: fica a última lista boa');
  assert.deepEqual(await contasSemAntecipado(ok, 70_000 + 6_000), [3], 'depois de ~5 s tenta o banco de novo (não espera o minuto)');
  assert.equal(leituras, 2);
  _esquecerCacheDoGuia();
  assert.deepEqual(await contasSemAntecipado(cai, 1_000), [], 'sem lista boa antes: nenhuma conta (o guia segue como sempre)');
});
