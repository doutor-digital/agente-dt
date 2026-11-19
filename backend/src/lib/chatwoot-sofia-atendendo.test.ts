/**
 * «Sofia atendendo» (19/11/2026): conversa nova da caixa em que a Sofia é robô vai para «Abertas» já na 1ª mensagem e leva a etiqueta
 * `sofia-atendendo`; a etiqueta sai quando a equipe responde (CRM ou celular), quando a Sofia passa para a equipe, quando a rodada não responde
 * e quando a conversa é resolvida; volta se a Sofia voltar a atender. Chave `CHATWOOT_SOFIA_ATENDENDO=0` desliga.
 */
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const A = await import('./chatwoot-sofia-atendendo.js');
const IA = await import('./chatwoot-ia.js');
const C = await import('../mcp-remoto/chatwoot.js');
const { ETIQUETA_PAUSA } = await import('./chatwoot-pausa.js');
const { ETIQUETA_HUMANO } = await import('./chatwoot-sofia.js');

const { ETIQUETA_SOFIA_ATENDENDO: ETQ } = A;
const CAIXAS = { 3: 'doutor-hernia-parauapebas' };

// ── a regra pura ─────────────────────────────────────────────────────────────────────────────────

/** Um Chatwoot de mentira com UMA conversa (estado vivo): registra cada chamada. */
function mundo(c: { status: string; labels?: readonly string[]; attrs?: Record<string, unknown>; assignee?: number | null; falhaAbrir?: boolean; etiquetaNaConta?: boolean; pausaNoMeio?: boolean }) {
  const conv = { status: c.status, labels: [...(c.labels ?? [])] };
  const log: string[] = [];
  let naConta = c.etiquetaNaConta ?? false;
  const p: import('./chatwoot-sofia-atendendo.js').PortaDoAtendimento = {
    async conversa(id) {
      log.push(`GET ${id}`);
      return {
        status: conv.status,
        lida: { id, nome: 'Maria', telefone: '+5594999990000', attrs: { ...(c.attrs ?? {}) }, etiquetas: [...conv.labels], grupo: false, interno: conv.labels.includes('interno') },
      };
    },
    async etiquetas(id, lista) {
      log.push(`LABELS ${id} ${lista.join(',')}`);
      // corrida: a pausa gravou a lista dela (etiqueta + atributo) entre a nossa leitura e a nossa gravação — a nossa regrava por cima
      if (c.pausaNoMeio) {
        c.pausaNoMeio = false;
        (c.attrs ??= {}).ia_pausada_por = 'Lorena';
        conv.labels = [...lista];
        return;
      }
      conv.labels = [...lista];
    },
    async abrir(id) {
      log.push(`ABRIR ${id}`);
      if (c.falhaAbrir) throw new Error('Chatwoot 403');
      conv.status = 'open';
    },
    async garantirEtiqueta() {
      if (!naConta) log.push('CRIAR-ETIQUETA');
      naConta = true;
    },
  };
  return { p, conv, log };
}

test('começo: conversa PENDENTE vai para «Abertas» e ganha a etiqueta, sem perder as que já tinha (anuncio)', async () => {
  const m = mundo({ status: 'pending', labels: ['anuncio'] });
  const r = await A.comecarAtendimento(5, m.p);
  assert.deepEqual(r, { comeco: 'etiquetada', abriu: true });
  assert.equal(m.conv.status, 'open');
  assert.deepEqual(m.conv.labels, ['anuncio', ETQ]);
  assert.ok(m.log.includes('CRIAR-ETIQUETA'), 'a etiqueta é criada na conta (roxa) antes do 1º uso');
  // a lista é relida logo ANTES de gravar (abrir e criar a etiqueta demoram) e conferida DEPOIS de gravar
  assert.deepEqual(m.log.filter((l) => l.startsWith('GET') || l === 'ABRIR 5' || l === 'CRIAR-ETIQUETA' || l.startsWith('LABELS')), ['GET 5', 'ABRIR 5', 'CRIAR-ETIQUETA', 'GET 5', 'LABELS 5 anuncio,sofia-atendendo', 'GET 5']);
});

test('começo: já aberta sem etiqueta → só a etiqueta (sem toggle); já com a etiqueta → não regrava; repetir é seguro', async () => {
  const m = mundo({ status: 'open' });
  assert.deepEqual(await A.comecarAtendimento(5, m.p), { comeco: 'etiquetada', abriu: false });
  assert.ok(!m.log.some((l) => l.startsWith('ABRIR')));
  const antes = m.log.length;
  assert.deepEqual(await A.comecarAtendimento(5, m.p), { comeco: 'ja-etiquetada', abriu: false });
  assert.equal(m.log.slice(antes).filter((l) => l.startsWith('LABELS')).length, 0);
});

test('começo: conversa em que a Sofia não fala (pausada, esperando humano, interno, tratamento, resolvida) abre mas NÃO leva a etiqueta', async () => {
  for (const c of [
    { status: 'pending', labels: [ETIQUETA_PAUSA] },
    { status: 'pending', labels: [ETIQUETA_HUMANO] },
    { status: 'pending', labels: ['interno'] },
    { status: 'pending', attrs: { funil: 'Tratamento' } },
    { status: 'pending', attrs: { etapa: 'Esperando humano' } },
  ]) {
    const m = mundo(c);
    const r = await A.comecarAtendimento(5, m.p);
    assert.equal(r.comeco, 'sem-etiqueta', JSON.stringify(c));
    assert.equal(r.abriu, true, 'a equipe precisa ver a conversa em «Abertas»');
    assert.ok(!m.conv.labels.includes(ETQ));
  }
  const resolvida = mundo({ status: 'resolved' });
  assert.deepEqual(await A.comecarAtendimento(5, resolvida.p), { comeco: 'sem-etiqueta', abriu: false });
});

test('começo: se abrir falhar (403), a etiqueta ainda é posta; se a conversa sumiu, nada', async () => {
  const m = mundo({ status: 'pending', falhaAbrir: true });
  const r = await A.comecarAtendimento(5, m.p);
  assert.deepEqual(r, { comeco: 'etiquetada', abriu: false });
  assert.deepEqual(m.conv.labels, [ETQ]);
  assert.deepEqual(await A.comecarAtendimento(5, { ...m.p, conversa: async () => null }), { comeco: 'sem-conversa', abriu: false });
});

test('critério da rodada: onde ela vai desistir (cartão no Kommo, teto, sem telefone) a etiqueta NÃO entra — e sai se já estava', async () => {
  const m = mundo({ status: 'open' });
  assert.deepEqual(await A.comecarAtendimento(5, m.p, async () => false), { comeco: 'sem-etiqueta', abriu: false });
  assert.ok(!m.conv.labels.includes(ETQ));
  assert.ok(!m.log.includes('CRIAR-ETIQUETA'), 'nem cria a etiqueta na conta à toa');
  const tinha = mundo({ status: 'open', labels: [ETQ, 'anuncio'] });
  assert.deepEqual(await A.comecarAtendimento(5, tinha.p, async () => false), { comeco: 'sem-etiqueta', abriu: false });
  assert.deepEqual(tinha.conv.labels, ['anuncio'], 'a rodada já tinha desistido: não pisca');
  const ok = mundo({ status: 'open' });
  assert.equal((await A.comecarAtendimento(5, ok.p, async (lida) => lida.telefone !== null)).comeco, 'etiquetada');
});

test('CORRIDA com a pausa: se a nossa gravação desfez a `ia-pausada` (atributo de pausa sem a etiqueta), a pausa volta e a nossa etiqueta sai', async () => {
  const m = mundo({ status: 'open', labels: ['anuncio'], attrs: {}, pausaNoMeio: true });
  const r = await A.comecarAtendimento(5, m.p);
  assert.equal(r.comeco, 'sem-etiqueta');
  assert.deepEqual([...m.conv.labels].sort(), ['anuncio', ETIQUETA_PAUSA]);
  // sem corrida: nenhuma regravação extra
  const limpo = mundo({ status: 'open', labels: ['anuncio'] });
  await A.comecarAtendimento(5, limpo.p);
  assert.equal(limpo.log.filter((l) => l.startsWith('LABELS')).length, 1);
});

test('RODÍZIO: ter responsável (distribuição automática da caixa aberta) NÃO tira a Sofia nem a etiqueta', async () => {
  // a leitura da conversa nem guarda o responsável: só a PALAVRA da equipe (mensagem → pausa) cala a Sofia
  const lida = (await import('./chatwoot-porta.js')).conversaLidaDoChatwoot({
    id: 5, status: 'open', labels: [ETQ], meta: { sender: { name: 'Maria', phone_number: '+5594999990000' }, assignee: { id: 9, name: 'Lorena' } }, custom_attributes: { etapa: 'Novo lead' },
  })!;
  assert.equal(A.sofiaPodeAtender({ status: 'open', lida }), true);
  const aviso = { event: 'conversation_updated', id: 5, inbox_id: 3, status: 'open', labels: [ETQ], meta: { assignee: { id: 9 }, sender: {} }, custom_attributes: {} };
  assert.equal(A.eventoDeAtendimento(aviso, CAIXAS), null, 'a atribuição não gera leitura nem remoção');
});

test('fim: encerrar tira só a nossa etiqueta; conferir só tira se a conversa mostra que a Sofia saiu', async () => {
  const m = mundo({ status: 'open', labels: ['anuncio', ETQ, 'quente'] });
  assert.equal(await A.conferirAtendimento(5, m.p), false, 'aberta e sem pausa: continua atendendo');
  assert.equal(await A.encerrarAtendimento(5, m.p), true);
  assert.deepEqual(m.conv.labels, ['anuncio', 'quente']);
  assert.equal(await A.encerrarAtendimento(5, m.p), false, 'sem a etiqueta não regrava');

  for (const [rotulo, estado] of [
    ['resolvida', { status: 'resolved', labels: [ETQ] }],
    ['pausada', { status: 'open', labels: [ETQ, ETIQUETA_PAUSA] }],
    ['passada à equipe', { status: 'open', labels: [ETQ, ETIQUETA_HUMANO] }],
  ] as const) {
    const x = mundo(estado);
    assert.equal(await A.conferirAtendimento(5, x.p), true, rotulo);
    assert.ok(!x.conv.labels.includes(ETQ), rotulo);
  }
});

test('evento do webhook: só conversa de caixa do mapa, com a etiqueta e que JÁ mostra a Sofia fora; o resto nem lê', () => {
  const base = { event: 'conversation_updated', id: 5, inbox_id: 3, status: 'resolved', labels: [ETQ, 'anuncio'], custom_attributes: {}, meta: { sender: {} } };
  assert.deepEqual(A.eventoDeAtendimento(base, CAIXAS), { conversa: 5 });
  assert.deepEqual(A.eventoDeAtendimento({ ...base, status: 'open', labels: [ETQ, ETIQUETA_PAUSA] }, CAIXAS), { conversa: 5 });
  assert.deepEqual(A.eventoDeAtendimento({ ...base, event: 'conversation_status_changed' }, CAIXAS), { conversa: 5 });
  assert.equal(A.eventoDeAtendimento({ ...base, status: 'open' }, CAIXAS), null, 'a cada mensagem o Chatwoot manda conversation_updated: aberta e sem pausa não lê nada');
  assert.equal(A.eventoDeAtendimento({ ...base, status: 'pending' }, CAIXAS), null);
  assert.equal(A.eventoDeAtendimento({ ...base, labels: ['anuncio'] }, CAIXAS), null, 'sem a etiqueta');
  assert.equal(A.eventoDeAtendimento({ ...base, inbox_id: 9 }, CAIXAS), null, 'caixa fora do mapa');
  assert.equal(A.eventoDeAtendimento({ ...base, event: 'message_created' }, CAIXAS), null);
  assert.equal(A.eventoDeAtendimento({ ...base, status: undefined }, CAIXAS), null, 'aviso sem status: nada a concluir');
});

test('chave: ligado por padrão; só CHATWOOT_SOFIA_ATENDENDO=0 desliga', () => {
  assert.equal(A.atendimentoLigado({} as NodeJS.ProcessEnv), true);
  assert.equal(A.atendimentoLigado({ CHATWOOT_SOFIA_ATENDENDO: '1' } as NodeJS.ProcessEnv), true);
  assert.equal(A.atendimentoLigado({ CHATWOOT_SOFIA_ATENDENDO: '0' } as NodeJS.ProcessEnv), false);
  assert.equal(A.atendimentoLigado({ CHATWOOT_SOFIA_ATENDENDO: ' 0 ' } as NodeJS.ProcessEnv), false);
});

// ── a etiqueta na conta, no formato que o Chatwoot pede ────────────────────────────────────────────

test('etiqueta da conta: roxa, com a descrição e na barra; criada uma vez só; já existente não recria', async () => {
  const pedidos: Array<{ metodo: string; caminho: string; corpo: any }> = [];
  let existe = false;
  const fetchFalso = (async (url: string, o: { method?: string; body?: string } = {}) => {
    const u = new URL(url);
    pedidos.push({ metodo: o.method ?? 'GET', caminho: u.pathname.replace('/api/v1/accounts/1/', ''), corpo: o.body ? JSON.parse(o.body) : null });
    const r = (j: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) }) as Response;
    return r(o.method === 'GET' ? { payload: existe ? [{ title: ETQ }] : [{ title: 'anuncio' }] } : {});
  }) as unknown as typeof fetch;
  const ctx = C.criarContextoChatwoot({ url: 'https://crm.exemplo.test', conta: 1, token: 'tk' }, { fetch: fetchFalso });
  const porta = A.portaDoAtendimento(ctx, async () => undefined);
  await porta.garantirEtiqueta();
  await porta.garantirEtiqueta();
  const criacoes = pedidos.filter((x) => x.metodo === 'POST' && x.caminho === 'labels');
  assert.equal(criacoes.length, 1);
  assert.deepEqual(criacoes[0]!.corpo, { title: 'sofia-atendendo', description: 'A Sofia (IA) está atendendo esta conversa', color: '#7C3AED', show_on_sidebar: true });
  pedidos.length = 0;
  existe = true;
  await A.portaDoAtendimento(ctx, async () => undefined).garantirEtiqueta();
  assert.equal(pedidos.filter((x) => x.metodo === 'POST').length, 0, 'já existe na conta');
});

// ── o fluxo de verdade (webhook → portas → chamadas ao Chatwoot) ────────────────────────────────────

const ENV = { CHATWOOT_API_TOKEN: 'tk-do-ambiente', CHATWOOT_CONTA_ID: '1', CHATWOOT_URL: 'https://crm.exemplo.test', CHATWOOT_SOFIA_COMO_BOT: '1', CHATWOOT_SOFIA_BOT_TOKEN: 'token-do-robo-123456' } as NodeJS.ProcessEnv;
const CHAVES = [...Object.keys(ENV), 'CHATWOOT_SOFIA_ATENDENDO'];
const salvo = new Map(CHAVES.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const [k, v] of salvo) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  IA.esquecerEstadosDaIa();
  C.esquecerContextoDoAmbiente();
});

/** Chatwoot de mentira com estado: a conversa 5 (status e etiquetas vivos); `quebrar` faz um caminho responder 500. */
function chatwootVivo(ini: { status: string; labels: string[]; attrs?: Record<string, unknown> }, quebrar: RegExp | null = null) {
  const conv = { ...ini, labels: [...ini.labels] };
  const log: string[] = [];
  const f = (async (url: string, o: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const u = new URL(url);
    const metodo = o.method ?? 'GET';
    const caminho = u.pathname.replace('/api/v1/accounts/1/', '');
    const corpo = o.body ? JSON.parse(o.body) : null;
    const quem = o.headers?.api_access_token === 'token-do-robo-123456' ? 'ROBÔ' : 'conta';
    log.push(`${metodo} ${caminho}${corpo ? ` ${JSON.stringify(corpo)}` : ''} [${quem}]`);
    const r = (j: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, text: async () => JSON.stringify(j) }) as Response;
    if (quebrar && quebrar.test(`${metodo} ${caminho}`)) return r({ error: 'falhou' }, false);
    if (metodo === 'GET' && caminho === 'conversations/5') {
      return r({ id: 5, status: conv.status, labels: conv.labels, meta: { sender: { name: 'Maria', phone_number: '+5594999990000' }, assignee: null }, custom_attributes: ini.attrs ?? { etapa: 'Novo lead' } });
    }
    if (metodo === 'POST' && caminho === 'conversations/5/labels') conv.labels = corpo.labels;
    if (metodo === 'POST' && caminho === 'conversations/5/toggle_status') conv.status = corpo.status;
    if (metodo === 'GET' && caminho === 'labels') return r({ payload: [{ title: ETQ }] });
    return r({});
  }) as unknown as typeof fetch;
  return { conv, log, f };
}

const resp = () => ({ json: () => undefined, status: () => ({ json: () => undefined }) }) as never;
const chave = () => IA.chaveDoEvento(ENV.CHATWOOT_API_TOKEN!);
const dispararEvento = async (corpo: unknown) => {
  IA.eventoChatwootHandler({ query: { k: chave() }, body: corpo } as never, resp());
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};
const humana = { event: 'message_created', message_type: 'outgoing', private: false, conversation: { id: 5, inbox_id: 3 }, content_attributes: {}, sender: { id: 9, type: 'user', name: 'Lorena' } };

test('PAUSA pela equipe: a conversa sai de «Pendentes» e a etiqueta sai (caso da conversa 972)', async () => {
  Object.assign(process.env, ENV);
  const w = chatwootVivo({ status: 'pending', labels: ['anuncio', ETQ] });
  const f = mock.method(globalThis, 'fetch', w.f as never);
  try {
    await dispararEvento(humana);
    assert.equal(w.conv.status, 'open');
    assert.deepEqual([...w.conv.labels].sort(), ['anuncio', ETIQUETA_PAUSA].sort(), 'ia-pausada entra e sofia-atendendo sai; as outras ficam');
    assert.ok(w.log.some((l) => l.startsWith('POST conversations/5/toggle_status') && l.endsWith('[ROBÔ]')), 'abre pelo robô (a passagem nativa)');
  } finally {
    f.mock.restore();
  }
});

test('PAUSA: se a pausa falhar no meio (atribuição 500), a conversa ainda abre e a etiqueta ainda sai', async () => {
  Object.assign(process.env, ENV);
  const w = chatwootVivo({ status: 'pending', labels: [ETQ] }, /^POST conversations\/5\/assignments$/);
  const f = mock.method(globalThis, 'fetch', w.f as never);
  try {
    await dispararEvento(humana);
    assert.equal(w.conv.status, 'open');
    assert.ok(!w.conv.labels.includes(ETQ), 'a equipe respondeu: a Sofia não está mais atendendo');
  } finally {
    f.mock.restore();
  }
});

test('pelo CELULAR (eco da coexistência) também tira a etiqueta', async () => {
  Object.assign(process.env, ENV);
  const w = chatwootVivo({ status: 'open', labels: [ETQ] });
  const f = mock.method(globalThis, 'fetch', w.f as never);
  try {
    await dispararEvento({ ...humana, sender: null, content_attributes: { external_echo: true } });
    assert.ok(!w.conv.labels.includes(ETQ));
    assert.ok(w.conv.labels.includes(ETIQUETA_PAUSA));
  } finally {
    f.mock.restore();
  }
});

test('RESOLVIDA: a etiqueta sai; conversa aberta atribuída pelo rodízio NÃO mexe em nada (zero chamadas)', async () => {
  Object.assign(process.env, ENV);
  const w = chatwootVivo({ status: 'resolved', labels: [ETQ, 'anuncio'] });
  const f = mock.method(globalThis, 'fetch', w.f as never);
  try {
    const aviso = (status: string) => ({ event: 'conversation_updated', id: 5, inbox_id: 3, status, labels: [ETQ, 'anuncio'], custom_attributes: { etapa: 'Novo lead' }, meta: { sender: {}, assignee: { id: 9 } } });
    await dispararEvento(aviso('open'));
    assert.deepEqual(w.log, [], 'responsável pelo rodízio: a Sofia segue, nada é lido nem gravado');
    await dispararEvento(aviso('resolved'));
    assert.deepEqual(w.conv.labels, ['anuncio']);
  } finally {
    f.mock.restore();
  }
});

const avisoComEtiqueta = (status: string) => ({ event: 'conversation_updated', id: 5, inbox_id: 3, status, labels: [ETQ], custom_attributes: { etapa: 'Novo lead' }, meta: { sender: {} } });

test('CHAVE CHATWOOT_SOFIA_ATENDENDO=0: a etiqueta que já existia é TIRADA (mesmo com a conversa aberta e a Sofia livre); nada é posto; a pausa segue abrindo', async () => {
  Object.assign(process.env, ENV, { CHATWOOT_SOFIA_ATENDENDO: '0' });
  const w = chatwootVivo({ status: 'open', labels: [ETQ, 'anuncio'] });
  const f = mock.method(globalThis, 'fetch', w.f as never);
  try {
    await dispararEvento(avisoComEtiqueta('open'));
    assert.deepEqual(w.conv.labels, ['anuncio'], 'recurso desligado: a etiqueta não pode ficar presa');
    assert.ok(!w.log.some((l) => l === 'GET labels'), 'não mexe nas etiquetas da conta');
    // sem a etiqueta no aviso: nenhuma leitura
    w.log.length = 0;
    await dispararEvento({ ...avisoComEtiqueta('open'), labels: ['anuncio'] });
    assert.equal(w.log.length, 0);
    // a equipe responde: abre como antes
    await dispararEvento(humana);
    assert.ok(w.log.some((l) => l.startsWith('POST conversations/5/toggle_status')), 'a abertura pela pausa segue como antes');
  } finally {
    f.mock.restore();
  }
});

test('SEM ROBÔ (sem CHATWOOT_SOFIA_COMO_BOT): nada é posto, e a etiqueta que existir é tirada', async () => {
  Object.assign(process.env, ENV);
  delete process.env.CHATWOOT_SOFIA_COMO_BOT;
  const w = chatwootVivo({ status: 'open', labels: [ETQ] });
  const f = mock.method(globalThis, 'fetch', w.f as never);
  try {
    await dispararEvento(avisoComEtiqueta('open'));
    assert.deepEqual(w.conv.labels, []);
  } finally {
    f.mock.restore();
  }
});

/** as portas reais de Parauapebas, com o que NÃO é Chatwoot trocado por falsas (unidade, Kommo, relógio) */
function portasDaConta(w: ReturnType<typeof chatwootVivo>, estado: 'ligado' | 'seco' | 'desligado', o: { cartao?: boolean } = {}) {
  const ctx = C.criarContextoChatwoot({ url: 'https://crm.exemplo.test', conta: 1, token: 'tk-do-ambiente' }, { fetch: w.f });
  return {
    ...IA.portasReais(ctx),
    estado: () => estado,
    unidade: async () => ({ slug: 'doutor-hernia-parauapebas' }) as never,
    cartaoNoKommo: async () => (o.cartao ? { leadId: 99 } : null),
    hoje: () => '2026-11-19',
    agendar: () => 'timer',
    cancelar: () => undefined,
  };
}
const MSG = { conversa: 5, caixa: 3, slug: 'doutor-hernia-parauapebas', audios: [] as string[] };
const assentar = async () => {
  for (let i = 0; i < 14; i++) await new Promise((r) => setImmediate(r));
};

test('1ª MENSAGEM do paciente (ligado, robô): abre e etiqueta ANTES da espera de 60 s', async () => {
  Object.assign(process.env, ENV);
  const w = chatwootVivo({ status: 'pending', labels: ['anuncio'] });
  const f = mock.method(globalThis, 'fetch', w.f as never); // o robô usa o fetch global
  try {
    await IA.aoChegar(MSG, portasDaConta(w, 'ligado'), IA.novaMemoriaDaIa());
    await assentar();
    assert.equal(w.conv.status, 'open');
    assert.deepEqual(w.conv.labels, ['anuncio', ETQ]);
  } finally {
    f.mock.restore();
  }
});

test('SECO e DESLIGADO: não põem a etiqueta e TIRAM a que ficou de quando a unidade estava ligada', async () => {
  Object.assign(process.env, ENV);
  for (const estado of ['seco', 'desligado'] as const) {
    const w = chatwootVivo({ status: 'pending', labels: ['anuncio', ETQ] });
    const f = mock.method(globalThis, 'fetch', w.f as never);
    try {
      const portas = portasDaConta(w, estado);
      await IA.aoChegar(MSG, portas, IA.novaMemoriaDaIa());
      await assentar();
      if (estado === 'seco') {
        // no seco a etiqueta sai ao fim da rodada (a Sofia só deixa nota): `rodarSofia` com o desfecho `nota`
        assert.equal(await IA.rodarSofia(MSG, { ...portas, mensagens: async () => [{ message_type: 0, content: 'oi', private: false }], nota: async () => undefined, sofia: async () => ({ resposta: 'oi', acoes: [], pix: null, cartao: null, passouParaEquipe: false }), agendaReal: async () => [], registrarEvento: async () => undefined }, IA.novaMemoriaDaIa()), 'nota');
      }
      await assentar();
      assert.deepEqual(w.conv.labels, ['anuncio'], estado);
    } finally {
      f.mock.restore();
    }
  }
});

test('o critério da rodada vale na ENTRADA: cartão ativo no Kommo → abre mas NÃO etiqueta (não pisca); a resposta vale 30 s (1 ida ao Kommo por rajada)', async () => {
  Object.assign(process.env, ENV);
  const w = chatwootVivo({ status: 'pending', labels: [] });
  const f = mock.method(globalThis, 'fetch', w.f as never);
  try {
    let idas = 0;
    const portas = { ...portasDaConta(w, 'ligado', { cartao: true }), cartaoNoKommo: async () => (idas++, { leadId: 99 }) };
    const mem = IA.novaMemoriaDaIa();
    await IA.aoChegar(MSG, portas, mem);
    await IA.aoChegar(MSG, portas, mem);
    await assentar();
    assert.equal(w.conv.status, 'open', 'a equipe precisa ver a conversa');
    assert.deepEqual(w.conv.labels, []);
    assert.equal(idas, 1);
    // Kommo fora do ar: a rodada não responderia → também sem etiqueta
    const w2 = chatwootVivo({ status: 'open', labels: [] });
    const f2 = mock.method(globalThis, 'fetch', w2.f as never);
    try {
      await IA.aoChegar(MSG, { ...portasDaConta(w2, 'ligado'), cartaoNoKommo: async () => { throw new Error('Kommo 403'); } }, IA.novaMemoriaDaIa());
      await assentar();
      assert.deepEqual(w2.conv.labels, []);
    } finally {
      f2.mock.restore();
    }
  } finally {
    f.mock.restore();
  }
});

test('1ª MENSAGEM espera o anúncio gravar a etiqueta dele (as duas regravam a lista): a etiqueta `anuncio` não se perde', async () => {
  Object.assign(process.env, ENV);
  const w = chatwootVivo({ status: 'pending', labels: [] });
  const f = mock.method(globalThis, 'fetch', w.f as never);
  try {
    let soltar!: () => void;
    const anuncio = new Promise<void>((ok) => (soltar = ok)).then(() => {
      w.conv.labels = ['anuncio'];
    });
    await IA.aoChegar(MSG, portasDaConta(w, 'ligado'), IA.novaMemoriaDaIa(), anuncio);
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(w.log, [], 'enquanto o anúncio não terminou, nada é lido nem gravado');
    soltar();
    await assentar();
    assert.deepEqual(w.conv.labels, ['anuncio', ETQ]);
  } finally {
    f.mock.restore();
  }
});

test('UM evento, VÁRIOS escritores de etiqueta (resolvida + pausada + sem etapa + sofia-atendendo): rodam em fila e nenhuma desfaz a outra', async () => {
  Object.assign(process.env, ENV);
  const w = chatwootVivo({ status: 'resolved', labels: [ETIQUETA_PAUSA, ETQ, 'quente'], attrs: {} });
  const f = mock.method(globalThis, 'fetch', w.f as never);
  try {
    await dispararEvento({ event: 'conversation_updated', id: 5, inbox_id: 3, status: 'resolved', labels: [ETIQUETA_PAUSA, ETQ, 'quente'], custom_attributes: {}, meta: { sender: {} } });
    assert.deepEqual([...w.conv.labels].sort(), ['falta-etapa', 'quente'], w.log.join('\n'));
  } finally {
    f.mock.restore();
  }
});
