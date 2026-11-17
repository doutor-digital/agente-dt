/**
 * O referral que o PRÓPRIO Chatwoot traz (desde 14/11/2026, `content_attributes.referral`): vale ele, sem consultar o Kapso, e segue o mesmo
 * caminho (guardar → etiqueta `anuncio`, nota «Veio do anúncio» só na 1ª vez, Origem no contato). Sem referral no Chatwoot, o Kapso é consultado
 * como sempre. Antes, o Chatwoot trazer o referral fazia o servidor NÃO FAZER NADA (medido 17/11: 4 conversas de anúncio, 0 etiquetas/notas/origens).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { aplicarReferralDoKapso, mensagemParaConsultar, referralDoChatwoot } = await import('./kapso-referral.js');
const { aoAcharReferral } = await import('./chatwoot-ia.js');
const { ORIGEM_ANUNCIO } = await import('./chatwoot-origem.js');

const WAMID = 'wamid.HBgMNTU5NDkyNDg0NDk5FQIAEhggQUMzMjUxRTJE';
const REF_CW = {
  source_type: 'ad',
  source_id: '120253955239410514',
  ctwa_clid: 'Afd123',
  headline: 'Dor na coluna?',
  source_url: 'https://fb.me/x',
  body: 'Fale com a gente',
  image_url: 'https://scontent.example/a.jpg',
  media_type: 'image',
};
const webhook = (ref: unknown, extra: Record<string, unknown> = {}) => ({
  event: 'message_created',
  message_type: 'incoming',
  private: false,
  source_id: WAMID,
  created_at: '2026-11-15T12:00:00.000Z',
  sender: { id: 77 },
  content_attributes: ref === undefined ? {} : { referral: ref },
  conversation: { id: 900, inbox_id: 3 },
  ...extra,
});
const CAIXAS = new Set([3]);

test('referralDoChatwoot: normaliza como o do Kapso; hora do created_at; camelCase e id numérico aceitos; sem nada que identifique = null', () => {
  const r = referralDoChatwoot(REF_CW, '2026-11-15T12:00:00.000Z')!;
  assert.deepEqual(r, {
    anuncio: '120253955239410514',
    ctwaClid: 'Afd123',
    tipo: 'ad',
    titulo: 'Dor na coluna?',
    url: 'https://fb.me/x',
    quando: Date.parse('2026-11-15T12:00:00.000Z'),
    corpo: 'Fale com a gente',
    midia: 'https://scontent.example/a.jpg',
    tipoMidia: 'image',
    video: null,
  });
  assert.equal(referralDoChatwoot(REF_CW, 1794557921)!.quando, 1794557921000, 'epoch em segundos (API do Chatwoot)');
  assert.equal(referralDoChatwoot(REF_CW, 1794557921000)!.quando, 1794557921000, 'epoch em ms');
  const camel = referralDoChatwoot({ sourceType: 'ad', sourceId: 1202539552394, ctwaClid: 'C' })!;
  assert.equal(camel.ctwaClid, 'C');
  assert.equal(camel.anuncio, '1202539552394', 'id numérico seguro vira texto');
  // id numérico acima de MAX_SAFE_INTEGER já perdeu dígitos no JSON: descarta (sem id é melhor que id errado); o resto do referral fica
  const grande = referralDoChatwoot({ source_type: 'ad', source_id: 120253955239410514, ctwa_clid: 'C' })!;
  assert.equal(grande.anuncio, null);
  assert.equal(grande.ctwaClid, 'C');
  assert.equal(referralDoChatwoot({ headline: 'só um título' }), null, 'sem tipo, id nem clid: não identifica anúncio');
  for (const v of [null, undefined, 'x', 7, [], {}]) assert.equal(referralDoChatwoot(v), null);
});

test('mensagemParaConsultar: referral do Chatwoot vem junto; sem referral (ou vazio/inútil) = null, e o Kapso é quem responde', () => {
  const com = mensagemParaConsultar(webhook(REF_CW), CAIXAS)!;
  assert.equal(com.referral?.anuncio, '120253955239410514');
  assert.equal(com.referral?.quando, Date.parse('2026-11-15T12:00:00.000Z'));
  assert.equal(com.contato, 77);
  assert.equal(mensagemParaConsultar(webhook(undefined), CAIXAS)!.referral, null);
  assert.equal(mensagemParaConsultar(webhook({}), CAIXAS)!.referral, null);
  assert.equal(mensagemParaConsultar(webhook({ headline: 'x' }), CAIXAS)!.referral, null);
  // o resto das regras não mudou: outra caixa, saída e nota privada seguem de fora
  assert.equal(mensagemParaConsultar(webhook(REF_CW, { conversation: { id: 900, inbox_id: 2 } }), CAIXAS), null);
  assert.equal(mensagemParaConsultar(webhook(REF_CW, { message_type: 'outgoing' }), CAIXAS), null);
  assert.equal(mensagemParaConsultar(webhook(REF_CW, { private: true }), CAIXAS), null);
});

test('aplicar com referral do Chatwoot: guarda e avisa SEM consultar o Kapso', async () => {
  const guardados: unknown[][] = [];
  const achados: unknown[][] = [];
  let consultas = 0;
  const m = mensagemParaConsultar(webhook(REF_CW), CAIXAS)!;
  const r = await aplicarReferralDoKapso(m, {
    consultar: (async () => { consultas++; return null; }) as any,
    guardar: (async (...a: unknown[]) => { guardados.push(a); return true; }) as any,
    aoAchar: async (...a: unknown[]) => { achados.push(a); },
  });
  assert.equal(r, 'guardado');
  assert.equal(consultas, 0, 'o Chatwoot já tem: nada a buscar no Kapso');
  assert.deepEqual(guardados.map((g) => [g[0], g[1], g[2], (g[3] as any).anuncio]), [[3, 900, WAMID, '120253955239410514']]);
  assert.deepEqual(achados.map((a) => [a[0], (a[1] as any).ctwaClid, a[2]]), [[{ conversa: 900, caixa: 3, contato: 77 }, 'Afd123', true]]);
});

test('aplicar sem referral no Chatwoot: consulta o Kapso como antes', async () => {
  let consultas = 0;
  const guardados: unknown[] = [];
  const m = mensagemParaConsultar(webhook(undefined), CAIXAS)!;
  const r = await aplicarReferralDoKapso(m, {
    consultar: (async () => { consultas++; return { achou: true, ref: { anuncio: '9', ctwaClid: 'K', tipo: 'ad', titulo: null, url: null, quando: 1 } }; }) as any,
    guardar: (async (...a: unknown[]) => { guardados.push(a); return true; }) as any,
  });
  assert.equal(r, 'guardado');
  assert.equal(consultas, 1);
  assert.equal(guardados.length, 1);
});

/** Um estado de conta de mentira: registra o que seria feito no Chatwoot. */
function estado() {
  const f = { etiquetas: [] as string[][], notas: [] as number[], origem: [] as Array<Record<string, string>> };
  const e = {
    chat: { adicionarEtiquetas: async (_c: number, l: string[]) => { f.etiquetas.push(l); } },
    nota: { imagem: async () => null, nomes: async () => null, publicar: async (c: number) => { f.notas.push(c); } },
    origem: { estado: () => 'ligado', contato: async () => ({}), nomes: async () => null, gravar: async (_c: number, campos: Record<string, string>) => { f.origem.push(campos); } },
  } as any;
  return { f, e };
}
const guardarComo = (resultados: boolean[]) => (async () => resultados.shift() ?? false) as any;

test('referral de anúncio do Chatwoot: etiqueta anuncio + nota + origem; repetido NÃO duplica a nota', async () => {
  const { f, e } = estado();
  const m = mensagemParaConsultar(webhook(REF_CW), CAIXAS)!;
  const guardar = guardarComo([true, false]);
  assert.equal(await aplicarReferralDoKapso(m, { guardar, aoAchar: aoAcharReferral(e) }), 'guardado');
  assert.deepEqual(f.etiquetas, [['anuncio']]);
  assert.deepEqual(f.notas, [900]);
  assert.equal(f.origem.length, 1, 'Origem/Campanha preenchida no contato');
  assert.equal(f.origem[0]!.origem, ORIGEM_ANUNCIO);
  // a mesma mensagem de novo (webhook reentregue): a linha já existe → sem nota nova
  assert.equal(await aplicarReferralDoKapso(m, { guardar, aoAchar: aoAcharReferral(e) }), 'guardado');
  assert.equal(f.notas.length, 1, 'a nota só na 1ª vez');
});

test('referral do Chatwoot de publicação (não-ad): guarda, mas não etiqueta, não deixa nota nem chuta origem', async () => {
  const { f, e } = estado();
  const m = mensagemParaConsultar(webhook({ ...REF_CW, source_type: 'post' }), CAIXAS)!;
  assert.equal(await aplicarReferralDoKapso(m, { guardar: guardarComo([true]), aoAchar: aoAcharReferral(e) }), 'guardado');
  assert.deepEqual(f.etiquetas, []);
  assert.deepEqual(f.notas, []);
  assert.deepEqual(f.origem, []);
});

test('aoAcharReferral sem estado da conta não lança nem faz nada', async () => {
  const m = mensagemParaConsultar(webhook(REF_CW), CAIXAS)!;
  assert.equal(await aplicarReferralDoKapso(m, { guardar: guardarComo([true]), aoAchar: aoAcharReferral(null) }), 'guardado');
});
