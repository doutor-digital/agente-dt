/**
 * Etiquetas de UMA conversa em fila (o Chatwoot substitui a lista inteira): anúncio, formulário e «sofia-atendendo» gravando ao mesmo tempo não se desfazem,
 * mesmo quando uma delas demora (o «Sofia atendendo» só espera 8 s pelo anúncio/formulário). E o referral de anúncio tira a etiqueta `formulario` (palpite).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { portaDoChatwoot } = await import('./chatwoot-porta.js');
const { portaDoAtendimento, comecarAtendimento } = await import('./chatwoot-sofia-atendendo.js');
const { criarContextoChatwoot } = await import('../mcp-remoto/chatwoot.js');
const { aoAcharReferral } = await import('./chatwoot-ia.js');

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Chatwoot de mentira com a MESMA semântica do real: GET devolve as etiquetas de agora, POST /labels SUBSTITUI a lista; cada chamada demora um pouco. */
function chatwootQueSubstitui(inicial: string[], gravacaoLentaDe?: string) {
  const conv = { labels: [...inicial] };
  const log: string[] = [];
  const f = (async (url: string, o: { method?: string; body?: string } = {}) => {
    const caminho = new URL(url).pathname.replace(/^\/api\/v1\/accounts\/\d+\//, '');
    const metodo = o.method ?? 'GET';
    await espera(5);
    const r = (j: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) }) as Response;
    if (metodo === 'GET' && caminho === 'conversations/5') return r({ id: 5, status: 'open', labels: [...conv.labels], meta: { sender: { name: 'Maria', phone_number: '+5594999990000' }, assignee: null }, custom_attributes: {} });
    if (metodo === 'POST' && caminho === 'conversations/5/labels') {
      const nova: string[] = JSON.parse(o.body ?? '{}').labels;
      await espera(nova.includes(gravacaoLentaDe ?? '\u0000') ? 60 : 5); // a gravação de uma delas demora (o formulário passa dos 8 s do «Sofia atendendo»)
      conv.labels = nova;
      log.push(`POST ${conv.labels.join(',')}`);
      return r({ payload: conv.labels });
    }
    return r({});
  }) as unknown as typeof fetch;
  return { conv, log, ctx: criarContextoChatwoot({ url: 'https://crm.exemplo.test', conta: 1, token: 'tk' }, { fetch: f }) };
}

test('controle: a semântica do Chatwoot de mentira É a do real — leitura+gravação sem fila perde etiqueta (é isso que a fila evita)', async () => {
  const w = chatwootQueSubstitui(['quente']);
  const naive = async (etq: string) => {
    const r = JSON.parse(await (await w.ctx.fetch('https://crm.exemplo.test/api/v1/accounts/1/conversations/5')).text()) as { labels: string[] };
    await w.ctx.fetch('https://crm.exemplo.test/api/v1/accounts/1/conversations/5/labels', { method: 'POST', body: JSON.stringify({ labels: [...r.labels, etq] }) });
  };
  await Promise.all([naive('formulario'), naive('anuncio')]);
  assert.equal(w.conv.labels.length, 2, 'uma das duas se perdeu');
});

test('formulário + anúncio + «sofia-atendendo» ao mesmo tempo: NENHUMA se perde e a que já estava fica', async () => {
  const w = chatwootQueSubstitui(['quente']);
  const chat = portaDoChatwoot(w.ctx);
  const atend = portaDoAtendimento(w.ctx, async () => undefined);
  await Promise.all([chat.adicionarEtiquetas(5, ['formulario']), atend.adicionarEtiqueta!(5, 'sofia-atendendo'), chat.adicionarEtiquetas(5, ['anuncio'])]);
  assert.deepEqual([...w.conv.labels].sort(), ['anuncio', 'formulario', 'quente', 'sofia-atendendo']);
});

test('a Sofia que começa a atender DEPOIS dos 8 s (enquanto o formulário ainda grava) não derruba o formulário, e o formulário não derruba o «sofia-atendendo»', async () => {
  const w = chatwootQueSubstitui([], 'formulario');
  const chat = portaDoChatwoot(w.ctx);
  const atend = portaDoAtendimento(w.ctx, async () => undefined);
  const formulario = chat.adicionarEtiquetas(5, ['formulario']); // ainda em curso (a gravação dela demora)…
  const sofia = comecarAtendimento(5, atend); // …quando a Sofia começa
  await Promise.all([formulario, sofia]);
  assert.deepEqual([...w.conv.labels].sort(), ['formulario', 'sofia-atendendo']);
});

test('tirar a etiqueta de uma conversa também relê na fila: tira SÓ ela e preserva as que outro acabou de pôr', async () => {
  const w = chatwootQueSubstitui(['sofia-atendendo', 'quente']);
  const chat = portaDoChatwoot(w.ctx);
  const atend = portaDoAtendimento(w.ctx, async () => undefined);
  await Promise.all([atend.tirarEtiqueta!(5, 'sofia-atendendo'), chat.adicionarEtiquetas(5, ['formulario'])]);
  assert.deepEqual([...w.conv.labels].sort(), ['formulario', 'quente']);
  await chat.removerEtiquetas!(5, ['formulario']);
  assert.deepEqual(w.conv.labels, ['quente']);
  const antes = w.log.length;
  await chat.removerEtiquetas!(5, ['formulario']);
  assert.equal(w.log.length, antes, 'sem a etiqueta não grava nada');
});

test('conversa que não existe: adicionar lança (como sempre) e a fila não trava as seguintes', async () => {
  const f = (async (url: string) => {
    const ok = /\/conversations\/5(\/labels)?$/.test(new URL(url).pathname);
    return { ok, status: ok ? 200 : 404, text: async () => (ok ? JSON.stringify({ id: 5, labels: [] }) : '{}') } as Response;
  }) as unknown as typeof fetch;
  const ctx = criarContextoChatwoot({ url: 'https://crm.exemplo.test', conta: 1, token: 'tk' }, { fetch: f });
  const chat = portaDoChatwoot(ctx);
  await assert.rejects(() => chat.adicionarEtiquetas(9, ['x']));
  await chat.adicionarEtiquetas(5, ['x']);
});

// ── referral de anúncio tira a etiqueta do palpite ───────────────────────────────────────────────────────────────

function estadoDeMentira(modoOrigem: 'ligado' | 'seco' | 'desligado', contato: Record<string, unknown> = { origem: 'Formulário', origem_palpite: 'formulario-texto' }, modoFormulario: 'ligado' | 'seco' | 'desligado' = 'ligado') {
  const f = { somou: [] as string[][], tirou: [] as string[][] };
  const r = {
    chat: { adicionarEtiquetas: async (_c: number, l: string[]) => { f.somou.push(l); }, removerEtiquetas: async (_c: number, l: string[]) => { f.tirou.push(l); } },
    origem: { estado: () => modoOrigem, contato: async () => ({ ...contato }), nomes: async () => null, gravar: async () => undefined },
    formulario: { estado: () => modoFormulario },
    nota: {},
  };
  return { r, f };
}
const REF = { anuncio: '120200000000000001', ctwaClid: 'Afd', tipo: 'ad', titulo: 'Dor?', url: null, quando: 1 };
const M = { conversa: 5, caixa: 3, contato: 77 };

test('o referral troca o PALPITE do formulário por «Meta Ads»: só então a etiqueta `formulario` cai (e só com o formulário não desligado)', async () => {
  const lig = estadoDeMentira('ligado');
  const det = await aoAcharReferral(lig.r as never)(M, REF, false);
  assert.equal(det.origem, 'trocou-palpite');
  assert.deepEqual(lig.f.tirou, [['formulario']]);
  assert.deepEqual(lig.f.somou, [['anuncio']]);
  const off = estadoDeMentira('ligado', undefined, 'desligado');
  await aoAcharReferral(off.r as never)(M, REF, false);
  assert.deepEqual(off.f.tirou, [], 'formulário desligado: não mexe em etiqueta dele');
});

test('a origem NÃO mudou (equipe escolheu «Formulário» à mão, ou origem de outro tipo, ou seco/desligado, ou publicação): a etiqueta `formulario` fica', async () => {
  const casos: Array<[string, ReturnType<typeof estadoDeMentira>]> = [
    ['equipe à mão (sem marcador)', estadoDeMentira('ligado', { origem: 'Formulário' })],
    ['origem Indicação', estadoDeMentira('ligado', { origem: 'Indicação', origem_palpite: 'formulario-texto' })],
    ['origem em seco', estadoDeMentira('seco')],
    ['origem desligada', estadoDeMentira('desligado')],
  ];
  for (const [rotulo, x] of casos) {
    await aoAcharReferral(x.r as never)(M, REF, false);
    assert.deepEqual(x.f.tirou, [], rotulo);
  }
  const post = estadoDeMentira('ligado');
  await aoAcharReferral(post.r as never)(M, { ...REF, tipo: 'post' }, false);
  assert.deepEqual(post.f.tirou, []);
});
