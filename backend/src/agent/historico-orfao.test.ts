import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import { sanearHistorico, TEXTO_FERRAMENTA_INTERROMPIDA } from './historico-orfao.js';
import { toolsParaOpenAI } from './tools-openai.js';

const h = (t: string) => new HumanMessage(t);
const a = (t: string) => new AIMessage(t);
const ID = 'toolu_01LuELBcMzNc8pMsAb5wNoqX';
// O que o checkpoint do lead 29012474 guardava: a resposta do modelo SÓ com o tool_use (como veio da Anthropic).
const aTool = (id = ID, name = 'aplicar_tag') =>
  new AIMessage({
    content: [{ type: 'tool_use', id, name, input: { tags: ['x'] } }],
    tool_calls: [{ id, name, args: { tags: ['x'] }, type: 'tool_call' }],
  });
const tRes = (id = ID) => new ToolMessage({ tool_call_id: id, content: 'ok' });
const tipos = (ms: BaseMessage[]) => ms.map((m) => m.getType());

test('histórico íntegro volta como a mesma referência (nada é tocado)', () => {
  const msgs = [h('oi'), aTool(), tRes(), a('olá!'), h('quero agendar')];
  const r = sanearHistorico(msgs);
  assert.equal(r.messages, msgs);
  assert.deepEqual(r.completados, []);
  assert.equal(r.removidos, 0);
});

test('o caso do lead 29012474: tool_use sem tool_result e a conversa seguiu -> resultado sintético logo depois da chamada', () => {
  const msgs = [h('Olá! Gostaria de saber mais'), aTool(), h('Outro ponto'), a('IA indisponível'), h('plano hapvida?')];
  const r = sanearHistorico(msgs);
  assert.deepEqual(tipos(r.messages), ['human', 'ai', 'tool', 'human', 'ai', 'human']);
  const sint = r.messages[2] as ToolMessage;
  assert.equal(sint.tool_call_id, ID);
  assert.equal(sint.name, 'aplicar_tag');
  assert.equal(sint.status, 'error');
  assert.equal(sint.content, TEXTO_FERRAMENTA_INTERROMPIDA);
  assert.deepEqual(r.completados, [ID]);
  assert.equal(msgs.length, 5, 'o array original não é alterado');
});

test('tool_use no fim do histórico (turno cortado antes da ferramenta) também é completado', () => {
  const r = sanearHistorico([h('oi'), aTool()]);
  assert.deepEqual(tipos(r.messages), ['human', 'ai', 'tool']);
});

test('duas chamadas na mesma resposta, só uma respondida: completa a que falta e mantém a existente', () => {
  const ai = new AIMessage({
    content: '',
    tool_calls: [
      { id: 'A', name: 'consultar_horarios', args: {}, type: 'tool_call' },
      { id: 'B', name: 'buscar_paciente', args: {}, type: 'tool_call' },
    ],
  });
  const r = sanearHistorico([h('oi'), ai, tRes('B'), h('e então?')]);
  assert.deepEqual(tipos(r.messages), ['human', 'ai', 'tool', 'tool', 'human']);
  assert.deepEqual(
    r.messages.slice(2, 4).map((m) => (m as ToolMessage).tool_call_id),
    ['B', 'A'],
  );
  assert.deepEqual(r.completados, ['A']);
});

test('resultado REAL separado da chamada por outra mensagem volta pra junto dela (não vira "interrompida")', () => {
  const real = tRes('A');
  const r = sanearHistorico([h('oi'), aTool('A'), h('mandei outra coisa'), real, a('pronto')]);
  assert.deepEqual(tipos(r.messages), ['human', 'ai', 'tool', 'human', 'ai']);
  assert.equal(r.messages[2], real);
  assert.deepEqual(r.completados, []);
  assert.equal(r.removidos, 0);
});

test('o texto sintético manda conferir antes de repetir (a ação pode ter sido feita)', () => {
  const r = sanearHistorico([h('oi'), aTool('A'), h('?')]);
  const txt = String((r.messages[2] as ToolMessage).content);
  assert.match(txt, /não se sabe se a ação chegou a ser feita/);
  assert.match(txt, /confira o estado real/);
});

test('resultado sem chamada antes é removido (a Anthropic também recusa tool_result solto)', () => {
  const r = sanearHistorico([h('oi'), a('olá'), tRes('fantasma'), h('oi de novo')]);
  assert.deepEqual(tipos(r.messages), ['human', 'ai', 'human']);
  assert.equal(r.removidos, 1);
});

test('resultado que não pertence à chamada anterior sai, e a chamada ganha o seu', () => {
  const r = sanearHistorico([h('oi'), aTool('A'), tRes('Z'), h('?')]);
  assert.deepEqual(tipos(r.messages), ['human', 'ai', 'tool', 'human']);
  assert.equal((r.messages[2] as ToolMessage).tool_call_id, 'A');
  assert.equal(r.removidos, 1);
  assert.deepEqual(r.completados, ['A']);
});

test('tool_use só no conteúdo (sem tool_calls) também conta', () => {
  const ai = new AIMessage({ content: [{ type: 'tool_use', id: 'C', name: 'x', input: {} }] });
  const r = sanearHistorico([h('oi'), ai, h('?')]);
  assert.deepEqual(r.completados, ['C']);
});

// ---- A prova de ponta a ponta: o corpo REAL que o ChatAnthropic manda, capturado antes de sair pela rede ----

async function corpoQueAAnthropicRecebe(msgs: BaseMessage[]): Promise<{ messages: Array<{ role: string; content: unknown }> }> {
  let corpo: { messages: Array<{ role: string; content: unknown }> } | null = null;
  const model = new ChatAnthropic({
    apiKey: 'sk-ant-teste',
    model: 'claude-sonnet-5',
    maxRetries: 0,
    clientOptions: {
      fetch: (async (_url: unknown, init: { body: string }) => {
        corpo = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
            content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as never,
    },
  });
  await model.invoke([new SystemMessage('sistema'), ...msgs]);
  assert.ok(corpo);
  return corpo;
}

/** A regra da Anthropic: todo tool_use do assistente tem o tool_result na mensagem de usuário IMEDIATAMENTE seguinte. */
function violacoesDeToolUse(corpo: { messages: Array<{ role: string; content: unknown }> }): string[] {
  const ruins: string[] = [];
  corpo.messages.forEach((m, i) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return;
    for (const b of m.content as Array<{ type: string; id?: string }>) {
      if (b.type !== 'tool_use') continue;
      const prox = corpo.messages[i + 1];
      const ok =
        prox?.role === 'user' &&
        Array.isArray(prox.content) &&
        (prox.content as Array<{ type: string; tool_use_id?: string }>).some((c) => c.type === 'tool_result' && c.tool_use_id === b.id);
      if (!ok) ruins.push(b.id!);
    }
  });
  return ruins;
}

test('REPRODUÇÃO: o histórico do lead 29012474, como está, manda tool_use sem tool_result para a Anthropic', async () => {
  const preso = [h('Olá! Gostaria de saber mais'), aTool(), h('Outro ponto'), a('⏱️ IA indisponível'), h('plano hapvida?')];
  const corpo = await corpoQueAAnthropicRecebe(preso);
  assert.deepEqual(violacoesDeToolUse(corpo), [ID], 'sem sanear, a Anthropic responderia 400');
});

test('CONSERTO: saneado, o corpo cumpre a regra e o resto da conversa segue na ordem', async () => {
  const preso = [h('Olá! Gostaria de saber mais'), aTool(), h('Outro ponto'), a('⏱️ IA indisponível'), h('plano hapvida?')];
  const corpo = await corpoQueAAnthropicRecebe(sanearHistorico(preso).messages);
  assert.deepEqual(violacoesDeToolUse(corpo), []);
  const textos = JSON.stringify(corpo.messages);
  assert.ok(textos.includes('plano hapvida?'));
  assert.ok(textos.includes('Outro ponto'));
});

// ---- Plano B: as ferramentas no formato da OpenAI ----

const ferramenta = () =>
  new DynamicStructuredTool({
    name: 'aplicar_tag',
    description: 'Aplica etiquetas no lead',
    schema: z.object({ tags: z.array(z.string()) }),
    func: async () => 'ok',
  });

async function corpoQueAOpenAIRecebe(montar: (tools: DynamicStructuredTool[]) => unknown[]): Promise<{ tools: Array<{ type?: string; function?: { name: string } }> }> {
  const tools = [ferramenta()];
  // Exatamente o que a unidade no Claude faz (limparSchemaDoModelo / aplicarStrictAnthropic, em graph.ts): grava no tool
  // extras.providerToolDefinition no formato da Anthropic. À mão aqui, pra o teste não carregar o grafo inteiro.
  for (const t of tools) {
    (t as { extras?: unknown }).extras = {
      providerToolDefinition: { name: t.name, description: t.description, input_schema: { type: 'object', properties: {} } },
    };
  }
  let corpo: { tools: Array<{ type?: string; function?: { name: string } }> } | null = null;
  const base = new ChatOpenAI({
    apiKey: 'sk-teste',
    model: 'gpt-4o',
    maxRetries: 0,
    configuration: {
      fetch: (async (_url: unknown, init: { body: string }) => {
        corpo = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            id: 'c1', object: 'chat.completion', created: 1, model: 'gpt-4o',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as never,
    },
  });
  const comTools = (base as unknown as { bindTools: (t: unknown[]) => { invoke: (m: BaseMessage[]) => Promise<unknown> } }).bindTools(montar(tools));
  await comTools.invoke([new SystemMessage('s'), h('oi')]);
  assert.ok(corpo);
  return corpo;
}

test('REPRODUÇÃO: bindTools com as ferramentas já preparadas pro Claude manda tools[0] sem type (o 400 do plano B)', async () => {
  const corpo = await corpoQueAOpenAIRecebe((tools) => tools);
  assert.equal(corpo.tools[0].type, undefined);
});

test('CONSERTO: toolsParaOpenAI manda type=function e o nome/esquema da ferramenta', async () => {
  const corpo = await corpoQueAOpenAIRecebe((tools) => toolsParaOpenAI(tools));
  assert.equal(corpo.tools[0].type, 'function');
  assert.equal(corpo.tools[0].function?.name, 'aplicar_tag');
  assert.ok(JSON.stringify(corpo.tools[0]).includes('tags'));
});

// ---- A origem: turno cortado entre o modelo e a ferramenta, e a próxima mensagem chega por cima ----

test('ORIGEM: turno cortado na ferramenta + mensagem nova no mesmo thread deixa tool_use órfão no checkpoint; o saneamento resolve', async () => {
  const { END, START, StateGraph, MessagesAnnotation, MemorySaver } = await import('@langchain/langgraph');
  const { ToolNode } = await import('@langchain/langgraph/prebuilt');

  let travar = true;
  const tag = new DynamicStructuredTool({
    name: 'aplicar_tag',
    description: 't',
    schema: z.object({ tags: z.array(z.string()) }),
    // 1ª vez: a ferramenta nunca volta (o deploy matou o processo aqui); depois funciona
    func: async () => (travar ? new Promise<string>(() => undefined) : 'ok'),
  });
  const agente = async (state: typeof MessagesAnnotation.State) => {
    const ultima = state.messages[state.messages.length - 1];
    if (ultima.getType() === 'human' && String(ultima.content).startsWith('Olá')) {
      return { messages: [new AIMessage({ content: '', tool_calls: [{ id: ID, name: 'aplicar_tag', args: { tags: ['x'] } }] })] };
    }
    return { messages: [new AIMessage('resposta')] };
  };
  const grafo = new StateGraph(MessagesAnnotation)
    .addNode('agent', agente)
    .addNode('tools', new ToolNode([tag]))
    .addEdge(START, 'agent')
    .addConditionalEdges(
      'agent',
      (s) => ((s.messages[s.messages.length - 1] as AIMessage).tool_calls?.length ? 'tools' : END),
      { tools: 'tools', [END]: END },
    )
    .addEdge('tools', 'agent')
    .compile({ checkpointer: new MemorySaver() });

  const cfg = { configurable: { thread_id: 'canaa-29012474' } };
  const corte = new AbortController();
  const turno1 = grafo.invoke({ messages: [new HumanMessage('Olá! Gostaria de saber mais')] }, { ...cfg, signal: corte.signal });
  setTimeout(() => corte.abort(), 100);
  await assert.rejects(turno1);

  travar = false;
  const fim = await grafo.invoke({ messages: [new HumanMessage('Gostaria de saber se vcs aceitam o plano hapvida')] }, cfg);

  // o histórico que o próximo agentNode receberia: tool_use (toolu_...) seguido de humano, sem tool_result
  assert.deepEqual(tipos(fim.messages).slice(0, 3), ['human', 'ai', 'human'], 'tool_use ficou órfão no checkpoint');
  const corpo = await corpoQueAAnthropicRecebe(fim.messages);
  assert.deepEqual(violacoesDeToolUse(corpo), [ID]);

  const sano = await corpoQueAAnthropicRecebe(sanearHistorico(fim.messages).messages);
  assert.deepEqual(violacoesDeToolUse(sano), []);
});
