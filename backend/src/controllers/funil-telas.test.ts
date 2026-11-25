/**
 * Telas Oportunidades / Marketing / Gestor — as rotas, com portas falsas (Chatwoot, Meta, banco): quem não pode vê-las é recusado NO SERVIDOR
 * (mesmo chamando a URL direto); os dados saem sempre com o login da própria pessoa; fonte não ligada vira estado, não número inventado;
 * e o `menu.js` e a página PARSEIAM como JavaScript.
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

process.env.CHATWOOT_API_TOKEN = 'token-da-conta';
process.env.CHATWOOT_CONTA_ID = '1';
process.env.CHATWOOT_URL = 'https://chatwoot.exemplo.test';
process.env.CHATWOOT_GESTORES = 'ana@dd.com';

// O RELÓGIO É FIXO: as telas contam «hoje», «manhã» e «semana» em Belém a partir de Date.now(), e as conversas do teste nascem «1 hora atrás». Com o
// relógio de verdade o resultado dependia da hora do dia em que a suíte rodava (de madrugada, «1 hora atrás» caía em ontem e o período «manhã» ficava
// vazio). Quarta 18/11/2026, 11:00 em Belém; só o Date é simulado (timers e rede seguem reais).
mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-18T14:00:00Z') });

const AGORA_S = Math.floor(Date.now() / 1000);
const conversa = (id: number, o: Record<string, any> = {}) => ({
  id,
  status: 'open',
  inbox_id: 3,
  created_at: AGORA_S - 3600,
  last_activity_at: AGORA_S - 600,
  labels: [],
  custom_attributes: {},
  meta: { sender: { name: `Paciente ${id}`, phone_number: '+5594999990000', custom_attributes: {} }, assignee: null },
  last_non_activity_message: null,
  ...o,
});
const CONVERSAS = [
  conversa(1, { custom_attributes: { qualificacao: 'Quente', etapa: 'Agendado' } }),
  conversa(2, { custom_attributes: { etapa: 'Fechou', fechou_tratamento: 'sim', valor_fechado: '2620' } }),
  conversa(3, { custom_attributes: { etapa: 'Compareceu', data_consulta: '2026-01-05' } }),
];

const PERFIS: Record<string, unknown> = {
  admin: { id: 1, name: 'Suzanne', email: 's@dd.com', accounts: [{ id: 1, role: 'administrator' }] },
  agente: { id: 2, name: 'Bia', email: 'bia@dd.com', accounts: [{ id: 1, role: 'agent' }] },
  ana: { id: 3, name: 'Ana', email: 'ana@dd.com', accounts: [{ id: 1, role: 'agent' }] },
  // atende só a caixa 5: NÃO enxerga a 3
  so5: { id: 4, name: 'Sol', email: 'sol@dd.com', accounts: [{ id: 1, role: 'agent' }] },
};
const chamadas: Array<{ url: string; headers: Record<string, string> }> = [];
let graph: ((url: string) => unknown) | null = null;
const mensagensDe: string[] = [];
let mensagensLongas = false;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  chamadas.push({ url: u, headers });
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (u.startsWith('https://graph.facebook.com')) return graph ? json(graph(u)) : json({ error: { code: 190 } }, 400);
  if (u.endsWith('/api/v1/profile')) return PERFIS[headers['access-token'] ?? ''] ? json(PERFIS[headers['access-token']!]) : json({}, 401);
  if (u.includes('/inboxes')) return json({ payload: headers['access-token'] === 'so5' ? [{ id: 5, name: 'Outra' }] : [{ id: 3, name: 'WhatsApp' }, { id: 4, name: 'Histórico' }] });
  if (u.includes('/conversations?')) return json({ data: { payload: new URL(u).searchParams.get('inbox_id') === '3' ? CONVERSAS : [] } });
  if (u.includes('/messages')) {
    mensagensDe.push(u);
    // conversa «longa»: toda página vem cheia (20), então nunca se chega ao começo
    return json({ payload: mensagensLongas ? Array.from({ length: 20 }, (_, i) => ({ id: 1000 - mensagensDe.length * 20 - i, message_type: 1, created_at: 1 })) : [] });
  }
  return json({ payload: [] });
}) as typeof fetch;

const { prisma } = await import('../lib/prisma.js');
const falsoPrisma = {
  chatwootReguaVisto: { findMany: async () => [], findFirst: async () => null },
  unit: { findUnique: async () => null },
  funilTarefa: { findMany: async () => [] },
};
for (const [k, v] of Object.entries(falsoPrisma)) Object.defineProperty(prisma, k, { value: v, configurable: true });

const { _esquecerLeituraDoFunil, funilQuadroHandler, funilNotaHandler, semArquivo, funilOportunidadesHandler, funilMarketingHandler, funilGestorHandler, funilGestaoHandler, paginaFunilHandler, montarMenuJs } = await import('./funil.controller.js');
const { corsDoAssistente } = await import('./assistente.controller.js');

function resp() {
  const r = { codigo: 200, corpo: undefined as any, tipo: '', status(n: number) { r.codigo = n; return r; }, json(c: unknown) { r.corpo = c; return r; }, type(t: string) { r.tipo = t; return r; }, set() { return r; }, send(c: unknown) { r.corpo = c; return r; } };
  return r;
}
const pedido = (login: string | null, query: Record<string, string> = {}, extra: Record<string, string> = {}) => {
  const h: Record<string, string> = { ...extra };
  if (login) Object.assign(h, { 'x-cw-token': login, 'x-cw-client': 'c', 'x-cw-uid': 'u@dd.com' });
  return { query, ip: '1.1.1.1', get: (n: string) => h[n.toLowerCase()] } as unknown as Request;
};
const asRes = (r: ReturnType<typeof resp>) => r as unknown as Response;

test('Oportunidades: sem login = recusa; com login, lê SÓ com o login da pessoa e não olha a caixa de histórico', async () => {
  const sem = resp();
  await funilOportunidadesHandler(pedido(null), asRes(sem));
  assert.equal(sem.codigo, 403);
  // a chave avulsa do funil também não abre estas telas
  const chave = resp();
  await funilOportunidadesHandler(pedido(null, {}, { 'x-funil-chave': 'x'.repeat(32) }), asRes(chave));
  assert.equal(chave.codigo, 403);

  chamadas.length = 0;
  const r = resp();
  await funilOportunidadesHandler(pedido('agente'), asRes(r));
  assert.equal(r.codigo, 200);
  assert.equal(r.corpo.totais.naoFecharam, 1);
  assert.equal(r.corpo.naoFecharam[0].telefone, '+5594999990000');
  const doChatwoot = chamadas.filter((c) => c.url.startsWith('https://chatwoot.exemplo.test') && !c.url.endsWith('/profile'));
  assert.ok(doChatwoot.length > 0);
  for (const c of doChatwoot) {
    assert.equal(c.headers['access-token'], 'agente', c.url);
    assert.equal(c.headers.api_access_token, undefined, 'nunca o token da conta');
  }
  assert.ok(!doChatwoot.some((c) => /inbox_id=4/.test(c.url)), 'a caixa de histórico não é lida');
});

test('Marketing e Gestor: o agente comum é recusado no servidor, mesmo chamando a URL direto', async () => {
  for (const h of [funilMarketingHandler, funilGestorHandler]) {
    const r = resp();
    await h(pedido('agente', { periodo: 'mes' }), asRes(r));
    assert.equal(r.codigo, 403);
    assert.equal(r.corpo.semPermissao, true);
    assert.equal(r.corpo.semana, undefined);
    assert.equal(r.corpo.conversas, undefined);
    // sem login e com a chave avulsa: também não
    const s = resp();
    await h(pedido(null), asRes(s));
    assert.equal(s.codigo, 403);
    const k = resp();
    await h(pedido(null, {}, { 'x-funil-chave': 'x'.repeat(32) }), asRes(k));
    assert.equal(k.codigo, 403);
    // login inválido: sessão inválida, não vaza nada
    const inv = resp();
    await h(pedido('qualquer-coisa'), asRes(inv));
    assert.equal(inv.codigo, 403);
  }
});

test('Marketing e Gestor: administrador e e-mail da lista de gestores passam', async () => {
  for (const quem of ['admin', 'ana']) {
    for (const h of [funilMarketingHandler, funilGestorHandler]) {
      const r = resp();
      await h(pedido(quem, { periodo: 'mes' }), asRes(r));
      assert.equal(r.codigo, 200, `${quem}`);
      assert.equal(r.corpo.periodo.chave, 'mes');
    }
  }
});

test('Gestor sem a conta de anúncios ligada: estado «conectar» com o nome das envs, e nenhum número inventado', async () => {
  delete process.env.META_ADS_TOKEN_PARAUAPEBAS;
  delete process.env.META_ADS_CONTA_PARAUAPEBAS;
  const r = resp();
  await funilGestorHandler(pedido('admin', { periodo: 'semana' }), asRes(r));
  assert.equal(r.codigo, 200);
  const c = r.corpo;
  assert.equal(c.investido.estado, 'conectar');
  assert.equal(c.investido.valor, null);
  assert.match(c.investido.motivo, /META_ADS_TOKEN_PARAUAPEBAS e META_ADS_CONTA_PARAUAPEBAS/);
  assert.deepEqual(c.indicadores, { retorno: null, cac: null, custoPorConsulta: null });
  assert.equal(c.faturado.fonte, 'conversas'); // a unidade falsa não tem franquia: usa o valor fechado nas conversas, dizendo a fonte
  assert.equal(c.faturado.valor, 2620);
  assert.equal(c.leads, 3);
  assert.equal(c.fecharam, 1);
});

test('Gestor com a conta ligada: investido vem da Meta (token só no cabeçalho) e fecha as razões', async () => {
  process.env.META_ADS_TOKEN_PARAUAPEBAS = 'token-ads-secreto';
  process.env.META_ADS_CONTA_PARAUAPEBAS = 'act_55512345';
  graph = (url) =>
    url.includes('level=account')
      ? { data: [{ spend: '500', date_start: '2026-01-01' }] }
      : { data: [{ ad_id: '111', ad_name: 'A', campaign_id: '9001', campaign_name: 'Campanha X', spend: '500', account_currency: 'BRL' }] };
  chamadas.length = 0;
  const r = resp();
  await funilGestorHandler(pedido('admin', { periodo: 'quinzena' }), asRes(r));
  assert.equal(r.codigo, 200);
  assert.equal(r.corpo.investido.estado, 'ok');
  assert.equal(r.corpo.investido.valor, 500);
  assert.equal(r.corpo.indicadores.cac, 500); // 500 investido ÷ 1 fechou
  assert.equal(r.corpo.campanhas[0].titulo, 'Campanha X');
  const g = chamadas.filter((c) => c.url.startsWith('https://graph.facebook.com'));
  assert.ok(g.length > 0);
  for (const c of g) {
    assert.ok(!c.url.includes('token-ads-secreto'));
    assert.equal(c.headers.Authorization, 'Bearer token-ads-secreto');
    assert.match(c.url, /act_55512345/);
  }
  graph = null;
  delete process.env.META_ADS_TOKEN_PARAUAPEBAS;
  delete process.env.META_ADS_CONTA_PARAUAPEBAS;
});

test('Gestor com a Meta recusando o token: estado «erro» com o motivo, o resto continua', async () => {
  process.env.META_ADS_TOKEN_PARAUAPEBAS = 'token-vencido';
  process.env.META_ADS_CONTA_PARAUAPEBAS = '55512345';
  graph = null; // a Meta responde 400 / código 190
  const r = resp();
  // período próprio: a resposta pronta de 45 s é por pessoa + período
  await funilGestorHandler(pedido('admin', { periodo: 'manha' }), asRes(r));
  assert.equal(r.codigo, 200);
  assert.equal(r.corpo.periodo.chave, 'fimdia', '«Manhã» não vale para o dinheiro (Meta e franquia só têm dia inteiro): vira «Fim do dia»');
  assert.equal(r.corpo.investido.estado, 'erro');
  assert.match(r.corpo.investido.motivo, /recusou o token/);
  assert.equal(r.corpo.indicadores.cac, null);
  assert.equal(r.corpo.leads, 3);
  delete process.env.META_ADS_TOKEN_PARAUAPEBAS;
  delete process.env.META_ADS_CONTA_PARAUAPEBAS;
});

test('menu: o servidor diz quem vê Marketing e Gestor (a lista de gestores nunca vai no menu.js público)', async () => {
  const quem = async (login: string | null) => {
    const r = resp();
    await funilGestaoHandler(pedido(login), asRes(r));
    return r;
  };
  assert.equal((await quem('admin')).corpo.gestao, true);
  assert.equal((await quem('ana')).corpo.gestao, true);
  assert.equal((await quem('agente')).corpo.gestao, false);
  assert.equal((await quem(null)).codigo, 403);
  assert.equal((await quem('lixo')).codigo, 403);
  // o menu (página do Chatwoot) é outra origem: só esta rota, só dessa origem, só os cabeçalhos de login
  const cw = 'https://chatwoot.exemplo.test';
  const cors = corsDoAssistente('/api/public/funil/gestao', cw, cw);
  assert.ok(cors);
  assert.equal(cors!.credentials, false);
  assert.equal(corsDoAssistente('/api/public/funil/gestor', cw, cw), null);
  assert.equal(corsDoAssistente('/api/public/funil/gestao', 'https://outro.exemplo.test', cw), null);
});

test('menu.js: leva as contas sem pagamento antecipado para o guia (só ids inteiros) e continua PARSEANDO', () => {
  const js = montarMenuJs('https://agente.exemplo.test', [3, 0, 7]);
  assert.doesNotThrow(() => new Function(js));
  assert.match(js, /"semAntecipado":\[3,7\]/);
  assert.match(js, /"passosSemAntecipado":\{"Agendado":\[/);
  assert.match(montarMenuJs('https://agente.exemplo.test'), /"semAntecipado":\[\]/);
});

test('menu.js: PARSEIA, tem os cinco itens na ordem, sem lista de e-mails nem hash, e Esc/Ctrl+R continuam', () => {
  const js = montarMenuJs('https://agente.exemplo.test');
  assert.doesNotThrow(() => new Function(js));
  assert.ok(!js.includes('__AGENTE__') && !js.includes('__GESTORES__'));
  assert.ok(!js.includes('ana@dd.com'));
  assert.ok(!/[0-9a-f]{64}/.test(js), 'nenhum hash de e-mail no arquivo público');
  // Oportunidades, Marketing e Gestor são submenu de Hoje (pedido do João, 13/11); o Funil vem depois do grupo
  const ordem = ['data-hoje-menu', 'data-oport-menu', 'data-mkt-menu', 'data-gestor-menu', 'data-funil-menu'].map((m) => js.indexOf(m));
  assert.ok(ordem.every((i) => i > 0));
  assert.deepEqual([...ordem].sort((a, b) => a - b), ordem, 'a ordem do menu é Hoje (Oportunidades, Marketing, Gestor dentro) e depois Funil');
  assert.ok(js.includes("pai: 'hoje'") && js.includes('data-hoje-seta'), 'submenu de Hoje com a setinha de abrir e fechar');
  assert.match(js, /gestao: true/);
  assert.match(js, /e\.key === 'Escape'/);
  assert.match(js, /sessionStorage/); // Ctrl+R reabre
  assert.match(js, /\/api\/v1\/profile/);
  assert.match(js, /\/api\/public\/funil\/gestao/);
});

test('campanha da conversa longa (não deu para ler até o começo) não é guardada como «sem campanha»', async () => {
  CONVERSAS.push(conversa(501), conversa(502)); // conversas só deste teste (as outras já têm a campanha guardada)
  _esquecerLeituraDoFunil(); // o teste mexeu no Chatwoot de mentira: a leitura guardada das caixas (20 s) não vale mais
  mensagensLongas = true;
  mensagensDe.length = 0;
  const r1 = resp();
  await funilMarketingHandler(pedido('admin', { periodo: 'semana' }), asRes(r1));
  assert.equal(r1.codigo, 200);
  const primeira = mensagensDe.length;
  assert.ok(primeira > 0);
  assert.match(r1.corpo.avisos.join(' '), /até o começo/);
  // outro período (a resposta pronta de 45 s é por período): lê DE NOVO, porque nada foi guardado
  const r2 = resp();
  await funilMarketingHandler(pedido('admin', { periodo: 'quinzena' }), asRes(r2));
  assert.ok(mensagensDe.length > primeira, 'tentou ler de novo');
  mensagensLongas = false;
  // conversa curta: lida até o começo, guardada, não lê mais
  mensagensDe.length = 0;
  await funilMarketingHandler(pedido('admin', { periodo: 'manha' }), asRes(resp()));
  const lidas = mensagensDe.length;
  assert.ok(lidas > 0);
  await funilMarketingHandler(pedido('ana', { periodo: 'semana' }), asRes(resp()));
  assert.equal(mensagensDe.length, lidas, 'já guardada: não pergunta ao Chatwoot de novo');
  CONVERSAS.length -= 2;
  _esquecerLeituraDoFunil();
});

test('página (todas as telas) PARSEIA, sem marcador sobrando; as novas só falam com a página-mãe e nunca mandam nada ao paciente', () => {
  const r = resp();
  paginaFunilHandler({} as Request, asRes(r));
  const html = String(r.corpo);
  assert.ok(!html.includes('__ORIGEM_CW__') && !html.includes('__TELAS_CSS__') && !html.includes('__TELAS_JS__'));
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, 'a página tem script');
  assert.doesNotThrow(() => new Function(script!));
  assert.match(script!, /oportunidades/);
  assert.match(script!, /tel:/);
  assert.match(script!, /window\.print\(\)/);
  // o «?» do cabeçalho pede a aula da tela ao menu do CRM (só dentro do CRM): funil, hoje e oportunidades; marketing e gestor não têm aula
  assert.match(html, /id="ajuda"/);
  assert.match(script!, /event:'guia:tela',tela:aula/);
  assert.match(script!, /TELA===''\?'funil':TELA==='hoje'\?'hoje':TELA==='oport'\?'oportunidades':''/);
  assert.match(html, /@media print/);
  // «Mensagem» / «Agendar retorno» / «Confirmar» só abrem a conversa (função existente), nunca chamam a rota de mensagem
  const novo = script!.slice(script!.indexOf('Oportunidades · Marketing · Gestor'));
  assert.doesNotMatch(novo.slice(0, novo.indexOf('function iniciar')), /api\('POST'/);
  assert.match(novo, /abrirConversa\(i\.id\)/);
});

test('UNIFICAÇÃO: o filtro do funil tira o arquivo do histórico (Hoje/gestão) e deixa só o com etapa no quadro e em Oportunidades', () => {
  const antes = Math.floor(Date.parse('2026-11-12T12:00:00Z') / 1000);
  const depois = Math.floor(Date.parse('2026-11-14T12:00:00Z') / 1000);
  const pg = {
    data: {
      meta: { all_count: 4 },
      payload: [
        { id: 1, labels: [], last_activity_at: depois },
        { id: 2, labels: ['historico'], last_activity_at: antes },
        { id: 3, labels: ['historico'], last_activity_at: antes, custom_attributes: { etapa: 'Perdido' } },
        { id: 4, labels: ['historico'], last_activity_at: depois },
      ],
    },
  };
  assert.deepEqual(semArquivo(pg, 'fora').data.payload.map((c: any) => c.id), [1, 4]);
  assert.deepEqual(semArquivo(pg, 'com-etapa').data.payload.map((c: any) => c.id), [1, 3, 4]);
  assert.equal(semArquivo(pg, 'fora').data.meta.all_count, 4, 'não mexe no resto da página');
  assert.equal(semArquivo({ data: { payload: [{ id: 9, labels: [] }] } }, 'fora').data.payload.length, 1);
});

// ── 23/11: a aba «Funil» lia ~14 páginas em fila a cada abertura (≈11 s) — agora a leitura fica guardada ───────────────

const paginasLidas = () => chamadas.filter((c) => /\/conversations\?/.test(c.url)).length;
const quadro = async (quem: string, query: Record<string, string> = {}) => {
  const r = resp();
  await funilQuadroHandler(pedido(quem, query), asRes(r));
  assert.equal(r.codigo, 200, `${quem}: ${JSON.stringify(r.corpo)}`);
  return r.corpo;
};

test('quadro: a 2ª abertura (e a de OUTRA atendente das mesmas caixas) não relê o Chatwoot; o que a tela mostra é igual', async () => {
  _esquecerLeituraDoFunil();
  chamadas.length = 0;
  const q1 = await quadro('agente');
  const primeiras = paginasLidas();
  assert.ok(primeiras > 0);
  const q2 = await quadro('agente');
  const q3 = await quadro('admin'); // outra pessoa, mesmas caixas: a leitura é compartilhada
  assert.equal(paginasLidas(), primeiras, 'nenhuma página nova: a leitura guardada serviu');
  assert.deepEqual(q2.colunas, q1.colunas);
  assert.deepEqual(q3.colunas, q1.colunas, 'as mesmas colunas e conversas para quem enxerga as mesmas caixas');
  assert.equal(q1.total, CONVERSAS.length);
  // e a leitura de cada uma continua sendo com o login da PRÓPRIA pessoa
  assert.ok(chamadas.filter((c) => c.url.includes('/inboxes')).every((c) => ['agente', 'admin'].includes(c.headers['access-token'] ?? '')));
});

test('quadro: depois de 20 s serve o velho NA HORA e relê UMA vez em segundo plano; depois de 2 min espera a leitura nova', async () => {
  _esquecerLeituraDoFunil();
  await quadro('agente');
  const base = paginasLidas();
  mock.timers.tick(30_000);
  await quadro('agente');
  await quadro('admin');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const depoisDoVelho = paginasLidas();
  assert.ok(depoisDoVelho > base, 'a releitura em segundo plano aconteceu');
  const porLeitura = depoisDoVelho - base;
  await quadro('agente'); // já renovada: fresca de novo
  assert.equal(paginasLidas(), depoisDoVelho);
  mock.timers.tick(200_000);
  await quadro('agente'); // passou de 2 min: lê de novo e espera
  assert.equal(paginasLidas(), depoisDoVelho + porLeitura);
});

test('quadro: escrever (nota, mover, atribuir…) invalida: quem acabou de mover nunca vê o quadro velho', async () => {
  _esquecerLeituraDoFunil();
  await quadro('admin');
  const base = paginasLidas();
  await quadro('admin');
  assert.equal(paginasLidas(), base, 'guardado');
  const r = resp();
  await funilNotaHandler({ ...pedido('admin'), body: { conversaId: 1, texto: 'ligou' } } as unknown as Request, asRes(r));
  assert.equal(r.codigo, 200, JSON.stringify(r.corpo));
  const lidasDepoisDoMover = paginasLidas();
  await quadro('admin');
  assert.ok(paginasLidas() > lidasDepoisDoMover, 'releu depois da escrita');
});

test('quadro: a leitura guardada NÃO vaza caixa para quem não a enxerga (nem com ?caixa=N), e a caixa pedida precisa ser das DELA', async () => {
  _esquecerLeituraDoFunil();
  await quadro('admin'); // enche a leitura guardada da caixa 3 (login da administradora)
  chamadas.length = 0;
  const so5 = await quadro('so5');
  assert.equal(so5.total, 0, 'quem só atende a caixa 5 não recebe conversa da caixa 3');
  const pedida = await quadro('so5', { caixa: '3' });
  assert.equal(pedida.total, 0, '?caixa=3 também não: a leitura guardada não passa pelo Chatwoot com o login dela');
  assert.ok(!chamadas.some((c) => /inbox_id=3/.test(c.url)), 'nenhuma página da caixa 3 foi lida (nem vinda da memória)');
  const dela = await quadro('admin', { caixa: '3' });
  assert.equal(dela.total, CONVERSAS.length, 'quem enxerga a caixa recebe');
  const lixo = await quadro('admin', { caixa: '99' });
  assert.equal(lixo.total, 0, 'caixa que não existe: vazio, sem criar leitura guardada');
});

test('Oportunidades (resposta pronta de 45 s) também se refaz depois de uma escrita', async () => {
  _esquecerLeituraDoFunil();
  const oportunidades = () => funilOportunidadesHandler(pedido('admin'), asRes(resp()));
  await oportunidades();
  const base = paginasLidas();
  await oportunidades();
  assert.equal(paginasLidas(), base, 'guardada');
  await funilNotaHandler({ ...pedido('admin'), body: { conversaId: 1, texto: 'ligou' } } as unknown as Request, asRes(resp()));
  const depoisDaNota = paginasLidas();
  await oportunidades();
  assert.ok(paginasLidas() > depoisDaNota, 'a tela refez a leitura depois da escrita');
});
