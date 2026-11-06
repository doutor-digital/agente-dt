import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErroSistemas, sistemasChamar } from '../lib/integracoes/sistemas.js';
import { criarContextoSistemas, PendentesSistemas, registrarEscritaSistemas, registrarLeituraSistemas, type ContaSistemas } from './sistemas.js';
import { confirmarFinUnidades, prepararFinUnidades, registrarFinUnidadesSistemas } from './sistemas-fin-unidades.js';
import { confirmarAdmin, prepararAdmin } from './sistemas-admin.js';
import { CONFIG_FALSA, servidorAdminFalso } from './sistemas-falso.js';

// Lista de empresas do Financeiro (fin_unidades) pelo conector: SEMPRE em dois passos; o 1º usa o ENSAIO do servidor (o banco valida e normaliza, nada é gravado).

const QUEM = { usuario: 'user-1', nome: 'suzanne@exemplo.com' };
const OUTRO = { usuario: 'user-2', nome: 'outra@exemplo.com' };
const MOTIVO = 'Adriele não vê mais as empresas de outro grupo';

function montar(opcoes: Parameters<typeof servidorAdminFalso>[0] = { comFinanceiro: true }) {
  const srv = servidorAdminFalso(opcoes);
  const conta: ContaSistemas = { slug: 'hm-tecnologia', nome: 'HM Tecnologia', tela: CONFIG_FALSA.tela, fonte: { chamar: (m, c, op) => sistemasChamar(CONFIG_FALSA, m, c, op, srv.fetch) } };
  return { srv, ctx: criarContextoSistemas(new Map([[conta.slug, conta]])), pend: new PendentesSistemas() };
}
const gravacoes = (srv: ReturnType<typeof montar>['srv']) => srv.chamadas.filter((c) => c.caminho === '/admin/v1/usuario' && c.corpo?.acao === 'fin_unidades' && c.corpo?.ensaio !== true);

test('passo 1: mostra antes e depois JÁ na grafia oficial (validada pelo servidor), devolve um código e NÃO grava', async () => {
  const { srv, ctx, pend } = montar();
  const r = (await prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-5', empresas: ['balsas', 'MARABA', 'balsas-ma'], motivo: MOTIVO })) as any;
  assert.deepEqual(r.depois, ['Balsas-MA', 'Marabá-PA']);
  assert.equal(r.antes, 'todas');
  assert.match(r.confirmacao, /^fin-/); assert.match(r.instrucao, /Nada foi alterado ainda.*sistemas_confirmar_fin_unidades/);
  assert.match(r.resumo.join('\n'), /hoje vê TODAS as empresas/); assert.match(r.resumo.join('\n'), /Balsas-MA; Marabá-PA/); assert.match(r.resumo.join('\n'), /colaboradores, ponto, folha/);
  assert.equal(gravacoes(srv).length, 0, 'o passo 1 gravou');
  assert.ok(srv.chamadas.some((c) => c.corpo?.ensaio === true), 'não usou o ensaio do servidor');
});

test('passo 2: com o código grava a lista NORMALIZADA do ensaio; o código é de uso único; outro usuário não o usa', async () => {
  const { srv, ctx, pend } = montar();
  const p = (await prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-5', empresas: ['balsas'], motivo: MOTIVO })) as any;
  await assert.rejects(() => confirmarFinUnidades(ctx, pend, OUTRO, { confirmacao: p.confirmacao }), /outro usuário/);
  const ok = (await confirmarFinUnidades(ctx, pend, QUEM, { confirmacao: p.confirmacao })) as any;
  assert.equal(ok.ok, true); assert.deepEqual(ok.depois, ['Balsas-MA']); assert.equal(ok.backup_id, 'bk-fin-1');
  const g = gravacoes(srv); assert.equal(g.length, 1); assert.deepEqual(g[0]!.corpo!.valor, ['Balsas-MA']); assert.equal(g[0]!.corpo!.quem, QUEM.nome);
  await assert.rejects(() => confirmarFinUnidades(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /desconhecido ou já usado/);
  // agora a lista de antes aparece no próximo passo 1
  const q = (await prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-5', empresas: ['Balsas-MA', 'Instituto Trauma'], motivo: MOTIVO })) as any;
  assert.deepEqual(q.antes, ['Balsas-MA']); assert.match(q.resumo.join('\n'), /passa a ver: Instituto Trauma/);
});

test('nome que o banco não conhece: o erro aparece NO PASSO 1, com a lista das conhecidas; nada é preparado nem gravado', async () => {
  const { srv, ctx, pend } = montar();
  await assert.rejects(() => prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-5', empresas: ['Magalhaes Advocasia'], motivo: MOTIVO }), /o servidor recusou:.*não é uma empresa\/unidade conhecida\. Conhecidas: .*Balsas-MA/);
  assert.equal(gravacoes(srv).length, 0);
});

test('liberar todas: null e [] viram "todas" com o aviso de que ela volta a ver tudo', async () => {
  const { ctx, pend } = montar();
  const g = (await prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-5', empresas: ['Balsas-MA'], motivo: MOTIVO })) as any;
  await confirmarFinUnidades(ctx, pend, QUEM, { confirmacao: g.confirmacao });
  for (const v of [null, []]) {
    const r = (await prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-5', empresas: v, motivo: MOTIVO })) as any;
    assert.equal(r.depois, 'todas'); assert.match(r.resumo.join('\n'), /volta a ver TODAS/);
  }
});

test('recusas: usuário que não é financeiro, usuário que não existe, motivo curto, lista malformada, servidor sem a ação (API antiga)', async () => {
  const { ctx, pend } = montar();
  await assert.rejects(() => prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-2', empresas: ['Balsas-MA'], motivo: MOTIVO }), /só vale para o papel financeiro/);
  await assert.rejects(() => prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-99', empresas: ['Balsas-MA'], motivo: MOTIVO }), /não encontrado/);
  await assert.rejects(() => prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-5', empresas: ['Balsas-MA'], motivo: 'ok' }), /motivo/);
  await assert.rejects(() => prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-5', empresas: [''], motivo: MOTIVO }), /lista de nomes/);
  await assert.rejects(() => prepararFinUnidades(ctx, pend, QUEM, { usuario: "u-5' or 1=1", empresas: ['Balsas-MA'], motivo: MOTIVO }), /user_id/);
  const antiga = montar({ maisUsuarios: true });                        // servidor 0.1.10.8: /usuarios sem a coluna
  await assert.rejects(() => prepararFinUnidades(antiga.ctx, antiga.pend, QUEM, { usuario: 'u-4', empresas: ['Balsas-MA'], motivo: MOTIVO }), /ainda não tem a lista de empresas do Financeiro/);
  assert.equal(gravacoes(antiga.srv).length, 0);
});

test('o código de fin_unidades não confirma outra coisa (admin) e o de admin não confirma fin_unidades; a tentativa errada não gasta o código', async () => {
  const { ctx, pend } = montar({ comFinanceiro: true, maisUsuarios: true });
  const f = (await prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-5', empresas: ['Balsas-MA'], motivo: MOTIVO })) as any;
  await assert.rejects(() => confirmarAdmin(ctx, pend, QUEM, { confirmacao: f.confirmacao }), /sistemas_confirmar_fin_unidades/);
  const a = (await prepararAdmin(ctx, pend, QUEM, { acao: 'promover', usuario: 'u-1', motivo: MOTIVO })) as any;
  await assert.rejects(() => confirmarFinUnidades(ctx, pend, QUEM, { confirmacao: a.confirmacao }), /sistemas_confirmar_admin/);
  assert.equal(((await confirmarFinUnidades(ctx, pend, QUEM, { confirmacao: f.confirmacao })) as any).ok, true);
});

test('já vê todas e o pedido é "todas": o resumo diz que nada muda (sem aviso falso)', async () => {
  const { ctx, pend } = montar();
  const r = (await prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-5', empresas: null, motivo: MOTIVO })) as any;
  assert.match(r.resumo.join('\n'), /nada muda/); assert.ok(!/volta a ver TODAS/.test(r.resumo.join('\n')));
});

test('a lista guardada com outra grafia (dado antigo) não vira "deixa de ver / passa a ver" falso: compara pela mesma ideia do banco', async () => {
  const { srv, ctx, pend } = montar();
  (srv as any).usuarios?.find?.((u: any) => u.user_id === 'u-5');
  // grava uma vez, depois muda a grafia guardada direto no fake para simular dado antigo ("balsas")
  const p0 = (await prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-5', empresas: ['Balsas-MA'], motivo: MOTIVO })) as any;
  await confirmarFinUnidades(ctx, pend, QUEM, { confirmacao: p0.confirmacao });
  const original = ctx.contas.get('hm-tecnologia')!.fonte.chamar;
  ctx.contas.get('hm-tecnologia')!.fonte.chamar = (async (m: string, c: string, op: any) => {
    const r: any = await original(m as any, c, op);
    if (c === '/admin/v1/usuarios') for (const u of r.usuarios) if (u.user_id === 'u-5') u.fin_unidades = ['balsas'];
    return r;
  }) as typeof original;
  const r = (await prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-5', empresas: ['Balsas-MA'], motivo: MOTIVO })) as any;
  assert.match(r.resumo.join('\n'), /nada muda/); assert.ok(!/deixa de ver/.test(r.resumo.join('\n')));
});

test('a lista mudou entre a prévia e a confirmação (outra pessoa): recusa, não sobrescreve', async () => {
  const { srv, ctx, pend } = montar();
  const a = (await prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-5', empresas: ['Balsas-MA'], motivo: MOTIVO })) as any;
  const b = (await prepararFinUnidades(ctx, pend, OUTRO, { usuario: 'u-5', empresas: ['Marabá-PA'], motivo: MOTIVO })) as any;
  await confirmarFinUnidades(ctx, pend, OUTRO, { confirmacao: b.confirmacao });
  await assert.rejects(() => confirmarFinUnidades(ctx, pend, QUEM, { confirmacao: a.confirmacao }), /MUDOU desde a prévia.*Marabá-PA/);
  assert.equal(gravacoes(srv).length, 1);
});

test('não consegue rereler a lista na confirmação: NADA é gravado e o código volta', async () => {
  const { srv, ctx, pend } = montar();
  const p = (await prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-5', empresas: ['Balsas-MA'], motivo: MOTIVO })) as any;
  const conta = ctx.contas.get('hm-tecnologia')!; const original = conta.fonte.chamar;
  conta.fonte.chamar = (async () => { throw new ErroSistemas('sem resposta', null); }) as typeof original;
  await assert.rejects(() => confirmarFinUnidades(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /NADA foi gravado.*continua valendo/);
  conta.fonte.chamar = original;
  assert.equal(gravacoes(srv).length, 0);
  assert.equal(((await confirmarFinUnidades(ctx, pend, QUEM, { confirmacao: p.confirmacao })) as any).ok, true);
});

test('servidor que não diz que sabe o ENSAIO: o passo 1 nem manda o POST (ele poderia gravar sem o ok da pessoa)', async () => {
  const { srv, ctx, pend } = montar();
  const conta = ctx.contas.get('hm-tecnologia')!; const original = conta.fonte.chamar;
  conta.fonte.chamar = (async (m: string, c: string, op: any) => { const r: any = await original(m as any, c, op); if (c === '/admin/v1/usuarios') delete r.recursos; return r; }) as typeof original;
  await assert.rejects(() => prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-5', empresas: ['Balsas-MA'], motivo: MOTIVO }), /com ensaio/);
  assert.equal(srv.chamadas.filter((c) => c.metodo === 'POST').length, 0);
});

test('429/409/408 na confirmação são incertos: o código volta (não é "recusado")', async () => {
  for (const status of [429, 409, 408]) {
    const { ctx, pend } = montar();
    const p = (await prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-5', empresas: ['Balsas-MA'], motivo: MOTIVO })) as any;
    const conta = ctx.contas.get('hm-tecnologia')!; const original = conta.fonte.chamar;
    conta.fonte.chamar = (async (m: string, c: string, op: any) => { if (m === 'POST') throw new ErroSistemas('ocupado', status); return original(m as any, c, op); }) as typeof original;
    await assert.rejects(() => confirmarFinUnidades(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /NÃO sei se a lista foi gravada/);
    conta.fonte.chamar = original;
    assert.equal(((await confirmarFinUnidades(ctx, pend, QUEM, { confirmacao: p.confirmacao })) as any).ok, true, String(status));
  }
});

test('rede cai na confirmação: o código volta (a gravação é idempotente) e a mensagem manda conferir antes de repetir', async () => {
  const { srv, ctx, pend } = montar();
  const p = (await prepararFinUnidades(ctx, pend, QUEM, { usuario: 'u-5', empresas: ['Balsas-MA'], motivo: MOTIVO })) as any;
  const conta = ctx.contas.get('hm-tecnologia')!;
  const original = conta.fonte.chamar;
  conta.fonte.chamar = (async (m: string, c: string, op: any) => { if (m === 'POST') throw new ErroSistemas('sem resposta', null); return original(m as any, c, op); }) as typeof original;
  await assert.rejects(() => confirmarFinUnidades(ctx, pend, QUEM, { confirmacao: p.confirmacao }), /NÃO sei se a lista foi gravada/);
  conta.fonte.chamar = original;
  assert.equal(((await confirmarFinUnidades(ctx, pend, QUEM, { confirmacao: p.confirmacao })) as any).ok, true);
  assert.equal(gravacoes(srv).length, 1);
});

async function cliente(ctx: ReturnType<typeof criarContextoSistemas>, escreve: boolean) {
  const server = new McpServer({ name: 't', version: '1' });
  const auditoria: Array<{ ferramenta: string; argumentos: any; ok: boolean }> = [];
  const auditar = (r: { ferramenta: string; argumentos: unknown; ok: boolean }) => auditoria.push(r as any);
  const pend = new PendentesSistemas();
  registrarLeituraSistemas(server, ctx, QUEM, auditar);
  if (escreve) { registrarEscritaSistemas(server, ctx, pend, QUEM, auditar); registrarFinUnidadesSistemas(server, ctx, pend, QUEM, auditar); }
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(a), c.connect(b)]);
  const chamar = async (nome: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name: nome, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { erro: r.isError === true, texto: r.content[0]!.text, json: r.isError ? null : JSON.parse(r.content[0]!.text) };
  };
  return { c, chamar, auditoria };
}

test('pelo protocolo: só aparece para quem escreve; prévia é somente-leitura; a auditoria leva o usuário (id) e o código, nunca o nome', async () => {
  const { ctx } = montar();
  assert.ok(!(await (await cliente(ctx, false)).c.listTools()).tools.some((t) => t.name.includes('fin_unidades')));
  const { c, chamar, auditoria } = await cliente(ctx, true);
  const por = Object.fromEntries((await c.listTools()).tools.map((t) => [t.name, t.annotations]));
  assert.equal(por['sistemas_preparar_fin_unidades']!.readOnlyHint, true); assert.equal(por['sistemas_confirmar_fin_unidades']!.destructiveHint, true);
  const p = await chamar('sistemas_preparar_fin_unidades', { usuario: 'u-5', empresas: ['Balsas-MA'], motivo: MOTIVO });
  assert.equal(p.erro, false, p.texto);
  const ok = await chamar('sistemas_confirmar_fin_unidades', { confirmacao: p.json.confirmacao });
  assert.equal(ok.erro, false, ok.texto);
  const aud = JSON.stringify(auditoria);
  assert.ok(!/Fin Teste|"fin"|suzanne@/.test(aud), 'a auditoria levou nome ou login');
  assert.ok(auditoria.some((a) => a.ferramenta === 'sistemas_confirmar_fin_unidades' && a.argumentos.usuario === 'u-5' && a.argumentos.resultado === 'ok'));
});
