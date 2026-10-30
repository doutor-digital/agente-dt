// As regras de estrutura (parser real do Postgres). O MESMO arquivo de regras e o MESMO conjunto de casos (estrutura-casos.json) existem no
// sistemas-dd (src/estrutura-regras.ts, test/estrutura-regras.test.ts): o hash abaixo trava o arquivo, e se um lado mudar o outro tem de mudar igual.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { analisarEstrutura, ErroEstrutura, MAX_COMANDOS, MAX_SQL } from './estrutura-regras.js';

const HASH_DOS_CASOS = '1e88d719b7c1989f77bf685438b5ca2f57bc475c8da24934306324534b259dbe';
const HASH_DAS_REGRAS = '9109fce60f66355c5bacb9ff82693e8d78022754922f55041beb2f7d248b70e4';

interface Caso {
  sql: string;
  esperado: 'aceita' | 'recusa';
  nota: string;
  sintaxe?: boolean;
}
const casos = JSON.parse(readFileSync(new URL('./estrutura-casos.json', import.meta.url), 'utf8')) as Caso[];

test('o arquivo de regras é o mesmo nos dois repositórios (hash travado; mudou aqui, mude no sistemas-dd igual)', () => {
  const h = createHash('sha256').update(readFileSync(new URL('./estrutura-regras.ts', import.meta.url))).digest('hex');
  assert.equal(h, HASH_DAS_REGRAS, 'estrutura-regras.ts mudou: copie para ~/sistemas-dd/src/estrutura-regras.ts e atualize o hash nos DOIS testes');
});

interface CasoCompleto extends Caso {
  astSozinho?: 'aceita' | 'recusa';
}

/** `semMarcas`: só as regras por ÁRVORE (sem a recusa de comentário/aspas/$/E'…'): prova que o parser sozinho já barra os ataques. */
function conferir(semMarcas: boolean): string[] {
  const erros: string[] = [];
  for (const c of casos as CasoCompleto[]) {
    const esperado = semMarcas ? (c.astSozinho ?? c.esperado) : c.esperado;
    let msg: string | null = null;
    try {
      analisarEstrutura(c.sql, { semMarcas });
    } catch (e) {
      if (!(e instanceof ErroEstrutura)) throw e;
      msg = e.message;
    }
    if (esperado === 'aceita' && msg !== null) erros.push(`DEVIA ACEITAR: ${c.sql.slice(0, 100)} [${c.nota}] -> ${msg.slice(0, 100)}`);
    if (esperado === 'recusa' && msg === null) erros.push(`DEVIA RECUSAR: ${c.sql.slice(0, 100)} [${c.nota}]`);
    // recusa por erro de sintaxe não prova nada: só vale nos casos marcados
    if (esperado === 'recusa' && msg !== null && !c.sintaxe && /não é válido para o Postgres|^sql vazio/.test(msg)) erros.push(`ataque inválido (sintaxe), não prova nada: ${c.sql.slice(0, 100)} [${c.nota}]`);
  }
  return erros;
}

test('o conjunto de casos também é o mesmo nos dois repositórios (hash travado)', () => {
  const h = createHash('sha256').update(readFileSync(new URL('./estrutura-casos.json', import.meta.url))).digest('hex');
  assert.equal(h, HASH_DOS_CASOS, 'estrutura-casos.json mudou: copie para ~/sistemas-dd/test/estrutura-casos.json e atualize o hash nos DOIS testes');
});

test(`conjunto de casos (${casos.length}): todos os ataques das revisões recusados, todos os legítimos aceitos`, () => {
  assert.ok(casos.length > 250);
  assert.deepEqual(conferir(false), []);
});

test('as regras por ÁRVORE sozinhas (sem a recusa de comentário/aspas/$/E) já barram todos os ataques e aceitam os legítimos', () => {
  assert.deepEqual(conferir(true), []);
});

const recusa = (sql: string, re: RegExp) => assert.throws(() => analisarEstrutura(sql), (e: Error) => e instanceof ErroEstrutura && re.test(e.message), sql);

test('as mensagens dizem o que reescrever', () => {
  recusa('drop table caixa', /DROP não existe/);
  recusa('truncate caixa', /TRUNCATE não existe/);
  recusa('create table x as select * from caixa', /CREATE TABLE AS .* não é permitido/);
  recusa('create table x (a int) inherits (caixa)', /"inhRelations" não é permitida|opção/);
  recusa('alter table caixa alter column v type int using 1', /USING não é permitido/);
  recusa('delete from caixa', /apagar dados não passa por aqui/);
  recusa('select 1', /consultar dados/);
  recusa('create view v as select * from caixa', /security_invoker = true/);
  recusa('create policy p on caixa using (true)', /precisa dizer para quem vale/);
  recusa('create policy p on caixa to anon using (true)', /TO authenticated/);
  recusa('grant select on caixa to public', /TO authenticated|use "TO authenticated"|precisa dizer/);
  recusa('grant all on caixa to authenticated', /ALL|privilégios/);
  recusa('alter table caixa add constraint c check (f() > 0)', /função "f" não é permitida/);
  recusa('alter table caixa add constraint c check (public.rh_merge(1) > 0)', /função "public.rh_merge" não é permitida/);
  recusa('alter table caixa add constraint c check ((select 1) > 0)', /subconsulta/);
  recusa('create table t (a int default current_user)', /CURRENT_USER não é permitido/);
  recusa('create table t (a point)', /tipo "point" não é permitido/);
  recusa('create table auth.x (a int)', /só o esquema "public"/);
  recusa('alter table rh_usuarios add column x int', /tabela fechada/);
  recusa('create table x (a int) partition by range (a)', /partspec/);
  recusa('create temp table x (a int)', /temporária/);
  recusa('create index concurrently i on t (a)', /CONCURRENTLY/);
  recusa('alter table t alter column a drop default', /DROP DEFAULT/);
  recusa('create table t (a int', /não é válido para o Postgres/);
});

test('limites: vazio, só comentário, grande demais, comandos demais, entrada que não é texto', () => {
  recusa('', /sql vazio/);
  recusa('   ', /sql vazio/);
  recusa('-- nada', /comentário/);
  assert.throws(() => analisarEstrutura(undefined), ErroEstrutura);
  assert.throws(() => analisarEstrutura(42), ErroEstrutura);
  recusa(`comment on table caixa is '${'x'.repeat(MAX_SQL + 5)}'`, /grande demais/);
  recusa(Array.from({ length: MAX_COMANDOS + 1 }, (_, i) => `create table t${i} (a int)`).join(';'), /comandos demais/);
  assert.equal(analisarEstrutura(Array.from({ length: MAX_COMANDOS }, (_, i) => `create table t${i} (a int)`).join(';')).comandos.length, MAX_COMANDOS);
});

test('resumo e avisos vêm da árvore', () => {
  const tabela = analisarEstrutura(
    [
      'create table public.caixa_precos (id bigint generated by default as identity primary key, servico text not null, valor numeric(10,2) not null default 0)',
      'alter table public.caixa_precos enable row level security',
      'create policy precos_ver on public.caixa_precos for select to authenticated using (rh_admin())',
      'create index if not exists caixa_precos_servico_idx on public.caixa_precos (servico)',
      "comment on table public.caixa_precos is 'preços por serviço; v2'",
    ].join(';\n'),
  );
  assert.deepEqual(tabela.comandos.map((c) => c.tipo), ['CREATE TABLE', 'ALTER TABLE ENABLE RLS', 'CREATE POLICY', 'CREATE INDEX', 'COMMENT']);
  assert.match(tabela.comandos[0]!.o_que, /Cria a tabela caixa_precos/);
  assert.deepEqual(tabela.avisos, [], 'RLS ligada no mesmo pedido: sem aviso');

  const av = (sql: string) => analisarEstrutura(sql).avisos.join(' | ');
  assert.match(av('create table caixa_x (id int)'), /caixa_x nasce SEM segurança por linha/);
  assert.match(av('create table caixa_x (id int); alter table caixa_y enable row level security'), /caixa_x nasce SEM/);
  assert.match(av('alter table caixa_precos alter column valor type text'), /pode FALHAR/);
  assert.match(av('alter table caixa_precos add column z int not null'), /NOT NULL sem DEFAULT/);
  assert.equal(av('alter table caixa_precos add column z int not null default 0'), '');
  assert.equal(av('alter table caixa_precos add column z bigserial not null'), '');
  assert.match(av('alter table caixa_precos alter column valor set not null'), /SET NOT NULL falha/);
  assert.match(av('create policy p on caixa_precos to authenticated using (true)'), /permissiva/);
  assert.match(av('create policy p on caixa_precos to authenticated using (1 = 1)'), /permissiva/);
  assert.match(av('create policy p on caixa_precos to authenticated using (rh_admin()) with check (true)'), /permissiva/);
  assert.equal(av('create policy p on caixa_precos to authenticated using (rh_admin())'), '');
  assert.match(av('grant select on caixa_precos to authenticated'), /TODOS os usuários logados/);
  assert.equal(av('grant select on caixa_precos to service_role'), '');
});

test('o que o parser resolve e a regex nunca resolveria: aspas, comentário entre nome e ponto, escape unicode, maiúsculas, quebra de linha', () => {
  for (const sql of [
    'create view v with (security_invoker=true) as select * from "auth".users',
    'create view v with (security_invoker=true) as select * from auth/**/.users auth',
    'create view v with (security_invoker=true) as select * from auth -- c\n.users',
    'alter table "rh_usuarios" add column x int',
    'alter table PUBLIC.RH_USUARIOS add column x int',
    'alter table U&"rh\\005fusuarios" add column x int',
    'alter table\n\trh_usuarios\n\tadd column x int',
    "alter table caixa alter column v type int\nusing 1",
    "comment on table caixa is $a1$'$a1$; delete from caixa; comment on table caixa is 'x'",
    "comment on table caixa is '--'; delete from caixa",
    "comment on table caixa is e'\\''; delete from caixa; comment on table caixa is 'x'",
    'comment on table caixa is $$a$$; delete from caixa; comment on table caixa is $$b$$',
  ]) assert.throws(() => analisarEstrutura(sql, { semMarcas: true }), ErroEstrutura, sql);
});

test('comentário, aspas duplas, $ e E\'…\' são recusados de saída (e dizem o que fazer), mesmo quando o parser os entenderia', () => {
  recusa('-- cria\ncreate table t (a int)', /comentário/);
  recusa('create table t (a int) /* x */', /comentário/);
  recusa("comment on table caixa is 'a -- b'", /comentário/);
  recusa('create table "t" (a int)', /aspas duplas/);
  recusa('create table t (a text default $x$a$x$)', /"\$"/);
  recusa("create table t (a text default e'x')", /E'…'/);
  recusa("create table t (a text default U&'x')", /E'…'|U&/);
});

test('texto que parece comando continua sendo texto: ";", "delete", "--", $tag$ dentro de string legítima passam', () => {
  const c = analisarEstrutura("comment on table caixa is 'tabela; de preços; delete from x'");
  assert.equal(c.comandos.length, 1);
  assert.equal(analisarEstrutura("comment on table caixa is 'com ''aspas'' e ; delete from caixa'").comandos.length, 1);
  assert.equal(analisarEstrutura("create table e (a text default $a$;delete from caixa;$a$)", { semMarcas: true }).comandos.length, 1);
  assert.equal(analisarEstrutura("comment on table caixa is $a1$ com 'aspas' e ; $a1$", { semMarcas: true }).comandos.length, 1);
});
