/**
 * A carga que o agente-dt põe no Chatwoot (27/11/2026). Medido nos logs do Rails: 98% dos pedidos vinham de nós (varreduras da caixa inteira, 41 páginas,
 * repetidas pela régua, pelo CAPI, pela agenda e pelo funil, mais o histórico de mensagens de cada conversa a cada ciclo). Aqui: o que cada parte pede
 * ANTES e DEPOIS num Chatwoot de mentira que conta os pedidos, e que o dado entregue é o MESMO.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.CHATWOOT_LIMITE_POR_SEG = '0'; // aqui se mede o que é PEDIDO, não o tempo: o freio (3/s) tem o teste dele em chatwoot-limite.test.ts

const C = await import('../mcp-remoto/chatwoot.js');
const { paginasDaCaixa, esquecerListasDaCaixa } = await import('./chatwoot-caixa-lista.js');
const W = await import('./chatwoot-regua-worker.js');
const CAPI = await import('./chatwoot-capi.js');
const AG = await import('./chatwoot-agenda.js');
const { lerPaginasCruas, MemoriaDeLeitura, FUNIL_FRESCO_MS, FUNIL_VELHO_MS } = await import('./funil-leitura.js');

const AGORA = Math.floor(Date.now() / 1000);
const viva = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  created_at: AGORA - 86_400,
  status: 'open',
  labels: [],
  last_activity_at: AGORA - 600,
  custom_attributes: { etapa: 'Agendado' },
  meta: { sender: { name: 'Maria', phone_number: `+55949${String(90000000 + id).slice(-8)}` } },
  last_non_activity_message: null,
  ...extra,
});

/** Um Chatwoot de mentira com `total` conversas (25 por página) que conta o que lhe pedem e quantos pedidos andam ao mesmo tempo. */
function chatwoot(total: number) {
  const pedidos: string[] = [];
  let agoraEmAndamento = 0;
  let pico = 0;
  const conversas = Array.from({ length: total }, (_, i) => viva(i + 1));
  const respostas = new Map<string, unknown>();
  const fetchDeMentira = (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    pedidos.push(`${u.pathname.replace('/api/v1/accounts/1', '')}${u.search}`);
    agoraEmAndamento++;
    pico = Math.max(pico, agoraEmAndamento);
    await new Promise((ok) => setImmediate(ok));
    agoraEmAndamento--;
    const lista = /\/conversations$/.test(u.pathname);
    const corpo = lista
      ? { data: { payload: conversas.slice((Number(u.searchParams.get('page')) - 1) * 25, Number(u.searchParams.get('page')) * 25) } }
      : (respostas.get(u.pathname) ?? { payload: [] });
    return new Response(JSON.stringify(corpo), { status: 200 });
  }) as typeof fetch;
  const ctx = C.criarContextoChatwoot({ url: 'https://crm.exemplo.test', conta: 1, token: 'tk' }, { fetch: fetchDeMentira });
  const listagens = () => pedidos.filter((p) => /\/conversations\?/.test(p)).length;
  return { ctx, pedidos, conversas, respostas, listagens, pico: () => pico };
}

// ── a listagem da caixa, dividida ──────────────────────────────────────────────────────────────────

test('régua + CAPI + agenda no mesmo ritmo: ANTES 3 varreduras da caixa (3×41 pedidos); DEPOIS 1 (41), e os três recebem as MESMAS conversas', async () => {
  const { ctx, listagens, conversas } = chatwoot(1000); // 40 páginas cheias + a vazia
  // ANTES: cada um lê com a sua própria memória (validade 0 = nunca reaproveita)
  const sem = (o: string) => paginasDaCaixa(ctx, 3, { maxPaginas: 200, validadeMs: 0, origem: o });
  const [a, b, c] = [await sem('regua'), await sem('capi'), await sem('agenda')];
  const antes = listagens();
  assert.equal(antes, 3 * 41, 'antes: 3 leituras iguais da mesma caixa');
  esquecerListasDaCaixa(ctx);
  // DEPOIS: a régua lê (ela só aceita leitura dela mesma, validade 0), o CAPI e a agenda aceitam a dela
  const r = await W.chatDoChatwoot(ctx).paginas!(3, 200);
  const k = await CAPI.chatDoCapi(ctx).paginas!(3, 200);
  const g = await paginasDaCaixa(ctx, 3, { maxPaginas: 40, validadeMs: AG.VALIDADE_DA_LISTA_DA_AGENDA_MS, origem: 'agenda' });
  const depois = listagens() - antes;
  assert.equal(depois, 41, 'depois: 1 leitura só');
  assert.equal(r.truncada, false);
  const ids = (p: unknown[][]) => p.flat().map((x: any) => x.id);
  assert.deepEqual(ids(r.paginas), conversas.map((x) => x.id), 'a régua recebe a caixa inteira');
  assert.deepEqual(ids(k.paginas), ids(r.paginas));
  assert.deepEqual(ids(a.paginas), ids(r.paginas));
  assert.ok(g.reaproveitada && g.paginas.length === 40 && g.truncada === true, 'a agenda (teto 40) recebe as 40 primeiras e sabe que a caixa seguia, como antes');
  assert.deepEqual(ids(g.paginas), ids(r.paginas).slice(0, 1000), 'as mesmas conversas');
  void b; void c;
});

test('a régua (validade 0) NÃO aceita leitura de ninguém: lê de novo; o CAPI e a agenda aceitam a dela de 2,5 e de 6 min mas não a de 5,5 min (CAPI) nem a de 20 min', async () => {
  const { ctx, listagens } = chatwoot(100);
  let t = 5_000_000;
  const pedir = (validadeMs: number) => paginasDaCaixa(ctx, 3, { maxPaginas: 200, validadeMs, origem: 'x', agora: () => t });
  await pedir(W.VALIDADE_DA_LISTA_DA_REGUA_MS);
  const base = listagens();
  t += 5_000;
  assert.equal((await pedir(W.VALIDADE_DA_LISTA_DA_REGUA_MS)).reaproveitada, false, 'régua nunca aproveita leitura (nem de 5 s): ela grava a partir do que lê');
  t += 150_000; // 2,5 min depois da leitura da régua
  assert.equal((await pedir(CAPI.VALIDADE_DA_LISTA_DO_CAPI_MS)).reaproveitada, true, 'CAPI aceita');
  t += 3 * 60_000; // 5,5 min
  assert.equal((await pedir(CAPI.VALIDADE_DA_LISTA_DO_CAPI_MS)).reaproveitada, false, 'CAPI não aceita 5,5 min');
  t += 6 * 60_000;
  assert.equal((await pedir(AG.VALIDADE_DA_LISTA_DA_AGENDA_MS)).reaproveitada, true, 'agenda aceita 6 min');
  t += 20 * 60_000;
  assert.equal((await pedir(AG.VALIDADE_DA_LISTA_DA_AGENDA_MS)).reaproveitada, false, 'passou da validade e da vida máxima: relê');
  assert.equal(listagens() - base, 3 * 5, '3 leituras novas (a da régua, a do CAPI aos 5,5 min e a final) de 5 pedidos cada (4 páginas cheias + a vazia)');
});

test('a agenda, quando é a primeira a ler, lê como a régua (até o teto de 200) e entrega só as 40 primeiras: a mesma leitura serve ao CAPI, sem 2ª varredura', async () => {
  const { ctx, listagens } = chatwoot(1000);
  const g = await paginasDaCaixa(ctx, 3, { maxPaginas: 40, lerAte: 200, validadeMs: AG.VALIDADE_DA_LISTA_DA_AGENDA_MS, origem: 'agenda' });
  assert.equal(g.paginas.length, 40);
  assert.equal(g.truncada, true, 'para a agenda a caixa passa do teto de 40, como antes');
  const lidas = listagens();
  const k = await CAPI.chatDoCapi(ctx).paginas!(3, 200);
  assert.equal(listagens(), lidas, 'o CAPI aproveita');
  assert.equal(k.paginas.length, 40, '1000 conversas = 40 páginas cheias (a 41ª é a vazia)');
});

test('leituras ao mesmo tempo viram UMA; conta e caixa diferentes não se misturam; falha não fica guardada e chega a todos que esperavam', async () => {
  const { ctx, listagens } = chatwoot(50);
  const juntas = await Promise.all([1, 2, 3, 4].map(() => paginasDaCaixa(ctx, 3, { maxPaginas: 200, validadeMs: 60_000, origem: 'x' })));
  assert.equal(listagens(), 3, '50 conversas = 2 páginas cheias + a vazia, UMA vez');
  assert.equal(juntas.filter((x) => x.reaproveitada).length, 3);
  await paginasDaCaixa(ctx, 7, { maxPaginas: 200, validadeMs: 60_000, origem: 'x' });
  assert.equal(listagens(), 6, 'outra caixa = outra leitura');
  // falha
  const f = chatwoot(10);
  let falha = true;
  const lerPagina = async (p: number) => { if (falha) throw new Error('Chatwoot 502'); return p === 1 ? [viva(1)] : []; };
  const duas = await Promise.allSettled([1, 2].map(() => paginasDaCaixa(f.ctx, 3, { maxPaginas: 5, validadeMs: 60_000, origem: 'x', lerPagina })));
  assert.deepEqual(duas.map((d) => d.status), ['rejected', 'rejected']);
  falha = false;
  assert.equal((await paginasDaCaixa(f.ctx, 3, { maxPaginas: 5, validadeMs: 60_000, origem: 'x', lerPagina })).paginas.length, 1, 'a falha não ficou guardada');
});

test('«truncada» e o teto de páginas valem como antes para cada um, mesmo lendo da leitura de outro', async () => {
  const { ctx } = chatwoot(100); // 4 páginas cheias + a vazia
  const grande = await paginasDaCaixa(ctx, 3, { maxPaginas: 200, validadeMs: 60_000, origem: 'x' });
  assert.deepEqual([grande.paginas.length, grande.truncada], [4, false]);
  const exato = await paginasDaCaixa(ctx, 3, { maxPaginas: 4, validadeMs: 60_000, origem: 'x' });
  assert.deepEqual([exato.paginas.length, exato.truncada, exato.reaproveitada], [4, true, true], 'teto 4 com 4 cheias: não viu a vazia → truncada (como o laço de antes)');
  const folga = await paginasDaCaixa(ctx, 3, { maxPaginas: 5, validadeMs: 60_000, origem: 'x' });
  assert.deepEqual([folga.paginas.length, folga.truncada], [4, false]);
  const curto = await paginasDaCaixa(ctx, 3, { maxPaginas: 2, validadeMs: 60_000, origem: 'x' });
  assert.deepEqual([curto.paginas.length, curto.truncada], [2, true]);
  // leitura que parou no teto 2 NÃO serve a quem quer 10: lê de novo
  const { ctx: c2, listagens } = chatwoot(100);
  await paginasDaCaixa(c2, 3, { maxPaginas: 2, validadeMs: 60_000, origem: 'x' });
  const mais = await paginasDaCaixa(c2, 3, { maxPaginas: 10, validadeMs: 60_000, origem: 'x' });
  assert.equal(mais.reaproveitada, false);
  assert.equal(mais.paginas.length, 4);
  assert.equal(listagens(), 2 + 5);
});

test('a régua e o CAPI leem a mesma lista, página a página (teste/sem `paginas`) ou pela leitura dividida: a mesma lista de conversas', async () => {
  const { ctx } = chatwoot(130);
  const chat = W.chatDoChatwoot(ctx);
  const dividida = await W.lerConversas(chat, 3, new Date());
  const umaAUma = await W.lerConversas({ pagina: chat.pagina }, 3, new Date());
  assert.equal(dividida.conversas.length, 130);
  assert.deepEqual(dividida.conversas.map((c) => c.id), umaAUma.conversas.map((c) => c.id));
  assert.deepEqual([...dividida.atividades], [...umaAUma.atividades]);
  assert.equal(dividida.truncada, umaAUma.truncada);
});

// ── a agenda confere a conversa viva antes de gravar numa leitura que não é dela ──────────────────────

test('agenda: leitura reaproveitada só grava se os atributos da conversa viva forem os da listagem (o Chatwoot troca o objeto inteiro)', async () => {
  const { ctx, respostas } = chatwoot(1);
  const conversa = { id: 7, telefone: '5594999990000', attrs: { etapa: 'Agendado' }, atividade: 1 };
  respostas.set('/api/v1/accounts/1/conversations/7', { custom_attributes: { etapa: 'Agendado' } });
  assert.equal(await AG.atributosAindaOsMesmos(ctx, conversa), true);
  respostas.set('/api/v1/accounts/1/conversations/7', { custom_attributes: { etapa: 'Agendado', origem: 'Instagram' } });
  assert.equal(await AG.atributosAindaOsMesmos(ctx, conversa), false, 'alguém acrescentou um campo depois da listagem: não grava em cima');
  // com a etapa em PAPEL (conta que chama a etapa de outro nome) vale o que a CONTA tem
  const comPapel = { ...conversa, attrs: { etapa: 'Agendado' }, attrsDaConta: { etapa: 'Consulta marcada' } };
  respostas.set('/api/v1/accounts/1/conversations/7', { custom_attributes: { etapa: 'Consulta marcada' } });
  assert.equal(await AG.atributosAindaOsMesmos(ctx, comPapel), true);
  respostas.set('/api/v1/accounts/1/conversations/7', { custom_attributes: null });
  assert.equal(await AG.atributosAindaOsMesmos(ctx, { ...conversa, attrs: {} }), true, 'sem atributos dos dois lados = o mesmo');
  void isDeepStrictEqual;
});

// ── o histórico de mensagens, pela atividade ───────────────────────────────────────────────────────

test('régua: o histórico da conversa só é pedido de novo quando `last_activity_at` anda (mensagem nova); sem `atividade` pede sempre', async () => {
  W._esquecerRespostasPorAtividade();
  const { ctx, pedidos, respostas } = chatwoot(1);
  respostas.set('/api/v1/accounts/1/conversations/9/messages', { payload: [{ id: 1, message_type: 0, private: false, created_at: AGORA - 500 }, { id: 2, message_type: 1, private: true, created_at: AGORA - 400 }] });
  const chat = W.chatDoChatwoot(ctx);
  const n = () => pedidos.filter((p) => p.includes('/conversations/9/messages')).length;
  const a = await chat.ultimaPublica(9, 1000);
  const b = await chat.ultimaPublica(9, 1000);
  assert.equal(n(), 1, 'mesma atividade: uma ida só');
  assert.deepEqual(a, b);
  assert.equal(a?.saida, false, 'a última PÚBLICA é a do paciente (a nota privada não conta)');
  respostas.set('/api/v1/accounts/1/conversations/9/messages', { payload: [{ id: 3, message_type: 1, private: false, created_at: AGORA - 10 }] });
  const c = await chat.ultimaPublica(9, 1001);
  assert.equal(n(), 2, 'mensagem nova (atividade andou): pede de novo');
  assert.equal(c?.saida, true, 'e entrega o que é novo, não o guardado');
  await chat.ultimaPublica(9);
  await chat.ultimaPublica(9, 0);
  assert.equal(n(), 4, 'sem atividade conhecida: nunca usa o guardado');
  // quando o paciente escreveu por último: o mesmo
  respostas.set('/api/v1/accounts/1/conversations/9/messages', { payload: [{ id: 5, message_type: 0, private: false, created_at: AGORA - 30 }] });
  const antes = pedidos.length;
  const d1 = await chat.ultimaDoPaciente(9, 2000);
  const d2 = await chat.ultimaDoPaciente(9, 2000);
  assert.equal(pedidos.length - antes, 1, 'a segunda não foi ao Chatwoot');
  assert.deepEqual(d1, d2);
  // atividade de agora: outra mensagem pode chegar no mesmo segundo depois da leitura — não guarda
  const n0 = pedidos.length;
  await chat.ultimaPublica(9, Math.floor(Date.now() / 1000));
  await chat.ultimaPublica(9, Math.floor(Date.now() / 1000));
  assert.equal(pedidos.length - n0, 2, 'atividade de menos de 3 s atrás: sempre relê');
  W._esquecerRespostasPorAtividade();
});

// ── o funil ────────────────────────────────────────────────────────────────────────────────────────

test('funil: o que a leitura das caixas pede ao Chatwoot em 10 min com 3 atendentes com a tela aberta (atualização de 60 s): ANTES (fresco 20 s) × DEPOIS', async () => {
  const contar = async (frescoMs: number, velhoMs: number) => {
    let agora = 1_000_000;
    let varreduras = 0;
    const m = new MemoriaDeLeitura<number>(frescoMs, velhoMs, () => agora);
    const varredura = async () => { varreduras++; await new Promise((ok) => setImmediate(ok)); return varreduras; };
    for (let seg = 0; seg < 600; seg += 60) {
      agora = 1_000_000 + seg * 1000;
      // as três abas atualizam quase juntas (a mesma leitura serve a todas)
      await Promise.all([m.obter(1, '3|200|1', varredura), m.obter(1, '3|200|1', varredura), m.obter(1, '3|200|1', varredura)]);
      await new Promise((ok) => setImmediate(ok)); // a renovação em segundo plano termina
    }
    return varreduras;
  };
  const antes = await contar(20_000, 120_000);
  const depois = await contar(FUNIL_FRESCO_MS, FUNIL_VELHO_MS);
  console.log(`# funil, 10 min, 3 abas: varreduras ${antes} → ${depois} (× 41 páginas = ${antes * 41} → ${depois * 41} pedidos)`);
  assert.equal(antes, 10, 'antes: toda atualização de 60 s já passava do prazo de 20 s → uma varredura por minuto');
  assert.ok(depois <= 5, `depois: uma a cada ~2 min (${depois})`);
});

test('funil: a leitura das caixas nunca tem mais que `lote` páginas em andamento ao mesmo tempo (1 no quadro e no «Hoje», 4 nas telas de gestão)', async () => {
  for (const lote of [1, 3, 4]) {
    const c = chatwoot(500);
    const buscar = (caminho: string, query: Record<string, string> = {}) => C.chamar(c.ctx, 'GET', caminho, { query }) as Promise<unknown>;
    const r = await lerPaginasCruas(buscar, [3], 30, lote);
    assert.ok(r.paginas.length >= 20);
    assert.ok(c.pico() <= lote, `lote ${lote}: pico ${c.pico()}`);
  }
});
