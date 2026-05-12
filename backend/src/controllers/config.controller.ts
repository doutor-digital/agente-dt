// ============================================================================
// config.controller.ts — CRUD do AgentConfig (multi-tenant).
//
// LÓGICA DE ENGENHARIA
// --------------------
// Cada Unit pode ter seu próprio AgentConfig (1:N, mas só um ativo por
// Unit). Os endpoints aceitam `unitId` na query/body. Sem unitId, opera
// no AgentConfig "global" (sem Unit) — mantém compatibilidade.
// ============================================================================

import type { Request, Response } from 'express';
import { z } from 'zod';
import { getActiveConfig, saveConfig, DEFAULTS } from '../agent/config.js';
import { logger } from '../lib/logger.js';

const KNOWN_TOOLS = ['aplicar_tag', 'mover_etapa'];

const toolSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
  description: z.string().min(1).max(2000),
});

const workflowRuleSchema = z.object({
  id: z.string().min(1),
  when: z.string().min(1).max(500),
  then: z.string().min(1).max(500),
});

const saveSchema = z.object({
  unitId: z.string().nullable().optional(),
  systemPrompt: z.string().min(10).max(20000),
  tools: z.array(toolSchema).max(20),
  workflow: z.array(workflowRuleSchema).max(50),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(8192).optional(),
});

export async function getConfig(req: Request, res: Response): Promise<void> {
  const unitId = (req.query.unitId as string | undefined) ?? null;
  const config = await getActiveConfig(unitId);

  res.json({
    config,
    knownTools: KNOWN_TOOLS,
    defaults: {
      systemPrompt: DEFAULTS.systemPrompt,
      tools: DEFAULTS.tools,
    },
  });
}

export async function putConfig(req: Request, res: Response): Promise<void> {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', issues: parsed.error.flatten() });
    return;
  }

  const tools = parsed.data.tools.filter((t) => KNOWN_TOOLS.includes(t.name));

  try {
    const saved = await saveConfig({
      unitId: parsed.data.unitId ?? null,
      systemPrompt: parsed.data.systemPrompt,
      tools,
      workflow: parsed.data.workflow,
      model: parsed.data.model,
      temperature: parsed.data.temperature,
      maxTokens: parsed.data.maxTokens,
    });
    logger.info({ id: saved.id, unitId: saved.unitId }, 'AgentConfig salvo');
    res.json({ config: saved });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'falha ao salvar AgentConfig');
    res.status(500).json({ error: 'save_failed', message: msg });
  }
}
