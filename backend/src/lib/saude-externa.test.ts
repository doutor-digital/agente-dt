import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { montarResposta, SQL_DA_SAUDE } from './saude-externa.js';
import { saudeIaExternaHandler, tokenConfere } from '../controllers/saude-externa.controller.js';

const AGORA = Date.UTC(2026, 10, 27, 3, 0, 0);
const linha = (o: Record<string, unknown>) => ({
  provider: null as string | null,
  rede: 0,
  total: 0,
  erros: 0,
  unidades: 0,
  maior_unidade: 0,
  erros_credito: 0,
  erros_chave: 0,
  erros_limite: 0,
  erros_indisponivel: 0,
  ultimo_sucesso: null as Date | null,
  ...o,
});

test('a resposta da noite de 26/11: fora, causa crédito, sem nada além de contagens', () => {
  const r = montarResposta(
    [
      linha({ provider: 'anthropic', total: 1000, erros: 1000, unidades: 39, erros_credito: 1000 }),
      linha({ rede: 1, total: 1000, erros: 1000, unidades: 39, erros_credito: 1000, ultimo_sucesso: new Date(AGORA - 15 * 3_600_000) }),
    ],
    AGORA,
  );
  assert.equal(r.estado, 'fora');
  assert.equal(r.causa, 'credito');
  assert.equal(r.chamadas, 1000);
  assert.equal(r.taxaErro, 1);
  assert.equal(r.ultimoSucessoMinAtras, 900);
  assert.deepEqual(r.provedores, [{ nome: 'anthropic', chamadas: 1000, erros: 1000, taxaErro: 1 }]);
  // nada de unidade, telefone, lead ou texto de erro na resposta
  assert.deepEqual(Object.keys(r).sort(), ['causa', 'chamadas', 'erros', 'estado', 'geradoEm', 'janelaMin', 'motivo', 'provedores', 'taxaErro', 'ultimoSucessoMinAtras']);
});

test('madrugada sem chamada nenhuma é ok e diz que silêncio não é queda', () => {
  const r = montarResposta([linha({ rede: 1 })], AGORA);
  assert.equal(r.estado, 'ok');
  assert.match(r.motivo, /silêncio não é queda/);
  assert.equal(montarResposta([], AGORA).estado, 'ok');
});

test('a consulta é UMA só, pelo created_at, em UTC (nunca now() puro) e só olha a última hora', () => {
  assert.match(SQL_DA_SAUDE, /from llm_calls c/i);
  assert.equal((SQL_DA_SAUDE.match(/from llm_calls/gi) ?? []).length, 1, 'a tabela é lida uma vez só (o CTE agrega por provedor e unidade)');
  assert.match(SQL_DA_SAUDE, /where c\.created_at > \(now\(\) at time zone 'utc'\) - interval '60 minutes'/);
  assert.ok(!/(?<![.\w])now\(\)\s*[-+]/.test(SQL_DA_SAUDE), 'now() puro cobriria 3 h a mais');
});

test('token: confere em tempo constante, recusa diferente e de tamanho diferente', () => {
  assert.equal(tokenConfere('abc123', 'abc123'), true);
  assert.equal(tokenConfere('abc124', 'abc123'), false);
  assert.equal(tokenConfere('abc', 'abc123'), false);
  assert.equal(tokenConfere('', 'abc123'), false);
});

const SEGREDO = 'segredo-longo-de-teste-0123456789abcdef';

function chamar(token: string | undefined, env: string | undefined) {
  const antes = process.env.HEALTH_IA_TOKEN;
  if (env === undefined) delete process.env.HEALTH_IA_TOKEN;
  else process.env.HEALTH_IA_TOKEN = env;
  const saida: { status: number; corpo: unknown } = { status: 200, corpo: undefined };
  const res = {
    status(n: number) {
      saida.status = n;
      return this;
    },
    json(c: unknown) {
      saida.corpo = c;
      return this;
    },
    setHeader() {
      return this;
    },
  } as unknown as Response;
  const req = { header: (n: string) => (n.toLowerCase() === 'x-health-token' ? token : undefined) } as unknown as Request;
  return saudeIaExternaHandler(req, res).then(() => {
    if (antes === undefined) delete process.env.HEALTH_IA_TOKEN;
    else process.env.HEALTH_IA_TOKEN = antes;
    return saida;
  });
}

test('FECHADO por padrão: sem HEALTH_IA_TOKEN no servidor é 404; token errado ou ausente é 401', async () => {
  assert.equal((await chamar('qualquer', undefined)).status, 404);
  assert.equal((await chamar('qualquer', '   ')).status, 404);
  assert.equal((await chamar('curto', 'curto')).status, 404, 'token com menos de 16 caracteres = não configurado');
  assert.equal((await chamar(undefined, SEGREDO)).status, 401);
  assert.equal((await chamar('errado', SEGREDO)).status, 401);
});

test('banco fora: 503 SEM `estado` (o vigia não pode ler «fora» num soluço do banco), pelo caminho real do controller', async () => {
  // DATABASE_URL de teste aponta para uma porta fechada: a consulta lança de verdade
  const { esquecerSaudeGuardada } = await import('./saude-externa.js');
  esquecerSaudeGuardada();
  const r = await chamar(SEGREDO, SEGREDO);
  assert.equal(r.status, 503);
  assert.deepEqual(r.corpo, { error: 'db_unavailable' });
  assert.ok(!('estado' in (r.corpo as object)));
});
