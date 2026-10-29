import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { xlsxFalso } from '../lib/integracoes/xlsx-falso.js';
import { criarContextoPlanilha, fontePlanilhaPublica, planilhaAbas, planilhaLer, registrarFerramentasPlanilha, type ContextoPlanilha } from './planilha.js';

// Planilha FICTÍCIA gerada aqui. Nada da planilha real de ninguém entra em teste, log ou PR.
const SENHAS = ['Fic$enha-Um-9981', 'zz-outra-8842', 'Fic$enha-Colada-7'];
const CPFS_CRUS = ['12345678909', '987.654.321-00', '111.222.333-44'];
const ID = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';

function linhas(n: number) {
  const out: string[][] = [['Nome', 'CPF', 'Telefone', 'Senha Meu INSS', 'Situação']];
  for (let i = 1; i <= n; i++) out.push([`Cliente ${i}`, '12345678909', '11987654321', SENHAS[0]!, i % 2 ? 'Em análise' : 'Concedido']);
  return out;
}

function ctxCom(abas: Parameters<typeof xlsxFalso>[0], chamadas: string[] = []): ContextoPlanilha {
  const fetcher = (async (url: string | URL | Request) => {
    chamadas.push(String(url));
    return new Response(new Uint8Array(xlsxFalso(abas)), { status: 200 });
  }) as typeof fetch;
  return criarContextoPlanilha(new Map([['magalhaes', { slug: 'magalhaes', nome: 'Magalhães', planilhas: [{ apelido: 'clientes', fonte: fontePlanilhaPublica(ID, fetcher) }] }]]));
}

const CLIENTES = [
  {
    nome: 'Clientes',
    linhas: [
      ['Nome', 'CPF', 'Telefone', 'Senha Meu INSS', 'Situação', 'Obs'],
      ['Maria Souza', CPFS_CRUS[0]!, '(11) 98765-4321', SENHAS[0]!, 'Em análise', 'ok'],
      ['João Lima', CPFS_CRUS[1]!, '11912345678', SENHAS[1]!, 'Concedido', `acesso ${CPFS_CRUS[2]}/${SENHAS[2]}`],
      ['Ana Reis', '', '', '', 'Indeferido', 'retorno em 30 dias'],
      ['Lia Prado', '', '', '', 'Em análise', 'sem pendência'],
    ],
  },
  { nome: 'Outra', linhas: [['Item', 'Valor'], ['a', '1']] },
];

function naoVaza(x: unknown) {
  const s = JSON.stringify(x);
  for (const p of [...SENHAS, ...CPFS_CRUS, '98765-4321', '11912345678', '11987654321']) assert.equal(s.includes(p), false, `vazou: ${p}`);
}

test('planilha_abas: abas, cabeçalhos que sobraram e o que foi descartado (sem o conteúdo)', async () => {
  const r = await planilhaAbas(ctxCom(CLIENTES), { unidade: 'magalhaes' });
  const u = r.porUnidade['magalhaes'] as Extract<(typeof r.porUnidade)[string], { ok: true }>;
  assert.equal(u.ok, true);
  const p = u.planilhas[0]!;
  assert.equal(p.apelido, 'clientes');
  assert.equal(p.modo, 'publico');
  assert.deepEqual(p.abas.map((a) => a.nome), ['Clientes', 'Outra']);
  assert.deepEqual(p.abas[0]!.cabecalhos, ['Nome', 'CPF', 'Telefone', 'Situação', 'Obs']);
  assert.equal(p.abas[0]!.linhas, 4);
  assert.deepEqual(p.abas[0]!.colunasDescartadas, [{ cabecalho: 'Senha Meu INSS', motivo: 'cabeçalho de senha/login' }]);
  naoVaza(r);
});

test('planilha_ler: 50 linhas por padrão, máximo 200, com número da linha e onde continuar', async () => {
  const ctx = ctxCom([{ nome: 'Grande', linhas: linhas(300) }]);
  const r = await planilhaLer(ctx, { unidade: 'magalhaes' });
  assert.equal(r.linhas.length, 50);
  assert.equal(r.totalNaAba, 300);
  assert.equal(r.proximaLinha, 51);
  assert.equal(r.linhas[0]!.linha, 1);
  const r2 = await planilhaLer(ctx, { unidade: 'magalhaes', aPartirDaLinha: 51, maxLinhas: 200 });
  assert.equal(r2.linhas.length, 200);
  assert.equal(r2.linhas[0]!.linha, 51);
  await assert.rejects(planilhaLer(ctx, { unidade: 'magalhaes', maxLinhas: 201 }), /até 200/);
  naoVaza([r, r2]);
});

test('planilha_ler: CPF e telefone mascarados; CPF/senha colado na observação omitido', async () => {
  const r = await planilhaLer(ctxCom(CLIENTES), { unidade: 'magalhaes', aba: 'clientes' });
  assert.deepEqual(r.linhas[0]!.valores, { Nome: 'Maria Souza', CPF: '***.***.***-09', Telefone: '(**) *****-4321', Situação: 'Em análise', Obs: 'ok' });
  assert.equal(r.linhas[1]!.valores['Obs'], 'acesso [CPF/senha omitido]');
  naoVaza(r);
});

test('completo: true NUNCA libera CPF, telefone nem senha', async () => {
  const ctx = ctxCom(CLIENTES);
  const r = await planilhaLer(ctx, { unidade: 'magalhaes', aba: 'clientes', completo: true });
  naoVaza(r);
  assert.equal(r.linhas[0]!.valores['CPF'], '***.***.***-09');
  assert.equal('Senha Meu INSS' in r.linhas[0]!.valores, false);
  // nem pedindo a coluna pelo nome
  await assert.rejects(planilhaLer(ctx, { unidade: 'magalhaes', aba: 'clientes', colunas: ['Senha Meu INSS'], completo: true }), (e: Error) => {
    assert.match(e.message, /não existe|não há/);
    naoVaza(e.message);
    return true;
  });
});

test('busca só vê o dado já limpo: não dá para descobrir CPF nem senha procurando por eles', async () => {
  const ctx = ctxCom(CLIENTES);
  for (const termo of [CPFS_CRUS[0]!, '123.456.789-09', SENHAS[0]!, 'Fic$enha', '98765-4321']) {
    const r = await planilhaLer(ctx, { unidade: 'magalhaes', aba: 'clientes', busca: termo });
    assert.equal(r.linhas.length, 0, termo);
  }
  const r = await planilhaLer(ctx, { unidade: 'magalhaes', aba: 'clientes', busca: 'souza análise' });
  assert.deepEqual(r.linhas.map((l) => l.valores['Nome']), ['Maria Souza']);
  const sem = await planilhaLer(ctx, { unidade: 'magalhaes', aba: 'clientes', busca: 'ANALISE' });
  assert.equal(sem.linhas.length, 2, 'sem acento e sem caixa');
  assert.equal(sem.totalNoFiltro, 2);
});

test('colunas: devolve só as pedidas; coluna que não existe lista as que existem', async () => {
  const ctx = ctxCom(CLIENTES);
  const r = await planilhaLer(ctx, { unidade: 'magalhaes', aba: 'clientes', colunas: ['nome', 'situacao'] });
  assert.deepEqual(Object.keys(r.linhas[0]!.valores), ['Nome', 'Situação']);
  await assert.rejects(planilhaLer(ctx, { unidade: 'magalhaes', aba: 'clientes', colunas: ['Idade'] }), /Nome, CPF, Telefone, Situação, Obs/);
});

test('planilha_ler: a aba pode ser omitida só se houver uma; senão lista; unidade sem planilha explica', async () => {
  const ctx = ctxCom(CLIENTES);
  await assert.rejects(planilhaLer(ctx, { unidade: 'magalhaes' }), /Clientes, Outra/);
  await assert.rejects(planilhaLer(ctx, { unidade: 'magalhaes', aba: 'inexistente' }), /Clientes, Outra/);
  await assert.rejects(planilhaLer(ctx, { unidade: 'serra' }), /nenhuma|desconhecida|sem planilha/);
  await assert.rejects(planilhaLer(ctx, { unidade: 'magalhaes', planilha: 'outra-coisa', aba: 'Clientes' }), /clientes/);
  const vazio = criarContextoPlanilha(new Map());
  await assert.rejects(planilhaAbas(vazio, { unidade: 'todas' }), /nenhuma/);
});

test('cache: a planilha limpa fica 10 min em memória e não é baixada de novo a cada consulta', async () => {
  const chamadas: string[] = [];
  const ctx = ctxCom(CLIENTES, chamadas);
  await planilhaAbas(ctx, { unidade: 'magalhaes' });
  await planilhaLer(ctx, { unidade: 'magalhaes', aba: 'Clientes' });
  await planilhaLer(ctx, { unidade: 'magalhaes', aba: 'Outra' });
  assert.equal(chamadas.length, 1);
  assert.deepEqual(chamadas, [`https://docs.google.com/spreadsheets/d/${ID}/export?format=xlsx`]);
});

test('erro da origem não vaza conteúdo: planilha privada vira mensagem de acesso', async () => {
  const ctx = criarContextoPlanilha(new Map([['m', { slug: 'm', nome: 'M', planilhas: [{ apelido: 'x', fonte: fontePlanilhaPublica(ID, (async () => new Response('<html>login</html>', { status: 200 })) as typeof fetch) }] }]]));
  const r = await planilhaAbas(ctx, { unidade: 'm' });
  const u = r.porUnidade['m']!;
  assert.equal(u.ok, false);
  assert.match((u as { erro: string }).erro, /qualquer pessoa com o link/);
});

test('ferramentas registradas: só leitura, e o teto de 200 linhas está no esquema', () => {
  const vistas: Array<{ nome: string; cfg: { annotations?: { readOnlyHint?: boolean }; inputSchema?: Record<string, z.ZodTypeAny> } }> = [];
  const falso = { registerTool: (nome: string, cfg: never) => void vistas.push({ nome, cfg }) } as unknown as McpServer;
  registrarFerramentasPlanilha(falso, ctxCom(CLIENTES));
  assert.deepEqual(vistas.map((v) => v.nome), ['planilha_abas', 'planilha_ler']);
  for (const v of vistas) assert.equal(v.cfg.annotations?.readOnlyHint, true);
  const max = vistas[1]!.cfg.inputSchema!['maxLinhas']!;
  assert.equal(max.safeParse(200).success, true);
  assert.equal(max.safeParse(201).success, false);
});
