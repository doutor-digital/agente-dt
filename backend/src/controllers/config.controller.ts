// ============================================================================
// config.controller.ts — CRUD do AgentConfig.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Endpoints simples, sem auth (mesma fronteira que /api/traces — projeto
// é interno e rodado atrás de VPN; auth está no roadmap).
//
// Validação via Zod no boundary HTTP. Internamente trabalhamos com tipos
// canônicos definidos em agent/config.ts.
// ============================================================================

import type { Request, Response } from 'express';
import { z } from 'zod';
import { getActiveConfig, saveConfig, DEFAULTS } from '../agent/config.js';
import { logger } from '../lib/logger.js';

// Lista de tools "conhecidas" pelo código. O front usa pra mostrar quais
// tools existem mesmo que o config no banco esteja vazio.
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
  systemPrompt: z.string().min(10).max(20000),
  tools: z.array(toolSchema).max(20),
  workflow: z.array(workflowRuleSchema).max(50),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(8192).optional(),
});

export async function getConfig(_req: Request, res: Response): Promise<void> {
  const config = await getActiveConfig();

  // Anexa lista de tools "registradas no código" — o front merge com o que
  // está salvo no banco pra garantir que tools novas apareçam pro usuário.
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

  // Sanitiza tools: só aceita nomes que o código conhece.
  const tools = parsed.data.tools.filter((t) => KNOWN_TOOLS.includes(t.name));

  try {
    const saved = await saveConfig({
      systemPrompt: parsed.data.systemPrompt,
      tools,
      workflow: parsed.data.workflow,
      model: parsed.data.model,
      temperature: parsed.data.temperature,
      maxTokens: parsed.data.maxTokens,
    });
    logger.info({ id: saved.id }, 'AgentConfig salvo');
    res.json({ config: saved });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'falha ao salvar AgentConfig');
    res.status(500).json({ error: 'save_failed', message: msg });
  }
}
