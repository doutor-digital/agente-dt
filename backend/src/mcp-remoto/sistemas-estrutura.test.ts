import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErroSistemas, sistemasChamar } from '../lib/integracoes/sistemas.js';
import { criarContextoSistemas, PendentesSistemas, prepararAlteracao, registrarEscritaSistemas, registrarLeituraSistemas, type ContaSistemas } from './sistemas.js';
import { analisarEstrutura, confirmarEstrutura, prepararEstrutura, registrarEstruturaSistemas } from './sistemas-estrutura.js';
import { CHAVE_FALSA, CONFIG_FALSA, servidorAdminFalso } from './sistemas-falso.js';

// Criar/alterar a ESTRUTURA do banco do sistema novo (sistemas_preparar_estrutura / sistemas_confirmar_estrutura), contra o servidor falso.

const QUEM = { usuario: 'user-1', nome: 'suzanne@exemplo.com' };
const MOTIVO = 'tabela de preços do caixa';

function montar(o: Parameters<typeof servidorAdminFalso>[0] = {}) {
  const srv = servidorAdminFalso(o);
  const conta: ContaSistemas = { slug: 'hm-tecnologia', nome: 'HM Tecnologia', fonte: { chamar: (m, c, op) => sistemasChamar(CONFIG_FALSA, m, c, op, srv.fetch) } };
  return { srv, ctx: criarContextoSistemas(new Map([[conta.slug, conta]])) };
}

/** Como a produção monta: leitura para todos; escrita e estrutura só para quem escreve (producao.ts decide). */
async function cliente(ctx: ReturnType<typeof criarContextoSistemas>, o: { escreve: boolean; pendentes?: PendentesSistemas }) {
  const server = new McpServer({ name: 't', version: '1' });
  const auditoria: Array<{ ferramenta: string; argumentos: any; ok: boolean; erro?: string }> = [];
  const auditar = (r: { ferramenta: string; argumentos: unknown; ok: boolean; erro?: string }) => auditoria.push(r as any);
  const pend = o.pendentes ?? new PendentesSistemas();
  registrarLeituraSistemas(server, ctx, QUEM, auditar);
  if (o.escreve) {
    registrarEscritaSistemas(server, ctx, pend, QUEM, auditar);
    registrarEstruturaSistemas(server, ctx, pend, QUEM, auditar);
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

const TABELA_COMPLETA = [
  'create table public.caixa_precos (id bigint generated always as identity primary key, servico text not null, valor numeric(10,2) not null default 0)',
  'alter table public.caixa_precos enable row level security',
  'create policy precos_ver on public.caixa_precos for select to authenticated using (rh_admin())',
  'create index if not exists caixa_precos_servico_idx on public.caixa_precos (servico)',
  "comment on table public.caixa_precos is 'preços por serviço'",
].join(';\n');

// ---------------------------------------------------------------- portão por e-mail

test('portão: quem não escreve não vê as ferramentas de estrutura; quem escreve vê as duas', async () => {
  const { ctx } = montar();
  const leitor = await cliente(ctx, { escreve: false });
  const nomes = (await leitor.c.listTools()).tools.map((t) => t.name);
  assert.ok(!nomes.some((n) => n.includes('estrutura')), nomes.join());
  const escritor = await cliente(ctx, { escreve: true });
  const todos = (await escritor.c.listTools()).tools.map((t) => t.name);
  for (const n of ['sistemas_preparar_estrutura', 'sistemas_confirmar_estrutura']) assert.ok(todos.includes(n), n);
  await leitor.fechar();
  await escritor.fechar();
});

test('na produção, a estrutura só é registrada dentro do bloco de quem pode escrever', () => {
  const src = readFileSync(new URL('./producao.ts', import.meta.url), 'utf8');
  assert.equal(src.match(/registrarEstruturaSistemas\(/g)?.length, 1);
  const i = src.indexOf('registrarEstruturaSistemas(');
  const bloco = src.slice(src.lastIndexOf('if (escritores.has(quem.userId))', i), i);
  assert.match(bloco, /^if \(escritores\.has\(quem\.userId\)\) \{/);
  assert.ok(!bloco.includes('}\n      if ('), 'o bloco de quem escreve não pode ter fechado antes');
});

// ---------------------------------------------------------------- o que se aceita

test('aceita criar tabela, RLS, política, índice e comentário; resume o que cada comando faz', () => {
  const a = analisarEstrutura(TABELA_COMPLETA);
  assert.deepEqual(a.comandos.map((c) => c.tipo), ['CREATE TABLE', 'ALTER TABLE ENABLE RLS', 'CREATE POLICY', 'CREATE INDEX', 'COMMENT']);
  assert.match(a.comandos[0]!.o_que, /Cria a tabela caixa_precos/);
  assert.deepEqual(a.avisos, [], 'RLS ligada no mesmo pedido: sem aviso');
});

test('aceita colunas, restrições, default, tipo, view com security_invoker e grant para authenticated', () => {
  const casos = [
    'alter table caixa_precos add column unidade text',
    'ALTER TABLE public.caixa_precos ADD COLUMN IF NOT EXISTS ativo boolean NOT NULL DEFAULT true',
    'alter table caixa_precos add constraint valor_ok check (valor >= 0)',
    'alter table caixa_precos add primary key (id)',
    'alter table caixa_precos add column a int, add column b int',
    'alter table caixa_precos alter column valor set default 0',
    'alter table caixa_precos alter column valor set data type numeric(12,2)',
    'alter table caixa_precos alter column valor type numeric(12,2) using valor::numeric',
    'alter table caixa_precos alter column servico set not null',
    'create unique index caixa_precos_u on caixa_precos (servico, unidade)',
    'create view public.v_precos with (security_invoker = true) as select * from caixa_precos',
    'create or replace view v_precos with (security_invoker=on) as select id from caixa_precos',
    'create policy p on caixa_precos for all to authenticated using (rh_admin()) with check (rh_admin())',
    'alter policy p on caixa_precos using (rh_admin())',
    'create policy p2 on caixa_precos as permissive for insert to authenticated, service_role with check (rh_admin())',
    'create table caixa_lanc as select p.id, u.nome from caixa_precos p join caixa_unidades u on u.id = p.unidade_id',
    'alter table caixa_precos add column unidade_id bigint references caixa_unidades(id)',
    'alter table caixa_precos add column u2 bigint references public.caixa_unidades (id)',
    'create view v with (security_barrier = true, security_invoker = true) as select * from caixa_precos',
    'create view v (a, b) with (security_invoker = true) as select 1, 2',
    "comment on column public.caixa_precos.valor is 'x'",
    'comment on constraint valor_ok on caixa_precos is \'x\'',
    "comment on column caixa_precos.valor is 'em reais'",
    'grant select, insert on caixa_precos to authenticated',
    'revoke delete on public.caixa_precos from authenticated, service_role',
    '-- coluna nova\nalter table caixa_precos add column obs text; -- fim',
  ];
  for (const s of casos) assert.doesNotThrow(() => analisarEstrutura(s), s);
});

test('avisos: mudar tipo pode falhar com dados; NOT NULL sem DEFAULT; tabela nova sem RLS', () => {
  const tipo = analisarEstrutura('alter table caixa_precos alter column valor type text');
  assert.match(tipo.avisos.join(' '), /pode FALHAR.*dados/);
  const nn = analisarEstrutura('alter table caixa_precos add column z int not null');
  assert.match(nn.avisos.join(' '), /NOT NULL sem DEFAULT/);
  const sem = analisarEstrutura('create table caixa_x (id int)');
  assert.match(sem.avisos.join(' '), /SEM segurança por linha/);
  const outra = analisarEstrutura('create table caixa_x (id int); alter table caixa_y enable row level security');
  assert.match(outra.avisos.join(' '), /caixa_x nasce SEM/);
  const gr = analisarEstrutura('grant select on caixa_precos to authenticated');
  assert.match(gr.avisos.join(' '), /TODOS os usuários logados/);
});

// ---------------------------------------------------------------- o que se recusa

test('recusa DROP, TRUNCATE, COPY (até dentro de texto/comentário) e ALTER … DROP', () => {
  for (const s of [
    'drop table caixa_precos',
    'DROP TABLE IF EXISTS caixa_precos CASCADE',
    'truncate caixa_precos',
    'alter table caixa_precos drop column valor',
    'alter table caixa_precos alter column valor drop not null',
    'drop policy p on caixa_precos',
    "comment on table t is 'depois a gente faz drop'",
    '/* drop */ create table x (a int)',
    "copy caixa_precos to '/tmp/x'",
  ]) assert.throws(() => analisarEstrutura(s), /DROP, TRUNCATE e COPY não existem/, s);
});

test('recusa contrabando: comando escondido depois de ";", em lote, em texto e em maiúsculas', () => {
  const ruins: Array<[string, RegExp]> = [
    ['create table x (a int); drop table y', /DROP/],
    ['create table x (a int);\n  DROP TABLE y;', /DROP/],
    ['create table x (a int) ; create role invasor', /não reconheço/],
    ['create table x (a int); do $$ begin null; end $$', /não reconheço/],
    ['create table x (a int); alter role sistemas superuser', /não reconheço/],
    ['create table x (a int); select pg_read_file(\'/etc/passwd\')', /pg_|não reconheço/],
    ['alter user sistemas password \'x\'', /não reconheço/],
    ['alter role sistemas set role sistemas', /ROLE|não reconheço|role/i],
    ['set role sistemas', /SET ROLE/],
    ['create function public.f() returns int language sql security definer as \'select 1\'', /SECURITY DEFINER/],
    ['create function public.f() returns int language sql as \'select 1\'', /não reconheço/],
    ['create table x (a int); execute foo', /EXECUTE/],
    ['create table x (a int); begin; commit', /não reconheço/],
    ['vacuum caixa_precos', /não reconheço/],
    ['select 1', /não reconheço/],
    ['insert into caixa_precos (servico) values (\'x\')', /não reconheço/],
    ['delete from caixa_precos', /não reconheço/],
  ];
  for (const [s, re] of ruins) assert.throws(() => analisarEstrutura(s), re, s);
  // texto entre aspas simples não esconde nem inventa ";"
  assert.doesNotThrow(() => analisarEstrutura("comment on table caixa_precos is 'a; b'"));
});

test('recusa auth/storage/pg_*/catálogo, nome entre aspas (esconderia o esquema) e outro esquema', () => {
  for (const s of [
    'create view v with (security_invoker=true) as select * from auth.users',
    'alter table auth.users add column x text',
    'create table x (u uuid references auth.users(id))',
    'create policy p on caixa_precos using (auth.uid() = id)',
    'create table storage.x (a int)',
    'create view v with (security_invoker=true) as select * from pg_catalog.pg_roles',
    'create view v with (security_invoker=true) as select * from pg_shadow',
    'create view v with (security_invoker=true) as select * from information_schema.tables',
    'create view v with (security_invoker=true) as select * from "auth".users',
    'create table "Caixa" (a int)',
    'create table extensions.x (a int)',
  ]) assert.throws(() => analisarEstrutura(s), /esquemas auth|aspas duplas/, s);
  assert.throws(() => analisarEstrutura('create table outro.x (a int)'), /só o esquema "public"/);
  assert.throws(() => analisarEstrutura('alter table outro.x add column a int'), /só o esquema "public"/);
  assert.throws(() => analisarEstrutura('create policy p on outro.x using (true)'), /só o esquema "public"/);
});

test('recusa ALTER ROLE/USER, GRANT a papéis internos ou ao público, anon, RLS desligada e renomear', () => {
  for (const s of [
    'grant sistemas to authenticated',
    'grant select on caixa_precos to mcp_leitor',
    'grant select on caixa_precos to sistemas_app',
    'grant select on caixa_precos to anon',
    'grant select on caixa_precos to public',
    'grant select on caixa_precos to authenticated with grant option',
    'grant all on caixa_precos to authenticated',
    'grant all privileges on caixa_precos to authenticated',
    'grant select on all tables in schema public to authenticated',
    'grant truncate on caixa_precos to authenticated',
    'grant usage on schema public to authenticated',
    'revoke all on caixa_precos from authenticated',
  ]) assert.throws(() => analisarEstrutura(s), /GRANT\/REVOKE|anon|não reconheço|TRUNCATE/, s);
  assert.throws(() => analisarEstrutura('alter table caixa_precos disable row level security'), /desligar a segurança por linha/);
  assert.throws(() => analisarEstrutura('alter table caixa_precos rename to x'), /RENAME.*não é permitido/);
  assert.throws(() => analisarEstrutura('alter table caixa_precos rename column a to b'), /RENAME/);
  assert.throws(() => analisarEstrutura('alter table caixa_precos owner to sistemas'), /OWNER TO/);
  assert.throws(() => analisarEstrutura('create policy p on caixa_precos to anon using (true)'), /anon/);
});

test('recusa view sem security_invoker (passaria por cima da RLS), materializada, índice concorrente e temporária', () => {
  assert.throws(() => analisarEstrutura('create view v as select * from caixa_precos'), /security_invoker/);
  assert.throws(() => analisarEstrutura('create view v with (security_invoker = false) as select 1'), /security_invoker/);
  assert.throws(() => analisarEstrutura('create materialized view v as select 1'), /materializada/);
  assert.throws(() => analisarEstrutura('create index concurrently i on caixa_precos (a)'), /CONCURRENTLY/);
  assert.throws(() => analisarEstrutura('create temp table t (a int)'), /temporário/);
});

test('recusa vazio, só comentário, grande demais, comandos demais e motivo curto', async () => {
  assert.throws(() => analisarEstrutura(''), /vazio/);
  assert.throws(() => analisarEstrutura('   '), /vazio/);
  assert.throws(() => analisarEstrutura('-- nada'), /vazio/);
  assert.throws(() => analisarEstrutura(undefined), /vazio/);
  assert.throws(() => analisarEstrutura(`create table x (a text default '${'a'.repeat(21_000)}')`), /grande demais/);
  assert.throws(() => analisarEstrutura(Array.from({ length: 26 }, (_, i) => `create table t${i} (a int)`).join(';')), /comandos demais/);
  const { srv, ctx } = montar();
  await assert.rejects(() => prepararEstrutura(ctx, new PendentesSistemas(), QUEM, { sql: 'create table x (a int)', motivo: 'x' }), /motivo/);
  assert.equal(srv.chamadas.length, 0, 'recusa não chega ao servidor');
});

// ---------------------------------------------------------------- dois passos

test('caminho feliz: preparar não executa nada; confirmar manda o SQL aprovado e quem pediu, e registra', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const p = await prepararEstrutura(ctx, pend, QUEM, { sql: TABELA_COMPLETA, motivo: MOTIVO });
  assert.equal(srv.chamadas.length, 0, 'preparar nem fala com o servidor');
  assert.equal(srv.estruturas.length, 0);
  assert.equal(p.resumo.length, 5);
  assert.match(p.resumo[0], /1\. Cria a tabela caixa_precos/);
  assert.match(p.confirmacao, /^est-[0-9a-f]{18}$/);
  assert.match(p.instrucao, /sistemas_confirmar_estrutura/);
  assert.equal(p.sql, TABELA_COMPLETA);
  const rastro: { sql?: string; motivo?: string; resultado?: string } = {};
  const r = await confirmarEstrutura(ctx, pend, QUEM, { confirmacao: p.confirmacao }, rastro);
  assert.equal(r.ok, true);
  assert.equal(r.comandos, 5);
  assert.equal(srv.estruturas.length, 1);
  assert.deepEqual(srv.estruturas[0], { sql: TABELA_COMPLETA, quem: QUEM.nome, motivo: MOTIVO });
  const c = srv.chamadas.at(-1)!;
  assert.equal(c.caminho, '/admin/v1/estrutura');
  assert.equal(c.chave, CHAVE_FALSA);
  assert.equal(c.quem, QUEM.nome);
  assert.deepEqual(rastro, { sql: TABELA_COMPLETA, motivo: MOTIVO, resultado: 'ok' });
  assert.deepEqual(srv.registro.at(-1), { tabela: '(estrutura)', quem: QUEM.nome, op: 'estrutura' });
});

test('confirmação reusada, desconhecida, de outro usuário, de outro tipo e vencida: nada vai ao servidor', async () => {
  let agora = 5_000_000;
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas(() => agora);
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: 'est-inventado' }), /desconhecido ou já usado/);
  const p = await prepararEstrutura(ctx, pend, QUEM, { sql: 'create table caixa_a (a int)', motivo: MOTIVO });
  await assert.rejects(() => confirmarEstrutura(ctx, pend, { usuario: 'outro', nome: 'o@x' }, { confirmacao: p.confirmacao }), /outro usuário/);
  assert.equal(srv.chamadas.length, 0);
  // código de estrutura não vale para confirmar dados, e o código de dados não vale para estrutura; nenhum dos dois é gasto na tentativa errada
  const { confirmarAlteracao } = await import('./sistemas.js');
  await assert.rejects(() => confirmarAlteracao(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /ESTRUTURA.*sistemas_confirmar_estrutura/);
  const d = await prepararAlteracao(ctx, pend, QUEM, { operacao: 'atualizar', tabela: 'rh_funcionarios', filtro: { id: 1 }, dados: { cargo: 'X' } });
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: d.confirmacao }), /DADOS.*sistemas_confirmar_alteracao/);
  assert.equal(srv.chamadas.filter((c) => c.caminho === '/admin/v1/confirmar').length, 0);
  // o certo funciona UMA vez
  assert.equal((await confirmarEstrutura(ctx, pend, QUEM, { confirmacao: p.confirmacao })).ok, true);
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /desconhecido ou já usado/);
  assert.equal(srv.estruturas.length, 1, 'rodou uma vez só');
  // vencida
  const v = await prepararEstrutura(ctx, pend, QUEM, { sql: 'create table caixa_b (a int)', motivo: MOTIVO });
  agora += 11 * 60_000;
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: v.confirmacao }), /venceu.*prepare/);
  assert.equal(srv.estruturas.length, 1);
});

test('banco recusou (ok:false): vira erro em português e o código se gasta; erro 5xx: não sei se gravou, o código volta', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const p = await prepararEstrutura(ctx, pend, QUEM, { sql: 'create table falha_do_banco (a int)', motivo: MOTIVO });
  const rastro: { resultado?: string } = {};
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: p.confirmacao }, rastro), /NÃO aplicou: relation "caixa_precos" already exists.*desfaz/);
  assert.match(rastro.resultado!, /^recusado/);
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /desconhecido ou já usado/);

  const q = await prepararEstrutura(ctx, pend, QUEM, { sql: 'create table erro_do_servidor (a int)', motivo: MOTIVO });
  await assert.rejects(
    () => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: q.confirmacao }),
    (e: Error) => /NÃO sei se a estrutura foi alterada/.test(e.message) && !e.message.includes(CONFIG_FALSA.api),
  );
  // o código voltou: dá para tentar de novo (aqui falha igual, mas não some)
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: q.confirmacao }), /NÃO sei se/);
  assert.equal(srv.estruturas.length, 0);
});

test('servidor sem a rota (404) e resposta fora do contrato', async () => {
  const { ctx } = montar();
  const conta = ctx.contas.get('hm-tecnologia')!;
  const pend = new PendentesSistemas();
  const original = conta.fonte.chamar;
  conta.fonte.chamar = async () => {
    throw new ErroSistemas('o servidor do sistema novo não tem essa rota (404): confira a URL base no painel de integrações e a versão do servidor', 404);
  };
  const p = await prepararEstrutura(ctx, pend, QUEM, { sql: 'create table caixa_c (a int)', motivo: MOTIVO });
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /não tem essa rota/);
  conta.fonte.chamar = async () => ({ qualquer: 'coisa' });
  const q = await prepararEstrutura(ctx, pend, QUEM, { sql: 'create table caixa_d (a int)', motivo: MOTIVO });
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: q.confirmacao }), /fora do contrato/);
  conta.fonte.chamar = original;
  assert.equal((await confirmarEstrutura(ctx, pend, QUEM, { confirmacao: q.confirmacao })).ok, true, 'resposta incerta devolve o código');
});

test('pelo MCP: registro de auditoria leva quem, SQL, motivo e resultado; a chave nunca aparece', async () => {
  const { srv, ctx } = montar();
  const { chamar, auditoria, fechar } = await cliente(ctx, { escreve: true });
  const p = await chamar('sistemas_preparar_estrutura', { sql: 'create table caixa_e (a int)', motivo: MOTIVO });
  assert.equal(p.erro, false, p.texto);
  const c = await chamar('sistemas_confirmar_estrutura', { confirmacao: p.json.confirmacao });
  assert.equal(c.json.ok, true, c.texto);
  assert.equal(srv.estruturas.length, 1);
  const prep = auditoria.find((a) => a.ferramenta === 'sistemas_preparar_estrutura')!;
  assert.equal(prep.argumentos.sql, 'create table caixa_e (a int)');
  assert.equal(prep.argumentos.motivo, MOTIVO);
  const conf = auditoria.find((a) => a.ferramenta === 'sistemas_confirmar_estrutura')!;
  assert.equal(conf.ok, true);
  assert.equal(conf.argumentos.sql, 'create table caixa_e (a int)');
  assert.equal(conf.argumentos.resultado, 'ok');
  // recusa também fica registrada, com o motivo da recusa
  const ruim = await chamar('sistemas_preparar_estrutura', { sql: 'drop table x', motivo: MOTIVO });
  assert.equal(ruim.erro, true);
  assert.match(ruim.texto, /DROP, TRUNCATE e COPY não existem/);
  assert.equal(auditoria.at(-1)!.ok, false);
  assert.ok(!JSON.stringify([p.texto, c.texto, ruim.texto, auditoria]).includes(CHAVE_FALSA));
  await fechar();
});

test('descrições em português dizem que é estrutura e que DROP não existe', async () => {
  const { ctx } = montar();
  const { c, fechar } = await cliente(ctx, { escreve: true });
  const t = (await c.listTools()).tools.find((x) => x.name === 'sistemas_preparar_estrutura')!;
  assert.match(t.description!, /ESTRUTURA/);
  assert.match(t.description!, /DROP.*NÃO existem/);
  await fechar();
});

test('revisão: recusa esquema fora de public em qualquer parte do comando, funções que recebem SQL em texto, política sem TO e view com a opção no lugar errado', () => {
  for (const s of [
    'create table t as select * from private.x',
    'alter table caixa_precos add column x int references private.y(id)',
    "comment on table private.x is 'a'",
    "comment on column private.x.c is 'a'",
    "create view v with (security_invoker=true) as select query_to_xml('select * from auth.users', true, false, '')",
    "create view v with (security_invoker=true) as select table_to_xml('caixa_precos', true, false, '')",
  ]) assert.throws(() => analisarEstrutura(s), /esquema|auth|_to_xml/, s);
  assert.throws(() => analisarEstrutura('create policy p on caixa_precos for select using (true)'), /precisa dizer para quem vale/);
  assert.throws(() => analisarEstrutura('create policy p on caixa_precos for select to public using (true)'), /TO authenticated/);
  assert.throws(() => analisarEstrutura('create policy p on caixa_precos to authenticated, mcp_leitor using (true)'), /TO authenticated/);
  assert.throws(() => analisarEstrutura('alter policy p on caixa_precos rename to q'), /renomear política/);
  assert.throws(() => analisarEstrutura('create view v as select 1 with (security_invoker=true)'), /security_invoker/);
  assert.throws(() => analisarEstrutura("create view v as select 'security_invoker = true'"), /security_invoker/);
  assert.throws(() => analisarEstrutura('create table x (a int) -- "Caixa"'), /aspas duplas/);
  assert.match(analisarEstrutura('create policy p on caixa_precos to authenticated using (true)').avisos.join(' '), /usa \(true\)/);
  const sr = analisarEstrutura('grant select on caixa_precos to service_role');
  assert.deepEqual(sr.avisos, [], 'service_role não é "todos os usuários logados"');
});

test('auditoria guarda o SQL inteiro de um lote grande (não só os primeiros 4000 caracteres)', async () => {
  const { ctx } = montar();
  const { chamar, auditoria, fechar } = await cliente(ctx, { escreve: true });
  const sql = Array.from({ length: 24 }, (_, i) => `comment on table caixa_t${i} is '${'x'.repeat(480)}'`).join(';\n') + ';\nalter table caixa_fim add column ultimo int';
  assert.ok(sql.length > 10_000 && sql.length < 20_000);
  const p = await chamar('sistemas_preparar_estrutura', { sql, motivo: MOTIVO });
  assert.equal(p.erro, false, p.texto);
  await chamar('sistemas_confirmar_estrutura', { confirmacao: p.json.confirmacao });
  for (const f of ['sistemas_preparar_estrutura', 'sistemas_confirmar_estrutura']) {
    const a = auditoria.find((x) => x.ferramenta === f)!;
    assert.ok(a.argumentos.sql.endsWith('add column ultimo int'), f);
  }
  await fechar();
});
