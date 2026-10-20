import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conveniaGet, JanelaDeRitmo, testarChaveConvenia } from './convenia.js';

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

test('GET leva o token no header "token", só GET e sem corpo', async () => {
  const chamadas: Chamada[] = [];
  const r = await conveniaGet<{ ok: number }>('c1', 'tok-123', '/employees', { paginate: 500, page: 1, vazio: undefined }, fetcherFalso([json({ ok: 1 })], chamadas));
  assert.deepEqual(r, { ok: 1 });
  assert.equal(chamadas[0]!.url, 'https://public-api.convenia.com.br/api/v3/employees?paginate=500&page=1');
  assert.equal(chamadas[0]!.init.method, 'GET');
  assert.equal(chamadas[0]!.init.body, undefined);
  assert.equal((chamadas[0]!.init.headers as Record<string, string>).token, 'tok-123');
});

test('401 e 403 viram mensagens claras (sem o token)', async () => {
  await assert.rejects(
    () => conveniaGet('c2', 'segredo-que-nao-pode-aparecer', '/employees', {}, fetcherFalso([json({ message: 'Unauthorized. Invalid Token' }, 401)])),
    (e: Error) => /recusou o token/.test(e.message) && !e.message.includes('segredo-que-nao-pode-aparecer'),
  );
  await assert.rejects(() => conveniaGet('c3', 'tok', '/employees/x/absences', {}, fetcherFalso([json({}, 403)])), /não tem permissão para \/employees\/x\/absences/);
});

test('resposta 200 que não é JSON vira erro do Convênia com a rota', async () => {
  const html = () => new Response('<html>manutenção</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  await assert.rejects(() => conveniaGet('c5', 'tok', '/employees', {}, fetcherFalso([html])), /Convênia 200 em \/employees: resposta que não é JSON/);
});

test('429 respeita o Retry-After e tenta de novo', async () => {
  const chamadas: Chamada[] = [];
  const r = await conveniaGet('c4', 'tok', '/employees', {}, fetcherFalso([json({}, 429, { 'retry-after': '0' }), json({ data: [] })], chamadas));
  assert.deepEqual(r, { data: [] });
  assert.equal(chamadas.length, 2);
});

test('janela: deixa a rajada passar até o teto e segura o resto até a janela andar', async () => {
  let agora = 0;
  const esperas: number[] = [];
  const j = new JanelaDeRitmo(3, 60_000, () => agora, async (ms) => { esperas.push(ms); agora += ms; });
  for (let i = 0; i < 3; i++) await j.vez();
  assert.deepEqual(esperas, []);
  agora = 10_000;
  await j.vez();
  assert.deepEqual(esperas, [50_000]);
});

test('teste da chave: nome do token, exige a listagem de colaboradores, avisa se o token escreve', async () => {
  const perms = (nomes: string[]) => json({ data: { name: 'ChaveApiKeyClaude', permissions: nomes.map((name) => ({ name })) } });
  assert.equal(await testarChaveConvenia('tok', fetcherFalso([perms(['employees.get.employees', 'employees.get.absences'])])), 'Convênia · token "ChaveApiKeyClaude"');
  assert.match(await testarChaveConvenia('tok', fetcherFalso([perms(['employees.get.employees', 'employees.post.dismissal'])])), /também altera dados/);
  await assert.rejects(() => testarChaveConvenia('tok', fetcherFalso([perms(['companies.get.company.jobs'])])), /Listagem de colaboradores/);
});
