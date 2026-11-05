// Contrato do que usamos do LangGraph. Fixado na subida 1.3.0 -> 1.4.21.
//
// Por que existe: `PostgresSaver.setup()` roda no boot de produção e aplica migrations no
// Postgres de produção SOZINHO. Uma subida de pacote que traga migration nova (foi o caso do
// @langchain/langgraph-checkpoint-postgres 1.1.0, que acrescenta `task_path` em
// checkpoint_writes) altera o banco no deploy e, no rolling update do Swarm (start-first), o
// contêiner antigo ainda estará lendo as mesmas tabelas. Este teste faz essa mudança aparecer
// no PR, em vez de no boot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import { AgentState } from './state.js';

/** Quantas migrations o PostgresSaver aplica hoje (versões 0..4). Mudou? Leia a nota acima. */
const MIGRATIONS_CONHECIDAS = 5;

type Consulta = { sql: string; params?: unknown[] };

/** Pool falso: grava toda consulta que o setup() faz e simula o estado do banco. */
function poolFalso(versaoNoBanco: number | null) {
  const consultas: Consulta[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      consultas.push({ sql, params });
      if (/SELECT v FROM .*checkpoint_migrations/i.test(sql)) {
        if (versaoNoBanco === null) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
        return { rows: [{ v: versaoNoBanco }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, consultas };
}

test('setup() num banco que já está na versão de produção (v=4) não executa DDL nenhum', async () => {
  const { pool, consultas } = poolFalso(MIGRATIONS_CONHECIDAS - 1);
  await new PostgresSaver(pool).setup();
  // CREATE SCHEMA IF NOT EXISTS "public" roda sempre (idempotente, sem efeito); o resto não pode rodar.
  const alteracoes = consultas.filter((c) => !/^\s*(SELECT|CREATE SCHEMA IF NOT EXISTS)/i.test(c.sql));
  assert.deepEqual(
    alteracoes.map((c) => c.sql.trim().slice(0, 80)),
    [],
    'o setup() mexeu no banco: há migration nova no @langchain/langgraph-checkpoint-postgres. ' +
      'Não é uma subida de pacote comum — avaliar o DDL e o rollback antes de mesclar.',
  );
});

test('setup() num banco virgem aplica exatamente as 5 migrations conhecidas, sem coluna nova', async () => {
  const { pool, consultas } = poolFalso(null);
  await new PostgresSaver(pool).setup();
  const registradas = consultas.filter((c) => /INSERT INTO .*checkpoint_migrations/i.test(c.sql));
  assert.deepEqual(
    registradas.map((c) => c.params?.[0]),
    [0, 1, 2, 3, 4],
    'a lista de migrations do checkpointer mudou',
  );
  const ddl = consultas.filter((c) => /^\s*(CREATE TABLE|ALTER)/i.test(c.sql)).map((c) => c.sql);
  assert.equal(ddl.length, MIGRATIONS_CONHECIDAS);
  assert.ok(!ddl.some((s) => /task_path/i.test(s)), 'task_path é o esquema do checkpoint-postgres 1.1.x');
  // só as 4 tabelas do checkpoint, nada de objeto novo
  const tabelas = new Set(ddl.map((s) => /(?:TABLE(?: IF NOT EXISTS)?)\s+(\S+)/i.exec(s)?.[1]?.replace(/"/g, '').replace(/^public\./, '')));
  assert.deepEqual(
    [...tabelas].sort(),
    ['checkpoint_blobs', 'checkpoint_migrations', 'checkpoint_writes', 'checkpoints'],
  );
});

// --- O grafo do agente em miniatura: mesmo desenho do graph.ts (agent + ToolNode, retry 2) ---

function montarGrafo(agente: (estado: typeof AgentState.State) => Promise<{ messages: AIMessage[] }>) {
  const quebra = new DynamicStructuredTool({
    name: 'quebra',
    description: 'sempre falha',
    schema: z.object({ n: z.number() }),
    func: async () => {
      throw new Error('ferramenta quebrou');
    },
  });
  return new StateGraph(AgentState)
    .addNode('agent', agente, { retryPolicy: { maxAttempts: 2 } })
    .addNode('tools', new ToolNode([quebra]))
    .addEdge(START, 'agent')
    .addConditionalEdges(
      'agent',
      (s) => (((s.messages.at(-1) as AIMessage | undefined)?.tool_calls?.length ?? 0) > 0 ? 'tools' : END),
      { tools: 'tools', [END]: END },
    )
    .addEdge('tools', 'agent')
    .compile({ checkpointer: new MemorySaver() });
}

test('erro de ferramenta vira ToolMessage de erro (o turno continua) — também com args inválidos e ferramenta inexistente', async () => {
  let chamadas = 0;
  const grafo = montarGrafo(async (s) => {
    chamadas += 1;
    if (s.messages.at(-1)?.getType() === 'human') {
      return {
        messages: [
          new AIMessage({
            content: '',
            tool_calls: [
              { id: 'c1', name: 'quebra', args: { n: 1 } },
              { id: 'c2', name: 'quebra', args: { n: 'texto' } },
              { id: 'c3', name: 'nao_existe', args: {} },
            ],
          }),
        ],
      };
    }
    return { messages: [new AIMessage('fim')] };
  });
  const r = await grafo.invoke(
    { messages: [new HumanMessage('oi')] },
    { configurable: { thread_id: 'unit-teste-lead-1' }, recursionLimit: 24 },
  );
  const tools = r.messages.filter((m) => m.getType() === 'tool') as ToolMessage[];
  assert.deepEqual(tools.map((t) => t.tool_call_id), ['c1', 'c2', 'c3']);
  assert.ok(tools.every((t) => t.status === 'error'));
  assert.match(String(tools[0].content), /ferramenta quebrou/);
  assert.match(String(tools[2].content), /not found/i);
  assert.equal(r.messages.at(-1)?.getType(), 'ai');
  assert.equal(chamadas, 2, 'um turno com ferramenta chama o agente duas vezes');
});

test('retryPolicy { maxAttempts: 2 }: uma falha do agente é repetida UMA vez; falhou de novo, o erro sobe', async () => {
  let tentativas = 0;
  const unaFalha = montarGrafo(async () => {
    tentativas += 1;
    if (tentativas === 1) throw new Error('falha transitória');
    return { messages: [new AIMessage('ok')] };
  });
  const r = await unaFalha.invoke(
    { messages: [new HumanMessage('oi')] },
    { configurable: { thread_id: 'unit-teste-lead-2' }, recursionLimit: 24 },
  );
  assert.equal(tentativas, 2);
  assert.equal(r.messages.at(-1)?.content, 'ok');

  let total = 0;
  const sempreFalha = montarGrafo(async () => {
    total += 1;
    throw new Error('falha permanente');
  });
  await assert.rejects(
    sempreFalha.invoke(
      { messages: [new HumanMessage('oi')] },
      { configurable: { thread_id: 'unit-teste-lead-3' }, recursionLimit: 24 },
    ),
    /falha permanente/,
  );
  assert.equal(total, 2, 'maxAttempts: 2 = a original + 1 repetição');
});

test('o histórico do thread_id sobrevive entre turnos (reducer de mensagens + checkpointer)', async () => {
  const grafo = montarGrafo(async (s) => ({ messages: [new AIMessage(`vi ${s.messages.length} mensagens`)] }));
  const cfg = { configurable: { thread_id: 'unit-teste-lead-4' }, recursionLimit: 24 };
  await grafo.invoke({ messages: [new HumanMessage('um')] }, cfg);
  const r = await grafo.invoke({ messages: [new HumanMessage('dois')] }, cfg);
  assert.deepEqual(
    r.messages.map((m) => m.getType()),
    ['human', 'ai', 'human', 'ai'],
  );
  assert.equal(r.messages.at(-1)?.content, 'vi 3 mensagens');
});
