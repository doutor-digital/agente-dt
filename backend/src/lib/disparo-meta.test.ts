import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ehNumeroRestrito, enviarTemplate, montarCorpoDoTemplate, variavelLimpa } from './whatsapp-meta.js';

const CRED = { phoneNumberId: '12345', token: 'tok-secreto' };
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

function fetchFalso(resposta: () => Response | Promise<Response>) {
  const pedidos: Array<{ url: string; opcoes: RequestInit }> = [];
  globalThis.fetch = (async (url: string, opcoes: RequestInit) => {
    pedidos.push({ url: String(url), opcoes });
    return resposta();
  }) as typeof fetch;
  return pedidos;
}
const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });

test('corpo do template: cabeçalho de mídia + variáveis do corpo, no formato da Graph API', () => {
  const c = montarCorpoDoTemplate({
    para: '5563991021043', nome: 'canaa_resgate_150_arte', idioma: 'pt_BR', corpo: ['Maria'],
    cabecalho: { tipo: 'image', link: 'https://exemplo.com/arte4.jpg' },
  });
  assert.deepEqual(c, {
    recipient_type: 'individual', to: '5563991021043', type: 'template',
    template: {
      name: 'canaa_resgate_150_arte', language: { code: 'pt_BR' },
      components: [
        { type: 'header', parameters: [{ type: 'image', image: { link: 'https://exemplo.com/arte4.jpg' } }] },
        { type: 'body', parameters: [{ type: 'text', text: 'Maria' }] },
      ],
    },
  });
});

test('corpo do template: sem variáveis e sem mídia não manda components; documento leva o nome do arquivo', () => {
  const c = montarCorpoDoTemplate({ para: '5563991021043', nome: 'so_texto', idioma: 'pt_BR' }) as { template: Record<string, unknown> };
  assert.equal('components' in c.template, false);
  const d = montarCorpoDoTemplate({ para: '5563991021043', nome: 'doc', idioma: 'pt_BR', cabecalho: { tipo: 'document', link: 'https://x.com/a.pdf', nomeArquivo: 'a.pdf' } }) as { template: { components: Array<{ parameters: unknown[] }> } };
  assert.deepEqual(d.template.components[0]!.parameters, [{ type: 'document', document: { link: 'https://x.com/a.pdf', filename: 'a.pdf' } }]);
});

test('a Meta recusa quebra de linha e excesso de espaço dentro da variável: limpa antes', () => {
  assert.equal(variavelLimpa('  Maria\n\tdas   Graças  '), 'Maria das Graças');
});

test('enviarTemplate: mesmo caminho dos outros envios (phone number id, token no cabeçalho) e devolve o wamid', async () => {
  const pedidos = fetchFalso(() => json({ messaging_product: 'whatsapp', contacts: [{ wa_id: '5563991021043' }], messages: [{ id: 'wamid.ABC' }] }));
  const r = await enviarTemplate(CRED, { para: '5563991021043', nome: 'm', idioma: 'pt_BR', corpo: ['Maria'] });
  assert.deepEqual([r.ok, r.wamid, r.incerto], [true, 'wamid.ABC', false]);
  assert.match(pedidos[0]!.url, /\/12345\/messages$/);
  assert.equal((pedidos[0]!.opcoes.headers as Record<string, string>).Authorization, 'Bearer tok-secreto');
  assert.equal(JSON.parse(String(pedidos[0]!.opcoes.body)).messaging_product, 'whatsapp');
  assert.ok(pedidos[0]!.opcoes.signal, 'tem timeout');
});

test('enviarTemplate: recusa da Meta (4xx) é definitiva; 5xx, queda e timeout são INCERTOS', async () => {
  fetchFalso(() => json({ error: { code: 132000, message: 'parâmetros' } }, 400));
  const r400 = await enviarTemplate(CRED, { para: '5563991021043', nome: 'm', idioma: 'pt_BR' });
  assert.deepEqual([r400.ok, r400.incerto], [false, false]);

  fetchFalso(() => json({ error: { code: 2, message: 'erro interno' } }, 500));
  assert.equal((await enviarTemplate(CRED, { para: '5563991021043', nome: 'm', idioma: 'pt_BR' })).incerto, true);

  fetchFalso(() => {
    throw new TypeError('fetch failed');
  });
  const rQueda = await enviarTemplate(CRED, { para: '5563991021043', nome: 'm', idioma: 'pt_BR' });
  assert.deepEqual([rQueda.ok, rQueda.incerto], [false, true]);

  fetchFalso(() => json({ messaging_product: 'whatsapp' }, 200));
  const semId = await enviarTemplate(CRED, { para: '5563991021043', nome: 'm', idioma: 'pt_BR' });
  assert.deepEqual([semId.ok, semId.incerto], [false, true], '200 sem id da mensagem: não dá para afirmar nada');
});

test('enviarTemplate: só a recusa ASSINADA pela Meta é definitiva — gateway/proxy (4xx sem corpo da Meta) é incerto', async () => {
  fetchFalso(() => new Response('<html>Bad gateway</html>', { status: 502 }));
  assert.equal((await enviarTemplate(CRED, { para: '5563991021043', nome: 'm', idioma: 'pt_BR' })).incerto, true, '502 de proxy');
  fetchFalso(() => new Response('Request Timeout', { status: 408 }));
  assert.equal((await enviarTemplate(CRED, { para: '5563991021043', nome: 'm', idioma: 'pt_BR' })).incerto, true, '408 sem corpo da Meta');
  fetchFalso(() => json({ error: { code: 130429, message: 'rate limit' } }, 429));
  assert.equal((await enviarTemplate(CRED, { para: '5563991021043', nome: 'm', idioma: 'pt_BR' })).incerto, false, '429 com erro da Meta: não entrou');
});

test('enviarTemplate: telefone fora do formato nem chega na rede', async () => {
  const pedidos = fetchFalso(() => json({}));
  const r = await enviarTemplate(CRED, { para: '(63) 99102-1043', nome: 'm', idioma: 'pt_BR' });
  assert.equal(r.ok, false);
  assert.equal(pedidos.length, 0);
});

// ── limite de taxa (decisão do sênior, 26/10): esperar, não recusar ──
import { ehLimiteDeTaxa } from './whatsapp-meta.js';

test('limite de taxa: 429 ou os códigos de "devagar" da Meta; recusa de verdade e erro qualquer não', () => {
  assert.equal(ehLimiteDeTaxa(429, null), true, '429, mesmo vindo de proxy sem corpo da Meta');
  assert.equal(ehLimiteDeTaxa(429, '<html>'), true);
  for (const code of [130429, 131048, 131056, 80007, 80008, 4]) assert.equal(ehLimiteDeTaxa(400, { error: { code } }), true, String(code));
  for (const code of [131026, 132000, 190, 100]) assert.equal(ehLimiteDeTaxa(400, { error: { code } }), false, String(code));
  assert.equal(ehLimiteDeTaxa(500, null), false);
  assert.equal(ehLimiteDeTaxa(200, { messages: [] }), false);
});

test('enviarTemplate: 429 (mesmo de proxy, sem corpo da Meta) e os códigos de taxa são "esperar", NÃO recusa definitiva nem incerto', async () => {
  const msg = { para: '5563991021043', nome: 'm', idioma: 'pt_BR' };
  fetchFalso(() => new Response('<html>too many</html>', { status: 429 }));
  const r429 = await enviarTemplate(CRED, msg);
  assert.deepEqual([r429.ok, r429.limiteDeTaxa, r429.incerto, r429.restrito], [false, true, false, undefined]);

  fetchFalso(() => json({ error: { code: 130429, message: 'Rate limit hit' } }, 400));
  const r130429 = await enviarTemplate(CRED, msg);
  assert.deepEqual([r130429.ok, r130429.limiteDeTaxa, r130429.incerto, r130429.restrito], [false, true, false, undefined]);

  // recusa definitiva de verdade não é limite de taxa
  fetchFalso(() => json({ error: { code: 131026, message: 'undeliverable' } }, 400));
  const rDef = await enviarTemplate(CRED, msg);
  assert.deepEqual([rDef.ok, rDef.limiteDeTaxa, rDef.incerto], [false, undefined, false]);
});

test('enviarTemplate: 131048 vem marcado como RESTRITO (a unidade pausa), e só ele', async () => {
  fetchFalso(() => json({ error: { code: 131048, message: 'Spam rate limit hit' } }, 400));
  const r = await enviarTemplate(CRED, { para: '5563991021043', nome: 'm', idioma: 'pt_BR' });
  assert.deepEqual([r.limiteDeTaxa, r.restrito, r.incerto], [true, true, false]);
  assert.equal(ehNumeroRestrito({ error: { code: 131048 } }), true);
  for (const code of [130429, 131056, 80007, 4, 131026]) assert.equal(ehNumeroRestrito({ error: { code } }), false, String(code));
  assert.equal(ehNumeroRestrito(null), false);
});
