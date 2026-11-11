import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  caminhoSeguro,
  chamar,
  chamarDireto,
  confirmar,
  contaChatwootDoAmbiente,
  criarContextoChatwoot,
  precisaConfirmar,
  preparar,
  VALIDADE_MS,
} from './chatwoot.js';

const CONTA = { url: 'https://cw.teste', conta: 1, token: 'tok-secreto-123' };

function falso(resposta: { status?: number; corpo?: unknown } = {}) {
  const chamadas: Array<{ url: string; metodo: string; corpo: unknown; cabecalhos: Record<string, string> }> = [];
  const f = (async (url: string, init: RequestInit) => {
    chamadas.push({ url, metodo: String(init.method), corpo: init.body ? JSON.parse(String(init.body)) : undefined, cabecalhos: init.headers as Record<string, string> });
    return new Response(JSON.stringify(resposta.corpo ?? { ok: true }), { status: resposta.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, chamadas };
}

test('conta do ambiente: precisa de token e conta numérica; URL padrão é a do atendimento', () => {
  assert.equal(contaChatwootDoAmbiente({}), null);
  assert.equal(contaChatwootDoAmbiente({ CHATWOOT_API_TOKEN: 'x', CHATWOOT_CONTA_ID: 'abc' }), null);
  assert.deepEqual(contaChatwootDoAmbiente({ CHATWOOT_API_TOKEN: ' x ', CHATWOOT_CONTA_ID: '1' }), {
    url: 'https://atendimento.doutordigitalconsultoria.com',
    conta: 1,
    token: 'x',
  });
  assert.equal(contaChatwootDoAmbiente({ CHATWOOT_API_TOKEN: 'x', CHATWOOT_CONTA_ID: '2', CHATWOOT_URL: 'https://a.b/' })?.url, 'https://a.b');
});

test('caminho: só relativo à conta, sem sair dela', () => {
  assert.equal(caminhoSeguro('/conversations/12/messages/'), 'conversations/12/messages');
  assert.equal(caminhoSeguro(''), '');
  for (const ruim of ['../2/inboxes', 'conversations/../../platform', 'a//b', 'https://x.com/a', 'inboxes?x=1', 'platform/api/v1/users', 'super_admin', 'api/v1/accounts/2/inboxes', 'accounts/2', 'a b', 'a/./b']) {
    assert.throws(() => caminhoSeguro(ruim), /./, ruim);
  }
});

test('a chamada vai para a conta fixa, com o token no cabeçalho, nunca na URL', async () => {
  const { f, chamadas } = falso({ corpo: [{ id: 1 }] });
  const ctx = criarContextoChatwoot(CONTA, { fetch: f });
  await chamar(ctx, 'GET', 'inboxes', { query: { page: '2' } });
  assert.equal(chamadas[0].url, 'https://cw.teste/api/v1/accounts/1/inboxes?page=2');
  assert.equal(chamadas[0].cabecalhos.api_access_token, 'tok-secreto-123');
  assert.ok(!chamadas[0].url.includes('tok-secreto'));
  await chamar(ctx, 'GET', '');
  assert.equal(chamadas[1].url, 'https://cw.teste/api/v1/accounts/1');
});

test('erro da API vira mensagem clara e sem o token', async () => {
  const { f } = falso({ status: 422, corpo: { message: 'Title has already been taken tok-secreto-123' } });
  const ctx = criarContextoChatwoot(CONTA, { fetch: f });
  await assert.rejects(chamar(ctx, 'POST', 'labels', { corpo: { title: 'x' } }), (e: Error) => {
    assert.match(e.message, /Chatwoot 422 em POST labels: .*already been taken/);
    assert.ok(!e.message.includes('tok-secreto'));
    return true;
  });
});

test('sem conta configurada, recusa', async () => {
  await assert.rejects(chamar(criarContextoChatwoot(null), 'GET', 'inboxes'), /não está ligado/);
});

test('o que precisa de dois passos: apagar, mensagem pública, conversa nova com mensagem, campanha', () => {
  assert.equal(precisaConfirmar('DELETE', 'labels/3'), 'apaga');
  assert.ok(precisaConfirmar('POST', 'conversations/5/messages', { content: 'oi' }));
  assert.equal(precisaConfirmar('POST', 'conversations/5/messages', { content: 'nota', private: true }), null);
  assert.ok(precisaConfirmar('POST', 'conversations', { source_id: 'x', inbox_id: 1, message: { content: 'oi' } }));
  assert.equal(precisaConfirmar('POST', 'conversations', { source_id: 'x', inbox_id: 1 }), null);
  assert.ok(precisaConfirmar('POST', 'campaigns', { title: 'x' }));
  for (const [m, c] of [['POST', 'labels'], ['PATCH', 'contacts/2'], ['PUT', 'inboxes/1'], ['POST', 'conversations/5/labels'], ['POST', 'conversations/5/toggle_status'], ['GET', 'conversations']] as const) {
    assert.equal(precisaConfirmar(m, c, {}), null, `${m} ${c}`);
  }
});

test('chatwoot_api direto: cria e altera; recusa apagar e mandar mensagem sem chamar a API', async () => {
  const { f, chamadas } = falso();
  const ctx = criarContextoChatwoot(CONTA, { fetch: f });
  await chamarDireto(ctx, 'POST', 'labels', { title: 'retorno', color: '#1f93ff' });
  await chamarDireto(ctx, 'PATCH', 'contacts/9', { name: 'Maria' });
  assert.deepEqual(chamadas.map((c) => `${c.metodo} ${c.url}`), ['POST https://cw.teste/api/v1/accounts/1/labels', 'PATCH https://cw.teste/api/v1/accounts/1/contacts/9']);
  assert.throws(() => chamarDireto(ctx, 'DELETE', 'labels/3'), /chatwoot_preparar/);
  assert.throws(() => chamarDireto(ctx, 'POST', 'conversations/5/messages', { content: 'oi' }), /chatwoot_preparar/);
  assert.equal(chamadas.length, 2);
});

test('dois passos: preparar não chama a API; confirmar executa uma vez, só para quem preparou, e apagar avisa o João', async () => {
  const { f, chamadas } = falso();
  const avisos: string[] = [];
  let agora = 1_000_000;
  const ctx = criarContextoChatwoot(CONTA, { fetch: f, agora: () => agora, avisar: (t) => void avisos.push(t) });
  const p = preparar(ctx, 'suzanne@x', { metodo: 'DELETE', caminho: 'labels/3' });
  assert.equal(chamadas.length, 0);
  assert.match(p.vaiFazer, /DELETE labels\/3 — apaga/);
  await assert.rejects(confirmar(ctx, 'outra@x', p.codigo), /outro usuário/);
  await confirmar(ctx, 'suzanne@x', p.codigo.toLowerCase());
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].metodo, 'DELETE');
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /suzanne@x apagou labels\/3/);
  await assert.rejects(confirmar(ctx, 'suzanne@x', p.codigo), /já usado/);

  // mensagem ao cliente não avisa; código vencido não executa
  const m = preparar(ctx, 'suzanne@x', { metodo: 'POST', caminho: 'conversations/5/messages', corpo: { content: 'Olá!' } });
  await confirmar(ctx, 'suzanne@x', m.codigo);
  assert.equal(avisos.length, 1);
  assert.deepEqual(chamadas[1].corpo, { content: 'Olá!' });
  const v = preparar(ctx, 'suzanne@x', { metodo: 'DELETE', caminho: 'contacts/1' });
  agora += VALIDADE_MS + 1;
  await assert.rejects(confirmar(ctx, 'suzanne@x', v.codigo), /venceu/);
  assert.equal(chamadas.length, 2);
});

test('preparar também recusa caminho que sai da conta', () => {
  const ctx = criarContextoChatwoot(CONTA, { fetch: falso().f });
  assert.throws(() => preparar(ctx, 'a', { metodo: 'DELETE', caminho: '../2/labels/1' }));
});

test('aviso que falha não esconde o que foi apagado', async () => {
  const { f, chamadas } = falso();
  const ctx = criarContextoChatwoot(CONTA, { fetch: f, avisar: () => Promise.reject(new Error('telegram fora')) });
  const p = preparar(ctx, 'a', { metodo: 'DELETE', caminho: 'labels/1' });
  await confirmar(ctx, 'a', p.codigo);
  assert.equal(chamadas.length, 1);
});
