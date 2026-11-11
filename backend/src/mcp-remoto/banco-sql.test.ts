import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analisarEscrita,
  analisarLeitura,
  criarCatalogo,
  montarLeitura,
  sqlAntes,
  sqlApagarPorChave,
  sqlExecutar,
  sqlPorChave,
  sqlReinserir,
  sqlRestaurarLinha,
  tokenizar,
  type TabelaCat,
} from './banco-sql.js';

const t = (nome: string, colunas: string[], chave: string[] = ['id'], visao = false): TabelaCat => ({ nome, colunas, chave, visao });

const CAT = criarCatalogo(
  [
    t('units', ['id', 'slug', 'name', 'kommo_access_token', 'openai_api_key', 'spine_token', 'is_active']),
    t('users', ['id', 'email', 'name', 'password_hash']),
    t('conversations', ['id', 'lead_id', 'phone', 'status']),
    t('llm_calls', ['id', 'prompt_tokens', 'total_tokens']),
    t('chaves_de_integracao', ['id', 'provedor', 'chave_cifrada']),
    t('mcp_oauth_tokens', ['id', 'token_hash']),
    t('bling_conexoes', ['id', 'client_secret', 'access_token']),
    t('kommo_web_sessions', ['id', 'session_id', 'refresh_token']),
    t('sem_chave', ['a', 'b'], []),
    t('so_segredo', ['id', 'token'], ['id']),
    t('v_resumo', ['id', 'total'], [], true),
    t('rh_docs', ['id', 'col', 'data']),
  ],
  ['public', 'outro_esquema', 'rh'],
  ['minha_funcao'],
);

const ok = (sql: string) => analisarLeitura(sql, CAT);
const nega = (sql: string, padrao?: RegExp) => assert.throws(() => analisarLeitura(sql, CAT), padrao ?? /./, sql.slice(0, 120));
const okW = (sql: string) => analisarEscrita(sql, CAT);
const negaW = (sql: string, padrao?: RegExp) => assert.throws(() => analisarEscrita(sql, CAT), padrao ?? /./, sql.slice(0, 120));

// ------------------------------------------------------------------ tokens

test('tokenizar: texto, nome entre aspas, $$ e comentário não viram comando', () => {
  const toks = tokenizar(`select 'a;b', "x;y", $$ z;w $$, $tag$ ; $tag$ /* ; */ from t -- ; drop`);
  assert.ok(!toks.some((x) => x.tipo === 'pt' && x.v === ';'));
  assert.equal(toks.filter((x) => x.tipo === 'str').length, 3);
  assert.equal(toks.filter((x) => x.tipo === 'qid').length, 1);
});

test('tokenizar: E\'…\' aceita \\\' sem fechar o texto; texto comum não', () => {
  assert.equal(tokenizar("select E'a\\';b'").filter((x) => x.tipo === 'str').length, 1);
  // sem o E, a barra não escapa: o texto fecha em 'a\' e o resto (;b') vira SQL solto
  assert.throws(() => tokenizar("select 'a\\';b'"), /sem fechar/);
});

test('tokenizar: o que não fecha ou esconde nome é recusado', () => {
  for (const ruim of ["select 'abc", 'select "abc', 'select /* abc', 'select $$ abc', 'select $1', 'select U&"\\0041"', "select U&'\\0041'", 'select ""', 'select 1\u0000']) {
    assert.throws(() => tokenizar(ruim), /./, ruim);
  }
});

test('tokenizar: comentário aninhado do Postgres', () => {
  assert.equal(tokenizar('select /* a /* b */ c */ 1').length, 2);
});

// ------------------------------------------------------------------ leitura: o que passa

test('leitura: SELECT simples, WITH, parênteses, ; final, comentário nas pontas', () => {
  assert.equal(ok('select slug from units').sql, 'select slug from units');
  assert.equal(ok('  SELECT 1;  ').sql, 'SELECT 1');
  assert.equal(ok('/* oi */ select 1 -- fim').sql, 'select 1');
  assert.equal(ok('with a as (select 1 as x) select * from a').sql, 'with a as (select 1 as x) select * from a');
  assert.ok(ok('(select 1) union (select 2)'));
  assert.ok(ok("select '; drop table units; --' as t"));
  assert.ok(ok('select $$a; b$$'));
  assert.ok(ok("select E'a\\';b'"));
  assert.ok(ok('select count(*), sum(prompt_tokens) from llm_calls'));
});

test('leitura: palavra de escrita DENTRO de texto ou nome entre aspas é só dado', () => {
  assert.ok(ok("select * from conversations where status = 'delete from x'"));
  assert.ok(ok('select 1 as "update"'));
});

// ------------------------------------------------------------------ leitura: burlas

test('leitura: mais de um comando, em todas as formas', () => {
  for (const s of ['select 1; select 2', 'select 1; drop table units', 'select 1 /* ; */; delete from units', 'select 1 -- x\n; delete from units', "select 1;\n;", 'select 1;;', ';select 1', 'select 1 ; -- c\n select 2']) nega(s, /um comando só|sem fechar|vazio|SELECT/);
});

test('leitura: só SELECT/WITH abre o comando', () => {
  for (const s of ['drop table units', 'delete from units', "update units set name = 'x'", 'insert into units (id) values (1)', 'truncate units', 'create table x (a int)', 'alter table units add b int', 'grant all on units to public',
    'copy units to stdout', "copy (select 1) to program 'id'", 'set role postgres', 'set session authorization postgres', 'reset all', 'begin', 'commit', 'rollback', 'savepoint a',
    "do $$ begin perform 1; end $$", 'call x()', 'execute foo', 'explain analyze delete from units', 'vacuum', 'lock table units', 'listen x', "notify x, 'y'", 'values (1)', 'table units', 'show all', 'analyze units', 'refresh materialized view v', 'prepare p as select 1', 'declare c cursor for select 1']) nega(s);
});

test('leitura: escrita escondida dentro de WITH/SELECT', () => {
  nega('with d as (delete from conversations returning *) select * from d');
  nega("with i as (insert into conversations (id) values ('1') returning *) select * from i");
  nega("with u as (update conversations set status = 'x' returning *) select * from u");
  nega('select * into novo from conversations');
  nega('select * from conversations for update');
  nega('select * from conversations for share');
  nega('with m as (merge into conversations using x on true when matched then delete) select 1');
});

test('leitura: função perigosa, em qualquer grafia', () => {
  for (const s of [
    "select pg_read_file('/etc/passwd')", "select pg_read_binary_file('/etc/passwd')", "select pg_ls_dir('.')", "select pg_stat_file('/etc/passwd')", 'select pg_sleep(60)', 'select pg_terminate_backend(1)', 'select pg_cancel_backend(1)',
    'select pg_advisory_lock(1)', "select pg_notify('a','b')", 'select pg_reload_conf()', 'select pg_switch_wal()', "select pg_logical_emit_message(true,'a','b')", "select pg_read_file ('/etc/passwd')", "select PG_READ_FILE('/etc/passwd')",
    "select pg_read_file/**/('/etc/passwd')", "select pg_read_file\n('/etc/passwd')", "select \"pg_read_file\"('/etc/passwd')", "select public.pg_read_file('/etc/passwd')", "select pg_catalog.pg_read_file('/etc/passwd')",
    "select dblink('host=x','select 1')", "select dblink_exec('host=x','drop table a')", "select dblink_connect('x')", "select lo_import('/etc/passwd')", "select lo_export(1,'/tmp/x')", 'select lo_unlink(1)', 'select lo_get(1)', 'select lo_from_bytea(0, \'x\')',
    "select set_config('transaction_read_only','off',true)", "select set_config('role','postgres',false)", "select current_setting('server_version')", "select nextval('s')", "select setval('s',1)", "select currval('s')", 'select lastval()',
    "select query_to_xml('select * from chaves_de_integracao', true, false, '')", "select table_to_xml('units', true, false, '')", "select cursor_to_xml('c', 1, true, false, '')", "select schema_to_xml('public', true, false, '')", "select database_to_xml(true, false, '')",
    "select query_to_xmlschema('select 1', true, false, '')", "select * from ts_stat('select * from units')", 'select txid_current()',
  ]) nega(s);
});

test('leitura: SET ROLE e set_config não mudam a transação (o SET nem chega)', () => {
  nega('select 1 where true; set role postgres');
  nega("select 1; set transaction read write");
  nega("select (set_config('default_transaction_read_only','off',false))");
  nega('select 1 offset 0 set');
});

test('leitura: catálogo do sistema, information_schema e outros esquemas', () => {
  for (const s of ['select * from pg_authid', 'select * from pg_shadow', 'select * from pg_user_mapping', 'select * from pg_stat_activity', 'select * from pg_catalog.pg_class', 'select * from pg_roles', 'select * from pg_settings',
    'select * from information_schema.columns', 'select * from INFORMATION_SCHEMA.tables', 'select * from outro_esquema.units', 'select * from rh.units', 'select * from "outro_esquema"."units"', 'select * from pg_largeobject', 'select * from pg_temp.x', 'select * from pg_toast.x']) nega(s);
  assert.ok(ok('select pg_typeof(1)'));
  assert.ok(ok('select pg_size_pretty(1024)'));
});

test('leitura: função criada no banco não é chamada daqui', () => {
  nega('select minha_funcao(1)', /função do banco/);
  assert.ok(ok('select 1 as minha_funcao'));
});

test('leitura: tabela de segredo — direta, entre aspas, com esquema, por apelido, em subconsulta, em CTE', () => {
  for (const s of [
    'select * from chaves_de_integracao', 'select * from "chaves_de_integracao"', 'select * from public.chaves_de_integracao', 'select * from public . "Chaves_De_Integracao"', 'select * from PUBLIC."CHAVES_DE_INTEGRACAO"',
    'select k.* from chaves_de_integracao k', 'select k.chave_cifrada from chaves_de_integracao as k', 'select * from mcp_oauth_tokens', 'select count(*) from mcp_oauth_tokens', 'select * from (select * from bling_conexoes) x',
    'with x as (select * from kommo_web_sessions) select * from x', 'select * from units u join chaves_de_integracao c on c.id = u.id', 'select (select count(*) from mcp_oauth_tokens)', 'select * from mcp_oauth_clients', 'select * from mcp_oauth_codigos',
    'select * from kommo_chat_sessions', 'select * from sessoes_de_usuario', 'select * from tokens_oauth', 'select * from cofre_de_chaves', 'select * from credenciais', 'select * from segredos',
    'select row_to_json(c) from chaves_de_integracao c', 'select to_jsonb(t) from so_segredo t', "select 1 from conversations where exists (select 1 from bling_conexoes)",
  ]) nega(s);
});

test('leitura: coluna de segredo — por nome, apelido, entre aspas e maiúscula', () => {
  for (const s of ['select kommo_access_token from units', 'select u.openai_api_key from units u', 'select "KOMMO_ACCESS_TOKEN" from units', 'select password_hash from users', 'select spine_token from units', 'select client_secret from bling_conexoes',
    'select 1 as senha', 'select token from x', 'select * from units where openai_api_key is not null', 'select count(*) filter (where kommo_access_token is null) from units', 'select refresh_token from x', 'select u.PASSWORD_HASH from users u']) nega(s);
  // contagem de tokens de LLM não é segredo
  assert.ok(ok('select sum(prompt_tokens), sum(total_tokens) from llm_calls'));
});

test('leitura: texto que aponta para convite de acesso (token guardado como linha)', () => {
  nega("select * from rh_docs where col = 'acesso_convites'");
  nega("select * from rh_docs where col = 'ACESSO_CONVITES'");
  assert.ok(ok("select * from rh_docs where col = 'funcionarios'"));
});

test('leitura: entradas inválidas', () => {
  for (const s of ['', '   ', '-- só comentário', '/* nada */', ';', 'select 1)', 'select (1', 'select 1) as x union select * from (select 2', 'x'.repeat(20_001)]) nega(s);
  for (const s of [undefined, null, 5, {}, ['select 1']]) assert.throws(() => analisarLeitura(s, CAT), /sql vazio/);
});

// ------------------------------------------------------------------ leitura: invólucro das tabelas com coluna de segredo

test('leitura: tabela com coluna de segredo é lida por um invólucro sem elas (select * e linha inteira)', () => {
  const a = ok('select * from units');
  assert.deepEqual(a.restritas.map((x) => x.nome), ['units']);
  const sql = montarLeitura(a, 501);
  assert.match(sql, /^WITH "units" AS NOT MATERIALIZED \(SELECT "id", "slug", "name", "is_active" FROM public\."units"\) SELECT \* FROM \(/);
  assert.ok(!/kommo_access_token|openai_api_key|spine_token/.test(sql));
  assert.match(sql, /LIMIT 501$/);
  const b = ok('select row_to_json(u) from users u where u.email like \'%@x\'');
  assert.match(montarLeitura(b, 10), /"users" AS NOT MATERIALIZED \(SELECT "id", "email", "name" FROM public\."users"\)/);
  assert.equal(ok('select count(*) from conversations').restritas.length, 0);
  assert.ok(!montarLeitura(ok('select count(*) from conversations'), 10).startsWith('WITH'));
});

test('leitura: a tabela restrita não pode ser chamada pelo esquema (fugiria do invólucro)', () => {
  nega('select * from public.units', /não qualifique/);
  nega('select * from public . "units"', /não qualifique/);
  nega('select public.users.email from users', /não qualifique/);
  assert.ok(ok('select units.slug from units'));
});

test('leitura: o comentário final não engole o fecho do invólucro', () => {
  const a = ok('select 1 as a -- tchau');
  assert.equal(montarLeitura(a, 5), 'SELECT * FROM (\nselect 1 as a\n) AS _q LIMIT 5');
  const b = ok('select 1 as a, -- meio\n 2 as b');
  assert.match(montarLeitura(b, 5), /\n\) AS _q LIMIT 5$/);
});

// ------------------------------------------------------------------ escrita: o que passa

test('escrita: INSERT, UPDATE e DELETE simples', () => {
  const i = okW("insert into conversations (id, lead_id, phone) values ('1', '10', '55'), ('2', '11', '56');");
  assert.equal(i.tipo, 'insert');
  assert.equal(i.tabela.nome, 'conversations');
  assert.deepEqual(i.colunas, ['id', 'lead_id', 'phone']);
  const u = okW("update conversations set status = 'fechada', phone = null where id = '1' and lead_id in (select lead_id from conversations where status = 'x')");
  assert.equal(u.tipo, 'update');
  assert.deepEqual(u.colunas, ['status', 'phone']);
  assert.equal(u.condicao?.trim(), "id = '1' and lead_id in (select lead_id from conversations where status = 'x')");
  const d = okW("DELETE FROM conversations WHERE id = 'a;b' -- fim");
  assert.equal(d.tipo, 'delete');
  assert.equal(d.condicao?.trim(), "id = 'a;b'");
  assert.ok(okW('update units set name = lower(name), is_active = true where id = $$x$$'));
  assert.ok(okW('insert into conversations (id, phone) values (gen_random_uuid()::text, (select max(phone) from conversations))'));
});

test('escrita: tabela restrita (com coluna de segredo) aceita INSERT/UPDATE nas colunas boas', () => {
  assert.ok(okW("update units set name = 'x' where id = '1'"));
  assert.ok(okW("insert into units (id, slug, name) values ('1', 's', 'n')"));
});

// ------------------------------------------------------------------ escrita: burlas

test('escrita: DDL e outros verbos não existem', () => {
  for (const s of ['drop table conversations', 'alter table conversations add x int', 'truncate conversations', 'create table x (a int)', 'grant all on conversations to public', 'copy conversations from stdin', 'set role postgres', 'select 1', 'merge into conversations using x on true when matched then delete', 'with x as (select 1) delete from conversations where id = 1',
    'create index i on conversations (id)', 'comment on table conversations is \'x\'', 'revoke all on conversations from public', 'vacuum conversations', 'do $$ begin delete from conversations; end $$', 'call p()']) negaW(s);
});

test('escrita: vários comandos num só', () => {
  for (const s of ["delete from conversations where id = '1'; drop table conversations", "delete from conversations where id = '1'; delete from conversations where id = '2'", "update conversations set status = 'x' where id = '1';;", "delete from conversations where id = '1' /* ; */; truncate conversations", "delete from conversations where id = '1'\n;-- c\ndelete from conversations"]) negaW(s, /um comando só|sem fechar/);
});

test('escrita: UPDATE e DELETE exigem WHERE de verdade', () => {
  negaW('update conversations set status = 1', /sem WHERE/);
  negaW('delete from conversations', /sem WHERE/);
  negaW('delete from conversations where', /sem WHERE/);
  negaW("update conversations set status = 'x' /* where id = 1 */", /sem WHERE/);
  negaW("update conversations set status = 'x' -- where id = 1", /sem WHERE/);
  negaW("update conversations set status = (select 1 from conversations where id = '1')", /sem WHERE/);
  negaW("update conversations set status = 'where'", /sem WHERE/);
});

test('escrita: formas fora da lista são recusadas', () => {
  for (const s of [
    "insert into conversations (id) values ('1') returning *", "insert into conversations (id) values ('1') on conflict do nothing", "insert into conversations (id) select id from conversations", 'insert into conversations default values', "insert into conversations values ('1')",
    "insert into conversations (id) values ('1'), ", "insert into conversations (id, id) values ('1', '2')", "insert into conversations (id) values", "insert into conversations (nao_existe) values ('1')", "insert conversations (id) values ('1')", "insert into public.conversations (id) values ('1')",
    "update conversations c set status = 'x' where c.id = '1'", "update conversations set status = 'x' from llm_calls where conversations.id = llm_calls.id", "update conversations set status = 'x' where id = '1' returning *", "update conversations set (status, phone) = ('a', 'b') where id = '1'",
    "update only conversations set status = 'x' where id = '1'", "update public.conversations set status = 'x' where id = '1'", "update conversations set nao_existe = 'x' where id = '1'", "update conversations set id = '9' where id = '1'", "update conversations set status = 'x', where id = '1'",
    "delete from conversations c where c.id = '1'", "delete from conversations using llm_calls where conversations.id = llm_calls.id", "delete from conversations where id = '1' returning *", "delete conversations where id = '1'", "delete from public.conversations where id = '1'",
    "update conversations set status = 'x' join llm_calls on true where id = '1'",
  ]) negaW(s);
});

test('escrita: tabela sem chave, view, inexistente ou de segredo', () => {
  negaW("update sem_chave set a = 1 where b = 2", /chave primária/);
  negaW("insert into sem_chave (a) values (1)", /chave primária/);
  negaW("update v_resumo set total = 1 where id = 1", /view/);
  negaW("update nao_existe set a = 1 where id = 1", /não existe/);
  negaW("update chaves_de_integracao set provedor = 'x' where id = '1'", /segredo/);
  negaW("delete from chaves_de_integracao where id = '1'", /segredo/);
  negaW("insert into mcp_oauth_tokens (id) values ('1')", /segredo/);
  negaW("update bling_conexoes set client_id = 'x' where id = '1'");
  negaW("update kommo_web_sessions set id = 'x' where id = '1'");
  negaW("update so_segredo set id = 'x' where id = '1'");
});

test('escrita: coluna de segredo — leitura no WHERE, escrita no SET/VALUES, por apelido ou maiúscula', () => {
  negaW("update units set kommo_access_token = 'x' where id = '1'", /segredo/);
  negaW("update units set name = 'x' where openai_api_key = 'k'", /segredo/);
  negaW("update units set \"OPENAI_API_KEY\" = 'x' where id = '1'", /segredo/);
  negaW("insert into units (id, spine_token) values ('1', 't')", /segredo/);
  negaW("update users set password_hash = 'x' where id = '1'", /segredo/);
  negaW("update users set name = (select password_hash from users limit 1) where id = '1'", /segredo/);
  negaW("update conversations set status = (select kommo_access_token from units limit 1) where id = '1'", /segredo/);
});

test('escrita: tabela com coluna de segredo só aparece como alvo, uma vez', () => {
  negaW("update units set name = (select name from units where id = '2') where id = '1'", /segredo|alvo/);
  negaW("update conversations set status = (select u from units u limit 1) where id = '1'", /alvo|segredo/);
  negaW("update units set name = 'x' where units.id = '1'", /alvo|segredo/);
  negaW("delete from units where id = '1'", /segredo/);
  negaW("delete from users where id = '1'", /segredo/);
  assert.ok(okW("update conversations set status = (select max(id) from llm_calls) where id = '1'"));
});

test('escrita: função perigosa e palavra de sessão dentro do valor', () => {
  negaW("update conversations set status = nextval('s')::text where id = '1'");
  negaW("update conversations set status = pg_sleep(10)::text where id = '1'");
  negaW("update conversations set status = set_config('role', 'x', false) where id = '1'");
  negaW("insert into conversations (id) values (lo_import('/etc/passwd')::text)");
  negaW("insert into conversations (id) values (current_setting('x'))");
  negaW("update conversations set status = (select query_to_xml('select * from chaves_de_integracao', true, false, '')::text) where id = '1'");
  negaW("update conversations set status = 'x' where id = (select id from pg_authid)");
  negaW("update conversations set status = 'x' where id = '1' and exists (delete from conversations)");
});

// ------------------------------------------------------------------ montagem do SQL de escrita

test('SQL de escrita: nomes vêm do catálogo, só colunas boas, FOR UPDATE só quando pedido', () => {
  const p = okW("update units set name = 'x' where id = '1'");
  const a = sqlAntes(p, 200, false);
  assert.match(a, /^SELECT "id"::text AS "__pk0", to_jsonb\("units"\)::text AS "__linha" FROM \(SELECT "id", "slug", "name", "is_active" FROM public\."units"\) AS "units" WHERE \(\n/);
  assert.match(a, /\) LIMIT 201$/);
  assert.ok(!/FOR UPDATE/.test(a));
  assert.match(sqlAntes(p, 200, true), /LIMIT 201 FOR UPDATE$/);
  assert.ok(!/kommo_access_token|openai_api_key/.test(a + sqlAntes(p, 200, true)));
  assert.equal(sqlExecutar(p), "update units set name = 'x' where id = '1'\nRETURNING \"id\"::text AS \"__pk0\"");
  const t1 = CAT.tabelas.get('units')!;
  assert.match(sqlPorChave(t1, 2), /WHERE \("id"::text\) IN \(\(\$1\), \(\$2\)\)$/);
  assert.match(sqlRestaurarLinha(t1), /^UPDATE public\."units" SET "slug" = _r\."slug", "name" = _r\."name", "is_active" = _r\."is_active" FROM jsonb_populate_record\(NULL::public\."units", \$1::jsonb\) AS _r WHERE/);
  assert.ok(!/kommo_access_token/.test(sqlRestaurarLinha(t1) + sqlReinserir(t1)));
  assert.match(sqlApagarPorChave(t1, 1), /^DELETE FROM public\."units" WHERE \("id"::text\) IN \(\(\$1\)\) RETURNING/);
});

test('SQL de escrita: o WHERE é embrulhado em parênteses (OR não escapa do filtro) e o comentário final não existe', () => {
  const p = okW("delete from conversations where id = '1' or status = 'x' -- fim");
  assert.match(sqlAntes(p, 5, false), /WHERE \(\n id = '1' or status = 'x'\n\) LIMIT 6$/);
  assert.equal(sqlExecutar(p).split('\n')[0], "delete from conversations where id = '1' or status = 'x'");
});
