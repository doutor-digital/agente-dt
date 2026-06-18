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
import { composeFlattenedPromptForUnit } from '../agent/prompt-composer.js';
import { findUnitById } from '../services/units.service.js';
import { logger } from '../lib/logger.js';

const KNOWN_TOOLS = ['aplicar_tag', 'mover_etapa', 'pausar_ia', 'atualizar_titulo_lead'];

const toolSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
  description: z.string().min(1).max(2000),
});

// workflow declarativo aposentado — substituído por UnitAction. Continuamos
// aceitando o campo no payload (e ignorando) por 1-2 ciclos pra clientes antigos
// não quebrarem ao salvar — o front atual já não envia.
const saveSchema = z.object({
  unitId: z.string().nullable().optional(),
  systemPrompt: z.string().min(10).max(20000),
  tools: z.array(toolSchema).max(20),
  workflow: z.unknown().optional(),
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

// "Centralizar no prompt": achata a config atual da unidade (persona, fontes,
// regras, toggles, ações, templates) num texto único e devolve pro front
// preencher o editor. NÃO persiste nada — o usuário revisa e salva. Read-only.
export async function getFlattenedPrompt(req: Request, res: Response): Promise<void> {
  const unitId = (req.query.unitId as string | undefined) ?? null;
  if (!unitId) {
    res.status(400).json({ error: 'unitId_required' });
    return;
  }
  const unit = await findUnitById(unitId);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  try {
    const config = await getActiveConfig(unitId);
    const prompt = await composeFlattenedPromptForUnit({
      unit,
      agentConfigPrompt: config.systemPrompt,
    });
    res.json({ prompt });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, unitId }, 'falha ao achatar prompt');
    res.status(500).json({ error: 'flatten_failed', message: msg });
  }
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
