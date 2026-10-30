import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
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
  assert.match(ruim.texto, /DROP não existe/);
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

test('preparar recusa pelo parser antes de falar com o servidor, e o resumo/avisos vêm da árvore', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  for (const sql of ['drop table caixa_precos', 'create table x as select * from rh_docs', "comment on table caixa is $a1$'$a1$; delete from caixa; comment on table caixa is 'x'", 'alter table caixa add constraint c1 check (public.rh_merge(\'a\', \'b\', null) is null)']) {
    await assert.rejects(() => prepararEstrutura(ctx, pend, QUEM, { sql, motivo: MOTIVO }), (e: Error) => e instanceof ErroDeEntrada, sql);
  }
  await assert.rejects(() => prepararEstrutura(ctx, pend, QUEM, { sql: 'create table x (a int)', motivo: 'x' }), /motivo/);
  assert.equal(srv.chamadas.length, 0, 'recusa não chega ao servidor');
  const p = await prepararEstrutura(ctx, pend, QUEM, { sql: 'create table caixa_x (id int); alter table caixa_x alter column id type bigint', motivo: MOTIVO });
  assert.match(p.avisos.join(' '), /SEM segurança por linha/);
  assert.match(p.avisos.join(' '), /pode FALHAR/);
  assert.equal(p.resumo.length, 2);
});
