// ============================================================================
// playground.controller.ts — Endpoint sandbox pra testar a IA dentro do painel.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Roda a IA com o systemPrompt REAL da Unit (com todas as features ativadas
// no Wizard) mas SEM tocar no Kommo nem persistir nada no banco.
//
// Diferenças do agent/graph.ts:
//   - Sem PostgresSaver (sem thread_id, histórico vive na request).
//   - Tools são instrumentadas mas NÃO chamam o Kommo — devolvem string
//     simulada e a chamada é capturada na lista `actions` retornada.
//   - Sem ExecutionTrace, sem TraceRecorder.
//   - LlmCall ainda é gravado (útil pra observar custo do teste).
//
// Loop ReAct manual: chama o modelo, se houver tool_calls executa as fakes,
// adiciona ToolMessages e re-invoca. Máximo de 5 iterações pra não loopar.
// ============================================================================

import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z as zod } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getActiveConfig } from '../agent/config.js';
import { composeSystemPromptForUnit } from '../agent/prompt-composer.js';
import { createChatOpenAI, invokeChatModel } from '../services/openai.service.js';
import { logger } from '../lib/logger.js';

// Lead ID sintético — fica no histórico/payload mas nunca chega no Kommo.
const SANDBOX_LEAD_ID = 999_000_001;

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(4000),
});

const runSchema = z.object({
  messages: z.array(messageSchema).min(1).max(40),
});

interface SandboxAction {
  tool: string;
  args: Record<string, unknown>;
  result: string;
}

function buildSandboxTools(opts: { onCall: (a: SandboxAction) => void }) {
  const aplicar_tag = new DynamicStructuredTool({
    name: 'aplicar_tag',
    description:
      'Aplica uma tag ao lead no Kommo (sandbox: simulado, não chama o CRM).',
    schema: zod.object({
      leadId: zod.number().int().positive(),
      tag: zod.string().min(1).max(50),
    }),
    func: async ({ leadId, tag }) => {
      const result = `[SANDBOX] aplicar_tag("${tag}") no lead ${leadId} — simulado.`;
      opts.onCall({ tool: 'aplicar_tag', args: { leadId, tag }, result });
      return result;
    },
  });

  const mover_etapa = new DynamicStructuredTool({
    name: 'mover_etapa',
    description: 'Move o lead para outra etapa do funil (sandbox: simulado).',
    schema: zod.object({
      leadId: zod.number().int().positive(),
      statusId: zod.number().int().positive(),
      pipelineId: zod.number().int().positive().optional(),
    }),
    func: async ({ leadId, statusId, pipelineId }) => {
      const result = `[SANDBOX] mover_etapa(${statusId}) no lead ${leadId} — simulado.`;
      opts.onCall({ tool: 'mover_etapa', args: { leadId, statusId, pipelineId }, result });
      return result;
    },
  });

  const pausar_ia = new DynamicStructuredTool({
    name: 'pausar_ia',
    description: 'Pausa a IA neste lead (sandbox: simulado).',
    schema: zod.object({
      leadId: zod.number().int().positive(),
      motivo: zod.string().min(1).max(200),
    }),
    func: async ({ leadId, motivo }) => {
      const result = `[SANDBOX] pausar_ia(${motivo}) no lead ${leadId} — simulado.`;
      opts.onCall({ tool: 'pausar_ia', args: { leadId, motivo }, result });
      return result;
    },
  });

  const atualizar_titulo_lead = new DynamicStructuredTool({
    name: 'atualizar_titulo_lead',
    description: 'Atualiza o título (nome) do lead no Kommo (sandbox: simulado).',
    schema: zod.object({
      leadId: zod.number().int().positive(),
      nome: zod.string().min(1).max(120),
    }),
    func: async ({ leadId, nome }) => {
      const result = `[SANDBOX] atualizar_titulo_lead("${nome}") no lead ${leadId} — simulado.`;
      opts.onCall({ tool: 'atualizar_titulo_lead', args: { leadId, nome }, result });
      return result;
    },
  });

  return [aplicar_tag, mover_etapa, pausar_ia, atualizar_titulo_lead];
}

export async function playgroundRunHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', issues: parsed.error.flatten() });
    return;
  }

  const unit = await prisma.unit.findUnique({ where: { id: unitId } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  if (!unit.openaiApiKey) {
    res.status(400).json({ error: 'openai_not_configured' });
    return;
  }

  const config = await getActiveConfig(unit.id);

  // Última mensagem do usuário alimenta a busca semântica do RAG.
  const lastUser = [...parsed.data.messages].reverse().find((m) => m.role === 'user');
  // Primeiro turno = só 1 mensagem do user e nenhuma da IA no histórico.
  const userCount = parsed.data.messages.filter((m) => m.role === 'user').length;
  const assistantCount = parsed.data.messages.filter((m) => m.role === 'assistant').length;
  const isFirstTurn = userCount === 1 && assistantCount === 0;
  const systemPrompt = await composeSystemPromptForUnit({
    unit,
    agentConfigPrompt: config.systemPrompt,
    userMessage: lastUser?.content,
    isFirstTurn,
  });

  // Acrescenta info do "lead sintético" pra IA poder chamar as tools (precisa do leadId).
  const sandboxPreamble = `# CONTEXTO DE TESTE
Você está rodando em MODO SANDBOX. O leadId atual é ${SANDBOX_LEAD_ID}. Trate
como uma conversa real e use as tools normalmente quando fizer sentido — elas
não vão alterar o CRM, mas suas chamadas serão mostradas como decisões pro
operador revisar.`;
  const fullSystem = `${systemPrompt}\n\n${sandboxPreamble}`;

  const actions: SandboxAction[] = [];
  const tools = buildSandboxTools({ onCall: (a) => actions.push(a) });

  const modelName = config.model || unit.openaiModel;
  const baseModel = createChatOpenAI(unit, {
    model: modelName,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  });
  const model = baseModel.bindTools(tools) as unknown as Parameters<typeof invokeChatModel>[0]['model'];

  const history: BaseMessage[] = [new SystemMessage(fullSystem)];
  for (const m of parsed.data.messages) {
    if (m.role === 'user') history.push(new HumanMessage(m.content));
    else history.push(new AIMessage(m.content));
  }

  // Loop ReAct manual. Máximo 5 voltas pra não rodar infinito se a IA insistir.
  const MAX_ITERS = 5;
  let finalReply = '';
  try {
    for (let i = 0; i < MAX_ITERS; i++) {
      const ai = (await invokeChatModel({
        model,
        messages: history,
        unitId: unit.id,
        traceId: null,
        modelName,
        tools,
      })) as AIMessage;

      history.push(ai);
      const toolCalls = ai.tool_calls ?? [];

      if (toolCalls.length === 0) {
        finalReply = typeof ai.content === 'string' ? ai.content : JSON.stringify(ai.content);
        break;
      }

      for (const tc of toolCalls) {
        const tool = tools.find((t) => t.name === tc.name);
        if (!tool) {
          history.push(
            new ToolMessage({
              tool_call_id: tc.id ?? '',
              content: `ERRO: tool ${tc.name} não existe em sandbox.`,
            }),
          );
          continue;
        }
        // Cada DynamicStructuredTool da union tem signature de schema próprio —
        // o TS rejeita o `.invoke` polimórfico. Cast pro shape mínimo necessário.
        const invoker = tool as unknown as { invoke: (args: unknown) => Promise<string> };
        const result = await invoker.invoke(tc.args ?? {});
        history.push(new ToolMessage({ tool_call_id: tc.id ?? '', content: result }));
      }
    }

    if (!finalReply) {
      finalReply =
        '(A IA esgotou o limite de 5 chamadas de tool sem responder em texto. Verifique o prompt.)';
    }

    res.json({ reply: finalReply, actions });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, unitId }, 'playground falhou');
    res.status(500).json({ error: 'playground_failed', message: msg });
  }
}
