// O classificador de SQL livre (parser real do Postgres). O MESMO arquivo de regras e o MESMO conjunto de casos (sql-casos.json) existem no
// sistemas-dd (src/sql-regras.ts, test/sql-regras.test.ts): os hashes abaixo travam os dois arquivos, e se um lado mudar o outro tem de mudar igual.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { classificar, ErroSql, MAX_COMANDOS, MAX_SQL } from './sql-regras.js';

const HASH_DOS_CASOS = 'd991fa5f4e902062f1889b8be4f3e63bb4a3dcd89d5e07d078a7496fec94078f';
const HASH_DAS_REGRAS = '79dbd2ae9bb4a318f79931bf725ca3e2557b057753dea2929c00c11a87396a94';

interface Caso {
  sql: string;
  esperado: 'direto' | 'confirmar' | 'recusa';
  nota: string;
  sintaxe?: boolean;
  /** Descontratos+Ficha; sem o campo é o RH */
  sistema?: 'rh' | 'dsc';
}
const casos = JSON.parse(readFileSync(new URL('./sql-casos.json', import.meta.url), 'utf8')) as Caso[];

test('o arquivo de regras é o mesmo nos dois repositórios (hash travado; mudou aqui, mude no sistemas-dd igual)', () => {
  const h = createHash('sha256').update(readFileSync(new URL('./sql-regras.ts', import.meta.url))).digest('hex');
  assert.equal(h, HASH_DAS_REGRAS, 'sql-regras.ts mudou: copie para ~/sistemas-dd/src/sql-regras.ts e atualize o hash nos DOIS testes');
});

test('o conjunto de casos também é o mesmo nos dois repositórios (hash travado)', () => {
  const h = createHash('sha256').update(readFileSync(new URL('./sql-casos.json', import.meta.url))).digest('hex');
  assert.equal(h, HASH_DOS_CASOS, 'sql-casos.json mudou: copie para ~/sistemas-dd/test/sql-casos.json e atualize o hash nos DOIS testes');
});

function resultado(sql: string, sistema: 'rh' | 'dsc' = 'rh'): { decisao: 'direto' | 'confirmar' | 'recusa'; msg: string } {
  try {
    return { decisao: classificar(sql, sistema).decisao, msg: '' };
  } catch (e) {
    if (!(e instanceof ErroSql)) throw e;
    return { decisao: 'recusa', msg: e.message };
  }
}

test(`conjunto de casos (${casos.length}): cada categoria roda direto, pede confirmação ou é recusada, e todos os furos de 30/10 caem`, () => {
  assert.ok(casos.length > 400);
  const erros: string[] = [];
  for (const c of casos) {
    const r = resultado(c.sql, c.sistema);
    if (r.decisao !== c.esperado) erros.push(`ESPERAVA ${c.esperado.toUpperCase()} e deu ${r.decisao.toUpperCase()}: ${c.sql.slice(0, 110)} [${c.nota}] ${r.msg.slice(0, 90)}`);
    // recusa por erro de sintaxe não prova nada: só vale nos casos marcados
    if (c.esperado === 'recusa' && r.decisao === 'recusa' && !c.sintaxe && /não é válido para o Postgres/.test(r.msg)) erros.push(`ataque inválido (sintaxe), não prova nada: ${c.sql.slice(0, 110)} [${c.nota}]`);
  }
  assert.deepEqual(erros, []);
});

test('cada categoria do pedido tem caso: direto, confirmar e recusa', () => {
  const tipos = (e: Caso['esperado']) => new Set(casos.filter((c) => c.esperado === e).flatMap((c) => classificarOuNada(c.sql, c.sistema)));
  const direto = tipos('direto');
  for (const t of ['CREATE TABLE', 'CREATE TABLE AS', 'CREATE VIEW', 'CREATE MATERIALIZED VIEW', 'CREATE INDEX', 'CREATE FUNCTION', 'CREATE TRIGGER', 'CREATE POLICY', 'ALTER POLICY', 'CREATE TYPE', 'CREATE SEQUENCE', 'ALTER TABLE ADD COLUMN', 'ALTER TABLE ADD CONSTRAINT', 'ALTER COLUMN TYPE', 'ALTER TABLE ENABLE RLS', 'COMMENT', 'GRANT', 'RENAME', 'INSERT', 'UPDATE', 'DELETE']) {
    assert.ok(direto.has(t), `falta caso direto de ${t}`);
  }
  const confirmar = tipos('confirmar');
  for (const t of ['DROP TABLE', 'DROP VIEW', 'DROP INDEX', 'DROP POLICY', 'DROP TRIGGER', 'DROP FUNCTION', 'DROP SEQUENCE', 'DROP TYPE', 'TRUNCATE', 'DELETE', 'UPDATE', 'ALTER TABLE DROP COLUMN', 'ALTER TABLE DROP CONSTRAINT', 'REVOKE', 'ALTER TABLE DISABLE RLS']) {
    assert.ok(confirmar.has(t), `falta caso que pede confirmação de ${t}`);
  }
});
function classificarOuNada(sql: string, sistema?: 'rh' | 'dsc'): string[] {
  try {
    return classificar(sql, sistema).comandos.map((c) => c.tipo);
  } catch {
    return [];
  }
}

/**
 * O que o parser resolve e a regex nunca resolveria: cada ataque recusado, reescrito com maiúsculas, quebras de linha e comentários entre
 * as palavras, continua recusado (quando continua sendo SQL válido).
 */
test('cada sistema tem as suas tabelas fechadas e as suas funções de acesso: o dsc não herda os nomes do RH nem o contrário', () => {
  const rh = (sql: string) => resultado(sql, 'rh').decisao;
  const dsc = (sql: string) => resultado(sql, 'dsc').decisao;
  assert.equal(rh('update caixa_lanc set a = 1 where id in (select id from dsc_usuarios)'), 'direto', 'no RH dsc_usuarios é uma tabela qualquer');
  assert.equal(dsc('update fichas set a = 1 where id in (select id from dsc_usuarios)'), 'recusa', 'no dsc ela é fechada');
  assert.equal(dsc('update fichas set a = 1 where id in (select id from rh_usuarios)'), 'direto', 'no dsc rh_usuarios não é nada');
  assert.equal(rh('alter table dsc_docs add column x int'), 'direto', 'dsc_docs só é núcleo no dsc');
  assert.equal(dsc('alter table rh_docs add column x int'), 'direto');
  assert.equal(rh('create policy p on caixa_lanc for select to authenticated using (dsc_admin())'), 'recusa', 'dsc_admin() não é função de acesso do RH');
  assert.equal(dsc('create policy p on fichas for select to authenticated using (dsc_admin())'), 'direto');
  assert.equal(dsc('create policy p on fichas for select to authenticated using (rh_admin())'), 'recusa');
  assert.throws(() => classificar('select 1', 'outro' as never), ErroSql);
  // a conferência de um não vaza para o outro
  assert.equal(rh('alter table rh_docs add column x int'), 'recusa');
});

test('os ataques recusados continuam recusados com maiúsculas, quebras de linha, tabulação e comentários entre as palavras', () => {
  const erros: string[] = [];
  let testados = 0;
  for (const c of casos.filter((x) => x.esperado === 'recusa' && !x.sintaxe && x.sql.trim().length > 0)) {
    const variantes = [
      c.sql.toUpperCase().includes("'") ? undefined : c.sql.toUpperCase(),
      c.sql.replace(/ /g, '\n\t'),
      c.sql.replace(/ /g, '/**/ /**/'),
      c.sql.replace(/ /g, ' -- c\n '),
      `/* abre */ ${c.sql} /* fecha */`,
      `${c.sql} ;`,
    ];
    for (const v of variantes) {
      if (v === undefined) continue;
      const r = resultado(v, c.sistema);
      // variante que virou SQL inválido não prova nada; variante válida tem de continuar recusada
      if (r.decisao === 'recusa') {
        testados++;
        continue;
      }
      erros.push(`virou ${r.decisao}: ${v.slice(0, 120).replace(/\n/g, '\\n')} [${c.nota}]`);
    }
  }
  assert.ok(testados > 1500, `variantes testadas: ${testados}`);
  assert.deepEqual(erros, []);
});

test('texto que parece comando continua sendo texto: ";", "delete", "--", $tag$ e aspas dentro de dado legítimo passam', () => {
  const a = classificar("insert into caixa_lanc (obs) values ('tabela; de preços; delete from rh_usuarios -- e /* isto */')");
  assert.equal(a.comandos.length, 1);
  assert.equal(a.decisao, 'direto');
  assert.equal(classificar("insert into caixa_lanc (obs) values ($a1$ com 'aspas' e ; delete from rh_usuarios $a1$)").comandos.length, 1);
  assert.equal(classificar("insert into caixa_lanc (obs) values (e'x\\'; delete from rh_usuarios; --')").comandos.length, 1);
  assert.equal(classificar("insert into caixa_lanc (obs) values ('auth.users'), ('rh_usuarios')").decisao, 'direto', 'um nome dentro de texto é dado, não objeto');
});

test('vários comandos: cada um vira um trecho, lido de novo dá a mesma árvore; a decisão é a do pior', () => {
  const a = classificar("create table caixa_a (id int); insert into caixa_a values (1); -- fim\n delete from caixa_a;");
  assert.equal(a.trechos.length, 3);
  assert.deepEqual(a.comandos.map((c) => `${c.tipo}:${c.acao}`), ['CREATE TABLE:direto', 'INSERT:direto', 'DELETE:confirmar']);
  assert.equal(a.decisao, 'confirmar');
  for (const t of a.trechos) assert.equal(classificar(t).comandos.length, 1);
  const ac = classificar('insert into caixa_x values (1); insert into caixa_x values (2); update caixa_x set a = 1 where b = 2');
  assert.equal(ac.decisao, 'direto');
  assert.deepEqual(ac.alvosDeEscrita, [{ n: 3, tabela: 'caixa_x', op: 'update' }]);
});

test('a análise diz o que o servidor precisa: snapshot, tabelas a copiar, tabelas e views criadas, renomeio', () => {
  const a = classificar('create table caixa_n (id int); create materialized view caixa_m as select 1; alter table caixa_lanc add column z int; update caixa_unidades set ativa = true where slug = $$x$$; alter table caixa_lanc rename column z to y');
  assert.equal(a.mudaEstrutura, true);
  assert.equal(a.mudaDados, true);
  assert.equal(a.precisaSnapshot, true);
  assert.deepEqual(a.tabelasCriadas, ['caixa_n']);
  assert.deepEqual(a.matviewsCriadas, ['caixa_m']);
  assert.deepEqual(a.tabelasParaCopiar.sort(), ['caixa_lanc', 'caixa_unidades']);
  assert.equal(a.renomeia, true);
  assert.ok(a.avisos.some((x) => /caixa_n nasce SEM segurança por linha/.test(x)));
  assert.ok(a.avisos.some((x) => /caixa_m não tem segurança por linha/.test(x)));
  const so = classificar("insert into caixa_lanc (valor) values (1)");
  assert.equal(so.precisaSnapshot, false, 'só INSERT: nada a copiar');
  assert.ok(a.avisos.length > 0);
  const rls = classificar('create table caixa_n (id int); alter table caixa_n enable row level security');
  assert.ok(rls.avisos.some((x) => /nasce com segurança por linha/.test(x)));
});

const recusa = (sql: string, re: RegExp) => assert.throws(() => classificar(sql), (e: Error) => e instanceof ErroSql && re.test(e.message), sql);

test('as mensagens dizem o que reescrever', () => {
  recusa('select 1', /sistemas_consultar/);
  recusa('create view v as select * from caixa_lanc', /security_invoker = true/);
  recusa('create policy p on caixa_lanc using (true)', /precisa dizer para quem vale/);
  recusa('create policy p on caixa_lanc to anon using (true)', /authenticated/);
  recusa('grant select on caixa_lanc to anon', /authenticated/);
  recusa('grant all on caixa_lanc to authenticated', /"ALL" não é permitido/);
  recusa("alter table caixa_lanc add constraint c check (f() > 0)", /função "f" não é permitida/);
  recusa("alter table caixa_lanc add constraint c check (public.rh_merge('a','b','{}') is not null)", /função "public.rh_merge" não é permitida/);
  recusa('create table t (a int default current_user)', /CURRENT_USER não é permitido/);
  recusa('create table t (a point)', /tipo "point" não é permitido/);
  recusa('create table auth.x (a int)', /só o esquema "public"/);
  recusa('alter table rh_usuarios add column x int', /tabela fechada/);
  recusa('alter table rh_docs add column x int', /núcleo do sistema/);
  recusa('create function f() returns void language sql security definer as $$ select 1 $$', /SECURITY DEFINER não é permitido/);
  recusa('create table t (a int', /não é válido para o Postgres/);
  recusa('set role postgres', /SET\/RESET/);
  recusa('copy caixa_lanc to $$/tmp/x$$', /COPY/);
  recusa('create extension pgcrypto', /extensão/);
  recusa('vacuum', /VACUUM/);
  recusa('begin', /BEGIN\/COMMIT/);
  recusa("create table x as with d as (delete from caixa_lanc returning *) select * from d", /dentro do WITH só SELECT/);
});

test('limites: vazio, só comentário, grande demais, comandos demais, entrada que não é texto', () => {
  recusa('', /sql vazio/);
  recusa('   ', /sql vazio/);
  recusa('-- nada', /sql vazio/);
  assert.throws(() => classificar(undefined), ErroSql);
  assert.throws(() => classificar(42), ErroSql);
  recusa(`comment on table caixa_lanc is '${'x'.repeat(MAX_SQL + 5)}'`, /grande demais/);
  recusa(Array.from({ length: MAX_COMANDOS + 1 }, (_, i) => `create table t${i} (a int)`).join(';'), /comandos demais/);
  assert.equal(classificar(Array.from({ length: MAX_COMANDOS }, (_, i) => `create table t${i} (a int)`).join(';')).comandos.length, MAX_COMANDOS);
});

test('WHERE sempre verdadeiro é detectado nas formas comuns (o servidor ainda confere as linhas afetadas na hora de rodar)', () => {
  for (const w of ['true', '1 = 1', "'a' = 'a'", 'not false', 'true or x = 1', '2 > 1', 'id = id', '(1 = 1) and (3 <> 4)', '1 = 1 or 2 = 3']) {
    assert.equal(classificar(`delete from t where ${w}`).decisao, 'confirmar', w);
  }
  for (const w of ['id = 1', 'id = 1 or 1 = 1 and false', 'false', "x = 'a' or y = 'a'", 'id is not null', 'id in (1, 2)', '1 = 2']) {
    assert.equal(classificar(`update t set a = 1 where ${w}`).decisao, 'direto', w);
  }
});
