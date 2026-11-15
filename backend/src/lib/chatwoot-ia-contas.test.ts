/**
 * Passo 3b2 (IA/webhook, lida, sinal-Pix): a IA fala NA CONTA do evento. Identidade de Parauapebas: a Sofia dela responde exatamente igual
 * (mesmas portas, mesmo fluxo, mesma memória, as mesmas chamadas ao Chatwoot e os MESMOS argumentos para o modelo/prompt). Evento de conta que o
 * servidor não conhece é IGNORADO com aviso, nunca respondido pela conta 1.
 */
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const IA = await import('./chatwoot-ia.js');
const U = await import('./chatwoot-unidades.js');
const C = await import('../mcp-remoto/chatwoot.js');
const { logger } = await import('./logger.js');
const Lida = await import('./chatwoot-lida.js');
const Sinal = await import('./sinal-pix-worker.js');

const PARAU = U.SEMENTE_PARAUAPEBAS.slug;
const ENV = { CHATWOOT_API_TOKEN: 'tk-do-ambiente', CHATWOOT_CONTA_ID: '1', CHATWOOT_URL: 'https://crm.exemplo.test' } as NodeJS.ProcessEnv;
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
  caixas: [
    { id: 20, tipo: 'cloud' },
    { id: 21, tipo: 'evolution', instanciaEvolution: 'demo-unidade' },
  ],
};

afterEach(() => {
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS]);
  IA.esquecerEstadosDaIa();
  Lida.esquecerPortasDaLida();
});

// ── de que conta é o evento ──────────────────────────────────────────────────────────────────────

test('contaDoEvento: Parauapebas (conta do ambiente) — com e sem `account` no payload, e sem caixa, é a conta 1 como sempre', () => {
  assert.deepEqual(IA.contaDoEvento({ account: { id: 1 }, conversation: { id: 5, inbox_id: 3 } }, ENV), { conta: 1 });
  assert.deepEqual(IA.contaDoEvento({ conversation: { id: 5, inbox_id: 3 } }, ENV), { conta: 1 });
  assert.deepEqual(IA.contaDoEvento({ conversation: { id: 5, inbox_id: 2 } }, ENV), { conta: 1 });
  assert.deepEqual(IA.contaDoEvento({ inbox: { id: 4 }, event: 'x' }, ENV), { conta: 1 }, 'a caixa de histórico também é de Parauapebas');
  assert.deepEqual(IA.contaDoEvento({ event: 'conversation_updated' }, ENV), { conta: 1 }, 'sem conta e sem caixa: o ambiente, como sempre');
  assert.deepEqual(IA.contaDoEvento({ conversation: { inbox_id: 999 } }, ENV), { conta: 1 }, 'caixa que nenhuma unidade tem: o ambiente (os analisadores a ignoram, como sempre)');
});

test('contaDoEvento: clínica de conta 2 — pela caixa ou pelo payload; conta desconhecida, caixa de outra conta e conta inválida são IGNORADAS', () => {
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO]);
  assert.deepEqual(IA.contaDoEvento({ account: { id: 2 }, conversation: { id: 5, inbox_id: 20 } }, ENV), { conta: 2 });
  assert.deepEqual(IA.contaDoEvento({ conversation: { id: 5, inbox_id: 20 } }, ENV), { conta: 2 }, 'sem `account`: pela caixa');
  assert.deepEqual(IA.contaDoEvento({ inbox_id: 21 }, ENV), { conta: 2 });
  const motivo = (b: unknown) => ('ignorar' in IA.contaDoEvento(b, ENV) ? (IA.contaDoEvento(b, ENV) as { ignorar: string }).ignorar : null);
  assert.match(motivo({ account: { id: 99 }, conversation: { inbox_id: 3 } })!, /conta 99 desconhecida/);
  assert.match(motivo({ account: { id: 1 }, conversation: { inbox_id: 20 } })!, /a caixa 20 é da conta 2, mas o evento veio da conta 1/);
  assert.match(motivo({ account: { id: 2 }, conversation: { inbox_id: 3 } })!, /a caixa 3 é da conta 1, mas o evento veio da conta 2/);
  assert.equal(motivo({ account: { id: 2 } }), null, 'conta 2 sem caixa no payload: vale a conta do payload');
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, { ...DEMO, contaId: -1 } as never]);
  assert.match(motivo({ conversation: { inbox_id: 20 } })!, /sem conta válida/);
  assert.equal(IA.contaDoEvento({ conversation: { inbox_id: 3 } }, {} as NodeJS.ProcessEnv).hasOwnProperty('ignorar'), true, 'sem Chatwoot configurado: ignora');
});

// ── o handler: evento de conta desconhecida é ignorado com aviso, nunca respondido ───────────────

test('handler: evento de conta DESCONHECIDA é ignorado com UM aviso no log e NENHUMA chamada ao Chatwoot; o de Parauapebas segue', async () => {
  const salvo = { ...process.env };
  Object.assign(process.env, ENV);
  const chamadas: string[] = [];
  const f = mock.method(globalThis, 'fetch', (async (url: string) => (chamadas.push(String(url)), { ok: true, status: 200, text: async () => '{}' } as Response)) as never);
  const avisos: string[] = [];
  const w = mock.method(logger, 'warn', ((...a: unknown[]) => void avisos.push(String(a[1] ?? a[0]))) as never);
  try {
    const res = () => ({ json: () => undefined, status: () => ({ json: () => undefined }) }) as never;
    const key = IA.chaveDoEvento(ENV.CHATWOOT_API_TOKEN!);
    const evento = (conta: number, caixa: number, conversa = 5) => ({ query: { k: key }, body: { event: 'message_created', message_type: 'incoming', private: false, content: 'oi', account: { id: conta }, conversation: { id: conversa, inbox_id: caixa }, sender: { identifier: '559481854046@s.whatsapp.net' }, attachments: [] } }) as never;
    for (let i = 0; i < 3; i++) IA.eventoChatwootHandler(evento(99, 3), res());
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(chamadas, [], 'nenhuma chamada ao Chatwoot');
    assert.equal(avisos.filter((a) => /IGNORADO — conta 99 desconhecida/.test(a)).length, 1, 'um aviso só, mesmo com 3 eventos');
    // e o de Parauapebas (conta 1, caixa 3) não é ignorado: cria o estado da conta 1
    IA.eventoChatwootHandler(evento(1, 3), res());
    assert.ok(IA.estadoDoReceptor(1, ENV), 'a conta 1 tem estado');
  } finally {
    f.mock.restore();
    w.mock.restore();
    // desfaz EXATAMENTE o que o teste pôs: o que não existia antes sai, o que existia volta ao valor de antes
    for (const k of Object.keys(ENV)) {
      if (k in salvo) process.env[k] = salvo[k];
      else delete process.env[k];
    }
  }
});

// ── a Sofia de Parauapebas responde exatamente igual ─────────────────────────────────────────────

/** Um Chatwoot de mentira: a conversa 5 com uma fala do paciente; registra cada chamada na ordem. */
function chatwootDaConversa(log: string[]) {
  return (async (url: string, o: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const u = new URL(url);
    const metodo = o.method ?? 'GET';
    log.push(`${metodo} ${u.pathname}${u.search}${o.body ? ` ${o.body}` : ''} [token ${o.headers?.api_access_token ?? '-'}]`);
    const corpo = (j: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) }) as Response;
    if (metodo === 'GET' && /\/conversations\/5\/messages$/.test(u.pathname)) return corpo({ payload: [{ id: 1, message_type: 0, private: false, content: 'Oi, quero marcar uma avaliação', created_at: 1_700_000_000 }] });
    if (metodo === 'GET' && /\/conversations\/5$/.test(u.pathname)) return corpo({ id: 5, meta: { sender: { name: 'Maria da Silva', phone_number: '+5594999990000' } }, custom_attributes: { etapa: 'Novo lead' }, labels: [] });
    if (metodo === 'POST' && /\/messages$/.test(u.pathname)) return corpo({ id: 900, sender: { id: 3 } });
    return corpo({});
  }) as unknown as typeof fetch;
}

/** As portas que NÃO são o Chatwoot (unidade, modelo, agenda, Kommo, relógio) trocadas por falsas que anotam o que recebem. */
function portasFalsas(registro: unknown[]) {
  return {
    estado: () => 'ligado' as const,
    unidade: async () => ({ slug: PARAU, name: 'Doutor Hérnia Parauapebas' }) as never,
    agendaReal: async () => null,
    cartaoNoKommo: async () => null,
    sofia: async (unit: { slug: string }, falas: unknown, pedido: { conversa: number; modo: string; lida: unknown }) => {
      registro.push({ unit: unit.slug, falas, conversa: pedido.conversa, modo: pedido.modo, lida: pedido.lida });
      return { resposta: 'Olá, Maria! Tenho terça às 14:30 ou quarta às 9:00.', acoes: [], semResposta: false } as never;
    },
    agendar: (fn: () => void) => (fn(), 1),
    cancelar: () => undefined,
    hoje: () => '2026-11-16',
  };
}
const MENSAGEM = { conversa: 5, caixa: 3, slug: PARAU, audios: [] as string[] };
const resumoDaMemoria = (m: import('./chatwoot-ia.js').MemoriaDaIa) => ({ esperas: m.esperas.size, rodadas: [...m.rodadas.entries()], avisosDoKommo: [...m.avisosDoKommo], emAndamento: [...m.emAndamento], avisosDeHorario: [...m.avisosDeHorario], usuarios: [...m.usuariosDaIntegracao], desligadas: m.registrosDeDesligada.size });

test('IDENTIDADE da Sofia de Parauapebas: a rodada pelas portas da conta 1 faz as MESMAS chamadas ao Chatwoot, passa os MESMOS argumentos ao modelo (falas, unidade, modo) e deixa a MESMA memória que a rodada pelas portas de antes', async () => {
  // ANTES: as portas montadas direto do contexto do ambiente, com uma memória nova (o que o singleton fazia)
  const logAntes: string[] = [];
  const registroAntes: unknown[] = [];
  const ctxAntes = C.criarContextoChatwoot(C.contaChatwootDoAmbiente(ENV), { fetch: chatwootDaConversa(logAntes) });
  const memAntes = IA.novaMemoriaDaIa();
  const portasAntes = { ...IA.portasReais(ctxAntes, { tokenRobo: null }), ...portasFalsas(registroAntes) };
  assert.equal(await IA.rodarSofia(MENSAGEM, portasAntes as never, memAntes), 'enviada');

  // DEPOIS: o estado que o webhook usa para a conta 1
  const logDepois: string[] = [];
  const registroDepois: unknown[] = [];
  const f = mock.method(globalThis, 'fetch', chatwootDaConversa(logDepois) as never);
  try {
    const estado = IA.estadoDoReceptor(1, ENV)!;
    const portasDepois = { ...estado.portas, ...portasFalsas(registroDepois) };
    assert.equal(await IA.rodarSofia(MENSAGEM, portasDepois as never, estado.mem), 'enviada');
    assert.deepEqual(logDepois, logAntes, 'as mesmas chamadas ao Chatwoot, na mesma ordem, com o mesmo token');
    assert.deepEqual(registroDepois, registroAntes, 'os mesmos argumentos para o modelo: o prompt do Parauapebas não mudou (falas, unidade, modo, conversa lida)');
    assert.deepEqual(resumoDaMemoria(estado.mem), resumoDaMemoria(memAntes), 'a mesma memória no fim da rodada');
    assert.ok(logDepois.some((l) => l.startsWith('POST /api/v1/accounts/1/conversations/5/messages') && l.includes('Olá, Maria')), 'a resposta saiu na conta 1');
    assert.ok(logDepois.every((l) => !l.includes('/accounts/2/') && l.includes('[token tk-do-ambiente]')));
  } finally {
    f.mock.restore();
  }
});

test('o estado da conta 1 é o mesmo de sempre (um por conta, guardado) e a conta 2 tem OUTRO: memória, trava, contexto e token próprios', () => {
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO]);
  const env = { ...ENV, CHATWOOT_API_TOKEN_DEMO: 'tk-so-da-demo' } as NodeJS.ProcessEnv;
  const e1 = IA.estadoDoReceptor(1, env)!;
  const e2 = IA.estadoDoReceptor(2, env)!;
  assert.equal(IA.estadoDoReceptor(1, env), e1, 'guardado');
  assert.equal(IA.estadoDoReceptor(2, env), e2);
  assert.notEqual(e1, e2);
  assert.notEqual(e1.mem, e2.mem);
  assert.notEqual(e1.trava, e2.trava);
  assert.notEqual(e1.portas, e2.portas);
  assert.equal(IA.estadoDoReceptor(3, env), null, 'conta que nenhuma unidade tem: sem estado');
  assert.equal(IA.estadoDoReceptor(2, { ...ENV, CHATWOOT_API_TOKEN: undefined } as NodeJS.ProcessEnv), null, 'sem Chatwoot configurado no ambiente: não responde, mesmo com o estado guardado');
});

test('a conversa 5 da conta 1 e a conversa 5 da conta 2 NÃO dividem a memória (a rodada de uma não é «ocupada» pela da outra); a resposta da conta 2 sai na conta 2 com o token dela', async () => {
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO]);
  const env = { ...ENV, CHATWOOT_API_TOKEN_DEMO: 'tk-so-da-demo' } as NodeJS.ProcessEnv;
  const log: string[] = [];
  const f = mock.method(globalThis, 'fetch', chatwootDaConversa(log) as never);
  try {
    const e1 = IA.estadoDoReceptor(1, env)!;
    const e2 = IA.estadoDoReceptor(2, env)!;
    const registro: unknown[] = [];
    // a conta 1 está no meio da conversa 5 (rodada em andamento)…
    e1.mem.emAndamento.add(5);
    const p2 = { ...e2.portas, ...portasFalsas(registro), unidade: async () => ({ slug: 'clinica-demonstracao', name: 'Clínica Demonstração' }) as never };
    // …e a da conta 2, com o mesmo número de conversa, roda normalmente
    assert.equal(await IA.rodarSofia({ conversa: 5, caixa: 20, slug: 'clinica-demonstracao', audios: [] }, p2 as never, e2.mem), 'enviada');
    assert.equal(await IA.rodarSofia(MENSAGEM, { ...e1.portas, ...portasFalsas(registro) } as never, e1.mem), 'ocupada', 'a conta 1 segue ocupada: cada conta tem a sua memória');
    assert.ok(log.some((l) => l.startsWith('POST /api/v1/accounts/2/conversations/5/messages') && l.includes('[token tk-so-da-demo]')));
    assert.ok(log.every((l) => !l.includes('/accounts/1/')), 'a conta 1 nem foi tocada');
  } finally {
    f.mock.restore();
  }
});

test('robô da Sofia: a conta 2 NUNCA usa o token do robô de Parauapebas (só o `CHATWOOT_SOFIA_BOT_TOKEN_<SUFIXO>` dela)', async () => {
  const { tokenDoRobo } = await import('./chatwoot-sofia-bot.js');
  const env = { CHATWOOT_SOFIA_COMO_BOT: '1', CHATWOOT_SOFIA_BOT_TOKEN: 'token-do-robo-de-parau-123', CHATWOOT_SOFIA_BOT_TOKEN_DEMO: 'token-do-robo-da-demo-456' } as NodeJS.ProcessEnv;
  assert.equal(tokenDoRobo(env), 'token-do-robo-de-parau-123', 'Parauapebas: como sempre');
  assert.equal(tokenDoRobo(env, 'DEMO'), 'token-do-robo-da-demo-456');
  assert.equal(tokenDoRobo({ ...env, CHATWOOT_SOFIA_BOT_TOKEN_DEMO: undefined } as NodeJS.ProcessEnv, 'DEMO'), null, 'sem o robô da demo: nenhum (nunca o de Parauapebas)');
  assert.equal(tokenDoRobo({ ...env, CHATWOOT_SOFIA_COMO_BOT: '0' } as NodeJS.ProcessEnv, 'DEMO'), null);
});

// ── lida (Evolution) ─────────────────────────────────────────────────────────────────────────────

test('LIDA: a porta é a da conta da caixa (Parauapebas: a do ambiente, como sempre); caixa de clínica de conta 2 usa a conta 2; caixa sem conta válida RECUSA', () => {
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO]);
  const p2 = Lida.portaDaLidaDaCaixa(2, ENV);
  assert.ok(p2);
  assert.equal(Lida.portaDaLidaDaCaixa(2, ENV), p2, 'guardada por conta: a mesma porta');
  const demo = Lida.portaDaLidaDaCaixa(21, ENV);
  assert.ok(demo && demo !== p2, 'a conta 2 tem outra porta');
  assert.equal(Lida.portaDaLidaDaCaixa(999, ENV), null);
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, { ...DEMO, contaId: -1 } as never]);
  Lida.esquecerPortasDaLida();
  assert.equal(Lida.portaDaLidaDaCaixa(21, ENV), null, 'conta inválida: recusa, não cai na conta 1');
  assert.equal(Lida.portaDaLidaDaCaixa(2, {} as NodeJS.ProcessEnv), null);
});

// ── sinal Pix ────────────────────────────────────────────────────────────────────────────────────

test('SINAL PIX: a baixa vai na conta da UNIDADE (Parauapebas: a do ambiente); unidade desconhecida RECUSA', async () => {
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO]);
  const chamadas: string[] = [];
  const f = mock.method(globalThis, 'fetch', (async (url: string, o: { method?: string; headers?: Record<string, string> } = {}) => (chamadas.push(`${o.method ?? 'GET'} ${new URL(url).pathname} [token ${o.headers?.api_access_token}]`), { ok: true, status: 200, text: async () => JSON.stringify({ id: 5, labels: [], meta: { sender: {} } }) } as Response)) as never);
  try {
    const env = { ...ENV, CHATWOOT_API_TOKEN_DEMO: 'tk-so-da-demo' } as NodeJS.ProcessEnv;
    await Sinal.baixaDoChatwootDaUnidade(PARAU, env)!.nota(5, 'x');
    await Sinal.baixaDoChatwootDaUnidade('clinica-demonstracao', env)!.nota(5, 'y');
    assert.deepEqual(chamadas, ['POST /api/v1/accounts/1/conversations/5/messages [token tk-do-ambiente]', 'POST /api/v1/accounts/2/conversations/5/messages [token tk-so-da-demo]']);
    assert.equal(Sinal.baixaDoChatwootDaUnidade('unidade-desconhecida', env), null);
    assert.equal(Sinal.baixaDoChatwootDaUnidade(PARAU, {} as NodeJS.ProcessEnv), null);
  } finally {
    f.mock.restore();
  }
});

// ── configuração recarregada ─────────────────────────────────────────────────────────────────────

test('RECARGA da configuração: o estado da IA e a porta da lida acompanham a conta/token; a MEMÓRIA da conversa em andamento fica', () => {
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO]);
  const env1 = { ...ENV, CHATWOOT_API_TOKEN_DEMO: 'token-velho' } as NodeJS.ProcessEnv;
  const antes = IA.estadoDoReceptor(2, env1)!;
  antes.mem.emAndamento.add(5);
  assert.equal(IA.estadoDoReceptor(2, env1), antes, 'nada mudou: o mesmo estado');
  const portaAntes = Lida.portaDaLidaDaCaixa(21, env1)!;
  assert.equal(Lida.portaDaLidaDaCaixa(21, env1), portaAntes);
  // o token da clínica foi trocado: as portas são refeitas…
  const env2 = { ...ENV, CHATWOOT_API_TOKEN_DEMO: 'token-novo' } as NodeJS.ProcessEnv;
  const depois = IA.estadoDoReceptor(2, env2)!;
  assert.notEqual(depois, antes);
  assert.notEqual(depois.portas, antes.portas);
  assert.notEqual(Lida.portaDaLidaDaCaixa(21, env2), portaAntes);
  // …mas a rodada em andamento da conversa 5 não é esquecida (senão a Sofia responderia duas vezes)
  assert.equal(depois.mem, antes.mem);
  assert.ok(depois.mem.emAndamento.has(5));
  // a clínica saiu da configuração: ninguém mais usa a conta 2
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS]);
  assert.equal(IA.estadoDoReceptor(2, env2), null);
  assert.equal(Lida.portaDaLidaDaCaixa(21, env2), null);
  // Parauapebas não foi mexida por nada disso
  const p1 = IA.estadoDoReceptor(1, env2)!;
  assert.equal(IA.estadoDoReceptor(1, env2), p1);
});

test('duas clínicas na MESMA conta: a «dona» da conta é sempre a primeira em ordem alfabética (não depende da ordem da configuração)', () => {
  const b = { ...DEMO, slug: 'zeta-clinica', envSufixo: 'ZETA', caixas: [{ id: 30, tipo: 'cloud' as const }] };
  const a = { ...DEMO, slug: 'alfa-clinica', envSufixo: 'ALFA', caixas: [{ id: 31, tipo: 'cloud' as const }] };
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, b, a]);
  assert.deepEqual(U.unidadesDaConta(2), ['alfa-clinica', 'zeta-clinica']);
  const env = { ...ENV, CHATWOOT_API_TOKEN_ALFA: 'token-da-alfa', CHATWOOT_API_TOKEN_ZETA: 'token-da-zeta' } as NodeJS.ProcessEnv;
  const dona = C.donaDaConta(C.criarContextoChatwoot(C.contaChatwootDoAmbiente(env)), 2, env);
  assert.equal(dona?.slug, 'alfa-clinica');
  assert.equal(dona?.ctx.conta?.token, 'token-da-alfa');
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, a, b]);
  assert.equal(C.donaDaConta(C.criarContextoChatwoot(C.contaChatwootDoAmbiente(env)), 2, env)?.slug, 'alfa-clinica');
});
