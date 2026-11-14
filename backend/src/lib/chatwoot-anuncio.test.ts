/**
 * chatwoot-anuncio: a nota «Veio do anúncio» (título, campanha, texto, links, imagem). Só anúncio; só host da Meta; imagem
 * recusada → só texto; nunca lança; CHATWOOT_NOTA_ANUNCIO=0 desliga. E o kapso-referral só avisa «novo» na 1ª vez.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { textoDaNota, hostDaMeta, baixarImagem, notaDoAnuncio, LIMITE_IMAGEM } = await import('./chatwoot-anuncio.js');
const { referralDaMensagemDoKapso, aplicarReferralDoKapso } = await import('./kapso-referral.js');

const REF = {
  anuncio: '120253955240500514',
  ctwaClid: 'C',
  tipo: 'ad',
  titulo: 'AGENDAR AVALIAÇÃO!',
  url: 'https://fb.me/55qiR5fRe',
  quando: 1,
  corpo: 'Você de PARAUAPEBAS! ESSA DOR PODE ACABAR',
  midia: 'https://scontent-for2-1.xx.fbcdn.net/v/capa.jpg?oe=1',
  tipoMidia: 'video',
  video: 'https://www.facebook.com/story.php?story_fbid=1&id=2',
};

test('textoDaNota: título, campanha, texto e links (vídeo só de host da Meta)', () => {
  const t = textoDaNota(REF, { campanha: 'Campanha X', conjunto: 'Conjunto Y' });
  assert.match(t, /^📣 Veio do anúncio «AGENDAR AVALIAÇÃO!»\nCampanha: Campanha X · Conjunto: Conjunto Y\n\nVocê de PARAUAPEBAS/);
  assert.match(t, /▶️ Ver o vídeo do anúncio: https:\/\/www\.facebook\.com\/story\.php/);
  assert.match(t, /🔗 https:\/\/fb\.me\/55qiR5fRe$/);
  assert.doesNotMatch(textoDaNota({ ...REF, video: 'https://golpe.example/v' }, null), /Ver o vídeo/);
  assert.doesNotMatch(textoDaNota(REF, null), /Campanha:/);
});

test('textoDaNota: texto longo é cortado com reticências; sem título ainda diz que veio de anúncio', () => {
  const t = textoDaNota({ ...REF, titulo: null, corpo: 'a'.repeat(5000), url: null, video: null }, null);
  assert.match(t, /^📣 Veio do anúncio\n\na{1200}…$/);
});

test('hostDaMeta: só https de fbcdn.net / fbsbx.com / facebook.com', () => {
  assert.equal(hostDaMeta('https://scontent.fmab4-1.fna.fbcdn.net/x.jpg'), true);
  assert.equal(hostDaMeta('https://lookaside.fbsbx.com/x'), true);
  assert.equal(hostDaMeta('http://scontent.fbcdn.net/x.jpg'), false);
  assert.equal(hostDaMeta('https://fbcdn.net.golpe.com/x.jpg'), false);
  assert.equal(hostDaMeta('https://169.254.169.254/latest'), false);
  assert.equal(hostDaMeta('nada'), false);
});

function resposta(o: { ok?: boolean; tipo?: string; tamanho?: number; bytes?: number }) {
  return {
    ok: o.ok ?? true,
    headers: { get: (n: string) => (n === 'content-type' ? (o.tipo ?? 'image/jpeg') : n === 'content-length' && o.tamanho ? String(o.tamanho) : null) },
    arrayBuffer: async () => new ArrayBuffer(o.bytes ?? 10),
  };
}

test('baixarImagem: host fora da Meta nem é chamado; recusa não-imagem, grande demais, vazia e link vencido', async () => {
  let chamadas = 0;
  const b = (r: ReturnType<typeof resposta>) => (async () => { chamadas++; return r; }) as any;
  assert.equal(await baixarImagem('https://golpe.example/x.jpg', b(resposta({}))), null);
  assert.equal(chamadas, 0);
  assert.deepEqual(await baixarImagem(REF.midia, b(resposta({ bytes: 3 }))), { bytes: new Uint8Array(3), tipo: 'image/jpeg' });
  assert.equal(await baixarImagem(REF.midia, b(resposta({ tipo: 'text/html' }))), null);
  assert.equal(await baixarImagem(REF.midia, b(resposta({ tamanho: LIMITE_IMAGEM + 1 }))), null);
  assert.equal(await baixarImagem(REF.midia, b(resposta({ bytes: LIMITE_IMAGEM + 1 }))), null);
  assert.equal(await baixarImagem(REF.midia, b(resposta({ bytes: 0 }))), null);
  assert.equal(await baixarImagem(REF.midia, b(resposta({ ok: false }))), null);
  assert.equal(await baixarImagem(REF.midia, (async () => { throw new Error('redirect'); }) as any), null);
});

function portas(o: { imagem?: unknown; nomes?: unknown; falhar?: boolean } = {}) {
  const publicadas: Array<{ conversa: number; texto: string; anexo: any }> = [];
  return {
    publicadas,
    p: {
      imagem: async () => (o.imagem === undefined ? { bytes: new Uint8Array(4), tipo: 'image/jpeg' } : (o.imagem as any)),
      nomes: async () => (o.nomes === undefined ? { campanha: 'Campanha X', conjunto: null } : (o.nomes as any)),
      publicar: async (conversa: number, texto: string, anexo: unknown) => {
        if (o.falhar) throw new Error('Chatwoot 500');
        publicadas.push({ conversa, texto, anexo });
      },
    },
  };
}

test('notaDoAnuncio: anúncio → uma nota com a imagem anexada e a campanha', async () => {
  const x = portas();
  assert.equal(await notaDoAnuncio({ conversa: 900, slug: 'doutor-hernia-parauapebas', ref: REF }, x.p, {}), 'com-imagem');
  assert.equal(x.publicadas.length, 1);
  assert.equal(x.publicadas[0]!.anexo.nome, 'anuncio-120253955240500514.jpg');
  assert.match(x.publicadas[0]!.texto, /Campanha: Campanha X/);
});

test('notaDoAnuncio: sem imagem vai só o texto; sem unidade não pergunta a campanha', async () => {
  const x = portas({ imagem: null });
  assert.equal(await notaDoAnuncio({ conversa: 900, slug: undefined, ref: REF }, x.p, {}), 'so-texto');
  assert.equal(x.publicadas[0]!.anexo, null);
  assert.doesNotMatch(x.publicadas[0]!.texto, /Campanha:/);
});

test('notaDoAnuncio: publicação (post), desligada ou Chatwoot fora do ar → nada publicado e não lança', async () => {
  const x = portas();
  assert.equal(await notaDoAnuncio({ conversa: 900, slug: 's', ref: { ...REF, tipo: 'post', anuncio: null } }, x.p, {}), 'nada');
  assert.equal(await notaDoAnuncio({ conversa: 900, slug: 's', ref: REF }, x.p, { CHATWOOT_NOTA_ANUNCIO: '0' }), 'desligado');
  assert.equal(x.publicadas.length, 0);
  assert.equal(await notaDoAnuncio({ conversa: 900, slug: 's', ref: REF }, portas({ falhar: true }).p, {}), 'falhou');
});

test('referralDaMensagemDoKapso: guarda texto, capa e link do vídeo do anúncio', () => {
  const r = referralDaMensagemDoKapso({
    timestamp: '1794532041',
    referral: { source_type: 'ad', source_id: '1', headline: 'H', body: 'x'.repeat(4000), media_type: 'video', thumbnail_url: 'https://a.fbcdn.net/c.jpg', video_url: 'https://www.facebook.com/v' },
  })!;
  assert.equal(r.corpo!.length, 3000);
  assert.equal(r.midia, 'https://a.fbcdn.net/c.jpg');
  assert.equal(r.tipoMidia, 'video');
  assert.equal(r.video, 'https://www.facebook.com/v');
  assert.equal(referralDaMensagemDoKapso({ referral: { source_type: 'ad', image_url: 'https://a.fbcdn.net/i.jpg', thumbnail_url: 'https://a.fbcdn.net/t.jpg' } })!.midia, 'https://a.fbcdn.net/i.jpg');
});

test('aplicarReferralDoKapso: «novo» só quando a linha foi guardada agora (mensagem repetida não ganha 2ª nota)', async () => {
  const m = { conversa: 5, caixa: 3, wamid: 'wamid.ABCDEFGHIJKL', contato: 7 };
  const consultar = (async () => ({ achou: true, ref: REF })) as any;
  const novos: boolean[] = [];
  const aoAchar = async (_m: unknown, _r: unknown, novo: boolean) => { novos.push(novo); };
  await aplicarReferralDoKapso(m, { consultar, guardar: async () => true, aoAchar });
  await aplicarReferralDoKapso(m, { consultar, guardar: async () => false, aoAchar });
  await aplicarReferralDoKapso(m, { consultar, guardar: async () => undefined, aoAchar });
  assert.deepEqual(novos, [true, false, true]);
});
