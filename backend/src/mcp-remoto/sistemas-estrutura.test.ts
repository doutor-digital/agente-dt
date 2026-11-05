import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { ErroSistemas, sistemasChamar } from '../lib/integracoes/sistemas.js';
import { criarContextoSistemas, PendentesSistemas, prepararAlteracao, registrarEscritaSistemas, registrarLeituraSistemas, type ContaSistemas } from './sistemas.js';
import { impressaoDasPoliticas } from './estrutura-campos.js';
import { confirmarEstrutura, prepararColuna, prepararIndice, prepararRegra, prepararTabela, registrarEstruturaSistemas } from './sistemas-estrutura.js';
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

test('portão: quem não escreve não vê as ferramentas de estrutura; quem escreve vê as cinco; o SQL livre NÃO existe mais', async () => {
  const { ctx } = montar();
  const leitor = await cliente(ctx, { escreve: false });
  const nomes = (await leitor.c.listTools()).tools.map((t) => t.name);
  assert.ok(!nomes.some((n) => n.includes('estrutura') || n.includes('_tabela') || n.includes('_coluna') || n.includes('_indice') || n.includes('_regra')), nomes.join());
  const escritor = await cliente(ctx, { escreve: true });
  const todos = (await escritor.c.listTools()).tools.map((t) => t.name);
  for (const n of ['sistemas_preparar_tabela', 'sistemas_preparar_coluna', 'sistemas_preparar_indice', 'sistemas_preparar_regra', 'sistemas_confirmar_estrutura']) assert.ok(todos.includes(n), n);
  assert.ok(!todos.includes('sistemas_preparar_estrutura'), 'a ferramenta de SQL livre foi removida');
  for (const t of (await escritor.c.listTools()).tools.filter((x) => x.name.startsWith('sistemas_preparar_t') || x.name.startsWith('sistemas_preparar_c') || x.name.startsWith('sistemas_preparar_i') || x.name.startsWith('sistemas_preparar_r'))) {
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
  assert.match(p.resumo[1], /gestao_e_financeiro.*admin, gestão e financeiro/s);
  assert.match(p.confirmacao, /^est-[0-9a-f]{18}$/);
  assert.match(p.instrucao, /sistemas_confirmar_estrutura/);
  const rastro: { sql?: string; motivo?: string; resultado?: string } = {};
  const r = await confirmarEstrutura(ctx, pend, QUEM, { confirmacao: p.confirmacao }, rastro);
  assert.equal(r.ok, true);
  assert.equal(r.comandos, 9);
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
  assert.match(t.description!, /não há DROP de tabela, coluna ou índice, nem renomear, nem SQL próprio/);
  assert.match(t.description!, /rh_usuarios, rh_docs, rh_log/);
  assert.match(t.description!, /text, integer, bigint, numeric\(12,2\), boolean, date, timestamptz, uuid, jsonb/);
  await fechar();
});

test('servidor antigo (API 0.1.9: "escreva o SQL (campo sql)"): a mensagem diz que o servidor está desatualizado, nada é criado e o código se gasta', async () => {
  const { ctx } = montar();
  const conta = [...ctx.contas.values()][0]!;
  conta.fonte.chamar = async (m, c) => {
    if (m === 'GET') return { tabelas: [] };
    throw new ErroSistemas('escreva o SQL (campo sql)', 400);
  };
  const pend = new PendentesSistemas();
  const p = await prepararTabela(ctx, pend, QUEM, { nome: 'caixa_x', colunas: COLUNAS, motivo: MOTIVO });
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /versão ANTIGA.*0\.1\.10.*NADA foi criado.*0\.1\.10\.1/);
});

// ---------------------------------------------------------------- regra de acesso por modelo fechado

test('tabela com regra: o SQL mostra as políticas e os privilégios do modelo; o servidor recebe regra + coluna_unidade; sem regra o pedido é o de sempre (sem os campos novos)', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const cols = [{ nome: 'loja', tipo: 'text', obrigatoria: true }, { nome: 'valor', tipo: 'numeric(12,2)' }];
  const p = await prepararTabela(ctx, pend, QUEM, { nome: 'caixa_transf', colunas: cols, regra: 'unidade_le_e_lanca', coluna_unidade: 'loja', motivo: MOTIVO });
  assert.match(p.sql, /create policy "caixa_transf_sel" on public\."caixa_transf" for select to authenticated using \(public\.caixa_pode\("loja"\)\)/);
  assert.match(p.sql, /create policy "caixa_transf_ins" .* with check \(public\.caixa_pode\("loja"\)\)/);
  assert.match(p.sql, /create policy "caixa_transf_upd" .* using \(public\.caixa_gestor\(\)\) with check \(public\.caixa_gestor\(\)\)/);
  assert.match(p.sql, /revoke all on table public\."caixa_transf" from public, anon, authenticated, service_role, mcp_leitor, mcp_consulta_rh/);
  assert.match(p.sql, /grant select on table public\."caixa_transf" to mcp_leitor, mcp_consulta_rh/);
  assert.match(p.resumo.join(' '), /unidade_le_e_lanca.*CRIA linhas da sua unidade.*coluna loja/s);
  assert.match(p.resumo.join(' '), /LÊ TODAS AS LINHAS/);
  await confirmarEstrutura(ctx, pend, QUEM, { confirmacao: p.confirmacao });
  assert.deepEqual(srv.estruturas[0], { tipo: 'tabela', nome: 'caixa_transf', colunas: cols, regra: 'unidade_le_e_lanca', coluna_unidade: 'loja', sqlAprovado: p.sql, quem: QUEM.nome, motivo: MOTIVO });
  const sem = await prepararTabela(ctx, pend, QUEM, { nome: 'caixa_sem', colunas: COLUNAS, motivo: MOTIVO });
  await confirmarEstrutura(ctx, pend, QUEM, { confirmacao: sem.confirmacao });
  assert.ok(!('regra' in srv.estruturas[1]!) && !('coluna_unidade' in srv.estruturas[1]!), 'sem regra, o pedido não leva os campos novos (servidor antigo entende)');
});

test('coluna única com a regra unidade_le_e_lanca avisa do erro de duplicidade que revela valor de outra unidade', async () => {
  const { ctx } = montar();
  const p = await prepararTabela(ctx, new PendentesSistemas(), QUEM, { nome: 'caixa_u', colunas: [{ nome: 'unidade', tipo: 'text' }, { nome: 'codigo', tipo: 'text', unica: true }], regra: 'unidade_le_e_lanca', motivo: MOTIVO });
  assert.match(p.avisos.join(' '), /ÚNICA.*descobre que o valor existe/);
});

test('troca de regra: só em tabela criada por este caminho; preparar só LÊ; confirmar manda tipo "regra" + campos + SQL aprovado', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const p = await prepararRegra(ctx, pend, QUEM, { tabela: 'caixa_semaforo', regra: 'so_admin_e_gestao', motivo: MOTIVO });
  assert.deepEqual(srv.chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['GET /admin/v1/esquema'], 'preparar não escreve');
  assert.match(p.sql, /^drop policy if exists "caixa_semaforo_sel" on public\."caixa_semaforo";\ndrop policy if exists "caixa_semaforo_ins"/);
  assert.match(p.sql, /create policy "caixa_semaforo_sel" .* using \(public\.rh_admin\(\)\)/);
  assert.match(p.avisos.join(' '), /guardadas em admin_backup/);
  assert.doesNotMatch(p.avisos.join(' '), /o servidor não informou o dono/, 'com o dono informado não há esse aviso');
  assert.match(p.avisos.join(' '), /já tem linhas/);
  assert.equal(p.avisos.some((a: string) => /NÃO tem as travas de status/.test(a)), false, 'so_admin_e_gestao não leva o aviso do modelo de unidade');
  const l = await prepararRegra(ctx, pend, QUEM, { tabela: 'caixa_semaforo', regra: 'unidade_le_e_lanca', motivo: MOTIVO });
  assert.match(l.avisos.join(' '), /NÃO tem as travas de status e de autor.*\n?.*se a tabela tem coluna ou índice ÚNICO/s, 'a troca para unidade_le_e_lanca avisa do modelo e da duplicidade (o esquema não mostra índices únicos)');
  const rastro: { sql?: string; resultado?: string } = {};
  const r = await confirmarEstrutura(ctx, pend, QUEM, { confirmacao: p.confirmacao }, rastro);
  assert.equal(r.ok, true);
  const { politicas_vistas: vistas, ...resto } = srv.estruturas[0] as Record<string, unknown>;
  assert.deepEqual(resto, { tipo: 'regra', tabela: 'caixa_semaforo', regra: 'so_admin_e_gestao', sqlAprovado: p.sql, quem: QUEM.nome, motivo: MOTIVO });
  assert.equal(typeof vistas, 'string', 'a troca leva a impressão das políticas que a prévia viu');
  assert.equal(vistas, impressaoDasPoliticas((await esquemaDe(srv, 'caixa_semaforo')).politicas), 'a mesma função do servidor, sobre o /esquema');
  assert.equal(rastro.resultado, 'ok');
  // com a coluna de unidade escolhida
  const u = await prepararRegra(ctx, pend, QUEM, { tabela: 'caixa_semaforo', regra: 'unidade_le_gestao_grava', coluna_unidade: 'loja', motivo: MOTIVO });
  assert.match(u.sql, /using \(public\.caixa_pode\("loja"\)\)/);
});

test('troca de regra recusada (nada vai ao servidor): tabela antiga, fechada, inexistente, com política de outra origem, regra inexistente/construída, coluna de unidade ruim, nome malicioso', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const ruim = (a: Parameters<typeof prepararRegra>[3], re: RegExp) => assert.rejects(() => prepararRegra(ctx, pend, QUEM, a), (e: Error) => e instanceof ErroDeEntrada && re.test(e.message));
  await ruim({ tabela: 'fin_lanc', regra: 'gestao_e_financeiro', motivo: MOTIVO }, /não foi criada por este caminho \(o dono é sistemas\)/);
  await ruim({ tabela: 'rh_funcionarios', regra: 'gestao_e_financeiro', motivo: MOTIVO }, /não foi criada por este caminho/);
  await ruim({ tabela: 'caixa_lancamentos', regra: 'gestao_e_financeiro', motivo: MOTIVO }, /não foi criada por este caminho/);
  await ruim({ tabela: 'rh_usuarios', regra: 'gestao_e_financeiro', motivo: MOTIVO }, /tabela fechada/);
  await ruim({ tabela: 'rh_docs', regra: 'so_admin_e_gestao', motivo: MOTIVO }, /tabela fechada/);
  await ruim({ tabela: 'admin_log', regra: 'so_admin_e_gestao', motivo: MOTIVO }, /tabela fechada/);
  await ruim({ tabela: 'auth.users', regra: 'so_admin_e_gestao', motivo: MOTIVO }, /use minúsculas/);
  await ruim({ tabela: 'caixa_semaforo"; drop table x; --', regra: 'so_admin_e_gestao', motivo: MOTIVO }, /use minúsculas/);
  await ruim({ tabela: 'caixa_nao_existe', regra: 'so_admin_e_gestao', motivo: MOTIVO }, /não existe/);
  await ruim({ tabela: 'caixa_estranha', regra: 'so_admin_e_gestao', motivo: MOTIVO }, /política que este caminho não criou \(liberada_por_fora\)/);
  await ruim({ tabela: 'caixa_semaforo', regra: 'todo_mundo_le', motivo: MOTIVO }, /não existe\. Regras aceitas/);
  for (const regra of ['__proto__', 'constructor', 'toString', 'true', 'gestao_e_financeiro; drop table x']) await ruim({ tabela: 'caixa_semaforo', regra, motivo: MOTIVO }, /não existe\. Regras aceitas/);
  await ruim({ tabela: 'caixa_semaforo', regra: 'unidade_le_e_lanca', coluna_unidade: 'valor', motivo: MOTIVO }, /tem de ser text/);
  await ruim({ tabela: 'caixa_semaforo', regra: 'unidade_le_e_lanca', coluna_unidade: 'nada', motivo: MOTIVO }, /a coluna "nada" não existe na tabela/);
  await ruim({ tabela: 'caixa_semaforo', regra: 'gestao_e_financeiro', coluna_unidade: 'unidade', motivo: MOTIVO }, /não usa coluna de unidade/);
  await ruim({ tabela: 'caixa_semaforo', regra: 'unidade_le_e_lanca', coluna_unidade: 'unidade"); drop table x; --', motivo: MOTIVO }, /use minúsculas/);
  await ruim({ tabela: 'caixa_vazia', regra: 'unidade_le_gestao_grava', motivo: MOTIVO }, /a coluna "unidade" não existe na tabela/);
  await ruim({ tabela: 'caixa_semaforo', regra: 'gestao_e_financeiro', motivo: 'x' }, /motivo/);
  await ruim({ tabela: 'caixa_vista', regra: 'gestao_e_financeiro', motivo: MOTIVO }, /não é uma tabela comum/);
  assert.equal(srv.estruturas.length, 0);
  assert.ok(srv.chamadas.every((c) => c.metodo === 'GET'), 'só leituras');
});

test('servidor SEM o dono no /esquema (antes da 0.1.10.8-pol): a prévia deixa passar a tabela de outro dono, e QUEM RECUSA É O SERVIDOR; tipo "regra" desconhecido => mensagem de servidor desatualizado, nada muda', async () => {
  const { srv, ctx } = montar({ maisTabelas: true, servidorAntigo: true });
  const pend = new PendentesSistemas();
  const p = await prepararRegra(ctx, pend, QUEM, { tabela: 'fin_lanc', regra: 'gestao_e_financeiro', motivo: MOTIVO });
  assert.match(p.sql, /drop policy if exists "fin_lanc_sel"/, 'sem o dono a prévia não sabe: é o servidor que recusa');
  const rastro: { resultado?: string } = {};
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: p.confirmacao }, rastro), /ANTERIOR à 0\.1\.10\.8-pol.*NADA foi alterado/);
  assert.equal(rastro.resultado, 'servidor desatualizado');
  assert.equal(srv.estruturas.length, 0);
  assert.match(p.avisos.join(' '), /o servidor não informou o dono de fin_lanc.*NÃO foi conferido nesta prévia/, 'sem o dono, a prévia AVISA que não conferiu');
  // a variante em que o mesmo texto chegaria como 200 { ok:false }
  const b = montar({ maisTabelas: true, servidorAntigo: true, antigoComo200: true });
  const pb = new PendentesSistemas();
  const q = await prepararRegra(b.ctx, pb, QUEM, { tabela: 'caixa_semaforo', regra: 'so_admin_e_gestao', motivo: MOTIVO });
  await assert.rejects(() => confirmarEstrutura(b.ctx, pb, QUEM, { confirmacao: q.confirmacao }), /ANTERIOR à 0\.1\.10\.8-pol.*NADA foi alterado/);
  // tabela com regra num servidor que ignora a regra: o SQL gerado "difere" e o aviso diz o porquê provável
  const t = await prepararTabela(ctx, pend, QUEM, { nome: 'caixa_k', colunas: COLUNAS, regra: 'so_admin_e_gestao', motivo: MOTIVO });
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: t.confirmacao }), /gera agora é diferente.*Se a tabela NÃO mudou desde a prévia.*ANTERIOR à 0\.1\.10\.8-pol.*Se a tabela mudou, é só preparar de novo/s);
  assert.equal(srv.estruturas.length, 0);
});

test('pelo MCP: a regra é um enum fechado no esquema da ferramenta, a descrição lista os 4 modelos e avisa que a Lia lê tudo; regra fora da lista é recusada antes de chegar ao conector', async () => {
  const { srv, ctx } = montar();
  const { c, chamar, auditoria, fechar } = await cliente(ctx, { escreve: true });
  const tools = (await c.listTools()).tools;
  const t = tools.find((x) => x.name === 'sistemas_preparar_tabela')!;
  const r = tools.find((x) => x.name === 'sistemas_preparar_regra')!;
  for (const ferramenta of [t, r]) {
    const prop = (ferramenta.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties.regra!;
    assert.deepEqual(prop.enum, ['unidade_le_gestao_grava', 'unidade_le_e_lanca', 'gestao_e_financeiro', 'so_admin_e_gestao']);
    for (const m of ['unidade_le_gestao_grava', 'unidade_le_e_lanca', 'gestao_e_financeiro', 'so_admin_e_gestao']) assert.match(ferramenta.description!, new RegExp(m));
    assert.ok(!('sql' in (ferramenta.inputSchema as { properties: object }).properties));
  }
  assert.match(t.description!, /A leitura da Lia \(consulta\) vê TODAS as linhas/);
  assert.match(r.description!, /fin_\*, caixa_lanc, rh_docs, portal_vinculo.*RECUSADAS/);
  assert.equal((r.annotations as { readOnlyHint?: boolean }).readOnlyHint, true, 'preparar não escreve');
  const fora = await chamar('sistemas_preparar_regra', { tabela: 'caixa_semaforo', regra: 'aberto_para_todos', motivo: MOTIVO });
  assert.equal(fora.erro, true);
  const proto = await chamar('sistemas_preparar_regra', { tabela: 'caixa_semaforo', regra: '__proto__', motivo: MOTIVO });
  assert.equal(proto.erro, true);
  const antiga = await chamar('sistemas_preparar_regra', { tabela: 'fin_lanc', regra: 'gestao_e_financeiro', motivo: MOTIVO });
  assert.equal(antiga.erro, true);
  assert.match(antiga.texto, /não foi criada por este caminho/);
  const ok = await chamar('sistemas_preparar_regra', { tabela: 'caixa_semaforo', regra: 'unidade_le_e_lanca', motivo: MOTIVO });
  assert.equal(ok.erro, false, ok.texto);
  const conf = await chamar('sistemas_confirmar_estrutura', { confirmacao: ok.json.confirmacao });
  assert.equal(conf.json.ok, true, conf.texto);
  assert.equal(srv.estruturas.length, 1);
  assert.equal(auditoria.find((a) => a.ferramenta === 'sistemas_preparar_regra' && a.ok)!.argumentos.regra, 'unidade_le_e_lanca');
  assert.ok(!JSON.stringify([ok.texto, conf.texto, auditoria]).includes(CHAVE_FALSA));
  await fechar();
});

/** a tabela como o /esquema do servidor falso a entrega (pergunta a ele como o conector pergunta) */
async function esquemaDe(srv: ReturnType<typeof servidorAdminFalso>, tabela: string): Promise<{ politicas: Array<Record<string, unknown>> }> {
  const r = await srv.fetch('http://servidor-falso/admin/v1/esquema', { method: 'GET', headers: { 'x-admin-key': CHAVE_FALSA } } as never);
  return (JSON.parse(await r.text()) as { tabelas: Array<{ nome: string; politicas: Array<Record<string, unknown>> }> }).tabelas.find((t) => t.nome === tabela)!;
}

// ---------------------------------------------------------------- bloco 2 do sênior

test('COMPATIBILIDADE: conector novo + servidor 0.1.10.6 — criar TABELA é recusada COM e SEM regra, com a dica de versão nos dois casos; coluna e índice passam; a troca de regra diz "servidor anterior"', async () => {
  const { srv, ctx } = montar({ maisTabelas: true, servidorAntigo: true });
  const pend = new PendentesSistemas();
  for (const regra of [undefined, 'so_admin_e_gestao']) {
    const t = await prepararTabela(ctx, pend, QUEM, { nome: `caixa_${regra ? 'com' : 'sem'}`, colunas: COLUNAS, ...(regra ? { regra } : {}), motivo: MOTIVO });
    await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: t.confirmacao }), /gera agora é diferente.*Se a tabela NÃO mudou desde a prévia.*ANTERIOR à 0\.1\.10\.8-pol.*com ou sem regra de acesso.*preparar de novo não resolve.*Se a tabela mudou, é só preparar de novo/s);
  }
  assert.equal(srv.estruturas.length, 0);
  const c = await prepararColuna(ctx, pend, QUEM, { tabela: 'caixa_precos', coluna: { nome: 'ativo', tipo: 'boolean' }, motivo: MOTIVO });
  assert.equal((await confirmarEstrutura(ctx, pend, QUEM, { confirmacao: c.confirmacao })).ok, true);
  const i = await prepararIndice(ctx, pend, QUEM, { tabela: 'caixa_precos', colunas: ['servico'], motivo: MOTIVO });
  assert.equal((await confirmarEstrutura(ctx, pend, QUEM, { confirmacao: i.confirmacao })).ok, true);
  assert.equal(srv.estruturas.length, 2, 'coluna e índice chegaram');
});

test('texto verdadeiro: descrições e instruções dizem que coluna e índice valem em tabela antiga, que a troca de regra leva "drop policy" e que tabela exige conector e servidor juntos', async () => {
  const { ctx } = montar();
  const { c, fechar } = await cliente(ctx, { escreve: true });
  const ferramentas = (await c.listTools()).tools;
  const por = (n: string) => ferramentas.find((x) => x.name === n)!;
  assert.match(por('sistemas_preparar_coluna').description!, /inclusive tabela antiga de outro dono como fin_\* e caixa_\*/);
  assert.match(por('sistemas_preparar_indice').description!, /inclusive tabela antiga de outro dono/);
  assert.match(por('sistemas_preparar_regra').description!, /drop policy if exists/);
  const fonte = readFileSync(new URL('./servidor.ts', import.meta.url), 'utf8');
  assert.match(fonte, /coluna e índice valem também em tabela antiga; a regra só troca em tabela criada por este caminho/);
  assert.doesNotMatch(fonte, /tabela de outro dono não existem/);
  const estr = readFileSync(new URL('./sistemas-estrutura.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(estr, /tudo como antes/);
  await fechar();
});

test('índice ÚNICO em tabela que deixa a unidade criar linhas (unidade_le_e_lanca) avisa da duplicidade; índice comum e tabela de outro modelo, não', async () => {
  const { ctx } = montar();
  const pend = new PendentesSistemas();
  const u = await prepararIndice(ctx, pend, QUEM, { tabela: 'caixa_lancada', colunas: ['codigo'], unico: true, motivo: MOTIVO });
  assert.match(u.avisos.join(' '), /deixa a UNIDADE criar linhas.*descobre que o valor existe/);
  assert.doesNotMatch((await prepararIndice(ctx, pend, QUEM, { tabela: 'caixa_lancada', colunas: ['codigo'], motivo: MOTIVO })).avisos.join(' '), /UNIDADE criar/);
  assert.doesNotMatch((await prepararIndice(ctx, pend, QUEM, { tabela: 'caixa_semaforo', colunas: ['loja'], unico: true, motivo: MOTIVO })).avisos.join(' '), /UNIDADE criar/);
});

test('troca de regra: a impressão que vai ao servidor é a do /esquema; coluna_unidade sem regra na tabela nova é recusada (não cai em outra regra por engano); objeto com toString não derruba', async () => {
  const { ctx } = montar();
  const pend = new PendentesSistemas();
  await assert.rejects(() => prepararTabela(ctx, pend, QUEM, { nome: 'caixa_q', colunas: [{ nome: 'unidade', tipo: 'text' }], coluna_unidade: 'unidade', motivo: MOTIVO }), (e: Error) => e instanceof ErroDeEntrada && /coluna_unidade só vale junto de uma regra/.test(e.message));
  await assert.rejects(() => prepararTabela(ctx, pend, QUEM, { nome: 'caixa_q', colunas: COLUNAS, regra: { toString: 1 } as never, motivo: MOTIVO }), (e: Error) => e instanceof ErroDeEntrada && /não existe\. Regras aceitas/.test(e.message));
  await assert.rejects(() => prepararTabela(ctx, pend, QUEM, { nome: 'caixa_q', colunas: [{ nome: 'xy', tipo: { toString: 1 } as never }], motivo: MOTIVO }), (e: Error) => e instanceof ErroDeEntrada && /não é permitido/.test(e.message));
});
