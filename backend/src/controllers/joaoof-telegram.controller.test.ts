import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { criarJoaoofTelegramHandler } from './joaoof-telegram.controller.js';
import { _zerarEstadoDoTelegram, type DepsTelegramJoao } from '../joaoof/telegram-joao.js';
import { repoEmMemoria } from '../joaoof/repo.js';

const SEGREDO = 'segredo-do-webhook-de-teste';

function chamar(segredo: string | undefined, corpo: unknown) {
  _zerarEstadoDoTelegram();
  const respostas: string[] = [];
  const deps: DepsTelegramJoao = {
    repo: repoEmMemoria(),
    modo: () => 'ligado',
    agora: () => new Date(),
    chatPermitido: () => '7822226023',
    responder: async (t) => {
      respostas.push(t);
      return true;
    },
    executar: async () => ({ resposta: 'ok', passos: 1, chamadasDeFerramenta: [], resultadosDeFerramenta: [], parou: null, custoUsd: 0 }),
    textoDoCusto: async () => '',
    alertas: async () => [],
  };
  const handler = criarJoaoofTelegramHandler(() => deps, { JOAOOF_TELEGRAM_SEGREDO: SEGREDO } as NodeJS.ProcessEnv);
  let status = 0;
  const req = { get: (n: string) => (n.toLowerCase() === 'x-telegram-bot-api-secret-token' ? segredo : undefined), body: corpo, ip: '1.1.1.1' } as unknown as Request;
  const res = { status: (s: number) => ((status = s), { json: () => undefined }) } as unknown as Response;
  handler(req, res);
  return { status: () => status, respostas };
}

const corpo = { update_id: 1, message: { text: 'feito', chat: { id: 7822226023, type: 'private' }, from: { id: 7822226023, is_bot: false } } };

test('sem o segredo no cabeçalho: 401 e nada é tratado', async () => {
  const r = chamar(undefined, corpo);
  await new Promise((x) => setTimeout(x, 20));
  assert.equal(r.status(), 401);
  assert.equal(r.respostas.length, 0);
  const errado = chamar('outro-segredo', corpo);
  assert.equal(errado.status(), 401);
});

test('com o segredo: 200 na hora e a mensagem do João é tratada', async () => {
  const r = chamar(SEGREDO, corpo);
  assert.equal(r.status(), 200);
  await new Promise((x) => setTimeout(x, 30));
  assert.deepEqual(r.respostas, ['ok']);
});

test('segredo não configurado no servidor = recusa tudo', () => {
  const h = criarJoaoofTelegramHandler(() => ({}) as DepsTelegramJoao, {} as NodeJS.ProcessEnv);
  let status = 0;
  h({ get: () => 'qualquer', body: corpo, ip: 'x' } as unknown as Request, { status: (s: number) => ((status = s), { json: () => undefined }) } as unknown as Response);
  assert.equal(status, 401);
});
