import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chaveDaFranquia, espacarCriacao } from './franquia-espacamento.js';

function relogio() {
  let t = 1_000_000;
  const dormidos: number[] = [];
  return { dormidos, agora: () => t, dormir: async (ms: number) => { dormidos.push(ms); t += ms; } };
}

test('criações da mesma franquia saem uma por vez, com o espaço combinado entre elas', async () => {
  const r = relogio();
  const ordem: string[] = [];
  const f = (nome: string) => espacarCriacao('franquia-A', async () => { ordem.push(`${nome}@${r.agora()}`); return nome; }, 1500, r.dormir, r.agora);
  const out = await Promise.all([f('a'), f('b'), f('c')]);
  assert.deepEqual(out, ['a', 'b', 'c']);
  const tempos = ordem.map((o) => Number(o.split('@')[1]));
  assert.ok(tempos[1] - tempos[0] >= 1500, `b veio ${tempos[1] - tempos[0]} ms depois de a`);
  assert.ok(tempos[2] - tempos[1] >= 1500, `c veio ${tempos[2] - tempos[1]} ms depois de b`);
});

test('franquias diferentes não esperam uma pela outra', async () => {
  const r = relogio();
  await Promise.all([
    espacarCriacao('franquia-X', async () => 1, 1500, r.dormir, r.agora),
    espacarCriacao('franquia-Y', async () => 2, 1500, r.dormir, r.agora),
  ]);
  assert.deepEqual(r.dormidos, []);
});

test('uma criação que falha não trava a fila das seguintes', async () => {
  const r = relogio();
  await assert.rejects(espacarCriacao('franquia-Z', async () => { throw new Error('boom'); }, 1500, r.dormir, r.agora), /boom/);
  assert.equal(await espacarCriacao('franquia-Z', async () => 'ok', 1500, r.dormir, r.agora), 'ok');
});

test('a chave da franquia junta a unidade e o -resgate que dividem o mesmo token', () => {
  assert.equal(chaveDaFranquia({ spineBaseUrl: 'https://x', spineToken: 't' }), chaveDaFranquia({ spineBaseUrl: 'https://x', spineToken: 't' }));
  assert.notEqual(chaveDaFranquia({ spineBaseUrl: 'https://x', spineToken: 't1' }), chaveDaFranquia({ spineBaseUrl: 'https://x', spineToken: 't2' }));
});
