// ============================================================================
// config.ts — AgentConfig: prompt + tools habilitadas + workflow declarativo.
//
// LÓGICA DE ENGENHARIA — MULTI-TENANT
// -----------------------------------
// Cada Unit tem seu próprio AgentConfig (1:N). Quando uma execução começa
// para uma Unit, buscamos o AgentConfig ATIVO daquela Unit. Se não existir
// nenhum, criamos com os defaults (system prompt da Unit + tools default).
//
// Compatibilidade com a versão mono-tenant:
//   - getActiveConfig(unitId?) — sem unitId, retorna o primeiro config sem
//     unitId associado (ou cria um). Mantém o comportamento antigo.
//
// FORMATO DOS CAMPOS JSON
// -----------------------
// `tools`: { name, enabled, description }[]
//   - O graph filtra `enabled === false` antes do `bindTools`.
//   - O graph SUBSTITUI a description original pela versão editada.
//
// `workflow`: { id, when, then }[]
//   - Concatenado ao system prompt. Não é um sub-grafo.
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
  unitId: string | null;
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
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT = `Você é um agente de qualificação de leads do CRM Kommo.

Sua missão: analisar o lead recebido e tomar UMA ação prática usando as tools disponíveis.

Regras:
- Sempre que possível, chame UMA tool (aplicar_tag, mover_etapa ou pausar_ia) em vez de só conversar.
- Use a tag "Quente" para leads com sinais claros de interesse (orçamento, urgência, decisor).
- Use a tag "Frio" para leads que pediram pra não ser contatados ou sem fit.
- Use pausar_ia quando o paciente pedir um humano, demonstrar irritação, ou trouxer caso clínico delicado.
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
  {
    name: 'pausar_ia',
    enabled: true,
    description:
      'Pausa o atendimento por IA neste lead, marcando a flag "IA Pausada" no ' +
      'Kommo. Use quando o paciente pedir um humano, demonstrar irritação ou ' +
      'trazer caso clínico delicado.',
  },
  {
    name: 'atualizar_titulo_lead',
    enabled: true,
    description:
      'Atualiza o título (nome) do lead no Kommo. Use IMEDIATAMENTE quando o ' +
      'paciente disser o próprio nome — o título do card no Kommo deixa de ser ' +
      'genérico e passa a ser o nome real.',
  },
  {
    name: 'resumir_lead_para_sdr',
    enabled: true,
    description:
      'Gera um resumo do lead (queixa, contexto, próximos passos) e posta como ' +
      'NOTA INTERNA no Kommo pro SDR humano ver. Use quando transferir o lead ' +
      'pra um humano ou em momentos-chave (paciente quente, agendamento confirmado).',
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
// Helpers de serialização — Prisma Json type é "any".
// ---------------------------------------------------------------------------

function toShape(row: {
  id: string;
  unitId: string | null;
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
    unitId: row.unitId,
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
// getActiveConfig — busca o AgentConfig ativo da Unit (ou global, se nulo).
// Cria um default se não existir.
//
// CACHE: cada turno do agente chama essa função. Sem cache são ~30-100ms de
// Postgres no caminho crítico. TTL 30s — propagação rápida após salvar via
// Wizard, e `saveConfig` invalida explicitamente.
// ---------------------------------------------------------------------------

const CONFIG_TTL_MS = 30_000;
const configCache = new Map<string, { value: AgentConfigShape; expiresAt: number }>();

function configCacheKey(unitId: string | null): string {
  return unitId ?? '__global__';
}

export function invalidateActiveConfig(unitId: string | null): void {
  configCache.delete(configCacheKey(unitId));
}

/** Limpa TODO o cache de config — usado pelo endpoint admin "Limpar cache". */
export function clearAllConfigCache(): number {
  const n = configCache.size;
  configCache.clear();
  return n;
}

export async function getActiveConfig(unitId: string | null = null): Promise<AgentConfigShape> {
  const key = configCacheKey(unitId);
  const cached = configCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const active = await prisma.agentConfig.findFirst({
    where: { isActive: true, unitId },
    orderBy: { updatedAt: 'desc' },
  });
  if (active) {
    const shape = toShape(active);
    configCache.set(key, { value: shape, expiresAt: Date.now() + CONFIG_TTL_MS });
    return shape;
  }

  logger.info({ unitId }, 'AgentConfig: nenhum ativo encontrado, semeando default');
  const seeded = await prisma.agentConfig.create({
    data: {
      unitId,
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
  const shape = toShape(seeded);
  configCache.set(key, { value: shape, expiresAt: Date.now() + CONFIG_TTL_MS });
  return shape;
}

// ---------------------------------------------------------------------------
// saveConfig — upsert do "default" e garante único ativo por Unit.
// ---------------------------------------------------------------------------

export type SaveConfigInput = {
  unitId?: string | null;
  systemPrompt: string;
  tools: ToolConfig[];
  workflow: WorkflowRule[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
};

export async function saveConfig(input: SaveConfigInput): Promise<AgentConfigShape> {
  const unitId = input.unitId ?? null;
  const data = {
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    workflow: input.workflow,
    model: input.model ?? DEFAULTS.model,
    temperature: input.temperature ?? DEFAULTS.temperature,
    maxTokens: input.maxTokens ?? DEFAULTS.maxTokens,
  };

  const saved = await prisma.$transaction(async (tx) => {
    // Garante único ativo por Unit (ou global).
    await tx.agentConfig.updateMany({
      where: { isActive: true, unitId },
      data: { isActive: false },
    });

    const existing = await tx.agentConfig.findFirst({
      where: { name: 'default', unitId },
    });
    if (existing) {
      return tx.agentConfig.update({
        where: { id: existing.id },
        data: { ...data, isActive: true },
      });
    }
    return tx.agentConfig.create({
      data: { unitId, name: 'default', isActive: true, ...data },
    });
  });

  // Limpa o cache pra próxima execução pegar a versão fresca.
  invalidateActiveConfig(unitId);

  return toShape(saved);
}

// ---------------------------------------------------------------------------
// renderWorkflowGuidance — converte regras declarativas num bloco de texto
// anexado ao system prompt.
// ---------------------------------------------------------------------------

export function renderWorkflowGuidance(rules: WorkflowRule[]): string {
  if (!rules.length) return '';
  const lines = rules.map((r, i) => `${i + 1}. SE ${r.when} ENTÃO ${r.then}`);
  return `\n\nSequências de automação (siga estas regras quando aplicáveis):\n${lines.join('\n')}`;
}
