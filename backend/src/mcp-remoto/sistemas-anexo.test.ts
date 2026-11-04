import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErroSistemas } from '../lib/integracoes/sistemas.js';
import { baixarUrl, dominiosPermitidos, DOMINIOS_PADRAO, hostPermitido, ipPrivado, type Requisitar, type Resposta } from './baixar-url.js';
import { CofreDeArquivos, ErroDeCofre } from './cofre-arquivos.js';
import { criarContextoSistemas, type ContaSistemas } from './sistemas.js';
import { nomeLimpo, registrarAnexosSistemas, type DepsAnexo } from './sistemas-anexo.js';

// ── amostras ──────────────────────────────────────────────────────────────────────────────────────────
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR-fake')]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const DOC = Buffer.concat([OLE, Buffer.alloc(32), Buffer.from('WordDocument', 'utf16le')]);
const HTML = Buffer.from('<!doctype html><html><body>Recibo</body></html>');

const LANC = '3f2b8c1e-5d6a-4b7c-9e0f-112233445566';
const QUEM = { usuario: 'u-suzanne', nome: 'suzanne@exemplo.com' };
const BASE = 'https://agente-vps.exemplo.com.br';
const MIN = 60_000;

// ── o servidor do sistema, de mentira ─────────────────────────────────────────────────────────────────
interface Chamada { metodo: string; caminho: string; corpo: any; quem?: string }
function servidor(o: { lancamento?: Record<string, unknown> | null; anexo?: (corpo: any) => unknown } = {}) {
  const chamadas: Chamada[] = [];
  const lanc = o.lancamento === undefined ? { id: LANC, unidade: 'rioverde', data: '2026-11-03', tipo: 'entrada', categoria: 'consulta', valor: 150, forma: 'pix', status: 'aguardando' } : o.lancamento;
  const conta: ContaSistemas = {
    slug: 'hm-tecnologia',
    nome: 'HM',
    fonte: {
      async chamar(metodo, caminho, op) {
        chamadas.push({ metodo, caminho, corpo: op?.corpo, quem: op?.quem });
        if (caminho === '/admin/v1/consulta') return { colunas: [], linhas: lanc ? [lanc] : [], cortado: false };
        if (caminho === '/admin/v1/anexo') {
          const r = o.anexo ? o.anexo(op?.corpo) : { ok: true, doc_id: 'doc-1', caminho: 'rioverde/2026-11/x-recibo.pdf', paginas: 1, previas: 1, ia_status: 'aguardando' };
          if (r instanceof Error) throw r;
          return r;
        }
        throw new Error(`rota inesperada ${caminho}`);
      },
    },
  };
  return { chamadas, ctx: criarContextoSistemas(new Map([[conta.slug, conta]])), anexos: () => chamadas.filter((c) => c.caminho === '/admin/v1/anexo') };
}

function ambiente(srv: ReturnType<typeof servidor>, extra: Partial<DepsAnexo> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'anexo-teste-'));
  const relogio = { t: Date.parse('2026-11-04T10:00:00-03:00') };
  const cofre = new CofreDeArquivos({ dir: path.join(dir, 'cofre'), agora: () => relogio.t });
  const auditoria: Array<{ ferramenta: string; argumentos: any; ok: boolean; erro?: string }> = [];
  const deps: DepsAnexo = { cofre, baseUrl: () => BASE, dominios: DOMINIOS_PADRAO, ...extra };
  return { cofre, relogio, auditoria, deps, dir, limpar: () => rmSync(dir, { recursive: true, force: true }), srv };
}

async function cliente(a: ReturnType<typeof ambiente>) {
  const server = new McpServer({ name: 't', version: '1' });
  registrarAnexosSistemas(server, a.srv.ctx, QUEM, a.deps, (r) => a.auditoria.push(r as any));
  const [x, y] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(x), c.connect(y)]);
  const chamar = async (nome: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name: nome, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    const texto = r.content[0]!.text;
    return { erro: r.isError === true, texto, json: r.isError ? null : JSON.parse(texto) };
  };
  return { c, chamar };
}

/** pede o link como a Lia e "envia" como a página/curl (reservar + guardar) */
async function pedirESubir(a: ReturnType<typeof ambiente>, k: Awaited<ReturnType<typeof cliente>>, conteudo: Buffer | null, nome = 'recibo.pdf', args: Record<string, unknown> = {}) {
  const p = await k.chamar('sistemas_preparar_anexo', { tabela: 'caixa_lanc', lancamento: LANC, tipo: 'comprovante', ...args });
  assert.equal(p.erro, false, p.texto);
  if (conteudo) {
    const token = String(p.json.linkDeEnvio).split('/').pop()!;
    await a.cofre.guardar(a.cofre.reservar(token), nome, conteudo);
  }
  return p.json as { envio: string; linkDeEnvio: string };
}

// ── o portão ──────────────────────────────────────────────────────────────────────────────────────────
test('portão: as ferramentas de anexo só são registradas no bloco de quem escreve (producao.ts)', () => {
  const prod = readFileSync(new URL('./producao.ts', import.meta.url), 'utf8');
  const chamada = prod.indexOf('registrarAnexosSistemas(');
  const bloco = prod.indexOf('if (escritores.has(quem.userId)) {');
  const proximo = prod.indexOf('if (leitoresWhatsapp.has(quem.userId))');
  assert.ok(bloco > 0 && chamada > bloco && chamada < proximo, 'registrarAnexosSistemas tem que estar dentro de if (escritores.has(...))');
});

// ── passo 1: o link ───────────────────────────────────────────────────────────────────────────────────
test('preparar_anexo: confere o lançamento, devolve link de 10 min preso ao lançamento, sem gravar nada no sistema', async () => {
  const a = ambiente(servidor());
  try {
    const k = await cliente(a);
    const r = await k.chamar('sistemas_preparar_anexo', { tabela: 'caixa_lanc', lancamento: LANC, tipo: 'nota_fiscal', nome_arquivo: 'NF 123.pdf' });
    assert.equal(r.erro, false, r.texto);
    assert.match(r.json.linkDeEnvio, new RegExp(`^${BASE}/arquivos/enviar/[A-Za-z0-9_-]{43}$`));
    assert.equal(r.json.validoMinutos, 10);
    assert.equal(r.json.dominioDoLink, 'agente-vps.exemplo.com.br');
    assert.match(r.json.comandoCurl, /curl .*-X PUT --data-binary @ARQUIVO .*X-Nome-Arquivo: NF%20123\.pdf.*arquivos\/enviar\//);
    assert.equal(r.json.lancamento.id, LANC); assert.equal(r.json.lancamento.tipoDoAnexo, 'nota_fiscal'); assert.equal(r.json.lancamento.linha.unidade, 'rioverde');
    assert.equal(a.srv.anexos().length, 0, 'preparar não grava');
    assert.equal(Date.parse(r.json.validoAte) - a.relogio.t, 10 * MIN);
    // a auditoria do conector não leva o link nem o nome do arquivo
    assert.ok(!JSON.stringify(a.auditoria).includes('/arquivos/enviar/'));
    assert.ok(!JSON.stringify(a.auditoria).includes('NF 123'));
  } finally { a.limpar(); }
});

test('preparar_anexo: lançamento inexistente, cancelado, fin_lanc que já tem anexo, id que não é uuid, tabela inválida', async () => {
  const k1 = await cliente(ambiente(servidor({ lancamento: null })));
  const a1 = await k1.chamar('sistemas_preparar_anexo', { tabela: 'caixa_lanc', lancamento: LANC, tipo: 'recibo' });
  assert.ok(a1.erro && /não achei o lançamento/.test(a1.texto), a1.texto);
  const k2 = await cliente(ambiente(servidor({ lancamento: { id: LANC, unidade: 'rioverde', valor: 1, status: 'cancelado' } })));
  const a2 = await k2.chamar('sistemas_preparar_anexo', { tabela: 'caixa_lanc', lancamento: LANC, tipo: 'recibo' });
  assert.ok(a2.erro && /cancelado/.test(a2.texto), a2.texto);
  const k3 = await cliente(ambiente(servidor({ lancamento: { id: LANC, unidade: 'Marabá-PA', valor: 1, anexo: 'fin-2026-10-27-bombeiro-itz' } })));
  const a3 = await k3.chamar('sistemas_preparar_anexo', { tabela: 'fin_lanc', lancamento: LANC, tipo: 'recibo' });
  assert.ok(a3.erro && /já tem anexo/.test(a3.texto), a3.texto);
  const k4 = await cliente(ambiente(servidor()));
  const a4 = await k4.chamar('sistemas_preparar_anexo', { tabela: 'caixa_lanc', lancamento: "x'; drop table caixa_docs; --".padEnd(36, 'x'), tipo: 'recibo' });
  assert.ok(a4.erro && /uuid/.test(a4.texto), a4.texto);
  const a5 = await k4.chamar('sistemas_preparar_anexo', { tabela: 'rh_usuarios', lancamento: LANC, tipo: 'recibo' });
  assert.ok(a5.erro, a5.texto);
});

test('o cofre aperta o envio do anexo: 10 min, só PDF/JPG/PNG, 15 MB; o link de arquivo_pedir_upload continua 30 min', async () => {
  const a = ambiente(servidor());
  try {
    const k = await cliente(a);
    const p = await pedirESubir(a, k, null);
    const token = p.linkDeEnvio.split('/').pop()!;
    // Word é recusado NESTE envio (e o link continua valendo: recusa não gasta)
    const r = a.cofre.reservar(token);
    assert.equal(await a.cofre.guardar(r, 'a.doc', DOC).catch((e: ErroDeCofre) => e.codigo), 'tipo');
    // 16 MB passa do teto deste envio (o geral é 20)
    const r2 = a.cofre.reservar(token);
    assert.equal(r2.tamanhoMaxBytes, 15 * 1024 * 1024);
    assert.equal(await a.cofre.guardar(r2, 'a.pdf', Buffer.concat([PDF, Buffer.alloc(16 * 1024 * 1024)])).catch((e: ErroDeCofre) => e.codigo), 'tamanho');
    // aos 10 min o link vence
    a.relogio.t += 10 * MIN + 1;
    assert.throws(() => a.cofre.reservar(token), (e: any) => e instanceof ErroDeCofre && e.codigo === 'expirado');
    // o pedido comum continua com 30 min
    const comum = a.cofre.pedirEnvio({ userId: QUEM.usuario, finalidade: 'contrato' });
    assert.equal(comum.validoAte - a.relogio.t, 30 * MIN);
    assert.equal(comum.tamanhoMaxBytes, 20 * 1024 * 1024);
  } finally { a.limpar(); }
});

// ── passo 2: anexar o que chegou ──────────────────────────────────────────────────────────────────────
test('anexar_envio: entrega ao servidor o arquivo, o destino do PEDIDO e quem pediu; depois apaga do cofre; uma vez só', async () => {
  const srv = servidor();
  const a = ambiente(srv);
  try {
    const k = await cliente(a);
    const p = await pedirESubir(a, k, PDF, 'Recibo Pix.pdf', { tipo: 'recibo' });
    const r = await k.chamar('sistemas_anexar_envio', { envio: p.envio });
    assert.equal(r.erro, false, r.texto);
    assert.equal(r.json.anexado, true); assert.equal(r.json.doc_id, 'doc-1'); assert.equal(r.json.arquivoApagadoDoCofre, true);
    assert.match(r.json.proximoPasso, /caixa_docs_prev/);
    const [c] = srv.anexos();
    assert.equal(c!.corpo.tabela, 'caixa_lanc'); assert.equal(c!.corpo.id, LANC); assert.equal(c!.corpo.tipo, 'recibo');
    assert.equal(c!.corpo.nome, 'Recibo-Pix.pdf'); // o nome passou pelo nomeSeguro do cofre
    assert.equal(c!.corpo.enviado_nome, 'Lia (pela Suzanne)'); assert.equal(c!.corpo.quem, 'suzanne@exemplo.com'); assert.equal(c!.corpo.origem, 'envio');
    assert.ok(Buffer.from(c!.corpo.conteudo_b64, 'base64').equals(PDF));
    assert.equal(c!.quem, 'suzanne@exemplo.com');
    // o cofre não guarda mais nada, e repetir não anexa de novo
    assert.equal(a.cofre.ver(QUEM.usuario, p.envio).estado, 'apagado');
    const de_novo = await k.chamar('sistemas_anexar_envio', { envio: p.envio });
    assert.ok(de_novo.erro && /apagado|não encontrado/.test(de_novo.texto), de_novo.texto);
    assert.equal(srv.anexos().length, 1);
  } finally { a.limpar(); }
});

test('anexar_envio: o arquivo ainda não chegou → diz isso e o link continua valendo', async () => {
  const srv = servidor();
  const a = ambiente(srv);
  try {
    const k = await cliente(a);
    const p = await pedirESubir(a, k, null);
    const r = await k.chamar('sistemas_anexar_envio', { envio: p.envio });
    assert.ok(r.erro && /ainda não chegou/.test(r.texto), r.texto);
    assert.equal(srv.anexos().length, 0);
    await a.cofre.guardar(a.cofre.reservar(p.linkDeEnvio.split('/').pop()!), 'x.png', PNG);
    assert.equal((await k.chamar('sistemas_anexar_envio', { envio: p.envio })).erro, false);
  } finally { a.limpar(); }
});

test('anexar_envio: envio sem destino (arquivo_pedir_upload) e envio de OUTRA pessoa não anexam nada', async () => {
  const srv = servidor();
  const a = ambiente(srv);
  try {
    const k = await cliente(a);
    const solto = a.cofre.pedirEnvio({ userId: QUEM.usuario, finalidade: 'contrato' });
    await a.cofre.guardar(a.cofre.reservar(solto.token), 'c.pdf', PDF);
    const r1 = await k.chamar('sistemas_anexar_envio', { envio: solto.id });
    assert.ok(r1.erro && /não foi pedido por sistemas_preparar_anexo/.test(r1.texto), r1.texto);
    const alheio = a.cofre.pedirEnvio({ userId: 'u-outra', finalidade: 'x', destino: { tipo: 'anexo-lancamento', sistema: 'hm-tecnologia', tabela: 'caixa_lanc', lancamento: LANC, tipoAnexo: 'recibo' } });
    await a.cofre.guardar(a.cofre.reservar(alheio.token), 'c.pdf', PDF);
    const r2 = await k.chamar('sistemas_anexar_envio', { envio: alheio.id });
    assert.ok(r2.erro && /não encontrado/.test(r2.texto), r2.texto);
    assert.equal(srv.anexos().length, 0);
    assert.equal(a.cofre.ver('u-outra', alheio.id).estado, 'recebido', 'o envio alheio continua intacto');
  } finally { a.limpar(); }
});

test('anexar_envio: servidor recusa (409) → o arquivo sai do cofre e a razão volta; sem resposta (500) → o arquivo FICA e o aviso é "não sei se gravou"', async () => {
  const recusado = servidor({ anexo: () => new ErroSistemas('esse mesmo arquivo já está anexado a esse lançamento', 409) });
  const a = ambiente(recusado);
  try {
    const k = await cliente(a);
    const p = await pedirESubir(a, k, PDF);
    const r = await k.chamar('sistemas_anexar_envio', { envio: p.envio });
    assert.ok(r.erro && /recusou o anexo.*já está anexado/.test(r.texto), r.texto);
    assert.equal(a.cofre.ver(QUEM.usuario, p.envio).estado, 'apagado');
  } finally { a.limpar(); }
  const incerto = servidor({ anexo: () => new ErroSistemas('o servidor respondeu com erro (HTTP 502)', 502) });
  const b = ambiente(incerto);
  try {
    const k = await cliente(b);
    const p = await pedirESubir(b, k, PDF);
    const r = await k.chamar('sistemas_anexar_envio', { envio: p.envio });
    assert.ok(r.erro && /NÃO sei se o anexo foi gravado/.test(r.texto), r.texto);
    assert.equal(b.cofre.ver(QUEM.usuario, p.envio).estado, 'recebido', 'dá para tentar de novo depois de conferir');
  } finally { b.limpar(); }
});

// ── passo 3: o servidor baixa ─────────────────────────────────────────────────────────────────────────
function baixa(corpo: Buffer, o: { host?: string; ct?: string; nome?: string } = {}) {
  const chamadas: string[] = [];
  return {
    chamadas,
    baixar: async (url: string) => {
      chamadas.push(url);
      return { bytes: corpo, host: o.host ?? 'recibo.infinitepay.io', contentType: o.ct ?? 'application/pdf', nomeSugerido: o.nome ?? 'comprovante-9f3a' };
    },
  };
}

test('anexar_url: PDF baixado vira anexo; o servidor recebe a origem (só o domínio); a auditoria guarda o domínio, não o endereço', async () => {
  const srv = servidor();
  const b = baixa(PDF);
  const a = ambiente(srv, { baixar: b.baixar as any });
  try {
    const k = await cliente(a);
    const r = await k.chamar('sistemas_anexar_url', { tabela: 'caixa_lanc', lancamento: LANC, tipo: 'comprovante', url: 'https://recibo.infinitepay.io/abc123SEGREDO' });
    assert.equal(r.erro, false, r.texto);
    const [c] = srv.anexos();
    assert.equal(c!.corpo.origem, 'url:recibo.infinitepay.io'); assert.equal(c!.corpo.nome, 'comprovante-9f3a.pdf');
    assert.ok(Buffer.from(c!.corpo.conteudo_b64, 'base64').equals(PDF));
    assert.deepEqual(a.auditoria.find((x) => x.ferramenta === 'sistemas_anexar_url')!.argumentos, { sistema: undefined, tabela: 'caixa_lanc', lancamento: LANC, tipo: 'comprovante', host: 'recibo.infinitepay.io' });
    assert.ok(!JSON.stringify(a.auditoria).includes('abc123SEGREDO'));
  } finally { a.limpar(); }
});

test('anexar_url: página HTML não vale (sem navegador) e explica o que fazer; nada é enviado ao servidor', async () => {
  const srv = servidor();
  const a = ambiente(srv, { baixar: baixa(HTML, { ct: 'text/html' }).baixar as any });
  try {
    const k = await cliente(a);
    const r = await k.chamar('sistemas_anexar_url', { tabela: 'caixa_lanc', lancamento: LANC, tipo: 'comprovante', url: 'https://recibo.infinitepay.io/abc' });
    assert.ok(r.erro && /PÁGINA da web.*não tem navegador.*sistemas_preparar_anexo/.test(r.texto), r.texto);
    assert.equal(srv.anexos().length, 0);
  } finally { a.limpar(); }
});

test('anexar_url: conferência do lançamento vem ANTES do download (lançamento inexistente não baixa nada)', async () => {
  const b = baixa(PDF);
  const a = ambiente(servidor({ lancamento: null }), { baixar: b.baixar as any });
  try {
    const k = await cliente(a);
    const r = await k.chamar('sistemas_anexar_url', { tabela: 'caixa_lanc', lancamento: LANC, tipo: 'comprovante', url: 'https://recibo.infinitepay.io/abc' });
    assert.ok(r.erro);
    assert.equal(b.chamadas.length, 0);
  } finally { a.limpar(); }
});

test('anexar_url com o downloader de verdade: domínio fora da lista e IP escrito na URL são recusados antes de qualquer rede', async () => {
  const a = ambiente(servidor());
  try {
    const k = await cliente(a);
    for (const url of ['https://evil.example.com/a.pdf', 'https://169.254.169.254/latest/meta-data', 'http://recibo.infinitepay.io/a.pdf', 'https://api-rh:8080/admin/v1/esquema', 'https://recibo.infinitepay.io.evil.com/a.pdf']) {
      const r = await k.chamar('sistemas_anexar_url', { tabela: 'caixa_lanc', lancamento: LANC, tipo: 'comprovante', url });
      assert.ok(r.erro, url);
      assert.ok(a.srv.anexos().length === 0, url);
    }
  } finally { a.limpar(); }
});

// ── o downloader: SSRF ────────────────────────────────────────────────────────────────────────────────
test('hostPermitido: curinga só cobre subdomínio; parecido não passa', () => {
  const l = ['recibo.infinitepay.io', 'asaas.com', '*.asaas.com'];
  for (const h of ['recibo.infinitepay.io', 'asaas.com', 'www.asaas.com', 'a.b.asaas.com', 'ASAAS.COM', 'www.asaas.com.']) assert.ok(hostPermitido(h, l), h);
  for (const h of ['infinitepay.io', 'evilasaas.com', 'asaas.com.evil.com', 'xrecibo.infinitepay.io', 'recibo.infinitepay.io.evil.com', 'localhost', '']) assert.ok(!hostPermitido(h, l), h);
});

test('dominiosPermitidos: o padrão mais o que o João liberar na variável; lixo na variável é ignorado', () => {
  assert.deepEqual(dominiosPermitidos({}), [...DOMINIOS_PADRAO]);
  const l = dominiosPermitidos({ ANEXO_URL_DOMINIOS: 'boleto.banco.com.br, *.sicoob.com.br, localhost, 10.0.0.1, http://x.com, ' });
  assert.ok(l.includes('boleto.banco.com.br') && l.includes('*.sicoob.com.br'));
  assert.ok(!l.includes('localhost') && !l.includes('10.0.0.1') && !l.some((d) => d.includes('http')));
});

test('ipPrivado: tudo o que não é internet pública', () => {
  const privados = ['10.0.0.1', '10.255.255.255', '127.0.0.1', '127.1.2.3', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.0.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.0.8', '198.18.0.1',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a00:1', '2002:a00:1::', '2001:db8::1', 'não é ip', '1.2.3', '999.1.1.1'];
  for (const ip of privados) assert.ok(ipPrivado(ip), ip);
  const publicos = ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '104.18.0.1', '2606:4700::1111', '2a00:1450:4001::200e'];
  for (const ip of publicos) assert.ok(!ipPrivado(ip), ip);
});

function resposta(status: number, o: { headers?: Record<string, string>; corpo?: Buffer } = {}): Resposta {
  return {
    status,
    headers: o.headers ?? {},
    corpo: async (max) => {
      if ((o.corpo?.length ?? 0) > max) throw new Error('grande');
      return o.corpo ?? Buffer.alloc(0);
    },
    descartar: () => undefined,
  };
}
const PUBLICO = async () => ['104.18.1.1'];

test('baixarUrl: segue redirect dentro da lista, recusa redirect para fora da lista e para IP interno, e limita os saltos', async () => {
  const vistos: string[] = [];
  const req: Requisitar = async (u) => {
    vistos.push(u.toString());
    if (u.hostname === 'recibo.infinitepay.io') return resposta(302, { headers: { location: 'https://www.asaas.com/b/pdf/xyz' } });
    if (u.hostname === 'www.asaas.com') return resposta(200, { headers: { 'content-type': 'application/pdf' }, corpo: PDF });
    throw new Error(`não devia chamar ${u}`);
  };
  const ok = await baixarUrl('https://recibo.infinitepay.io/r/1', { dominios: DOMINIOS_PADRAO, resolver: PUBLICO, requisitar: req });
  assert.equal(ok.host, 'www.asaas.com'); assert.ok(ok.bytes.equals(PDF)); assert.equal(ok.nomeSugerido, 'xyz');

  for (const destino of ['https://infinitepay.io/', 'https://evil.com/x', 'http://www.asaas.com/x', 'https://169.254.169.254/', 'https://www.asaas.com:8443/x', 'https://u:p@www.asaas.com/x']) {
    vistos.length = 0;
    const r: Requisitar = async (u) => (u.hostname === 'recibo.infinitepay.io' ? resposta(301, { headers: { location: destino } }) : (vistos.push(u.toString()), resposta(200, { corpo: PDF })));
    await assert.rejects(baixarUrl('https://recibo.infinitepay.io/r/1', { dominios: DOMINIOS_PADRAO, resolver: PUBLICO, requisitar: r }), /./, destino);
    assert.deepEqual(vistos, [], `${destino}: não pode nem conectar`);
  }
  const loop: Requisitar = async () => resposta(302, { headers: { location: 'https://www.asaas.com/x' } });
  await assert.rejects(baixarUrl('https://www.asaas.com/x', { dominios: DOMINIOS_PADRAO, resolver: PUBLICO, requisitar: loop }), /redirecionamentos demais/);
});

test('baixarUrl: nome que resolve para IP interno (mesmo que só um dos endereços) é recusado sem conectar', async () => {
  let conectou = 0;
  const req: Requisitar = async () => (conectou++, resposta(200, { corpo: PDF }));
  for (const ips of [['10.0.0.5'], ['127.0.0.1'], ['104.18.1.1', '169.254.169.254'], ['::1'], ['::ffff:192.168.0.1'], []]) {
    await assert.rejects(baixarUrl('https://www.asaas.com/x', { dominios: DOMINIOS_PADRAO, resolver: async () => ips, requisitar: req }), /interno|encontrar/, ips.join());
  }
  assert.equal(conectou, 0);
});

test('baixarUrl: conecta no IP que foi verificado (o mesmo que a checagem viu)', async () => {
  let ipUsado = '';
  const req: Requisitar = async (_u, ip) => ((ipUsado = ip), resposta(200, { corpo: PDF }));
  await baixarUrl('https://www.asaas.com/x', { dominios: DOMINIOS_PADRAO, resolver: async () => ['104.18.9.9', '104.18.9.10'], requisitar: req });
  assert.equal(ipUsado, '104.18.9.9');
});

test('baixarUrl: tamanho (Content-Length e corpo sem Content-Length), status que não é 200 e tempo', async () => {
  const dom = DOMINIOS_PADRAO;
  await assert.rejects(baixarUrl('https://www.asaas.com/x', { dominios: dom, resolver: PUBLICO, maxBytes: 100, requisitar: async () => resposta(200, { headers: { 'content-length': '101' }, corpo: Buffer.alloc(0) }) }), /limite de/);
  await assert.rejects(baixarUrl('https://www.asaas.com/x', { dominios: dom, resolver: PUBLICO, maxBytes: 100, requisitar: async () => resposta(200, { corpo: Buffer.alloc(101) }) }), /./);
  await assert.rejects(baixarUrl('https://www.asaas.com/x', { dominios: dom, resolver: PUBLICO, requisitar: async () => resposta(404) }), /respondeu 404/);
  await assert.rejects(baixarUrl('https://www.asaas.com/x', { dominios: dom, resolver: PUBLICO, requisitar: async () => resposta(403) }), /respondeu 403/);
  let t = 0;
  await assert.rejects(baixarUrl('https://www.asaas.com/x', { dominios: dom, resolver: async () => ((t += 60_000), ['104.18.1.1']), agora: () => t, tempoTotalMs: 25_000, requisitar: async () => resposta(200, { corpo: PDF }) }), /demorou demais/);
});

test('baixarUrl: o pedido não leva cookie nem Authorization, e a resposta não é descomprimida (conferido na função que faz o pedido real)', () => {
  const fonte = readFileSync(new URL('./baixar-url.ts', import.meta.url), 'utf8');
  assert.match(fonte, /'Accept-Encoding': 'identity'/);
  assert.ok(!/Authorization|Cookie/.test(fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'nenhum cabeçalho de credencial');
  assert.match(fonte, /servername: u\.hostname/);
});

// ── achados da revisão ────────────────────────────────────────────────────────────────────────────────
test('anexar_envio duas vezes ao mesmo tempo (retry/paralelo): UMA entrega ao servidor; a outra é recusada; incerteza devolve o arquivo para nova tentativa', async () => {
  let solta!: () => void;
  const segura = new Promise<void>((r) => (solta = r));
  let n = 0;
  const srv = servidor({ anexo: () => ((n++), { ok: true, doc_id: `doc-${n}`, caminho: 'x', paginas: 1, previas: 1 }) });
  // o servidor demora: as duas chamadas se sobrepõem
  const original = srv.ctx.contas.get('hm-tecnologia')!.fonte.chamar.bind(srv.ctx.contas.get('hm-tecnologia')!.fonte);
  srv.ctx.contas.get('hm-tecnologia')!.fonte.chamar = async (m, c, o) => {
    if (c === '/admin/v1/anexo') await segura;
    return original(m, c, o);
  };
  const a = ambiente(srv);
  try {
    const k = await cliente(a);
    const p = await pedirESubir(a, k, PDF);
    const primeira = k.chamar('sistemas_anexar_envio', { envio: p.envio });
    await new Promise((r) => setTimeout(r, 20));
    const segunda = await k.chamar('sistemas_anexar_envio', { envio: p.envio });
    assert.ok(segunda.erro && /já está sendo entregue/.test(segunda.texto), segunda.texto);
    solta();
    assert.equal((await primeira).erro, false);
    assert.equal(n, 1, 'o servidor recebeu UMA entrega');
  } finally { a.limpar(); }
  // sem resposta do servidor: o arquivo volta a ficar disponível e a nova tentativa funciona
  let tentativa = 0;
  const srv2 = servidor({ anexo: () => (++tentativa === 1 ? new ErroSistemas('sem resposta', null) : { ok: true, doc_id: 'doc-9', caminho: 'x', paginas: 1, previas: 1 }) });
  const b = ambiente(srv2);
  try {
    const k = await cliente(b);
    const p = await pedirESubir(b, k, PDF);
    assert.ok((await k.chamar('sistemas_anexar_envio', { envio: p.envio })).erro);
    assert.equal((await k.chamar('sistemas_anexar_envio', { envio: p.envio })).erro, false);
  } finally { b.limpar(); }
});

test('um envio de anexo não vira link de download (nem pelas ferramentas do cofre) e destino incompleto é recusado', async () => {
  const a = ambiente(servidor());
  try {
    const k = await cliente(a);
    const p = await pedirESubir(a, k, PDF);
    assert.throws(() => a.cofre.gerarLink(QUEM.usuario, p.envio, 10), (e: any) => e instanceof ErroDeCofre && /só segue para o sistema/.test(e.message));
    const torto = a.cofre.pedirEnvio({ userId: QUEM.usuario, finalidade: 'x', destino: { tipo: 'anexo-lancamento', tabela: 'rh_usuarios', lancamento: LANC, tipoAnexo: 'recibo', sistema: 'hm-tecnologia' } });
    await a.cofre.guardar(a.cofre.reservar(torto.token), 'c.pdf', PDF);
    const r = await k.chamar('sistemas_anexar_envio', { envio: torto.id });
    assert.ok(r.erro && /incompleto/.test(r.texto), r.texto);
    assert.equal(a.srv.anexos().length, 0);
  } finally { a.limpar(); }
});

test('nome do arquivo vindo da URL: sem pasta, sem ponto-ponto, sem caractere de controle', async () => {
  assert.equal(nomeLimpo('../../x.pdf'), 'x.pdf');
  assert.equal(nomeLimpo('a\\b\\c.pdf'), 'c.pdf');
  assert.equal(nomeLimpo('rec\u0000ibo\n.pdf'), 'recibo.pdf');
  assert.equal(nomeLimpo('a..b.pdf'), 'a.b.pdf');
  const srv = servidor();
  const a = ambiente(srv, { baixar: baixa(PDF, { nome: '../../etc/x.pdf' }).baixar as any });
  try {
    const k = await cliente(a);
    assert.equal((await k.chamar('sistemas_anexar_url', { tabela: 'caixa_lanc', lancamento: LANC, tipo: 'comprovante', url: 'https://recibo.infinitepay.io/a' })).erro, false);
    assert.equal(srv.anexos()[0]!.corpo.nome, 'x.pdf');
  } finally { a.limpar(); }
});

test('baixarUrl: IPv4 primeiro; se a conexão falha tenta o próximo endereço JÁ verificado; todos falham → erro', async () => {
  const tentados: string[] = [];
  const req: Requisitar = async (_u, ip) => {
    tentados.push(ip);
    if (ip === '104.18.1.1') throw new Error('ECONNREFUSED');
    return resposta(200, { corpo: PDF });
  };
  const ok = await baixarUrl('https://www.asaas.com/x', { dominios: DOMINIOS_PADRAO, resolver: async () => ['2606:4700::1111', '104.18.1.1', '104.18.1.2'], requisitar: req });
  assert.ok(ok.bytes.equals(PDF));
  assert.deepEqual(tentados, ['104.18.1.1', '104.18.1.2'], 'IPv4 antes do IPv6; o que falhou não bloqueia o resto');
  await assert.rejects(baixarUrl('https://www.asaas.com/x', { dominios: DOMINIOS_PADRAO, resolver: PUBLICO, requisitar: async () => { throw new Error('ENETUNREACH'); } }), /não consegui baixar/);
});

// ── revisão do sênior ─────────────────────────────────────────────────────────────────────────────────
test('404 do servidor = DESATUALIZADO, não recusa: o arquivo FICA no cofre, nada é apagado e a mensagem diz o que fazer; depois de atualizar, a mesma entrega funciona', async () => {
  let atualizado = false;
  const srv = servidor({ anexo: () => (atualizado ? { ok: true, doc_id: 'doc-1', caminho: 'x', paginas: 1, previas: 1 } : new ErroSistemas('nao_encontrado', 404)) });
  const a = ambiente(srv);
  try {
    const k = await cliente(a);
    const p = await pedirESubir(a, k, PDF);
    const r = await k.chamar('sistemas_anexar_envio', { envio: p.envio });
    assert.ok(r.erro && /DESATUALIZADO.*0\.1\.10\.3.*continua guardado no cofre/.test(r.texto), r.texto);
    assert.equal(a.cofre.ver(QUEM.usuario, p.envio).estado, 'recebido', 'o arquivo não foi apagado');
    atualizado = true;
    assert.equal((await k.chamar('sistemas_anexar_envio', { envio: p.envio })).erro, false);
  } finally { a.limpar(); }
});

test('sem nome_arquivo o comando curl leva o nome SEM extensão: um PNG/JPG no envio não é recusado por "comprovante.pdf"', async () => {
  const a = ambiente(servidor());
  try {
    const k = await cliente(a);
    const p = await k.chamar('sistemas_preparar_anexo', { tabela: 'caixa_lanc', lancamento: LANC, tipo: 'nota_fiscal' });
    assert.match(p.json.comandoCurl, /X-Nome-Arquivo: nota_fiscal'/);
    assert.ok(!/X-Nome-Arquivo: [^']*\./.test(p.json.comandoCurl));
    // e é isso que o cofre recebe: PNG com esse nome entra, o link NÃO é queimado
    const token = String(p.json.linkDeEnvio).split('/').pop()!;
    const g = await a.cofre.guardar(a.cofre.reservar(token), 'nota_fiscal', PNG);
    assert.equal(g.tipo, 'png');
    assert.equal(g.nome, 'nota_fiscal.png');
  } finally { a.limpar(); }
});

test('anexar_url: a extensão vem do CONTEÚDO, não do endereço (recibo.png que entrega PDF vira recibo.pdf)', async () => {
  const srv = servidor();
  const a = ambiente(srv, { baixar: baixa(PDF, { nome: 'recibo.png' }).baixar as any });
  try {
    const k = await cliente(a);
    assert.equal((await k.chamar('sistemas_anexar_url', { tabela: 'caixa_lanc', lancamento: LANC, tipo: 'recibo', url: 'https://www.asaas.com/recibo.png' })).erro, false);
    assert.equal(srv.anexos()[0]!.corpo.nome, 'recibo.pdf');
  } finally { a.limpar(); }
  const srv2 = servidor();
  const b = ambiente(srv2, { baixar: baixa(PNG, { nome: 'recibo.pdf' }).baixar as any });
  try {
    const k = await cliente(b);
    assert.equal((await k.chamar('sistemas_anexar_url', { tabela: 'caixa_lanc', lancamento: LANC, tipo: 'recibo', url: 'https://www.asaas.com/recibo.pdf' })).erro, false);
    assert.equal(srv2.anexos()[0]!.corpo.nome, 'recibo.png');
  } finally { b.limpar(); }
});
