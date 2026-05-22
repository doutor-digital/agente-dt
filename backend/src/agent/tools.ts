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
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { LeadFieldRule, Unit } from '@prisma/client';
import type { KommoClient, KommoFieldType } from '../services/kommo.service.js';
import type { TraceRecorder } from './trace-recorder.js';
import { getRecentMessagesByLead } from '../services/conversations.service.js';
import { createChatOpenAI, invokeChatModel } from '../services/openai.service.js';

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
    'Atualiza o título do card do lead no Kommo com o nome do paciente. ' +
    'Use IMEDIATAMENTE quando o paciente disser o próprio nome. O sistema ' +
    'acrescenta automaticamente a data da conversa no formato "Nome DD/MM/YYYY" ' +
    '(ex: "Maria Silva 20/05/2026"). Você só precisa passar o NOME — não ' +
    'inclua data, ela é adicionada automaticamente. Idempotente: chamar duas ' +
    'vezes com o mesmo nome não altera o título.',
  resumir_lead_para_sdr:
    'Gera um RESUMO do lead (queixa, contexto, sinais de interesse, próximos ' +
    'passos sugeridos) e posta como NOTA INTERNA no Kommo. A nota é visível ' +
    'só pros operadores humanos (SDR/vendedor) — o paciente NÃO vê. Use no ' +
    'momento de transferir o lead pra um humano (ex: agendamento confirmado, ' +
    'caso clínico delicado, paciente quente pedindo orçamento) pra que o SDR ' +
    'pegue o lead com contexto pronto. Idempotente em termos lógicos, mas ' +
    'cria uma nota nova a cada chamada — chame só 1x por transição.',
  criar_tarefa:
    'Cria uma TAREFA no Kommo vinculada ao lead, com prazo e (opcional) ' +
    'usuário responsável. Use pra delegar follow-up ao SDR humano (ex: "ligar ' +
    'amanhã às 14h", "confirmar consulta em 2 dias"). A tarefa aparece no ' +
    'painel de tarefas do Kommo do operador. Não envia mensagem ao paciente.',
  atribuir_responsavel:
    'Define qual usuário do Kommo é o RESPONSÁVEL pelo lead (transferência ' +
    'de propriedade). Use quando o caso precisa de uma pessoa específica ' +
    '(ex: caso clínico → Dra. Ana; agendamento padrão → Equipe Comercial). ' +
    'Combine com pausar_ia se quiser que o humano assuma a conversa.',
  remover_tag:
    'Remove uma tag específica do lead no Kommo. Use pra limpar classificações ' +
    'antigas que não se aplicam mais (ex: lead estava "Frio", voltou ' +
    'engajado → remover "Frio" e aplicar "Quente"). Idempotente: remover ' +
    'tag inexistente é no-op.',
  definir_valor_lead:
    'Define o VALOR (preço, em reais) do lead no Kommo — campo nativo "price" ' +
    'do card. Use quando o paciente confirma um procedimento/plano com ' +
    'preço conhecido (ex: avaliação R$200, cirurgia R$5000). Esse valor ' +
    'alimenta as métricas de pipeline em dinheiro no dashboard.',
  fechar_lead:
    'FECHA o lead formalmente como VENDA REALIZADA (won) ou VENDA PERDIDA ' +
    '(lost). Use só em momentos de encerramento explícito: paciente confirmou ' +
    'pagamento (won) ou desistiu definitivamente (lost). Pra LOST, pode ' +
    'passar o motivo (lossReasonId) se conhecido.',
  mover_funil:
    'Move o lead pra OUTRO FUNIL inteiro do Kommo (não apenas etapa). Use ' +
    'quando muda o contexto do lead — ex: lead que fechou primeira venda ' +
    'volta com nova demanda → move do funil "Captação" pro "Pós-venda". ' +
    'Se não passar statusId, Kommo coloca no primeiro status do funil destino.',
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
  /** Regras de captura de dados — cada uma vira uma tool dinâmica. */
  leadFieldRules?: LeadFieldRule[];
  /** Unit completa — usada pela tool de resumo pra montar o LLM da unidade. */
  unit?: Unit;
}

export function buildTools({
  recorder,
  kommo,
  descriptionOverrides = {},
  pausedFieldId = null,
  leadFieldRules = [],
  unit,
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
        // Lê o lead atual pra (a) usar `created_at` como data da conversa (faz
        // a tool ser idempotente entre dias — usando data de criação fixa
        // em vez de "hoje") e (b) checar se o título já está como queremos.
        const lead = await kommo.getLead(leadId);
        const createdAtMs = (lead.created_at ?? Math.floor(Date.now() / 1000)) * 1000;
        const dateBR = new Intl.DateTimeFormat('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        }).format(new Date(createdAtMs));
        const desired = `${nome.trim()} ${dateBR}`;

        if (lead.name === desired) {
          const latency = Math.round(performance.now() - t0);
          await recorder.step({
            kind: 'KOMMO_ACTION',
            title: `Título já está como "${desired}" — no-op`,
            payload: { leadId, current: lead.name, desired },
            latencyMs: latency,
          });
          return `OK — título já está como "${desired}" (sem alteração, ${latency}ms).`;
        }

        await kommo.updateLeadName(leadId, desired);
        const latency = Math.round(performance.now() - t0);
        await recorder.step({
          kind: 'KOMMO_ACTION',
          title: `Título do lead ${leadId} atualizado: "${lead.name}" → "${desired}"`,
          payload: { leadId, nome, dateBR, desired, previous: lead.name },
          latencyMs: latency,
        });
        return `OK — título do lead ${leadId} agora é "${desired}" (${latency}ms).`;
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

  // -------------------------------------------------------------------------
  // criar_tarefa — POST /tasks no Kommo, vinculado ao lead.
  // -------------------------------------------------------------------------
  const criarTarefaSchema = z.object({
    leadId: z.number().int().positive().describe('ID numérico do lead no Kommo.'),
    text: z.string().min(3).max(500).describe('Texto da tarefa (o que fazer).'),
    deadlineMinutes: z
      .number()
      .int()
      .positive()
      .max(60 * 24 * 30) // 30 dias
      .describe(
        'Quantos minutos a partir de agora pro deadline. Ex: 60=1h, 1440=1 dia, ' +
          '10080=1 semana. A tarefa aparece pro operador com esse prazo.',
      ),
    responsibleUserId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('ID do usuário Kommo responsável. Se omitido, herda do lead.'),
  });
  const criar_tarefa = new DynamicStructuredTool({
    name: 'criar_tarefa',
    description: desc('criar_tarefa'),
    schema: criarTarefaSchema,
    func: async ({ leadId, text, deadlineMinutes, responsibleUserId }) => {
      const t0 = performance.now();
      const completeAt = Math.floor(Date.now() / 1000) + deadlineMinutes * 60;
      await recorder.step({
        kind: 'TOOL_CALL',
        title: `Decisão: criar tarefa pro lead ${leadId} ("${text.slice(0, 50)}")`,
        payload: { leadId, text, deadlineMinutes, responsibleUserId: responsibleUserId ?? null, completeAt },
      });
      try {
        const result = await kommo.createTask({ leadId, text, completeAt, responsibleUserId });
        const latency = Math.round(performance.now() - t0);
        await recorder.step({
          kind: 'KOMMO_ACTION',
          title: `Tarefa criada no lead ${leadId} (id ${result?.id ?? '?'})`,
          payload: { leadId, taskId: result?.id ?? null, completeAt, text },
          latencyMs: latency,
        });
        return `OK — tarefa criada no lead ${leadId} pra ${new Date(completeAt * 1000).toLocaleString('pt-BR')} (${latency}ms).`;
      } catch (err) {
        const latency = Math.round(performance.now() - t0);
        const msg = err instanceof Error ? err.message : String(err);
        await recorder.step({
          kind: 'ERROR',
          title: `Falha ao criar tarefa: ${msg}`,
          payload: { leadId, error: msg },
          latencyMs: latency,
        });
        return `ERRO ao criar tarefa: ${msg}`;
      }
    },
  });

  // -------------------------------------------------------------------------
  // atribuir_responsavel — PATCH /leads com responsible_user_id.
  // -------------------------------------------------------------------------
  const atribuirResponsavelSchema = z.object({
    leadId: z.number().int().positive().describe('ID numérico do lead no Kommo.'),
    userId: z.number().int().positive().describe('ID do usuário Kommo que vai assumir o lead.'),
  });
  const atribuir_responsavel = new DynamicStructuredTool({
    name: 'atribuir_responsavel',
    description: desc('atribuir_responsavel'),
    schema: atribuirResponsavelSchema,
    func: async ({ leadId, userId }) => {
      const t0 = performance.now();
      await recorder.step({
        kind: 'TOOL_CALL',
        title: `Decisão: atribuir lead ${leadId} ao usuário ${userId}`,
        payload: { leadId, userId },
      });
      try {
        await kommo.setLeadResponsible(leadId, userId);
        const latency = Math.round(performance.now() - t0);
        await recorder.step({
          kind: 'KOMMO_ACTION',
          title: `Lead ${leadId} agora pertence ao usuário ${userId}`,
          payload: { leadId, userId },
          latencyMs: latency,
        });
        return `OK — lead ${leadId} atribuído ao usuário ${userId} (${latency}ms).`;
      } catch (err) {
        const latency = Math.round(performance.now() - t0);
        const msg = err instanceof Error ? err.message : String(err);
        await recorder.step({
          kind: 'ERROR',
          title: `Falha ao atribuir responsável: ${msg}`,
          payload: { leadId, userId, error: msg },
          latencyMs: latency,
        });
        return `ERRO ao atribuir responsável: ${msg}`;
      }
    },
  });

  // -------------------------------------------------------------------------
  // remover_tag — PATCH com _embedded.tags_to_delete.
  // -------------------------------------------------------------------------
  const removerTagSchema = z.object({
    leadId: z.number().int().positive().describe('ID numérico do lead no Kommo.'),
    tag: z.string().min(1).max(50).describe('Nome exato da tag a remover.'),
  });
  const remover_tag = new DynamicStructuredTool({
    name: 'remover_tag',
    description: desc('remover_tag'),
    schema: removerTagSchema,
    func: async ({ leadId, tag }) => {
      const t0 = performance.now();
      await recorder.step({
        kind: 'TOOL_CALL',
        title: `Decisão: remover tag "${tag}" do lead ${leadId}`,
        payload: { leadId, tag },
      });
      try {
        await kommo.removeTag(leadId, tag);
        const latency = Math.round(performance.now() - t0);
        await recorder.step({
          kind: 'KOMMO_ACTION',
          title: `Tag "${tag}" removida do lead ${leadId}`,
          payload: { leadId, tag },
          latencyMs: latency,
        });
        return `OK — tag "${tag}" removida do lead ${leadId} (${latency}ms).`;
      } catch (err) {
        const latency = Math.round(performance.now() - t0);
        const msg = err instanceof Error ? err.message : String(err);
        await recorder.step({
          kind: 'ERROR',
          title: `Falha ao remover tag: ${msg}`,
          payload: { leadId, tag, error: msg },
          latencyMs: latency,
        });
        return `ERRO ao remover tag: ${msg}`;
      }
    },
  });

  // -------------------------------------------------------------------------
  // definir_valor_lead — PATCH com price.
  // -------------------------------------------------------------------------
  const definirValorLeadSchema = z.object({
    leadId: z.number().int().positive().describe('ID numérico do lead no Kommo.'),
    price: z
      .number()
      .nonnegative()
      .max(10_000_000)
      .describe('Valor em reais (number). Ex: 1500 = R$ 1500,00.'),
  });
  const definir_valor_lead = new DynamicStructuredTool({
    name: 'definir_valor_lead',
    description: desc('definir_valor_lead'),
    schema: definirValorLeadSchema,
    func: async ({ leadId, price }) => {
      const t0 = performance.now();
      await recorder.step({
        kind: 'TOOL_CALL',
        title: `Decisão: definir valor R$ ${price} no lead ${leadId}`,
        payload: { leadId, price },
      });
      try {
        await kommo.setLeadPrice(leadId, price);
        const latency = Math.round(performance.now() - t0);
        await recorder.step({
          kind: 'KOMMO_ACTION',
          title: `Valor do lead ${leadId} agora é R$ ${price}`,
          payload: { leadId, price },
          latencyMs: latency,
        });
        return `OK — valor do lead ${leadId} = R$ ${price} (${latency}ms).`;
      } catch (err) {
        const latency = Math.round(performance.now() - t0);
        const msg = err instanceof Error ? err.message : String(err);
        await recorder.step({
          kind: 'ERROR',
          title: `Falha ao definir valor: ${msg}`,
          payload: { leadId, price, error: msg },
          latencyMs: latency,
        });
        return `ERRO ao definir valor: ${msg}`;
      }
    },
  });

  // -------------------------------------------------------------------------
  // fechar_lead — PATCH com status_id (142=won, 143=lost) + lossReasonId.
  // -------------------------------------------------------------------------
  const fecharLeadSchema = z.object({
    leadId: z.number().int().positive().describe('ID numérico do lead no Kommo.'),
    status: z.enum(['won', 'lost']).describe('"won" = venda realizada, "lost" = venda perdida.'),
    lossReasonId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Opcional. ID do motivo de perda (Kommo /leads/loss_reasons). Só pra lost.'),
  });
  const fechar_lead = new DynamicStructuredTool({
    name: 'fechar_lead',
    description: desc('fechar_lead'),
    schema: fecharLeadSchema,
    func: async ({ leadId, status, lossReasonId }) => {
      const t0 = performance.now();
      await recorder.step({
        kind: 'TOOL_CALL',
        title: `Decisão: fechar lead ${leadId} como ${status.toUpperCase()}`,
        payload: { leadId, status, lossReasonId: lossReasonId ?? null },
      });
      try {
        await kommo.setLeadStatus(leadId, { won: status === 'won', lossReasonId });
        const latency = Math.round(performance.now() - t0);
        await recorder.step({
          kind: 'KOMMO_ACTION',
          title: `Lead ${leadId} fechado como ${status === 'won' ? 'VENDA REALIZADA' : 'VENDA PERDIDA'}`,
          payload: { leadId, status, lossReasonId },
          latencyMs: latency,
        });
        return `OK — lead ${leadId} fechado como ${status} (${latency}ms).`;
      } catch (err) {
        const latency = Math.round(performance.now() - t0);
        const msg = err instanceof Error ? err.message : String(err);
        await recorder.step({
          kind: 'ERROR',
          title: `Falha ao fechar lead: ${msg}`,
          payload: { leadId, status, error: msg },
          latencyMs: latency,
        });
        return `ERRO ao fechar lead: ${msg}`;
      }
    },
  });

  // -------------------------------------------------------------------------
  // mover_funil — PATCH com pipeline_id + status_id opcional.
  // -------------------------------------------------------------------------
  const moverFunilSchema = z.object({
    leadId: z.number().int().positive().describe('ID numérico do lead no Kommo.'),
    pipelineId: z.number().int().positive().describe('ID do funil destino.'),
    statusId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Opcional. ID da etapa dentro do novo funil. Sem isso, Kommo usa a primeira etapa.'),
  });
  const mover_funil = new DynamicStructuredTool({
    name: 'mover_funil',
    description: desc('mover_funil'),
    schema: moverFunilSchema,
    func: async ({ leadId, pipelineId, statusId }) => {
      const t0 = performance.now();
      await recorder.step({
        kind: 'TOOL_CALL',
        title: `Decisão: mover lead ${leadId} pro funil ${pipelineId}${statusId ? ` (etapa ${statusId})` : ''}`,
        payload: { leadId, pipelineId, statusId: statusId ?? null },
      });
      try {
        await kommo.setLeadPipeline(leadId, pipelineId, statusId);
        const latency = Math.round(performance.now() - t0);
        await recorder.step({
          kind: 'KOMMO_ACTION',
          title: `Lead ${leadId} movido pro funil ${pipelineId}`,
          payload: { leadId, pipelineId, statusId },
          latencyMs: latency,
        });
        return `OK — lead ${leadId} movido pro funil ${pipelineId} (${latency}ms).`;
      } catch (err) {
        const latency = Math.round(performance.now() - t0);
        const msg = err instanceof Error ? err.message : String(err);
        await recorder.step({
          kind: 'ERROR',
          title: `Falha ao mover funil: ${msg}`,
          payload: { leadId, pipelineId, error: msg },
          latencyMs: latency,
        });
        return `ERRO ao mover funil: ${msg}`;
      }
    },
  });

  // resumir_lead_para_sdr — gera resumo e posta como nota interna no Kommo.
  // Só registrada se tivermos `unit` (precisa pra montar o LLM da unidade).
  const resumirLeadParaSdrSchema = z.object({
    leadId: z.number().int().positive().describe('ID numérico do lead no Kommo.'),
    focusHint: z
      .string()
      .max(400)
      .optional()
      .describe(
        'Opcional. Dica do que destacar no resumo (ex: "foco em queixa clínica e ' +
          'preferência de horário"). Se omitido, gera resumo equilibrado.',
      ),
  });

  const resumir_lead_para_sdr = unit
    ? new DynamicStructuredTool({
        name: 'resumir_lead_para_sdr',
        description: desc('resumir_lead_para_sdr'),
        schema: resumirLeadParaSdrSchema,
        func: async ({ leadId, focusHint }) => {
          const t0 = performance.now();
          await recorder.step({
            kind: 'TOOL_CALL',
            title: `Decisão: resumir lead ${leadId} pra SDR (nota interna)`,
            payload: { leadId, focusHint: focusHint ?? null },
          });

          try {
            // 1) Histórico da conversa (últimas 40 msgs).
            const msgs = await getRecentMessagesByLead(unit.id, String(leadId), 40);
            if (msgs.length === 0) {
              const latency = Math.round(performance.now() - t0);
              await recorder.step({
                kind: 'KOMMO_ACTION',
                title: `Sem histórico de conversa pra lead ${leadId} — nota não criada`,
                payload: { leadId },
                latencyMs: latency,
              });
              return `Sem histórico de mensagens pra resumir (lead ${leadId}).`;
            }

            // 2) Monta prompt de sumarização.
            const transcript = msgs
              .map((m) => `${m.role === 'user' ? 'PACIENTE' : 'IA'}: ${m.content}`)
              .join('\n');
            const sys = new SystemMessage(
              [
                'Você é um assistente que escreve resumos rápidos pra um SDR ' +
                  'humano. O SDR vai abrir o lead no CRM e ler ESSE resumo ' +
                  'pra entender o contexto em 10 segundos.',
                '',
                'Formato obrigatório (markdown simples, sem emoji excessivo):',
                '• **Quem é**: nome + 1 detalhe (se souber)',
                '• **Queixa/Demanda**: o que o paciente quer',
                '• **Sinais de interesse**: orçamento? urgência? indicação?',
                '• **Próximo passo sugerido**: o que o SDR faz agora',
                '',
                'Regras:',
                '- Máx 6 linhas no total. Curto e útil.',
                '- Não invente informação que não está na conversa.',
                '- Não cumprimente o SDR, vá direto ao conteúdo.',
                focusHint ? `- Foco extra desta vez: ${focusHint}` : '',
              ]
                .filter(Boolean)
                .join('\n'),
            );
            const human = new HumanMessage(
              `Conversa entre PACIENTE e IA (mais antiga em cima):\n\n${transcript}`,
            );

            // 3) Chama o LLM da unidade.
            const model = createChatOpenAI(unit, {
              model: unit.openaiModel ?? undefined,
              temperature: 0.3,
              maxTokens: 600,
            });
            const t1 = performance.now();
            const response = (await invokeChatModel({
              model: model as unknown as Parameters<typeof invokeChatModel>[0]['model'],
              messages: [sys, human],
              unitId: unit.id,
              traceId: recorder.traceId,
              modelName: unit.openaiModel ?? 'gpt-4o-mini',
            })) as { content: unknown };
            const llmMs = Math.round(performance.now() - t1);
            const summary =
              typeof response.content === 'string'
                ? response.content
                : JSON.stringify(response.content);

            // 4) Posta nota interna no Kommo.
            const note = await kommo.addLeadNote(leadId, `📋 Resumo da IA (auto):\n\n${summary}`);

            const latency = Math.round(performance.now() - t0);
            await recorder.step({
              kind: 'KOMMO_ACTION',
              title: `Nota interna criada no lead ${leadId} (resumo pra SDR)`,
              payload: {
                leadId,
                summaryPreview: summary.slice(0, 200),
                noteId: note?.id ?? null,
                msgCount: msgs.length,
                llmMs,
              },
              latencyMs: latency,
            });
            return `OK — resumo postado como nota interna no lead ${leadId} (${msgs.length} msgs analisadas, ${llmMs}ms LLM, ${latency}ms total).`;
          } catch (err) {
            const latency = Math.round(performance.now() - t0);
            const msg = err instanceof Error ? err.message : String(err);
            await recorder.step({
              kind: 'ERROR',
              title: `Falha ao gerar resumo pra SDR: ${msg}`,
              payload: { leadId, error: msg },
              latencyMs: latency,
            });
            return `ERRO ao resumir lead: ${msg}`;
          }
        },
      })
    : null;

  // Tools dinâmicas — uma por LeadFieldRule ativa. Cada rule escreve em um
  // custom field específico do Kommo, com schema ditado pelo tipo do campo.
  const dynamicTools = leadFieldRules.map((rule) =>
    buildLeadFieldRuleTool({ rule, kommo, recorder }),
  );

  // Tipo amplo pra acomodar tools com schemas diferentes — TS infere o array
  // pelo 1º elemento e rejeitaria os outros schemas senão.
  const nativeTools: DynamicStructuredTool[] = [
    aplicar_tag,
    mover_etapa,
    pausar_ia,
    atualizar_titulo_lead,
    criar_tarefa,
    atribuir_responsavel,
    remover_tag,
    definir_valor_lead,
    fechar_lead,
    mover_funil,
  ];
  if (resumir_lead_para_sdr) nativeTools.push(resumir_lead_para_sdr);
  return [...nativeTools, ...dynamicTools];
}

// ---------------------------------------------------------------------------
// Tool dinâmica de captura — schema depende do tipo do field.
// ---------------------------------------------------------------------------

function buildLeadFieldRuleTool({
  rule,
  kommo,
  recorder,
}: {
  rule: LeadFieldRule;
  kommo: KommoClient;
  recorder: TraceRecorder;
}) {
  const fieldType = rule.kommoFieldType as KommoFieldType;
  const enums = (rule.kommoFieldEnums as Array<{ id: number; value: string }> | null) ?? [];
  const enumValues = enums.map((e) => e.value);

  // Schema da tool muda por tipo. value sempre fica como string no contrato
  // pra simplificar — convertemos depois antes de mandar pro Kommo.
  const baseSchema: Record<string, z.ZodTypeAny> = {
    leadId: z.number().int().positive().describe('ID numérico do lead no Kommo.'),
  };

  if (fieldType === 'numeric') {
    baseSchema.value = z
      .number()
      .describe(rule.valueHint ?? `Valor numérico pra "${rule.kommoFieldName}".`);
  } else if (fieldType === 'date' || fieldType === 'birthday') {
    baseSchema.value = z
      .string()
      .describe(
        rule.valueHint ??
          'Data em ISO 8601 (YYYY-MM-DD). Converta o que o paciente disser pra esse formato.',
      );
  } else if (fieldType === 'multiselect') {
    const arr = enumValues.length > 0 ? z.array(z.enum(enumValues as [string, ...string[]])) : z.array(z.string());
    baseSchema.values = arr.describe(
      rule.valueHint ??
        (enumValues.length > 0
          ? `Uma ou mais opções dentre: ${enumValues.join(', ')}`
          : `Opções pra "${rule.kommoFieldName}".`),
    );
  } else if ((fieldType === 'select' || fieldType === 'radiobutton') && enumValues.length > 0) {
    baseSchema.value = z
      .enum(enumValues as [string, ...string[]])
      .describe(
        rule.valueHint ?? `Escolha UMA das opções: ${enumValues.join(', ')}`,
      );
  } else {
    baseSchema.value = z
      .string()
      .min(1)
      .max(2000)
      .describe(rule.valueHint ?? `Valor pra "${rule.kommoFieldName}".`);
  }

  const schema = z.object(baseSchema);
  const examplesBlock =
    rule.examples.length > 0
      ? ` Exemplos de quando chamar: ${rule.examples.slice(0, 5).map((e) => `"${e}"`).join('; ')}.`
      : '';

  const description =
    `${rule.instruction.trim()} Salva no campo "${rule.kommoFieldName}" do lead no Kommo (tipo ${fieldType}).${examplesBlock} Chame em silêncio — não comente a captura na resposta ao paciente.`;

  return new DynamicStructuredTool({
    name: rule.toolName,
    description,
    schema,
    func: async (args: Record<string, unknown>) => {
      const leadId = Number(args.leadId);
      const value = fieldType === 'multiselect' ? args.values : args.value;
      const t0 = performance.now();

      await recorder.step({
        kind: 'TOOL_CALL',
        title: `Decisão: ${rule.toolName}(leadId=${leadId}) → "${rule.kommoFieldName}"`,
        payload: { leadId, fieldId: rule.kommoFieldId, fieldName: rule.kommoFieldName, fieldType, value },
      });

      try {
        await kommo.setLeadCustomFieldValue(
          leadId,
          rule.kommoFieldId,
          fieldType,
          value as string | number | string[],
        );
        const latency = Math.round(performance.now() - t0);
        await recorder.step({
          kind: 'KOMMO_ACTION',
          title: `"${rule.kommoFieldName}" gravado no lead ${leadId}`,
          payload: { leadId, fieldId: rule.kommoFieldId, fieldType, value },
          latencyMs: latency,
        });
        return `OK — "${rule.kommoFieldName}" gravado (${latency}ms).`;
      } catch (err) {
        const latency = Math.round(performance.now() - t0);
        const msg = err instanceof Error ? err.message : String(err);
        await recorder.step({
          kind: 'ERROR',
          title: `Falha em ${rule.toolName}: ${msg}`,
          payload: { leadId, fieldId: rule.kommoFieldId, fieldType, value, error: msg },
          latencyMs: latency,
        });
        return `ERRO ao gravar "${rule.kommoFieldName}": ${msg}`;
      }
    },
  });
}

export type AgentTools = ReturnType<typeof buildTools>;
