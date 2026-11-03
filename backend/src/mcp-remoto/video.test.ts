import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import express from 'express';
import {
  contextoVideoDoAmbiente,
  criarTokenDoClipe,
  lerFolhas,
  lerTokenDoClipe,
  linkDoClipe,
  listarGravacoes,
  montarRotaDoClipe,
  registrarVideoSePermitido,
  type AcessoAoClipe,
  type ContextoVideo,
} from './video.js';

// Vigia de vídeo (03/11/2026): lê pacotes de triagem de uma pasta, devolve folhas como imagem e link assinado do clipe.

const AGORA = Date.parse('2026-11-03T20:00:00Z');
const raiz = mkdtempSync(path.join(tmpdir(), 'vigia-test-'));
const fora = mkdtempSync(path.join(tmpdir(), 'vigia-fora-'));
const SEGREDO = 'segredo-de-teste-com-mais-de-32-caracteres';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('folha-de-teste-do-evento'), Buffer.from([0xff, 0xd9])]);
const MP4 = Buffer.concat([Buffer.alloc(4, 0), Buffer.from('ftypisom'), Buffer.alloc(2000, 7)]);

function ctx(extra: Partial<ContextoVideo> = {}): ContextoVideo {
  return { dir: raiz, retencaoDias: 30, urlPublica: 'https://agente.test', segredo: SEGREDO, agora: () => AGORA, ...extra };
}

/** Monta um pacote como o enviar-gravacoes.sh deixa no servidor. */
function pacote(camera: string, stamp: string, o: { duracao?: number; eventos?: number; semMeta?: boolean; json?: string; clipes?: number[]; folhas?: number[] } = {}) {
  const dir = path.join(raiz, camera, stamp);
  mkdirSync(path.join(dir, 'folhas'), { recursive: true });
  mkdirSync(path.join(dir, 'clipes'), { recursive: true });
  const n = o.eventos ?? 2;
  const eventos = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    inicio: 100 + i * 1000,
    fim: 160 + i * 1000,
    pico: 0.0135 + i,
    segundos_com_movimento: 20,
    quadros_seg: Array.from({ length: 12 }, (_, q) => 100 + i * 1000 + q * 5),
    folha: `folhas/evento_${String(i + 1).padStart(4, '0')}.jpg`,
    clipe: `clipes/evento_${String(i + 1).padStart(4, '0')}.mp4`,
    clipe_seg: 60,
    clipe_cortado: false,
  }));
  writeFileSync(
    path.join(dir, 'eventos.json'),
    o.json ??
      JSON.stringify({
        video: 'x.mkv',
        duracao_seg: o.duracao ?? 36_000,
        grade: '4x3',
        movimento_por_hora: [
          { hora: `${stamp.slice(0, 10)}T08:00`, segundos: 120 },
          { hora: `${stamp.slice(0, 10)}T09:00`, segundos: 0 },
        ],
        eventos,
      }),
  );
  for (const i of o.folhas ?? eventos.map((e) => e.id)) writeFileSync(path.join(dir, 'folhas', `evento_${String(i).padStart(4, '0')}.jpg`), JPEG);
  for (const i of o.clipes ?? eventos.map((e) => e.id)) writeFileSync(path.join(dir, 'clipes', `evento_${String(i).padStart(4, '0')}.mp4`), MP4);
  if (!o.semMeta) writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ camera, inicio_gravacao: `${stamp.slice(0, 10)}T${stamp.slice(11, 13)}:${stamp.slice(13)}:00` }));
  return dir;
}

pacote('caixa', '2026-11-03_0800', { eventos: 3 });
pacote('estoque', '2026-11-02_1400', { duracao: 7200, eventos: 1, clipes: [], folhas: [] });
pacote('caixa', '2026-09-01_0800'); // fora da retenção
pacote('caixa', '2026-11-03_1000', { semMeta: true }); // envio em andamento
pacote('caixa', '2026-11-02_0800', { json: '{ isto não é json' }); // corrompido
pacote('caixa', '2026-11-01_0800', { json: JSON.stringify({ duracao_seg: 'dez', eventos: [] }) }); // formato errado


test('ambiente: sem VIGIA_DIR não há vigia; retenção inválida volta a 30 dias', () => {
  const o = { urlPublica: 'https://x.test/', segredo: SEGREDO };
  assert.equal(contextoVideoDoAmbiente({}, o), null);
  assert.equal(contextoVideoDoAmbiente({ VIGIA_DIR: '   ' }, o), null);
  assert.equal(contextoVideoDoAmbiente({ VIGIA_DIR: '/srv/vigia' }, o)?.retencaoDias, 30);
  assert.equal(contextoVideoDoAmbiente({ VIGIA_DIR: '/srv/vigia', VIGIA_RETENCAO_DIAS: '7' }, o)?.retencaoDias, 7);
  for (const ruim of ['0', '-3', 'abc', '1.5', '9999', '']) assert.equal(contextoVideoDoAmbiente({ VIGIA_DIR: '/srv/vigia', VIGIA_RETENCAO_DIAS: ruim }, o)?.retencaoDias, 30, ruim);
  assert.equal(contextoVideoDoAmbiente({ VIGIA_DIR: '/srv/vigia' }, o)?.urlPublica, 'https://x.test');
});

test('video_gravacoes: lista só o pronto e dentro da retenção, mais recente primeiro, com hora real e movimento por hora', async () => {
  const r: any = await listarGravacoes(ctx(), {});
  assert.deepEqual(r.gravacoes.map((g: any) => g.id), ['caixa_2026-11-03_0800', 'estoque_2026-11-02_1400']);
  const g = r.gravacoes[0];
  assert.equal(g.camera, 'caixa');
  assert.equal(g.inicio, '2026-11-03 08:00:00');
  assert.equal(g.fim, '2026-11-03 18:00:00');
  assert.equal(g.duracao, '10:00:00');
  assert.equal(g.eventos, 3);
  assert.equal(g.eventosComClipe, 3);
  assert.deepEqual(g.movimentoPorHora, [
    { hora: '2026-11-03 08:00', segundosComMovimento: 120 },
    { hora: '2026-11-03 09:00', segundosComMovimento: 0 },
  ]);
  assert.equal(r.gravacoes[1].eventosComClipe, 0);
  assert.equal(r.envioEmAndamento, 1, 'sem meta.json = envio em andamento, não aparece');
  assert.equal(r.pacotesIlegiveis, 2, 'json corrompido e json fora do formato são contados, não derrubam a lista');
  assert.match(r.aviso, /nunca acuse/);
  assert.equal(JSON.stringify(r).includes('2026-09-01'), false, 'fora da retenção não aparece');
});

test('video_gravacoes: filtros por câmera e dia, limite, e retenção configurável', async () => {
  assert.deepEqual(((await listarGravacoes(ctx(), { camera: 'estoque' })) as any).gravacoes.map((g: any) => g.id), ['estoque_2026-11-02_1400']);
  assert.deepEqual(((await listarGravacoes(ctx(), { dia: '2026-11-02' })) as any).gravacoes.map((g: any) => g.id), ['estoque_2026-11-02_1400']);
  assert.equal(((await listarGravacoes(ctx(), { limite: 1 })) as any).gravacoes.length, 1);
  // com retenção de 1 dia, o dia 02/11 14h (30 h antes) sai; a de hoje fica
  assert.deepEqual(((await listarGravacoes(ctx({ retencaoDias: 1 }), {})) as any).gravacoes.map((g: any) => g.id), ['caixa_2026-11-03_0800']);
  // e com mais dias a antiga volta (prova que o corte é a configuração, não um número fixo)
  const todas = ((await listarGravacoes(ctx({ retencaoDias: 365 }), {})) as any).gravacoes.map((g: any) => g.id);
  assert.ok(todas.includes('caixa_2026-09-01_0800'));
  await assert.rejects(() => listarGravacoes(ctx(), { camera: '../x' }), /camera inválida/);
  await assert.rejects(() => listarGravacoes(ctx(), { dia: '2026-11-03/../..' }), /dia inválido/);
});

test('video_gravacoes: pasta que não existe vira erro claro, não exceção crua', async () => {
  await assert.rejects(() => listarGravacoes(ctx({ dir: path.join(raiz, 'nao-existe') }), {}), /não está acessível/);
});

test('id da gravação: path traversal e lixo são recusados antes de tocar no disco', async () => {
  const ruins = ['../x', 'caixa_2026-11-03_0800/../..', '..%2f..%2fetc', 'caixa_2026-11-03_0800\n/../x', 'CAIXA_2026-11-03_0800', 'caixa/2026-11-03_0800', '', 'caixa_2026-11-03', '/etc/passwd', 'caixa_2026-11-03_0800.json'];
  for (const g of ruins) {
    await assert.rejects(() => lerFolhas(ctx(), { gravacao: g }), /gravacao inválida/, JSON.stringify(g));
    await assert.rejects(() => linkDoClipe(ctx(), 'u1', { gravacao: g, evento: 1 }), /gravacao inválida/, JSON.stringify(g));
  }
});

test('video_folhas sem eventos: índice com hora real, duração e pico; paginado', async () => {
  const [t]: any = await lerFolhas(ctx(), { gravacao: 'caixa_2026-11-03_0800' });
  assert.equal(t.type, 'text');
  assert.match(t.text, /3 eventos em 10:00:00/);
  assert.match(t.text, /^1 08:01:40 60s 0\.0135$/m); // 08:00:00 + 100 s
  assert.match(t.text, /^2 08:18:20 60s 1\.0135$/m);
  assert.match(t.text, /Fim do índice/);
  const [p]: any = await lerFolhas(ctx(), { gravacao: 'caixa_2026-11-03_0800', aPartirDoEvento: 3 });
  assert.doesNotMatch(p.text, /^1 /m);
  assert.match(p.text, /^3 /m);
});

test('video_folhas com eventos: texto + IMAGEM jpeg na ordem pedida, com o horário real de cada quadro', async () => {
  const r = await lerFolhas(ctx(), { gravacao: 'caixa_2026-11-03_0800', eventos: [2, 1] });
  assert.deepEqual(r.map((b) => b.type), ['text', 'text', 'image', 'text', 'image']);
  const [, cab2, img2, cab1, img1]: any[] = r;
  assert.match(cab2.text, /^Evento 2: 2026-11-03 08:18:20 a 08:19:20 \(60 s\)/);
  assert.match(cab2.text, /08:18:20, 08:18:25, 08:18:30/); // quadros_seg + hora de início
  assert.match(cab1.text, /^Evento 1: 2026-11-03 08:01:40 a 08:02:40/);
  for (const i of [img1, img2]) {
    assert.equal(i.mimeType, 'image/jpeg');
    assert.deepEqual(Buffer.from(i.data, 'base64'), JPEG);
  }
});

test('video_folhas: evento inexistente, lote grande demais e gravação sem pacote são erros claros', async () => {
  await assert.rejects(() => lerFolhas(ctx(), { gravacao: 'caixa_2026-11-03_0800', eventos: [1, 99] }), /não tem o\(s\) evento\(s\) 99/);
  await assert.rejects(() => lerFolhas(ctx(), { gravacao: 'caixa_2026-11-03_0800', eventos: [1, 2, 3, 4, 5, 6, 7, 8, 9] }), /no máximo 8/);
  await assert.rejects(() => lerFolhas(ctx(), { gravacao: 'caixa_2026-11-03_1000' }), /ainda não terminou/);
  await assert.rejects(() => lerFolhas(ctx(), { gravacao: 'caixa_2026-09-01_0800' }), /saiu da lista/);
  await assert.rejects(() => lerFolhas(ctx(), { gravacao: 'caixa_2026-11-02_0800' }), /ilegível/);
  await assert.rejects(() => lerFolhas(ctx(), { gravacao: 'sala_2026-11-03_0800' }), /não existe/);
});

test('video_folhas: o eventos.json NÃO escolhe caminho; link simbólico para fora da pasta não vaza', async () => {
  const segredo = path.join(fora, 'segredo.jpg');
  writeFileSync(segredo, 'CONTEUDO-FORA-DA-PASTA');
  const dir = pacote('porta', '2026-11-03_0700', { eventos: 2, folhas: [] });
  // caminho malicioso no JSON: ignorado (o caminho vem do id)
  const j = JSON.parse(JSON.stringify({ duracao_seg: 100, eventos: [{ id: 1, inicio: 1, fim: 9, folha: segredo, clipe: segredo }, { id: 2, inicio: 20, fim: 30 }] }));
  writeFileSync(path.join(dir, 'eventos.json'), JSON.stringify(j));
  symlinkSync(segredo, path.join(dir, 'folhas', 'evento_0001.jpg'));
  const r = await lerFolhas(ctx(), { gravacao: 'porta_2026-11-03_0700', eventos: [1, 2] });
  assert.equal(r.some((b) => b.type === 'image'), false, 'nenhuma imagem: a do 1 é link para fora e a do 2 não existe');
  assert.equal(JSON.stringify(r).includes('CONTEUDO-FORA'), false);
  assert.equal(JSON.stringify(r).includes(Buffer.from('CONTEUDO-FORA-DA-PASTA').toString('base64')), false);
  assert.equal(r.filter((b: any) => b.type === 'text' && /não está disponível/.test(b.text)).length, 2);
  // pasta da câmera inteira apontando para fora também não passa
  symlinkSync(fora, path.join(raiz, 'camera-fora'));
  const dados = ((await listarGravacoes(ctx(), {})) as any).gravacoes.map((g: any) => g.camera);
  assert.equal(dados.includes('camera-fora'), false);
});

test('token do clipe: assinado, de validade curta, preso ao conteúdo', () => {
  const c = ctx();
  const { token, venceEm } = criarTokenDoClipe(c, 'caixa_2026-11-03_0800', 2, 15, 'user-1');
  assert.equal(venceEm, AGORA + 15 * 60_000);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'seguro em URL');
  assert.deepEqual(lerTokenDoClipe(c, token), { camera: 'caixa', stamp: '2026-11-03_0800', gravacao: 'caixa_2026-11-03_0800', evento: 2, quem: 'user-1' });
  // vence
  assert.equal(lerTokenDoClipe(ctx({ agora: () => AGORA + 15 * 60_000 + 1000 }), token), null);
  assert.ok(lerTokenDoClipe(ctx({ agora: () => AGORA + 14 * 60_000 }), token));
  // outra chave
  assert.equal(lerTokenDoClipe(ctx({ segredo: 'outro-segredo-com-mais-de-32-caracteres!!' }), token), null);
  // adulterado: troca o evento, troca a assinatura, corta, lixo
  const [parte, sig] = token.split('.');
  const outraParte = Buffer.from(Buffer.from(parte!, 'base64url').toString().replace('|2|', '|3|')).toString('base64url');
  assert.equal(lerTokenDoClipe(c, `${outraParte}.${sig}`), null);
  assert.equal(lerTokenDoClipe(c, `${parte}.${sig!.slice(0, -2)}AA`), null);
  assert.equal(lerTokenDoClipe(c, `${parte}.`), null);
  assert.equal(lerTokenDoClipe(c, `${parte}.${sig}.extra`), null);
  assert.equal(lerTokenDoClipe(c, ''), null);
  assert.equal(lerTokenDoClipe(c, 'a'.repeat(5000)), null);
  // mesmo assinado, validade acima do teto de 30 min não passa
  const longo = criarTokenDoClipe(c, 'caixa_2026-11-03_0800', 1, 600, 'u');
  assert.equal(lerTokenDoClipe(c, longo.token), null);
});

test('video_clipe: link com validade padrão de 15 min, teto de 30, e só de evento que tem clipe', async () => {
  const l: any = await linkDoClipe(ctx(), 'user-1', { gravacao: 'caixa_2026-11-03_0800', evento: 2 });
  assert.match(l.url, /^https:\/\/agente\.test\/vigia\/clipe\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/caixa_2026-11-03_0800_evento0002\.mp4$/);
  assert.equal(l.valeMinutos, 15);
  assert.equal(l.venceEm, new Date(AGORA + 15 * 60_000).toISOString());
  assert.equal(l.evento.inicio, '2026-11-03 08:18:20');
  assert.ok(l.tamanhoMB >= 0);
  assert.equal(((await linkDoClipe(ctx(), 'u', { gravacao: 'caixa_2026-11-03_0800', evento: 1, minutos: 500 })) as any).valeMinutos, 30);
  assert.equal(((await linkDoClipe(ctx(), 'u', { gravacao: 'caixa_2026-11-03_0800', evento: 1, minutos: 0 })) as any).valeMinutos, 1);
  await assert.rejects(() => linkDoClipe(ctx(), 'u', { gravacao: 'caixa_2026-11-03_0800', evento: 9 }), /não tem o evento 9/);
  await assert.rejects(() => linkDoClipe(ctx(), 'u', { gravacao: 'estoque_2026-11-02_1400', evento: 1 }), /não tem clipe/);
});

// ------------------------------------------------------------ rota HTTP (servidor de verdade, porta efêmera)

async function servidor(c: ContextoVideo) {
  const acessos: AcessoAoClipe[] = [];
  const app = express();
  montarRotaDoClipe(app, c, (a) => acessos.push(a));
  const srv = await new Promise<import('node:http').Server>((ok) => {
    const s = app.listen(0, '127.0.0.1', () => ok(s));
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { base, acessos, fechar: () => new Promise<void>((ok) => srv.close(() => ok())) };
}
const caminhoDe = (url: string) => new URL(url).pathname;

test('rota: link válido entrega o clipe (video/mp4, sem cache, nosniff), com Range, e audita quem pediu', async () => {
  const c = ctx();
  const s = await servidor(c);
  try {
    const l: any = await linkDoClipe(c, 'user-gerente', { gravacao: 'caixa_2026-11-03_0800', evento: 1 });
    const r = await fetch(s.base + caminhoDe(l.url), { headers: { 'x-forwarded-for': '1.2.3.4, 9.9.9.9', 'user-agent': 'Chrome-teste' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.match(r.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), MP4);
    assert.deepEqual(s.acessos, [{ quem: 'user-gerente', gravacao: 'caixa_2026-11-03_0800', evento: 1, ip: '9.9.9.9', agente: 'Chrome-teste' }]);
    // o navegador pede um pedaço para pular no vídeo
    const rg = await fetch(s.base + caminhoDe(l.url), { headers: { range: 'bytes=0-9' } });
    assert.equal(rg.status, 206);
    assert.equal((await rg.arrayBuffer()).byteLength, 10);
  } finally {
    await s.fechar();
  }
});

test('rota: token ruim, vencido, de outro evento ou fora da retenção dão a MESMA resposta 404', async () => {
  const c = ctx();
  const s = await servidor(c);
  try {
    const bom: any = await linkDoClipe(c, 'u', { gravacao: 'caixa_2026-11-03_0800', evento: 1 });
    const tokenBom = caminhoDe(bom.url).split('/')[3]!;
    const vencido = await servidor(ctx({ agora: () => AGORA + 16 * 60_000 }));
    const retido = await servidor(ctx({ retencaoDias: 1, agora: () => AGORA + 3 * 86_400_000 }));
    const semClipe = criarTokenDoClipe(c, 'estoque_2026-11-02_1400', 1, 15, 'u').token; // assinado, mas o clipe não existe
    const inexistente = criarTokenDoClipe(c, 'caixa_2026-11-03_0800', 77, 15, 'u').token;
    const casos: Array<[string, string]> = [
      [s.base, '/vigia/clipe/lixo/x.mp4'],
      [s.base, `/vigia/clipe/${tokenBom.slice(0, -3)}AAA/x.mp4`],
      [s.base, `/vigia/clipe/${semClipe}/x.mp4`],
      [s.base, `/vigia/clipe/${inexistente}/x.mp4`],
      [vencido.base, `/vigia/clipe/${tokenBom}/x.mp4`],
      [retido.base, `/vigia/clipe/${criarTokenDoClipe(ctx({ retencaoDias: 1, agora: () => AGORA + 3 * 86_400_000 }), 'caixa_2026-11-03_0800', 1, 15, 'u').token}/x.mp4`],
      [s.base, '/vigia/clipe/..%2F..%2Fetc%2Fpasswd/x.mp4'],
    ];
    const corpos = new Set<string>();
    for (const [base, rota] of casos) {
      const r = await fetch(base + rota);
      assert.equal(r.status, 404, rota);
      assert.match(r.headers.get('cache-control') ?? '', /no-store/);
      corpos.add(await r.text());
    }
    assert.equal(corpos.size, 1, 'quem não tem link válido não aprende nada: todas as respostas são iguais');
    assert.equal(s.acessos.length, 0, 'recusa não vira "acesso"');
    await vencido.fechar();
    await retido.fechar();
  } finally {
    await s.fechar();
  }
});

// ------------------------------------------------------------ pelo protocolo (como o claude.ai chama)

async function conectar(c: ContextoVideo | null, userId: string, permitidos: string[], registros: any[] = []) {
  const server = new McpServer({ name: 't', version: '0' });
  const ligou = registrarVideoSePermitido(server, c, userId, new Set(permitidos), (r) => void registros.push(r));
  if (!ligou) return { ligou, cliente: null as Client | null, registros };
  const [a, b] = InMemoryTransport.createLinkedPair();
  const cliente = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(a), cliente.connect(b)]);
  return { ligou, cliente, registros };
}

test('portão: sem VIGIA_DIR, sem a lista ou fora dela as ferramentas NÃO existem', async () => {
  assert.equal((await conectar(null, 'u1', ['u1'])).ligou, false);
  assert.equal((await conectar(ctx(), 'u1', [])).ligou, false);
  assert.equal((await conectar(ctx(), 'u2', ['u1'])).ligou, false);
  assert.equal((await conectar(ctx(), '', [''])).ligou, false, 'usuário vazio nunca entra');
  const ok = await conectar(ctx(), 'u1', ['u1', 'u3']);
  assert.equal(ok.ligou, true);
  const nomes = (await ok.cliente!.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(nomes, ['video_clipe', 'video_folhas', 'video_gravacoes']);
  for (const t of (await ok.cliente!.listTools()).tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
});

test('protocolo: video_folhas devolve content type "image" (base64 jpeg); a auditoria guarda só os argumentos', async () => {
  const { cliente, registros } = await conectar(ctx(), 'u1', ['u1']);
  const r: any = await cliente!.callTool({ name: 'video_folhas', arguments: { gravacao: 'caixa_2026-11-03_0800', eventos: [1] } });
  assert.notEqual(r.isError, true);
  const img = r.content.find((b: any) => b.type === 'image');
  assert.equal(img.mimeType, 'image/jpeg');
  assert.deepEqual(Buffer.from(img.data, 'base64'), JPEG);
  assert.equal(registros.length, 1);
  assert.equal(registros[0].ferramenta, 'video_folhas');
  assert.equal(registros[0].ok, true);
  assert.deepEqual(registros[0].argumentos, { gravacao: 'caixa_2026-11-03_0800', eventos: [1] });
  assert.equal(JSON.stringify(registros[0]).includes(img.data), false, 'imagem não vai para a auditoria');

  // mais de 8 eventos: o próprio esquema recusa
  const muitos: any = await cliente!.callTool({ name: 'video_folhas', arguments: { gravacao: 'caixa_2026-11-03_0800', eventos: [1, 2, 3, 4, 5, 6, 7, 8, 9] } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
  assert.equal(muitos.isError, true);
});

test('protocolo: gravacoes e clipe passam pela auditoria; erro volta como texto legível (isError) e também é auditado', async () => {
  const { cliente, registros } = await conectar(ctx(), 'u1', ['u1']);
  const lista: any = await cliente!.callTool({ name: 'video_gravacoes', arguments: {} });
  assert.equal(JSON.parse(lista.content[0].text).gravacoes[0].id, 'caixa_2026-11-03_0800');
  const clipe: any = await cliente!.callTool({ name: 'video_clipe', arguments: { gravacao: 'caixa_2026-11-03_0800', evento: 1 } });
  assert.match(JSON.parse(clipe.content[0].text).url, /^https:\/\/agente\.test\/vigia\/clipe\//);
  const ruim: any = await cliente!.callTool({ name: 'video_clipe', arguments: { gravacao: '../../etc', evento: 1 } });
  assert.equal(ruim.isError, true);
  assert.match(ruim.content[0].text, /gravacao inválida/);
  assert.deepEqual(registros.map((r) => [r.ferramenta, r.ok]), [['video_gravacoes', true], ['video_clipe', true], ['video_clipe', false]]);
});

// ------------------------------------------------------------ prova com pacote REAL (gerado por teste-ponta-a-ponta.sh)

test('pacote real do enviar-gravacoes.sh (só com VIGIA_DIR_E2E)', { skip: !process.env.VIGIA_DIR_E2E }, async () => {
  const c = ctx({ dir: process.env.VIGIA_DIR_E2E!, agora: () => Date.parse('2026-11-04T00:00:00Z') });
  const lista: any = await listarGravacoes(c, {});
  console.log(JSON.stringify(lista.gravacoes, null, 1));
  assert.equal(lista.gravacoes.length, 1);
  assert.equal(lista.gravacoes[0].eventos, 2);
  const folhas = await lerFolhas(c, { gravacao: lista.gravacoes[0].id, eventos: [1, 2] });
  console.log(folhas.map((b: any) => (b.type === 'image' ? `[imagem ${b.mimeType} ${Buffer.from(b.data, 'base64').length} bytes]` : b.text)).join('\n'));
  assert.equal(folhas.filter((b) => b.type === 'image').length, 2);
  const l: any = await linkDoClipe(c, 'u', { gravacao: lista.gravacoes[0].id, evento: 1 });
  console.log(l.url, l.tamanhoMB, 'MB');
});
