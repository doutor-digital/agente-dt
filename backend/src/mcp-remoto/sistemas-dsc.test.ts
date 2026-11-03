import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { lerConfigsSistemas, lerConfigSistemas, sistemasChamar, testarChaveSistemas, type ConfigSistemas } from '../lib/integracoes/sistemas.js';
import { alterarUsuario, criarConvite, criarContextoSistemas, PendentesSistemas, prepararAlteracao, registrarEscritaSistemas, registrarLeituraSistemas, resolverSistema, type ContaSistemas } from './sistemas.js';
import { prepararAdmin, registrarAdminSistemas } from './sistemas-admin.js';
import { prepararTabela, registrarEstruturaSistemas } from './sistemas-estrutura.js';
import { CHAVE_FALSA, CONFIG_FALSA, servidorAdminFalso } from './sistemas-falso.js';
import { confirmarSql, prepararSql, registrarSqlSistemas, sqlDireto } from './sistemas-sql.js';
import { INSTRUCOES } from './servidor.js';

// Os DOIS sistemas pelo mesmo conector: rh (RH/Caixa/Financeiro) e descontratos (Descontratos + Ficha), cada um com o seu servidor e as suas travas.

const QUEM = { usuario: 'user-1', nome: 'suzanne@exemplo.com' };
const MOTIVO = 'status do descontrato';
const CHAVE_DSC = 'CHAVE-DSC-super-secreta-9876543210-abcdef';
const CONFIG_DSC: ConfigSistemas = { api: 'http://api-dsc:8080', chave: CHAVE_DSC, tipo: 'dsc', id: 'descontratos' };
const CONFIG_RH: ConfigSistemas = { ...CONFIG_FALSA, tipo: 'rh', id: 'rh' };

function dois() {
  const rh = servidorAdminFalso({ maisTabelas: true, maisUsuarios: true });
  const dsc = servidorAdminFalso({ tipo: 'dsc' });
  // o servidor falso do dsc confere a chave do dsc
  const dscFetch = (async (url: string, init: RequestInit & { headers: Record<string, string> }) => dsc.fetch(url, { ...init, headers: { ...init.headers, 'x-admin-key': init.headers['x-admin-key'] === CHAVE_DSC ? CHAVE_FALSA : init.headers['x-admin-key'] } })) as unknown as typeof fetch;
  const contas = new Map<string, ContaSistemas>([
    ['rh', { slug: 'rh', nome: 'Doutor Digital · rh', tela: CONFIG_RH.tela, tipo: 'rh', fonte: { chamar: (m, c, op) => sistemasChamar(CONFIG_RH, m, c, op, rh.fetch) } }],
    ['descontratos', { slug: 'descontratos', nome: 'Doutor Digital · descontratos', tipo: 'dsc', fonte: { chamar: (m, c, op) => sistemasChamar(CONFIG_DSC, m, c, op, dscFetch) } }],
  ]);
  return { rh, dsc, ctx: criarContextoSistemas(contas) };
}

async function cliente(ctx: ReturnType<typeof criarContextoSistemas>) {
  const server = new McpServer({ name: 't', version: '1' });
  const auditar = () => {};
  const pend = new PendentesSistemas();
  registrarLeituraSistemas(server, ctx, QUEM, auditar);
  registrarEscritaSistemas(server, ctx, pend, QUEM, auditar);
  registrarEstruturaSistemas(server, ctx, pend, QUEM, auditar);
  registrarSqlSistemas(server, ctx, pend, QUEM, auditar);
  registrarAdminSistemas(server, ctx, pend, QUEM, auditar);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(a), c.connect(b)]);
  const chamar = async (nome: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name: nome, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    const texto = r.content[0]!.text;
    return { erro: r.isError === true, texto, json: r.isError ? null : JSON.parse(texto) };
  };
  return { c, chamar, fechar: () => c.close() };
}

// ---------------------------------------------------------------- configuração

test('configuração: o formato antigo (um sistema) continua valendo; a lista leva os dois, com id e tipo; erros não repetem a chave', async () => {
  const antigo = lerConfigsSistemas(JSON.stringify({ api: 'http://api-rh:8080', chave: CHAVE_FALSA, tela: 'https://rh.exemplo.com.br/' }));
  assert.equal(antigo.length, 1);
  assert.equal(antigo[0]!.id, undefined);
  assert.equal(antigo[0]!.tipo, undefined, 'sem tipo vale como rh');
  assert.equal(lerConfigSistemas(JSON.stringify({ api: 'http://api-rh:8080', chave: CHAVE_FALSA })).chave, CHAVE_FALSA);
  const lista = lerConfigsSistemas(JSON.stringify({ sistemas: [{ id: 'rh', tipo: 'rh', api: 'http://api-rh:8080', chave: CHAVE_FALSA, tela: 'https://rh.exemplo.com.br/' }, { id: 'descontratos', tipo: 'dsc', api: 'http://api-dsc:8080', chave: CHAVE_DSC }]}));
  assert.deepEqual(lista.map((c) => `${c.id}:${c.tipo}:${c.api}`), ['rh:rh:http://api-rh:8080', 'descontratos:dsc:http://api-dsc:8080']);
  const ruins: Array<[unknown, RegExp]> = [
    [{ sistemas: [] }, /lista de 1 a 5/],
    [{ sistemas: [{ tipo: 'rh', api: 'http://a:1', chave: CHAVE_FALSA }] }, /falta o "id"/],
    [{ sistemas: [{ id: 'rh', tipo: 'x', api: 'http://a:1', chave: CHAVE_FALSA }] }, /"tipo" deve ser/],
    [{ sistemas: [{ id: 'RH!', tipo: 'rh', api: 'http://a:1', chave: CHAVE_FALSA }] }, /"id" deve ter/],
    [{ sistemas: [{ id: 'rh', api: 'http://a:1', chave: CHAVE_FALSA }, { id: 'rh', api: 'http://b:1', chave: CHAVE_FALSA }] }, /mesmo "id"/],
    [{ sistemas: [{ id: 'rh', api: 'http://a:1', chave: 'curta' }] }, /sistema 1: "chave" ausente ou curta/],
  ];
  for (const [cfg, re] of ruins) assert.throws(() => lerConfigsSistemas(JSON.stringify(cfg)), (e: Error) => re.test(e.message) && !e.message.includes(CHAVE_FALSA) && !e.message.includes('curta"'));
  // o teste do painel prova a chave de CADA sistema e devolve só contagens
  const fetcher = (async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
    const ok = url.startsWith('http://api-rh') ? init.headers['x-admin-key'] === CHAVE_FALSA : init.headers['x-admin-key'] === CHAVE_DSC;
    return { ok, status: ok ? 200 : 401, text: async () => JSON.stringify(ok ? { usuarios: [{}, {}, {}] } : { erro: 'chave inválida' }) } as unknown as Response;
  }) as unknown as typeof fetch;
  const rotulo = await testarChaveSistemas(JSON.stringify({ sistemas: [{ id: 'rh', tipo: 'rh', api: 'http://api-rh:8080', chave: CHAVE_FALSA, tela: 'https://rh.exemplo.com.br/' }, { id: 'descontratos', tipo: 'dsc', api: 'http://api-dsc:8080', chave: CHAVE_DSC }] }), fetcher);
  assert.equal(rotulo, 'Sistema novo (RH/Caixa · 3 usuários | Descontratos/Ficha · 3 usuários)');
  await assert.rejects(() => testarChaveSistemas(JSON.stringify({ sistemas: [{ id: 'rh', api: 'http://api-rh:8080', chave: CHAVE_FALSA }, { id: 'descontratos', tipo: 'dsc', api: 'http://api-dsc:8080', chave: 'errada-errada-errada-errada' }] }), fetcher), /recusou a chave/);
});

// ---------------------------------------------------------------- escolher o sistema

test('com os dois ligados o conector pede o sistema; "dsc", "ficha", "caixa" e "financeiro" valem como apelidos; cada um fala com o seu servidor e a sua chave', async () => {
  const { rh, dsc, ctx } = dois();
  assert.throws(() => resolverSistema(ctx, undefined), /informe o sistema.*"rh".*"descontratos"/);
  assert.equal(resolverSistema(ctx, 'dsc').slug, 'descontratos');
  assert.equal(resolverSistema(ctx, 'Ficha').slug, 'descontratos');
  assert.equal(resolverSistema(ctx, 'descontratos').slug, 'descontratos');
  assert.equal(resolverSistema(ctx, 'caixa').slug, 'rh');
  assert.equal(resolverSistema(ctx, 'financeiro').slug, 'rh');
  assert.throws(() => resolverSistema(ctx, 'supabase'), /não está ligado/);
  // só o rh ligado: dsc não resolve para nada (não inventa)
  assert.throws(() => resolverSistema(criarContextoSistemas(new Map([['rh', ctx.contas.get('rh')!]])), 'dsc'), /não está ligado/);
  await sqlDireto(ctx, QUEM, { sistema: 'dsc', sql: "update dsc_docs set data = data || jsonb_build_object('status', 'pronto_assinatura') where col = 'cancelamentos' and id = 'abc'", motivo: MOTIVO });
  assert.equal(rh.chamadas.length, 0, 'o RH não recebeu nada');
  assert.deepEqual(dsc.chamadas.filter((c) => c.metodo === 'POST').map((c) => c.caminho), ['/admin/v1/backup', '/admin/v1/sql']);
  assert.equal(dsc.chamadas[0]!.chave, CHAVE_FALSA, 'o falso do dsc troca a chave do dsc pela dele; o que importa é que chegou a chave do dsc ao cliente');
  await sqlDireto(ctx, QUEM, { sistema: 'rh', sql: "update caixa_precos set valor = 1 where servico = 'x'", motivo: MOTIVO });
  assert.ok(rh.chamadas.length > 0);
  assert.equal(dsc.sqls.length, 1);
});

// ---------------------------------------------------------------- SQL no Descontratos

test('Descontratos: o caso da Suzanne (status de um documento) roda direto com backup antes; dsc_usuarios, auth e a estrutura de dsc_docs não', async () => {
  const { dsc, ctx } = dois();
  const r = await sqlDireto(ctx, QUEM, { sistema: 'descontratos', sql: "update dsc_docs set data = data || jsonb_build_object('status', 'pronto_assinatura') where col = 'cancelamentos' and id = 'abc'", motivo: MOTIVO });
  assert.equal(r.ok, true);
  assert.equal(r.sistema, 'descontratos');
  assert.equal(dsc.sqls.length, 1);
  assert.equal(dsc.sqls[0]!.snapshot_id, 'snap-1');
  for (const sql of ["update dsc_usuarios set papel = 'dono' where login = 'x'", 'select * from auth.users', 'alter table dsc_docs add column x int', 'create policy p on dsc_docs for all to authenticated using (true)', 'drop table dsc_site']) {
    await assert.rejects(() => sqlDireto(ctx, QUEM, { sistema: 'descontratos', sql, motivo: MOTIVO }), /NADA foi executado/, sql);
  }
  // nomes do RH não valem no dsc: rh_admin() não é função de acesso dele
  await assert.rejects(() => sqlDireto(ctx, QUEM, { sistema: 'descontratos', sql: 'create policy p on fichas for select to authenticated using (rh_admin())', motivo: MOTIVO }), /rh_admin/);
  await sqlDireto(ctx, QUEM, { sistema: 'descontratos', sql: 'create policy p on fichas for select to authenticated using (dsc_admin())', motivo: MOTIVO });
  // e os do dsc não valem no RH
  await assert.rejects(() => sqlDireto(ctx, QUEM, { sistema: 'rh', sql: 'create policy p on caixa_precos for select to authenticated using (dsc_admin())', motivo: MOTIVO }), /dsc_admin/);
  assert.equal(dsc.sqls.length, 2);
});

test('Descontratos: DROP, TRUNCATE e DELETE sem WHERE em dois passos, com backup antes e confirmado:true no segundo', async () => {
  const { dsc, ctx } = dois();
  const pend = new PendentesSistemas();
  await assert.rejects(() => sqlDireto(ctx, QUEM, { sistema: 'dsc', sql: 'delete from dsc_docs', motivo: MOTIVO }), /DESTRÓI/);
  await assert.rejects(() => sqlDireto(ctx, QUEM, { sistema: 'dsc', sql: 'drop table fichas_eventos', motivo: MOTIVO }), /DESTRÓI/);
  assert.equal(dsc.chamadas.length, 0);
  const p = await prepararSql(ctx, pend, QUEM, { sistema: 'dsc', sql: 'drop table fichas_eventos', motivo: MOTIVO });
  assert.equal(p.sistema, 'descontratos');
  const r = await confirmarSql(ctx, pend, QUEM, { confirmacao: p.confirmacao });
  assert.equal(r.sistema, 'descontratos');
  assert.equal(dsc.sqls[0]!.confirmado, true);
  assert.deepEqual(dsc.chamadas.filter((c) => c.metodo === 'POST').map((c) => c.caminho), ['/admin/v1/backup', '/admin/v1/sql']);
});

// ---------------------------------------------------------------- o que é só do RH

test('usuário, convite, admin e estrutura por campos são do RH: no Descontratos dizem isso e mandam para sistemas_sql, sem falar com o servidor', async () => {
  const { dsc, ctx } = dois();
  const pend = new PendentesSistemas();
  await assert.rejects(() => alterarUsuario(ctx, QUEM, { sistema: 'dsc', acao: 'ativo', usuario: 'u-1', valor: 'não' }), /só existe no RH\/Caixa.*sistemas_sql/);
  await assert.rejects(() => criarConvite(ctx, QUEM, { sistema: 'dsc', nome: 'Carla', login: 'carla', papel: 'unidade', unidade: 'serra' }), /só existe no RH\/Caixa/);
  await assert.rejects(() => prepararAdmin(ctx, pend, QUEM, { sistema: 'dsc', acao: 'promover', usuario: 'u-1', motivo: 'dar acesso ao João' }), /só existe no RH\/Caixa/);
  await assert.rejects(() => prepararTabela(ctx, pend, QUEM, { sistema: 'dsc', nome: 'caixa_x', colunas: [{ nome: 'nome', tipo: 'text' }], motivo: MOTIVO }), /só existe no RH\/Caixa.*sistemas_sql/);
  await assert.rejects(() => prepararAlteracao(ctx, pend, QUEM, { sistema: 'dsc', operacao: 'atualizar', tabela: 'dsc_usuarios', filtro: { login: 'x' }, dados: { papel: 'dono' } }), /dsc_usuarios não muda por aqui/);
  assert.equal(dsc.chamadas.length, 0);
});

test('pelo MCP: as três ferramentas de SQL e o parâmetro sistema aceitam os dois; a descrição manda não usar o Supabase; o texto geral do servidor também', async () => {
  const { ctx } = dois();
  const { c, chamar, fechar } = await cliente(ctx);
  const ferramentas = (await c.listTools()).tools;
  const sql = ferramentas.find((t) => t.name === 'sistemas_sql')!;
  assert.match(sql.description!, /Descontratos\/Ficha/);
  assert.match(sql.description!, /Supabase antigo NÃO é mais usado/);
  const prop = (sql.inputSchema as { properties: Record<string, { description?: string }> }).properties.sistema!;
  assert.match(prop.description!, /"rh".*"descontratos"/);
  for (const re of [/Descontratos/, /Ficha/, /NÃO use o conector do Supabase/, /sistema="descontratos"/, /sistema="rh"/, /as telas já leem o servidor novo/, /dsc_usuarios/]) assert.match(INSTRUCOES, re);
  const r = await chamar('sistemas_sql', { sistema: 'descontratos', sql: "update dsc_docs set data = data || jsonb_build_object('status','x') where col = 'a' and id = 'b'", motivo: MOTIVO });
  assert.equal(r.erro, false, r.texto);
  assert.equal(r.json.sistema, 'descontratos');
  const sem = await chamar('sistemas_sql', { sql: 'update dsc_docs set data = data where id = 1', motivo: MOTIVO });
  assert.equal(sem.erro, true); assert.match(sem.texto, /informe o sistema/);
  const usuarios = await chamar('sistemas_usuarios', { sistema: 'descontratos' });
  assert.equal(usuarios.erro, false);
  assert.ok(!JSON.stringify([r.texto, sem.texto, usuarios.texto]).includes(CHAVE_DSC));
  await fechar();
});
