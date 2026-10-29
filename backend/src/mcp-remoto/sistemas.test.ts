import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErroSistemas, lerConfigSistemas, sistemasChamar, testarChaveSistemas } from '../lib/integracoes/sistemas.js';
import { listarIntegracoes } from './integracoes.js';
import {
  alterarUsuario,
  confirmarAlteracao,
  consultar,
  criarContextoSistemas,
  criarConvite,
  linkDoConvite,
  MAX_CARACTERES,
  PendentesSistemas,
  prepararAlteracao,
  registrarEscritaSistemas,
  registrarLeituraSistemas,
  resolverSistema,
  validarComandoDeDados,
  validarSelect,
  type ContaSistemas,
} from './sistemas.js';
import { CHAVE_FALSA, CONFIG_FALSA, servidorAdminFalso, type OpcoesFalso } from './sistemas-falso.js';

// O sistema novo de RH/Caixa pelo claude.ai (ferramentas sistemas_*), contra um servidor de administração falso.

const QUEM = { usuario: 'user-1', nome: 'suzanne@exemplo.com' };

function montar(o: OpcoesFalso = {}, config = CONFIG_FALSA) {
  const srv = servidorAdminFalso(o);
  const conta: ContaSistemas = {
    slug: 'hm-tecnologia',
    nome: 'HM Tecnologia',
    tela: config.tela,
    fonte: { chamar: (m, c, op) => sistemasChamar(config, m, c, op, srv.fetch) },
  };
  return { srv, ctx: criarContextoSistemas(new Map([[conta.slug, conta]])) };
}

/** Sobe as ferramentas num McpServer de verdade e fala com elas por um cliente MCP. */
async function cliente(ctx: ReturnType<typeof criarContextoSistemas>, o: { escreve: boolean; pendentes?: PendentesSistemas; usuario?: string }) {
  const server = new McpServer({ name: 't', version: '1' });
  const auditoria: Array<{ ferramenta: string; argumentos: unknown; ok: boolean; erro?: string }> = [];
  const auditar = (r: { ferramenta: string; argumentos: unknown; ok: boolean; erro?: string }) => auditoria.push(r);
  const quem = { usuario: o.usuario ?? QUEM.usuario, nome: QUEM.nome };
  registrarLeituraSistemas(server, ctx, quem, auditar);
  if (o.escreve) registrarEscritaSistemas(server, ctx, o.pendentes ?? new PendentesSistemas(), quem, auditar);
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

// ---------------------------------------------------------------- configuração e cliente HTTP

test('configuração: JSON com api, chave e tela; erros não repetem o que foi colado', () => {
  const ok = lerConfigSistemas(JSON.stringify({ api: 'http://api-rh:8080/', chave: CHAVE_FALSA, tela: 'https://rh.exemplo.com.br/app/' }));
  assert.deepEqual(ok, { api: 'http://api-rh:8080', chave: CHAVE_FALSA, tela: 'https://rh.exemplo.com.br/app/' });
  assert.equal(lerConfigSistemas(JSON.stringify({ api: 'http://api-rh:8080', chave: CHAVE_FALSA })).tela, undefined);
  const ruins = [
    CHAVE_FALSA, // chave solta, sem JSON
    `{"api":"http://api-rh:8080","chave":"${CHAVE_FALSA}"`, // JSON quebrado
    JSON.stringify({ api: 'ftp://x', chave: CHAVE_FALSA }),
    JSON.stringify({ api: 'http://u:senha@api-rh:8080', chave: CHAVE_FALSA }),
    JSON.stringify({ api: 'http://api-rh:8080?x=1', chave: CHAVE_FALSA }),
    JSON.stringify({ api: 'http://api-rh:8080', chave: 'curta' }),
    JSON.stringify({ api: 'http://api-rh:8080', chave: CHAVE_FALSA, tela: 'javascript:alert(1)' }),
  ];
  for (const r of ruins) {
    assert.throws(() => lerConfigSistemas(r), (e: Error) => !e.message.includes(CHAVE_FALSA) && !e.message.includes('senha@'));
  }
});

test('cliente: manda a chave e quem pediu em cabeçalho; 401 e erros do servidor saem em português, sem a chave nem o endereço', async () => {
  const { srv } = montar({ vazarNoErro: true });
  await sistemasChamar(CONFIG_FALSA, 'GET', '/admin/v1/usuarios', { quem: 'João <joao@x.com>' }, srv.fetch);
  assert.equal(srv.chamadas[0]!.chave, CHAVE_FALSA);
  assert.equal(srv.chamadas[0]!.quem, encodeURIComponent('João <joao@x.com>'), 'nome com acento vai codificado');
  await assert.rejects(
    () => sistemasChamar({ ...CONFIG_FALSA, chave: 'outra-chave-errada-123456' }, 'GET', '/admin/v1/usuarios', {}, srv.fetch),
    (e: Error) => /recusou a chave.*painel de integrações/.test(e.message) && !e.message.includes('outra-chave'),
  );
  await assert.rejects(
    () => sistemasChamar(CONFIG_FALSA, 'POST', '/admin/v1/consulta', { corpo: { sql: 'select explode' } }, srv.fetch),
    (e: Error) => !e.message.includes(CHAVE_FALSA) && !e.message.includes('api-rh') && /\[oculto\]/.test(e.message),
  );
  const rede = (async () => {
    throw new TypeError(`fetch failed: connect ECONNREFUSED http://api-rh:8080 key=${CHAVE_FALSA}`);
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => sistemasChamar(CONFIG_FALSA, 'GET', '/admin/v1/usuarios', {}, rede),
    (e: Error) => /não consegui falar com o servidor/.test(e.message) && !e.message.includes(CHAVE_FALSA) && !e.message.includes('api-rh'),
  );
  const html = (async () => ({ ok: true, status: 200, text: async () => '<html>bad gateway</html>' })) as unknown as typeof fetch;
  await assert.rejects(() => sistemasChamar(CONFIG_FALSA, 'GET', '/admin/v1/usuarios', {}, html), /não é JSON/);
});

test('painel: testar a chave lê os usuários e devolve só a contagem', async () => {
  const { srv } = montar();
  assert.match(await testarChaveSistemas(JSON.stringify(CONFIG_FALSA), srv.fetch), /^Sistema novo \(RH\/Caixa\) · 2 usuários$/);
  assert.match(await testarChaveSistemas(JSON.stringify({ ...CONFIG_FALSA, tela: undefined }), srv.fetch), /sem endereço da tela RH/);
});

// ---------------------------------------------------------------- SQL

test('SELECT: aceita select/with, recusa vários comandos e escrita; texto entre aspas e comentário não enganam', () => {
  assert.equal(validarSelect('select * from rh_funcionarios;'), 'select * from rh_funcionarios');
  assert.equal(validarSelect("WITH x AS (select 1) select * from x"), 'WITH x AS (select 1) select * from x');
  assert.equal(validarSelect("select * from rh_funcionarios where obs ilike '%update; delete%' -- drop table x"), "select * from rh_funcionarios where obs ilike '%update; delete%' -- drop table x");
  assert.equal(validarSelect('select "update" from t /* ; drop */'), 'select "update" from t /* ; drop */');
  assert.throws(() => validarSelect('select 1; select 2'), /um comando só/);
  assert.throws(() => validarSelect('select 1; drop table rh_funcionarios'), /um comando só/);
  assert.throws(() => validarSelect('delete from rh_funcionarios'), /só é permitido um SELECT/);
  assert.throws(() => validarSelect('with x as (delete from t returning *) select * from x'), /DELETE/);
  assert.throws(() => validarSelect('select * from t for update'), /UPDATE/);
  assert.throws(() => validarSelect('   '), /vazio/);
  assert.throws(() => validarSelect(42), /vazio/);
});

test('SQL: contrabando por E\'\\\'\', nome com $$ e ";" seguido de comentário', () => {
  // E'..' trata \' como aspa escapada: o ";" e o DELETE seguintes estão FORA do texto
  assert.throws(() => validarSelect("select E'\\'' ; delete from rh_funcionarios where true --'"), /um comando só/);
  assert.throws(() => validarComandoDeDados("select E'\\'' ; delete from t --'"), /um comando só/);
  // a$$ é um nome (o $ é letra de nome): não abre bloco entre $$
  assert.throws(() => validarSelect('select 1 a$$; drop table t; $$'), /um comando só/);
  // $$ de verdade esconde o texto, mas o texto escondido não vira comando
  assert.equal(validarSelect("select $$a;b$$ as x"), "select $$a;b$$ as x");
  // ";" final seguido de comentário sai do texto enviado
  assert.equal(validarSelect('select 1; -- nota'), 'select 1 -- nota');
  // na simulação que escreve, ";" nem dentro de texto
  assert.equal(validarComandoDeDados('delete from t where id = 1;'), 'delete from t where id = 1');
  assert.throws(() => validarComandoDeDados("delete from t where nome = 'a;b'"), /nem dentro de texto/);
  assert.throws(() => validarComandoDeDados('commit'), /SELECT, INSERT, UPDATE ou DELETE/);
  assert.throws(() => validarComandoDeDados('set role postgres'), /SELECT, INSERT/);
});

test('consultar: o SQL ruim nem chega ao servidor; resposta enorme é cortada com aviso', async () => {
  const { srv, ctx } = montar();
  await assert.rejects(() => consultar(ctx, QUEM.nome, { sql: 'select 1; select 2' }), /um comando só/);
  await assert.rejects(() => consultar(ctx, QUEM.nome, { sql: 'update rh_funcionarios set nome = 1' }), /só é permitido um SELECT/);
  assert.equal(srv.chamadas.length, 0);
  const ok = await consultar(ctx, QUEM.nome, { sql: 'select id, nome from rh_funcionarios' });
  assert.equal(ok.linhasDevolvidas, 2);
  assert.equal(ok.cortado, false);
  assert.equal(srv.chamadas[0]!.quem, QUEM.nome);

  const grande = montar({ linhas: Array.from({ length: 1000 }, (_, i) => ({ id: i, texto: 'x'.repeat(400) })) });
  const r = await consultar(grande.ctx, QUEM.nome, { sql: 'select * from t' });
  assert.equal(r.cortado, true);
  assert.ok(r.linhasDevolvidas < 1000 && r.linhasDevolvidas >= 1);
  assert.ok(JSON.stringify(r.linhas).length <= MAX_CARACTERES);
  assert.match(String(r.aviso), /refine/);
});

// ---------------------------------------------------------------- leitura pelas ferramentas

test('leitura: esquema (com filtro), consulta, usuários, log e simulação passam pelo servidor', async () => {
  const { srv, ctx } = montar();
  const { chamar, fechar } = await cliente(ctx, { escreve: false });
  const e = await chamar('sistemas_esquema');
  assert.equal(e.json.tabelas.length, 2);
  assert.equal(e.json.funcoes.length, 1);
  const f = await chamar('sistemas_esquema', { tabela: 'caixa' });
  assert.deepEqual(f.json.tabelas.map((t: { nome: string }) => t.nome), ['caixa_lancamentos']);
  assert.equal(f.json.funcoes, undefined);
  const c = await chamar('sistemas_consultar', { sql: 'select id, nome from rh_funcionarios' });
  assert.equal(c.json.linhas.length, 2);
  assert.equal(c.json.sistema, 'hm-tecnologia');
  const u = await chamar('sistemas_usuarios');
  assert.equal(u.json.usuarios[1].papel, 'unidade');
  await chamar('sistemas_log', { tabela: 'rh_funcionarios', desde: '2026-10-01', limite: 5 });
  const l = srv.chamadas.at(-1)!;
  assert.equal(l.query, '?tabela=rh_funcionarios&desde=2026-10-01&limite=5');
  const lerr = await chamar('sistemas_log', { tabela: 'x; drop' });
  assert.equal(lerr.erro, true);
  for (const desde of ['2026-01-01; drop table x', '2026-13-01', '2026-02-30', '2026-01-01 lixo']) {
    const r = await chamar('sistemas_log', { desde });
    assert.equal(r.erro, true, desde);
    assert.match(r.texto, /desde: use AAAA-MM-DD/);
  }
  const s = await chamar('sistemas_simular', { usuario: 'u-2', sql: 'select * from rh_funcionarios' });
  assert.equal(s.json.ok, true);
  assert.deepEqual(srv.chamadas.at(-1)!.corpo, { user_id: 'u-2', sql: 'select * from rh_funcionarios', escrever: false });
  const w = await chamar('sistemas_simular', { usuario: 'u-2', sql: 'delete from rh_funcionarios', escrever: true });
  assert.match(w.json.modo, /DESFEITO/);
  assert.equal(w.json.ok, false);
  assert.equal(srv.funcionarios.length, 2);
  const mau = await chamar('sistemas_simular', { usuario: 'u-2', sql: 'commit', escrever: true });
  assert.equal(mau.erro, true);
  assert.match(mau.texto, /SELECT, INSERT, UPDATE ou DELETE/);
  const mau2 = await chamar('sistemas_simular', { usuario: 'u-2', sql: 'delete from t', escrever: false });
  assert.equal(mau2.erro, true);
  await fechar();
});

test('permissão: quem não pode escrever não vê as ferramentas de escrita', async () => {
  const { ctx } = montar();
  const leitor = await cliente(ctx, { escreve: false });
  const nomes = (await leitor.c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(nomes, ['sistemas_consultar', 'sistemas_esquema', 'sistemas_log', 'sistemas_simular', 'sistemas_usuarios']);
  const escritor = await cliente(ctx, { escreve: true });
  const todos = (await escritor.c.listTools()).tools.map((t) => t.name);
  for (const n of ['sistemas_preparar_alteracao', 'sistemas_confirmar_alteracao', 'sistemas_usuario', 'sistemas_convite']) assert.ok(todos.includes(n), n);
  await leitor.fechar();
  await escritor.fechar();
});

// ---------------------------------------------------------------- escrita em dois passos

test('preparar não grava; confirmar grava com o código e registra quem pediu', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const p = await prepararAlteracao(ctx, pend, QUEM, { operacao: 'atualizar', tabela: 'rh_funcionarios', filtro: { id: 1 }, dados: { cargo: 'Gerente' } });
  assert.equal(srv.funcionarios[0]!.cargo, 'Recepção', 'a prévia não grava nada');
  assert.equal(p.afetadas, 1);
  assert.equal((p.antes as Array<{ cargo: string }>)[0]!.cargo, 'Recepção');
  assert.equal((p.depois as Array<{ cargo: string }>)[0]!.cargo, 'Gerente');
  assert.match(p.instrucao, /sistemas_confirmar_alteracao/);
  assert.equal(srv.chamadas.at(-1)!.corpo.quem, QUEM.nome);
  const r = await confirmarAlteracao(ctx, pend, QUEM, { confirmacao: p.confirmacao });
  assert.equal(srv.funcionarios[0]!.cargo, 'Gerente');
  assert.equal(r.ok, true);
  assert.equal(r.conferido, true);
  assert.deepEqual(srv.registro.at(-1), { tabela: 'rh_funcionarios', quem: QUEM.nome, op: 'atualizar' });
  assert.equal(srv.chamadas.at(-1)!.corpo.quem, QUEM.nome);
  await assert.rejects(() => confirmarAlteracao(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /desconhecido ou já usado/);
});

test('confirmar sem preparar, com código de outro usuário ou de outra sessão: nada vai ao servidor', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  await assert.rejects(() => confirmarAlteracao(ctx, pend, QUEM, { confirmacao: 'prep-1' }), /desconhecido ou já usado.*prepare/);
  assert.equal(srv.chamadas.length, 0);
  const p = await prepararAlteracao(ctx, pend, QUEM, { operacao: 'apagar', tabela: 'rh_ferias', filtro: { id: 1 } });
  const antes = srv.chamadas.length;
  await assert.rejects(() => confirmarAlteracao(ctx, pend, { usuario: 'outro', nome: 'outro@x' }, { confirmacao: p.confirmacao }), /outro usuário/);
  assert.equal(srv.chamadas.length, antes);
  // o código continua valendo para quem preparou
  assert.equal((await confirmarAlteracao(ctx, pend, QUEM, { confirmacao: p.confirmacao })).ok, true);
});

test('código vencido: localmente (10 min) e quando o servidor é quem recusa', async () => {
  let agora = 1_000_000;
  const { ctx } = montar();
  const pend = new PendentesSistemas(() => agora);
  const p = await prepararAlteracao(ctx, pend, QUEM, { operacao: 'atualizar', tabela: 'rh_funcionarios', filtro: { id: 2 }, dados: { cargo: 'X' } });
  agora += 11 * 60_000;
  await assert.rejects(() => confirmarAlteracao(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /venceu.*prepare/);

  // relógio do conector parado, relógio do servidor adiantado: a recusa do servidor chega em português
  let servidor = Date.now();
  const s2 = montar({ agora: () => servidor });
  const pend2 = new PendentesSistemas(() => 0);
  const p2 = await prepararAlteracao(s2.ctx, pend2, QUEM, { operacao: 'atualizar', tabela: 'rh_funcionarios', filtro: { id: 2 }, dados: { cargo: 'X' } });
  servidor += 11 * 60_000;
  await assert.rejects(() => confirmarAlteracao(s2.ctx, pend2, QUEM, { confirmacao: p2.confirmacao }), /prévia venceu/);
  assert.equal(s2.srv.funcionarios[1]!.cargo, 'Fisio');
});

test('preparar recusa o que é perigoso antes de falar com o servidor', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const ruim = (a: Parameters<typeof prepararAlteracao>[3], re: RegExp) => assert.rejects(() => prepararAlteracao(ctx, pend, QUEM, a), re);
  await ruim({ operacao: 'atualizar', tabela: 'rh_funcionarios', dados: { cargo: 'X' } }, /precisa de "filtro"/);
  await ruim({ operacao: 'apagar', tabela: 'rh_funcionarios' }, /precisa de "filtro"/);
  await ruim({ operacao: 'inserir', tabela: 'rh_funcionarios' }, /precisa de "dados"/);
  await ruim({ operacao: 'atualizar', tabela: 'rh_funcionarios', filtro: { id: 1 } }, /precisa de "dados"/);
  await ruim({ operacao: 'apagar', tabela: 'rh_funcionarios', filtro: { id: 1 }, dados: { a: 1 } }, /não leva "dados"/);
  await ruim({ operacao: 'atualizar', tabela: 'rh_usuarios', filtro: { id: 1 }, dados: { papel: 'admin' } }, /sistemas_usuario/);
  await ruim({ operacao: 'atualizar', tabela: 'RH_Usuarios', filtro: { id: 1 }, dados: { papel: 'admin' } }, /sistemas_usuario/);
  await ruim({ operacao: 'atualizar', tabela: 'rh_funcionarios; drop table x', filtro: { id: 1 }, dados: { a: 1 } }, /tabela/);
  await ruim({ operacao: 'atualizar', tabela: 'rh_funcionarios', filtro: { 'id = 1 or 1': 1 }, dados: { a: 1 } }, /coluna/);
  assert.equal(srv.chamadas.length, 0);
});

test('conferido=false vira aviso para a pessoa', async () => {
  const { ctx } = montar();
  const original = ctx.contas.get('hm-tecnologia')!.fonte.chamar;
  ctx.contas.get('hm-tecnologia')!.fonte.chamar = async (m, c, o) => {
    const r = (await original(m, c, o)) as Record<string, unknown>;
    return c.endsWith('/confirmar') ? { ...r, conferido: false } : r;
  };
  const pend = new PendentesSistemas();
  const p = await prepararAlteracao(ctx, pend, QUEM, { operacao: 'atualizar', tabela: 'rh_funcionarios', filtro: { id: 1 }, dados: { cargo: 'Y' } });
  const r = await confirmarAlteracao(ctx, pend, QUEM, { confirmacao: p.confirmacao });
  assert.match(String(r.atencao), /NÃO bateu/);
});

test('usuário: papel, unidade e ativo (sim/não vira booleano); valor ruim não chega ao servidor', async () => {
  const { srv, ctx } = montar();
  await alterarUsuario(ctx, QUEM, { acao: 'ativo', usuario: 'u-2', valor: 'não' });
  assert.deepEqual(srv.chamadas.at(-1)!.corpo, { acao: 'ativo', user_id: 'u-2', valor: false, quem: QUEM.nome });
  await alterarUsuario(ctx, QUEM, { acao: 'papel', usuario: 'u-2', valor: ' gestao ' });
  assert.equal(srv.chamadas.at(-1)!.corpo.valor, 'gestao');
  const r = await alterarUsuario(ctx, QUEM, { acao: 'unidade', usuario: 'u-2', valor: 'serra' });
  assert.deepEqual((r as { depois: unknown }).depois, { unidade: 'serra' });
  const antes = srv.chamadas.length;
  await assert.rejects(() => alterarUsuario(ctx, QUEM, { acao: 'ativo', usuario: 'u-2', valor: 'talvez' }), /sim ou não/);
  await assert.rejects(() => alterarUsuario(ctx, QUEM, { acao: 'papel', usuario: 'u-2', valor: true }), /valor/);
  await assert.rejects(() => alterarUsuario(ctx, QUEM, { acao: 'papel', usuario: "u-2' or 1=1", valor: 'admin' }), /user_id/);
  assert.equal(srv.chamadas.length, antes);
});

test('convite: devolve o endereço completo (tela + #a-token), sem senha; sem tela cadastrada, recusa', async () => {
  const { srv, ctx } = montar();
  const r = await criarConvite(ctx, QUEM, { nome: 'Carla Souza', login: 'carla', papel: 'unidade', unidade: 'serra' });
  assert.equal(r.link, 'https://rh.exemplo.com.br/app/#a-tok123456789abc');
  assert.equal(r.validade, '7 dias');
  assert.deepEqual(srv.chamadas.at(-1)!.corpo, { nome: 'Carla Souza', login: 'carla', papel: 'unidade', unidade: 'serra', quem: QUEM.nome });
  assert.ok(!/senha"?:/i.test(JSON.stringify(srv.chamadas.at(-1)!.corpo)));
  assert.equal(linkDoConvite('https://rh.exemplo.com.br/#velho', '#a-abcdefgh12'), 'https://rh.exemplo.com.br/#a-abcdefgh12');
  assert.throws(() => linkDoConvite('https://rh.exemplo.com.br/', '#a-x'), /formato inesperado/);
  const sem = montar({}, { ...CONFIG_FALSA, tela: undefined });
  await assert.rejects(() => criarConvite(sem.ctx, QUEM, { nome: 'A', login: 'a', papel: 'gestao' }), /endereço da tela RH/);
  assert.equal(sem.srv.chamadas.length, 0);
});

// ---------------------------------------------------------------- sem integração, vários sistemas, chave

test('sem a integração cadastrada, toda ferramenta manda cadastrar no painel de integrações', async () => {
  const vazio = criarContextoSistemas();
  assert.throws(() => resolverSistema(vazio), /painel de integrações/);
  const { chamar, fechar } = await cliente(vazio, { escreve: true });
  const chamadas: Array<[string, Record<string, unknown>]> = [
    ['sistemas_esquema', {}],
    ['sistemas_consultar', { sql: 'select 1' }],
    ['sistemas_usuarios', {}],
    ['sistemas_log', {}],
    ['sistemas_simular', { usuario: 'u-1', sql: 'select 1' }],
    ['sistemas_preparar_alteracao', { operacao: 'apagar', tabela: 'rh_ferias', filtro: { id: 1 } }],
    ['sistemas_usuario', { acao: 'ativo', usuario: 'u-1', valor: true }],
    ['sistemas_convite', { nome: 'A', login: 'a', papel: 'gestao' }],
  ];
  for (const [nome, args] of chamadas) {
    const r = await chamar(nome, args);
    assert.equal(r.erro, true, nome);
    assert.match(r.texto, /cadastre.*painel de integrações/, nome);
  }
  const c = await chamar('sistemas_confirmar_alteracao', { confirmacao: 'prep-1' });
  assert.equal(c.erro, true);
  await fechar();
});

test('mais de um sistema: pede para escolher; o nome curto resolve', () => {
  const f = { chamar: async () => ({}) };
  const ctx = criarContextoSistemas(new Map([['hm-rh', { slug: 'hm-rh', nome: 'RH', fonte: f }], ['hm-dsc', { slug: 'hm-dsc', nome: 'DSC', fonte: f }]]));
  assert.throws(() => resolverSistema(ctx), /informe o sistema.*hm-rh, hm-dsc/);
  assert.equal(resolverSistema(ctx, 'dsc').slug, 'hm-dsc');
  assert.throws(() => resolverSistema(ctx, 'financeiro'), /não está ligado/);
});

test('a chave e o endereço interno nunca aparecem em nenhuma saída, nem na auditoria', async () => {
  const { srv, ctx } = montar({ vazarNoErro: true });
  const pend = new PendentesSistemas();
  const { chamar, auditoria, fechar } = await cliente(ctx, { escreve: true, pendentes: pend });
  const saidas: string[] = [];
  const guardar = async (nome: string, args: Record<string, unknown>) => {
    const r = await chamar(nome, args);
    saidas.push(r.texto);
    return r;
  };
  await guardar('sistemas_esquema', {});
  await guardar('sistemas_consultar', { sql: 'select explode' }); // o servidor falso repete a chave no erro
  await guardar('sistemas_consultar', { sql: 'select 1' });
  await guardar('sistemas_usuarios', {});
  await guardar('sistemas_log', {});
  await guardar('sistemas_simular', { usuario: 'u-1', sql: 'select 1' });
  const p = await guardar('sistemas_preparar_alteracao', { operacao: 'atualizar', tabela: 'rh_funcionarios', filtro: { id: 1 }, dados: { cargo: 'Z' } });
  await guardar('sistemas_confirmar_alteracao', { confirmacao: p.json.confirmacao });
  await guardar('sistemas_usuario', { acao: 'papel', usuario: 'u-1', valor: 'admin' });
  await guardar('sistemas_convite', { nome: 'A', login: 'a', papel: 'gestao' });
  assert.ok(saidas.length >= 10);
  for (const s of saidas) {
    assert.ok(!s.includes(CHAVE_FALSA), `chave vazou: ${s.slice(0, 120)}`);
    assert.ok(!s.includes('api-rh'), `endereço interno vazou: ${s.slice(0, 120)}`);
  }
  const aud = JSON.stringify(auditoria);
  assert.ok(!aud.includes(CHAVE_FALSA) && !aud.includes('api-rh'));
  assert.ok(srv.chamadas.every((c) => c.chave === CHAVE_FALSA), 'a chave vai ao servidor, só em cabeçalho');
  assert.ok(srv.chamadas.every((c) => !c.query.includes(CHAVE_FALSA) && !JSON.stringify(c.corpo).includes(CHAVE_FALSA)));
  await fechar();
});

test('listar_integracoes mostra quem tem o sistema novo', () => {
  const r = listarIntegracoes({ franquia: new Map(), kommo: new Map(), bling: new Map(), sistemas: new Map([['hm-tecnologia', { nome: 'HM Tecnologia' }]]) });
  assert.equal(r.comSistemas, 1);
  assert.ok(r.unidades[0]!.ferramentas.some((f) => f.startsWith('sistemas_*')));
});

test('na produção, a escrita do sistema novo só é registrada dentro do bloco de quem pode escrever; a leitura, fora', () => {
  const src = readFileSync(new URL('./producao.ts', import.meta.url), 'utf8');
  const i = src.indexOf('registrarEscritaSistemas(');
  assert.ok(i > 0);
  assert.equal(src.match(/registrarEscritaSistemas\(/g)?.length, 1);
  assert.equal(src.match(/registrarLeituraSistemas\(/g)?.length, 1);
  const bloco = src.slice(src.lastIndexOf('if (escritores.has(quem.userId))', i), i);
  assert.match(bloco, /^if \(escritores\.has\(quem\.userId\)\) \{/);
  assert.ok(!bloco.includes('}\n      if ('), 'o bloco de quem escreve não pode ter fechado antes');
  assert.ok(src.indexOf('registrarLeituraSistemas(') < src.lastIndexOf('if (escritores.has(quem.userId))', i));
});

test('anotações: simular e escrita não se anunciam como só leitura; usuário e convite são destrutivos', async () => {
  const { ctx } = montar();
  const { c, fechar } = await cliente(ctx, { escreve: true });
  const por = Object.fromEntries((await c.listTools()).tools.map((t) => [t.name, t.annotations ?? {}]));
  for (const n of ['sistemas_esquema', 'sistemas_consultar', 'sistemas_usuarios', 'sistemas_log', 'sistemas_preparar_alteracao']) assert.equal(por[n]!.readOnlyHint, true, n);
  assert.equal(por['sistemas_simular']!.readOnlyHint, false);
  assert.equal(por['sistemas_confirmar_alteracao']!.destructiveHint, true);
  assert.equal(por['sistemas_usuario']!.destructiveHint, true);
  assert.equal(por['sistemas_convite']!.destructiveHint, true);
  await fechar();
});

test('auditoria do conector não leva os dados da alteração (salário, CPF, nome do convidado), só tabela e colunas', async () => {
  const { ctx } = montar();
  const { chamar, auditoria, fechar } = await cliente(ctx, { escreve: true });
  await chamar('sistemas_preparar_alteracao', { operacao: 'atualizar', tabela: 'rh_funcionarios', filtro: { cpf: '123.456.789-00' }, dados: { salario: 4321.99 } });
  await chamar('sistemas_convite', { nome: 'Carla Souza', login: 'carla@x.com', papel: 'gestao' });
  const aud = JSON.stringify(auditoria);
  assert.ok(!aud.includes('123.456.789-00') && !aud.includes('4321.99') && !aud.includes('Carla Souza') && !aud.includes('carla@x.com'), aud);
  assert.deepEqual(auditoria[0]!.argumentos, { sistema: undefined, operacao: 'atualizar', tabela: 'rh_funcionarios', colunasDoFiltro: ['cpf'], colunasDosDados: ['salario'] });
  await fechar();
});

test('confirmar sem resposta do servidor: avisa que NÃO sabe se gravou e o código continua valendo; erro definitivo gasta o código', async () => {
  const { srv, ctx } = montar();
  const original = ctx.contas.get('hm-tecnologia')!.fonte.chamar;
  let cai = true;
  ctx.contas.get('hm-tecnologia')!.fonte.chamar = async (m, c, o) => {
    if (c.endsWith('/confirmar') && cai) {
      cai = false;
      throw new ErroSistemas('não consegui falar com o servidor do sistema novo (sem resposta ou tempo esgotado)', null);
    }
    return original(m, c, o);
  };
  const pend = new PendentesSistemas();
  const p = await prepararAlteracao(ctx, pend, QUEM, { operacao: 'inserir', tabela: 'rh_ferias', dados: { funcionario: 1 } });
  await assert.rejects(() => confirmarAlteracao(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /NÃO sei se a alteração foi gravada.*sistemas_log.*continua valendo/);
  assert.equal((await confirmarAlteracao(ctx, pend, QUEM, { confirmacao: p.confirmacao })).ok, true);

  // 4xx do servidor: o servidor RECUSOU, nada gravou; o código não volta
  const q = await prepararAlteracao(ctx, pend, QUEM, { operacao: 'apagar', tabela: 'rh_ferias', filtro: { id: 1 } });
  srv.preparados.delete(q.confirmacao);
  await assert.rejects(() => confirmarAlteracao(ctx, pend, QUEM, { confirmacao: q.confirmacao }), /prévia desconhecida/);
  await assert.rejects(() => confirmarAlteracao(ctx, pend, QUEM, { confirmacao: q.confirmacao }), /desconhecido ou já usado/);
});

test('cliente: 403 com mensagem do servidor vai como veio; 401 e 403 mudo falam da chave', async () => {
  const resp = (status: number, corpo: unknown) => (async () => ({ ok: false, status, text: async () => JSON.stringify(corpo) })) as unknown as typeof fetch;
  await assert.rejects(() => sistemasChamar(CONFIG_FALSA, 'POST', '/admin/v1/preparar', {}, resp(403, { erro: 'apagar em fin_* só pelo servidor' })), /^Error: apagar em fin_\* só pelo servidor$/);
  await assert.rejects(() => sistemasChamar(CONFIG_FALSA, 'GET', '/admin/v1/usuarios', {}, resp(403, {})), /recusou a chave/);
  await assert.rejects(() => sistemasChamar(CONFIG_FALSA, 'GET', '/admin/v1/usuarios', {}, resp(401, { erro: 'x' })), /recusou a chave/);
});
