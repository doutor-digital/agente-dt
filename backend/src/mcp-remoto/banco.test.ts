import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sistemasChamar } from '../lib/integracoes/sistemas.js';
import { fonteDoSistema } from './banco-pg.js';
import { criarContextoSistemas } from './sistemas.js';
import { CONFIG_FALSA, servidorAdminFalso } from './sistemas-falso.js';
import { criarCatalogo, type TabelaCat } from './banco-sql.js';
import {
  confirmarEscrita,
  consultarBanco,
  criarContextoBanco,
  esquemaBanco,
  paraJson,
  prepararDesfazer,
  prepararEscrita,
  registrarBancoSePermitido,
  VALIDADE_MS,
  type BancoId,
  type ContextoBanco,
  type FonteBanco,
  type TxBanco,
} from './banco.js';

const tab = (nome: string, colunas: string[], chave = ['id'], visao = false): TabelaCat => ({ nome, colunas, chave, visao, linhas: 3 });
const CAT = criarCatalogo(
  [
    tab('conversations', ['id', 'lead_id', 'status']),
    tab('units', ['id', 'slug', 'kommo_access_token']),
    tab('chaves_de_integracao', ['id', 'chave_cifrada']),
    tab('mcp_oauth_tokens', ['id', 'token_hash']),
  ],
  [],
  [],
);

const QUEM = { usuario: 'u-suzanne', email: 'suzanne.mychelly1@gmail.com' };

interface Roteiro {
  /** linhas devolvidas pelo SELECT de antes */
  antes?: Array<Record<string, unknown>>;
  /** chaves devolvidas pelo comando (RETURNING) */
  tocadas?: Array<Record<string, unknown>>;
  /** linhas lidas depois do comando */
  depois?: Array<Record<string, unknown>>;
}

/** Banco de mentira: reconhece o SQL que o conector monta e responde o que o teste combinou. Guarda tudo o que viu. */
function falso(r: Roteiro = {}, o: { escreve?: boolean; json?: boolean; lidas?: Array<Record<string, unknown>> } = {}) {
  const vistos: Array<{ sql: string; params: unknown[] }> = [];
  const transacoes: Array<{ desfazer: boolean }> = [];
  const leituras: string[] = [];
  const registros: unknown[][] = [];
  const tx: TxBanco = {
    async consultar(sql, ...params) {
      vistos.push({ sql, params });
      if (sql.includes('FROM mcp_banco_alteracoes')) return [];
      if (/IN \(\(\$1\)/.test(sql) && sql.startsWith('SELECT "id"::text AS "__pk0"')) return r.depois ?? [];
      if (sql.startsWith('SELECT "id"::text AS "__pk0"') && sql.includes('WHERE (\n')) return r.antes ?? [];
      if (/RETURNING/.test(sql)) return r.tocadas ?? [];
      return [];
    },
    async executar(sql, ...params) {
      vistos.push({ sql, params });
      if (sql.startsWith('INSERT INTO mcp_banco_alteracoes')) registros.push(params);
      return 1;
    },
  };
  const fonte: FonteBanco = {
    id: 'agente',
    escreve: o.escreve ?? true,
    linhasEmJson: o.json ?? false,
    cacheCatalogoMs: 0,
    catalogo: async () => CAT,
    ler: async (sql) => {
      leituras.push(sql);
      return o.lidas ?? [];
    },
    transacao: async (fn, op) => {
      transacoes.push({ desfazer: op?.desfazer === true });
      return fn(tx);
    },
  };
  return { fonte, vistos, transacoes, leituras, registros };
}

function ctxCom(fontes: Partial<Record<BancoId, FonteBanco>>, avisos: string[] = [], agora: () => number = Date.now): ContextoBanco {
  const m = new Map<BancoId, () => FonteBanco>();
  for (const [k, f] of Object.entries(fontes)) m.set(k as BancoId, () => f);
  return criarContextoBanco(m, { avisar: (t) => void avisos.push(t), agora });
}

const LINHA_ANTES = { __pk0: '1', __linha: '{"id":"1","lead_id":"10","status":"aberta"}' };
const LINHA_DEPOIS = { __pk0: '1', __linha: '{"id":"1","lead_id":"10","status":"fechada"}' };
const UPDATE = "update conversations set status = 'fechada' where id = '1'";

// ------------------------------------------------------------------ portão

function servidorFalso() {
  const nomes: string[] = [];
  return { server: { registerTool: (nome: string) => void nomes.push(nome) } as unknown as McpServer, nomes };
}

test('portão: sem estar na lista, nenhuma ferramenta banco_* existe (nem para quem escreve no Kommo)', () => {
  const { server, nomes } = servidorFalso();
  const ctx = ctxCom({ agente: falso().fonte });
  assert.equal(registrarBancoSePermitido(server, ctx, QUEM, new Set(), () => {}), false);
  assert.equal(registrarBancoSePermitido(server, ctx, QUEM, new Set(['u-outra']), () => {}), false);
  assert.equal(registrarBancoSePermitido(server, ctx, { usuario: '', email: '' }, new Set(['']), () => {}), false);
  assert.deepEqual(nomes, []);
});

test('portão: quem está na lista ganha as 5 ferramentas; sem nenhum banco ligado, nenhuma', () => {
  const { server, nomes } = servidorFalso();
  assert.equal(registrarBancoSePermitido(server, ctxCom({ agente: falso().fonte }), QUEM, new Set(['u-suzanne']), () => {}), true);
  assert.deepEqual(nomes.sort(), ['banco_confirmar_escrita', 'banco_consultar', 'banco_esquema', 'banco_preparar_desfazer', 'banco_preparar_escrita']);
  const vazio = servidorFalso();
  assert.equal(registrarBancoSePermitido(vazio.server, ctxCom({}), QUEM, new Set(['u-suzanne']), () => {}), false);
  assert.deepEqual(vazio.nomes, []);
});

// ------------------------------------------------------------------ esquema e leitura

test('esquema: tabela e coluna de segredo não aparecem', async () => {
  const ctx = ctxCom({ agente: falso().fonte });
  const r = await esquemaBanco(ctx, { banco: 'agente' });
  const nomes = r.tabelas.map((x) => x.tabela);
  assert.deepEqual(nomes.sort(), ['conversations', 'units']);
  const units = (await esquemaBanco(ctx, { banco: 'agente', tabela: 'units' })).tabelas[0]!;
  assert.deepEqual(units.colunas, ['id', 'slug']);
  assert.equal(units.colunasOcultas, 1);
  assert.ok(!JSON.stringify(r).includes('chave_cifrada') && !JSON.stringify(r).includes('kommo_access_token'));
});

test('consultar: SQL perigoso nem chega ao banco', async () => {
  const f = falso();
  const ctx = ctxCom({ agente: f.fonte });
  for (const sql of ['delete from conversations', 'select * from chaves_de_integracao', "select pg_read_file('/etc/passwd')", 'select kommo_access_token from units', 'select 1; select 2', "select set_config('transaction_read_only','off',true)"]) {
    await assert.rejects(consultarBanco(ctx, QUEM, { banco: 'agente', sql }), /./, sql);
  }
  assert.deepEqual(f.leituras, []);
});

test('consultar: embrulha com teto de 501 linhas e devolve bigint como texto', async () => {
  const f = falso({}, { lidas: [{ n: 10n, nome: 'a' }] });
  const r = await consultarBanco(ctxCom({ agente: f.fonte }), QUEM, { banco: 'agente', sql: 'select count(*) as n, 1 as nome from conversations' });
  assert.match(f.leituras[0]!, /^SELECT \* FROM \(\nselect count\(\*\) as n, 1 as nome from conversations\n\) AS _q LIMIT 501$/);
  assert.deepEqual(r.linhas, [{ n: '10', nome: 'a' }]);
  assert.equal(r.cortado, false);
  assert.equal(paraJson({ a: 1n }), '{"a":"1"}');
});

test('consultar: banco direto devolve cada linha como json cortado no banco', async () => {
  const f = falso({}, { json: true, lidas: [{ _linha: { b: 2, a: 1 } }, { _linha: { _linha_cortada_por_tamanho: 'xxx' } }] });
  const r = await consultarBanco(ctxCom({ agente: f.fonte }), QUEM, { banco: 'agente', sql: 'select 2 as b, 1 as a from conversations' });
  assert.match(f.leituras[0]!, /^SELECT CASE WHEN octet_length\(_j\) > 50000 THEN json_build_object\('_linha_cortada_por_tamanho', left\(_j, 1000\)\) ELSE _j::json END AS "_linha" FROM \(SELECT to_json\(_q\)::text AS _j FROM \(\nselect 2 as b, 1 as a from conversations\n\) AS _q LIMIT 501\) AS _t$/);
  assert.deepEqual(r.colunas, ['b', 'a']);
  assert.equal(r.linhasDevolvidas, 2);
});

test('consultar: mais de 500 linhas ou mais de 200 KB vêm cortados e avisados', async () => {
  const muitas = Array.from({ length: 501 }, (_, i) => ({ i }));
  const r1 = await consultarBanco(ctxCom({ agente: falso({}, { lidas: muitas }).fonte }), QUEM, { banco: 'agente', sql: 'select i from conversations' });
  assert.equal(r1.linhasDevolvidas, 500);
  assert.equal(r1.cortado, true);
  const grandes = Array.from({ length: 100 }, () => ({ t: 'x'.repeat(10_000) }));
  const r2 = await consultarBanco(ctxCom({ agente: falso({}, { lidas: grandes }).fonte }), QUEM, { banco: 'agente', sql: 'select t from conversations' });
  assert.ok(r2.linhasDevolvidas < 100 && r2.cortado);
  assert.ok(JSON.stringify(r2.linhas).length <= 200_000);
});

test('consultar: tabela com coluna de segredo é lida pelo invólucro', async () => {
  const f = falso();
  const r = await consultarBanco(ctxCom({ agente: f.fonte }), QUEM, { banco: 'agente', sql: 'select * from units' });
  assert.match(f.leituras[0]!, /^WITH "units" AS NOT MATERIALIZED \(SELECT "id", "slug" FROM public\."units"\)/);
  assert.match(String(r.nota), /units/);
});

test('consultar: banco desconhecido ou desligado', async () => {
  await assert.rejects(consultarBanco(ctxCom({ agente: falso().fonte }), QUEM, { banco: 'n8n' as BancoId, sql: 'select 1' }), /banco: use/);
  await assert.rejects(consultarBanco(ctxCom({ agente: falso().fonte }), QUEM, { banco: 'rh', sql: 'select 1' }), /não está ligado/);
});

// ------------------------------------------------------------------ escrita: passo 1

test('preparar: roda numa transação DESFEITA, mostra linhas e antes → depois, e não grava nem avisa', async () => {
  const avisos: string[] = [];
  const f = falso({ antes: [LINHA_ANTES], tocadas: [{ __pk0: '1' }], depois: [LINHA_DEPOIS] });
  const r = await prepararEscrita(ctxCom({ agente: f.fonte }, avisos), QUEM, { banco: 'agente', sql: UPDATE, motivo: 'fechar a conversa de teste' });
  assert.deepEqual(f.transacoes, [{ desfazer: true }]);
  assert.equal(r.linhas, 1);
  assert.equal(r.operacao, 'update');
  assert.deepEqual(r.amostra, [{ chave: { id: '1' }, mudou: { status: { de: 'aberta', para: 'fechada' } } }]);
  assert.match(r.confirmacao, /^[0-9A-F]{10}$/);
  assert.ok(!f.vistos.some((v) => v.sql.startsWith('INSERT INTO mcp_banco_alteracoes')), 'prévia não registra backup');
  assert.deepEqual(avisos, []);
});

test('preparar: exige motivo, recusa o que o parser recusa e passa pelo teto de 200 linhas', async () => {
  const f = falso({ antes: [LINHA_ANTES], tocadas: [{ __pk0: '1' }], depois: [LINHA_DEPOIS] });
  const ctx = ctxCom({ agente: f.fonte });
  await assert.rejects(prepararEscrita(ctx, QUEM, { banco: 'agente', sql: UPDATE, motivo: '' }), /motivo/);
  for (const sql of ['drop table conversations', "delete from conversations where id = '1'; drop table units", 'update conversations set status = 1', "update chaves_de_integracao set id = 'x' where id = '1'", "update units set kommo_access_token = 'x' where id = '1'"]) {
    await assert.rejects(prepararEscrita(ctx, QUEM, { banco: 'agente', sql, motivo: 'teste de recusa' }), /./, sql);
  }
  assert.deepEqual(f.transacoes, [], 'o que o parser recusa nem abre transação');
  const muitas = Array.from({ length: 201 }, (_, i) => ({ __pk0: String(i), __linha: '{"id":"x"}' }));
  const grande = falso({ antes: muitas });
  await assert.rejects(prepararEscrita(ctxCom({ agente: grande.fonte }), QUEM, { banco: 'agente', sql: UPDATE, motivo: "muitas linhas" }), /200 linhas|teto por escrita é 200/);
  const grande2 = falso({ antes: [LINHA_ANTES], tocadas: muitas.map((m) => ({ __pk0: m.__pk0 })) });
  await assert.rejects(prepararEscrita(ctxCom({ agente: grande2.fonte }), QUEM, { banco: 'agente', sql: UPDATE, motivo: "muitas linhas" }), /200 linhas|teto por escrita é 200/);
  const nenhuma = falso({ antes: [] });
  await assert.rejects(prepararEscrita(ctxCom({ agente: nenhuma.fonte }), QUEM, { banco: 'agente', sql: UPDATE, motivo: 'nada casa' }), /nenhuma linha/);
});

test('preparar: RH e Descontratos não escrevem por SQL e apontam o caminho certo', async () => {
  const f = falso({}, { escreve: false });
  const ctx = ctxCom({ rh: f.fonte, dsc: f.fonte });
  await assert.rejects(prepararEscrita(ctx, QUEM, { banco: 'rh', sql: UPDATE, motivo: 'não deve' }), /sistemas_preparar_alteracao/);
  await assert.rejects(prepararEscrita(ctx, QUEM, { banco: 'dsc', sql: UPDATE, motivo: 'não deve' }), /sistemas_preparar_alteracao.*descontratos/);
  assert.deepEqual(f.transacoes, []);
});

// ------------------------------------------------------------------ escrita: passo 2

test('confirmar: grava, registra o backup NA MESMA transação, avisa o Telegram sem dados e gasta o código', async () => {
  const avisos: string[] = [];
  const f = falso({ antes: [LINHA_ANTES], tocadas: [{ __pk0: '1' }], depois: [LINHA_DEPOIS] });
  const ctx = ctxCom({ agente: f.fonte }, avisos);
  const p = await prepararEscrita(ctx, QUEM, { banco: 'agente', sql: UPDATE, motivo: 'fechar a conversa de teste' });
  const r = await confirmarEscrita(ctx, QUEM, { confirmacao: p.confirmacao.toLowerCase() });
  assert.deepEqual(f.transacoes, [{ desfazer: true }, { desfazer: false }]);
  assert.equal(r.linhasGravadas, 1);
  assert.match(r.registro, /^bk-/);
  assert.equal(r.avisoTelegram, 'enviado');
  // trava as linhas na confirmação, não na prévia
  assert.equal(f.vistos.filter((v) => / FOR UPDATE$/.test(v.sql)).length, 1);
  // o backup: id, banco, usuário, e-mail, tipo, tabela, sql, motivo, n, chaves, antes, depois, desfaz_de
  assert.equal(f.registros.length, 1);
  const reg = f.registros[0]!;
  assert.equal(reg[1], 'agente');
  assert.equal(reg[2], 'u-suzanne');
  assert.equal(reg[3], 'suzanne.mychelly1@gmail.com');
  assert.equal(reg[4], 'update');
  assert.equal(reg[5], 'conversations');
  assert.equal(reg[7], 'fechar a conversa de teste');
  assert.equal(reg[9], '[["1"]]');
  assert.equal(reg[10], `[${LINHA_ANTES.__linha}]`);
  assert.equal(reg[11], `[${LINHA_DEPOIS.__linha}]`);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0]!, /suzanne\.mychelly1@gmail\.com atualizou em conversations \(1 linha\)/);
  assert.match(avisos[0]!, /fechar a conversa de teste/);
  assert.ok(!avisos[0]!.includes('fechada') && !avisos[0]!.includes("'1'"), 'o aviso não leva valores das linhas');
  await assert.rejects(confirmarEscrita(ctx, QUEM, { confirmacao: p.confirmacao }), /desconhecido ou já usado/);
});

test('confirmar: o código é de quem preparou e vence em 10 minutos', async () => {
  let agora = 1_000_000;
  const f = falso({ antes: [LINHA_ANTES], tocadas: [{ __pk0: '1' }], depois: [LINHA_DEPOIS] });
  const ctx = ctxCom({ agente: f.fonte }, [], () => agora);
  const p = await prepararEscrita(ctx, QUEM, { banco: 'agente', sql: UPDATE, motivo: 'teste de dono' });
  await assert.rejects(confirmarEscrita(ctx, { usuario: 'u-outra', email: 'o@x' }, { confirmacao: p.confirmacao }), /outro usuário/);
  // a tentativa errada não gasta o código do dono
  const dono = await confirmarEscrita(ctx, QUEM, { confirmacao: p.confirmacao });
  assert.equal(dono.linhasGravadas, 1);
  const p2 = await prepararEscrita(ctx, QUEM, { banco: 'agente', sql: UPDATE, motivo: 'teste de validade' });
  agora += VALIDADE_MS + 1;
  await assert.rejects(confirmarEscrita(ctx, QUEM, { confirmacao: p2.confirmacao }), /venceu/);
  assert.equal(f.registros.length, 1);
});

test('confirmar: se as linhas mudaram desde a prévia, NADA é gravado', async () => {
  const f = falso({ antes: [LINHA_ANTES], tocadas: [{ __pk0: '1' }], depois: [LINHA_DEPOIS] });
  const ctx = ctxCom({ agente: f.fonte });
  const p = await prepararEscrita(ctx, QUEM, { banco: 'agente', sql: UPDATE, motivo: 'linha vai mudar' });
  // alguém mexeu na linha entre a prévia e a confirmação
  const outro = falso({ antes: [{ __pk0: '1', __linha: '{"id":"1","lead_id":"10","status":"em atendimento"}' }], tocadas: [{ __pk0: '1' }], depois: [LINHA_DEPOIS] });
  ctx.fontes.set('agente', () => outro.fonte);
  await assert.rejects(confirmarEscrita(ctx, QUEM, { confirmacao: p.confirmacao }), /mudaram desde a prévia/);
  assert.equal(outro.registros.length, 0);
  assert.ok(!outro.vistos.some((v) => /RETURNING/.test(v.sql)), 'o comando nem rodou');
});

test('confirmar: o aviso do Telegram que falha não desfaz a escrita, mas é dito', async () => {
  const f = falso({ antes: [LINHA_ANTES], tocadas: [{ __pk0: '1' }], depois: [LINHA_DEPOIS] });
  const ctx = criarContextoBanco(new Map([['agente', () => f.fonte]]), { avisar: () => Promise.resolve(false) });
  const p = await prepararEscrita(ctx, QUEM, { banco: 'agente', sql: UPDATE, motivo: 'telegram fora do ar' });
  const r = await confirmarEscrita(ctx, QUEM, { confirmacao: p.confirmacao });
  assert.equal(r.linhasGravadas, 1);
  assert.match(r.avisoTelegram, /NÃO consegui avisar/);
  const ctx2 = criarContextoBanco(new Map([['agente', () => f.fonte]]), { avisar: () => Promise.reject(new Error('rede')) });
  const p2 = await prepararEscrita(ctx2, QUEM, { banco: 'agente', sql: UPDATE, motivo: 'telegram lança erro' });
  assert.match((await confirmarEscrita(ctx2, QUEM, { confirmacao: p2.confirmacao })).avisoTelegram, /NÃO consegui avisar/);
});

test('INSERT: a prévia mostra as linhas novas; o registro guarda só o depois', async () => {
  const f = falso({ tocadas: [{ __pk0: '9' }], depois: [{ __pk0: '9', __linha: '{"id":"9","lead_id":"1","status":"nova"}' }] });
  const ctx = ctxCom({ agente: f.fonte });
  const p = await prepararEscrita(ctx, QUEM, { banco: 'agente', sql: "insert into conversations (id, lead_id, status) values ('9', '1', 'nova')", motivo: 'criar conversa de teste' });
  assert.equal(p.operacao, 'insert');
  assert.deepEqual(p.amostra, [{ chave: { id: '9' }, linha: { id: '9', lead_id: '1', status: 'nova' } }]);
  await confirmarEscrita(ctx, QUEM, { confirmacao: p.confirmacao });
  assert.equal(f.registros[0]![10], null);
  assert.equal(f.registros[0]![11], '[{"id":"9","lead_id":"1","status":"nova"}]');
});

test('backup grande demais (mais de 5 MB) recusa a escrita inteira', async () => {
  const gorda = { __pk0: '1', __linha: JSON.stringify({ id: '1', texto: 'x'.repeat(3_000_000) }) };
  const f = falso({ antes: [gorda], tocadas: [{ __pk0: '1' }], depois: [gorda] });
  const ctx = ctxCom({ agente: f.fonte });
  const p = await prepararEscrita(ctx, QUEM, { banco: 'agente', sql: UPDATE, motivo: 'linha gigante' });
  await assert.rejects(confirmarEscrita(ctx, QUEM, { confirmacao: p.confirmacao }), /5 MB/);
  assert.equal(f.registros.length, 0);
});

// ------------------------------------------------------------------ desfazer

test('desfazer: precisa de um registro bk-… e nada acontece se ele não existe', async () => {
  const ctx = ctxCom({ agente: falso().fonte });
  await assert.rejects(prepararDesfazer(ctx, QUEM, { alteracao: 'qualquer coisa' }), /bk-/);
  await assert.rejects(prepararDesfazer(ctx, QUEM, { alteracao: 'bk-abc123-def' }), /não existe em mcp_banco_alteracoes/);
  await assert.rejects(prepararDesfazer(ctxCom({ rh: falso({}, { escreve: false }).fonte }), QUEM, { alteracao: 'bk-abc123-def', banco: 'rh' }), /sistemas_preparar_alteracao/);
});

// ------------------------------------------------------------------ RH e Descontratos pela API do sistema

test('RH pela API do sistema: esquema vem do servidor; a consulta é embrulhada e leva o e-mail de quem pediu; escrever por SQL é recusado', async () => {
  const srv = servidorAdminFalso({ maisTabelas: true, linhas: [{ id: 1 }] });
  const sistemas = criarContextoSistemas(new Map([['hm-rh', { slug: 'hm-rh', nome: 'RH', fonte: { chamar: (m, c, op) => sistemasChamar(CONFIG_FALSA, m, c, op, srv.fetch) } }]]));
  const ctx = criarContextoBanco(new Map([['rh', () => fonteDoSistema('rh', sistemas)]]));
  const e = await esquemaBanco(ctx, { banco: 'rh' });
  assert.ok(e.tabelas.some((t) => t.tabela === 'rh_funcionarios'));
  const r = await consultarBanco(ctx, QUEM, { banco: 'rh', sql: 'select id from rh_funcionarios' });
  assert.deepEqual(r.linhas, [{ id: 1 }]);
  const c = srv.chamadas.find((x) => x.caminho === '/admin/v1/consulta')!;
  assert.equal(c.corpo.sql, 'SELECT * FROM (\nselect id from rh_funcionarios\n) AS _q LIMIT 501');
  assert.equal(c.quem, 'suzanne.mychelly1@gmail.com');
  // esquemas de segredo que um sistema vindo do Supabase pode ter, e o que o parser fecha em qualquer banco
  for (const sql of ['select * from auth.users', 'select * from vault.secrets', 'select * from storage.objects', 'delete from rh_funcionarios', "select * from pg_authid"]) {
    await assert.rejects(consultarBanco(ctx, QUEM, { banco: 'rh', sql }), /./, sql);
  }
  assert.equal(srv.chamadas.filter((x) => x.caminho === '/admin/v1/consulta').length, 1, 'o que o parser recusa nem sai para o servidor');
  await assert.rejects(prepararEscrita(ctx, QUEM, { banco: 'rh', sql: UPDATE, motivo: 'não deve' }), /sistemas_preparar_alteracao/);
  assert.equal(srv.chamadas.filter((x) => x.caminho === '/admin/v1/preparar').length, 0);
});

test('RH sem conta carregada: erro claro, nada vaza', async () => {
  const ctx = criarContextoBanco(new Map([['rh', () => fonteDoSistema('rh', criarContextoSistemas())]]));
  await assert.rejects(consultarBanco(ctx, QUEM, { banco: 'rh', sql: 'select 1' }), /sistema novo|RH/);
});

test('RH: linha enorme vinda da API é cortada aqui (50 KB), não vira resposta de MBs', async () => {
  const f = falso({}, { lidas: [{ id: 1, texto: 'x'.repeat(5_000_000) }, { id: 2, texto: 'ok' }] });
  const r = await consultarBanco(ctxCom({ agente: f.fonte }), QUEM, { banco: 'agente', sql: 'select id, texto from conversations' });
  assert.deepEqual(Object.keys((r.linhas as Array<Record<string, unknown>>)[0]!), ['_linha_cortada_por_tamanho']);
  assert.deepEqual((r.linhas as unknown[])[1], { id: 2, texto: 'ok' });
});
