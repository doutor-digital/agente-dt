import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sistemasChamar, type ConfigSistemas } from '../lib/integracoes/sistemas.js';
import { CONFIG_DSC_FALSA, servidorDescontratosFalso } from './descontratos-falso.js';
import { criarContextoSistemas, PendentesSistemas, registrarEscritaSistemas, registrarLeituraSistemas, type ContaSistemas } from './sistemas.js';
import { CONFIG_FALSA, CHAVE_FALSA, servidorAdminFalso } from './sistemas-falso.js';

// A página da tela (rh_site / dsc_site) e o papel fisio no conector: trocar um trecho com backup, a volta em uma chamada, e o que NÃO aparece na auditoria.

const QUEM = { usuario: 'user-1', nome: 'suzanne@exemplo.com' };

function sistemas() {
  const rh = servidorAdminFalso({ maisUsuarios: true });
  const dsc = servidorDescontratosFalso();
  const contaRh: ContaSistemas = { slug: 'doutor-digital', nome: 'Doutor Digital', tela: CONFIG_FALSA.tela, fonte: { chamar: (m, c, o) => sistemasChamar(CONFIG_FALSA, m, c, o, rh.fetch) } };
  const contaDsc: ContaSistemas = { slug: 'descontratos', nome: 'Descontratos/Ficha', tipo: 'dsc', fonte: { chamar: (m, c, o) => sistemasChamar(CONFIG_DSC_FALSA as ConfigSistemas, m, c, o, dsc.fetch) } };
  return { rh, dsc, ctx: criarContextoSistemas(new Map([[contaRh.slug, contaRh], [contaDsc.slug, contaDsc]])) };
}

async function cliente(ctx: ReturnType<typeof criarContextoSistemas>, escreve = true) {
  const server = new McpServer({ name: 't', version: '1' });
  const auditoria: Array<{ ferramenta: string; argumentos: any; ok: boolean; erro?: string }> = [];
  const auditar = (r: { ferramenta: string; argumentos: unknown; ok: boolean; erro?: string }) => auditoria.push(r as any);
  registrarLeituraSistemas(server, ctx, QUEM, auditar);
  if (escreve) registrarEscritaSistemas(server, ctx, new PendentesSistemas(), QUEM, auditar);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(a), c.connect(b)]);
  const chamar = async (nome: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name: nome, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { erro: r.isError === true, texto: r.content[0]!.text, json: r.isError ? null : JSON.parse(r.content[0]!.text) };
  };
  return { c, chamar, auditoria, fechar: () => c.close() };
}

test('quem não está em MCP_ESCRITA_EMAILS não vê as ferramentas da página nem a de desfazer', async () => {
  const { ctx } = sistemas();
  const { c, fechar } = await cliente(ctx, false);
  const nomes = (await c.listTools()).tools.map((t) => t.name);
  assert.ok(!nomes.includes('sistemas_site_trocar') && !nomes.includes('sistemas_desfazer'));
  await fechar();
  const com = await cliente(ctx, true);
  const todos = (await com.c.listTools()).tools.map((t) => t.name);
  assert.ok(todos.includes('sistemas_site_trocar') && todos.includes('sistemas_desfazer'));
  await com.fechar();
});

test('trocar um trecho: manda o que o servidor espera (sem a chave no corpo), devolve backup_id e diz como voltar', async () => {
  const { rh, ctx } = sistemas();
  const { chamar, fechar } = await cliente(ctx);
  const r = await chamar('sistemas_site_trocar', { parte: 0, de: 'INICIO', para: 'COMECO' });
  assert.equal(r.erro, false, r.texto);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.sistema, 'doutor-digital');
  assert.match(r.json.backup_id, /^[0-9a-f-]{36}$/);
  assert.match(r.json.instrucao, /sistemas_desfazer/);
  assert.ok(rh.paginas.get(0)!.includes('COMECO'));
  const c = rh.chamadas.find((x) => x.caminho === '/admin/v1/site/trocar')!;
  assert.deepEqual(c.corpo, { part: 0, de: 'INICIO', para: 'COMECO', quem: QUEM.nome });
  assert.equal(c.chave, CHAVE_FALSA);
  assert.ok(!r.texto.includes(CHAVE_FALSA));
  await fechar();
});

test('trecho ausente, repetido ou que quebra o JavaScript: o servidor recusa, a ferramenta devolve o motivo e a página não muda', async () => {
  const { rh, ctx } = sistemas();
  const { chamar, fechar } = await cliente(ctx);
  const antes = rh.paginas.get(1);
  for (const [args, re] of [[{ parte: 1, de: 'x', para: 'y' }, /aparece 2 vezes/], [{ parte: 1, de: 'z', para: 'y' }, /não aparece/], [{ parte: 0, de: 'FIM', para: 'SINTAXE_RUIM' }, /erro de sintaxe/]] as const) {
    const r = await chamar('sistemas_site_trocar', args);
    assert.equal(r.erro, true);
    assert.match(r.texto, re);
  }
  assert.equal(rh.paginas.get(1), antes);
  assert.ok(!rh.paginas.get(0)!.includes('SINTAXE_RUIM'));
  await fechar();
});

test('entradas inválidas nem chegam ao servidor', async () => {
  const { rh, ctx } = sistemas();
  const { chamar, fechar } = await cliente(ctx);
  const n = rh.chamadas.length;
  assert.equal((await chamar('sistemas_site_trocar', { parte: -1, de: 'a', para: 'b' })).erro, true);
  assert.equal((await chamar('sistemas_site_trocar', { parte: 0, de: '', para: 'b' })).erro, true);
  assert.equal((await chamar('sistemas_desfazer', { backup_id: 'não é uuid, é uma frase longa' })).erro, true);
  assert.equal(rh.chamadas.length, n);
  await fechar();
});

test('desfazer: uma chamada devolve a página; repetir é recusado; "forcar" só vai se a pessoa mandar', async () => {
  const { rh, ctx } = sistemas();
  const { chamar, fechar } = await cliente(ctx);
  const antes = rh.paginas.get(0);
  const t = await chamar('sistemas_site_trocar', { parte: 0, de: 'INICIO', para: 'COMECO' });
  const d = await chamar('sistemas_desfazer', { backup_id: t.json.backup_id });
  assert.equal(d.erro, false, d.texto);
  assert.equal(d.json.ok, true);
  assert.equal(rh.paginas.get(0), antes);
  const repetido = await chamar('sistemas_desfazer', { backup_id: t.json.backup_id });
  assert.equal(repetido.erro, true);
  assert.match(repetido.texto, /já foi desfeito/);
  // outra pessoa mexeu depois: o servidor recusa; sem forcar na chamada, o corpo não leva forcar
  const t2 = await chamar('sistemas_site_trocar', { parte: 0, de: 'INICIO', para: 'UM' });
  rh.paginas.set(0, rh.paginas.get(0)!.replace('UM', 'OUTRA PESSOA'));
  const recusa = await chamar('sistemas_desfazer', { backup_id: t2.json.backup_id });
  assert.equal(recusa.erro, true);
  assert.equal(rh.chamadas.filter((x) => x.caminho === '/admin/v1/desfazer').at(-1)!.corpo.forcar, undefined);
  const forcada = await chamar('sistemas_desfazer', { backup_id: t2.json.backup_id, forcar: true });
  assert.equal(forcada.erro, false);
  assert.equal(rh.chamadas.filter((x) => x.caminho === '/admin/v1/desfazer').at(-1)!.corpo.forcar, true);
  await fechar();
});

test('Descontratos: sistema="descontratos" leva a troca ao servidor do Descontratos (e a chave dele), nunca ao do RH', async () => {
  const { rh, dsc, ctx } = sistemas();
  const { chamar, fechar } = await cliente(ctx);
  const r = await chamar('sistemas_site_trocar', { sistema: 'descontratos', parte: 0, de: 'a', para: 'b' });
  // o servidor falso do Descontratos desta suíte não tem a rota: o que importa é para ONDE foi
  assert.equal(rh.chamadas.filter((x) => x.caminho === '/admin/v1/site/trocar').length, 0);
  assert.ok(dsc.chamadas.some((x: any) => x.caminho === '/admin/v1/site/trocar'), r.texto);
  await fechar();
});

test('sistemas_preparar_alteracao na tabela dsc_site vai para o Descontratos; outra tabela do Descontratos continua fechada', async () => {
  const { rh, dsc, ctx } = sistemas();
  const { chamar, fechar } = await cliente(ctx);
  await chamar('sistemas_preparar_alteracao', { sistema: 'descontratos', operacao: 'atualizar', tabela: 'dsc_site', filtro: { part: 3 }, dados: { content: 'x' } });
  assert.ok(dsc.chamadas.some((x: any) => x.caminho === '/admin/v1/preparar'));
  assert.equal(rh.chamadas.filter((x) => x.caminho === '/admin/v1/preparar').length, 0);
  const fechada = await chamar('sistemas_preparar_alteracao', { sistema: 'descontratos', operacao: 'apagar', tabela: 'dsc_docs', filtro: { col: 'x' } });
  assert.equal(fechada.erro, true);
  assert.match(fechada.texto, /só existe no RH/);
  await fechar();
});

test('auditoria do conector: a troca registra parte e TAMANHOS, nunca o texto da página', async () => {
  const { ctx } = sistemas();
  const { chamar, auditoria, fechar } = await cliente(ctx);
  await chamar('sistemas_site_trocar', { parte: 0, de: 'INICIO', para: 'SEGREDO-NA-PAGINA-123' });
  const a = auditoria.find((x) => x.ferramenta === 'sistemas_site_trocar')!;
  assert.deepEqual(a.argumentos, { sistema: undefined, parte: 0, deTamanho: 6, paraTamanho: 21, aceitouServidorNovo: false });
  assert.ok(!JSON.stringify(auditoria).includes('SEGREDO-NA-PAGINA-123'));
  await fechar();
});

test('papel fisio: as ferramentas de usuário e convite o anunciam e o convite de fisio sai sem unidade', async () => {
  const { rh, ctx } = sistemas();
  const { c, chamar, fechar } = await cliente(ctx);
  const ferr = (await c.listTools()).tools;
  for (const n of ['sistemas_usuarios', 'sistemas_usuario', 'sistemas_convite']) assert.match(ferr.find((t) => t.name === n)!.description ?? '', /fisio/, n);
  const conv = await chamar('sistemas_convite', { nome: 'Fisio Teste', login: 'fisio.teste', papel: 'fisio' });
  assert.equal(conv.erro, false, conv.texto);
  assert.match(conv.json.link, /#a-/);
  assert.deepEqual(rh.chamadas.find((x) => x.caminho === '/admin/v1/convite')!.corpo.unidade, undefined);
  await fechar();
});

test('resposta ambígua (5xx): a ferramenta NÃO manda repetir às cegas e diz onde conferir', async () => {
  const { rh, ctx } = sistemas();
  const { chamar, fechar } = await cliente(ctx);
  const antes = rh.paginas.get(0);
  const r = await chamar('sistemas_site_trocar', { parte: 0, de: 'EXPLODE500', para: 'x' });
  assert.equal(r.erro, true);
  assert.match(r.texto, /NÃO sei se a troca foi gravada/);
  assert.match(r.texto, /admin_log/);
  assert.ok(!r.texto.includes(CHAVE_FALSA));
  assert.equal(rh.paginas.get(0), antes);
  await fechar();
});

test('conferido:false não vira "Gravado e conferido"; servidor novo só passa com o ok explícito (aceitarServidorNovo)', async () => {
  const { rh, ctx } = sistemas();
  const { chamar, fechar } = await cliente(ctx);
  const ruim = await chamar('sistemas_site_trocar', { parte: 0, de: 'INICIO', para: 'CONFERIDO_FALSE' });
  assert.equal(ruim.erro, false, ruim.texto);
  assert.match(ruim.json.atencao, /NÃO bateu/);
  assert.match(ruim.json.instrucao, /MAS a conferência não bateu/);
  assert.ok(!/Gravado e conferido/.test(ruim.json.instrucao));
  const recusada = await chamar('sistemas_site_trocar', { parte: 1, de: 'x x', para: 'NOVO-HOST' });
  assert.equal(recusada.erro, true);
  assert.match(recusada.texto, /servidor NOVO/);
  assert.equal(rh.chamadas.filter((x) => x.caminho === '/admin/v1/site/trocar').at(-1)!.corpo.aceitar_hosts_novos, undefined);
  const aceita = await chamar('sistemas_site_trocar', { parte: 1, de: 'x x', para: 'NOVO-HOST', aceitarServidorNovo: true });
  assert.equal(aceita.erro, false, aceita.texto);
  assert.equal(rh.chamadas.filter((x) => x.caminho === '/admin/v1/site/trocar').at(-1)!.corpo.aceitar_hosts_novos, true);
  await fechar();
});

test('DSC_SITE em maiúsculas vai para o Descontratos e a confirmação responde como página (volta, tela, como conferir)', async () => {
  const { dsc, ctx } = sistemas();
  const { chamar, fechar } = await cliente(ctx);
  const p = await chamar('sistemas_preparar_alteracao', { sistema: 'descontratos', operacao: 'atualizar', tabela: 'DSC_SITE', filtro: { part: 3 }, dados: { content: 'x' } });
  assert.equal(p.erro, false, p.texto);
  assert.ok(dsc.chamadas.some((x: any) => x.caminho === '/admin/v1/preparar'));
  const c = await chamar('sistemas_confirmar_alteracao', { confirmacao: p.json.confirmacao });
  assert.equal(c.erro, false, c.texto);
  assert.match(c.json.registro, /admin_log/);
  assert.ok(!/histórico do próprio descontrato/.test(c.json.registro), 'a página do Descontratos não tem histórico de descontrato');
  assert.match(c.json.tela, /próxima abertura/);
  await fechar();
});

test('Descontratos: a troca e a volta da página chegam ao servidor dele; backup de outra tabela do Descontratos é recusado pelo servidor e a ferramenta mostra o motivo', async () => {
  const { ctx } = sistemas();
  const { chamar, fechar } = await cliente(ctx);
  const t = await chamar('sistemas_site_trocar', { sistema: 'descontratos', parte: 2, de: 'a', para: 'b' });
  assert.equal(t.erro, false, t.texto);
  assert.equal(t.json.sistema, 'descontratos');
  const d = await chamar('sistemas_desfazer', { sistema: 'descontratos', backup_id: t.json.backup_id });
  assert.equal(d.erro, false, d.texto);
  const outro = await chamar('sistemas_desfazer', { sistema: 'descontratos', backup_id: '00000000-0000-4000-8000-0000000000aa' });
  assert.equal(outro.erro, true);
  assert.match(outro.texto, /não volta por aqui/);
  await fechar();
});

test('auditoria: a mensagem de erro da troca não leva o que o servidor citou entre aspas', async () => {
  const { ctx } = sistemas();
  const { chamar, auditoria, fechar } = await cliente(ctx);
  await chamar('sistemas_site_trocar', { parte: 1, de: 'x x', para: 'NOVO-HOST' });
  const a = auditoria.find((x) => x.ferramenta === 'sistemas_site_trocar' && !x.ok)!;
  assert.ok(a.erro && !a.erro.includes('coleta.exemplo'), a.erro);
  await fechar();
});
