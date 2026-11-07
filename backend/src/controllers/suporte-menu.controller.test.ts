import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

import { suporteMenuWebhookHandler } from './suporte-menu.controller.js';

const ENV_ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.SUPORTE_MENU_SEGREDO = 'segredo-do-teste';
  process.env.SUPORTE_EVO_INSTANCIA = 'analista-dt';
  delete process.env.SUPORTE_MENU;
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ENV_ORIGINAL)) delete process.env[k];
  Object.assign(process.env, ENV_ORIGINAL);
});

function chamar(opcoes: { query?: Record<string, unknown>; cabecalho?: string; corpo?: unknown }) {
  const resposta: { status: number | null; json: unknown } = { status: null, json: null };
  const req = {
    query: opcoes.query ?? {},
    body: opcoes.corpo ?? {},
    ip: '127.0.0.1',
    get: (n: string) => (n.toLowerCase() === 'x-suporte-segredo' ? opcoes.cabecalho : undefined),
  } as unknown as Request;
  const res = {
    status(c: number) {
      resposta.status = c;
      return this;
    },
    json(j: unknown) {
      resposta.json = j;
      return this;
    },
  } as unknown as Response;
  suporteMenuWebhookHandler(req, res);
  return resposta;
}

test('sem segredo, segredo errado ou segredo em lista: 401, sem dizer o porquê', () => {
  assert.equal(chamar({}).status, 401);
  assert.equal(chamar({ query: { k: 'errado' } }).status, 401);
  assert.equal(chamar({ query: { k: ['segredo-do-teste'] } }).status, 401);
  assert.deepEqual(chamar({ query: { k: 'errado' } }).json, { ok: false });
});

test('sem segredo configurado no servidor: recusa tudo, até a string vazia', () => {
  delete process.env.SUPORTE_MENU_SEGREDO;
  assert.equal(chamar({ query: { k: '' } }).status, 401);
  assert.equal(chamar({ query: { k: 'qualquer' } }).status, 401);
});

test('segredo certo (na URL ou no cabeçalho) com o menu DESLIGADO: 200 e não faz nada', () => {
  assert.deepEqual(chamar({ query: { k: 'segredo-do-teste' } }).json, { ok: true, ignorado: 'desligado' });
  assert.equal(chamar({ cabecalho: 'segredo-do-teste' }).status, 200);
});

test('menu em modo seco: evento que não é mensagem recebida é respondido 200 com o motivo e nada mais', () => {
  process.env.SUPORTE_MENU = 'seco';
  const r = chamar({ query: { k: 'segredo-do-teste' }, corpo: { event: 'connection.update', instance: 'analista-dt' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, ignorado: 'evento ignorado' });
  const grupo = chamar({
    query: { k: 'segredo-do-teste' },
    corpo: { event: 'messages.upsert', instance: 'analista-dt', data: { key: { remoteJid: '1203@g.us', id: 'X', fromMe: false }, message: { conversation: 'oi' } } },
  });
  assert.deepEqual(grupo.json, { ok: true, ignorado: 'não é conversa individual' });
});
