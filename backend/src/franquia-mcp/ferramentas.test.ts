/**
 * De ponta a ponta: um cliente MCP de verdade (o que o Claude Code usa) falando com o servidor
 * pelo transporte em memória, e o servidor falando com a franquia falsa.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Unidade } from './unidade.js';
import { criarContexto } from './contexto.js';
import { registrarFerramentas } from './ferramentas.js';
import { type FranquiaFalsa, subirFranquiaFalsa } from './franquia-falsa.js';

const TOKEN = 'token-secreto-da-serra-0123456789';
let falsa: FranquiaFalsa;
let cliente: Client;

before(async () => {
  falsa = await subirFranquiaFalsa({
    [TOKEN]: { agendamentos: [{ idSchedule: 1, clientName: 'Ana', dateAttendance: '2026-06-10T13:00:00Z', statusName: 'Atendido' }] },
  });
  const unidades = new Map<string, Unidade>([['serra', { slug: 'serra', nome: 'Serra', token: TOKEN, fuso: 'America/Sao_Paulo', baseUrl: falsa.url }]]);
  const server = new McpServer({ name: 'spine-mcp', version: 'teste' });
  registrarFerramentas(server, criarContexto(unidades, { intervaloMs: 0, cliente: { log: () => {} } }));
  const [lado1, lado2] = InMemoryTransport.createLinkedPair();
  cliente = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(lado1), cliente.connect(lado2)]);
});
after(async () => {
  await cliente.close();
  await falsa.fechar();
});

function texto(r: Awaited<ReturnType<Client['callTool']>>): string {
  return (r.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
}

test('expõe as 11 ferramentas, todas marcadas como só leitura', async () => {
  const { tools } = await cliente.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'bi_leads_por_origem',
    'bi_pacientes_por_genero',
    'bi_tratamentos_por_categoria',
    'buscar_agendamentos',
    'buscar_leads',
    'buscar_pacientes',
    'buscar_tratamentos',
    'checar_conexao',
    'dados_gerais',
    'listar_unidades',
    'paciente_por_id',
  ]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
});

test('buscar_agendamentos responde JSON com o total', async () => {
  const r = await cliente.callTool({ name: 'buscar_agendamentos', arguments: { unidade: 'serra', inicio: '2026-06-01', fim: '2026-06-30' } });
  assert.equal(r.isError, undefined);
  assert.equal(JSON.parse(texto(r)).porUnidade.serra.total, 1);
});

test('pedido inválido volta como erro legível, sem derrubar o servidor', async () => {
  const r = await cliente.callTool({ name: 'buscar_agendamentos', arguments: { unidade: 'serra', inicio: '01/06/2026', fim: '2026-06-30' } });
  assert.equal(r.isError, true);
  assert.match(texto(r), /Pedido inválido: inicio: use o formato AAAA-MM-DD/);
});

test('tratamentos sem período é recusado pelo esquema (a franquia cortaria no mês corrente)', async () => {
  const r = await cliente.callTool({ name: 'buscar_tratamentos', arguments: { unidade: 'serra' } });
  assert.equal(r.isError, true);
});

test('o token não aparece em nenhuma resposta', async () => {
  const chamadas = [
    { name: 'listar_unidades', arguments: {} },
    { name: 'checar_conexao', arguments: { unidade: 'todas' } },
    { name: 'buscar_pacientes', arguments: { unidade: 'serra' } },
    { name: 'paciente_por_id', arguments: { unidade: 'serra', idClient: 42 } },
  ];
  for (const ch of chamadas) {
    const t = texto(await cliente.callTool(ch));
    assert.ok(!t.includes(TOKEN) && !t.includes('secreto'), ch.name);
  }
});

test('auditoria recebe cada chamada, com erro quando houve', async () => {
  const registros: Array<{ ferramenta: string; ok: boolean; erro?: string }> = [];
  const unidades = new Map<string, Unidade>([['serra', { slug: 'serra', nome: 'Serra', token: TOKEN, fuso: 'America/Sao_Paulo', baseUrl: falsa.url }]]);
  const server = new McpServer({ name: 'spine-mcp', version: 'teste' });
  registrarFerramentas(server, criarContexto(unidades, { intervaloMs: 0, cliente: { log: () => {} } }), { auditar: (r) => registros.push(r) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const outro = new Client({ name: 'auditoria', version: '0' });
  await Promise.all([server.connect(a), outro.connect(b)]);
  await outro.callTool({ name: 'listar_unidades', arguments: {} });
  await outro.callTool({ name: 'buscar_pacientes', arguments: { unidade: 'xpto' } });
  await outro.close();
  assert.deepEqual(
    registros.map((r) => [r.ferramenta, r.ok]),
    [
      ['listar_unidades', true],
      ['buscar_pacientes', false],
    ],
  );
  assert.match(registros[1]?.erro ?? '', /unidade desconhecida/);
});

test('erro que repete um id (pay_…, idClient de 10 dígitos) volta ao modelo e vai à auditoria INTACTO', async () => {
  const registros: Array<{ ferramenta: string; ok: boolean; erro?: string }> = [];
  const unidades = new Map<string, Unidade>([['serra', { slug: 'serra', nome: 'Serra', token: TOKEN, fuso: 'America/Sao_Paulo', baseUrl: falsa.url }]]);
  const server = new McpServer({ name: 'spine-mcp', version: 'teste' });
  registrarFerramentas(server, criarContexto(unidades, { intervaloMs: 0, cliente: { log: () => {} } }), { auditar: (r) => registros.push(r) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const outro = new Client({ name: 'auditoria', version: '0' });
  await Promise.all([server.connect(a), outro.connect(b)]);
  const r = await outro.callTool({ name: 'buscar_pacientes', arguments: { unidade: 'pay_12345678901 idClient 1234567890' } });
  await outro.close();
  assert.match(texto(r), /pay_12345678901 idclient 1234567890/i);
  assert.match(registros[0]?.erro ?? '', /pay_12345678901 idclient 1234567890/i);
});

test('erro que repete o pedido (CPF, CNPJ, telefone no nome da unidade) volta ao modelo e vai à auditoria mascarado', async () => {
  const registros: Array<{ ferramenta: string; ok: boolean; erro?: string }> = [];
  const unidades = new Map<string, Unidade>([['serra', { slug: 'serra', nome: 'Serra', token: TOKEN, fuso: 'America/Sao_Paulo', baseUrl: falsa.url }]]);
  const server = new McpServer({ name: 'spine-mcp', version: 'teste' });
  registrarFerramentas(server, criarContexto(unidades, { intervaloMs: 0, cliente: { log: () => {} } }), { auditar: (r) => registros.push(r) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const outro = new Client({ name: 'auditoria', version: '0' });
  await Promise.all([server.connect(a), outro.connect(b)]);
  const r = await outro.callTool({ name: 'buscar_pacientes', arguments: { unidade: '123.456.789-09 12345678000195 (11) 98765-4321' } });
  await outro.close();
  const proibido = /123\.456\.789-09|12345678000195|98765-4321/;
  assert.equal(proibido.test(texto(r)), false, texto(r));
  assert.equal(proibido.test(registros[0]?.erro ?? ''), false, registros[0]?.erro);
  assert.match(registros[0]?.erro ?? '', /unidade desconhecida/);
  assert.match(registros[0]?.erro ?? '', /-09/);
});
