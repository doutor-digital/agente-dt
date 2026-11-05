import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import { esconderLeadIdDoModelo, limparSchemaDoModelo } from './graph.js';
import { toolsParaOpenAI } from './tools-openai.js';
import { mensagensParaPlanoB } from './raciocinio-plano-b.js';

/**
 * O PEDIDO que sai de verdade para cada provedor, sem rede: o `fetch` do cliente HTTP é trocado e o corpo é guardado.
 * Prova o plano B de unidade de Claude (llm_calls: 182 × "400 Missing required parameter: 'tools[0].type'"): as ferramentas
 * que o principal prepara (extras.providerToolDefinition, formato Anthropic) não podem vazar para a OpenAI, e o prompt em
 * blocos com `cache_control` não pode chegar cru lá.
 */

type Corpo = {
  tools?: Array<Record<string, unknown>>;
  system?: unknown;
  messages: Array<{ role: string; content: unknown }>;
};

const ferramenta = () =>
  new DynamicStructuredTool({
    name: 'aplicar_tag',
    description: 'Aplica etiquetas no lead',
    schema: z.object({ leadId: z.number().int(), tags: z.array(z.string()), data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    func: async () => 'ok',
  });

/** As ferramentas exatamente como o buildAgentGraph as deixa para um principal Claude (sem o modo estrito). */
function ferramentasDoClaude(): DynamicStructuredTool[] {
  const tools = [ferramenta()];
  for (const t of tools) esconderLeadIdDoModelo(t);
  limparSchemaDoModelo(tools);
  return tools;
}

/** O histórico como o principal Claude o deixa: prompt em blocos com cache_control, resposta da IA com tool_use, tool, conversa marcada. */
function historicoDoClaude(): BaseMessage[] {
  return [
    new SystemMessage({
      content: [
        { type: 'text', text: 'PROMPT FIXO', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'PROMPT DO TURNO' },
      ],
    } as never),
    new HumanMessage('oi'),
    new AIMessage({
      content: [
        { type: 'text', text: 'vou etiquetar' },
        { type: 'tool_use', id: 'toolu_1', name: 'aplicar_tag', input: { tags: ['x'] } },
      ],
      tool_calls: [{ id: 'toolu_1', name: 'aplicar_tag', args: { tags: ['x'] }, type: 'tool_call' }],
    }),
    new ToolMessage({ tool_call_id: 'toolu_1', content: 'ok' }),
    new HumanMessage({ content: [{ type: 'text', text: 'e agora?', cache_control: { type: 'ephemeral' } }] } as never),
  ];
}

async function pedidoParaAOpenAI(tools: unknown[], messages: BaseMessage[]): Promise<Corpo> {
  let corpo: Corpo | null = null;
  const base = new ChatOpenAI({
    apiKey: 'sk-teste',
    model: 'gpt-4o-mini',
    maxRetries: 0,
    configuration: {
      fetch: (async (_url: unknown, init: { body: string }) => {
        corpo = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            id: 'c1', object: 'chat.completion', created: 1, model: 'gpt-4o-mini',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as never,
    },
  });
  const comTools = (base as unknown as { bindTools: (t: unknown[]) => { invoke: (m: BaseMessage[]) => Promise<unknown> } }).bindTools(tools);
  await comTools.invoke(messages);
  assert.ok(corpo);
  return corpo;
}

async function pedidoParaAAnthropic(tools: unknown[], messages: BaseMessage[]): Promise<Corpo> {
  let corpo: Corpo | null = null;
  const base = new ChatAnthropic({
    apiKey: 'sk-ant-teste',
    model: 'claude-sonnet-4-6',
    maxRetries: 0,
    clientOptions: {
      fetch: (async (_url: unknown, init: { body: string }) => {
        corpo = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as never,
    },
  });
  const comTools = (base as unknown as { bindTools: (t: unknown[]) => { invoke: (m: BaseMessage[]) => Promise<unknown> } }).bindTools(tools);
  await comTools.invoke(messages);
  assert.ok(corpo);
  return corpo;
}

test('PLANO B (OpenAI): toda ferramenta sai com type=function, mesmo depois do preparo do principal Claude', async () => {
  const tools = ferramentasDoClaude();
  // a pré-condição do bug: o principal deixou a definição no formato Anthropic em cada ferramenta
  assert.ok((tools[0] as { extras?: { providerToolDefinition?: unknown } }).extras?.providerToolDefinition);

  const corpo = await pedidoParaAOpenAI(toolsParaOpenAI(tools), mensagensParaPlanoB('openai', historicoDoClaude()));

  assert.equal(corpo.tools?.length, 1);
  for (const t of corpo.tools ?? []) {
    assert.equal(t.type, 'function');
    assert.equal((t.function as { name: string }).name, 'aplicar_tag');
    assert.equal('input_schema' in t, false, 'o formato da Anthropic não pode vazar');
  }
  // o leadId escondido do modelo continua escondido no plano B
  assert.ok(!JSON.stringify(corpo.tools).includes('leadId'));
});

test('PLANO B (OpenAI): sem passar por toolsParaOpenAI o pedido sai quebrado (a reprodução do 400)', async () => {
  const corpo = await pedidoParaAOpenAI(ferramentasDoClaude(), historicoDoClaude());
  assert.equal(corpo.tools?.[0]?.type, undefined);
});

test('PLANO B (OpenAI): nenhuma mensagem leva cache_control, e o prompt do sistema vira texto', async () => {
  const corpo = await pedidoParaAOpenAI(toolsParaOpenAI(ferramentasDoClaude()), mensagensParaPlanoB('openai', historicoDoClaude()));

  assert.ok(!JSON.stringify(corpo.messages).includes('cache_control'));
  assert.ok(!JSON.stringify(corpo.messages).includes('ttl'));
  assert.deepEqual(corpo.messages[0], { role: 'system', content: 'PROMPT FIXO\n\nPROMPT DO TURNO' });
  assert.deepEqual(corpo.messages.at(-1), { role: 'user', content: 'e agora?' });
  // a chamada de ferramenta do histórico segue no formato da OpenAI
  const ia = corpo.messages.find((m) => m.role === 'assistant') as unknown as { tool_calls: Array<{ type: string; id: string }> };
  assert.equal(ia.tool_calls[0]!.type, 'function');
  assert.equal(ia.tool_calls[0]!.id, 'toolu_1');
});

test('PLANO B: sem a limpeza o prompt em blocos chega na OpenAI com cache_control (a reprodução)', async () => {
  const corpo = await pedidoParaAOpenAI(toolsParaOpenAI(ferramentasDoClaude()), historicoDoClaude());
  assert.ok(JSON.stringify(corpo.messages[0]).includes('cache_control'));
});

test('mensagensParaPlanoB não altera as mensagens recebidas e devolve a mesma referência quando nada muda', () => {
  const hist = historicoDoClaude();
  const antes = JSON.stringify(hist);
  const saida = mensagensParaPlanoB('openai', hist);
  assert.equal(JSON.stringify(hist), antes, 'o principal manda as suas mensagens intactas');
  assert.equal(saida[1], hist[1], 'mensagem sem marca é a mesma referência');
  assert.equal(saida[3], hist[3]);
  assert.equal(saida.length, hist.length);
});

test('plano B na própria Anthropic: as mensagens vão como estão (a marca de cache vale lá)', () => {
  const hist = historicoDoClaude();
  assert.equal(mensagensParaPlanoB('anthropic', hist), hist);
});

test('CAMINHO CLAUDE (não mudou): schema limpo na ferramenta e prompt em blocos com cache_control', async () => {
  const tools = ferramentasDoClaude();
  const corpo = await pedidoParaAAnthropic(tools, historicoDoClaude());

  const t = corpo.tools?.[0] as { name: string; input_schema: Record<string, unknown>; type?: string };
  assert.equal(t.name, 'aplicar_tag');
  assert.ok(t.input_schema, 'a Anthropic recebe input_schema');
  assert.equal(t.type, undefined);
  const schema = JSON.stringify(t.input_schema);
  assert.ok(!schema.includes('$schema'), 'metadado inútil continua fora');
  assert.ok(!schema.includes('additionalProperties'));
  assert.ok(schema.includes('^\\\\d{4}-\\\\d{2}-\\\\d{2}$') || schema.includes('pattern'), 'pattern (instrução) continua');
  assert.ok(!schema.includes('leadId'));

  // o prompt segue em blocos e a marca de cache do prefixo continua lá
  const sistema = JSON.stringify(corpo.system);
  assert.ok(sistema.includes('cache_control'));
  assert.ok(sistema.includes('PROMPT FIXO') && sistema.includes('PROMPT DO TURNO'));
});

test('as ferramentas do principal NÃO são mutadas pelo plano B (providerToolDefinition continua para o Claude)', () => {
  const tools = ferramentasDoClaude();
  const antes = JSON.stringify((tools[0] as { extras?: unknown }).extras);
  toolsParaOpenAI(tools);
  assert.equal(JSON.stringify((tools[0] as { extras?: unknown }).extras), antes);
});
