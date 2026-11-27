import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registrarEvento, type DepsVigia } from './vigia.js';
import { entradaEmMemoria } from './entrada.js';
import type { ModoJoaoof } from './config.js';

const montar = (modo: ModoJoaoof) => {
  const entradas = entradaEmMemoria();
  const deps: DepsVigia = { entradas, modo: () => modo, agora: () => new Date('2026-11-27T15:00:00Z') };
  return { entradas, deps };
};
const ev = { id: 'sofia-parou:parauapebas:14h', unidadeSlug: 'doutor-hernia-parauapebas', tipo: 'sofia_parada', severidade: 'critico' as const, texto: 'Sofia sem responder há 42 min (7 conversas) — paciente 94 99533-4370' };

test('evento vira entrada da fila (mascarada) e o mesmo id repetido não duplica', async () => {
  const { deps, entradas } = montar('seco');
  assert.equal(await registrarEvento(deps, ev), 'registrado');
  assert.equal(await registrarEvento(deps, ev), 'repetido');
  assert.equal(entradas._itens.length, 1);
  assert.equal(entradas._itens[0]!.fonte, 'vigia');
  assert.equal(entradas._itens[0]!.severidade, 'critico');
  assert.match(entradas._itens[0]!.texto, /^\[sofia_parada\] Sofia sem responder/);
  assert.doesNotMatch(entradas._itens[0]!.texto, /99533/);
});

test('desligado não grava nada; evento sem id ou sem texto é inválido', async () => {
  const off = montar('desligado');
  assert.equal(await registrarEvento(off.deps, ev), 'desligado');
  assert.equal(off.entradas._itens.length, 0);
  const { deps } = montar('ligado');
  assert.equal(await registrarEvento(deps, { ...ev, id: '' }), 'invalido');
  assert.equal(await registrarEvento(deps, { ...ev, texto: '  ' }), 'invalido');
});

test('o banco caindo não derruba quem chama (o vigia não pode cair por causa do Joaoof)', async () => {
  const { deps } = montar('ligado');
  deps.entradas.inserir = async () => {
    throw new Error('banco fora');
  };
  assert.equal(await registrarEvento(deps, ev), 'invalido');
});
