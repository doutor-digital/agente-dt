/**
 * Token nunca no log (14/10/2026: o token do Kommo de Olímpia apareceu no log do `ddagent_agent`, dentro do
 * `request._header` de um erro do axios). Os casos usam um erro DE VERDADE: um servidor local responde 401 e
 * o axios monta o erro como monta em produção — com o cabeçalho repetido em cinco lugares do objeto.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import axios, { type AxiosError } from 'axios';
import pino from 'pino';

import { limparParaLog, mascararTexto, MASCARA } from './log-sem-segredo.js';
import { extractLog, formatadores, redacao } from './logger.js';

const SEGREDO = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.SEGREDO-DE-OLIMPIA.assinatura';

let servidor: http.Server;
let base = '';
before(async () => {
  servidor = http.createServer((_req, res) => {
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.end('{"title":"Unauthorized","status":401}');
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
after(() => servidor.close());

async function erroDoAxios(metodo: 'get' | 'patch' = 'get'): Promise<AxiosError> {
  const cliente = axios.create({ baseURL: `${base}/api/v4`, headers: { Authorization: `Bearer ${SEGREDO}` } });
  try {
    if (metodo === 'patch') await cliente.patch('/leads/123', { custom_fields_values: [{ field_id: 1, values: [{ value: 'x' }] }] });
    else await cliente.get('/leads', { params: { limit: 1 } });
  } catch (e) {
    return e as AxiosError;
  }
  throw new Error('o servidor de teste deveria responder 401');
}

/** Uma linha do logger com a MESMA configuração de produção (redação + formatador), escrita num buffer. */
function linhaDoLogger(...args: unknown[]): string {
  const linhas: string[] = [];
  const log = pino({ redact: redacao, formatters: formatadores }, { write: (s: string) => linhas.push(s) });
  (log.warn as (...a: unknown[]) => void)(...args);
  return linhas.join('');
}

test('o erro do axios sem limpeza VAZA o token (a prova de que o teste pega o problema)', async () => {
  const e = await erroDoAxios();
  const linhas: string[] = [];
  const cru = pino({ redact: redacao }, { write: (s: string) => linhas.push(s) });
  cru.warn({ err: e }, 'kommo falhou');
  assert.ok(linhas.join('').includes(SEGREDO), 'sem o formatador, a redação por caminho deixa escapar');
});

test('logger de produção: header com Bearer é redigido em todos os formatos de log de erro', async () => {
  const e = await erroDoAxios();
  const embrulhado = Object.assign(new Error('falhou ao gravar'), { original: e });
  const casos: Array<[string, unknown[]]> = [
    ['{ err }', [{ err: e, unit: 'olimpia' }, 'kommo falhou']],
    ['erro como 1º argumento', [e, 'kommo falhou']],
    ['{ error }', [{ error: e }, 'x']],
    ['{ err: e.response }', [{ err: e.response }, 'x']],
    ['{ resp: e.response }', [{ resp: e.response }, 'x']],
    ['{ config: e.config }', [{ config: e.config }, 'x']],
    ['{ req: e.request }', [{ req: e.request }, 'x']],
    ['aninhado', [{ ctx: { falha: { err: e } } }, 'x']],
    ['erro embrulhando o do axios', [{ err: embrulhado }, 'x']],
    ['mesmo erro citado duas vezes', [{ err: e, de_novo: e, lista: [e, e] }, 'x']],
  ];
  for (const [nome, args] of casos) {
    const linha = linhaDoLogger(...args);
    assert.ok(!linha.includes(SEGREDO), `${nome}: o token apareceu no log`);
    assert.ok(!linha.includes('SEGREDO-DE-OLIMPIA'), `${nome}: pedaço do token apareceu no log`);
  }
});

test('o resumo do erro HTTP mantém o que serve para investigar', async () => {
  const linha = linhaDoLogger({ err: await erroDoAxios('patch'), unit: 'olimpia', leadId: 123 }, 'kommo falhou');
  const o = JSON.parse(linha);
  assert.equal(o.err.type, 'ErroHttp');
  assert.equal(o.err.status, 401);
  assert.equal(o.err.method, 'PATCH');
  assert.match(o.err.url, /\/api\/v4\/leads\/123$/);
  assert.match(o.err.resposta, /Unauthorized/);
  assert.match(o.err.message, /401/);
  assert.ok(o.err.stack, 'a pilha continua no log');
  assert.equal(o.unit, 'olimpia');
  assert.equal(o.leadId, 123);
  assert.equal(o.err.config, undefined, 'config (onde mora o cabeçalho) não vai para o log');
  assert.equal(o.err.request, undefined);
  assert.ok(linha.length < 4_000, `linha de ${linha.length} bytes — o erro cru passava de 12 KB`);
});

test('system_logs (persistência de warn/error) também não guarda o token', async () => {
  const e = await erroDoAxios();
  const casos: Array<[string, unknown[]]> = [
    ['{ err }', [{ err: e }, 'x']],
    ['erro como 1º argumento', [e, 'x']],
    ['{ resp: e.response }', [{ resp: e.response }, 'x']],
    ['token na mensagem', ['texto com Bearer ' + SEGREDO]],
  ];
  for (const [nome, args] of casos) {
    const { context, msg } = extractLog(args);
    assert.ok(!(JSON.stringify(context) + msg).includes(SEGREDO), nome);
  }
});

test('texto solto: Bearer, Basic e token na URL são mascarados', () => {
  assert.equal(mascararTexto(`Authorization: Bearer ${SEGREDO}`), `Authorization: Bearer ${MASCARA}`);
  assert.equal(mascararTexto('Basic dXNlcjpzZW5oYQ=='), `Basic ${MASCARA}`);
  assert.equal(mascararTexto('plano Basic mensal; Bearer token é o cabeçalho'), 'plano Basic mensal; Bearer token é o cabeçalho', 'texto comum fica');
  assert.equal(mascararTexto('https://graph.facebook.com/v20.0/me?access_token=EAAB123&fields=id'), `https://graph.facebook.com/v20.0/me?access_token=${MASCARA}&fields=id`);
});

test('chave com nome de segredo é mascarada; o resto do log fica igual', () => {
  const r = limparParaLog({ unit: 'olimpia', headers: { Authorization: 'qualquer', Accept: 'json' }, accessToken: 'abc', tokens: 1200 }) as Record<string, any>;
  assert.equal(r.headers.Authorization, MASCARA);
  assert.equal(r.headers.Accept, 'json');
  assert.equal(r.accessToken, MASCARA);
  assert.equal(r.tokens, 1200, '"tokens" (contagem do LLM) não é segredo');
});

test('log comum passa intacto e sem cópia (o filtro roda em toda linha)', () => {
  const obj = { unit: 'petropolis', leadId: 1292772, campo: '⌂ Endereço', valor: 'Rua A, 10', quando: new Date(0) };
  assert.equal(limparParaLog(obj), obj);
  const erro = new Error('falha comum');
  assert.equal(limparParaLog(erro), erro, 'erro sem segredo segue para o serializador do pino como está');
});

test('erro comum com segredo na mensagem continua com o tipo certo', () => {
  class KommoApiError extends Error {}
  const e = new KommoApiError(`chamada falhou com Bearer ${SEGREDO}`);
  const linha = linhaDoLogger({ err: e }, 'x');
  assert.ok(!linha.includes(SEGREDO));
  assert.equal(JSON.parse(linha).err.type, 'KommoApiError');
});
