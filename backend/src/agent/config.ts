// ============================================================================
// config.ts — AgentConfig: prompt + tools habilitadas + workflow declarativo.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Antes deste módulo, o SYSTEM_PROMPT vivia hardcoded em graph.ts. Isso
// significa que qualquer ajuste de comportamento exigia deploy. Aqui movemos
// a configuração para o banco (model AgentConfig do Prisma) e expomos:
//
//   - getActiveConfig()   → lê o registro ativo. Se não existir, cria com
//                           os defaults canônicos. Idempotente.
//   - saveConfig(input)   → upsert do "default" e marca como ativo.
//   - DEFAULTS            → fonte de verdade do prompt/tools/workflow base.
//
// FORMATO DOS CAMPOS JSON
// -----------------------
// `tools`: array de { name, enabled, description }.
//   - O graph filtra tools cujo `enabled === false` antes do `bindTools`.
//   - O graph SUBSTITUI a description original da tool pela versão editada
//     (a description é o "gatilho" — é o que o LLM lê pra decidir chamar).
//
// `workflow`: array de regras declarativas { id, when, then }.
//   - NÃO é um sub-grafo; é texto que o agent recebe como parte do system
//     prompt. Funciona como "policy" pra guiar o ReAct loop.
//   - Mantemos texto livre pra dar flexibilidade — o LLM é quem interpreta.
// ============================================================================

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

export type ToolConfig = {
  name: string;
  enabled: boolean;
  description: string;
};

export type WorkflowRule = {
  id: string;
  when: string;
  then: string;
};

export type AgentConfigShape = {
  id: string;
  name: string;
  isActive: boolean;
  systemPrompt: string;
  tools: ToolConfig[];
  workflow: WorkflowRule[];
  model: string;
  temperature: number;
  maxTokens: number;
  updatedAt: Date;
};

// ---------------------------------------------------------------------------
// DEFAULTS — bootstrap quando o banco está vazio.
// O system prompt aqui é o MESMO que estava hardcoded no graph.ts (mantemos
// compatibilidade do MVP) — o usuário edita pelo dashboard a partir daqui.
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT = `Você é um agente de qualificação de leads do CRM Kommo.

Sua missão: analisar o lead recebido e tomar UMA ação prática usando as tools disponíveis.

Regras:
- Sempre que possível, chame UMA tool (aplicar_tag ou mover_etapa) em vez de só conversar.
- Use a tag "Quente" para leads com sinais claros de interesse (orçamento, urgência, decisor).
- Use a tag "Frio" para leads que pediram pra não ser contatados ou sem fit.
- Seja conciso. Não invente IDs de etapa — só mova se o usuário informar um statusId válido.
- Após executar a tool, responda em UMA frase explicando o que fez e por quê.`;

const DEFAULT_TOOLS: ToolConfig[] = [
  {
    name: 'aplicar_tag',
    enabled: true,
    description:
      'Adiciona uma tag ao lead no Kommo. Use quando a análise do lead indicar ' +
      'uma classificação (ex: "Quente", "Frio", "Sem interesse"). Idempotente: ' +
      'aplicar a mesma tag duas vezes não duplica.',
  },
  {
    name: 'mover_etapa',
    enabled: true,
    description:
      'Move o lead para outra etapa do pipeline no Kommo. Use quando a ' +
      'análise indicar mudança de qualificação (ex: "Lead Qualificado" → ' +
      '"Em Negociação"). Requer o statusId numérico da etapa destino.',
  },
];

const DEFAULT_WORKFLOW: WorkflowRule[] = [];

export const DEFAULTS = {
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  tools: DEFAULT_TOOLS,
  workflow: DEFAULT_WORKFLOW,
  model: 'gpt-4o-mini',
  temperature: 0,
  maxTokens: 1024,
};

// ---------------------------------------------------------------------------
// Helpers de serialização — Prisma Json type é "any", então isolamos a
// conversão num lugar só pra não espalhar `as unknown as ...` pelo código.
// ---------------------------------------------------------------------------

function toShape(row: {
  id: string;
  name: string;
  isActive: boolean;
  systemPrompt: string;
  tools: unknown;
  workflow: unknown;
  model: string;
  temperature: number;
  maxTokens: number;
  updatedAt: Date;
}): AgentConfigShape {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    systemPrompt: row.systemPrompt,
    tools: Array.isArray(row.tools) ? (row.tools as ToolConfig[]) : DEFAULTS.tools,
    workflow: Array.isArray(row.workflow) ? (row.workflow as WorkflowRule[]) : [],
    model: row.model,
    temperature: row.temperature,
    maxTokens: row.maxTokens,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// getActiveConfig — lê o ativo. Se não existir nenhum, faz seed do default
// e marca como ativo. Operação idempotente (segura contra race no boot).
// ---------------------------------------------------------------------------

export async function getActiveConfig(): Promise<AgentConfigShape> {
  const active = await prisma.agentConfig.findFirst({
    where: { isActive: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (active) return toShape(active);

  // Sem ativo — semeamos um.
  logger.info('AgentConfig: nenhum ativo encontrado, semeando default');
  const seeded = await prisma.agentConfig.create({
    data: {
      name: 'default',
      isActive: true,
      systemPrompt: DEFAULTS.systemPrompt,
      tools: DEFAULTS.tools,
      workflow: DEFAULTS.workflow,
      model: DEFAULTS.model,
      temperature: DEFAULTS.temperature,
      maxTokens: DEFAULTS.maxTokens,
    },
  });
  return toShape(seeded);
}

// ---------------------------------------------------------------------------
// saveConfig — upsert do "default" e garante que ele é o único ativo.
// O dashboard chama isso quando o usuário salva. Usamos transação para que
// não fique mais de um registro ativo simultaneamente.
// ---------------------------------------------------------------------------

export type SaveConfigInput = {
  systemPrompt: string;
  tools: ToolConfig[];
  workflow: WorkflowRule[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
};

export async function saveConfig(input: SaveConfigInput): Promise<AgentConfigShape> {
  const data = {
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    workflow: input.workflow,
    model: input.model ?? DEFAULTS.model,
    temperature: input.temperature ?? DEFAULTS.temperature,
    maxTokens: input.maxTokens ?? DEFAULTS.maxTokens,
  };

  const saved = await prisma.$transaction(async (tx) => {
    // Garante que só o "default" fica ativo.
    await tx.agentConfig.updateMany({ where: { isActive: true }, data: { isActive: false } });

    const existing = await tx.agentConfig.findFirst({ where: { name: 'default' } });
    if (existing) {
      return tx.agentConfig.update({
        where: { id: existing.id },
        data: { ...data, isActive: true },
      });
    }
    return tx.agentConfig.create({
      data: { name: 'default', isActive: true, ...data },
    });
  });

  return toShape(saved);
}

// ---------------------------------------------------------------------------
// renderWorkflowGuidance — converte as regras declarativas num bloco de
// texto que vai ANEXADO ao system prompt em runtime. Mantemos formato
// numerado pra LLM seguir a ordem.
// ---------------------------------------------------------------------------

export function renderWorkflowGuidance(rules: WorkflowRule[]): string {
  if (!rules.length) return '';
  const lines = rules.map((r, i) => `${i + 1}. SE ${r.when} ENTÃO ${r.then}`);
  return `\n\nSequências de automação (siga estas regras quando aplicáveis):\n${lines.join('\n')}`;
}
