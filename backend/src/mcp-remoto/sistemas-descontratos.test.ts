import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sistemasChamar, testarChaveDescontratos, type ConfigSistemas } from '../lib/integracoes/sistemas.js';
import { CofreDeArquivos } from './cofre-arquivos.js';
import { CONFIG_DSC_FALSA, CHAVE_DSC_FALSA, servidorDescontratosFalso } from './descontratos-falso.js';
import { listarIntegracoes } from './integracoes.js';
import {
  criarContextoSistemas,
  PendentesSistemas,
  registrarEscritaSistemas,
  registrarLeituraSistemas,
  resolverSistema,
  tipoDaConta,
  type ContaSistemas,
} from './sistemas.js';
import { registrarAdminSistemas } from './sistemas-admin.js';
import { registrarAnexosSistemas } from './sistemas-anexo.js';
import { contasDoRh, montarContasSistemas } from './sistemas-contas.js';
import { registrarEstruturaSistemas } from './sistemas-estrutura.js';
import { CHAVE_FALSA, CONFIG_FALSA, servidorAdminFalso } from './sistemas-falso.js';

// O Descontratos como SEGUNDA conta do conector (provisório, até o banco dele migrar para o do RH): convive com o RH sem mudar o que a Lia já faz no RH,
// só as ferramentas de leitura e a de concluir descontrato valem nele, e a chave do RH nunca chega ao servidor do Descontratos (nem o contrário).

const QUEM = { usuario: 'user-1', nome: 'suzanne@exemplo.com' };
const pastas: string[] = [];
after(() => pastas.forEach((p) => rmSync(p, { recursive: true, force: true })));

/** os dois sistemas ligados, cada um com o seu servidor falso e a sua chave: é o cenário real da produção depois do cadastro */
function doisSistemas() {
  const rh = servidorAdminFalso({ maisUsuarios: true });
  const dsc = servidorDescontratosFalso();
  const contaRh: ContaSistemas = { slug: 'doutor-digital', nome: 'Doutor Digital', tela: CONFIG_FALSA.tela, fonte: { chamar: (m, c, o) => sistemasChamar(CONFIG_FALSA, m, c, o, rh.fetch) } };
  const contaDsc: ContaSistemas = { slug: 'descontratos', nome: 'Descontratos/Ficha', tipo: 'dsc', fonte: { chamar: (m, c, o) => sistemasChamar(CONFIG_DSC_FALSA as ConfigSistemas, m, c, o, dsc.fetch) } };
  return { rh, dsc, ctx: criarContextoSistemas(new Map([[contaRh.slug, contaRh], [contaDsc.slug, contaDsc]])) };
}

async function cliente(ctx: ReturnType<typeof criarContextoSistemas>, o: { usuario?: string; escreve?: boolean } = {}) {
  const server = new McpServer({ name: 't', version: '1' });
  const auditoria: Array<{ ferramenta: string; argumentos: any; ok: boolean; erro?: string }> = [];
  const auditar = (r: { ferramenta: string; argumentos: unknown; ok: boolean; erro?: string }) => auditoria.push(r as any);
  const quem = { usuario: o.usuario ?? QUEM.usuario, nome: QUEM.nome };
  const pend = new PendentesSistemas();
  registrarLeituraSistemas(server, ctx, quem, auditar);
  if (o.escreve !== false) {
    registrarEscritaSistemas(server, ctx, pend, quem, auditar);
    registrarEstruturaSistemas(server, ctx, pend, quem, auditar);
    registrarAdminSistemas(server, ctx, pend, quem, auditar);
    const dir = mkdtempSync(path.join(tmpdir(), 'sdsc-'));
    pastas.push(dir);
    const deps = { cofre: new CofreDeArquivos({ dir: path.join(dir, 'cofre') }), baseUrl: () => 'https://conector.exemplo.com', dominios: [] as string[], enviadoNome: 'Lia' };
    registrarAnexosSistemas(server, ctx, quem, deps, auditar);
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

// ---------------------------------------------------------------- dois sistemas: o RH não muda

test('sem "sistema", TODAS as ferramentas continuam no RH (a Lia não passa a errar com o Descontratos ligado)', async () => {
  const { rh, dsc, ctx } = doisSistemas();
  const k = await cliente(ctx);
  assert.equal((await k.chamar('sistemas_esquema')).json.sistema, 'doutor-digital');
  assert.equal((await k.chamar('sistemas_consultar', { sql: 'select id, nome from rh_funcionarios' })).json.sistema, 'doutor-digital');
  assert.equal((await k.chamar('sistemas_usuarios')).json.sistema, 'doutor-digital');
  assert.equal((await k.chamar('sistemas_log')).json.sistema, 'doutor-digital');
  const prep = await k.chamar('sistemas_preparar_alteracao', { operacao: 'atualizar', tabela: 'rh_funcionarios', filtro: { id: 1 }, dados: { cargo: 'Gerente' } });
  assert.equal(prep.json.sistema, 'doutor-digital');
  assert.equal((await k.chamar('sistemas_confirmar_alteracao', { confirmacao: prep.json.confirmacao })).json.sistema, 'doutor-digital');
  assert.ok(rh.chamadas.length >= 6);
  assert.equal(dsc.chamadas.length, 0, 'o servidor do Descontratos não recebeu nenhuma chamada');
  await k.fechar();
});

test('resolverSistema: sem pedido, cada ferramenta cai no sistema do seu tipo (RH por padrão), mesmo com as duas contas ligadas', () => {
  const { ctx } = doisSistemas();
  assert.equal(resolverSistema(ctx, undefined).slug, 'doutor-digital');
  assert.equal(resolverSistema(ctx, undefined, 'qualquer').slug, 'doutor-digital');
  assert.equal(resolverSistema(ctx, undefined, 'dsc').slug, 'descontratos');
  assert.equal(resolverSistema(ctx, 'doutor-digital').slug, 'doutor-digital');
  assert.equal(resolverSistema(ctx, 'descontratos', 'dsc').slug, 'descontratos');
  assert.throws(() => resolverSistema(ctx, 'descontratos'), /só existe no RH\/Caixa/);
  assert.throws(() => resolverSistema(ctx, 'doutor-digital', 'dsc'), /não o Descontratos/);
});

test('dois RH ligados continuam pedindo o sistema (isso não mudou), e o Descontratos não conta como RH', () => {
  const { ctx } = doisSistemas();
  ctx.contas.set('hm-tecnologia', { ...ctx.contas.get('doutor-digital')!, slug: 'hm-tecnologia', nome: 'HM' });
  assert.throws(() => resolverSistema(ctx, undefined), /informe o sistema\. Ligados: doutor-digital, hm-tecnologia$/);
  assert.equal(resolverSistema(ctx, 'hm').slug, 'hm-tecnologia');
  assert.equal(resolverSistema(ctx, undefined, 'dsc').slug, 'descontratos');
});

test('sem a conta do Descontratos tudo é como antes; só o Descontratos ligado: sem "sistema" a leitura usa ele, as ferramentas do RH explicam', () => {
  const { ctx } = doisSistemas();
  const soRh = criarContextoSistemas(new Map([['doutor-digital', ctx.contas.get('doutor-digital')!]]));
  assert.equal(resolverSistema(soRh, undefined).slug, 'doutor-digital');
  assert.throws(() => resolverSistema(soRh, undefined, 'dsc'), /Descontratos\/Ficha ainda não está ligado/);
  assert.throws(() => resolverSistema(soRh, 'descontratos', 'qualquer'), /não está ligado/);
  const soDsc = criarContextoSistemas(new Map([['descontratos', ctx.contas.get('descontratos')!]]));
  assert.equal(resolverSistema(soDsc, undefined, 'qualquer').slug, 'descontratos');
  assert.throws(() => resolverSistema(soDsc, undefined), /RH\/Caixa\/Financeiro ainda não está ligado/);
});

// ---------------------------------------------------------------- Descontratos: leitura

test('leitura no Descontratos: sistema="descontratos" (ou o apelido dsc/ficha) vai ao servidor DELE, com a chave DELE; a chave do RH não vaza para lá', async () => {
  const { rh, dsc, ctx } = doisSistemas();
  const k = await cliente(ctx);
  const e = await k.chamar('sistemas_esquema', { sistema: 'descontratos' });
  assert.equal(e.json.sistema, 'descontratos');
  assert.ok(e.json.tabelas.some((t: any) => t.nome === 'dsc_docs'));
  const q = await k.chamar('sistemas_consultar', { sistema: 'dsc', sql: "select id, data->>'status' from dsc_docs where col = 'cancelamentos'" });
  assert.equal(q.json.sistema, 'descontratos');
  assert.equal((await k.chamar('sistemas_consultar', { sistema: 'Ficha', sql: 'select 1' })).json.sistema, 'descontratos');
  assert.ok(dsc.chamadas.length === 3 && dsc.chamadas.every((c) => c.chave === CHAVE_DSC_FALSA), 'só a chave do Descontratos chega no servidor dele');
  assert.ok(rh.chamadas.every((c) => c.chave === CHAVE_FALSA));
  assert.equal(rh.chamadas.length, 0);
  // o "quem" vai para o registro do servidor do Descontratos
  assert.ok(dsc.chamadas.filter((c) => c.caminho === '/admin/v1/consulta').every((c) => c.quem === QUEM.nome));
  await k.fechar();
});

test('o SELECT de leitura segue só leitura também no Descontratos (a mesma validação)', async () => {
  const { dsc, ctx } = doisSistemas();
  const k = await cliente(ctx);
  const r = await k.chamar('sistemas_consultar', { sistema: 'descontratos', sql: "update dsc_docs set data = '{}'" });
  assert.equal(r.erro, true);
  assert.match(r.texto, /só é permitido um SELECT/);
  assert.equal(dsc.chamadas.length, 0);
  await k.fechar();
});

// ---------------------------------------------------------------- Descontratos: o que NÃO vale

test('toda ferramenta do RH recusa a conta do Descontratos SEM falar com o servidor dele (o admin do RH não se abre para o Descontratos)', async () => {
  const { dsc, ctx } = doisSistemas();
  const k = await cliente(ctx);
  const chamadas: Array<[string, Record<string, unknown>]> = [
    ['sistemas_usuarios', {}],
    ['sistemas_log', {}],
    ['sistemas_simular', { usuario: 'u-1', sql: 'select 1' }],
    ['sistemas_preparar_alteracao', { operacao: 'apagar', tabela: 'dsc_docs', filtro: { col: 'cancelamentos' } }],
    ['sistemas_usuario', { acao: 'ativo', usuario: 'u-1', valor: false }],
    ['sistemas_convite', { nome: 'X', login: 'x', papel: 'gestao' }],
    ['sistemas_preparar_tabela', { nome: 'nova_tabela', colunas: [{ nome: 'campo', tipo: 'text' }], motivo: 'teste do portão' }],
    ['sistemas_preparar_coluna', { tabela: 'dsc_docs', coluna: { nome: 'campo', tipo: 'text' }, motivo: 'teste do portão' }],
    ['sistemas_preparar_indice', { tabela: 'dsc_docs', colunas: ['col'], motivo: 'teste do portão' }],
    ['sistemas_preparar_admin', { acao: 'promover', usuario: 'u-1', motivo: 'teste do portão' }],
    ['sistemas_preparar_anexo', { tabela: 'fin_lanc', lancamento: '00000000-0000-4000-8000-000000000000', tipo: 'recibo' }],
    ['sistemas_preparar_documento', { destino: 'rh_colaborador', id: 'c-1', tipo_documento: 'ASO' }],
  ];
  for (const [nome, args] of chamadas) {
    const r = await k.chamar(nome, { sistema: 'descontratos', ...args });
    assert.equal(r.erro, true, nome);
    assert.match(r.texto, /Descontratos|descontratos/, nome);
    assert.match(r.texto, /só existe no RH\/Caixa|RH\/Caixa/, nome);
  }
  assert.equal(dsc.chamadas.length, 0, 'nenhuma dessas ferramentas chegou ao servidor do Descontratos');
  await k.fechar();
});

test('o código preparado no RH não confirma nada no Descontratos e vice-versa (cada código é do sistema que o criou)', async () => {
  const { rh, dsc, ctx } = doisSistemas();
  const k = await cliente(ctx);
  const c = await k.chamar('sistemas_preparar_descontrato', { protocolo: 'ARA-2026-001', acao: 'pagar', valor_pago: 150 });
  assert.equal(c.json.sistema, 'descontratos');
  const r = await k.chamar('sistemas_preparar_alteracao', { operacao: 'atualizar', tabela: 'rh_funcionarios', filtro: { id: 1 }, dados: { cargo: 'X' } });
  // cada confirmação vai ao servidor do sistema que preparou
  assert.equal((await k.chamar('sistemas_confirmar_alteracao', { confirmacao: r.json.confirmacao })).json.sistema, 'doutor-digital');
  assert.equal((await k.chamar('sistemas_confirmar_alteracao', { confirmacao: c.json.confirmacao })).json.sistema, 'descontratos');
  assert.equal(rh.chamadas.filter((x) => x.caminho === '/admin/v1/confirmar').length, 1);
  assert.equal(dsc.chamadas.filter((x) => x.caminho === '/admin/v1/confirmar').length, 1);
  await k.fechar();
});

// ---------------------------------------------------------------- concluir descontrato

test('concluir em dois passos: preparar não grava; confirmar (sistemas_confirmar_alteracao) grava; o código vale uma vez e só para quem preparou', async () => {
  const { dsc, ctx } = doisSistemas();
  const k = await cliente(ctx);
  const prep = await k.chamar('sistemas_preparar_descontrato', { id: 'd-1', acao: 'pagar', valor_pago: 150.5, data_pagamento: '2026-11-04' });
  assert.equal(prep.erro, false, prep.texto);
  assert.equal(prep.json.sistema, 'descontratos', 'sem "sistema": é o Descontratos, mesmo havendo o RH');
  assert.equal(prep.json.descontrato.protocolo, 'ARA-2026-001');
  assert.match(prep.json.instrucao, /Nada foi gravado ainda.*QUAL descontrato.*sistemas_confirmar_alteracao/);
  assert.equal(dsc.gravados.length, 0, 'preparar não grava');
  const corpo = dsc.chamadas.find((c) => c.caminho === '/admin/v1/descontrato/preparar')!;
  assert.deepEqual(corpo.corpo, { id: 'd-1', acao: 'pagar', valor_pago: 150.5, data_pagamento: '2026-11-04', quem: QUEM.nome });
  // outro usuário do conector não confirma o código alheio
  const outro = await cliente(ctx, { usuario: 'user-2' });
  const x = await outro.chamar('sistemas_confirmar_alteracao', { confirmacao: prep.json.confirmacao });
  assert.equal(x.erro, true);
  assert.match(x.texto, /outro usuário|desconhecido/);
  assert.equal(dsc.gravados.length, 0);
  await outro.fechar();
  const ok = await k.chamar('sistemas_confirmar_alteracao', { confirmacao: prep.json.confirmacao });
  assert.equal(ok.erro, false, ok.texto);
  assert.equal(ok.json.conferido, true);
  assert.equal(ok.json.backup_id, 'bk-dsc-1');
  assert.match(ok.json.registro, /histórico do próprio descontrato/);
  assert.doesNotMatch(ok.json.registro, /sistemas_log/, 'o Descontratos não tem sistemas_log');
  assert.equal(dsc.gravados.length, 1);
  assert.equal((await k.chamar('sistemas_confirmar_alteracao', { confirmacao: prep.json.confirmacao })).erro, true, 'uso único');
  assert.equal(dsc.gravados.length, 1);
  await k.fechar();
});

test('concluir: entradas ruins são recusadas ANTES de falar com o servidor', async () => {
  const { dsc, ctx } = doisSistemas();
  const k = await cliente(ctx);
  const ruins: Array<[Record<string, unknown>, RegExp]> = [
    [{ acao: 'pagar', valor_pago: 1 }, /id OU o protocolo/],
    [{ id: 'a', protocolo: 'ARA-2026-001', acao: 'pagar', valor_pago: 1 }, /id OU o protocolo/],
    [{ id: 'a b', acao: 'finalizar' }, /id inválido/],
    [{ protocolo: 'a;b', acao: 'finalizar' }, /protocolo inválido/],
    [{ id: 'a', acao: 'pagar' }, /valor_pago/],
    [{ id: 'a', acao: 'finalizar', valor_pago: 10 }, /só da acao "pagar"/],
    [{ id: 'a', acao: 'quitado', data_pagamento: '2026-11-04' }, /só da acao "pagar"/],
  ];
  for (const [args, esperado] of ruins) {
    const r = await k.chamar('sistemas_preparar_descontrato', args);
    assert.equal(r.erro, true, JSON.stringify(args));
    assert.match(r.texto, esperado, JSON.stringify(args));
  }
  // ação fora da lista (aprovar, indeferir…) nem existe: o esquema da ferramenta recusa
  assert.equal((await k.chamar('sistemas_preparar_descontrato', { id: 'a', acao: 'aprovar' })).erro, true);
  assert.equal(dsc.chamadas.length, 0);
  await k.fechar();
});

test('concluir: a recusa do servidor (falta comprovante, não existe) chega com o motivo e nada fica guardado para confirmar', async () => {
  const { dsc, ctx } = doisSistemas();
  const k = await cliente(ctx);
  const a = await k.chamar('sistemas_preparar_descontrato', { id: 'sem-comprovante', acao: 'pagar', valor_pago: 1 });
  assert.equal(a.erro, true);
  assert.match(a.texto, /falta o comprovante do pagamento/);
  const b = await k.chamar('sistemas_preparar_descontrato', { id: 'nao-existe', acao: 'finalizar' });
  assert.equal(b.erro, true);
  assert.match(b.texto, /não achei o descontrato/);
  assert.equal(dsc.gravados.length, 0);
  assert.equal((await k.chamar('sistemas_confirmar_alteracao', { confirmacao: 'dc-1' })).erro, true);
  await k.fechar();
});

test('a ferramenta de concluir só existe para quem pode escrever (a mesma lista de quem altera cartões)', async () => {
  const { ctx } = doisSistemas();
  const leitor = await cliente(ctx, { escreve: false });
  assert.ok(!(await leitor.c.listTools()).tools.some((t) => t.name === 'sistemas_preparar_descontrato'));
  await leitor.fechar();
  const escritor = await cliente(ctx);
  assert.ok((await escritor.c.listTools()).tools.some((t) => t.name === 'sistemas_preparar_descontrato'));
  await escritor.fechar();
  const src = readFileSync(new URL('./producao.ts', import.meta.url), 'utf8');
  assert.equal(src.match(/registrarEscritaSistemas\(/g)?.length, 1);
  const i = src.indexOf('registrarEscritaSistemas(');
  assert.match(src.slice(src.lastIndexOf('if (escritores.has(quem.userId))', i), i), /^if \(escritores\.has\(quem\.userId\)\) \{/);
});

test('o registro do conector não guarda o valor pago, só quem, qual descontrato e a ação', async () => {
  const { ctx } = doisSistemas();
  const k = await cliente(ctx);
  await k.chamar('sistemas_preparar_descontrato', { protocolo: 'ARA-2026-001', acao: 'pagar', valor_pago: 123.45, data_pagamento: '2026-11-04' });
  const reg = k.auditoria.find((a) => a.ferramenta === 'sistemas_preparar_descontrato')!;
  assert.deepEqual(reg.argumentos, { sistema: undefined, acao: 'pagar', id: undefined, protocolo: 'ARA-2026-001', comValor: true });
  assert.ok(!JSON.stringify(reg).includes('123.45'));
  await k.fechar();
});

// ---------------------------------------------------------------- cadastro (painel) e montagem das contas

test('painel: o Descontratos é um provedor à parte; o teste da chave só aceita servidor que TEM dsc_docs', async () => {
  // chaves.ts puxa o banco e o env do agente: o ambiente de mentira basta, nada conecta
  Object.assign(process.env, { DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/x', KOMMO_SUBDOMAIN: 'x', KOMMO_ACCESS_TOKEN: 'x'.repeat(12), OPENAI_API_KEY: 'x'.repeat(12), SESSION_JWT_SECRET: 'x'.repeat(40) });
  const { PROVEDORES, ehProvedor } = await import('../lib/integracoes/chaves.js');
  assert.ok((PROVEDORES as readonly string[]).includes('descontratos') && ehProvedor('descontratos'));
  assert.ok((PROVEDORES as readonly string[]).includes('sistemas'), 'o RH continua com o provedor dele');
  const dsc = servidorDescontratosFalso();
  const rotulo = await testarChaveDescontratos(JSON.stringify(CONFIG_DSC_FALSA), dsc.fetch);
  assert.equal(rotulo, 'Descontratos/Ficha · 2 tabelas');
  assert.ok(!rotulo.includes(CHAVE_DSC_FALSA));
  // a chave do RH colada na linha do Descontratos: o servidor do RH responde um esquema SEM dsc_docs e é recusado; a chave também não vaza na mensagem
  const rh = servidorAdminFalso();
  await assert.rejects(testarChaveDescontratos(JSON.stringify(CONFIG_FALSA), rh.fetch), (e: Error) => /não é o Descontratos/.test(e.message) && !e.message.includes(CHAVE_FALSA));
  // chave errada
  await assert.rejects(testarChaveDescontratos(JSON.stringify({ ...CONFIG_DSC_FALSA, chave: 'x'.repeat(30) }), dsc.fetch), /recusou a chave/);
});

test('montagem das contas: RH pelo slug da unidade, Descontratos pelo slug fixo; conta ruim não derruba a outra; o painel do RH não lista o Descontratos como unidade', () => {
  const avisos: Array<{ slug?: string; unidades?: string[]; motivo: string }> = [];
  const rhJson = JSON.stringify(CONFIG_FALSA);
  const dscJson = JSON.stringify(CONFIG_DSC_FALSA);
  const ok = montarContasSistemas([{ slug: 'doutor-digital', nome: 'Doutor Digital', chave: rhJson }], [{ slug: 'doutor-digital', nome: 'Doutor Digital', chave: dscJson }], (a) => avisos.push(a));
  assert.deepEqual([...ok.keys()], ['doutor-digital', 'descontratos']);
  assert.equal(tipoDaConta(ok.get('doutor-digital')!), 'rh');
  assert.equal(tipoDaConta(ok.get('descontratos')!), 'dsc');
  assert.equal(ok.get('doutor-digital')!.tela, CONFIG_FALSA.tela);
  assert.deepEqual([...contasDoRh(ok).keys()], ['doutor-digital']);
  assert.equal(avisos.length, 0);
  // a lista de integrações por unidade (listar_integracoes) não ganha uma "unidade" descontratos
  const lista = listarIntegracoes({ franquia: new Map(), kommo: new Map(), bling: new Map(), sistemas: contasDoRh(ok) });
  assert.deepEqual(lista.unidades.map((u) => u.slug), ['doutor-digital']);

  // só RH cadastrado: igual a hoje
  assert.deepEqual([...montarContasSistemas([{ slug: 'doutor-digital', nome: 'DD', chave: rhJson }], []).keys()], ['doutor-digital']);
  // Descontratos ilegível: avisa SEM o conteúdo e o RH segue
  const ruim = montarContasSistemas([{ slug: 'doutor-digital', nome: 'DD', chave: rhJson }], [{ slug: 'doutor-digital', nome: 'DD', chave: `{"api":"http://api-dsc:8080","chave":"${CHAVE_DSC_FALSA.slice(0, 10)}"}` }], (a) => avisos.push(a));
  assert.deepEqual([...ruim.keys()], ['doutor-digital']);
  assert.equal(avisos.length, 1);
  assert.ok(!JSON.stringify(avisos).includes(CHAVE_DSC_FALSA.slice(0, 10)));
  // RH ilegível não derruba o Descontratos
  const soDsc = montarContasSistemas([{ slug: 'doutor-digital', nome: 'DD', chave: 'lixo' }], [{ slug: 'doutor-digital', nome: 'DD', chave: dscJson }], (a) => avisos.push(a));
  assert.deepEqual([...soDsc.keys()], ['descontratos']);
  // Descontratos em duas unidades: só a primeira; uma unidade chamada "descontratos" não é sobrescrita
  avisos.length = 0;
  const dois = montarContasSistemas([], [{ slug: 'a', nome: 'A', chave: dscJson }, { slug: 'b', nome: 'B', chave: dscJson }], (a) => avisos.push(a));
  assert.equal(dois.size, 1);
  assert.equal(avisos.length, 1);
  assert.deepEqual(avisos[0]!.unidades, ['a', 'b']);
  avisos.length = 0;
  const colide = montarContasSistemas([{ slug: 'descontratos', nome: 'Unidade', chave: rhJson }], [{ slug: 'x', nome: 'X', chave: dscJson }], (a) => avisos.push(a));
  assert.equal(tipoDaConta(colide.get('descontratos')!), 'rh');
  assert.match(String(avisos[0]!.motivo), /já existe uma unidade chamada descontratos/);
});

test('a montagem usa a rede injetada e as duas chaves nunca se misturam', async () => {
  const rh = servidorAdminFalso();
  const dsc = servidorDescontratosFalso();
  // um fetch que escolhe o servidor falso pelo endereço, como a rede interna do Swarm
  const rede = (async (url: string, init: any) => (new URL(url).host === 'api-dsc:8080' ? dsc.fetch(url, init) : rh.fetch(url, init))) as unknown as typeof fetch;
  const contas = montarContasSistemas([{ slug: 'doutor-digital', nome: 'DD', chave: JSON.stringify(CONFIG_FALSA) }], [{ slug: 'doutor-digital', nome: 'DD', chave: JSON.stringify(CONFIG_DSC_FALSA) }], undefined, rede);
  const ctx = criarContextoSistemas(contas);
  const k = await cliente(ctx);
  assert.equal((await k.chamar('sistemas_esquema')).json.sistema, 'doutor-digital');
  assert.equal((await k.chamar('sistemas_esquema', { sistema: 'descontratos' })).json.sistema, 'descontratos');
  assert.ok(rh.chamadas.every((c) => c.chave === CHAVE_FALSA));
  assert.ok(dsc.chamadas.every((c) => c.chave === CHAVE_DSC_FALSA));
  await k.fechar();
});
