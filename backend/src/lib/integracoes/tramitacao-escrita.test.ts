import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErroTramitacao } from './tramitacao.js';
import { criarAtividadeTramitacao, type AtividadeNova } from './tramitacao-escrita.js';

// Respostas simuladas: nenhuma chamada real, nenhuma chave real.
const atividade: AtividadeNova = {
  title: 'Atendimento - Fulano de Teste (Dra Amanda)',
  description: 'texto',
  type: 'Event',
  start: '2026-11-18T09:00:00-03:00',
  end: '2026-11-18T09:50:00-03:00',
  creator_id: 'user_abc',
  assignments: [{ user_id: 'user_abc', role: 'executor' }],
};

const json = (corpo: unknown, status = 200) => () => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });

function falso(resposta: () => Response, chamadas: Array<{ url: string; init: RequestInit }> = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), init: init ?? {} });
    return resposta();
  }) as typeof fetch;
}

test('POST /v1/atividades com Bearer, JSON { activity }, sem seguir redirecionamento; devolve o id', async () => {
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  const r = await criarAtividadeTramitacao('tok-abc', atividade, falso(json({ activity: { id: 321 } }, 201), chamadas));
  assert.deepEqual(r, { id: 321 });
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0]!.url, 'https://planilha.tramitacaointeligente.com.br/api/v1/atividades');
  assert.equal(chamadas[0]!.init.method, 'POST');
  assert.equal(chamadas[0]!.init.redirect, 'error');
  const h = chamadas[0]!.init.headers as Record<string, string>;
  assert.equal(h.Authorization, 'Bearer tok-abc');
  assert.equal(h['Content-Type'], 'application/json');
  const corpo = JSON.parse(String(chamadas[0]!.init.body)) as { activity: AtividadeNova };
  assert.equal(corpo.activity.type, 'Event');
  assert.equal(corpo.activity.creator_id, 'user_abc');
  assert.deepEqual(corpo.activity.assignments, [{ user_id: 'user_abc', role: 'executor' }]);
});

test('erro 500 NÃO repete (POST não é idempotente: repetir criaria evento em dobro)', async () => {
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  await assert.rejects(() => criarAtividadeTramitacao('k', atividade, falso(json({ error: 'boom' }, 500), chamadas)), (e: unknown) => e instanceof ErroTramitacao && e.status === 500);
  assert.equal(chamadas.length, 1);
});

test('422 mostra os erros de validação; 402 e 401 dizem o que fazer; a chave nunca aparece na mensagem', async () => {
  await assert.rejects(
    () => criarAtividadeTramitacao('segredo-xyz', atividade, falso(json({ errors: ['Título não pode ficar em branco'] }, 422))),
    (e: unknown) => e instanceof ErroTramitacao && e.status === 422 && /Título não pode ficar em branco/.test(e.message) && !/segredo-xyz/.test(e.message),
  );
  await assert.rejects(() => criarAtividadeTramitacao('k', atividade, falso(json({ reason: 'plano' }, 402))), (e: unknown) => e instanceof ErroTramitacao && e.status === 402 && /plano/.test(e.message));
  await assert.rejects(() => criarAtividadeTramitacao('k', atividade, falso(json({ error: 'Sem permissão' }, 401))), (e: unknown) => e instanceof ErroTramitacao && e.status === 401 && /permissão de escrita/.test(e.message));
});

test('queda de rede vira ErroTramitacao sem repetir; resposta 2xx sem JSON avisa que o evento pode existir', async () => {
  let n = 0;
  const cai = (async () => {
    n++;
    throw new Error('ECONNRESET');
  }) as unknown as typeof fetch;
  await assert.rejects(() => criarAtividadeTramitacao('k', atividade, cai), (e: unknown) => e instanceof ErroTramitacao && /sem resposta/.test(e.message));
  assert.equal(n, 1);
  await assert.rejects(() => criarAtividadeTramitacao('k', atividade, falso(() => new Response('ok', { status: 201 }))), /pode ter sido criado/);
});
