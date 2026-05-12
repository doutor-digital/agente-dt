// ============================================================================
// tools.ts — Tools do agente (Zod + DynamicStructuredTool).
//
// LÓGICA DE ENGENHARIA
// --------------------
// As Tools são a interface entre a LLM e o mundo real. Cada Tool tem:
//   1. Um SCHEMA Zod, que o LangChain converte automaticamente para o
//      formato de tool-calling esperado pela Anthropic. A LLM "vê" apenas
//      o schema — ela nunca lê o código de execução.
//   2. Uma DESCRIÇÃO em linguagem natural. ESSA descrição é o que
//      determina QUANDO a LLM decide chamar a tool. Vale ouro: descreva
//      o caso de uso, não a implementação.
//   3. Uma FUNÇÃO de execução, que aqui delega para `KommoService`.
//
// Por que NÃO colocamos chamadas axios direto aqui?
// Porque o LangGraph fica acoplado ao Kommo. Mantendo o `KommoService`
// como a camada HTTP pura, podemos trocar Kommo por HubSpot amanhã
// reescrevendo só o service. As tools continuam idênticas (do ponto de
// vista da LLM) — só mudamos o que está atrás delas.
//
// Por que usamos `DynamicStructuredTool` e não a função `tool(...)` nova?
// Ambos funcionam; usamos a versão `DynamicStructuredTool` porque ela
// expõe um construtor explícito que combina melhor com TypeScript estrito.
// ============================================================================

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { KommoService } from '../services/kommo.service.js';
import type { TraceRecorder } from './trace-recorder.js';

// ---------------------------------------------------------------------------
// Descrições default das tools — também é a fonte de verdade pro seed do
// AgentConfig. Mantemos no MESMO arquivo da tool pra evitar drift.
// ---------------------------------------------------------------------------

export const DEFAULT_TOOL_DESCRIPTIONS: Record<string, string> = {
  aplicar_tag:
    'Adiciona uma tag ao lead no Kommo. Use quando a análise do lead indicar ' +
    'uma classificação (ex: "Quente", "Frio", "Sem interesse"). Idempotente: ' +
    'aplicar a mesma tag duas vezes não duplica.',
  mover_etapa:
    'Move o lead para outra etapa do pipeline no Kommo. Use quando a ' +
    'análise indicar mudança de qualificação (ex: "Lead Qualificado" → ' +
    '"Em Negociação"). Requer o statusId numérico da etapa destino.',
};

// ---------------------------------------------------------------------------
// Factory: as tools precisam de acesso ao `TraceRecorder` da execução
// corrente para gravar steps. Como não dá pra "injetar" facilmente em
// tools registradas globalmente, criamos uma factory que retorna um array
// novo de tools por invocação.
//
// `descriptionOverrides` permite que o AgentConfig (editado pelo dashboard)
// substitua o texto-gatilho da tool sem mudar o código. A description é o
// que o LLM lê pra decidir QUANDO chamar — então editá-la muda comportamento.
// ---------------------------------------------------------------------------

export function buildTools(
  recorder: TraceRecorder,
  descriptionOverrides: Record<string, string> = {},
) {
  const desc = (name: string) =>
    descriptionOverrides[name] || DEFAULT_TOOL_DESCRIPTIONS[name];
  const aplicarTagSchema = z.object({
    leadId: z.number().int().positive().describe('ID numérico do lead no Kommo.'),
    tag: z
      .string()
      .min(1)
      .max(50)
      .describe(
        'Nome da tag a aplicar. Use exemplos como "Quente", "Frio", "Pronto para Fechar".',
      ),
  });

  const moverEtapaSchema = z.object({
    leadId: z.number().int().positive().describe('ID numérico do lead no Kommo.'),
    statusId: z
      .number()
      .int()
      .positive()
      .describe('ID da etapa (status) destino no pipeline do Kommo.'),
    pipelineId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('ID do pipeline destino (opcional — só se for mover entre funis).'),
  });

  const aplicar_tag = new DynamicStructuredTool({
    name: 'aplicar_tag',
    description: desc('aplicar_tag'),
    schema: aplicarTagSchema,
    func: async ({ leadId, tag }) => {
      const t0 = performance.now();
      await recorder.step({
        kind: 'TOOL_CALL',
        title: `Decisão: aplicar tag "${tag}" no lead ${leadId}`,
        payload: { leadId, tag },
      });

      try {
        await KommoService.addTag({ leadId, tag });
        const latency = Math.round(performance.now() - t0);
        await recorder.step({
          kind: 'KOMMO_ACTION',
          title: `Tag "${tag}" aplicada no Kommo`,
          payload: { leadId, tag },
          latencyMs: latency,
        });
        return `OK — tag "${tag}" aplicada no lead ${leadId} (${latency}ms).`;
      } catch (err) {
        const latency = Math.round(performance.now() - t0);
        const msg = err instanceof Error ? err.message : String(err);
        await recorder.step({
          kind: 'ERROR',
          title: `Falha ao aplicar tag: ${msg}`,
          payload: { leadId, tag, error: msg },
          latencyMs: latency,
        });
        // Devolvemos a falha como string pra LLM poder reagir (ex: tentar
        // outra tool). NÃO lançamos — isso quebraria o loop ReAct.
        return `ERRO ao aplicar tag: ${msg}`;
      }
    },
  });

  const mover_etapa = new DynamicStructuredTool({
    name: 'mover_etapa',
    description: desc('mover_etapa'),
    schema: moverEtapaSchema,
    func: async ({ leadId, statusId, pipelineId }) => {
      const t0 = performance.now();
      await recorder.step({
        kind: 'TOOL_CALL',
        title: `Decisão: mover lead ${leadId} para etapa ${statusId}`,
        payload: { leadId, statusId, pipelineId },
      });

      try {
        await KommoService.moveStage({ leadId, statusId, pipelineId });
        const latency = Math.round(performance.now() - t0);
        await recorder.step({
          kind: 'KOMMO_ACTION',
          title: `Lead movido para etapa ${statusId}`,
          payload: { leadId, statusId, pipelineId },
          latencyMs: latency,
        });
        return `OK — lead ${leadId} movido para etapa ${statusId} (${latency}ms).`;
      } catch (err) {
        const latency = Math.round(performance.now() - t0);
        const msg = err instanceof Error ? err.message : String(err);
        await recorder.step({
          kind: 'ERROR',
          title: `Falha ao mover etapa: ${msg}`,
          payload: { leadId, statusId, error: msg },
          latencyMs: latency,
        });
        return `ERRO ao mover etapa: ${msg}`;
      }
    },
  });

  return [aplicar_tag, mover_etapa];
}

export type AgentTools = ReturnType<typeof buildTools>;
