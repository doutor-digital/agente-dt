import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErroSistemas, sistemasChamar } from '../lib/integracoes/sistemas.js';
import { confirmarAlteracao, criarContextoSistemas, PendentesSistemas, prepararAlteracao, registrarEscritaSistemas, registrarLeituraSistemas, type ContaSistemas } from './sistemas.js';
import { confirmarEstrutura, prepararTabela } from './sistemas-estrutura.js';
import { CHAVE_FALSA, CONFIG_FALSA, servidorAdminFalso } from './sistemas-falso.js';
import { confirmarSql, limparParaAuditoria, prepararSql, registrarSqlSistemas, sqlDireto } from './sistemas-sql.js';
import { INSTRUCOES } from './servidor.js';

// O SQL livre do sistema novo: direto, com backup antes; o que destrói em dois passos; o que nunca roda é recusado. Contra o servidor falso.

const QUEM = { usuario: 'user-1', nome: 'suzanne@exemplo.com' };
const OUTRO = { usuario: 'user-2', nome: 'lia@exemplo.com' };
const MOTIVO = 'tabela de preços do caixa';
const CRIAR = 'create table caixa_x (id uuid primary key default gen_random_uuid(), servico text not null)';

function montar(o: Parameters<typeof servidorAdminFalso>[0] = { maisTabelas: true }) {
  const srv = servidorAdminFalso(o);
  const conta: ContaSistemas = { slug: 'hm-tecnologia', nome: 'HM Tecnologia', fonte: { chamar: (m, c, op) => sistemasChamar(CONFIG_FALSA, m, c, op, srv.fetch) } };
  return { srv, ctx: criarContextoSistemas(new Map([[conta.slug, conta]])) };
}
/** as chamadas de ESCRITA e de backup que o servidor recebeu, na ordem */
const rotas = (srv: ReturnType<typeof montar>['srv']) => srv.chamadas.filter((c) => c.metodo === 'POST').map((c) => c.caminho.replace('/admin/v1', ''));

/** Como a produção monta: leitura para todos; SQL livre só para quem escreve (producao.ts decide). */
async function cliente(ctx: ReturnType<typeof criarContextoSistemas>, o: { escreve: boolean; pendentes?: PendentesSistemas }) {
  const server = new McpServer({ name: 't', version: '1' });
  const auditoria: Array<{ ferramenta: string; argumentos: any; ok: boolean; erro?: string }> = [];
  const auditar = (r: { ferramenta: string; argumentos: unknown; ok: boolean; erro?: string }) => auditoria.push(r as any);
  const pend = o.pendentes ?? new PendentesSistemas();
  registrarLeituraSistemas(server, ctx, QUEM, auditar);
  if (o.escreve) {
    registrarEscritaSistemas(server, ctx, pend, QUEM, auditar);
    registrarSqlSistemas(server, ctx, pend, QUEM, auditar);
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(a), c.connect(b)]);
  const chamar = async (nome: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name: nome, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    const texto = r.content[0]!.text;
    return { erro: r.isError === true, texto, json: r.isError ? null : JSON.parse(texto) };
  };
  return { c, chamar, auditoria, fechar: () => c.close() };
}

// ---------------------------------------------------------------- portão

test('portão: quem não escreve não vê o SQL livre e não executa nada; quem escreve vê as três ferramentas; na produção só no bloco de quem escreve', async () => {
  const { srv, ctx } = montar();
  const leitor = await cliente(ctx, { escreve: false });
  const nomes = (await leitor.c.listTools()).tools.map((t) => t.name);
  assert.ok(!nomes.some((n) => n.endsWith('_sql')), nomes.join());
  // chamar na marra uma ferramenta que não foi registrada: erro, e nada chega ao servidor
  const mau = await leitor.chamar('sistemas_sql', { sql: CRIAR, motivo: MOTIVO }).catch((e: Error) => ({ erro: true, texto: String(e.message) }));
  assert.equal(mau.erro, true);
  assert.deepEqual(srv.chamadas, [], 'o leitor não fez o servidor receber nada');
  const escritor = await cliente(ctx, { escreve: true });
  const todos = (await escritor.c.listTools()).tools.map((t) => t.name);
  for (const n of ['sistemas_sql', 'sistemas_preparar_sql', 'sistemas_confirmar_sql']) assert.ok(todos.includes(n), n);
  await leitor.fechar();
  await escritor.fechar();
  const src = readFileSync(new URL('./producao.ts', import.meta.url), 'utf8');
  assert.equal(src.match(/registrarSqlSistemas\(/g)?.length, 1);
  const i = src.indexOf('registrarSqlSistemas(');
  const bloco = src.slice(src.lastIndexOf('if (escritores.has(quem.userId))', i), i);
  assert.match(bloco, /^if \(escritores\.has\(quem\.userId\)\) \{/);
  assert.ok(!bloco.includes('}\n      if ('), 'o bloco de quem escreve não pode ter fechado antes');
});

test('anotações e descrições: sistemas_sql não se anuncia como só leitura; as descrições dizem em português o novo comportamento', async () => {
  const { ctx } = montar();
  const { c, fechar } = await cliente(ctx, { escreve: true });
  const por = Object.fromEntries((await c.listTools()).tools.map((t) => [t.name, t]));
  assert.equal(por['sistemas_sql']!.annotations!.readOnlyHint, false);
  assert.equal(por['sistemas_preparar_sql']!.annotations!.readOnlyHint, true);
  assert.equal(por['sistemas_confirmar_sql']!.annotations!.destructiveHint, true);
  const d = por['sistemas_sql']!.description!;
  for (const re of [/DIRETO, sem pedir confirmação/, /backup/, /DROP/, /TRUNCATE/, /UPDATE\/DELETE sem WHERE/, /sistemas_preparar_sql/, /NUNCA roda/, /auth/, /SECURITY DEFINER/, /COPY/]) assert.match(d, re);
  assert.match(por['sistemas_preparar_sql']!.description!, /NÃO executa nada/);
  assert.match(por['sistemas_confirmar_sql']!.description!, /backup/);
  const instrucoes = INSTRUCOES;
  for (const re of [/sistemas_sql/, /SEM pedir confirmação/, /sistemas_preparar_sql/, /sistemas_confirmar_sql/, /DROP, TRUNCATE/, /NUNCA roda, nem com confirmação/, /inclusive ADMIN/, /sistemas_preparar_admin/]) assert.match(instrucoes, re);
  assert.ok(!/só leitura \(as exceções, para quem tem permissão, são as de dois passos/.test(instrucoes), 'o texto antigo ("só dois passos") saiu');
  await fechar();
});

// ---------------------------------------------------------------- direto

test('direto: o backup é chamado ANTES do SQL, o servidor recebe o snapshot_id, e a resposta diz o que foi guardado', async () => {
  const { srv, ctx } = montar();
  const r = await sqlDireto(ctx, QUEM, { sql: CRIAR, motivo: MOTIVO });
  assert.deepEqual(rotas(srv), ['/backup', '/sql'], 'primeiro o backup, depois o SQL');
  assert.equal(srv.backups.length, 1);
  assert.equal(srv.sqls.length, 1);
  assert.equal(srv.sqls[0]!.snapshot_id, 'snap-1');
  assert.equal(srv.sqls[0]!.confirmado, undefined, 'direto nunca manda confirmado');
  assert.equal(srv.sqls[0]!.sql, CRIAR);
  assert.equal(srv.sqls[0]!.quem, QUEM.nome);
  assert.equal(srv.sqls[0]!.motivo, MOTIVO);
  assert.equal(r.ok, true);
  assert.equal(r.backup.snapshot_id, 'snap-1');
  assert.deepEqual(r.comandos, [{ n: 1, tipo: 'CREATE TABLE', afetadas: 1 }]);
  assert.ok(r.avisos.some((a: string) => /RLS|segurança por linha/.test(a)));
  assert.match(r.instrucao, /sistemas_esquema/);
  assert.match(r.registro, /admin_log/);
  assert.equal(srv.chamadas.at(-1)!.chave, CHAVE_FALSA);
  assert.equal(srv.chamadas.at(-1)!.quem, QUEM.nome);
});

test('direto: cada categoria do pedido roda sem confirmação; UPDATE e DELETE com WHERE tiram o backup das linhas', async () => {
  const { srv, ctx } = montar();
  const direto = [
    'create view caixa_v with (security_invoker = true) as select * from caixa_precos',
    'create materialized view caixa_mv as select servico from caixa_precos',
    'create index caixa_i on caixa_precos (servico)',
    'create function dobro(a integer) returns integer language sql immutable as $$ select a * 2 $$',
    'create trigger tg before insert on caixa_precos for each row execute function marca()',
    'create policy p on caixa_precos for select to authenticated using (caixa_gestor())',
    "create type st as enum ('a', 'b')",
    'create sequence caixa_seq',
    'alter table caixa_precos add column obs text',
    "comment on table caixa_precos is 'preços'",
    'grant select on caixa_precos to authenticated',
    'alter table caixa_precos rename column servico to nome',
    "insert into caixa_precos (servico, valor) values ('a', 1)",
    "update caixa_precos set valor = 2 where servico = 'a'",
    "delete from caixa_precos where servico = 'a'",
  ];
  for (const sql of direto) {
    const antes = srv.sqls.length;
    const r = await sqlDireto(ctx, QUEM, { sql, motivo: MOTIVO });
    assert.equal(r.ok, true, sql);
    assert.equal(srv.sqls.length, antes + 1, sql);
  }
  const u = srv.backups.at(-2)!;
  assert.match(u.sql, /^update caixa_precos/);
  // INSERT puro não precisa de backup: nem chama a rota
  const ins = srv.chamadas.filter((c) => c.corpo?.sql?.startsWith('insert'));
  assert.deepEqual(ins.map((c) => c.caminho.replace('/admin/v1', '')), ['/sql'], 'INSERT só toca em linhas novas: sem backup');
  const r = await sqlDireto(ctx, QUEM, { sql: "update caixa_precos set valor = 2 where servico = 'a'", motivo: MOTIVO });
  assert.deepEqual(Object.keys(r.backup.linhas_por_tabela), ['caixa_precos'], 'o backup guarda as linhas da tabela tocada');
});

test('direto: vários comandos juntos vão no mesmo pedido, com um backup só', async () => {
  const { srv, ctx } = montar();
  const sql = `${CRIAR}; alter table caixa_x enable row level security; create policy p on caixa_x for all to authenticated using (caixa_gestor())`;
  const r = await sqlDireto(ctx, QUEM, { sql, motivo: MOTIVO });
  assert.deepEqual(rotas(srv), ['/backup', '/sql']);
  assert.equal(r.comandos.length, 3);
  assert.ok(!r.avisos.some((a: string) => /SEM segurança/.test(a)), 'o pedido já liga a RLS');
});

// ---------------------------------------------------------------- backup que falha

test('se o backup falha, a mudança NÃO roda: 500, recusa, resposta sem snapshot_id e rede caída', async () => {
  for (const falha of ['erro', 'recusa', 'sem-id'] as const) {
    const { srv, ctx } = montar({ maisTabelas: true, backupFalha: falha });
    await assert.rejects(() => sqlDireto(ctx, QUEM, { sql: CRIAR, motivo: MOTIVO }), /O BACKUP ANTES DA MUDANÇA FALHOU.*a mudança NÃO foi feita/);
    assert.ok(!rotas(srv).includes('/sql'), `${falha}: o SQL não foi enviado`);
    assert.equal(srv.sqls.length, 0);
  }
  // rede caída
  const { ctx: ctxBase } = montar();
  const conta = [...ctxBase.contas.values()][0]!;
  const sem: ContaSistemas = { ...conta, fonte: { chamar: async () => { throw new ErroSistemas('não consegui falar com o servidor', null); } } };
  await assert.rejects(() => sqlDireto(criarContextoSistemas(new Map([[sem.slug, sem]])), QUEM, { sql: CRIAR, motivo: MOTIVO }), /O BACKUP ANTES DA MUDANÇA FALHOU/);
  // também no segundo passo
  const { srv, ctx } = montar({ maisTabelas: true, backupFalha: 'recusa' });
  const pend = new PendentesSistemas();
  const p = await prepararSql(ctx, pend, QUEM, { sql: 'drop table caixa_precos', motivo: MOTIVO });
  await assert.rejects(() => confirmarSql(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /O BACKUP ANTES DA MUDANÇA FALHOU/);
  assert.ok(!rotas(srv).includes('/sql'));
  assert.equal(srv.sqls.length, 0);
});

// ---------------------------------------------------------------- o que destrói pede dois passos

test('direto recusa o que destrói e manda para os dois passos, sem falar com o servidor', async () => {
  const { srv, ctx } = montar();
  const destroi = [
    'drop table caixa_precos', 'drop view v', 'drop index i', 'drop policy p on caixa_precos', 'drop trigger g on caixa_precos', 'drop function f(int)', 'drop sequence s', 'drop type t',
    'truncate caixa_precos', 'delete from caixa_precos', 'delete from caixa_precos where true', 'update caixa_precos set valor = 0', 'update caixa_precos set valor = 0 where 1 = 1',
    'alter table caixa_precos drop column valor', 'alter table caixa_precos drop constraint c', 'revoke select on caixa_precos from authenticated', 'alter table caixa_precos disable row level security',
    `${CRIAR}; drop table caixa_x`,
  ];
  for (const sql of destroi) await assert.rejects(() => sqlDireto(ctx, QUEM, { sql, motivo: MOTIVO }), /DESTRÓI.*sistemas_preparar_sql.*sistemas_confirmar_sql.*NADA foi executado/, sql);
  assert.deepEqual(srv.chamadas, []);
});

test('dois passos: preparar não executa, mostra o resumo, as linhas de hoje e o backup; confirmar tira o backup, manda confirmado:true e registra', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const p = await prepararSql(ctx, pend, QUEM, { sql: 'drop table caixa_precos', motivo: MOTIVO });
  assert.deepEqual(srv.chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['GET /admin/v1/esquema'], 'preparar só LÊ o esquema');
  assert.match(p.decisao, /exige confirmação/);
  assert.match(p.resumo[0], /DESTRÓI.*DROP TABLE.*APAGA TABLE caixa_precos/);
  assert.deepEqual(p.linhasHoje, { caixa_precos: 3 });
  assert.match(p.backup, /snapshot do esquema e das linhas de caixa_precos/);
  assert.match(p.confirmacao, /^sql-[0-9a-f]{18}$/);
  assert.match(p.instrucao, /sistemas_confirmar_sql/);
  assert.match(p.instrucao, /3|linhas/);
  const rastro: any = {};
  const r = await confirmarSql(ctx, pend, QUEM, { confirmacao: p.confirmacao }, rastro);
  assert.deepEqual(rotas(srv), ['/backup', '/sql']);
  assert.equal(srv.sqls[0]!.confirmado, true);
  assert.equal(srv.sqls[0]!.sql, 'drop table caixa_precos');
  assert.equal(srv.sqls[0]!.snapshot_id, 'snap-1');
  assert.equal(r.ok, true);
  assert.equal(rastro.resultado, 'ok');
  assert.equal(rastro.snapshot, 'snap-1');
  assert.deepEqual(rastro.tabelas, ['caixa_precos']);
});

test('dois passos: o código vale uma vez, só para quem preparou, só como SQL, e vence em 10 minutos', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const p = await prepararSql(ctx, pend, QUEM, { sql: 'truncate caixa_precos', motivo: MOTIVO });
  await assert.rejects(() => confirmarSql(ctx, pend, OUTRO, { confirmacao: p.confirmacao }), /outro usuário/);
  await assert.rejects(() => confirmarSql(ctx, pend, QUEM, { confirmacao: 'sql-inventado' }), /desconhecido ou já usado/);
  // o código de SQL não confirma dados, estrutura, nem o contrário
  await assert.rejects(() => confirmarAlteracao(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /SQL.*sistemas_confirmar_sql/);
  const dados = await prepararAlteracao(ctx, pend, QUEM, { operacao: 'atualizar', tabela: 'rh_funcionarios', filtro: { id: 1 }, dados: { cargo: 'x' } });
  await assert.rejects(() => confirmarSql(ctx, pend, QUEM, { confirmacao: dados.confirmacao }), /DADOS.*sistemas_confirmar_alteracao/);
  const est = await prepararTabela(ctx, pend, QUEM, { nome: 'caixa_z', colunas: [{ nome: 'nome', tipo: 'text' }], motivo: MOTIVO });
  await assert.rejects(() => confirmarSql(ctx, pend, QUEM, { confirmacao: est.confirmacao }), /ESTRUTURA.*sistemas_confirmar_estrutura/);
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /SQL.*sistemas_confirmar_sql/);
  assert.deepEqual(srv.sqls, [], 'nenhuma tentativa errada executou');
  await confirmarSql(ctx, pend, QUEM, { confirmacao: p.confirmacao });
  await assert.rejects(() => confirmarSql(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /desconhecido ou já usado/);
  // vence
  let agora = 1_000_000;
  const pend2 = new PendentesSistemas(() => agora);
  const p2 = await prepararSql(ctx, pend2, QUEM, { sql: 'truncate caixa_precos', motivo: MOTIVO });
  agora += 10 * 60_000 + 1;
  await assert.rejects(() => confirmarSql(ctx, pend2, QUEM, { confirmacao: p2.confirmacao }), /venceu/);
});

test('dois passos aceita também SQL que não destrói (mostra, e o ok da pessoa o executa) e diz que poderia ser direto', async () => {
  const { ctx } = montar();
  const pend = new PendentesSistemas();
  const p = await prepararSql(ctx, pend, QUEM, { sql: CRIAR, motivo: MOTIVO });
  assert.match(p.decisao, /poderia rodar direto/);
  assert.match(p.resumo[0], /\[direto\] CREATE TABLE/);
});

// ---------------------------------------------------------------- o que nunca roda

test('item 4: recusado antes de falar com o servidor, nos dois caminhos — auth, senhas, tabelas fechadas, SET ROLE, COPY, extensão, SECURITY DEFINER, transação', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const nunca = [
    'select * from auth.users',
    'create table caixa_x as select id, encrypted_password from auth.users',
    "update rh_usuarios set papel = 'admin'",
    'delete from admin_log',
    'drop table rh_usuarios',
    'truncate rh_log',
    'alter table rh_docs add column x int',
    'set role postgres',
    "copy caixa_precos to '/tmp/x'",
    'create extension dblink',
    'create function f() returns int language sql security definer as $$ select 1 $$',
    'begin',
    'vacuum',
    'create table x (a int); commit',
    'grant select on caixa_precos to anon',
    'drop table auth.users',
    'create policy p on caixa_precos using (true)',
  ];
  for (const sql of nunca) {
    await assert.rejects(() => sqlDireto(ctx, QUEM, { sql, motivo: MOTIVO }), /NADA foi executado/, sql);
    await assert.rejects(() => prepararSql(ctx, pend, QUEM, { sql, motivo: MOTIVO }), /NADA foi executado/, sql);
  }
  assert.deepEqual(srv.chamadas, [], 'nenhum desses chegou ao servidor');
});

test('os furos do PR #175 (30/10) continuam fechados nas duas ferramentas', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const furos = [
    'create table x as with d as (delete from caixa_precos returning *) select * from d', // CTAS com DELETE em CTE
    'create table x as select * from rh_usuarios', // CTAS lendo usuários
    "alter table rh_usuarios alter column papel type text using 'admin'", // ALTER … USING
    'create policy p on rh_usuarios for all to authenticated using (true)', // policy
    "comment on table caixa_precos is $a1$'$a1$; delete from rh_usuarios; comment on table caixa_precos is 'x'", // $a1$
    "alter table caixa_precos add constraint c check (rh_merge('a','b','{}'::jsonb) is not null)", // CHECK com rh_merge
    "alter table caixa_precos add constraint c check (rh_patch('a','b',1) is not null)", // CHECK com rh_patch
    'create trigger g before insert on rh_usuarios for each row execute function marca()',
  ];
  for (const sql of furos) {
    await assert.rejects(() => sqlDireto(ctx, QUEM, { sql, motivo: MOTIVO }), /NADA foi executado/, sql);
    await assert.rejects(() => prepararSql(ctx, pend, QUEM, { sql, motivo: MOTIVO }), /NADA foi executado/, sql);
  }
  // o REVOKE do 30/10 agora é um comando que exige confirmação, e some do caminho direto
  await assert.rejects(() => sqlDireto(ctx, QUEM, { sql: 'revoke select on caixa_precos from authenticated', motivo: MOTIVO }), /DESTRÓI/);
  assert.deepEqual(srv.chamadas, []);
});

test('entrada ruim: motivo curto, sql vazio ou grande demais, sem integração', async () => {
  const { ctx } = montar();
  await assert.rejects(() => sqlDireto(ctx, QUEM, { sql: CRIAR, motivo: 'oi' }), /motivo/);
  await assert.rejects(() => sqlDireto(ctx, QUEM, { sql: '   ', motivo: MOTIVO }), /sql vazio/);
  await assert.rejects(() => sqlDireto(ctx, QUEM, { sql: `comment on table t is '${'x'.repeat(100_001)}'`, motivo: MOTIVO }), /grande demais/);
  await assert.rejects(() => sqlDireto(criarContextoSistemas(), QUEM, { sql: CRIAR, motivo: MOTIVO }), /painel de integrações/);
  const { chamar, fechar } = await cliente(ctx, { escreve: true });
  const r = await chamar('sistemas_sql', { sql: 'x', motivo: MOTIVO }).catch((e: Error) => ({ erro: true, texto: e.message }));
  assert.equal(r.erro, true);
  await fechar();
});

// ---------------------------------------------------------------- respostas do servidor

test('o servidor recusou (erro do banco ou a trava da tabela inteira): vira erro em português; nada fica pela metade', async () => {
  const { ctx } = montar({ maisTabelas: true, sqlFalha: 'recusa' });
  await assert.rejects(() => sqlDireto(ctx, QUEM, { sql: CRIAR, motivo: MOTIVO }), /o servidor NÃO aplicou: o banco recusou no comando 2.*desfez/);
  const g = montar({ maisTabelas: true, sqlFalha: 'guarda' });
  await assert.rejects(() => sqlDireto(g.ctx, QUEM, { sql: "update caixa_precos set valor = 1 where servico is not null", motivo: MOTIVO }), /TODAS as 3 linhas.*Foi desfeito.*sistemas_preparar_sql/);
});

test('sem resposta do servidor no SQL: avisa que NÃO sabe se rodou; no dois passos o código volta; no direto não há código', async () => {
  const { srv, ctx } = montar({ maisTabelas: true, sqlFalha: 'incerto' });
  await assert.rejects(() => sqlDireto(ctx, QUEM, { sql: CRIAR, motivo: MOTIVO }), /NÃO sei se o SQL foi executado.*snapshot snap-1.*antes de repetir/);
  const pend = new PendentesSistemas();
  const p = await prepararSql(ctx, pend, QUEM, { sql: 'drop table caixa_precos', motivo: MOTIVO });
  await assert.rejects(() => confirmarSql(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /NÃO sei se o SQL foi executado/);
  // o código voltou: dá para tentar de novo (depois de conferir)
  const dev = pend.tirar(p.confirmacao, QUEM.usuario, 'sql');
  assert.equal(dev.sqlLivre!.sql, 'drop table caixa_precos');
  assert.equal(srv.sqls.length, 0);
});

// ---------------------------------------------------------------- MCP, auditoria e segredos

test('pelo MCP: direto, dois passos, auditoria do conector sem o texto do SQL (CPF/salário), chave nunca na saída', async () => {
  const { srv, ctx } = montar();
  const { chamar, auditoria, fechar } = await cliente(ctx, { escreve: true });
  const ins = "update caixa_precos set valor = 4321.99 where servico = 'cpf 123.456.789-00'";
  const d = await chamar('sistemas_sql', { sql: ins, motivo: MOTIVO });
  assert.equal(d.erro, false, d.texto);
  assert.equal(d.json.ok, true);
  const rec = await chamar('sistemas_sql', { sql: 'drop table caixa_precos', motivo: MOTIVO });
  assert.equal(rec.erro, true); assert.match(rec.texto, /sistemas_preparar_sql/);
  const p = await chamar('sistemas_preparar_sql', { sql: 'drop table caixa_precos', motivo: MOTIVO });
  assert.equal(p.erro, false, p.texto);
  assert.equal(srv.sqls.length, 1, 'preparar não executou');
  const c = await chamar('sistemas_confirmar_sql', { confirmacao: p.json.confirmacao });
  assert.equal(c.erro, false, c.texto);
  assert.equal(srv.sqls.length, 2);
  const aud = JSON.stringify(auditoria);
  assert.ok(!aud.includes('123.456.789') && !aud.includes('4321.99'), 'o SQL (dado pessoal) fica fora da auditoria do conector');
  const a1 = auditoria.find((a) => a.ferramenta === 'sistemas_sql' && a.ok)!;
  assert.deepEqual(a1.argumentos.comandos, ['UPDATE:direto']);
  assert.deepEqual(a1.argumentos.tabelas, ['caixa_precos']);
  assert.match(a1.argumentos.sqlHash, /^[0-9a-f]{16}$/);
  assert.equal(a1.argumentos.snapshot, 'snap-1');
  assert.equal(a1.argumentos.resultado, 'ok');
  const conf = auditoria.find((a) => a.ferramenta === 'sistemas_confirmar_sql')!;
  assert.equal(conf.ok, true); assert.deepEqual(conf.argumentos.comandos, ['DROP TABLE:confirmar']);
  const nega = auditoria.find((a) => a.ferramenta === 'sistemas_sql' && !a.ok)!;
  assert.deepEqual(nega.argumentos.comandos, ['DROP TABLE:confirmar']);
  assert.ok(!JSON.stringify([d.texto, rec.texto, p.texto, c.texto, aud]).includes(CHAVE_FALSA));
  assert.ok(!JSON.stringify([d.texto, rec.texto, p.texto, c.texto, aud]).includes('api-rh'));
  await fechar();
});

test('auditoria do conector: erro do parser/banco não leva valor entre aspas nem número longo (CPF, telefone); o resultado também não', async () => {
  assert.equal(limparParaAuditoria('o SQL não é válido (syntax error at or near "cpf 123.456.789-00")'), 'o SQL não é válido (syntax error at or near "…")');
  assert.equal(limparParaAuditoria("invalid input syntax for type date: '13/45/1990'"), "invalid input syntax for type date: '…'");
  assert.equal(limparParaAuditoria('telefone 5511999998888 inválido'), 'telefone # inválido');
  assert.equal(limparParaAuditoria(undefined), undefined);
  assert.ok((limparParaAuditoria('x'.repeat(1000)) ?? '').length <= 240);
  const { ctx } = montar();
  const { chamar, auditoria, fechar } = await cliente(ctx, { escreve: true });
  const r = await chamar('sistemas_sql', { sql: "update caixa_precos set valor = 1 where servico = 'cpf 123.456.789-00' and (", motivo: MOTIVO });
  assert.equal(r.erro, true);
  const aud = JSON.stringify(auditoria);
  assert.ok(!aud.includes('123.456.789'), aud);
  await fechar();
});
