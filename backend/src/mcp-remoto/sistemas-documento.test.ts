import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErroSistemas } from '../lib/integracoes/sistemas.js';
import { DOMINIOS_PADRAO } from './baixar-url.js';
import { CofreDeArquivos, ErroDeCofre } from './cofre-arquivos.js';
import { criarContextoSistemas, type ContaSistemas } from './sistemas.js';
import { registrarAnexosSistemas, type DepsAnexo } from './sistemas-anexo.js';
import { destinoDocumentoConferido } from './sistemas-documento.js';

// ── amostras ──────────────────────────────────────────────────────────────────────────────────────────
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const PK = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const DOCX = Buffer.concat([PK, Buffer.from('[Content_Types].xml word/document.xml')]);
const XLSX = Buffer.concat([PK, Buffer.from('[Content_Types].xml xl/workbook.xml')]);
const MACRO = Buffer.concat([PK, Buffer.from('[Content_Types].xml word/document.xml word/vbaProject.bin')]);

const COLAB = '5fb77551-7bba-43c4-9a5f-84e69d99caf2';
const QUEM = { usuario: 'u-suzanne', nome: 'suzanne@exemplo.com' };
const BASE = 'https://agente-vps.exemplo.com.br';
const MIN = 60_000;

// ── o servidor do sistema, de mentira ─────────────────────────────────────────────────────────────────
interface Chamada { metodo: string; caminho: string; corpo: any; quem?: string }
function servidor(o: { conferir?: (corpo: any) => unknown; documento?: (corpo: any) => unknown } = {}) {
  const chamadas: Chamada[] = [];
  const conta: ContaSistemas = {
    slug: 'hm-tecnologia',
    nome: 'HM',
    fonte: {
      async chamar(metodo, caminho, op) {
        chamadas.push({ metodo, caminho, corpo: op?.corpo, quem: op?.quem });
        if (caminho === '/admin/v1/documento/conferir') {
          const corpo = op?.corpo as any;
          const r = o.conferir ? o.conferir(corpo) : { ok: true, destino: corpo?.destino, alvo: { colaborador: 'Maria da Silva', unidade: 'DH - Marabá', cargo: 'Fisioterapeuta', documentos_na_pasta: 3 } };
          if (r instanceof Error) throw r;
          return r;
        }
        if (caminho === '/admin/v1/documento') {
          const r = o.documento ? o.documento(op?.corpo) : { ok: true, conferido: true, destino: (op?.corpo as any)?.destino, bucket: 'rh-docs', caminho: `colaboradores/${COLAB}/u-aso.pdf`, tamanho: 10 };
          if (r instanceof Error) throw r;
          return r;
        }
        throw new Error(`rota inesperada ${caminho}`);
      },
    },
  };
  return { chamadas, ctx: criarContextoSistemas(new Map([[conta.slug, conta]])), conferencias: () => chamadas.filter((c) => c.caminho === '/admin/v1/documento/conferir'), entregas: () => chamadas.filter((c) => c.caminho === '/admin/v1/documento') };
}

function ambiente(srv: ReturnType<typeof servidor>, extra: Partial<DepsAnexo> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'documento-teste-'));
  const relogio = { t: Date.parse('2026-11-04T10:00:00-03:00') };
  const cofre = new CofreDeArquivos({ dir: path.join(dir, 'cofre'), agora: () => relogio.t });
  const auditoria: Array<{ ferramenta: string; argumentos: any; ok: boolean; erro?: string }> = [];
  const deps: DepsAnexo = { cofre, baseUrl: () => BASE, dominios: DOMINIOS_PADRAO, ...extra };
  return { cofre, relogio, auditoria, deps, dir, limpar: () => rmSync(dir, { recursive: true, force: true }), srv };
}

async function cliente(a: ReturnType<typeof ambiente>, quem = QUEM) {
  const server = new McpServer({ name: 't', version: '1' });
  registrarAnexosSistemas(server, a.srv.ctx, quem, a.deps, (r) => a.auditoria.push(r as any));
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

const colab = (extra: Record<string, unknown> = {}) => ({ destino: 'rh_colaborador', id: COLAB, tipo_documento: 'ASO admissional', ...extra });

/** pede o link como a Lia e "envia" como a página/curl (reservar + guardar) */
async function pedirESubir(a: ReturnType<typeof ambiente>, k: Awaited<ReturnType<typeof cliente>>, conteudo: Buffer | null, nome = 'aso.pdf', args: Record<string, unknown> = colab()) {
  const p = await k.chamar('sistemas_preparar_documento', args);
  assert.equal(p.erro, false, p.texto);
  if (conteudo) {
    const token = String(p.json.linkDeEnvio).split('/').pop()!;
    await a.cofre.guardar(a.cofre.reservar(token), nome, conteudo);
  }
  return p.json as { envio: string; linkDeEnvio: string };
}

// ── o portão ──────────────────────────────────────────────────────────────────────────────────────────
test('portão: sistemas_preparar_documento sai de registrarAnexosSistemas, que só roda no bloco de quem escreve (producao.ts)', async () => {
  const prod = readFileSync(new URL('./producao.ts', import.meta.url), 'utf8');
  const chamada = prod.indexOf('registrarAnexosSistemas(');
  const bloco = prod.indexOf('if (escritores.has(quem.userId)) {');
  const proximo = prod.indexOf('if (leitoresWhatsapp.has(quem.userId))');
  assert.ok(bloco > 0 && chamada > bloco && chamada < proximo);
  const a = ambiente(servidor());
  try {
    const server = new McpServer({ name: 't', version: '1' });
    registrarAnexosSistemas(server, a.srv.ctx, QUEM, a.deps, () => {});
    const [x, y] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'c', version: '1' });
    await Promise.all([server.connect(x), c.connect(y)]);
    const nomes = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(nomes.includes('sistemas_preparar_documento'));
    assert.ok(nomes.includes('sistemas_anexar_envio'));
  } finally { a.limpar(); }
});

// ── passo 1 ───────────────────────────────────────────────────────────────────────────────────────────
test('preparar_documento: o servidor diz QUEM é o destino, sai um link de 10 min (RH aceita DOCX/XLSX), e nada é gravado', async () => {
  const a = ambiente(servidor());
  try {
    const k = await cliente(a);
    const r = await k.chamar('sistemas_preparar_documento', colab({ validade: '2027-01-10', precisa_assinatura: true, nome_arquivo: 'ASO Maria.pdf' }));
    assert.equal(r.erro, false, r.texto);
    assert.match(r.json.linkDeEnvio, new RegExp(`^${BASE}/arquivos/enviar/[A-Za-z0-9_-]{43}$`));
    assert.equal(r.json.validoMinutos, 10);
    assert.deepEqual(r.json.aceita, ['pdf', 'jpg', 'png', 'docx', 'xlsx']);
    assert.equal(r.json.destino.quemE.colaborador, 'Maria da Silva');
    assert.equal(r.json.destino.tipo, 'rh_colaborador');
    assert.equal(r.json.destino.precisaAssinatura, true);
    assert.match(r.json.comandoCurl, /X-Nome-Arquivo: ASO-Maria\.pdf/);
    assert.match(r.json.proximoPasso, /QUEM é o destino/);
    // a conferência foi ao servidor com o destino, o tipo, o nome e QUEM pediu — e nenhum arquivo
    const [conf] = a.srv.conferencias();
    assert.equal(conf!.corpo.destino, 'rh_colaborador');
    assert.equal(conf!.corpo.id, COLAB);
    assert.equal(conf!.corpo.tipo_documento, 'ASO admissional');
    assert.equal(conf!.corpo.validade, '2027-01-10');
    assert.equal(conf!.corpo.precisa_assinatura, true);
    assert.equal(conf!.corpo.quem, QUEM.nome);
    assert.equal(conf!.corpo.conteudo_b64, undefined);
    assert.equal(a.srv.entregas().length, 0, 'preparar não grava');
    // a auditoria do conector não leva o link nem o nome do arquivo
    assert.ok(!JSON.stringify(a.auditoria).includes('/arquivos/enviar/'));
    assert.ok(!JSON.stringify(a.auditoria).includes('ASO Maria'));
    assert.equal(a.auditoria.find((x) => x.ferramenta === 'sistemas_preparar_documento')!.argumentos.id, COLAB);
  } finally { a.limpar(); }
});

test('preparar_documento: Caixa só PDF/JPG/PNG e exige tratamento + tipo da lista; cliente_dd é sempre "contrato"', async () => {
  const a = ambiente(servidor());
  try {
    const k = await cliente(a);
    const cx = await k.chamar('sistemas_preparar_documento', { destino: 'caixa_paciente', trat_ref: 'crm:araguaina:126730', tipo_documento: 'contrato' });
    assert.equal(cx.erro, false, cx.texto);
    assert.deepEqual(cx.json.aceita, ['pdf', 'jpg', 'png']);
    const token = String(cx.json.linkDeEnvio).split('/').pop()!;
    assert.equal(await a.cofre.guardar(a.cofre.reservar(token), 'a.docx', DOCX).catch((e: ErroDeCofre) => e.codigo), 'tipo', 'DOCX não entra no Caixa');
    assert.equal(a.srv.conferencias()[0]!.corpo.trat_ref, 'crm:araguaina:126730');
    assert.equal(a.srv.conferencias()[0]!.corpo.id, undefined);

    const semRef = await k.chamar('sistemas_preparar_documento', { destino: 'caixa_paciente', tipo_documento: 'contrato' });
    assert.ok(semRef.erro && /trat_ref/.test(semRef.texto), semRef.texto);
    const tipoRuim = await k.chamar('sistemas_preparar_documento', { destino: 'caixa_paciente', trat_ref: 'x', tipo_documento: 'selfie' });
    assert.ok(tipoRuim.erro && /tipo_documento do Caixa/.test(tipoRuim.texto), tipoRuim.texto);

    const cli = await k.chamar('sistemas_preparar_documento', { destino: 'cliente_dd', id: 'imp-abc123', tipo_documento: 'qualquer coisa' });
    assert.equal(cli.erro, false, cli.texto);
    assert.equal(a.srv.conferencias().at(-1)!.corpo.tipo_documento, 'contrato');
  } finally { a.limpar(); }
});

test('preparar_documento: entrada ruim é recusada ANTES de falar com o servidor (id com ../, sem tipo, validade, assinatura fora do colaborador, destino fora da lista)', async () => {
  const a = ambiente(servidor());
  try {
    const k = await cliente(a);
    for (const [args, rx] of [
      [colab({ id: '../../etc' }), /id do registro/],
      [colab({ id: undefined }), /id do registro/],
      [colab({ tipo_documento: '' }), /tipo do documento/],
      [colab({ validade: '10/01/2027' }), /validade/],
      [{ destino: 'rh_empresa', id: COLAB, tipo_documento: 'Alvará', precisa_assinatura: true }, /só vale para documento de colaborador/],
      [{ destino: 'cliente_dd', id: COLAB, validade: '2027-01-10' }, /validade/],
    ] as const) {
      const r = await k.chamar('sistemas_preparar_documento', args as any);
      assert.ok(r.erro && rx.test(r.texto), `${JSON.stringify(args)} → ${r.texto}`);
    }
    const fora = await k.chamar('sistemas_preparar_documento', { destino: 'rh_usuarios', id: COLAB, tipo_documento: 'x' });
    assert.ok(fora.erro, fora.texto);
    assert.equal(a.srv.chamadas.length, 0, 'nada chegou ao servidor');
  } finally { a.limpar(); }
});

test('preparar_documento: registro que não existe / cliente que já tem contrato → recusa do servidor, e NENHUM link é gasto', async () => {
  let recusar = true;
  const a = ambiente(servidor({ conferir: (c) => (recusar ? new ErroSistemas('não achei o registro x (colaboradores)', 404) : { ok: true, destino: c.destino, alvo: { colaborador: 'Maria' } }) }));
  try {
    const k = await cliente(a);
    for (let i = 0; i < 7; i++) {
      const r = await k.chamar('sistemas_preparar_documento', colab());
      assert.ok(r.erro && /não achei o registro/.test(r.texto), r.texto);
    }
    // o limite de envios vivos por pessoa é 5: se alguma recusa tivesse gasto um, estes 5 sucessos não caberiam
    recusar = false;
    for (let i = 0; i < 5; i++) assert.equal((await k.chamar('sistemas_preparar_documento', colab())).erro, false);
    assert.equal(a.srv.entregas().length, 0);
  } finally { a.limpar(); }
});

test('preparar_documento: servidor em versão antiga (rota sem resposta no contrato) → não gera link', async () => {
  const a = ambiente(servidor({ conferir: () => ({ ok: true }) }));
  try {
    const k = await cliente(a);
    const r = await k.chamar('sistemas_preparar_documento', colab());
    assert.ok(r.erro && /não confirmou o destino/.test(r.texto), r.texto);
  } finally { a.limpar(); }
});

// ── passo 2 ───────────────────────────────────────────────────────────────────────────────────────────
test('fluxo completo: preparar → subir DOCX → sistemas_anexar_envio entrega ao servidor com o destino DO PEDIDO e apaga do cofre', async () => {
  const a = ambiente(servidor());
  try {
    const k = await cliente(a);
    const p = await pedirESubir(a, k, DOCX, 'Ficha Maria.docx', colab({ validade: '2027-01-10' }));
    assert.equal(a.cofre.ver(QUEM.usuario, p.envio).estado, 'recebido');
    const r = await k.chamar('sistemas_anexar_envio', { envio: p.envio });
    assert.equal(r.erro, false, r.texto);
    assert.equal(r.json.anexado, true);
    assert.equal(r.json.arquivoApagadoDoCofre, true);
    assert.match(r.json.proximoPasso, /pasta do colaborador/);
    const [e] = a.srv.entregas();
    assert.equal(e!.corpo.destino, 'rh_colaborador');
    assert.equal(e!.corpo.id, COLAB);
    assert.equal(e!.corpo.tipo_documento, 'ASO admissional');
    assert.equal(e!.corpo.validade, '2027-01-10');
    assert.equal(e!.corpo.quem, QUEM.nome);
    assert.equal(e!.corpo.enviado_nome, 'Lia (pela Suzanne)');
    assert.equal(e!.corpo.origem, 'envio');
    assert.match(e!.corpo.nome, /\.docx$/);
    assert.deepEqual(Buffer.from(e!.corpo.conteudo_b64, 'base64'), DOCX, 'os bytes são os que a pessoa enviou');
    assert.equal(a.cofre.ver(QUEM.usuario, p.envio).estado, 'apagado');
    // uma segunda vez não anexa de novo
    const de_novo = await k.chamar('sistemas_anexar_envio', { envio: p.envio });
    assert.ok(de_novo.erro, de_novo.texto);
    assert.equal(a.srv.entregas().length, 1);
  } finally { a.limpar(); }
});

test('o destino é o do pedido: o envio de outra pessoa não é lido, e arquivo que ainda não chegou diz isso sem tocar no servidor', async () => {
  const a = ambiente(servidor());
  try {
    const k = await cliente(a);
    const p = await pedirESubir(a, k, null);
    const cedo = await k.chamar('sistemas_anexar_envio', { envio: p.envio });
    assert.ok(cedo.erro && /ainda não chegou/.test(cedo.texto), cedo.texto);
    assert.equal(a.srv.entregas().length, 0);
    const token = p.linkDeEnvio.split('/').pop()!;
    await a.cofre.guardar(a.cofre.reservar(token), 'aso.pdf', PDF);
    const outra = await cliente(a, { usuario: 'u-outra', nome: 'outra@exemplo.com' });
    const r = await outra.chamar('sistemas_anexar_envio', { envio: p.envio });
    assert.ok(r.erro && /não encontrado/i.test(r.texto), r.texto);
    assert.equal(a.srv.entregas().length, 0);
  } finally { a.limpar(); }
});

test('envio comum (arquivo_pedir_upload) NÃO serve para documento: sem destino de documento a entrega recusa, e planilha .xlsx não entra no envio comum', async () => {
  const a = ambiente(servidor());
  try {
    const k = await cliente(a);
    const comum = a.cofre.pedirEnvio({ userId: QUEM.usuario, finalidade: 'contrato para o ClickSign' });
    await a.cofre.guardar(a.cofre.reservar(comum.token), 'c.pdf', PDF);
    const r = await k.chamar('sistemas_anexar_envio', { envio: comum.id });
    assert.ok(r.erro, r.texto);
    assert.equal(a.srv.entregas().length, 0);
    // xlsx: só entra quando o pedido a lista
    const outro = a.cofre.pedirEnvio({ userId: QUEM.usuario, finalidade: 'planilha' });
    assert.equal(await a.cofre.guardar(a.cofre.reservar(outro.token), 'p.xlsx', XLSX).catch((e: ErroDeCofre) => e.codigo), 'tipo');
    const p = await pedirESubir(a, k, XLSX, 'folha.xlsx');
    assert.equal(a.cofre.ver(QUEM.usuario, p.envio).arquivo!.tipo.includes('spreadsheetml'), true);
    // macro nunca
    const m = await k.chamar('sistemas_preparar_documento', colab());
    const token = String(m.json.linkDeEnvio).split('/').pop()!;
    assert.equal(await a.cofre.guardar(a.cofre.reservar(token), 'm.docx', MACRO).catch((e: ErroDeCofre) => e.codigo), 'tipo');
  } finally { a.limpar(); }
});

test('o servidor recusou na entrega (ex.: arquivo repetido, 409): erro claro e o arquivo SAI do cofre (resposta definitiva)', async () => {
  const a = ambiente(servidor({ documento: () => new ErroSistemas('esse mesmo arquivo (mesmo conteúdo) já está na pasta desse registro', 409) }));
  try {
    const k = await cliente(a);
    const p = await pedirESubir(a, k, PDF);
    const r = await k.chamar('sistemas_anexar_envio', { envio: p.envio });
    assert.ok(r.erro && /recusou o documento.*já está na pasta/.test(r.texto), r.texto);
    assert.equal(a.cofre.ver(QUEM.usuario, p.envio).estado, 'apagado');
  } finally { a.limpar(); }
});

test('sem resposta do servidor (rede/500): "NÃO sei se gravou", o arquivo FICA no cofre e dá para tentar de novo depois de conferir', async () => {
  let n = 0;
  const a = ambiente(servidor({ documento: () => (++n === 1 ? new ErroSistemas('não consegui falar com o servidor do sistema novo', null) : { ok: true, conferido: true, destino: 'rh_colaborador', caminho: 'colaboradores/x/y.pdf' }) }));
  try {
    const k = await cliente(a);
    const p = await pedirESubir(a, k, PDF);
    const r1 = await k.chamar('sistemas_anexar_envio', { envio: p.envio });
    assert.ok(r1.erro && /NÃO sei se o documento foi gravado/.test(r1.texto), r1.texto);
    assert.equal(a.cofre.ver(QUEM.usuario, p.envio).estado, 'recebido', 'o arquivo continua guardado');
    const r2 = await k.chamar('sistemas_anexar_envio', { envio: p.envio });
    assert.equal(r2.erro, false, r2.texto);
    assert.equal(a.cofre.ver(QUEM.usuario, p.envio).estado, 'apagado');
  } finally { a.limpar(); }
});

test('duas entregas ao mesmo tempo do mesmo envio: o servidor recebe UMA só', async () => {
  let libera!: () => void;
  const trava = new Promise<void>((ok) => { libera = ok; });
  const srv = servidor();
  const original = srv.ctx.contas.get('hm-tecnologia')!.fonte.chamar.bind(srv.ctx.contas.get('hm-tecnologia')!.fonte);
  srv.ctx.contas.get('hm-tecnologia')!.fonte.chamar = async (m, c, o) => {
    if (c === '/admin/v1/documento') await trava;
    return original(m, c, o);
  };
  const a = ambiente(srv);
  try {
    const k = await cliente(a);
    const p = await pedirESubir(a, k, PDF);
    const um = k.chamar('sistemas_anexar_envio', { envio: p.envio });
    const dois = await k.chamar('sistemas_anexar_envio', { envio: p.envio });
    assert.ok(dois.erro && /já está sendo entregue/.test(dois.texto), dois.texto);
    libera();
    assert.equal((await um).erro, false);
    assert.equal(srv.entregas().length, 1);
  } finally { a.limpar(); }
});

test('envio que venceu (10 min sem o arquivo) não anexa nada', async () => {
  const a = ambiente(servidor());
  try {
    const k = await cliente(a);
    const p = await pedirESubir(a, k, null);
    a.relogio.t += 11 * MIN;
    const r = await k.chamar('sistemas_anexar_envio', { envio: p.envio });
    assert.ok(r.erro, r.texto);
    assert.equal(a.srv.entregas().length, 0);
  } finally { a.limpar(); }
});

test('destino guardado no cofre é conferido de novo: formato torto ou outro tipo de pedido é recusado', () => {
  assert.throws(() => destinoDocumentoConferido(undefined), /não foi pedido por sistemas_preparar_documento/);
  assert.throws(() => destinoDocumentoConferido({ tipo: 'anexo-lancamento' }), /não foi pedido/);
  assert.throws(() => destinoDocumentoConferido({ tipo: 'documento', sistema: 's', alvo: 'banco_inteiro', tipoDocumento: 'x', id: 'a' }), /incompleto/);
  assert.throws(() => destinoDocumentoConferido({ tipo: 'documento', sistema: 's', alvo: 'rh_colaborador', tipoDocumento: 'x', id: '../x' }), /incompleto/);
  assert.throws(() => destinoDocumentoConferido({ tipo: 'documento', sistema: 's', alvo: 'caixa_paciente', tipoDocumento: 'contrato', tratRef: '' }), /incompleto/);
  const ok = destinoDocumentoConferido({ tipo: 'documento', sistema: 's', alvo: 'rh_empresa', tipoDocumento: 'Alvará', id: 'e1', validade: '2027-01-01', assinar: 'nao' });
  assert.deepEqual(ok, { sistema: 's', alvo: 'rh_empresa', id: 'e1', tratRef: '', tipoDocumento: 'Alvará', validade: '2027-01-01', assinar: false });
});

test('regressão do #206: o fluxo de comprovante de lançamento continua igual (preparar_anexo → anexar_envio → /admin/v1/anexo)', async () => {
  const LANC = '3f2b8c1e-5d6a-4b7c-9e0f-112233445566';
  const chamadas: string[] = [];
  const conta: ContaSistemas = {
    slug: 'hm-tecnologia', nome: 'HM',
    fonte: {
      async chamar(_m, caminho) {
        chamadas.push(caminho);
        if (caminho === '/admin/v1/consulta') return { linhas: [{ id: LANC, unidade: 'rioverde', valor: 150, status: 'aguardando' }] };
        if (caminho === '/admin/v1/anexo') return { ok: true, doc_id: 'd1', caminho: 'rioverde/2026-11/x.pdf', previas: 1 };
        throw new Error(caminho);
      },
    },
  };
  const srv = { chamadas: [] as Chamada[], ctx: criarContextoSistemas(new Map([[conta.slug, conta]])), conferencias: () => [], entregas: () => [] } as unknown as ReturnType<typeof servidor>;
  const a = ambiente(srv);
  try {
    const k = await cliente(a);
    const p = await k.chamar('sistemas_preparar_anexo', { tabela: 'caixa_lanc', lancamento: LANC, tipo: 'comprovante' });
    assert.equal(p.erro, false, p.texto);
    await a.cofre.guardar(a.cofre.reservar(String(p.json.linkDeEnvio).split('/').pop()!), 'r.pdf', PDF);
    const r = await k.chamar('sistemas_anexar_envio', { envio: p.json.envio });
    assert.equal(r.erro, false, r.texto);
    assert.deepEqual(chamadas, ['/admin/v1/consulta', '/admin/v1/anexo']);
  } finally { a.limpar(); }
});

// ── achados da revisão ────────────────────────────────────────────────────────────────────────────────
test('o comando curl nunca leva apóstrofo nem nome estranho (nome_arquivo e o nome padrão vêm de entrada livre)', async () => {
  const a = ambiente(servidor());
  try {
    const k = await cliente(a);
    const r = await k.chamar('sistemas_preparar_documento', colab({ tipo_documento: "Atestado d'água/..", nome_arquivo: "maria's aso; ls.pdf" }));
    assert.equal(r.erro, false, r.texto);
    const nome = /X-Nome-Arquivo: ([^']*)'/.exec(r.json.comandoCurl)?.[1];
    assert.ok(nome && /^[A-Za-z0-9._%-]+$/.test(nome), r.json.comandoCurl);
    assert.equal((r.json.comandoCurl.match(/'/g) ?? []).length, 6, 'só as seis aspas do comando (dois cabeçalhos e o endereço): nenhuma vinda do nome');
    // sem nome_arquivo, o nome padrão sai do tipo do documento, também limpo
    const p = await k.chamar('sistemas_preparar_documento', colab({ tipo_documento: "Atestado d'água/.." }));
    assert.equal(p.erro, false, p.texto);
    const enviado = a.srv.conferencias().at(-1)!.corpo.nome;
    assert.match(enviado, /^[A-Za-z0-9._-]+\.pdf$/, enviado);
    assert.ok(!enviado.includes('..'));
  } finally { a.limpar(); }
});

test('alvo nulo (servidor com defeito) não vale como confirmação do destino; data de validade impossível é recusada no passo 1', async () => {
  const a = ambiente(servidor({ conferir: () => ({ ok: true, alvo: null }) }));
  try {
    const k = await cliente(a);
    const r = await k.chamar('sistemas_preparar_documento', colab());
    assert.ok(r.erro && /não confirmou o destino/.test(r.texto), r.texto);
  } finally { a.limpar(); }
  const b = ambiente(servidor());
  try {
    const k = await cliente(b);
    for (const v of ['2026-13-45', '0000-00-00', '2026-02-31']) {
      const r = await k.chamar('sistemas_preparar_documento', colab({ validade: v }));
      assert.ok(r.erro && /data real/.test(r.texto), `${v}: ${r.texto}`);
    }
    assert.equal(b.srv.chamadas.length, 0);
  } finally { b.limpar(); }
});

test('429/403/408 do servidor NÃO queimam o arquivo (nada foi gravado): continua no cofre e a repetição funciona; 409/415 queimam', async () => {
  let status = 429;
  let n = 0;
  const a = ambiente(servidor({ documento: () => (++n === 1 ? new ErroSistemas('muitas requisições', status) : { ok: true, conferido: true, destino: 'rh_colaborador', caminho: 'colaboradores/x/y.pdf' }) }));
  try {
    const k = await cliente(a);
    for (const st of [429, 403, 408]) {
      status = st; n = 0;
      const p = await pedirESubir(a, k, PDF, `a${st}.pdf`);
      const r1 = await k.chamar('sistemas_anexar_envio', { envio: p.envio });
      assert.ok(r1.erro && /não aceitou agora.*Nada foi gravado/.test(r1.texto), `${st}: ${r1.texto}`);
      assert.equal(a.cofre.ver(QUEM.usuario, p.envio).estado, 'recebido', `${st}: o arquivo fica`);
      assert.equal((await k.chamar('sistemas_anexar_envio', { envio: p.envio })).erro, false);
    }
    for (const st of [409, 415]) {
      status = st; n = 0;
      const p = await pedirESubir(a, k, PDF, `b${st}.pdf`);
      assert.ok((await k.chamar('sistemas_anexar_envio', { envio: p.envio })).erro);
      assert.equal(a.cofre.ver(QUEM.usuario, p.envio).estado, 'apagado', `${st}: queima`);
    }
  } finally { a.limpar(); }
});

test('ZIP com as marcas de Word E de Excel ao mesmo tempo não é aceito como documento (nem como um, nem como outro)', async () => {
  const a = ambiente(servidor());
  try {
    const k = await cliente(a);
    const p = await k.chamar('sistemas_preparar_documento', colab());
    const token = String(p.json.linkDeEnvio).split('/').pop()!;
    const ambiguo = Buffer.concat([PK, Buffer.from('[Content_Types].xml word/document.xml xl/workbook.xml')]);
    assert.equal(await a.cofre.guardar(a.cofre.reservar(token), 'x.docx', ambiguo).catch((e: ErroDeCofre) => e.codigo), 'tipo');
  } finally { a.limpar(); }
});
