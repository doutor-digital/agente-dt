// ============================================================================
// graph.ts — Grafo de decisão do agente (LangGraph, multi-tenant).
//
// LÓGICA DE ENGENHARIA — O FLUXO DO STATE
// ---------------------------------------
//
//                    ┌────────────────┐
//                    │   START        │
//                    └────────┬───────┘
//                             │ (State inicial:
//                             │  leadId, messages=[HumanMessage], traceId)
//                             ▼
//                    ┌────────────────┐
//                    │   agent (LLM)  │  ← chama OpenAI da Unit corrente
//                    └────────┬───────┘
//                             │ (LLM responde com:
//                             │   • tool_calls → vai pra tools
//                             │   • texto puro → vai pro END)
//                             ▼
//                    ┌────────────────┐
//                    │ shouldContinue?│
//                    └───┬────────┬───┘
//                  tools │        │ end
//                        ▼        ▼
//                   ┌─────────┐  END
//                   │  tools  │  ← executa tool no Kommo da Unit
//                   └────┬────┘
//                        └────────► agent (loop ReAct)
//
// MULTI-TENANT
// ------------
// `buildAgentGraph(recorder, unit)` recebe a Unit. Toda chamada de LLM e
// tool usa as credenciais da Unit. O `traceId` da execução fica no recorder
// pra que `invokeChatModel` consiga associar cada LlmCall ao trace correto.
//
// CHECKPOINTING / MEMÓRIA DE CONVERSA
// -----------------------------------
// `thread_id = "unit-{slug}-lead-{leadId}"` — separa histórico por Unit, pra
// que duas unidades nunca compartilhem memória de lead acidentalmente.
// ============================================================================

import { type AIMessage, type BaseMessage, SystemMessage } from '@langchain/core/messages';
import { END, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Unit } from '@prisma/client';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { AgentState, type AgentStateType } from './state.js';
import { buildTools } from './tools.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { TraceRecorder } from './trace-recorder.js';
import { getActiveConfig } from './config.js';
import { composeSystemPromptForUnit, composeSystemPromptPartsForUnit } from './prompt-composer.js';
import { createKommoClient } from '../services/kommo.service.js';
import { listEnabledLeadFieldRules } from '../services/lead-field-rules.service.js';
import { createChatModel, invokeChatModel } from '../services/openai.service.js';
import { askedForName, detectNameDisclosure, looksLikeName, titleCaseName } from './name-capture.js';

// ---------------------------------------------------------------------------
// Checkpointer (singleton).
// O PostgresSaver mantém um pool TCP próprio. Criamos UMA instância e
// reusamos. `setup()` cria as tabelas se ainda não existirem.
// ---------------------------------------------------------------------------

let checkpointerInstance: PostgresSaver | null = null;

export async function getCheckpointer(): Promise<PostgresSaver> {
  if (checkpointerInstance) return checkpointerInstance;
  const cp = PostgresSaver.fromConnString(env.DATABASE_URL);
  await cp.setup();
  checkpointerInstance = cp;
  logger.info('PostgresSaver pronto');
  return cp;
}

// ---------------------------------------------------------------------------
// Constrói o thread_id estável da Unit/Lead.
// Inclui slug pra evitar colisão entre unidades.
// ---------------------------------------------------------------------------
export function buildThreadId(unitSlug: string, leadId: string | number): string {
  return `unit-${unitSlug}-lead-${leadId}`;
}

/**
 * Extrai só o TEXTO visível da resposta do modelo. OpenAI/Claude devolvem
 * `content` como string; o Gemini devolve um ARRAY de partes. Sem isto, um
 * `JSON.stringify(content)` jogava o array cru (`[{"type":"text",...}]`) no
 * campo "Resposta da IA" e chegava ao paciente. Ignora partes de raciocínio
 * (`thought`) e chamadas de código, junta só o texto de fato.
 */
function aiTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          const o = p as Record<string, unknown>;
          if (o.thought) return '';
          if ('functionCall' in o || 'executableCode' in o || 'codeExecutionResult' in o) return '';
          if (typeof o.text === 'string') return o.text;
        }
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

// ---------------------------------------------------------------------------
// GEMINI — higieniza os schemas das tools.
//
// O Gemini rejeita (400 Bad Request) várias palavras de JSON-Schema que o Zod
// gera: `exclusiveMinimum` (de `.int().positive()`), `additionalProperties`,
// `$schema`, etc. OpenAI e Claude aceitam; o Gemini não. Como a validação REAL
// dos argumentos continua no `ToolNode(tools)` (Zod original), aqui a gente só
// simplifica o schema que o MODELO enxerga — sem perder segurança na execução.
// ---------------------------------------------------------------------------
const GEMINI_SCHEMA_STRIP = new Set([
  'exclusiveMinimum', 'exclusiveMaximum', 'minimum', 'maximum', 'multipleOf',
  '$schema', 'additionalProperties', 'default', 'const', 'patternProperties',
  'pattern', 'minLength', 'maxLength', 'format', 'minItems', 'maxItems',
  'minProperties', 'maxProperties',
]);
function stripGeminiUnsupported(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(stripGeminiUnsupported);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (GEMINI_SCHEMA_STRIP.has(k)) delete obj[k];
      else stripGeminiUnsupported(obj[k]);
    }
  }
}
function toolsParaGemini(tools: ReturnType<typeof buildTools>): unknown[] {
  return tools.map((t) => {
    let js: Record<string, unknown>;
    try {
      js = zodToJsonSchema(t.schema as never, { $refStrategy: 'none' }) as Record<string, unknown>;
    } catch {
      js = { type: 'object', properties: {} };
    }
    stripGeminiUnsupported(js);
    return { name: t.name, description: t.description, schema: js };
  });
}

// ---------------------------------------------------------------------------
// Construção do grafo.
//
// Recebe a `Unit` (credenciais + assistant_id + system prompt) e o
// `recorder` (vinculado ao ExecutionTrace). Retorna o grafo compilado
// pronto pra `invoke`.
// ---------------------------------------------------------------------------

export async function buildAgentGraph(recorder: TraceRecorder, unit: Unit) {
  const config = await getActiveConfig(unit.id);

  // 1) Tools com descriptions editadas pelo dashboard, instanciadas com o
  //    KommoClient da Unit.
  const toolConfigByName = new Map(config.tools.map((t) => [t.name, t]));
  const descriptionOverrides: Record<string, string> = {};
  for (const [name, cfg] of toolConfigByName) {
    if (cfg.description) descriptionOverrides[name] = cfg.description;
  }

  // Só monta o KommoClient se a Unit tiver credenciais. Se não tiver,
  // ainda dá pra rodar o agente em modo "só conversa" (sem tools Kommo).
  let kommoClient: ReturnType<typeof createKommoClient> | null = null;
  try {
    kommoClient = createKommoClient(unit);
  } catch (err) {
    logger.warn({ err, unit: unit.slug }, 'Unit sem credenciais Kommo — tools desabilitadas');
  }

  // Captura de dados — regras configuradas no painel "Capturas". Cada regra
  // ativa vira uma tool dinâmica que escreve em um custom field do Kommo.
  const leadFieldRules = await listEnabledLeadFieldRules(unit.id);

  const allTools = kommoClient
    ? buildTools({
        recorder,
        kommo: kommoClient,
        descriptionOverrides,
        pausedFieldId: unit.kommoPausedFieldId,
        leadFieldRules,
        unit,
      })
    : [];

  // Filtra tools desabilitadas no AgentConfig.
  const tools = allTools.filter((t) => {
    const cfg = toolConfigByName.get(t.name);
    return cfg ? cfg.enabled : true;
  });

  // 2) System prompt — montado dentro do agentNode em cada turno
  //    pra incorporar RAG (busca semântica baseada na mensagem do usuário).
  //    A montagem usa composer async que combina persona + features +
  //    templates + knowledge base + flagged examples.

  // 3) Modelo da Unit — OpenAI (padrão) ou Anthropic/Claude.
  const useAnthropic = unit.llmProvider === 'anthropic' && !!unit.anthropicApiKey;
  const useGoogle = unit.llmProvider === 'google' && !!unit.googleApiKey;
  const provider = useAnthropic ? 'anthropic' : useGoogle ? 'google' : 'openai';
  const modelName = useAnthropic
    ? unit.anthropicModel || 'claude-opus-4-8'
    : useGoogle
      ? unit.googleModel || 'gemini-2.5-flash'
      : config.model || unit.openaiModel || env.OPENAI_MODEL;
  const baseModel = createChatModel(unit, {
    model: modelName,
    // temperature só vai pro caminho OpenAI; ChatAnthropic (Opus 4.8) ignora.
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  });
  // bindTools retorna um Runnable, não ChatOpenAI — passamos via interface
  // mínima `InvokableModel` que `invokeChatModel` aceita.
  // Cast pra interface mínima — `bindTools` devolve um Runnable que não
  // bate com o tipo estrito do ChatOpenAI, mas a forma de `.invoke(messages, opts)`
  // é a mesma e é o que `invokeChatModel` precisa.
  // No Gemini, liga os schemas HIGIENIZADOS (sem exclusiveMinimum etc). A
  // execução segue no ToolNode(tools) com o Zod original — validação intacta.
  const toolsParaModelo = useGoogle ? toolsParaGemini(tools) : tools;
  const model = (
    tools.length > 0
      ? (baseModel as unknown as { bindTools: (t: unknown[]) => unknown }).bindTools(toolsParaModelo)
      : baseModel
  ) as unknown as Parameters<typeof invokeChatModel>[0]['model'];

  // -------------------------------------------------------------------------
  // NODE: agent
  // -------------------------------------------------------------------------
  const agentNode = async (state: AgentStateType) => {
    await recorder.step({
      kind: 'THINKING',
      title: 'IA analisando intenção',
      payload: { model: modelName, msgCount: state.messages.length, unit: unit.slug },
    });

    // SEMPRE usa o systemPrompt atual da Unit, NUNCA o que está no checkpoint.
    // Se o usuário edita o prompt no painel, queremos que a próxima execução
    // dessa Conversa já use a nova versão. Por isso filtramos qualquer
    // SystemMessage antiga que o PostgresSaver tenha persistido e prependamos
    // a atual. Sem isso, conversas existentes ficam presas no prompt antigo
    // pra sempre.
    //
    // Pega a última mensagem do paciente pra alimentar a busca semântica
    // (RAG) — assim o composer puxa só conhecimento relevante pra essa pergunta.
    const nonSystemMessages = state.messages.filter((m) => m.getType() !== 'system');
    const lastHuman = [...nonSystemMessages].reverse().find((m) => m.getType() === 'human');
    const userMessage = lastHuman
      ? typeof lastHuman.content === 'string'
        ? lastHuman.content
        : JSON.stringify(lastHuman.content)
      : undefined;
    // Primeiro turno = 1 única mensagem humana e nenhuma resposta da IA ainda.
    // Usado pra forçar saudação caprichada/coleta de nome na abertura.
    const humanCount = nonSystemMessages.filter((m) => m.getType() === 'human').length;
    const aiCount = nonSystemMessages.filter((m) => m.getType() === 'ai').length;
    const isFirstTurn = humanCount === 1 && aiCount === 0;

    // Tag de data de ENTRADA do lead (só unidades em ENTRY_DATE_TAG_SLUGS).
    // Roda uma vez, no 1º turno. Fire-and-forget (void) pra não somar latência
    // à resposta — a tag não é usada na geração.
    if (isFirstTurn && kommoClient && state.leadId && ENTRY_DATE_TAG_SLUGS.has(unit.slug)) {
      void maybeAddEntryDateTag({ recorder, kommo: kommoClient, leadId: state.leadId });
    }

    // workflowText foi aposentado em favor da aba "Ações" (UnitAction, tipada).
    // A coluna agent_configs.workflow ainda existe no DB mas não influencia
    // mais o prompt — recriar as regras na aba Ações se precisar.
    // Anthropic/Claude: system em 2 blocos com prompt caching — o estático
    // (persona, fontes, regras, ações) leva `cache_control` (TTL 1h) e é lido
    // a 0.1x em turnos seguintes; o volátil (memória, leadId, RAG) fica sem
    // cache. OpenAI: prompt único (string), sem caching manual.
    let systemMessage: SystemMessage;
    if (useAnthropic) {
      const { cacheable, dynamic } = await composeSystemPromptPartsForUnit({
        unit,
        agentConfigPrompt: config.systemPrompt,
        userMessage,
        isFirstTurn,
        leadId: state.leadId,
      });
      systemMessage = new SystemMessage({
        content: [
          { type: 'text', text: cacheable, cache_control: { type: 'ephemeral', ttl: '1h' } },
          ...(dynamic ? [{ type: 'text', text: dynamic }] : []),
        ],
      } as never);
    } else {
      const dynamicPrompt = await composeSystemPromptForUnit({
        unit,
        agentConfigPrompt: config.systemPrompt,
        userMessage,
        isFirstTurn,
        leadId: state.leadId,
      });
      systemMessage = new SystemMessage(dynamicPrompt);
    }
    const finalMessages: BaseMessage[] = [systemMessage, ...nonSystemMessages];

    const t0 = performance.now();
    const response = (await invokeChatModel({
      model,
      messages: finalMessages,
      unitId: unit.id,
      traceId: recorder.traceId,
      modelName,
      provider,
      tools,
    })) as AIMessage;
    const latency = Math.round(performance.now() - t0);

    const toolCalls = response.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const text = aiTextFromContent(response.content);
      await recorder.step({
        kind: 'THINKING',
        title: 'IA respondeu (sem tool call)',
        payload: { text },
        latencyMs: latency,
      });

      // Rede de segurança: se o usuário acabou de dizer o nome e a IA esqueceu
      // de chamar atualizar_titulo_lead, executa a tool nós mesmos. Idempotente
      // — só roda se o lead.name na Kommo ainda estiver genérico (sem o nome).
      if (kommoClient && unit.collectNameEnabled && userMessage && state.leadId) {
        // A IA pediu o nome no turno anterior? (habilita captura de nome "pelado")
        const lastAssistant = [...nonSystemMessages].reverse().find((m) => m.getType() === 'ai');
        const lastAssistantText = lastAssistant
          ? typeof lastAssistant.content === 'string'
            ? lastAssistant.content
            : JSON.stringify(lastAssistant.content)
          : null;
        const detected = detectNameDisclosure(userMessage, {
          nameWasAsked: askedForName(lastAssistantText),
        });
        if (detected) {
          await maybeAutoUpdateLeadTitle({
            recorder,
            kommo: kommoClient,
            leadId: state.leadId,
            name: detected,
          });
        }
      }

      return { messages: [response], decision: text } satisfies Partial<AgentStateType>;
    }

    return { messages: [response] } satisfies Partial<AgentStateType>;
  };

  // -------------------------------------------------------------------------
  // NODE: tools (ToolNode do LangGraph)
  // -------------------------------------------------------------------------
  const toolNode = new ToolNode(tools);

  // -------------------------------------------------------------------------
  // EDGE condicional: shouldContinue
  // -------------------------------------------------------------------------
  const shouldContinue = (state: AgentStateType): 'tools' | typeof END => {
    const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
    if (last && Array.isArray(last.tool_calls) && last.tool_calls.length > 0) {
      return 'tools';
    }
    return END;
  };

  // -------------------------------------------------------------------------
  // Montagem do grafo.
  // -------------------------------------------------------------------------
  const workflow = new StateGraph(AgentState)
    .addNode('agent', agentNode)
    .addNode('tools', toolNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', shouldContinue, {
      tools: 'tools',
      [END]: END,
    })
    .addEdge('tools', 'agent');

  const checkpointer = await getCheckpointer();
  const compiled = workflow.compile({ checkpointer });

  return compiled;
}

// ---------------------------------------------------------------------------
// Rede de segurança do "IA esqueceu de chamar a tool".
// A extração/validação de nome mora em ./name-capture.ts (módulo puro, testado).
// ---------------------------------------------------------------------------

/**
 * Se o lead.name no Kommo for genérico ("Lead #123", vazio, igual ao
 * contact name padrão do WhatsApp), atualiza pra `<Nome> DD/MM/YYYY`.
 * Caso contrário, no-op.
 */
async function maybeAutoUpdateLeadTitle({
  recorder,
  kommo,
  leadId,
  name,
}: {
  recorder: TraceRecorder;
  kommo: ReturnType<typeof createKommoClient>;
  leadId: number;
  name: string;
}): Promise<void> {
  const t0 = performance.now();
  // Trava final: mesmo que a detecção erre, não grava algo que não parece nome.
  if (!looksLikeName(name)) {
    await recorder.step({
      kind: 'THINKING',
      title: `[safety-net] "${name}" não parece nome — captura descartada`,
      payload: { leadId, rejeitado: name },
      latencyMs: Math.round(performance.now() - t0),
    });
    return;
  }
  const display = titleCaseName(name);
  try {
    const lead = await kommo.getLead(leadId);
    const current = (lead.name ?? '').trim();
    const looksGeneric =
      current.length === 0 ||
      /^lead\s*#?\d+$/i.test(current) ||
      // Se o nome já contém o que a IA captou, considera "já atualizado".
      current.toLowerCase().includes(display.toLowerCase());
    if (!looksGeneric) {
      await recorder.step({
        kind: 'KOMMO_ACTION',
        title: `[safety-net] título do lead já está como "${current}" — não sobrescreve`,
        payload: { leadId, current, detected: display },
        latencyMs: Math.round(performance.now() - t0),
      });
      return;
    }
    const createdAtMs = (lead.created_at ?? Math.floor(Date.now() / 1000)) * 1000;
    const dateBR = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(createdAtMs));
    const desired = `${display} ${dateBR}`;
    await kommo.updateLeadName(leadId, desired);
    await recorder.step({
      kind: 'KOMMO_ACTION',
      title: `[safety-net] IA esqueceu de chamar atualizar_titulo_lead — corrigido: "${current}" → "${desired}"`,
      payload: { leadId, previous: current, desired, name: display, dateBR },
      latencyMs: Math.round(performance.now() - t0),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recorder.step({
      kind: 'ERROR',
      title: `[safety-net] falha ao atualizar título automaticamente: ${msg}`,
      payload: { leadId, name: display, error: msg },
      latencyMs: Math.round(performance.now() - t0),
    });
  }
}

// Slugs das unidades que recebem a tag de data de entrada do lead. Mantido como
// lista explícita (pedido: "só a Magalhães") — adicionar outra unidade aqui.
const ENTRY_DATE_TAG_SLUGS = new Set(['advocacia-magalhaes']);

// Aplica no lead uma TAG com a data de ENTRADA (lead.created_at) no formato
// DD/MM/AA (ex: "01/01/26") — igual ao padrão de tags de data já usado na conta.
// Baseada em created_at → idempotente (mesma tag em toda execução; addTag no
// Kommo cria a tag se não existir e não duplica se já estiver no lead).
async function maybeAddEntryDateTag({
  recorder,
  kommo,
  leadId,
}: {
  recorder: TraceRecorder;
  kommo: ReturnType<typeof createKommoClient>;
  leadId: number;
}): Promise<void> {
  const t0 = performance.now();
  try {
    const lead = await kommo.getLead(leadId);
    const createdAtMs = (lead.created_at ?? Math.floor(Date.now() / 1000)) * 1000;
    const dateTag = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(createdAtMs)); // ex: "01/01/2026"
    await kommo.addTag({ leadId, tag: dateTag });
    await recorder.step({
      kind: 'KOMMO_ACTION',
      title: `tag de data de entrada aplicada: "${dateTag}"`,
      payload: { leadId, dateTag },
      latencyMs: Math.round(performance.now() - t0),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recorder.step({
      kind: 'ERROR',
      title: `falha ao aplicar tag de data de entrada: ${msg}`,
      payload: { leadId, error: msg },
      latencyMs: Math.round(performance.now() - t0),
    });
  }
}
