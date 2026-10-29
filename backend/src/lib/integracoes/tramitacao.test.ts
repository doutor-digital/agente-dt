import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErroTramitacao, testarChaveTramitacao, tramitacaoGet } from './tramitacao.js';

// Respostas simuladas. A API real da Tramitação não é chamada por nenhum teste e nenhuma chave real entra aqui.
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

const BASE = 'https://planilha.tramitacaointeligente.com.br/api';

test('GET leva Bearer, só GET, sem corpo; arrays viram chave[]; vazio some', async () => {
  const chamadas: Chamada[] = [];
  const r = await tramitacaoGet<{ ok: number }>('t1', 'tok-123', '/v1/processos', { per_page: 20, page: 1, 'status[]': ['ativo', 'suspenso'], number: undefined, tags: '' }, fetcherFalso([json({ ok: 1 })], chamadas));
  assert.deepEqual(r, { ok: 1 });
  assert.equal(chamadas[0]!.url, `${BASE}/v1/processos?per_page=20&page=1&status%5B%5D=ativo&status%5B%5D=suspenso`);
  assert.equal(chamadas[0]!.init.method, 'GET');
  assert.equal(chamadas[0]!.init.body, undefined);
  assert.equal((chamadas[0]!.init.headers as Record<string, string>).Authorization, 'Bearer tok-123');
});

test('só lê o que o conector precisa: documento é só a lista (metadados), nunca conteúdo nem arquivo', async () => {
  const f = fetcherFalso([json({})]);
  for (const ok of ['/v1/processos', '/v1/processos/42', '/v1/processos/5010331-15.2024.4.03.6201', '/v1/processos/42/partes', '/v1/processos/42/movimentacoes', '/v1/processos/42/documentos', '/v1/publicacoes', '/v1/clientes', '/v1/atividades']) {
    await tramitacaoGet('perm', 'tok', ok, {}, f);
  }
  const chamadas: Chamada[] = [];
  for (const proibido of [
    '/v1/processos/42/documentos/abc123/conteudo',
    '/v1/processos/42/documentos/abc123/arquivo',
    '/v1/arquivos/9',
    '/v1/clientes/7/arquivos',
    '/v1/webhooks/endpoints',
    '/v1/processos/42/../clientes',
    '/v1/processos/42?x=1',
    'https://outro.exemplo/v1/processos',
    '/v2/assinaturas',
  ]) {
    await assert.rejects(() => tramitacaoGet('perm', 'tok', proibido, {}, fetcherFalso([json({})], chamadas)), /fora da lista|não permitido/, proibido);
  }
  assert.equal(chamadas.length, 0, 'nenhuma chamada saiu');
});

test('nunca pede a senha do Meu INSS que a API liberaria', async () => {
  const chamadas: Chamada[] = [];
  await assert.rejects(() => tramitacaoGet('x', 'tok', '/v1/clientes', { mostrar_meu_inss_pass: 'true' }, fetcherFalso([json({})], chamadas)), /não permitido/);
  await assert.rejects(() => tramitacaoGet('x', 'tok', '/v1/clientes', { MOSTRAR_MEU_INSS_PASS: 1 }, fetcherFalso([json({})], chamadas)), /não permitido/);
  assert.equal(chamadas.length, 0);
});

test('401: mensagem clara, sem a chave', async () => {
  await assert.rejects(
    () => tramitacaoGet('t2', 'segredo-que-nao-pode-aparecer', '/v1/processos', {}, fetcherFalso([json({ error: 'Unauthorized' }, 401)])),
    (e: Error) => /recusou a chave/.test(e.message) && !e.message.includes('segredo-que-nao-pode-aparecer'),
  );
});

test('402 (plano sem API) não é repetido e explica o motivo que a Tramitação deu', async () => {
  const chamadas: Chamada[] = [];
  const corpo = { error: 'payment_required', message: 'A API exige o plano Ouro', reason: 'necessario_assinatura_plano_ouro', subscription_path: '/assinatura', user: { email: 'dono@exemplo.com' }, plan_info: { x: 1 } };
  await assert.rejects(() => tramitacaoGet('t3', 'tok', '/v1/processos', {}, fetcherFalso([json(corpo, 402)], chamadas)), (e: Error) => {
    assert.ok(e instanceof ErroTramitacao);
    assert.equal((e as ErroTramitacao).status, 402);
    assert.match(e.message, /402/);
    assert.match(e.message, /plano/i);
    assert.match(e.message, /necessario_assinatura_plano_ouro/);
    assert.equal(e.message.includes('dono@exemplo.com'), false, 'não repete dado do usuário da resposta');
    return true;
  });
  assert.equal(chamadas.length, 1);
});

test('429 respeita o Retry-After e tenta de novo; depois de 4 tentativas desiste com 429', async () => {
  const chamadas: Chamada[] = [];
  const r = await tramitacaoGet('t4', 'tok', '/v1/processos', {}, fetcherFalso([json({}, 429, { 'retry-after': '0' }), json({ lawsuits: [] })], chamadas));
  assert.deepEqual(r, { lawsuits: [] });
  assert.equal(chamadas.length, 2);
  const mais: Chamada[] = [];
  await assert.rejects(() => tramitacaoGet('t5', 'tok', '/v1/processos', {}, fetcherFalso([json({}, 429, { 'retry-after': '0' })], mais)), (e: Error) => (e as ErroTramitacao).status === 429 && /limit/.test(e.message));
  assert.equal(mais.length, 4);
});

test('400/422 trazem a mensagem da API; 404 diz que não achou; HTML vira erro com a rota', async () => {
  await assert.rejects(() => tramitacaoGet('t6', 'tok', '/v1/processos', { number: 'abc' }, fetcherFalso([json({ error: 'Número inválido' }, 400)])), /400 em \/v1\/processos: Número inválido/);
  await assert.rejects(() => tramitacaoGet('t7', 'tok', '/v1/processos/999', {}, fetcherFalso([json({ error: 'Not found' }, 404)])), (e: Error) => (e as ErroTramitacao).status === 404);
  const html = () => new Response('<html>manutenção</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  await assert.rejects(() => tramitacaoGet('t8', 'tok', '/v1/processos', {}, fetcherFalso([html])), /resposta que não é JSON/);
});

test('teste da chave: só a contagem de processos; 402 explica o plano', async () => {
  const r = await testarChaveTramitacao('tok', fetcherFalso([json({ lawsuits: [{ id: 1, number: '123', customers: [{ name: 'Fulano Secreto' }] }], pagination: { count: 312 } })]));
  assert.equal(r, 'Tramitação Inteligente · 312 processos');
  assert.equal(r.includes('Fulano'), false);
  await assert.rejects(() => testarChaveTramitacao('tok', fetcherFalso([json({ message: 'sem plano', reason: 'necessario_assinatura' }, 402)])), /402/);
});
