import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

import { CABECALHO_SEGREDO, criarTelegramChamadosHandler, tratarAtualizacao, type DepsBot } from './suporte-bot-chamados.controller.js';
import { SEM_PAUSA, type EstadoPausa } from '../lib/suporte-pausa.js';

const JOAO = '7822226023';
const SEGREDO_FALSO = 'segredo-falso-de-teste';

function depsFalsas(chat = JOAO) {
  let estado: EstadoPausa = SEM_PAUSA;
  const enviadas: string[] = [];
  const deps: DepsBot = {
    chatPermitido: () => chat,
    responder: async (t) => {
      enviadas.push(t);
      return true;
    },
    pausa: {
      ler: async () => estado,
      gravar: async ({ pausado, por, quando }) => {
        const antes = estado;
        if (antes.pausado !== pausado) estado = pausado ? { pausado: true, desde: quando, por, ignoradas: 0 } : SEM_PAUSA;
        return antes;
      },
    },
    agora: () => new Date('2026-11-11T15:00:00Z'),
    modoDoMenu: () => 'ligado',
    dadosDoStatus: async () => ({ abertas: 0, reabertas: 0, lembrete: 'desligado' }),
  };
  return { deps, enviadas, estado: () => estado };
}

const msg = (texto: string, id = Number(JOAO)) => ({ update_id: 9, message: { chat: { id, type: 'private' }, from: { id, is_bot: false }, text: texto } });

test('o João manda /pausar: pausa, responde no chat e o estado fica gravado', async () => {
  const w = depsFalsas();
  const r = await tratarAtualizacao(msg('/pausar'), w.deps);
  assert.equal(r.acao, 'respondeu');
  assert.equal(w.estado().pausado, true);
  assert.equal(w.enviadas.length, 1);
  assert.match(w.enviadas[0]!, /PAUSADO/);
});

test('outra pessoa manda /pausar: nada muda e o bot NÃO responde (não confirma que existe)', async () => {
  const w = depsFalsas();
  const r = await tratarAtualizacao(msg('/pausar', 555), w.deps);
  assert.deepEqual(r, { acao: 'ignorou', motivo: 'chat não autorizado' });
  assert.equal(w.estado().pausado, false);
  assert.equal(w.enviadas.length, 0);
});

test('canal sem bot próprio (chat vazio): nenhum comando vale, nem o do João', async () => {
  const w = depsFalsas('');
  const r = await tratarAtualizacao(msg('/pausar'), w.deps);
  assert.equal(r.acao, 'ignorou');
  assert.equal(w.estado().pausado, false);
});

test('falha ao gravar: responde o erro ao João e não lança', async () => {
  const w = depsFalsas();
  w.deps.pausa = { ler: async () => SEM_PAUSA, gravar: async () => Promise.reject(new Error('banco fora')) };
  const r = await tratarAtualizacao(msg('/pausar'), w.deps);
  assert.deepEqual(r, { acao: 'ignorou', motivo: 'erro' });
  assert.match(w.enviadas[0]!, /Não consegui executar/);
});

// ─── o portão do segredo ────────────────────────────────────────────────────────────────────────────────

function chamar(cabecalho: unknown, corpo: unknown, env: NodeJS.ProcessEnv, deps: DepsBot) {
  const resposta: { status: number | null; json: unknown } = { status: null, json: null };
  const req = {
    body: corpo,
    ip: '127.0.0.1',
    get: (n: string) => (n.toLowerCase() === CABECALHO_SEGREDO ? cabecalho : undefined),
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
  criarTelegramChamadosHandler(() => deps, env)(req, res);
  return resposta;
}

test('webhook sem cabeçalho, com cabeçalho errado ou sem segredo no servidor: 401 e NADA é executado', async () => {
  for (const [cab, env] of [
    [undefined, { TELEGRAM_CHAMADOS_SEGREDO: SEGREDO_FALSO }],
    ['errado', { TELEGRAM_CHAMADOS_SEGREDO: SEGREDO_FALSO }],
    [SEGREDO_FALSO, {}],
    ['', { TELEGRAM_CHAMADOS_SEGREDO: '' }],
  ] as const) {
    const w = depsFalsas();
    const r = chamar(cab, msg('/pausar'), env as NodeJS.ProcessEnv, w.deps);
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { ok: false });
    await new Promise((ok) => setImmediate(ok));
    assert.equal(w.estado().pausado, false);
    assert.equal(w.enviadas.length, 0);
  }
});

test('webhook com o segredo certo: 200 na hora e o comando é executado em seguida', async () => {
  const w = depsFalsas();
  const r = chamar(SEGREDO_FALSO, msg('/pausar'), { TELEGRAM_CHAMADOS_SEGREDO: SEGREDO_FALSO }, w.deps);
  assert.equal(r.status, 200);
  for (let i = 0; i < 10 && !w.estado().pausado; i++) await new Promise((ok) => setImmediate(ok));
  assert.equal(w.estado().pausado, true);
});
