import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testarChaveTiquetaque, tiquetaqueGet } from './tiquetaque.js';

type Chamada = { url: string; init: RequestInit };

function fetcherFalso(respostas: Array<() => Response>, chamadas: Chamada[] = []): typeof fetch {
  let i = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), init: init ?? {} });
    const r = respostas[Math.min(i++, respostas.length - 1)]!;
    return r();
  }) as typeof fetch;
}

const json = (corpo: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json', ...headers } });

test('GET leva Basic public:<token>, só GET e sem corpo', async () => {
  const chamadas: Chamada[] = [];
  const r = await tiquetaqueGet<{ ok: number }>('t1', 'tok-123', '/employees', { max_results: 500, page: 1, vazio: undefined }, fetcherFalso([json({ ok: 1 })], chamadas));
  assert.deepEqual(r, { ok: 1 });
  assert.equal(chamadas[0]!.url, 'https://api.tiquetaque.com/v2.1/employees?max_results=500&page=1');
  assert.equal(chamadas[0]!.init.method, 'GET');
  assert.equal(chamadas[0]!.init.body, undefined);
  const auth = (chamadas[0]!.init.headers as Record<string, string>).Authorization!;
  assert.equal(Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString(), 'public:tok-123');
});

test('401 vira mensagem clara sem o token; 422 traz a mensagem do Tiquetaque', async () => {
  await assert.rejects(
    () => tiquetaqueGet('t2', 'segredo-que-nao-pode-aparecer', '/employees', {}, fetcherFalso([json({ _status: 'ERR', _error: { code: 401, message: 'Invalid credentials.' } }, 401)])),
    (e: Error) => /recusou o token/.test(e.message) && !e.message.includes('segredo-que-nao-pode-aparecer'),
  );
  await assert.rejects(
    () => tiquetaqueGet('t3', 'tok', '/work-leaves', {}, fetcherFalso([json({ _status: 'ERR', _error: { code: 422, message: 'Required one and only one of parameters', ui_message: 'Um e apenas um dos parâmetros é necessário' } }, 422)])),
    /Tiquetaque 422 em \/work-leaves: Um e apenas um/,
  );
});

test('resposta 200 que não é JSON vira erro do Tiquetaque com a rota', async () => {
  const html = () => new Response('<html>manutenção</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  await assert.rejects(() => tiquetaqueGet('t4', 'tok', '/employees', {}, fetcherFalso([html])), /Tiquetaque 200 em \/employees: resposta que não é JSON/);
});

test('429 respeita o Retry-After e tenta de novo', async () => {
  const chamadas: Chamada[] = [];
  const r = await tiquetaqueGet('t5', 'tok', '/employees', {}, fetcherFalso([json({}, 429, { 'retry-after': '0' }), json({ _items: [] })], chamadas));
  assert.deepEqual(r, { _items: [] });
  assert.equal(chamadas.length, 2);
});

test('teste da chave: razão social dos empregadores e quantos ativos — sem CNPJ nem endereço', async () => {
  const empregadores = json({
    _items: [
      { _id: 'e1', name: 'Doutor Digital LTDA', cnpj: '11222333000181', address: { street_name: 'RUA SECRETA' } },
      { _id: 'e2', name: 'Clinica Exemplo LTDA', cnpj: '99888777000166' },
    ],
    _meta: { total: 2 },
  });
  const r = await testarChaveTiquetaque('tok', fetcherFalso([empregadores, json({ _items: [{}], _meta: { total: 48 } })]));
  assert.equal(r, 'Tiquetaque · Doutor Digital LTDA + Clinica Exemplo LTDA · 48 funcionários ativos');
  assert.ok(!r.includes('11222333000181') && !r.includes('RUA SECRETA'));
  await assert.rejects(() => testarChaveTiquetaque('tok', fetcherFalso([json({ _error: { message: 'Invalid credentials.' } }, 401)])), /recusou o token/);
});
