import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

export type ToolConfig = {
  name: string;
  enabled: boolean;
  description: string;
};

export type AgentConfigShape = {
  id: string;
  unitId: string | null;
  name: string;
  isActive: boolean;
  systemPrompt: string;
  tools: ToolConfig[];
  model: string;
  temperature: number;
  maxTokens: number;
  updatedAt: Date;
};

const DEFAULT_SYSTEM_PROMPT = `Você é um agente de qualificação de leads do CRM Kommo.

Sua missão: analisar o lead recebido e tomar UMA ação prática usando as tools disponíveis.

Regras:
- Sempre que possível, chame UMA tool (aplicar_tag, mover_etapa ou pausar_ia) em vez de só conversar.
- Use a tag "Quente" para leads com sinais claros de interesse (orçamento, urgência, decisor).
- Use a tag "Frio" para leads que pediram pra não ser contatados ou sem fit.
- Use pausar_ia SÓ quando o paciente pedir explicitamente um humano/atendente, demonstrar irritação clara, ou numa emergência (red flag). NÃO pause por dor comum ou dor que piorou.
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
      'Kommo. Use SOMENTE quando o paciente PEDIR EXPLICITAMENTE falar com um ' +
      'humano/atendente, demonstrar irritação clara, ou numa EMERGÊNCIA médica ' +
      '(red flag). NÃO pause por dor, dor que piorou, urgência de tratamento ou ' +
      'resposta de follow-up — atender e reativar quem sente dor é o trabalho ' +
      'normal do agente, não motivo de transferência.',
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
  {
    name: 'criar_tarefa',
    enabled: true,
    description:
      'Cria uma tarefa no Kommo vinculada ao lead, com prazo e (opcional) ' +
      'responsável. Use pra delegar follow-up ao SDR — ex: "ligar amanhã às ' +
      '14h", "confirmar consulta em 2 dias". A tarefa não envia mensagem ao paciente.',
  },
  {
    name: 'atribuir_responsavel',
    enabled: true,
    description:
      'Define o usuário Kommo responsável pelo lead (transferência de dono). ' +
      'Use quando o caso precisa de uma pessoa específica (ex: caso clínico ' +
      '→ Dra. Ana). Combine com pausar_ia pra humano assumir a conversa.',
  },
  {
    name: 'remover_tag',
    enabled: true,
    description:
      'Remove uma tag específica do lead no Kommo. Use pra limpar classificações ' +
      'antigas — ex: lead estava "Frio" e voltou engajado → remover "Frio". ' +
      'Idempotente: remover tag inexistente é no-op.',
  },
  {
    name: 'definir_valor_lead',
    enabled: true,
    description:
      'Define o valor (price) do lead no Kommo. Use quando o paciente confirma ' +
      'um procedimento/plano com preço conhecido. Alimenta as métricas de ' +
      'pipeline em dinheiro no dashboard.',
  },
  {
    name: 'fechar_lead',
    enabled: true,
    description:
      'Fecha o lead como VENDA REALIZADA (won) ou VENDA PERDIDA (lost). Use ' +
      'em momentos de encerramento explícito — paciente confirmou pagamento ' +
      'OU desistiu definitivamente. Pra lost, pode passar lossReasonId.',
  },
  {
    name: 'mover_funil',
    enabled: true,
    description:
      'Move o lead pra OUTRO funil inteiro no Kommo (não apenas etapa). Use ' +
      'quando muda o contexto — ex: lead que fechou venda volta com nova demanda ' +
      '→ mover do funil "Captação" pro "Pós-venda".',
  },
];

export const DEFAULTS = {
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  tools: DEFAULT_TOOLS,
  model: 'gpt-4o-mini',
  temperature: 0,
  maxTokens: 1024,
};

function toShape(row: {
  id: string;
  unitId: string | null;
  name: string;
  isActive: boolean;
  systemPrompt: string;
  tools: unknown;
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
    model: row.model,
    temperature: row.temperature,
    maxTokens: row.maxTokens,
    updatedAt: row.updatedAt,
  };
}

const CONFIG_TTL_MS = 30_000;
const configCache = new Map<string, { value: AgentConfigShape; expiresAt: number }>();

function configCacheKey(unitId: string | null): string {
  return unitId ?? '__global__';
}

export function invalidateActiveConfig(unitId: string | null): void {
  configCache.delete(configCacheKey(unitId));
}

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
      model: DEFAULTS.model,
      temperature: DEFAULTS.temperature,
      maxTokens: DEFAULTS.maxTokens,
    },
  });
  const shape = toShape(seeded);
  configCache.set(key, { value: shape, expiresAt: Date.now() + CONFIG_TTL_MS });
  return shape;
}

export type SaveConfigInput = {
  unitId?: string | null;
  systemPrompt: string;
  tools: ToolConfig[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
};

export async function saveConfig(input: SaveConfigInput): Promise<AgentConfigShape> {
  const unitId = input.unitId ?? null;
  const data = {
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    model: input.model ?? DEFAULTS.model,
    temperature: input.temperature ?? DEFAULTS.temperature,
    maxTokens: input.maxTokens ?? DEFAULTS.maxTokens,
  };

  const saved = await prisma.$transaction(async (tx) => {
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

  invalidateActiveConfig(unitId);

  return toShape(saved);
}

