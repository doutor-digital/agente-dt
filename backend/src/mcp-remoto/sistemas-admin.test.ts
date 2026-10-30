import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sistemasChamar } from '../lib/integracoes/sistemas.js';
import { alterarUsuario, confirmarAlteracao, criarConvite, criarContextoSistemas, PendentesSistemas, prepararAlteracao, registrarEscritaSistemas, registrarLeituraSistemas, type ContaSistemas } from './sistemas.js';
import { confirmarAdmin, prepararAdmin, registrarAdminSistemas } from './sistemas-admin.js';
import { confirmarEstrutura, prepararEstrutura } from './sistemas-estrutura.js';
import { CHAVE_FALSA, CONFIG_FALSA, servidorAdminFalso } from './sistemas-falso.js';

// Conceder ADMIN só em dois passos (sistemas_preparar_admin / sistemas_confirmar_admin); sistemas_usuario e sistemas_convite recusam admin.

const QUEM = { usuario: 'user-1', nome: 'suzanne@exemplo.com' };
const MOTIVO = 'nova gerente administrativa';

function montar(config = CONFIG_FALSA) {
  const srv = servidorAdminFalso({ maisUsuarios: true });
  const conta: ContaSistemas = { slug: 'hm-tecnologia', nome: 'HM Tecnologia', tela: config.tela, fonte: { chamar: (m, c, op) => sistemasChamar(config, m, c, op, srv.fetch) } };
  return { srv, ctx: criarContextoSistemas(new Map([[conta.slug, conta]])) };
}
const escritasAdmin = (srv: ReturnType<typeof montar>['srv']) => srv.chamadas.filter((c) => (c.caminho === '/admin/v1/usuario' || c.caminho === '/admin/v1/convite') && (c.corpo?.valor === 'admin' || c.corpo?.papel === 'admin'));

async function cliente(ctx: ReturnType<typeof criarContextoSistemas>, escreve: boolean) {
  const server = new McpServer({ name: 't', version: '1' });
  const auditoria: Array<{ ferramenta: string; argumentos: any; ok: boolean; erro?: string }> = [];
  const auditar = (r: { ferramenta: string; argumentos: unknown; ok: boolean; erro?: string }) => auditoria.push(r as any);
  const pend = new PendentesSistemas();
  registrarLeituraSistemas(server, ctx, QUEM, auditar);
  if (escreve) {
    registrarEscritaSistemas(server, ctx, pend, QUEM, auditar);
    registrarAdminSistemas(server, ctx, pend, QUEM, auditar);
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

test('portão: as ferramentas de admin só aparecem para quem escreve; na produção, só dentro do bloco de quem pode escrever', async () => {
  const { ctx } = montar();
  const leitor = await cliente(ctx, false);
  assert.ok(!(await leitor.c.listTools()).tools.some((t) => t.name.endsWith('_admin')));
  const escritor = await cliente(ctx, true);
  const nomes = (await escritor.c.listTools()).tools.map((t) => t.name);
  assert.ok(nomes.includes('sistemas_preparar_admin') && nomes.includes('sistemas_confirmar_admin'));
  await leitor.fechar(); await escritor.fechar();
  const src = readFileSync(new URL('./producao.ts', import.meta.url), 'utf8');
  assert.equal(src.match(/registrarAdminSistemas\(/g)?.length, 1);
  const i = src.indexOf('registrarAdminSistemas(');
  const bloco = src.slice(src.lastIndexOf('if (escritores.has(quem.userId))', i), i);
  assert.match(bloco, /^if \(escritores\.has\(quem\.userId\)\) \{/);
  assert.ok(!bloco.includes('}\n      if ('), 'o bloco de quem escreve não pode ter fechado antes');
});

test('sistemas_usuario e sistemas_convite recusam admin (qualquer caixa/espaço) sem falar com o servidor; os outros papéis seguem diretos', async () => {
  const { srv, ctx } = montar();
  for (const v of ['admin', 'ADMIN', ' Admin ']) {
    await assert.rejects(() => alterarUsuario(ctx, QUEM, { acao: 'papel', usuario: 'u-2', valor: v }), /sistemas_preparar_admin/);
    await assert.rejects(() => criarConvite(ctx, QUEM, { nome: 'Carla', login: 'carla', papel: v }), /sistemas_preparar_admin/);
  }
  assert.equal(srv.chamadas.length, 0);
  await alterarUsuario(ctx, QUEM, { acao: 'papel', usuario: 'u-2', valor: 'gestao' });
  await alterarUsuario(ctx, QUEM, { acao: 'ativo', usuario: 'u-2', valor: 'sim' });
  await alterarUsuario(ctx, QUEM, { acao: 'unidade', usuario: 'u-2', valor: 'serra' });
  assert.equal((await criarConvite(ctx, QUEM, { nome: 'Carla', login: 'carla', papel: 'gestao' })).link, 'https://rh.exemplo.com.br/app/#a-tok123456789abc');
  assert.equal(srv.chamadas.length, 4);
  // a descrição das ferramentas antigas não oferece mais "admin"
  const { c, fechar } = await cliente(ctx, true);
  const tools = (await c.listTools()).tools;
  for (const n of ['sistemas_usuario', 'sistemas_convite']) assert.match(tools.find((t) => t.name === n)!.description!, /sistemas_preparar_admin/);
  await fechar();
});

test('promover: preparar só LÊ (mostra quem e papel atual → admin); confirmar executa com confirmado_admin e registra', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const p = await prepararAdmin(ctx, pend, QUEM, { acao: 'promover', usuario: 'u-1', motivo: MOTIVO });
  assert.equal(escritasAdmin(srv).length, 0, 'preparar não grava');
  assert.deepEqual(srv.chamadas.map((c) => `${c.metodo} ${c.caminho}`), ['GET /admin/v1/usuarios']);
  assert.match(p.resumo[0], /Maria \(login maria\) passa de "gestao" para ADMIN/);
  assert.match(p.confirmacao, /^adm-[0-9a-f]{18}$/);
  assert.match(p.instrucao, /sistemas_confirmar_admin/);
  const rastro: { acao?: string; usuario?: string; resultado?: string } = {};
  const r = await confirmarAdmin(ctx, pend, QUEM, { confirmacao: p.confirmacao }, rastro);
  assert.equal(r.ok, true); assert.equal(r.papelAntes, 'gestao'); assert.equal(r.papelDepois, 'admin');
  assert.deepEqual(srv.chamadas.at(-1)!.corpo, { acao: 'papel', user_id: 'u-1', valor: 'admin', quem: QUEM.nome, confirmado_admin: true });
  assert.deepEqual(rastro, { acao: 'promover', usuario: 'u-1', resultado: 'ok' });
  await assert.rejects(() => confirmarAdmin(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /desconhecido ou já usado/);
  assert.equal(escritasAdmin(srv).length, 1, 'executou uma vez só');
});

test('promover: usuário inexistente, id ruim, já admin e motivo curto param no preparar; inativo vem com aviso', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  await assert.rejects(() => prepararAdmin(ctx, pend, QUEM, { acao: 'promover', usuario: 'u-999', motivo: MOTIVO }), /não encontrado/);
  await assert.rejects(() => prepararAdmin(ctx, pend, QUEM, { acao: 'promover', usuario: "u-1' or 1=1", motivo: MOTIVO }), /user_id/);
  await assert.rejects(() => prepararAdmin(ctx, pend, QUEM, { acao: 'promover', usuario: 'u-3', motivo: MOTIVO }), /já é admin/);
  await assert.rejects(() => prepararAdmin(ctx, pend, QUEM, { acao: 'promover', usuario: 'u-1', motivo: 'x' }), /motivo/);
  await assert.rejects(() => prepararAdmin(ctx, pend, QUEM, { acao: 'promover', motivo: MOTIVO }), /user_id/);
  assert.equal(escritasAdmin(srv).length, 0);
  const inativo = await prepararAdmin(ctx, pend, QUEM, { acao: 'promover', usuario: 'u-4', motivo: MOTIVO });
  assert.match(inativo.resumo[0], /INATIVO/);
});

test('convite de admin: preparar não cria nada; confirmar cria e devolve o link completo; nome e login só entram na confirmação', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const p = await prepararAdmin(ctx, pend, QUEM, { acao: 'convite', nome: 'Carla Souza', login: 'carla', motivo: MOTIVO });
  assert.equal(srv.chamadas.length, 0, 'preparar nem fala com o servidor');
  assert.match(p.resumo[0], /convite de acesso como ADMIN para Carla Souza \(login carla\)/);
  const r = await confirmarAdmin(ctx, pend, QUEM, { confirmacao: p.confirmacao });
  assert.equal(r.link, 'https://rh.exemplo.com.br/app/#a-tok123456789abc');
  assert.equal(r.papel, 'admin'); assert.equal(r.validade, '7 dias');
  assert.deepEqual(srv.chamadas.at(-1)!.corpo, { nome: 'Carla Souza', login: 'carla', papel: 'admin', quem: QUEM.nome, confirmado_admin: true });
  assert.ok(!/senha"?:/i.test(JSON.stringify(srv.chamadas.at(-1)!.corpo)));
  await assert.rejects(() => prepararAdmin(ctx, pend, QUEM, { acao: 'convite', login: 'x', motivo: MOTIVO }), /nome e login/);
  const sem = montar({ ...CONFIG_FALSA, tela: undefined });
  await assert.rejects(() => prepararAdmin(sem.ctx, new PendentesSistemas(), QUEM, { acao: 'convite', nome: 'A', login: 'a', motivo: MOTIVO }), /endereço da tela RH/);
});

test('um código de um tipo NÃO confirma outro tipo (dados, estrutura, admin), e a tentativa errada não gasta o código', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const adm = await prepararAdmin(ctx, pend, QUEM, { acao: 'promover', usuario: 'u-1', motivo: MOTIVO });
  const dados = await prepararAlteracao(ctx, pend, QUEM, { operacao: 'atualizar', tabela: 'rh_funcionarios', filtro: { id: 1 }, dados: { cargo: 'X' } });
  const estr = await prepararEstrutura(ctx, pend, QUEM, { sql: 'create table caixa_a (a int)', motivo: MOTIVO });
  const antes = srv.chamadas.length;
  // admin não confirma como dados nem estrutura
  await assert.rejects(() => confirmarAlteracao(ctx, pend, QUEM, { confirmacao: adm.confirmacao }), /ADMIN.*sistemas_confirmar_admin/);
  await assert.rejects(() => confirmarEstrutura(ctx, pend, QUEM, { confirmacao: adm.confirmacao }), /ADMIN.*sistemas_confirmar_admin/);
  // dados e estrutura não confirmam como admin
  await assert.rejects(() => confirmarAdmin(ctx, pend, QUEM, { confirmacao: dados.confirmacao }), /DADOS.*sistemas_confirmar_alteracao/);
  await assert.rejects(() => confirmarAdmin(ctx, pend, QUEM, { confirmacao: estr.confirmacao }), /ESTRUTURA.*sistemas_confirmar_estrutura/);
  assert.equal(srv.chamadas.length, antes, 'nada foi ao servidor');
  // os três continuam valendo, cada um no seu confirmador
  assert.equal((await confirmarAdmin(ctx, pend, QUEM, { confirmacao: adm.confirmacao })).ok, true);
  assert.equal((await confirmarAlteracao(ctx, pend, QUEM, { confirmacao: dados.confirmacao })).ok, true);
  assert.equal((await confirmarEstrutura(ctx, pend, QUEM, { confirmacao: estr.confirmacao })).ok, true);
});

test('código de outro usuário, vencido e rede caída na confirmação', async () => {
  let agora = 9_000_000;
  const { ctx } = montar();
  const pend = new PendentesSistemas(() => agora);
  const p = await prepararAdmin(ctx, pend, QUEM, { acao: 'promover', usuario: 'u-1', motivo: MOTIVO });
  await assert.rejects(() => confirmarAdmin(ctx, pend, { usuario: 'outro', nome: 'o@x' }, { confirmacao: p.confirmacao }), /outro usuário/);
  agora += 11 * 60_000;
  await assert.rejects(() => confirmarAdmin(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /venceu.*prepare/);

  const { ctx: ctx2 } = montar();
  const pend2 = new PendentesSistemas();
  const q = await prepararAdmin(ctx2, pend2, QUEM, { acao: 'promover', usuario: 'u-1', motivo: MOTIVO });
  const conta = ctx2.contas.get('hm-tecnologia')!;
  const original = conta.fonte.chamar;
  conta.fonte.chamar = async (m, c, o) => { if (c.endsWith('/usuario')) throw new (await import('../lib/integracoes/sistemas.js')).ErroSistemas('sem resposta', null); return original(m, c, o); };
  await assert.rejects(() => confirmarAdmin(ctx2, pend2, QUEM, { confirmacao: q.confirmacao }), /NÃO sei se o perfil admin foi concedido/);
  conta.fonte.chamar = original;
  assert.equal((await confirmarAdmin(ctx2, pend2, QUEM, { confirmacao: q.confirmacao })).ok, true, 'o código voltou');
});

test('servidor que ainda recusa admin (regra antiga): o erro chega em português e o código se gasta', async () => {
  const { ctx } = montar();
  const conta = ctx.contas.get('hm-tecnologia')!;
  const { ErroSistemas } = await import('../lib/integracoes/sistemas.js');
  const original = conta.fonte.chamar;
  conta.fonte.chamar = async (m, c, o) => { if (c.endsWith('/usuario')) throw new ErroSistemas('o perfil admin só é concedido pelo servidor, não pelo conector', 400); return original(m, c, o); };
  const pend = new PendentesSistemas();
  const p = await prepararAdmin(ctx, pend, QUEM, { acao: 'promover', usuario: 'u-1', motivo: MOTIVO });
  await assert.rejects(() => confirmarAdmin(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /só é concedido pelo servidor/);
  await assert.rejects(() => confirmarAdmin(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /desconhecido ou já usado/);
});

test('pelo MCP: dois passos, auditoria sem nome/login do convidado, chave nunca na saída', async () => {
  const { srv, ctx } = montar();
  const { chamar, auditoria, fechar } = await cliente(ctx, true);
  const direto = await chamar('sistemas_usuario', { acao: 'papel', usuario: 'u-1', valor: 'admin' });
  assert.equal(direto.erro, true); assert.match(direto.texto, /sistemas_preparar_admin/);
  const direto2 = await chamar('sistemas_convite', { nome: 'Carla Souza', login: 'carla', papel: 'admin' });
  assert.equal(direto2.erro, true); assert.match(direto2.texto, /sistemas_preparar_admin/);
  assert.equal(escritasAdmin(srv).length, 0);
  const p = await chamar('sistemas_preparar_admin', { acao: 'convite', nome: 'Carla Souza', login: 'carla', motivo: MOTIVO });
  assert.equal(p.erro, false, p.texto);
  const c = await chamar('sistemas_confirmar_admin', { confirmacao: p.json.confirmacao });
  assert.equal(c.erro, false, c.texto);
  assert.match(c.json.link, /#a-tok123456789abc$/);
  const aud = JSON.stringify(auditoria);
  assert.ok(!aud.includes('Carla') && !aud.includes('carla'), 'nome/login do convidado fora da auditoria');
  const conf = auditoria.find((a) => a.ferramenta === 'sistemas_confirmar_admin')!;
  assert.equal(conf.ok, true); assert.equal(conf.argumentos.acao, 'convite'); assert.equal(conf.argumentos.resultado, 'ok');
  assert.ok(!JSON.stringify([direto.texto, p.texto, c.texto, aud]).includes(CHAVE_FALSA));
  await fechar();
});

test('convite de admin: resposta ambígua (rede/5xx ou 200 sem link) NÃO devolve o código — repetir criaria um segundo convite', async () => {
  const { ErroSistemas } = await import('../lib/integracoes/sistemas.js');
  for (const modo of ['rede', '5xx', 'sem-link'] as const) {
    const { srv, ctx } = montar();
    const conta = ctx.contas.get('hm-tecnologia')!;
    const original = conta.fonte.chamar;
    let criados = 0;
    conta.fonte.chamar = async (m, c, o) => {
      if (!c.endsWith('/convite')) return original(m, c, o);
      criados++; // o servidor "criou" o convite, mas a resposta não chegou inteira
      if (modo === 'rede') throw new ErroSistemas('sem resposta', null);
      if (modo === '5xx') throw new ErroSistemas('falha interna', 502);
      return { ok: true };
    };
    const pend = new PendentesSistemas();
    const p = await prepararAdmin(ctx, pend, QUEM, { acao: 'convite', nome: 'Carla Souza', login: 'carla', motivo: MOTIVO });
    const rastro: { resultado?: string } = {};
    await assert.rejects(() => confirmarAdmin(ctx, pend, QUEM, { confirmacao: p.confirmacao }, rastro), /PODE ter sido criado|NÃO sei se o convite.*SEGUNDO convite/, modo);
    assert.match(rastro.resultado!, /incerto/, modo);
    assert.notEqual(rastro.resultado, 'ok');
    await assert.rejects(() => confirmarAdmin(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /desconhecido ou já usado/, `${modo}: o código não pode voltar`);
    assert.equal(criados, 1, `${modo}: um convite só`);
    assert.equal(escritasAdmin(srv).length, 0);
  }
});

test('convite de admin: a tela é conferida ANTES de chamar o servidor; promover continua devolvendo o código (idempotente); ok:false do servidor não vira sucesso', async () => {
  const { srv, ctx } = montar();
  const pend = new PendentesSistemas();
  const p = await prepararAdmin(ctx, pend, QUEM, { acao: 'convite', nome: 'Carla', login: 'carla', motivo: MOTIVO });
  ctx.contas.get('hm-tecnologia')!.tela = undefined; // alguém apagou a tela do painel entre o preparar e o confirmar
  const antes = srv.chamadas.length;
  await assert.rejects(() => confirmarAdmin(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /endereço da tela RH.*Nada foi criado/);
  assert.equal(srv.chamadas.length, antes, 'nada foi ao servidor');

  const { ctx: ctx2 } = montar();
  const conta = ctx2.contas.get('hm-tecnologia')!;
  const original = conta.fonte.chamar;
  conta.fonte.chamar = async (m, c, o) => (c.endsWith('/usuario') ? { ok: false, erro: 'não deu' } : original(m, c, o));
  const pend2 = new PendentesSistemas();
  const q = await prepararAdmin(ctx2, pend2, QUEM, { acao: 'promover', usuario: 'u-1', motivo: MOTIVO });
  const rastro: { resultado?: string } = {};
  await assert.rejects(() => confirmarAdmin(ctx2, pend2, QUEM, { confirmacao: q.confirmacao }, rastro), /NÃO concedeu: não deu/);
  assert.match(rastro.resultado!, /^recusado/);
});

test('código vencido E de outro tipo: diz que venceu (e gasta), não "é de outro tipo"', async () => {
  let agora = 1_000_000;
  const { ctx } = montar();
  const pend = new PendentesSistemas(() => agora);
  const adm = await prepararAdmin(ctx, pend, QUEM, { acao: 'promover', usuario: 'u-1', motivo: MOTIVO });
  agora += 11 * 60_000;
  await assert.rejects(() => confirmarAlteracao(ctx, pend, QUEM, { confirmacao: adm.confirmacao }), /venceu/);
  await assert.rejects(() => confirmarAdmin(ctx, pend, QUEM, { confirmacao: adm.confirmacao }), /desconhecido ou já usado/);
});
