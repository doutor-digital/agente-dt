import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { ErroSistemas, sistemasChamar } from '../lib/integracoes/sistemas.js';
import { criarContextoSistemas, PendentesSistemas, prepararAlteracao, registrarEscritaSistemas, registrarLeituraSistemas, type ContaSistemas } from './sistemas.js';
import { confirmarEstrutura, prepararColuna, prepararIndice, prepararTabela, registrarEstruturaSistemas } from './sistemas-estrutura.js';
import { CHAVE_FALSA, CONFIG_FALSA, servidorAdminFalso } from './sistemas-falso.js';

// Criar/alterar ESTRUTURA por campos (sistemas_preparar_tabela/coluna/indice → sistemas_confirmar_estrutura), contra o servidor falso.

const QUEM = { usuario: 'user-1', nome: 'suzanne@exemplo.com' };
const MOTIVO = 'tabela de preços do caixa';
const COLUNAS = [
  { nome: 'servico', tipo: 'text', obrigatoria: true },
  { nome: 'valor', tipo: 'numeric(12,2)', padrao: 0 },
];

function montar(o: Parameters<typeof servidorAdminFalso>[0] = { maisTabelas: true }) {
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

// ---------------------------------------------------------------- portão por e-mail

test('portão: quem não escreve não vê as ferramentas de estrutura; quem escreve vê as quatro; o SQL livre NÃO existe mais', async () => {
  const { ctx } = montar();
  const leitor = await cliente(ctx, { escreve: false });
  const nomes = (await leitor.c.listTools()).tools.map((t) => t.name);
  assert.ok(!nomes.some((n) => n.includes('estrutura') || n.includes('_tabela') || n.includes('_coluna') || n.includes('_indice')), nomes.join());
  const escritor = await cliente(ctx, { escreve: true });
  const todos = (await escritor.c.listTools()).tools.map((t) => t.name);
  for (const n of ['sistemas_preparar_tabela', 'sistemas_preparar_coluna', 'sistemas_preparar_indice', 'sistemas_confirmar_estrutura']) assert.ok(todos.includes(n), n);
  assert.ok(!todos.includes('sistemas_preparar_estrutura'), 'a ferramenta de SQL livre foi removida');
  for (const t of (await escritor.c.listTools()).tools.filter((x) => x.name.startsWith('sistemas_preparar_t') || x.name.startsWith('sistemas_preparar_c') || x.name.startsWith('sistemas_preparar_i'))) {
    assert.ok(!('sql' in ((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})), `${t.name} não pode receber SQL`);
  }
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

test('tabela: preparar só LÊ o esquema, mostra resumo e o SQL gerado; confirmar manda os campos + o SQL aprovado e registra', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const p = await prepararTabela(ctx, pend, QUEM, { nome: 'caixa_x', colunas: COLUNAS, motivo: MOTIVO });
  assert.deepEqual(srv.chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['GET /admin/v1/esquema'], 'preparar não escreve');
  assert.equal(srv.estruturas.length, 0);
  assert.match(p.sql, /^create table public\."caixa_x" \("id" uuid primary key default gen_random_uuid\(\), "criado_em" timestamptz not null default now\(\), "servico" text not null, "valor" numeric\(12,2\) default 0\.00\);\nalter table public\."caixa_x" enable row level security;\ncreate policy "caixa_x_sel"/);
  assert.match(p.resumo[0], /Cria a tabela caixa_x/);
  assert.match(p.resumo[1], /só a gestão/);
  assert.match(p.confirmacao, /^est-[0-9a-f]{18}$/);
  assert.match(p.instrucao, /sistemas_confirmar_estrutura/);
  const rastro: { sql?: string; motivo?: string; resultado?: string } = {};
  const r = await confirmarEstrutura(ctx, pend, QUEM, { confirmacao: p.confirmacao }, rastro);
  assert.equal(r.ok, true);
  assert.equal(r.comandos, 5);
  assert.equal(srv.estruturas.length, 1);
  assert.deepEqual(srv.estruturas[0], { tipo: 'tabela', nome: 'caixa_x', colunas: COLUNAS, sqlAprovado: p.sql, quem: QUEM.nome, motivo: MOTIVO });
  const c = srv.chamadas.at(-1)!;
  assert.equal(c.caminho, '/admin/v1/estrutura');
  assert.equal(c.chave, CHAVE_FALSA);
  assert.equal(c.quem, QUEM.nome);
  assert.deepEqual(rastro, { sql: p.sql, motivo: MOTIVO, resultado: 'ok' });
  assert.ok(!('sql' in srv.estruturas[0]!), 'o servidor não recebe SQL livre, só os campos e o SQL aprovado para comparar');
});

test('coluna e índice: preparar confere o que existe (linhas, colunas); confirmar manda os campos', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const c1 = await prepararColuna(ctx, pend, QUEM, { tabela: 'caixa_precos', coluna: { nome: 'ativo', tipo: 'boolean', obrigatoria: true, padrao: true }, motivo: MOTIVO });
  assert.equal(c1.sql, 'alter table public."caixa_precos" add column "ativo" boolean not null default true');
  assert.match(c1.avisos.join(' '), /já existem em caixa_precos recebem o padrão true/);
  await confirmarEstrutura(ctx, pend, QUEM, { confirmacao: c1.confirmacao });
  assert.equal(srv.estruturas[0]!.tipo, 'coluna');
  const i1 = await prepararIndice(ctx, pend, QUEM, { tabela: 'caixa_precos', colunas: ['servico', 'valor'], unico: true, motivo: MOTIVO });
  assert.equal(i1.sql, 'create unique index if not exists "caixa_precos_servico_valor_uq" on public."caixa_precos" ("servico", "valor")');
  await confirmarEstrutura(ctx, pend, QUEM, { confirmacao: i1.confirmacao });
  assert.deepEqual(srv.estruturas[1], { tipo: 'indice', tabela: 'caixa_precos', colunas: ['servico', 'valor'], unico: true, sqlAprovado: i1.sql, quem: QUEM.nome, motivo: MOTIVO });
});

test('recusas: tabela fechada, já existe, tipo fora da lista, padrão perigoso, obrigatória sem padrão em tabela com linhas — nada é escrito', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const ruim = (fn: () => Promise<unknown>, re: RegExp) => assert.rejects(fn, (e: Error) => e instanceof ErroDeEntrada && re.test(e.message));
  await ruim(() => prepararTabela(ctx, pend, QUEM, { nome: 'rh_usuarios2', colunas: COLUNAS, motivo: MOTIVO }), /tabela fechada/);
  await ruim(() => prepararTabela(ctx, pend, QUEM, { nome: 'admin_log', colunas: COLUNAS, motivo: MOTIVO }), /tabela fechada/);
  await ruim(() => prepararTabela(ctx, pend, QUEM, { nome: 'caixa_precos', colunas: COLUNAS, motivo: MOTIVO }), /já existe/);
  await ruim(() => prepararTabela(ctx, pend, QUEM, { nome: 'caixa_y', colunas: [{ nome: 'a1', tipo: 'regclass' }], motivo: MOTIVO }), /não é permitido/);
  await ruim(() => prepararTabela(ctx, pend, QUEM, { nome: 'caixa_y', colunas: [{ nome: 'a1', tipo: 'text', padrao: "x'; drop table y; --" }], motivo: MOTIVO }), /padrão/);
  await ruim(() => prepararTabela(ctx, pend, QUEM, { nome: 'caixa_y; drop table z', colunas: COLUNAS, motivo: MOTIVO }), /nome da tabela/);
  await ruim(() => prepararColuna(ctx, pend, QUEM, { tabela: 'rh_usuarios', coluna: { nome: 'papel2', tipo: 'text' }, motivo: MOTIVO }), /tabela fechada/);
  await ruim(() => prepararColuna(ctx, pend, QUEM, { tabela: 'caixa_precos', coluna: { nome: 'obrig', tipo: 'integer', obrigatoria: true }, motivo: MOTIVO }), /precisa de "padrao"/);
  await ruim(() => prepararColuna(ctx, pend, QUEM, { tabela: 'caixa_nao_existe', coluna: { nome: 'obrig', tipo: 'integer' }, motivo: MOTIVO }), /não existe/);
  await ruim(() => prepararIndice(ctx, pend, QUEM, { tabela: 'caixa_precos', colunas: ['nada'], motivo: MOTIVO }), /não existe/);
  await ruim(() => prepararTabela(ctx, pend, QUEM, { nome: 'caixa_y', colunas: COLUNAS, motivo: 'x' }), /motivo/);
  assert.equal(srv.estruturas.length, 0);
  assert.ok(srv.chamadas.every((c) => c.metodo === 'GET'), 'só leituras');
});

test('confirmação reusada, desconhecida, de outro usuário, de outro tipo e vencida: nada vai ao servidor', async () => {
  let agora = 5_000_000;
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas(() => agora);
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: 'est-inventado' }), /desconhecido ou já usado/);
  const p = await prepararTabela(ctx, pend, QUEM, { nome: 'caixa_a', colunas: COLUNAS, motivo: MOTIVO });
  await assert.rejects(() => confirmarEstrutura(ctx, pend, { usuario: 'outro', nome: 'o@x' }, { confirmacao: p.confirmacao }), /outro usuário/);
  assert.equal(srv.estruturas.length, 0);
  // código de estrutura não vale para confirmar dados, e o de dados não vale para estrutura; nenhum dos dois é gasto na tentativa errada
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
  const v = await prepararTabela(ctx, pend, QUEM, { nome: 'caixa_b', colunas: COLUNAS, motivo: MOTIVO });
  agora += 11 * 60_000;
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: v.confirmacao }), /venceu.*prepare/);
  assert.equal(srv.estruturas.length, 1);
});

test('o servidor recusou (ok:false): vira erro em português e o código se gasta; erro 5xx: não sei se gravou, o código volta', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const p = await prepararTabela(ctx, pend, QUEM, { nome: 'falha_do_banco', colunas: COLUNAS, motivo: MOTIVO });
  const rastro: { resultado?: string } = {};
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: p.confirmacao }, rastro), /NÃO aplicou: o SQL mudou desde a prévia.*desfaz/);
  assert.match(rastro.resultado!, /^recusado/);
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /desconhecido ou já usado/);

  const q = await prepararTabela(ctx, pend, QUEM, { nome: 'erro_do_servidor', colunas: COLUNAS, motivo: MOTIVO });
  await assert.rejects(
    () => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: q.confirmacao }),
    (e: Error) => /NÃO sei se a estrutura foi alterada/.test(e.message) && !e.message.includes(CONFIG_FALSA.api),
  );
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: q.confirmacao }), /NÃO sei se/);
  assert.equal(srv.estruturas.length, 0);
});

test('servidor sem a rota (404) e resposta fora do contrato', async () => {
  const { ctx } = montar();
  const conta = ctx.contas.get('hm-tecnologia')!;
  const pend = new PendentesSistemas();
  const original = conta.fonte.chamar;
  const p = await prepararTabela(ctx, pend, QUEM, { nome: 'caixa_c', colunas: COLUNAS, motivo: MOTIVO });
  conta.fonte.chamar = async (m, c, o) => {
    if (c.endsWith('/estrutura')) throw new ErroSistemas('o servidor do sistema novo não tem essa rota (404): confira a URL base no painel de integrações e a versão do servidor', 404);
    return original(m, c, o);
  };
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /não tem essa rota/);
  const q = await prepararTabela(ctx, pend, QUEM, { nome: 'caixa_d', colunas: COLUNAS, motivo: MOTIVO });
  conta.fonte.chamar = async (m, c, o) => (c.endsWith('/estrutura') ? { qualquer: 'coisa' } : original(m, c, o));
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: q.confirmacao }), /fora do contrato/);
  conta.fonte.chamar = original;
  assert.equal((await confirmarEstrutura(ctx, pend, QUEM, { confirmacao: q.confirmacao })).ok, true, 'resposta incerta devolve o código');
});

test('pelo MCP: dois passos, auditoria leva o pedido, o SQL e o resultado; a chave nunca aparece', async () => {
  const { srv, ctx } = montar();
  const { chamar, auditoria, fechar } = await cliente(ctx, { escreve: true });
  const p = await chamar('sistemas_preparar_tabela', { nome: 'caixa_e', colunas: COLUNAS, motivo: MOTIVO });
  assert.equal(p.erro, false, p.texto);
  assert.match(p.json.sql, /create table public\."caixa_e"/);
  const c = await chamar('sistemas_confirmar_estrutura', { confirmacao: p.json.confirmacao });
  assert.equal(c.json.ok, true, c.texto);
  assert.equal(srv.estruturas.length, 1);
  const prep = auditoria.find((a) => a.ferramenta === 'sistemas_preparar_tabela')!;
  assert.equal(prep.argumentos.nome, 'caixa_e');
  assert.equal(prep.argumentos.motivo, MOTIVO);
  const conf = auditoria.find((a) => a.ferramenta === 'sistemas_confirmar_estrutura')!;
  assert.equal(conf.ok, true);
  assert.match(conf.argumentos.sql, /create table public\."caixa_e"/);
  assert.equal(conf.argumentos.resultado, 'ok');
  // o SQL livre não existe: a ferramenta antiga some e as novas recusam entrada ruim com mensagem clara
  const antiga = await chamar('sistemas_preparar_estrutura', { sql: 'drop table x', motivo: MOTIVO }).catch((e: Error) => ({ erro: true, texto: String(e.message) }));
  assert.equal(antiga.erro, true);
  const ruim = await chamar('sistemas_preparar_tabela', { nome: 'caixa_f', colunas: [{ nome: 'a1', tipo: 'serial' }], motivo: MOTIVO });
  assert.equal(ruim.erro, true);
  assert.match(ruim.texto, /não é permitido.*Tipos aceitos/);
  assert.equal(auditoria.at(-1)!.ok, false);
  assert.ok(!JSON.stringify([p.texto, c.texto, ruim.texto, auditoria]).includes(CHAVE_FALSA));
  await fechar();
});

test('descrições em português dizem que é por campos, que não há SQL próprio nem DROP, e as tabelas fechadas', async () => {
  const { ctx } = montar();
  const { c, fechar } = await cliente(ctx, { escreve: true });
  const t = (await c.listTools()).tools.find((x) => x.name === 'sistemas_preparar_tabela')!;
  assert.match(t.description!, /sem SQL/);
  assert.match(t.description!, /não há DROP, renomear nem SQL próprio/);
  assert.match(t.description!, /rh_usuarios, rh_docs, rh_log/);
  assert.match(t.description!, /text, integer, bigint, numeric\(12,2\), boolean, date, timestamptz, uuid, jsonb/);
  await fechar();
});
