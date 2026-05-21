// ============================================================================
// tools.ts — Tools do agente (Zod + DynamicStructuredTool, multi-tenant).
//
// LÓGICA DE ENGENHARIA
// --------------------
// As Tools são a interface entre a LLM e o mundo real. Cada Tool tem:
//   1. SCHEMA Zod — convertido pela LangChain pro formato de tool-calling
//      esperado pela OpenAI.
//   2. DESCRIÇÃO em linguagem natural — o que faz o LLM decidir QUANDO
//      chamar a tool. É o gatilho.
//   3. FUNÇÃO de execução — delega pro `KommoClient` da Unit corrente.
//
// Por que NÃO chamadas axios diretas aqui?
//   - O LangGraph fica acoplado ao Kommo. Mantendo o `KommoClient` como
//     camada HTTP pura, a tool fica imutável quando trocarmos de CRM.
//
// MULTI-TENANT
// ------------
// Cada execução tem sua Unit. As tools precisam do `KommoClient` instanciado
// com as credenciais da Unit — por isso passamos pelo factory `buildTools`.
// ============================================================================

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { KommoClient } from '../services/kommo.service.js';
import type { TraceRecorder } from './trace-recorder.js';

// ---------------------------------------------------------------------------
// Descrições default — fonte de verdade pro seed do AgentConfig.
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
  pausar_ia:
    'Pausa o atendimento por IA neste lead, marcando a flag "IA Pausada" no ' +
    'Kommo. Use APENAS quando: (a) o paciente pedir explicitamente pra falar ' +
    'com um humano; (b) a situação é clínica/sensível e exige atendente real; ' +
    '(c) o paciente está agitado/insatisfeito. Após pausar, responda UMA frase ' +
    'avisando que um humano vai assumir.',
  atualizar_titulo_lead:
    'Atualiza o título (nome) do lead no Kommo. Use IMEDIATAMENTE quando o ' +
    'paciente disser o próprio nome — o título do card no Kommo deixa de ser ' +
    'genérico ("WhatsApp Web", "Visitante") e passa a ser o nome real. ' +
    'Idempotente: passar o mesmo nome duas vezes não muda nada.',
};

// ---------------------------------------------------------------------------
// Factory.
// `kommo` é o cliente já instanciado pra Unit corrente.
// `descriptionOverrides` permite que o AgentConfig (editado pelo dashboard)
// substitua o texto-gatilho da tool.
// ---------------------------------------------------------------------------

export interface BuildToolsArgs {
  recorder: TraceRecorder;
  kommo: KommoClient;
  descriptionOverrides?: Record<string, string>;
  /** ID do custom field "IA Pausada". Sem isso, `pausar_ia` retorna erro suave. */
  pausedFieldId?: number | null;
}

export function buildTools({
  recorder,
  kommo,
  descriptionOverrides = {},
  pausedFieldId = null,
}: BuildToolsArgs) {
  const desc = (name: string) => descriptionOverrides[name] || DEFAULT_TOOL_DESCRIPTIONS[name];

  const aplicarTagSchema = z.object({
    leadId: z.number().int().positive().describe('ID numérico do lead no Kommo.'),
    tag: z
      .string()
      .min(1)
      .max(50)
      .describe('Nome da tag a aplicar. Use exemplos como "Quente", "Frio", "Pronto para Fechar".'),
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
        await kommo.addTag({ leadId, tag });
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
        // Devolvemos a falha como string pra LLM poder reagir. NÃO lançamos.
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
        await kommo.moveStage({ leadId, statusId, pipelineId });
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

  const pausarIaSchema = z.object({
    leadId: z.number().int().positive().describe('ID numérico do lead no Kommo.'),
    motivo: z
      .string()
      .min(1)
      .max(200)
      .describe('Por que está pausando a IA neste lead (registrado no trace).'),
  });

  const pausar_ia = new DynamicStructuredTool({
    name: 'pausar_ia',
    description: desc('pausar_ia'),
    schema: pausarIaSchema,
    func: async ({ leadId, motivo }) => {
      const t0 = performance.now();
      await recorder.step({
        kind: 'TOOL_CALL',
        title: `Decisão: pausar IA no lead ${leadId} (${motivo})`,
        payload: { leadId, motivo },
      });

      if (!pausedFieldId) {
        const msg = 'Unit não tem kommoPausedFieldId configurado — pausa não pode ser persistida.';
        await recorder.step({
          kind: 'ERROR',
          title: msg,
          payload: { leadId, motivo },
          latencyMs: Math.round(performance.now() - t0),
        });
        return `ERRO: ${msg} Avise a equipe e prossiga sem pausar.`;
      }

      try {
        await kommo.setLeadFieldFlag(leadId, pausedFieldId, true);
        const latency = Math.round(performance.now() - t0);
        await recorder.step({
          kind: 'KOMMO_ACTION',
          title: `IA pausada no lead ${leadId}`,
          payload: { leadId, motivo, fieldId: pausedFieldId },
          latencyMs: latency,
        });
        return `OK — IA pausada no lead ${leadId} (${latency}ms). Responda em UMA frase avisando o paciente.`;
      } catch (err) {
        const latency = Math.round(performance.now() - t0);
        const msg = err instanceof Error ? err.message : String(err);
        await recorder.step({
          kind: 'ERROR',
          title: `Falha ao pausar IA: ${msg}`,
          payload: { leadId, motivo, error: msg },
          latencyMs: latency,
        });
        return `ERRO ao pausar IA: ${msg}`;
      }
    },
  });

  const atualizarTituloLeadSchema = z.object({
    leadId: z.number().int().positive().describe('ID numérico do lead no Kommo.'),
    nome: z
      .string()
      .min(1)
      .max(120)
      .describe(
        'Nome real do paciente como ele se identificou. Use o que ele disse, ' +
          'com inicial maiúscula (ex: "Maria Silva"). Não invente sobrenomes.',
      ),
  });

  const atualizar_titulo_lead = new DynamicStructuredTool({
    name: 'atualizar_titulo_lead',
    description: desc('atualizar_titulo_lead'),
    schema: atualizarTituloLeadSchema,
    func: async ({ leadId, nome }) => {
      const t0 = performance.now();
      await recorder.step({
        kind: 'TOOL_CALL',
        title: `Decisão: atualizar título do lead ${leadId} para "${nome}"`,
        payload: { leadId, nome },
      });

      try {
        await kommo.updateLeadName(leadId, nome);
        const latency = Math.round(performance.now() - t0);
        await recorder.step({
          kind: 'KOMMO_ACTION',
          title: `Título do lead ${leadId} atualizado para "${nome}"`,
          payload: { leadId, nome },
          latencyMs: latency,
        });
        return `OK — título do lead ${leadId} agora é "${nome}" (${latency}ms).`;
      } catch (err) {
        const latency = Math.round(performance.now() - t0);
        const msg = err instanceof Error ? err.message : String(err);
        await recorder.step({
          kind: 'ERROR',
          title: `Falha ao atualizar título: ${msg}`,
          payload: { leadId, nome, error: msg },
          latencyMs: latency,
        });
        return `ERRO ao atualizar título: ${msg}`;
      }
    },
  });

  return [aplicar_tag, mover_etapa, pausar_ia, atualizar_titulo_lead];
}

export type AgentTools = ReturnType<typeof buildTools>;
