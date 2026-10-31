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

/** Dorme de mentira: guarda cada espera pedida e não gasta tempo. */
const relogioFalso = () => {
  const esperas: number[] = [];
  return { esperas, dormir: async (ms: number) => void esperas.push(ms) };
};

test('Retry-After de verdade: espera o que a API pediu (em ms), não 1 ms', async () => {
  const r = relogioFalso();
  const chamadas: Chamada[] = [];
  const ok = await tramitacaoGet('ra1', 'tok', '/v1/processos', {}, fetcherFalso([json({}, 429, { 'retry-after': '3' }), json({ lawsuits: [] })], chamadas), { dormir: r.dormir });
  assert.deepEqual(ok, { lawsuits: [] });
  assert.deepEqual(r.esperas, [3000]);
  assert.equal(chamadas.length, 2);
  // sem Retry-After: 2 s, 4 s (a espera cresce com a tentativa)
  const s = relogioFalso();
  await tramitacaoGet('ra2', 'tok', '/v1/processos', {}, fetcherFalso([json({}, 429), json({}, 429), json({ lawsuits: [] })]), { dormir: s.dormir });
  assert.deepEqual(s.esperas, [2000, 4000]);
});

test('5xx e queda de rede esperam 1,5 s / 3 s e 1 s / 2 s antes de tentar de novo', async () => {
  const a = relogioFalso();
  await tramitacaoGet('ra3', 'tok', '/v1/processos', {}, fetcherFalso([json({}, 503), json({}, 502), json({ lawsuits: [] })]), { dormir: a.dormir });
  assert.deepEqual(a.esperas, [1500, 3000]);
  const b = relogioFalso();
  let n = 0;
  const cai = (async () => {
    if (n++ < 2) throw new TypeError('fetch failed');
    return json({ lawsuits: [] })();
  }) as typeof fetch;
  await tramitacaoGet('ra4', 'tok', '/v1/processos', {}, cai, { dormir: b.dormir });
  assert.deepEqual(b.esperas, [1000, 2000]);
});

test('teto TOTAL de espera: Retry-After grande desiste na hora; várias esperas médias param quando a soma passaria do teto', async () => {
  // um Retry-After maior que o que sobra do teto: nem dorme, devolve o 429 já
  const a = relogioFalso();
  const chamadasA: Chamada[] = [];
  await assert.rejects(
    () => tramitacaoGet('ra5', 'tok', '/v1/processos', {}, fetcherFalso([json({}, 429, { 'retry-after': '45' })], chamadasA), { dormir: a.dormir, tetoMs: 30_000 }),
    (e: Error) => (e as ErroTramitacao).status === 429 && /limit/.test(e.message),
  );
  assert.deepEqual(a.esperas, []);
  assert.equal(chamadasA.length, 1);
  // 20 s cabem (total 20 s); a segunda de 20 s passaria dos 30 s: para
  const b = relogioFalso();
  const chamadasB: Chamada[] = [];
  await assert.rejects(
    () => tramitacaoGet('ra6', 'tok', '/v1/processos', {}, fetcherFalso([json({}, 429, { 'retry-after': '20' })], chamadasB), { dormir: b.dormir, tetoMs: 30_000 }),
    (e: Error) => (e as ErroTramitacao).status === 429,
  );
  assert.deepEqual(b.esperas, [20_000]);
  assert.equal(chamadasB.length, 2);
  // exatamente no teto ainda espera (30 s = 30 s)
  const c = relogioFalso();
  await tramitacaoGet('ra7', 'tok', '/v1/processos', {}, fetcherFalso([json({}, 429, { 'retry-after': '30' }), json({ lawsuits: [] })]), { dormir: c.dormir, tetoMs: 30_000 });
  assert.deepEqual(c.esperas, [30_000]);
});

test('teto total também vale para 5xx: o erro que a API deu é o que volta, com o corpo ainda legível', async () => {
  const r = relogioFalso();
  await assert.rejects(
    () => tramitacaoGet('ra8', 'tok', '/v1/processos', {}, fetcherFalso([json({ error: 'indisponível' }, 503)]), { dormir: r.dormir, tetoMs: 1000 }),
    (e: Error) => (e as ErroTramitacao).status === 503 && /indisponível/.test(e.message),
  );
  assert.deepEqual(r.esperas, []);
});

test('queda de rede também respeita o teto total: esperas de 1 s + 2 s não cabem em 2,5 s', async () => {
  const r = relogioFalso();
  let chamadas = 0;
  const cai = (async () => {
    chamadas++;
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  await assert.rejects(() => tramitacaoGet('ra10', 'tok', '/v1/processos', {}, cai, { dormir: r.dormir, tetoMs: 2500 }), /sem resposta da Tramitação/);
  assert.deepEqual(r.esperas, [1000]);
  assert.equal(chamadas, 2);
});

test('no pior caso o conector espera no máximo o teto padrão (30 s), não 2 minutos', async () => {
  const r = relogioFalso();
  await assert.rejects(() => tramitacaoGet('ra9', 'tok', '/v1/processos', {}, fetcherFalso([json({}, 429, { 'retry-after': '25' })]), { dormir: r.dormir }));
  assert.ok(r.esperas.reduce((x, y) => x + y, 0) <= 30_000, JSON.stringify(r.esperas));
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

test('segue redirecionamento? Não: a chave vai no cabeçalho, então redirect é "error"', async () => {
  const chamadas: Chamada[] = [];
  await tramitacaoGet('t-redir', 'tok', '/v1/processos', {}, fetcherFalso([json({})], chamadas));
  assert.equal(chamadas[0]!.init.redirect, 'error');
});

test('parâmetro que pede a senha do Meu INSS é recusado em qualquer variante (colchetes, espaço, hífen, caixa, camelCase)', async () => {
  for (const k of ['mostrar_meu_inss_pass', 'mostrar_meu_inss_pass[]', 'mostrar_meu_inss_pass ', 'mostrar-meu-inss-pass', 'Mostrar_Meu_INSS_Pass', 'mostrarMeuInssPass', 'meu_inss_pass']) {
    const chamadas: Chamada[] = [];
    await assert.rejects(tramitacaoGet('t-proib', 'tok', '/v1/clientes', { [k]: 'true' }, fetcherFalso([json({})], chamadas)), /não permitido/, JSON.stringify(k));
    assert.equal(chamadas.length, 0, `nada foi para a rede: ${JSON.stringify(k)}`);
  }
  // parâmetros legítimos continuam passando
  await tramitacaoGet('t-proib', 'tok', '/v1/clientes', { cpf_cnpj: '1', 'tags[]': ['a'], per_page: 20 }, fetcherFalso([json({})]));
});

test('resposta de erro que não é JSON não leva trecho do corpo para a mensagem', async () => {
  const corpo = '<html>fulano@exemplo.com Bearer abc.def.ghi plano ouro</html>';
  await assert.rejects(
    tramitacaoGet('t-html', 'tok', '/v1/processos', {}, fetcherFalso([() => new Response(corpo, { status: 200 })])),
    (e: Error) => /não é JSON/.test(e.message) && !e.message.includes('fulano') && !e.message.includes('Bearer') && !e.message.includes('html'),
  );
});

test('redirecionamento (redirect:"error" lança no 3xx) falha na hora, com mensagem própria, sem repetir', async () => {
  let n = 0;
  const f = (async () => {
    n++;
    throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
  }) as unknown as typeof fetch;
  const t0 = Date.now();
  await assert.rejects(tramitacaoGet('t-3xx', 'tok', '/v1/processos', {}, f), /redirecionamento/);
  assert.equal(n, 1, 'não repete');
  assert.ok(Date.now() - t0 < 500, 'não dorme entre tentativas');
});
