/**
 * `banco_*` contra um Postgres DE VERDADE (o SQL que o conector monta só se prova no banco). Só roda com `TESTE_POSTGRES_URL` apontando para um
 * banco DESCARTÁVEL: ele cria e APAGA as tabelas bt_*, mcp_banco_alteracoes e kommo_web_sessions do esquema public. Por exemplo:
 *   docker run -d --rm -p 127.0.0.1:55999:5432 -e POSTGRES_PASSWORD=t postgres:16
 *   TESTE_POSTGRES_URL=postgresql://postgres:t@127.0.0.1:55999/postgres pnpm exec tsx --test src/mcp-remoto/banco-postgres.test.ts
 * Sem a variável o teste é pulado (a suíte normal não tem banco).
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { confirmarEscrita, consultarBanco, criarContextoBanco, esquemaBanco, prepararDesfazer, prepararEscrita, type ContextoBanco } from './banco.js';
import { fonteDoAgente } from './banco-pg.js';

const URL_TESTE = process.env.TESTE_POSTGRES_URL;
const QUEM = { usuario: 'u-suzanne', email: 'suzanne.mychelly1@gmail.com' };
const MIGRACAO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations/20261111150000_mcp_banco_alteracoes/migration.sql');

describe('banco_* no Postgres de verdade', { skip: !URL_TESTE }, () => {
  let admin: PrismaClient;
  let ctx: ContextoBanco;
  const avisos: string[] = [];
  const sql = (s: string, ...p: unknown[]) => admin.$executeRawUnsafe(s, ...p);
  const ler = (s: string, ...p: unknown[]) => admin.$queryRawUnsafe<Array<Record<string, unknown>>>(s, ...p);

  before(async () => {
    admin = new PrismaClient({ datasourceUrl: URL_TESTE });
    for (const d of ['drop view if exists bt_visao', 'drop table if exists bt_filha, bt_pai, bt_novo, bt_unidades, bt_msgs, bt_sem_chave, mcp_banco_alteracoes, kommo_web_sessions', 'drop function if exists bt_fn()', 'drop schema if exists outro cascade']) await sql(d);
    await sql("create table bt_unidades (id text primary key, nome text, openai_api_key text, n int, extra jsonb, criado timestamp default now())");
    await sql('create table bt_msgs (id serial primary key, texto text, valor numeric(12,2), quando timestamptz default now())');
    await sql('create table bt_sem_chave (a int)');
    await sql('create table bt_pai (id int primary key, nome text)');
    await sql('create table bt_filha (id int primary key, pai_id int references bt_pai(id) on delete cascade, nome text)');
    await sql('create table kommo_web_sessions (id text primary key, refresh_token text)');
    await sql('create view bt_visao as select id from bt_unidades');
    await sql("create function bt_fn() returns int language sql as 'select 1'");
    await sql('create schema outro');
    await sql('create table outro.bt_x (id int primary key)');
    for (const parte of readFileSync(MIGRACAO, 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('\n').split(';').map((x) => x.trim()).filter(Boolean)) await sql(parte);
    await sql("insert into bt_unidades (id, nome, openai_api_key, n, extra) values ('a', 'Alfa', 'sk-segredo-a', 1, '{\"x\": [1, 2]}'), ('b', 'Beta', 'sk-segredo-b', 2, null)");
    await sql("insert into kommo_web_sessions values ('s1', 'refresh-segredo')");
    const fonte = fonteDoAgente({ MCP_BANCO_AGENTE_URL: URL_TESTE } as NodeJS.ProcessEnv);
    assert.ok(fonte);
    ctx = criarContextoBanco(new Map([['agente', () => fonte]]), { avisar: (t) => void avisos.push(t) });
  });

  beforeEach(async () => {
    await sql('delete from bt_msgs');
  });

  after(async () => {
    for (const d of ['drop view if exists bt_visao', 'drop table if exists bt_filha, bt_pai, bt_novo, bt_unidades, bt_msgs, bt_sem_chave, mcp_banco_alteracoes, kommo_web_sessions', 'drop function if exists bt_fn()', 'drop schema if exists outro cascade']) await sql(d);
    await admin.$disconnect();
  });

  const fonte = () => ctx.fontes.get('agente')!();

  it('catálogo: tabelas, colunas, chave, view, função e outros esquemas', async () => {
    const cat = await fonte().catalogo();
    const u = cat.tabelas.get('bt_unidades')!;
    assert.deepEqual(u.colunas, ['id', 'nome', 'openai_api_key', 'n', 'extra', 'criado']);
    assert.deepEqual(u.chave, ['id']);
    assert.equal(cat.tabelas.get('bt_visao')!.visao, true);
    assert.deepEqual(cat.tabelas.get('bt_sem_chave')!.chave, []);
    assert.ok(cat.funcoes.includes('bt_fn'));
    assert.deepEqual(cat.tabelas.get('bt_pai')!.cascata, ['bt_filha']);
    assert.equal(cat.tabelas.get('bt_filha')!.cascata, undefined);
    assert.ok(cat.esquemas.includes('outro'));
    assert.ok(!cat.tabelas.has('bt_x'), 'só o esquema public');
    const e = await esquemaBanco(ctx, { banco: 'agente', tabela: 'bt_' });
    assert.ok(e.tabelas.every((t) => t.tabela.startsWith('bt_')));
    assert.deepEqual(e.tabelas.find((t) => t.tabela === 'bt_unidades')!.colunas, ['id', 'nome', 'n', 'extra', 'criado']);
    assert.ok(!JSON.stringify(await esquemaBanco(ctx, { banco: 'agente' })).includes('kommo_web_sessions'));
  });

  it('leitura: a transação é READ ONLY, com tempo e esquema fixos; escrita é recusada pelo PRÓPRIO banco', async () => {
    const [cfg] = await fonte().ler("select current_setting('statement_timeout') as t, current_setting('transaction_read_only') as ro, current_setting('search_path') as sp, current_setting('standard_conforming_strings') as sc", 'x');
    assert.deepEqual(cfg, { t: '30s', ro: 'on', sp: 'public', sc: 'on' });
    await assert.rejects(fonte().ler("insert into bt_msgs (texto) values ('invasor')", 'x'), /read-only/i);
    await assert.rejects(fonte().ler("create table bt_invasor (a int)", 'x'), /read-only/i);
    await assert.rejects(fonte().ler("delete from bt_unidades", 'x'), /read-only/i);
    await assert.rejects(fonte().ler('select 1; select 2', 'x'), /./, 'dois comandos numa chamada: o Postgres recusa (protocolo estendido)');
    assert.equal((await ler('select count(*)::int as n from bt_msgs'))[0]!.n, 0);
  });

  it('leitura: SET/set_config para sair do READ ONLY não passa nem do parser', async () => {
    for (const s of ["select set_config('transaction_read_only', 'off', true)", 'set transaction read write', 'select 1; set transaction read write', "select pg_sleep(0.1)", "select query_to_xml('select * from kommo_web_sessions', true, false, '')"]) {
      await assert.rejects(consultarBanco(ctx, QUEM, { banco: 'agente', sql: s }), /./, s);
    }
  });

  it('leitura: select * não traz a coluna de segredo; segredo por nome, apelido ou tabela fechada é recusado', async () => {
    const r = await consultarBanco(ctx, QUEM, { banco: 'agente', sql: 'select * from bt_unidades order by id' });
    assert.deepEqual(r.colunas, ['id', 'nome', 'n', 'extra', 'criado']);
    assert.equal(r.linhasDevolvidas, 2);
    assert.ok(!JSON.stringify(r).includes('sk-segredo'));
    const j = await consultarBanco(ctx, QUEM, { banco: 'agente', sql: 'select row_to_json(u) as linha, to_jsonb(u) as outra from bt_unidades u order by id' });
    assert.ok(!JSON.stringify(j).includes('sk-segredo') && !JSON.stringify(j).includes('openai_api_key'));
    const cte = await consultarBanco(ctx, QUEM, { banco: 'agente', sql: 'with x as (select * from bt_unidades) select * from x order by id' });
    assert.ok(!JSON.stringify(cte).includes('sk-segredo'));
    for (const s of ['select openai_api_key from bt_unidades', 'select * from kommo_web_sessions', 'select * from public.kommo_web_sessions', 'select * from bt_unidades u join kommo_web_sessions k on true', 'select * from public.bt_unidades', 'select * from outro.bt_x', 'select * from pg_shadow', 'select bt_fn()']) {
      await assert.rejects(consultarBanco(ctx, QUEM, { banco: 'agente', sql: s }), /./, s);
    }
  });

  it('leitura: coluna gigante é cortada no banco, a ordem das colunas se mantém e o corpo da linha não vira memória do agente', async () => {
    const g = await consultarBanco(ctx, QUEM, { banco: 'agente', sql: "select 2 as b, 1 as a, repeat('x', 200000) as grande from generate_series(1, 3)" });
    assert.equal(g.linhasDevolvidas, 3);
    assert.ok(JSON.stringify(g.linhas).length < 10_000);
    assert.deepEqual(Object.keys((g.linhas as Array<Record<string, unknown>>)[0]!), ['_linha_cortada_por_tamanho']);
    const o = await consultarBanco(ctx, QUEM, { banco: 'agente', sql: 'select 2 as b, 1 as a' });
    assert.deepEqual(o.colunas, ['b', 'a']);
  });

  it('leitura: bigint, numeric, data e json voltam em JSON; o teto de 500 linhas corta e avisa', async () => {
    const r = await consultarBanco(ctx, QUEM, { banco: 'agente', sql: "select count(*) as n, 10::numeric(12,2) as d, now() as agora, '{\"a\":1}'::jsonb as j from bt_unidades" });
    assert.equal((r.linhas as Array<Record<string, unknown>>)[0]!.n, 2);
    const m = await consultarBanco(ctx, QUEM, { banco: 'agente', sql: 'select g from generate_series(1, 1000) g' });
    assert.equal(m.linhasDevolvidas, 500);
    assert.equal(m.cortado, true);
  });

  // ---------------------------------------------------------------- escrita

  it('INSERT: a prévia desfaz de verdade; a confirmação grava, guarda o backup e avisa; desfazer apaga', async () => {
    const p = await prepararEscrita(ctx, QUEM, { banco: 'agente', sql: "insert into bt_msgs (texto, valor) values ('um', 1.5), ('dois', 2)", motivo: 'teste de insert' });
    assert.equal(p.linhas, 2);
    assert.equal((await ler('select count(*)::int as n from bt_msgs'))[0]!.n, 0, 'a prévia não deixou nada');
    const c = await confirmarEscrita(ctx, QUEM, { confirmacao: p.confirmacao });
    assert.equal(c.linhasGravadas, 2);
    assert.equal((await ler('select count(*)::int as n from bt_msgs'))[0]!.n, 2);
    const [reg] = await ler('select tipo, tabela, linhas, usuario_email, motivo, antes, depois, chaves, desfeito_em from mcp_banco_alteracoes where id = $1', c.registro);
    assert.equal(reg!.tipo, 'insert');
    assert.equal(reg!.linhas, 2);
    assert.equal(reg!.antes, null);
    assert.equal((reg!.depois as unknown[]).length, 2);
    // a prévia gastou dois números da sequência (o rollback não devolve): as chaves guardadas são as da confirmação
    assert.equal((reg!.chaves as string[][]).length, 2);
    assert.ok((reg!.chaves as string[][]).every((c) => /^\d+$/.test(c[0]!)));
    assert.match(avisos.at(-1)!, /inseriu em bt_msgs \(2 linhas\)/);
    const d = await prepararDesfazer(ctx, QUEM, { alteracao: c.registro });
    assert.equal((await ler('select count(*)::int as n from bt_msgs'))[0]!.n, 2, 'prévia do desfazer também desfaz');
    await confirmarEscrita(ctx, QUEM, { confirmacao: d.confirmacao });
    assert.equal((await ler('select count(*)::int as n from bt_msgs'))[0]!.n, 0);
    assert.ok((await ler('select desfeito_em from mcp_banco_alteracoes where id = $1', c.registro))[0]!.desfeito_em);
    await assert.rejects(prepararDesfazer(ctx, QUEM, { alteracao: c.registro }), /já foi desfeito/);
  });

  it('UPDATE: mostra só o que muda, grava, e o desfazer devolve o valor antigo (inclusive jsonb, data e numeric)', async () => {
    await sql("insert into bt_msgs (texto, valor) values ('velho', 10.10), ('velho2', 20)");
    const p = await prepararEscrita(ctx, QUEM, { banco: 'agente', sql: "update bt_msgs set texto = 'novo', valor = valor + 1 where texto like 'velho%'", motivo: 'teste de update' });
    assert.equal(p.linhas, 2);
    assert.deepEqual((p.amostra as Array<{ mudou: Record<string, unknown> }>)[0]!.mudou.texto, { de: 'velho', para: 'novo' });
    assert.equal((await ler("select count(*)::int as n from bt_msgs where texto = 'novo'"))[0]!.n, 0);
    const c = await confirmarEscrita(ctx, QUEM, { confirmacao: p.confirmacao });
    const depois = await ler('select texto, valor::text as v from bt_msgs order by id');
    assert.deepEqual(depois, [{ texto: 'novo', v: '11.10' }, { texto: 'novo', v: '21.00' }]);
    const d = await prepararDesfazer(ctx, QUEM, { alteracao: c.registro });
    await confirmarEscrita(ctx, QUEM, { confirmacao: d.confirmacao });
    assert.deepEqual(await ler('select texto, valor::text as v from bt_msgs order by id'), [{ texto: 'velho', v: '10.10' }, { texto: 'velho2', v: '20.00' }]);
    await sql('delete from bt_msgs');
  });

  it('UPDATE em tabela com coluna de segredo muda as colunas boas e nunca toca nem registra o segredo', async () => {
    const p = await prepararEscrita(ctx, QUEM, { banco: 'agente', sql: "update bt_unidades set nome = 'Alfa 2', extra = '{\"y\": true}'::jsonb where id = 'a'", motivo: 'renomear unidade de teste' });
    const c = await confirmarEscrita(ctx, QUEM, { confirmacao: p.confirmacao });
    assert.equal((await ler("select openai_api_key from bt_unidades where id = 'a'"))[0]!.openai_api_key, 'sk-segredo-a');
    const [reg] = await ler('select antes::text as antes, depois::text as depois from mcp_banco_alteracoes where id = $1', c.registro);
    assert.ok(!reg!.antes!.toString().includes('segredo') && !reg!.depois!.toString().includes('segredo'));
    const d = await prepararDesfazer(ctx, QUEM, { alteracao: c.registro });
    await confirmarEscrita(ctx, QUEM, { confirmacao: d.confirmacao });
    const [a] = await ler("select nome, extra::text as extra, openai_api_key from bt_unidades where id = 'a'");
    assert.deepEqual(a, { nome: 'Alfa', extra: '{"x": [1, 2]}', openai_api_key: 'sk-segredo-a' });
  });

  it('DELETE: apaga, guarda o backup e o desfazer reinsere; em tabela com segredo nem prepara', async () => {
    await sql("insert into bt_msgs (texto, valor) values ('apagar', 5)");
    const p = await prepararEscrita(ctx, QUEM, { banco: 'agente', sql: "delete from bt_msgs where texto = 'apagar'", motivo: 'teste de delete' });
    assert.equal(p.linhas, 1);
    const c = await confirmarEscrita(ctx, QUEM, { confirmacao: p.confirmacao });
    assert.equal((await ler('select count(*)::int as n from bt_msgs'))[0]!.n, 0);
    const d = await prepararDesfazer(ctx, QUEM, { alteracao: c.registro });
    await confirmarEscrita(ctx, QUEM, { confirmacao: d.confirmacao });
    assert.deepEqual(await ler('select texto, valor::text as v from bt_msgs'), [{ texto: 'apagar', v: '5.00' }]);
    await sql('delete from bt_msgs');
    await assert.rejects(prepararEscrita(ctx, QUEM, { banco: 'agente', sql: "delete from bt_unidades where id = 'b'", motivo: 'não pode' }), /segredo/);
  });

  it('linha mudou entre a prévia e a confirmação: nada é gravado e o código se gasta', async () => {
    await sql("insert into bt_msgs (texto) values ('concorrente')");
    const p = await prepararEscrita(ctx, QUEM, { banco: 'agente', sql: "update bt_msgs set texto = 'meu' where texto like 'conc%' or texto = 'mexida'", motivo: 'corrida de teste' });
    await sql("update bt_msgs set texto = 'mexida'");
    await assert.rejects(confirmarEscrita(ctx, QUEM, { confirmacao: p.confirmacao }), /mudaram desde a prévia/);
    assert.deepEqual(await ler('select texto from bt_msgs'), [{ texto: 'mexida' }]);
    assert.equal((await ler('select count(*)::int as n from mcp_banco_alteracoes where tabela = $1 and motivo = $2', 'bt_msgs', 'corrida de teste'))[0]!.n, 0);
    await sql('delete from bt_msgs');
  });

  it('desfazer recusa quando alguém mexeu na linha depois da escrita', async () => {
    await sql("insert into bt_msgs (texto) values ('origem')");
    const p = await prepararEscrita(ctx, QUEM, { banco: 'agente', sql: "update bt_msgs set texto = 'alterado' where texto = 'origem'", motivo: 'divergência de teste' });
    const c = await confirmarEscrita(ctx, QUEM, { confirmacao: p.confirmacao });
    await sql("update bt_msgs set texto = 'de outra pessoa'");
    await assert.rejects(prepararDesfazer(ctx, QUEM, { alteracao: c.registro }), /mudou depois desta alteração/);
    await sql('delete from bt_msgs');
  });

  it('teto de 200 linhas: o WHERE largo é recusado sem gravar; o comando que passa do teto também', async () => {
    await sql("insert into bt_msgs (texto) select 'm' || g from generate_series(1, 201) g");
    await assert.rejects(prepararEscrita(ctx, QUEM, { banco: 'agente', sql: "update bt_msgs set texto = 'x' where true", motivo: 'largo demais' }), /200 linhas/);
    await assert.rejects(prepararEscrita(ctx, QUEM, { banco: 'agente', sql: "insert into bt_msgs (texto) select 'y'", motivo: 'não deve' }), /./);
    await assert.rejects(prepararEscrita(ctx, QUEM, { banco: 'agente', sql: "insert into bt_msgs (texto) values ('a') ".concat(', (\'b\')'.repeat(200)), motivo: 'insert de 201' }), /200 linhas|teto por escrita é 200/);
    assert.equal((await ler("select count(*)::int as n from bt_msgs where texto like 'm%'"))[0]!.n, 201);
    assert.equal((await ler("select count(*)::int as n from bt_msgs where texto in ('a', 'b', 'x', 'y')"))[0]!.n, 0);
    await sql('delete from bt_msgs');
  });

  it('o banco ainda recusa o que o parser deixaria passar: violação de chave volta como erro e a tabela fica como estava', async () => {
    await assert.rejects(prepararEscrita(ctx, QUEM, { banco: 'agente', sql: "insert into bt_unidades (id, nome) values ('a', 'duplicada')", motivo: 'chave repetida' }), /\(23505\)|already exists/i);
    assert.equal((await ler("select nome from bt_unidades where id = 'a'"))[0]!.nome, 'Alfa');
  });

  it('apagar em tabela com FK em cascata é recusado (o backup não guarda as filhas); apagar a filha vale', async () => {
    await sql("insert into bt_pai values (1, 'p')");
    await sql("insert into bt_filha values (1, 1, 'f')");
    await assert.rejects(prepararEscrita(ctx, QUEM, { banco: 'agente', sql: 'delete from bt_pai where id = 1', motivo: 'cascata de teste' }), /cascata/);
    const p = await prepararEscrita(ctx, QUEM, { banco: 'agente', sql: 'delete from bt_filha where id = 1', motivo: 'apagar só a filha' });
    await confirmarEscrita(ctx, QUEM, { confirmacao: p.confirmacao });
    assert.equal((await ler('select count(*)::int as n from bt_pai'))[0]!.n, 1);
    await sql('delete from bt_pai');
  });

  it('o registro e a auditoria do conector só se leem (nem a trilha nem o backup se forjam por aqui)', async () => {
    for (const s of ["update mcp_banco_alteracoes set tipo = 'delete' where id = 'x'", "delete from mcp_banco_alteracoes where id = 'x'", "insert into mcp_banco_alteracoes (id, banco, usuario_id, usuario_email, tipo, tabela, sql_texto, motivo, linhas, chaves) values ('bk-forjado', 'agente', 'u', 'e', 'delete', 'bt_msgs', 'x', 'm', 1, '[]')"]) {
      await assert.rejects(prepararEscrita(ctx, QUEM, { banco: 'agente', sql: s, motivo: 'forjar trilha' }), /só se lê/);
    }
    assert.equal((await consultarBanco(ctx, QUEM, { banco: 'agente', sql: 'select count(*) as n from mcp_banco_alteracoes' })).linhasDevolvidas, 1);
  });

  it('tabela criada agora, com coluna de segredo, já é lida sem ela (o mapa é relido a cada chamada)', async () => {
    await sql("create table bt_novo (id text primary key, nome text, api_key text, \"refreshToken\" text)");
    await sql("insert into bt_novo values ('1', 'n', 'sk-novo', 'rt-novo')");
    const r = await consultarBanco(ctx, QUEM, { banco: 'agente', sql: 'select * from bt_novo' });
    assert.deepEqual(r.colunas, ['id', 'nome']);
    assert.ok(!JSON.stringify(r).includes('sk-novo') && !JSON.stringify(r).includes('rt-novo'));
    await assert.rejects(consultarBanco(ctx, QUEM, { banco: 'agente', sql: 'select "refreshToken" from bt_novo' }), /segredo/);
    await assert.rejects(prepararEscrita(ctx, QUEM, { banco: 'agente', sql: "update bt_novo set \"refreshToken\" = 'x' where id = '1'", motivo: 'camelCase' }), /segredo/);
  });

  it('DDL, tabela sem chave, view, segredo e esquema de fora ficam fechados também na escrita', async () => {
    for (const s of ['drop table bt_msgs', 'truncate bt_msgs', "update bt_sem_chave set a = 1 where a = 2", "update bt_visao set id = 'z' where id = 'a'", "update kommo_web_sessions set id = 'x' where id = 's1'", "update bt_unidades set openai_api_key = 'x' where id = 'a'", "update outro.bt_x set id = 1 where id = 2", "delete from bt_msgs where id = 1; drop table bt_msgs"]) {
      await assert.rejects(prepararEscrita(ctx, QUEM, { banco: 'agente', sql: s, motivo: 'burla de teste' }), /./, s);
    }
    assert.equal((await ler("select count(*)::int as n from kommo_web_sessions"))[0]!.n, 1);
  });
});
