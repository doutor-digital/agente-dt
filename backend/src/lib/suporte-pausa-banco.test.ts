import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { _zerarAvisoDeFalhaParaTeste, menuPausado } from './suporte-pausa-banco.js';
import { SEM_PAUSA, type ArmazemPausa } from './suporte-pausa.js';

const armazem = (ler: ArmazemPausa['ler']): ArmazemPausa => ({ ler, gravar: async () => SEM_PAUSA });

beforeEach(() => _zerarAvisoDeFalhaParaTeste());

test('menuPausado: reflete a chave', async () => {
  const sem = async () => false;
  assert.equal(await menuPausado(armazem(async () => SEM_PAUSA), sem), false);
  assert.equal(await menuPausado(armazem(async () => ({ pausado: true, desde: new Date(), por: 'telegram', ignoradas: 0 })), sem), true);
});

test('menuPausado: não conseguiu ler → trata como PAUSADO e avisa o João no Telegram, uma vez por hora', async () => {
  const avisos: string[] = [];
  const quebrado = armazem(async () => Promise.reject(new Error('banco fora')));
  const avisar = async (t: string) => {
    avisos.push(t);
    return true;
  };
  assert.equal(await menuPausado(quebrado, avisar), true);
  assert.equal(await menuPausado(quebrado, avisar), true);
  assert.equal(await menuPausado(quebrado, avisar), true);
  assert.equal(avisos.length, 1, 'não repete o aviso a cada mensagem');
  assert.match(avisos[0]!, /não consegui ler a chave de pausa/);
});
