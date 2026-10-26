import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { linkDoPainel, MONTAGENS_SIMULTANEAS, registrarDisparo, resolverUnidade, resumoDaOnda, type FonteDeDisparo } from './disparo.js';
import { FREIOS_PADRAO } from '../lib/disparo/freios.js';
import type { DadosDoPainel } from '../lib/disparo/painel.js';

const BASE = 'https://agente-vps.doutordigitalconsultoria.com';
const SLUGS = ['doutor-hernia-canaa', 'doutor-hernia-acailandia', 'doutor-hernia-petropolis', 'doutor-hernia-caxias', 'hm-tecnologia'];

function dados(sobre: Omit<Partial<DadosDoPainel>, 'onda'> & { onda?: Partial<DadosDoPainel['onda']> } = {}): DadosDoPainel {
  const { onda, ...resto } = sobre;
  return {
    onda: { id: 'onda1', estado: 'montada', total: 42, etiqueta: 'rosa-dia-1', impressao: 'x', aprovadaPor: null, aprovadaEm: null, pausaMotivo: null, template: 'canaa_rosa', idioma: 'pt_BR', textoModelo: 'Oi {{1}}! A {{2}} tem uma condição especial.', variaveis: ['primeiroNome', 'unidade'], cabecalho: { tipo: 'image', link: 'https://x/y.png' }, ...onda },
    campanhaNome: 'Outubro Rosa',
    unidade: { slug: 'doutor-hernia-canaa', nome: 'Doutor Hérnia Canaã' },
    modo: 'seco',
    freios: FREIOS_PADRAO,
    resumo: { candidatos: 60, fora: { 'consulta-futura': 10, 'pediu-sair': 3, 'sem-telefone': 0 } },
    contagem: { pendente: 42 },
    simulados: 0,
    amostra: [{ nome: 'Ana', telefone: '5563991021043' }, { nome: 'Rosa', telefone: '5563991021044' }, { nome: 'Lúcia', telefone: '5563991021045' }, { nome: 'Joana', telefone: '5563991021046' }],
    oferta: 'Consulta por R$ 150 até 31/10.',
    conferenciaMeta: { ok: true },
    podeAprovar: false,
    listaDeTeste: null,
    ...resto,
  };
}

interface Chamadas { montar: Array<{ campanha: string; unidade: string; etiqueta: string; por: string }>; salvar: Array<{ slug: string; soCriar: boolean; mesclar: boolean; oferta: unknown; chaves: string[] }> }

function fonteFalsa(o: { montando?: number; tela?: DadosDoPainel | null; salvarErro?: string; montarErro?: string; base?: string | null } = {}): { fonte: FonteDeDisparo; chamadas: Chamadas } {
  const chamadas: Chamadas = { montar: [], salvar: [] };
  const fonte: FonteDeDisparo = {
    urlDoPainel: () => (o.base === undefined ? BASE : o.base),
    unidades: async () => SLUGS,
    campanhas: async () => [{ slug: 'outubro-rosa-2026', nome: 'Outubro Rosa', template: 'rosa', idioma: 'pt_BR', textoModelo: 'Oi {{1}}', variaveis: ['primeiroNome'], temCabecalho: false, unidadesComModeloProprio: ['doutor-hernia-canaa'], oferta: null, ondas: { montada: 1 } }],
    ondasRecentes: async () => [{ id: 'onda1', campanha: 'outubro-rosa-2026', unidade: 'doutor-hernia-canaa', etiqueta: 'rosa', estado: 'montada', total: 42, criadoEm: new Date(0), motivo: null }],
    montandoAgora: async () => o.montando ?? 0,
    salvarCampanha: async (slug, entrada, opcoes) => {
      chamadas.salvar.push({ slug, soCriar: opcoes.soCriar, mesclar: opcoes.mesclar, oferta: entrada.oferta, chaves: Object.keys(entrada).sort() });
      return o.salvarErro ? { ok: false, status: 409, erro: o.salvarErro } : { ok: true, dados: { id: 'c1', slug, criada: opcoes.soCriar, alterados: opcoes.soCriar ? [] : ['oferta'] } };
    },
    montarOnda: async (a) => {
      chamadas.montar.push(a);
      return o.montarErro ? { ok: false, status: 409, erro: o.montarErro } : { ok: true, dados: { id: 'onda1' } };
    },
    tela: async () => (o.tela === undefined ? dados() : o.tela),
  };
  return { fonte, chamadas };
}

async function conectar(fonte: FonteDeDisparo) {
  const server = new McpServer({ name: 't', version: '0' });
  const auditoria: string[] = [];
  registrarDisparo(server, fonte, 'conector:u1', (r) => auditoria.push(`${r.ferramenta}:${r.ok}`));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), c.connect(b)]);
  return { c, auditoria };
}
const texto = (r: any) => String(r.content?.[0]?.text ?? '');

test('só existem as ferramentas de PREPARAR e MOSTRAR: nenhuma aprova, retoma, cancela ou envia', async () => {
  const { c } = await conectar(fonteFalsa().fonte);
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['disparo_campanha_salvar', 'disparo_listar', 'disparo_montar_onda', 'disparo_onda']);
  assert.ok(!tools.some((t) => /aprov|retom|libera|cancel|envia|dispara/i.test(t.name)));
  assert.ok(tools.every((t) => !t.annotations?.destructiveHint), 'nenhuma é destrutiva');
  await c.close();
});

test('o código do conector não importa nada que aprove, retome, cancele ou envie', () => {
  for (const arquivo of ['disparo.ts', 'disparo-producao.ts']) {
    const src = readFileSync(new URL(`./${arquivo}`, import.meta.url), 'utf8');
    const importes = src.split('\n').filter((l) => /^\s*(import|export) .* from /.test(l) || /^import /.test(l)).join('\n');
    assert.doesNotMatch(importes, /aprovarOnda|retomarOnda|cancelarOnda|enviarTemplate|whatsapp-meta|lote\.js|porto\.js/, arquivo);
  }
});

test('as ferramentas de disparo só são registradas dentro do bloco de quem pode escrever (MCP_ESCRITA_EMAILS)', () => {
  const src = readFileSync(new URL('./producao.ts', import.meta.url), 'utf8');
  const i = src.indexOf('registrarDisparo(');
  assert.ok(i > 0);
  const bloco = src.slice(src.lastIndexOf('if (escritores.has(quem.userId))', i), i);
  assert.match(bloco, /^if \(escritores\.has\(quem\.userId\)\) \{\s*registrarEscritaKommo/);
  assert.equal(src.match(/registrarDisparo\(/g)?.length, 1);
});

test('unidade: aceita slug, nome curto e acento; ambígua ou desconhecida lista as opções', () => {
  assert.equal(resolverUnidade('canaa', SLUGS), 'doutor-hernia-canaa');
  assert.equal(resolverUnidade('Canaã', SLUGS), 'doutor-hernia-canaa');
  assert.equal(resolverUnidade('doutor-hernia-acailandia', SLUGS), 'doutor-hernia-acailandia');
  assert.equal(resolverUnidade('hm', SLUGS), 'hm-tecnologia');
  assert.throws(() => resolverUnidade('doutor', SLUGS), /ambígua.*Opções: /);
  assert.throws(() => resolverUnidade('xpto', SLUGS), /não existe ou está inativa.*doutor-hernia-canaa/);
  assert.throws(() => resolverUnidade('  ', SLUGS), /diga a unidade/);
});

test('link do painel: origem + rota do console; sem endereço público, sem link', () => {
  assert.equal(linkDoPainel(BASE, 'abc'), `${BASE}/api/disparo/ondas/abc/painel`);
  assert.equal(linkDoPainel(`${BASE}/`, 'abc'), `${BASE}/api/disparo/ondas/abc/painel`);
  assert.equal(linkDoPainel(null, 'abc'), null);
});

test('prévia: quantas pessoas, o texto FINAL com as variáveis resolvidas, quem ficou de fora, o modo e o link — sem telefone de ninguém', () => {
  const r = resumoDaOnda(dados(), BASE);
  assert.equal(r.pessoas, 42);
  assert.equal(r.painel, `${BASE}/api/disparo/ondas/onda1/painel`);
  assert.deepEqual(r.textoComoChega.map((x) => x.texto), [
    'Oi Ana! A Doutor Hérnia Canaã tem uma condição especial.',
    'Oi Rosa! A Doutor Hérnia Canaã tem uma condição especial.',
    'Oi Lúcia! A Doutor Hérnia Canaã tem uma condição especial.',
  ]);
  assert.deepEqual(r.foraDaLista, { 'tem consulta marcada na franquia': 10, 'pediu para sair (SAIR)': 3 }, 'motivo com zero não aparece');
  assert.equal(r.cartoesNaEtiqueta, 60);
  assert.match(r.avisoDoModo, /MODO SECO.*NÃO manda nada/);
  assert.match(r.conferidoNaMeta, /^sim/);
  assert.equal(r.ofertaQueASofiaVaiSaber, 'Consulta por R$ 150 até 31/10.');
  assert.doesNotMatch(JSON.stringify(r), /\b55\d{10,11}\b/, 'nenhum telefone na resposta');
  assert.match(r.proximoPasso, /Mande o link ao João.*MODO SECO.*Eu não aprovo/);
});

test('prévia: o próximo passo muda com o estado e nunca manda o Claude aprovar ou retomar', () => {
  const p = (sobre: Parameters<typeof dados>[0]) => resumoDaOnda(dados(sobre), BASE).proximoPasso;
  assert.match(p({ onda: { estado: 'montando' } }), /Ainda montando/);
  assert.match(p({ modo: 'ligado' }), /quem clica em Aprovar .* é ele.*Eu não aprovo/);
  assert.match(p({ onda: { estado: 'pausada', pausaCausa: 'sair', pausaMotivo: '4 SAIR' } }), /Só o João retoma.*Eu não retomo/);
  assert.match(p({ onda: { estado: 'pausada', pausaCausa: 'falhas', pausaMotivo: '5 falhas' } }), /Não tem retomada.*cancelar no painel e montar de novo/);
  assert.match(p({ onda: { estado: 'cancelada', pausaMotivo: 'nenhuma pessoa elegível nesta etiqueta' } }), /Cancelada: nenhuma pessoa elegível/);
  assert.match(p({ onda: { estado: 'aprovada' } }), /seco: o worker só grava quem receberia/);
});

test('prévia: onda pausada por SAIR traz quem pediu (só o primeiro nome; o que escreveram fica no painel)', () => {
  const r = resumoDaOnda(dados({ onda: { estado: 'pausada', pausaCausa: 'sair', pausaMotivo: '4 pessoas responderam SAIR' }, saidas: [{ nome: 'Maria', resposta: 'SAIR-MARCADOR-XYZ', quando: null }, { nome: 'Rosa', resposta: '', quando: null }] }), BASE);
  assert.deepEqual(r.pediramSair, { quantos: 2, primeirosNomes: ['Maria', 'Rosa'], oQueEscreveram: 'só no painel do João' });
  assert.ok(!JSON.stringify(r).includes('MARCADOR-XYZ'), 'o texto livre do paciente não vai para o chat');
  assert.equal(r.motivoDaParada, '4 pessoas responderam SAIR');
});

test('montar: resolve a unidade, registra quem pediu, devolve o link e NÃO aprova nem manda nada', async () => {
  const { fonte, chamadas } = fonteFalsa();
  const { c, auditoria } = await conectar(fonte);
  const r = await c.callTool({ name: 'disparo_montar_onda', arguments: { campanha: 'outubro-rosa-2026', unidade: 'canaa', etiqueta: 'rosa-dia-1' } });
  assert.notEqual(r.isError, true);
  assert.deepEqual(chamadas.montar, [{ campanha: 'outubro-rosa-2026', unidade: 'doutor-hernia-canaa', etiqueta: 'rosa-dia-1', por: 'conector:u1' }]);
  const j = JSON.parse(texto(r));
  assert.equal(j.painel, `${BASE}/api/disparo/ondas/onda1/painel`);
  assert.match(j.proximoPasso, /disparo_onda.*Eu não aprovo/);
  assert.deepEqual(auditoria, ['disparo_montar_onda:true']);
  await c.close();
});

test('montar: com montagens demais em andamento recusa, e erro da regra (onda viva, modelo, Meta) volta legível', async () => {
  const cheia = await conectar(fonteFalsa({ montando: MONTAGENS_SIMULTANEAS }).fonte);
  const r = await cheia.c.callTool({ name: 'disparo_montar_onda', arguments: { campanha: 'x-y', unidade: 'canaa', etiqueta: 'e' } });
  assert.equal(r.isError, true);
  assert.match(texto(r), /ondas sendo montadas/);
  const { fonte, chamadas } = fonteFalsa({ montarErro: 'já existe a onda abc desta campanha nesta unidade (montada)' });
  const viva = await conectar(fonte);
  const r2 = await viva.c.callTool({ name: 'disparo_montar_onda', arguments: { campanha: 'x-y', unidade: 'canaa', etiqueta: 'e' } });
  assert.equal(r2.isError, true);
  assert.match(texto(r2), /já existe a onda abc/);
  assert.equal(chamadas.montar.length, 1);
  const r3 = await viva.c.callTool({ name: 'disparo_montar_onda', arguments: { campanha: 'x-y', unidade: 'xpto', etiqueta: 'e' } });
  assert.equal(r3.isError, true);
  assert.match(texto(r3), /não existe ou está inativa/);
  assert.equal(chamadas.montar.length, 1, 'unidade desconhecida nem chega a tentar');
});

test('salvar campanha: por padrão só CRIA (nunca sobrescreve sem pedir); com atualizar=true muda SÓ o que veio; a oferta viaja', async () => {
  const { fonte, chamadas } = fonteFalsa();
  const { c } = await conectar(fonte);
  const base = { campanha: 'outubro-rosa-2026', nome: 'Outubro Rosa', textoModelo: 'Oi {{1}}', variaveis: ['primeiroNome'], oferta: 'R$ 150 até 31/10' };
  assert.notEqual((await c.callTool({ name: 'disparo_campanha_salvar', arguments: base })).isError, true);
  const atualizada = await c.callTool({ name: 'disparo_campanha_salvar', arguments: { campanha: 'outubro-rosa-2026', nome: 'Outubro Rosa', textoModelo: 'Oi {{1}}', oferta: 'R$ 140 até 31/10', atualizar: true } });
  assert.notEqual(atualizada.isError, true);
  assert.deepEqual(JSON.parse(texto(atualizada)).camposAlterados, ['oferta']);
  assert.deepEqual(chamadas.salvar, [
    { slug: 'outubro-rosa-2026', soCriar: true, mesclar: true, oferta: 'R$ 150 até 31/10', chaves: ['nome', 'oferta', 'textoModelo', 'variaveis'] },
    { slug: 'outubro-rosa-2026', soCriar: false, mesclar: true, oferta: 'R$ 140 até 31/10', chaves: ['nome', 'oferta', 'textoModelo'] },
  ]);
  assert.ok(!chamadas.salvar[1]!.chaves.some((k) => ['porUnidade', 'cabecalho', 'variaveis', 'idioma', 'template'].includes(k)), 'o que não veio NÃO é mandado (nem vira padrão): modelo por unidade e arte ficam');
  const ruim = await conectar(fonteFalsa({ salvarErro: 'a campanha outubro-rosa-2026 já existe; peça para atualizar' }).fonte);
  const r = await ruim.c.callTool({ name: 'disparo_campanha_salvar', arguments: base });
  assert.equal(r.isError, true);
  assert.match(texto(r), /já existe/);
  const longa = await c.callTool({ name: 'disparo_campanha_salvar', arguments: { ...base, oferta: 'x'.repeat(1201) } });
  assert.equal(longa.isError, true, 'oferta acima do limite é recusada na entrada');
});

test('listar: campanhas e ondas recentes com link; onda: lê pela id e devolve erro claro se não existe', async () => {
  const { c } = await conectar(fonteFalsa().fonte);
  const l = JSON.parse(texto(await c.callTool({ name: 'disparo_listar', arguments: {} })));
  assert.equal(l.campanhas[0].slug, 'outubro-rosa-2026');
  assert.equal(l.ondasRecentes[0].painel, `${BASE}/api/disparo/ondas/onda1/painel`);
  assert.match(l.lembrete, /Aprovar e retomar .* do João/);
  const o = JSON.parse(texto(await c.callTool({ name: 'disparo_onda', arguments: { onda: 'onda1' } })));
  assert.equal(o.pessoas, 42);
  const sem = await conectar(fonteFalsa({ tela: null }).fonte);
  const r = await sem.c.callTool({ name: 'disparo_onda', arguments: { onda: 'nao-existe' } });
  assert.equal(r.isError, true);
  assert.match(texto(r), /onda não encontrada/);
});
