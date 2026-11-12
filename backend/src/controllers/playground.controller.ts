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
import { composeSystemPromptForUnit, sinalDaUnidade } from '../agent/prompt-composer.js';
import { leadFieldRuleDescription, leadFieldRuleSchema } from '../agent/tools.js';
import { listEnabledLeadFieldRules } from '../services/lead-field-rules.service.js';
import type { LeadFieldRule, Unit } from '@prisma/client';
import {
  calculateCost,
  createChatModel,
  invokeChatModel,
  resolveOpenAIApiKey,
} from '../services/openai.service.js';
import { logger } from '../lib/logger.js';
import { fusoDaUnidade } from '../lib/fuso.js';
import { textoDe } from '../agent/nome-na-resposta.js';

const SANDBOX_LEAD_ID = 999_000_001;

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(4000),
});

const runSchema = z.object({
  messages: z.array(messageSchema).min(1).max(40),
  /**
   * Texto-base SÓ PARA ESTE TESTE (nada é gravado). Vira a base do prompt desta chamada em qualquer unidade: entra no
   * lugar de `units.system_prompt` E o prompt do AgentConfig sai, como se o piloto `prompt-da-unidade` estivesse ligado
   * (sem isso, fora do piloto, o AgentConfig venceria e o teste rodaria outro texto calado — ver `escolherBase`).
   * Só SUPER_ADMIN. Serve para testar um prompt novo antes de publicar (Sofia 2.0).
   */
  unitSystemPrompt: z.string().min(1).max(60_000).optional(),
});

interface SandboxAction {
  tool: string;
  args: Record<string, unknown>;
  result: string;
}

type TimelineEvent =
  | { kind: 'user_message'; ts: number; content: string }
  | {
      kind: 'thinking';
      ts: number;
      durationMs: number;
      model: string;
      iteration: number;
      tokens?: { prompt: number; completion: number; total: number };
      costUsd?: number;
    }
  | {
      kind: 'tool_call';
      ts: number;
      tool: string;
      args: Record<string, unknown>;
      result: string;
    }
  | { kind: 'assistant_message'; ts: number; content: string };

interface AIMessageLike {
  content: unknown;
  tool_calls?: Array<{ id?: string; name: string; args?: Record<string, unknown> }>;
  usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  response_metadata?: { tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } };
}

function extractUsage(ai: AIMessageLike): { prompt: number; completion: number; total: number } | null {
  const u = ai.usage_metadata;
  if (u && (u.input_tokens || u.output_tokens || u.total_tokens)) {
    const prompt = u.input_tokens ?? 0;
    const completion = u.output_tokens ?? 0;
    const total = u.total_tokens ?? prompt + completion;
    return { prompt, completion, total };
  }
  const t = ai.response_metadata?.tokenUsage;
  if (t && (t.promptTokens || t.completionTokens || t.totalTokens)) {
    const prompt = t.promptTokens ?? 0;
    const completion = t.completionTokens ?? 0;
    const total = t.totalTokens ?? prompt + completion;
    return { prompt, completion, total };
  }
  return null;
}

function buildSandboxTools(opts: {
  onCall: (a: SandboxAction) => void;
  leadFieldRules: LeadFieldRule[];
  tz: string;
  /** a unidade usa o sinal por Pix (`sinalDaUnidade`): só então o sandbox ganha `gerar_sinal_pix`, como em produção */
  comSinal?: boolean;
}) {
  const aplicar_tag = new DynamicStructuredTool({
    name: 'aplicar_tag',
    description:
      'Aplica uma OU várias tags ao lead no Kommo (sandbox: simulado). Use `tags: [...]` pra múltiplas numa só chamada.',
    schema: zod.object({
      leadId: zod.number().int().positive(),
      tag: zod.string().min(1).max(50).optional(),
      tags: zod.array(zod.string().min(1).max(50)).min(1).max(15).optional(),
    }),
    func: async ({ leadId, tag, tags }) => {
      const list = [
        ...(tag ? [tag] : []),
        ...(Array.isArray(tags) ? tags : []),
      ].filter((t): t is string => !!t);
      const label = list.length === 1 ? `"${list[0]}"` : `[${list.map((t) => `"${t}"`).join(', ')}]`;
      const result = `[SANDBOX] aplicar_tag(${label}) no lead ${leadId} — simulado.`;
      opts.onCall({ tool: 'aplicar_tag', args: { leadId, tags: list }, result });
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
      nomeDeOutraPessoa: zod.boolean().optional(),
    }),
    func: async ({ leadId, nome, nomeDeOutraPessoa }) => {
      const dateBR = new Intl.DateTimeFormat('pt-BR', {
        timeZone: opts.tz,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).format(new Date());
      const desired = `${nome.trim()} ${dateBR}`;
      const contato = nomeDeOutraPessoa ? 'contato não muda (nome de outra pessoa)' : `contato iria para "${nome.trim()}" se a automação nome-no-contato estiver ligada`;
      const result = `[SANDBOX] atualizar_titulo_lead("${nome}") → título seria "${desired}" no lead ${leadId}; ${contato} — simulado.`;
      opts.onCall({ tool: 'atualizar_titulo_lead', args: { leadId, nome, nomeDeOutraPessoa, formatted: desired }, result });
      return result;
    },
  });

  const resumir_lead_para_sdr = new DynamicStructuredTool({
    name: 'resumir_lead_para_sdr',
    description:
      'Gera resumo da conversa pra o SDR humano e posta como nota interna + ' +
      'grava em campo custom se configurado (sandbox: simulado, não chama LLM).',
    schema: zod.object({
      leadId: zod.number().int().positive(),
      focusHint: zod.string().max(400).optional(),
    }),
    func: async ({ leadId, focusHint }) => {
      const result = `[SANDBOX] resumir_lead_para_sdr(lead ${leadId}${focusHint ? `, foco: "${focusHint}"` : ''}) → em prod isto chamaria o LLM, postaria nota interna e gravaria no campo "Observações" — simulado.`;
      opts.onCall({
        tool: 'resumir_lead_para_sdr',
        args: { leadId, focusHint: focusHint ?? null },
        result,
      });
      return result;
    },
  });

  // Agenda em sandbox. Sem estas, a IA no playground NÃO TEM como marcar consulta —
  // e o teste dá falso negativo: ela transfere porque não existe ferramenta, não
  // porque decidiu transferir. Foi justamente decidir transferir o defeito que a
  // gente precisa conseguir enxergar aqui (Porto, 26/08: 82 handoffs contra 39
  // agendamentos em 30 dias). Os dados são fictícios e nada chega na franquia.
  const AGENDA_FICTICIA = ['09:00', '10:00', '14:30', '16:00'];
  const ID_CLIENT_FICTICIO = 999001;

  const consultar_horarios = new DynamicStructuredTool({
    name: 'consultar_horarios',
    description: 'Lê os horários livres da agenda da clínica numa data (sandbox: agenda fictícia).',
    schema: zod.object({ data: zod.string().min(8).max(10) }),
    func: async ({ data }) => {
      const result = `[SANDBOX] consultar_horarios(${data}) → livres: ${AGENDA_FICTICIA.join(', ')} — agenda fictícia.`;
      opts.onCall({ tool: 'consultar_horarios', args: { data }, result });
      return result;
    },
  });

  const buscar_paciente = new DynamicStructuredTool({
    name: 'buscar_paciente',
    description: 'Procura o cadastro do paciente no CRM da franquia (sandbox: simulado).',
    schema: zod.object({ nome: zod.string().min(2).max(120) }),
    func: async ({ nome }) => {
      // Sempre "não encontrado": é o caso da maioria (paciente novo) e o que
      // levava a IA a transferir em vez de cadastrar.
      const result = `[SANDBOX] buscar_paciente("${nome}") → nenhum cadastro encontrado. Paciente novo: use cadastrar_paciente.`;
      opts.onCall({ tool: 'buscar_paciente', args: { nome }, result });
      return result;
    },
  });

  const cadastrar_paciente = new DynamicStructuredTool({
    name: 'cadastrar_paciente',
    description: 'Cria o cadastro do paciente na franquia e devolve o idClient (sandbox: simulado).',
    schema: zod.object({
      nome: zod.string().min(2).max(120),
      telefone: zod.string().min(8).max(20).optional(),
    }),
    func: async ({ nome, telefone }) => {
      const partes = nome.trim().split(/\s+/).filter((p) => p.length >= 2);
      if (partes.length < 2) {
        const erro = `[SANDBOX] cadastrar_paciente recusou: "${nome}" está sem sobrenome. Peça o nome completo ao paciente.`;
        opts.onCall({ tool: 'cadastrar_paciente', args: { nome, telefone }, result: erro });
        return erro;
      }
      const result = `[SANDBOX] cadastrar_paciente("${nome}") → idClient ${ID_CLIENT_FICTICIO} — simulado.`;
      opts.onCall({ tool: 'cadastrar_paciente', args: { nome, telefone }, result });
      return result;
    },
  });

  const agendar_consulta = new DynamicStructuredTool({
    name: 'agendar_consulta',
    description: 'Marca a consulta na agenda da franquia (sandbox: simulado).',
    schema: zod.object({
      idClient: zod.number().int().positive(),
      data: zod.string().min(8).max(10),
      hora: zod.string().min(4).max(8),
      leadId: zod.number().int().positive().optional(),
    }),
    func: async ({ idClient, data, hora, leadId }) => {
      const livre = AGENDA_FICTICIA.some((h) => hora.startsWith(h.slice(0, 2)));
      const result = livre
        ? `[SANDBOX] agendar_consulta(${data} ${hora}) → CONSULTA MARCADA para o idClient ${idClient} — simulado.`
        : `[SANDBOX] agendar_consulta(${data} ${hora}) recusou: horário não está livre. Consulte de novo e ofereça outro.`;
      opts.onCall({ tool: 'agendar_consulta', args: { idClient, data, hora, leadId }, result });
      return result;
    },
  });

  // Sofia 2.0 (sinal por Pix): em produção só existe na unidade com sinal e cria um link no Asaas; aqui devolve um link de exemplo, sem chamar o Asaas.
  const gerar_sinal_pix = new DynamicStructuredTool({
    name: 'gerar_sinal_pix',
    description: 'Gera o Pix do sinal (link do Asaas) depois de agendar_consulta (sandbox: link de exemplo, nada é criado).',
    schema: zod.object({ leadId: zod.number().int().positive().optional() }),
    func: async ({ leadId }) => {
      const result = '[SANDBOX] gerar_sinal_pix → Pix do sinal gerado. Envie ao paciente ESTE link, copiado exatamente: https://www.asaas.com/c/exemplo-sandbox — link de exemplo, nada foi criado.';
      opts.onCall({ tool: 'gerar_sinal_pix', args: { leadId: leadId ?? null }, result });
      return result;
    },
  });

  const remarcar_consulta = new DynamicStructuredTool({
    name: 'remarcar_consulta',
    description: 'Move a consulta do paciente para outro horário (sandbox: simulado).',
    schema: zod.object({
      idSchedule: zod.number().int().positive().optional(),
      idClient: zod.number().int().positive().optional(),
      data: zod.string().min(8).max(10),
      hora: zod.string().min(4).max(8),
    }),
    func: async (args) => {
      const result = `[SANDBOX] remarcar_consulta → nova data ${args.data} ${args.hora} — simulado.`;
      opts.onCall({ tool: 'remarcar_consulta', args, result });
      return result;
    },
  });

  const cancelar_consulta = new DynamicStructuredTool({
    name: 'cancelar_consulta',
    description: 'Cancela a consulta do paciente na agenda (sandbox: simulado).',
    schema: zod.object({
      idSchedule: zod.number().int().positive().optional(),
      idClient: zod.number().int().positive().optional(),
      motivo: zod.string().max(200).optional(),
    }),
    func: async (args) => {
      const result = `[SANDBOX] cancelar_consulta → cancelada${args.motivo ? ` (motivo: ${args.motivo})` : ''} — simulado.`;
      opts.onCall({ tool: 'cancelar_consulta', args, result });
      return result;
    },
  });

  const captura = opts.leadFieldRules.map(
    (rule) =>
      new DynamicStructuredTool({
        name: rule.toolName,
        description: `${leadFieldRuleDescription(rule)} (sandbox: não grava no Kommo)`,
        schema: leadFieldRuleSchema(rule),
        func: async (args: Record<string, unknown>) => {
          const value = rule.kommoFieldType === 'multiselect' ? args.values : args.value;
          const shown = Array.isArray(value) ? value.join(', ') : String(value ?? '');
          const result = `[SANDBOX] ${rule.toolName} → "${rule.kommoFieldName}" = "${shown}" — simulado, nada gravado no Kommo.`;
          opts.onCall({
            tool: rule.toolName,
            args: { ...args, fieldName: rule.kommoFieldName, fieldType: rule.kommoFieldType },
            result,
          });
          return result;
        },
      }),
  );

  return [
    aplicar_tag,
    mover_etapa,
    pausar_ia,
    atualizar_titulo_lead,
    consultar_horarios,
    buscar_paciente,
    cadastrar_paciente,
    agendar_consulta,
    ...(opts.comSinal ? [gerar_sinal_pix] : []),
    remarcar_consulta,
    cancelar_consulta,
    resumir_lead_para_sdr,
    ...captura,
  ];
}

export type ResultadoDoTeste =
  | {
      ok: true;
      reply: string;
      actions: SandboxAction[];
      timeline: TimelineEvent[];
      meta: {
        base: 'teste' | 'vivo';
        model: string;
        iterations: number;
        totalLatencyMs: number;
        tokens: { prompt: number; completion: number; total: number } | null;
        costUsd: number | null;
      };
    }
  | { ok: false; status: number; error: string; message?: string };

/**
 * Um turno da Sofia em sandbox (tools simuladas, nada gravado). Serve ao playground do painel e à prévia da página
 * `/aprendizados/:slug`. `promptDeTeste` troca o texto-base (o chamador confere que é super admin);
 * `aprendizadosExtras` soma regras ao bloco `<aprendizados>` só nesta chamada.
 */
export async function rodarTesteDaSofia(
  unitDoBanco: Unit,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  opts: {
    promptDeTeste?: string;
    aprendizadosExtras?: string[];
    /** Recebe o texto COMPLETO do prompt desta chamada, logo antes da 1ª chamada ao modelo: a conversa pública da página usa para barrar eco do prompt na resposta. */
    aoMontarPrompt?: (promptCompleto: string) => void;
  } = {},
): Promise<ResultadoDoTeste> {
  const promptDeTeste = opts.promptDeTeste;
  // prompt de teste: vale só para esta chamada, a unidade no banco não muda
  const unit = promptDeTeste ? { ...unitDoBanco, systemPrompt: promptDeTeste } : unitDoBanco;
  const useAnthropic = unit.llmProvider === 'anthropic' && !!unit.anthropicApiKey;
  const useGoogle = unit.llmProvider === 'google' && !!unit.googleApiKey;
  if (!useAnthropic && !useGoogle && !resolveOpenAIApiKey(unit)) {
    return { ok: false, status: 400, error: 'openai_not_configured' };
  }

  const config = await getActiveConfig(unit.id);

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const userCount = messages.filter((m) => m.role === 'user').length;
  const assistantCount = messages.filter((m) => m.role === 'assistant').length;
  const isFirstTurn = userCount === 1 && assistantCount === 0;
  const systemPrompt = await composeSystemPromptForUnit({
    unit,
    // com prompt de teste, o do AgentConfig sai: assim o teste é a base em qualquer unidade (dentro ou fora do piloto)
    agentConfigPrompt: promptDeTeste ? undefined : config.systemPrompt,
    userMessage: lastUser?.content,
    isFirstTurn,
    excludeLeadFieldRules: false,
    aprendizadosExtras: opts.aprendizadosExtras,
  });
  const sandboxPreamble = `# CONTEXTO DE TESTE
Você está rodando em MODO SANDBOX. O leadId atual é ${SANDBOX_LEAD_ID}. Trate
como uma conversa real e use as tools normalmente quando fizer sentido — elas
não vão alterar o CRM, mas suas chamadas serão mostradas como decisões pro
operador revisar.`;
  const fullSystem = `${systemPrompt}\n\n${sandboxPreamble}`;

  const actions: SandboxAction[] = [];
  const timeline: TimelineEvent[] = [];
  if (lastUser) {
    timeline.push({ kind: 'user_message', ts: Date.now(), content: lastUser.content });
  }
  const leadFieldRules = await listEnabledLeadFieldRules(unit.id, unit.slug);
  const tools = buildSandboxTools({
    leadFieldRules,
    tz: fusoDaUnidade(unit),
    comSinal: sinalDaUnidade(unit) !== null,
    onCall: (a) => {
      actions.push(a);
      timeline.push({
        kind: 'tool_call',
        ts: Date.now(),
        tool: a.tool,
        args: a.args,
        result: a.result,
      });
    },
  });

  const modelName = useAnthropic
    ? unit.anthropicModel || 'claude-opus-4-8'
    : useGoogle
      ? unit.googleModel || 'gemini-2.5-flash'
      : config.model || unit.openaiModel;
  const baseModel = createChatModel(unit, {
    model: modelName,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  });
  const model = (
    baseModel as unknown as { bindTools: (t: unknown[]) => unknown }
  ).bindTools(tools) as unknown as Parameters<typeof invokeChatModel>[0]['model'];

  const history: BaseMessage[] = [new SystemMessage(fullSystem)];
  for (const m of messages) {
    if (m.role === 'user') history.push(new HumanMessage(m.content));
    else history.push(new AIMessage(m.content));
  }

  // O modelo é chamado a partir daqui: erro antes (regras de campo, criação do modelo) não custou nada, e quem chamou pode devolver a cota.
  opts.aoMontarPrompt?.(fullSystem);

  const MAX_ITERS = 5;
  let finalReply = '';
  let iterations = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCostUsd = 0;
  const turnStart = performance.now();
  try {
    for (let i = 0; i < MAX_ITERS; i++) {
      const iterStart = performance.now();
      const ai = (await invokeChatModel({
        model,
        messages: history,
        unitId: unit.id,
        traceId: null,
        modelName,
        tools,
      })) as AIMessage & AIMessageLike;
      const iterMs = Math.round(performance.now() - iterStart);
      iterations++;

      const usage = extractUsage(ai);
      const costUsd = usage ? calculateCost(modelName, usage.prompt, usage.completion) : undefined;
      if (usage) {
        totalPromptTokens += usage.prompt;
        totalCompletionTokens += usage.completion;
      }
      if (costUsd) totalCostUsd += costUsd;

      timeline.push({
        kind: 'thinking',
        ts: Date.now(),
        durationMs: iterMs,
        model: modelName,
        iteration: i + 1,
        tokens: usage ?? undefined,
        costUsd,
      });

      history.push(ai);
      const toolCalls = ai.tool_calls ?? [];

      if (toolCalls.length === 0) {
        finalReply = textoDe(ai.content);
        timeline.push({ kind: 'assistant_message', ts: Date.now(), content: finalReply });
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
        const invoker = tool as unknown as { invoke: (args: unknown) => Promise<string> };
        const result = await invoker.invoke(tc.args ?? {});
        history.push(new ToolMessage({ tool_call_id: tc.id ?? '', content: result }));
      }
    }

    if (!finalReply) {
      finalReply =
        '(A IA esgotou o limite de 5 chamadas de tool sem responder em texto. Verifique o prompt.)';
      timeline.push({ kind: 'assistant_message', ts: Date.now(), content: finalReply });
    }

    const totalLatencyMs = Math.round(performance.now() - turnStart);
    return {
      ok: true,
      reply: finalReply,
      actions,
      timeline,
      meta: {
        /** 'teste' = o texto-base desta chamada foi o `unitSystemPrompt` recebido; 'vivo' = o de produção */
        base: promptDeTeste ? 'teste' : 'vivo',
        model: modelName,
        iterations,
        totalLatencyMs,
        tokens:
          totalPromptTokens || totalCompletionTokens
            ? {
                prompt: totalPromptTokens,
                completion: totalCompletionTokens,
                total: totalPromptTokens + totalCompletionTokens,
              }
            : null,
        costUsd: totalCostUsd > 0 ? Math.round(totalCostUsd * 1_000_000) / 1_000_000 : null,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, unitId: unit.id }, 'playground falhou');
    return { ok: false, status: 500, error: 'playground_failed', message: msg };
  }
}


export async function playgroundRunHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', issues: parsed.error.flatten() });
    return;
  }

  const promptDeTeste = parsed.data.unitSystemPrompt;
  // troca as instruções inteiras e roda na chave do modelo da clínica: só o super admin
  if (promptDeTeste && req.user?.role !== 'SUPER_ADMIN') {
    res.status(403).json({ error: 'prompt_de_teste_so_admin' });
    return;
  }
  const unitDoBanco = await prisma.unit.findUnique({ where: { id: unitId } });
  if (!unitDoBanco) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  const r = await rodarTesteDaSofia(unitDoBanco, parsed.data.messages, { promptDeTeste });
  if (!r.ok) {
    res.status(r.status).json(r.message ? { error: r.error, message: r.message } : { error: r.error });
    return;
  }
  const { ok: _ok, ...corpo } = r;
  res.json(corpo);
}
