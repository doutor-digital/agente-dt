/**
 * Assistente da atendente — as rotas, com portas falsas: sem login = 401; conversa a que ela não tem acesso (ou de caixa sem
 * unidade) = recusa; etiqueta `interno` = aviso sem modelo; a sugestão NÃO grava nada; pergunta de horário usa a agenda real
 * (porta falsa); teto por pessoa por dia. E o `menu.js` / a página precisam parsear.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';

// o Chatwoot do ambiente de teste: conta e token falsos, e um fetch que só conhece dois logins
process.env.CHATWOOT_API_TOKEN = 'token-da-conta';
process.env.CHATWOOT_CONTA_ID = '1';
process.env.CHATWOOT_URL = 'https://chatwoot.exemplo.test';
const chamadasDoFetch: Array<{ url: string; metodo: string; headers: Record<string, string> }> = [];
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  chamadasDoFetch.push({ url: u, metodo: init?.method ?? 'GET', headers });
  if (u.endsWith('/api/v1/profile')) {
    return headers['access-token'] === 'bom'
      ? new Response(JSON.stringify({ id: 7, name: 'Ana', accounts: [{ id: 1 }] }), { status: 200 })
      : new Response('{}', { status: 401 });
  }
  return new Response(JSON.stringify({ payload: [] }), { status: 200 });
}) as typeof fetch;

const { ajudaDoPortal, corsDoAssistente, criarHandlersDoAssistente, assistenteLigadaPara, assistenteEstadoHandler, assistentePerguntarHandler, assistenteSugerirHandler, leituraComLogin, paginaAssistenteHandler } = await import('./assistente.controller.js');
const { criarTeto } = await import('../lib/chatwoot-assistente.js');
const { montarMenuJs } = await import('./funil.controller.js');
const { criarContextoChatwoot } = await import('../mcp-remoto/chatwoot.js');
type Porta = import('./assistente.controller.js').PortaDeLeitura;

const unit = { id: 'u1', slug: 'doutor-hernia-parauapebas', name: 'Doutor Hérnia Parauapebas', category: 'outro', spineEnabled: true, spineToken: 'tok', spineAiPaused: false, spineAgendaDays: [0, 1, 2, 3, 4, 5, 6] } as unknown as Unit;
const sessao = { token: 'bom', client: 'c', uid: 'ana@dd.com' };

function resp() {
  const r = { codigo: 200, corpo: undefined as any, tipo: '', status(n: number) { r.codigo = n; return r; }, json(c: unknown) { r.corpo = c; return r; }, type(t: string) { r.tipo = t; return r; }, set() { return r; }, send(c: unknown) { r.corpo = c; return r; } };
  return r;
}
const pedido = (body: unknown, headers: Record<string, string> = {}) => ({ body, ip: '1.1.1.1', get: (n: string) => headers[n.toLowerCase()] }) as unknown as Request;
const asRes = (r: ReturnType<typeof resp>) => r as unknown as Response;

const ok = (reply: string) => ({ ok: true as const, reply, actions: [], timeline: [], meta: { base: 'vivo' as const, model: 'fake', iterations: 1, totalLatencyMs: 1, tokens: { prompt: 1, completion: 1, total: 2 }, costUsd: null } });

/** Um Chatwoot falso que SÓ sabe ler: qualquer outra coisa é registrada e o teste reclama. */
function leituraFalsa(o: { caixa?: number | null; etiquetas?: string[]; negar?: number; mensagens?: unknown[]; caixas?: number[] } = {}) {
  const chamadas: string[] = [];
  const porta: Porta = {
    async conversa(id) {
      chamadas.push(`conversa:${id}`);
      if (o.negar) throw Object.assign(new Error('sem acesso'), { status: o.negar });
      return { lida: { id, nome: 'Maria', telefone: '+5594999990000', attrs: {}, etiquetas: o.etiquetas ?? [], grupo: false, interno: (o.etiquetas ?? []).includes('interno') }, caixa: o.caixa === undefined ? 2 : o.caixa };
    },
    async mensagens(id) {
      chamadas.push(`mensagens:${id}`);
      return { payload: o.mensagens ?? [{ message_type: 0, content: 'tem horário amanhã de manhã?', private: false }] };
    },
    async caixas() {
      chamadas.push('caixas');
      return o.caixas ?? [2];
    },
  };
  return { porta, chamadas };
}

function montar(o: { leitura: Porta; rodar?: (...a: any[]) => Promise<any>; grade?: any; teto?: ReturnType<typeof criarTeto>; ligada?: boolean }) {
  const modelo = { chamadas: 0 };
  const h = criarHandlersDoAssistente({
    autenticar: async () => ({ nome: 'Ana', id: 7, sessao, leitura: o.leitura }),
    unidade: async (slug) => (slug === unit.slug ? unit : null),
    assistente: {
      rodarTeste: (async (...a: any[]) => {
        modelo.chamadas++;
        return o.rodar ? o.rodar(...a) : ok('Oi, Maria! Posso ajudar com o horário.');
      }) as any,
      grade: o.grade ?? (async () => ({ erro: null, slots: [] })),
      contaDividida: async () => null,
      ajuda: async () => [],
      hoje: () => '2026-11-16',
    },
    teto: o.teto ?? criarTeto(80),
    dia: () => '2026-11-16',
    ligadaPara: () => o.ligada ?? true,
  });
  return { h, modelo };
}

test('sem login do Chatwoot = 401 (nas três rotas); login que o Chatwoot recusa também', async () => {
  for (const f of [assistenteEstadoHandler, assistenteSugerirHandler, assistentePerguntarHandler]) {
    const r = resp();
    await f(pedido({ conversaId: 5, pergunta: 'oi?' }), asRes(r));
    assert.equal(r.codigo, 401);
    assert.equal(r.corpo.sessao, 'invalida');
  }
  // cabeçalhos com quebra de linha não valem como login
  const r2 = resp();
  await assistenteSugerirHandler(pedido({ conversaId: 5 }, { 'x-cw-token': 'bom\nx', 'x-cw-client': 'c', 'x-cw-uid': 'a@b.c' }), asRes(r2));
  assert.equal(r2.codigo, 401);
  // o Chatwoot diz que o login é inválido
  const r3 = resp();
  await assistenteSugerirHandler(pedido({ conversaId: 5 }, { 'x-cw-token': 'velho', 'x-cw-client': 'c', 'x-cw-uid': 'a@b.c' }), asRes(r3));
  assert.equal(r3.codigo, 401);
});

test('conversa a que ela não tem acesso, ou de caixa sem unidade, ou desligada = recusa, sem gastar modelo nem teto', async () => {
  for (const [nome, o, codigo] of [
    ['sem acesso (404 do Chatwoot)', { negar: 404 }, 403],
    ['sem acesso (403 do Chatwoot)', { negar: 403 }, 403],
    ['caixa que não tem unidade', { caixa: 9 }, 422],
  ] as const) {
    const { porta, chamadas } = leituraFalsa(o);
    const teto = criarTeto(1);
    const { h, modelo } = montar({ leitura: porta, teto });
    const r = resp();
    await h.sugerir(pedido({ conversaId: 31 }), asRes(r));
    assert.equal(r.codigo, codigo, nome);
    assert.equal(modelo.chamadas, 0, nome);
    assert.ok(!chamadas.includes('mensagens:31'), `${nome}: nem leu as mensagens`);
    assert.equal(teto.gastar('7', '2026-11-16').ok, true, `${nome}: o teto está intacto`);
  }
  const { porta } = leituraFalsa();
  const { h, modelo } = montar({ leitura: porta, ligada: false });
  const r = resp();
  await h.sugerir(pedido({ conversaId: 31 }), asRes(r));
  assert.equal(r.codigo, 422);
  assert.match(r.corpo.error, /não está ligada/);
  assert.equal(modelo.chamadas, 0);
  // entrada inválida
  const r2 = resp();
  await h.sugerir(pedido({ conversaId: 'abc' }), asRes(r2));
  assert.equal(r2.codigo, 400);
});

test('etiqueta interno: avisa e NÃO sugere resposta a paciente (sem modelo, sem teto)', async () => {
  const { porta, chamadas } = leituraFalsa({ etiquetas: ['interno'] });
  const teto = criarTeto(1);
  const { h, modelo } = montar({ leitura: porta, teto });
  const r = resp();
  await h.sugerir(pedido({ conversaId: 31 }), asRes(r));
  assert.equal(r.codigo, 200);
  assert.equal(r.corpo.semSugestao, 'interno');
  assert.match(r.corpo.aviso, /interno/);
  assert.equal(r.corpo.sugestao, undefined);
  assert.equal(modelo.chamadas, 0);
  assert.ok(!chamadas.includes('mensagens:31'));
  assert.equal(teto.gastar('7', '2026-11-16').ok, true);
});

test('sugerir: devolve o texto, as fontes e NÃO grava nada (o Chatwoot só foi lido; o modelo só tem ferramentas de leitura)', async () => {
  const { porta, chamadas } = leituraFalsa();
  let ferramentas: string[] = [];
  const { h } = montar({
    leitura: porta,
    rodar: async (_u: Unit, _m: unknown, opts: any) => {
      ferramentas = opts.ferramentas({ onCall: () => undefined, tz: 'x' }).map((t: any) => t.name);
      return ok('Oi, Maria! Qual turno fica melhor para você?');
    },
  });
  const r = resp();
  await h.sugerir(pedido({ conversaId: 31 }), asRes(r));
  assert.equal(r.codigo, 200);
  assert.equal(r.corpo.sugestao, 'Oi, Maria! Qual turno fica melhor para você?');
  assert.deepEqual(ferramentas, ['horarios_livres', 'buscar_na_ajuda']);
  // a porta do Chatwoot que o handler recebe nem TEM método de escrita
  assert.deepEqual(Object.keys(porta).sort(), ['caixas', 'conversa', 'mensagens']);
  assert.deepEqual(chamadas, ['conversa:31', 'mensagens:31']);
});

test('leitura com o login dela: só GET, com os cabeçalhos DELA (não o token da conta)', async () => {
  const chamadas: Array<{ metodo: string; url: string; headers: Record<string, string> }> = [];
  const ctx = criarContextoChatwoot(
    { url: 'https://chatwoot.exemplo.test', conta: 1, token: 'token-da-conta' },
    {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        chamadas.push({ metodo: init?.method ?? 'GET', url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
        return new Response(JSON.stringify(String(url).endsWith('/inboxes') ? { payload: [{ id: 2 }, { id: 5 }] } : { id: 31, inbox_id: 2, labels: ['interno'], meta: { sender: { name: 'Maria' } }, payload: [] }), { status: 200 });
      }) as typeof fetch,
    },
  );
  const leitura = leituraComLogin(ctx, sessao);
  const c = await leitura.conversa(31);
  await leitura.mensagens(31);
  assert.deepEqual(await leitura.caixas(), [2, 5]);
  assert.equal(c.caixa, 2);
  assert.equal(c.lida.interno, true);
  assert.ok(chamadas.length === 3 && chamadas.every((x) => x.metodo === 'GET'));
  assert.ok(chamadas.every((x) => x.headers['access-token'] === 'bom' && x.headers.uid === 'ana@dd.com' && !x.headers.api_access_token));
});

test('mensagens: o Chatwoot dá 20 por vez; a leitura pede as anteriores (até 40) e junta em ordem', async () => {
  const pedidos: string[] = [];
  const lote = (de: number, ate: number) => Array.from({ length: ate - de + 1 }, (_, i) => ({ id: de + i, message_type: 0, content: `m${de + i}` }));
  const ctx = criarContextoChatwoot(
    { url: 'https://chatwoot.exemplo.test', conta: 1, token: 'token-da-conta' },
    {
      fetch: (async (url: string | URL | Request) => {
        pedidos.push(String(url));
        const antes = new URL(String(url)).searchParams.get('before');
        const payload = !antes ? lote(81, 100) : antes === '81' ? lote(61, 80) : lote(41, 60);
        return new Response(JSON.stringify({ payload }), { status: 200 });
      }) as typeof fetch,
    },
  );
  const r = (await leituraComLogin(ctx, sessao).mensagens(31)) as { payload: Array<{ id: number }> };
  assert.equal(r.payload.length, 40);
  assert.deepEqual([r.payload[0]!.id, r.payload[39]!.id], [61, 100]);
  assert.equal(pedidos.length, 2, 'duas páginas, não a conversa inteira');
  assert.match(pedidos[1]!, /before=81/);
});

test('Central de Ajuda do portal: lê as páginas, guarda 10 min, junta leituras simultâneas e não martela o portal fora do ar', async () => {
  let chamadas = 0;
  let fora = false;
  const ctx = criarContextoChatwoot(
    { url: 'https://chatwoot.exemplo.test', conta: 1, token: 'token-da-conta' },
    {
      fetch: (async (url: string | URL | Request) => {
        chamadas++;
        await new Promise((ok) => setTimeout(ok, 5));
        if (fora) return new Response('{}', { status: 500 });
        const pagina = new URL(String(url)).searchParams.get('page');
        assert.match(String(url), /portals\/ajuda\/articles/);
        return new Response(JSON.stringify({ payload: pagina === '1' ? [{ id: 1, title: 'Marcar perdido', status: 'published', content: 'x' }, { id: 2, title: 'Rascunho', status: 'draft' }] : [] }), { status: 200 });
      }) as typeof fetch,
    },
  );
  const ajuda = ajudaDoPortal(ctx);
  const [a, b] = await Promise.all([ajuda(), ajuda()]);
  assert.deepEqual(a.map((x) => x.id), [1]);
  assert.deepEqual(b, a);
  assert.equal(chamadas, 2, 'duas páginas, uma leitura só para as duas perguntas');
  await ajuda();
  assert.equal(chamadas, 2, 'cache');
  // portal fora do ar (cache novo): falha, e a próxima pergunta nem tenta de novo por 1 minuto
  fora = true;
  const quebrada = ajudaDoPortal(ctx);
  await assert.rejects(quebrada());
  const antes = chamadas;
  await assert.rejects(quebrada());
  assert.equal(chamadas, antes);
});

test('CORS do botão: só GET de estado, só da origem do Chatwoot, sem credenciais', () => {
  const cw = 'https://chatwoot.exemplo.test';
  const ok = corsDoAssistente('/api/public/assistente/estado', cw, cw);
  assert.deepEqual(ok?.allowedHeaders, ['X-CW-Token', 'X-CW-Client', 'X-CW-Uid']);
  assert.equal(ok?.credentials, false);
  assert.deepEqual(ok?.methods, ['GET', 'OPTIONS']);
  assert.equal(corsDoAssistente('/api/public/assistente/sugerir', cw, cw), null);
  assert.equal(corsDoAssistente('/api/public/assistente/estado', 'https://outro.exemplo.test', cw), null);
  assert.equal(corsDoAssistente('/api/public/assistente/estado', cw, undefined), null);
});

test('perguntar com conversa de caixa sem a assistente: a dúvida vale (cai para as caixas dela); sugerir não', async () => {
  const { porta } = leituraFalsa({ caixa: 9, caixas: [2, 9] });
  const { h, modelo } = montar({ leitura: porta });
  const r = resp();
  await h.perguntar(pedido({ pergunta: 'como marco perdido?', conversaId: 31 }), asRes(r));
  assert.equal(r.codigo, 200);
  assert.equal(modelo.chamadas, 1);
  const r2 = resp();
  await h.sugerir(pedido({ conversaId: 31 }), asRes(r2));
  assert.equal(r2.codigo, 422);
  assert.equal(modelo.chamadas, 1);
});

test('perguntar sobre horário: usa a agenda REAL (porta falsa) e diz de onde veio', async () => {
  const lidos: string[] = [];
  const { porta } = leituraFalsa();
  const { h } = montar({
    leitura: porta,
    grade: async (_u: Unit, dia: string) => {
      lidos.push(dia);
      return { erro: null, slots: dia === '2026-11-17' ? [{ time: '08:00', status: 'livre' }, { time: '09:00', status: 'livre' }] : [] };
    },
    rodar: async (_u: Unit, _m: unknown, opts: any) => {
      const [horarios] = opts.ferramentas({ onCall: () => undefined, tz: 'x' });
      const lido = await horarios.invoke({ data: '2026-11-17', turno: 'manha' });
      return ok(`Amanhã de manhã tem: ${/08:00, 09:00/.test(lido) ? '8h e 9h' : 'nada'}.`);
    },
  });
  const r = resp();
  await h.perguntar(pedido({ pergunta: 'tem horário amanhã de manhã?', conversaId: 31 }), asRes(r));
  assert.equal(r.codigo, 200);
  assert.equal(r.corpo.resposta, 'Amanhã de manhã tem: 8h e 9h.');
  assert.equal(lidos[0], '2026-11-17'); // a grade foi lida de verdade, a partir do dia pedido
  assert.ok(lidos.length >= 2 && lidos.every((dia) => dia >= '2026-11-17'));
  assert.ok(r.corpo.fontes.includes('agenda da clínica'));
});

test('perguntar: sem conversa usa a única unidade ligada entre as caixas dela; histórico começa pela pessoa', async () => {
  let falas: any[] = [];
  const { porta } = leituraFalsa({ caixas: [1, 2, 3] });
  const { h } = montar({ leitura: porta, rodar: async (_u: Unit, m: any[]) => { falas = m; return ok('R$ 350.'); } });
  const r = resp();
  await h.perguntar(pedido({ pergunta: 'qual o valor?', historico: [{ role: 'assistant', content: 'solta' }, { role: 'user', content: 'oi' }, { role: 'assistant', content: 'olá' }] }), asRes(r));
  assert.equal(r.codigo, 200);
  assert.equal(r.corpo.resposta, 'R$ 350.');
  assert.deepEqual(falas.map((f) => f.role), ['user', 'assistant', 'user']);
  // sem nenhuma caixa ligada para ela
  const { porta: nada } = leituraFalsa({ caixas: [1, 3] });
  const { h: h2, modelo } = montar({ leitura: nada });
  const r2 = resp();
  await h2.perguntar(pedido({ pergunta: 'qual o valor?' }), asRes(r2));
  assert.equal(r2.codigo, 422);
  assert.equal(modelo.chamadas, 0);
  // e o estado (o botão só aparece se for true)
  const r3 = resp();
  await h.estado(pedido({}), asRes(r3));
  assert.deepEqual(r3.corpo, { ligada: true });
  const r4 = resp();
  await h2.estado(pedido({}), asRes(r4));
  assert.deepEqual(r4.corpo, { ligada: false });
});

test('teto por dia: depois do limite, 429 sem chamar o modelo; falha do modelo devolve a chamada', async () => {
  const { porta } = leituraFalsa();
  const teto = criarTeto(2);
  const { h, modelo } = montar({ leitura: porta, teto });
  const codigos: number[] = [];
  for (let i = 0; i < 4; i++) {
    const r = resp();
    await h.perguntar(pedido({ pergunta: 'qual o valor?' }), asRes(r));
    codigos.push(r.codigo);
  }
  assert.deepEqual(codigos, [200, 200, 429, 429]);
  assert.equal(modelo.chamadas, 2);
  // o teto vale para sugerir também (é um só por pessoa)
  const r = resp();
  await h.sugerir(pedido({ conversaId: 31 }), asRes(r));
  assert.equal(r.codigo, 429);
  // modelo fora do ar: a chamada volta
  const teto2 = criarTeto(1);
  const { h: h2 } = montar({ leitura: porta, teto: teto2, rodar: async () => ({ ok: false, status: 500, error: 'playground_failed' }) });
  const f = resp();
  await h2.perguntar(pedido({ pergunta: 'qual o valor?' }), asRes(f));
  assert.equal(f.codigo, 502);
  assert.equal(teto2.gastar('7', '2026-11-16').ok, true);
});

test('ligada só nas unidades da lista (ou *); vazia = desligada', () => {
  assert.equal(assistenteLigadaPara('doutor-hernia-parauapebas', undefined), false);
  assert.equal(assistenteLigadaPara('doutor-hernia-parauapebas', ''), false);
  assert.equal(assistenteLigadaPara('doutor-hernia-parauapebas', 'a, doutor-hernia-parauapebas'), true);
  assert.equal(assistenteLigadaPara('outra', 'doutor-hernia-parauapebas'), false);
  assert.equal(assistenteLigadaPara('outra', '*'), true);
});

test('menu.js (menu + botão da assistente) e a página do painel PARSEIAM como JavaScript', () => {
  const js = montarMenuJs('https://agente.exemplo.test');
  assert.doesNotThrow(() => new Function(js));
  assert.ok(!js.includes('__AGENTE__'));
  assert.ok(js.includes('"https://agente.exemplo.test"'));
  // o menu de antes continua lá, e o botão novo também
  assert.match(js, /__funilMenu/);
  assert.match(js, /__assistenteDD/);
  assert.match(js, /\/api\/public\/assistente\/estado/);

  const r = resp();
  paginaAssistenteHandler({} as Request, asRes(r));
  const html = String(r.corpo);
  assert.ok(!html.includes('__ORIGEM_CW__'));
  assert.ok(html.includes('"https://chatwoot.exemplo.test"'));
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, 'a página tem script');
  assert.doesNotThrow(() => new Function(script!));
  // o painel só fala com a página-mãe do Chatwoot e nunca manda nada ao paciente
  assert.match(script!, /ev\.origin !== ORIGEM_CW \|\| ev\.source !== window\.parent/);
  assert.doesNotMatch(script!, /\/funil\/mensagem|\/funil\/nota/);
});
