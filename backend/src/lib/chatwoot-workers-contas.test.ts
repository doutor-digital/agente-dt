/**
 * Passo 3b1 (agenda, CAPI, duplicados, celular por unidade): cada worker usa o Chatwoot da CONTA da caixa/unidade. Identidade de Parauapebas:
 * só com ela, as chamadas são as de sempre — as mesmas caixas, na mesma ordem, com os mesmos argumentos e o MESMO contexto do Chatwoot.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const U = await import('./chatwoot-unidades.js');
const C = await import('../mcp-remoto/chatwoot.js');
const Agenda = await import('./chatwoot-agenda.js');
const Capi = await import('./chatwoot-capi.js');
const Dup = await import('./chatwoot-duplicados.js');

const PARAU = U.SEMENTE_PARAUAPEBAS.slug;
const AMBIENTE = { CHATWOOT_API_TOKEN: 'tk-do-ambiente', CHATWOOT_CONTA_ID: '1', CHATWOOT_URL: 'https://crm.exemplo.test', CHATWOOT_AGENDA_SLUGS: PARAU, CHATWOOT_CAPI_SLUGS: PARAU, CHATWOOT_DUPLICADOS_SLUGS: PARAU } as NodeJS.ProcessEnv;
const DEMO: import('./chatwoot-unidades.js').ConfigChatwootUnidade = {
  slug: 'clinica-demonstracao',
  contaId: 2,
  prefixoModelos: 'demo_',
  usuarioCelularId: 77,
  gerenteId: 51,
  metaAgendamentosDia: 5,
  kapsoPhoneNumberId: '404404404404',
  wabaId: '999888777666555',
  envSufixo: 'DEMO',
  dadosModelos: { nome: 'Clínica Demonstração', cidade: 'Demonstração', endereco: 'Rua Exemplo, 100 — Centro, Demonstração/PA', mapa: 'https://maps.example/demo' },
  caixas: [{ id: 20, tipo: 'cloud' }],
};
const ctxDoAmbiente = (fetchFalso?: typeof fetch) => C.criarContextoChatwoot(C.contaChatwootDoAmbiente(AMBIENTE), fetchFalso ? { fetch: fetchFalso } : {});

afterEach(() => {
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS]);
  for (const k of ['CHATWOOT_AGENDA_SLUGS', 'CHATWOOT_CAPI_SLUGS', 'CHATWOOT_DUPLICADOS_SLUGS']) delete process.env[k];
});

// o estado de cada automação lê o ambiente do processo (estadoDaAutomacao); o teste põe as listas lá
const comAmbiente = <T>(f: () => Promise<T>): Promise<T> => {
  for (const k of ['CHATWOOT_AGENDA_SLUGS', 'CHATWOOT_CAPI_SLUGS', 'CHATWOOT_DUPLICADOS_SLUGS']) process.env[k] = PARAU;
  return f();
};

// ── agenda ───────────────────────────────────────────────────────────────────────────────────────

test('AGENDA — identidade: só com Parauapebas, o ciclo roda nas MESMAS caixas, na mesma ordem, com os mesmos argumentos e o MESMO contexto', () =>
  comAmbiente(async () => {
    const ctx = ctxDoAmbiente();
    const chamadas: Array<{ ctx: unknown; caixa: number; slug: string; modo: string }> = [];
    await Agenda.varrerAgenda(ctx, (async (c: unknown, caixa: number, slug: string, modo: string) => void chamadas.push({ ctx: c as never, caixa, slug, modo })) as never, AMBIENTE);
    assert.deepEqual(chamadas.map((c) => [c.caixa, c.slug, c.modo]), Object.keys({ ...U.CAIXAS_REGUA }).map((caixa) => [Number(caixa), PARAU, 'ligado']));
    assert.ok(chamadas.length >= 2 && chamadas.every((c) => c.ctx === ctx), 'o mesmo contexto (===)');
  }));

test('AGENDA — clínica de conta 2: o ciclo dela vai no contexto da conta 2 e nasce em SECO; o de Parauapebas não muda', () =>
  comAmbiente(async () => {
    U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO]);
    const ctx = ctxDoAmbiente();
    const chamadas: Array<{ ctx: import('../mcp-remoto/chatwoot.js').ContextoChatwoot; caixa: number; slug: string; modo: string }> = [];
    await Agenda.varrerAgenda(ctx, (async (c: unknown, caixa: number, slug: string, modo: string) => void chamadas.push({ ctx: c as never, caixa, slug, modo })) as never, AMBIENTE);
    const parau = chamadas.filter((c) => c.slug === PARAU);
    const demo = chamadas.filter((c) => c.slug === 'clinica-demonstracao');
    assert.ok(parau.length >= 2 && parau.every((c) => c.ctx === ctx && c.modo === 'ligado'));
    assert.deepEqual(demo.map((c) => [c.caixa, c.modo]), [[20, 'seco']], 'sem nada gravado: SECO');
    assert.equal(demo[0]!.ctx.conta!.conta, 2);
    assert.equal(demo[0]!.ctx.conta!.token, 'tk-do-ambiente', 'sem o token da conta: o global');
  }));

test('AGENDA — a memória das notas do seco leva a caixa (a conversa 5 da caixa 3 não cala a conversa 5 da caixa 20)', () => {
  assert.notEqual(Agenda.chaveDaNota(3, 5, { etapa: 'Agendado' }), Agenda.chaveDaNota(20, 5, { etapa: 'Agendado' }));
});

test('AGENDA — caixa de unidade sem conta válida é pulada, sem chamar o Chatwoot', () =>
  comAmbiente(async () => {
    U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, { ...DEMO, contaId: -2 } as never]);
    const chamadas: string[] = [];
    await Agenda.varrerAgenda(ctxDoAmbiente(), (async (_c: unknown, _caixa: number, slug: string) => void chamadas.push(slug)) as never, AMBIENTE);
    assert.ok(!chamadas.includes('clinica-demonstracao'));
  }));

// ── CAPI ─────────────────────────────────────────────────────────────────────────────────────────

function urlsDoChat() {
  const urls: Array<{ url: string; token: string | undefined }> = [];
  const f = (async (url: string, o: { headers?: Record<string, string> }) => {
    urls.push({ url: String(url), token: o.headers?.api_access_token });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { payload: [] } }) } as Response;
  }) as unknown as typeof fetch;
  return { urls, f };
}

test('CAPI — identidade: só com Parauapebas, as mesmas caixas oficiais, na mesma ordem, mesmos argumentos e o chat na conta 1', () =>
  comAmbiente(async () => {
    const { urls, f } = urlsDoChat();
    const ctx = ctxDoAmbiente(f);
    const chamadas: Array<{ caixa: number; slug: string; waba: string; modo: string }> = [];
    let chat: import('./chatwoot-capi.js').ChatDoCapi | null = null;
    await Capi.varrerCapi(ctx, {
      armazem: {} as never,
      meta: {} as never,
      tokens: new Map(),
      e: AMBIENTE,
      ciclo: (async (deps: import('./chatwoot-capi.js').DepsDoCapi, caixa: number, slug: string, waba: string, modo: string) => {
        chamadas.push({ caixa, slug, waba, modo });
        chat = deps.chat;
      }) as never,
    });
    assert.deepEqual(chamadas, Object.entries({ ...U.CAIXAS_CAPI }).map(([caixa, x]) => ({ caixa: Number(caixa), slug: x.slug, waba: x.waba, modo: 'ligado' })));
    assert.ok(chamadas.length >= 1);
    await chat!.pagina(3, 1);
    assert.deepEqual(urls.map((u) => u.url), ['https://crm.exemplo.test/api/v1/accounts/1/conversations?inbox_id=3&status=all&assignee_type=all&page=1']);
    assert.equal(urls[0]!.token, 'tk-do-ambiente');
  }));

test('CAPI — clínica de conta 2: o chat dela lê a conta 2 (com o token da conta 2) e o ciclo nasce em SECO; Parauapebas continua na conta 1', () =>
  comAmbiente(async () => {
    U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO]);
    const { urls, f } = urlsDoChat();
    const ctx = ctxDoAmbiente(f);
    const env = { ...AMBIENTE, CHATWOOT_API_TOKEN_DEMO: 'tk-so-da-demo' } as NodeJS.ProcessEnv;
    const vistos: Array<{ caixa: number; modo: string; chat: import('./chatwoot-capi.js').ChatDoCapi }> = [];
    await Capi.varrerCapi(ctx, { armazem: {} as never, meta: {} as never, tokens: new Map(), e: env, ciclo: (async (deps: import('./chatwoot-capi.js').DepsDoCapi, caixa: number, _s: string, _w: string, modo: string) => void vistos.push({ caixa, modo, chat: deps.chat })) as never });
    const demo = vistos.find((v) => v.caixa === 20)!;
    const parau = vistos.find((v) => v.caixa === 3)!;
    assert.equal(demo.modo, 'seco');
    assert.equal(parau.modo, 'ligado');
    await demo.chat.pagina(20, 1);
    await parau.chat.pagina(3, 1);
    assert.deepEqual(urls.map((u) => [u.url.includes('/accounts/2/'), u.token]), [[true, 'tk-so-da-demo'], [false, 'tk-do-ambiente']]);
    assert.ok(urls[1]!.url.includes('/accounts/1/'));
  }));

// ── duplicados ───────────────────────────────────────────────────────────────────────────────────

/** Um Chatwoot de mentira só de contatos: um par duplicado (com e sem o 9) por conta, e o registro das escritas NA ORDEM. */
function chatwootDeContatos() {
  const log: string[] = [];
  const f = (async (url: string, o: { method?: string; body?: string } = {}) => {
    const u = new URL(url);
    const metodo = o.method ?? 'GET';
    log.push(`${metodo} ${u.pathname}${u.search}${o.body ? ` ${o.body}` : ''}`);
    if (metodo === 'GET' && u.pathname.endsWith('/contacts')) {
      const pagina = u.searchParams.get('page');
      const conta = /accounts\/(\d+)/.exec(u.pathname)![1];
      const base = Number(conta) * 100;
      return { ok: true, status: 200, text: async () => JSON.stringify({ payload: pagina === '1' ? [{ id: base + 1, name: 'Maria', phone_number: '+5594984325883' }, { id: base + 2, name: 'Maria', phone_number: '+559484325883' }] : [] }) } as Response;
    }
    if (metodo === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify({ payload: [] }) } as Response;
    return { ok: true, status: 200, text: async () => '{}' } as Response;
  }) as unknown as typeof fetch;
  return { log, f };
}

test('DUPLICADOS — identidade: só com Parauapebas, as chamadas são EXATAMENTE as de cicloDuplicados direto na conta 1 (mesma ordem, mesmo teto)', async () => {
  process.env.CHATWOOT_DUPLICADOS_SLUGS = PARAU;
  const a = chatwootDeContatos();
  await Dup.cicloDuplicados(Dup.portasDoChatwoot(ctxDoAmbiente(a.f)), 'ligado');
  const b = chatwootDeContatos();
  await Dup.varrerContasDeDuplicados(ctxDoAmbiente(b.f), AMBIENTE);
  assert.deepEqual(b.log, a.log);
  assert.ok(b.log.some((l) => l.startsWith('POST') && l.includes('/accounts/1/actions/contact_merge')), 'juntou na conta 1');
  assert.ok(b.log.every((l) => !l.includes('/accounts/2/')));
});

test('DUPLICADOS — uma clínica nova em SECO (conta 2) NÃO segura a junção de Parauapebas, e a junção de Parauapebas nunca toca a conta 2', async () => {
  process.env.CHATWOOT_DUPLICADOS_SLUGS = PARAU;
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO]);
  assert.equal(Dup.estadoDuplicados(null), 'ligado', 'Parauapebas: o estado dela, sem a demo segurar');
  assert.equal(Dup.estadoDuplicados(2), 'seco', 'a conta nova nasce em seco');
  const c = chatwootDeContatos();
  await Dup.varrerContasDeDuplicados(ctxDoAmbiente(c.f), AMBIENTE);
  const conta1 = c.log.filter((l) => l.includes('/accounts/1/'));
  const conta2 = c.log.filter((l) => l.includes('/accounts/2/'));
  assert.ok(conta1.some((l) => l.startsWith('POST') && l.includes('contact_merge')), 'Parauapebas juntou');
  assert.ok(conta2.length > 0 && !conta2.some((l) => l.includes('contact_merge')), 'a conta 2 não juntou nada');
  assert.ok(conta2.some((l) => l.startsWith('POST') && l.includes('/notes') && l.includes('[SECO]')), 'a conta 2 só deixou a nota do seco');
  // o contato do merge é o de Parauapebas (ids 101/102), nunca o da conta 2 (201/202)
  assert.ok(c.log.filter((l) => l.includes('contact_merge')).every((l) => l.includes('"base_contact_id":101')));
});

test('DUPLICADOS — dentro da MESMA conta (unidades sem conta própria), vale o estado mais restrito (junção não tem volta)', () => {
  process.env.CHATWOOT_DUPLICADOS_SLUGS = PARAU;
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, { ...DEMO, contaId: null }]);
  assert.equal(Dup.estadoDuplicados(null), 'desligado', 'a outra unidade da mesma conta não está ligada: segura as duas (a mais restrita)');
});

// ── celular por unidade ──────────────────────────────────────────────────────────────────────────

test('CELULAR — o usuário «📱 Celular» é DA UNIDADE: o 7 é de Parauapebas, o 77 da demo; um não vale na outra', () => {
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO]);
  assert.equal(U.ehUsuarioCelular(7, PARAU), true);
  assert.equal(U.ehUsuarioCelular(7, 'clinica-demonstracao'), false);
  assert.equal(U.ehUsuarioCelular(77, 'clinica-demonstracao'), true);
  assert.equal(U.ehUsuarioCelular(77, PARAU), false);
  assert.equal(U.ehUsuarioCelular(7, 'unidade-desconhecida'), false);
  assert.equal(U.ehUsuarioCelular(null, PARAU), false);
});
