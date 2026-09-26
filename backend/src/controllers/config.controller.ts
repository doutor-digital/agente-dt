import type { Request, Response } from 'express';
import { z } from 'zod';
import { getActiveConfig, saveConfig, DEFAULTS } from '../agent/config.js';
import { composeFlattenedPromptForUnit } from '../agent/prompt-composer.js';
import { findUnitById } from '../services/units.service.js';
import { logger } from '../lib/logger.js';

const KNOWN_TOOLS = ['aplicar_tag', 'mover_etapa', 'pausar_ia', 'atualizar_titulo_lead'];

/**
 * Resolve qual unidade a chamada pode tocar — o mesmo desenho de reports.controller.
 *
 * As rotas `/config*` só tinham `requireAuth`: aceitavam `unitId` do query/corpo e
 * NÃO conferiam a unidade. Um UNIT_ADMIN da clínica A mandava `?unitId=<clínica B>`
 * e lia (GET) ou SOBRESCREVIA (PUT) o system_prompt de outra clínica — o cérebro da
 * IA que fala com paciente. `unitId: null` é a config GLOBAL (vale pra todas): só o
 * SUPER_ADMIN mexe nela.
 *
 * SUPER_ADMIN: qualquer unitId, inclusive null (global). UNIT_ADMIN: travado na
 * própria unidade, o `unitId` recebido é ignorado. `null` de unitId de usuário
 * (não deveria acontecer com UNIT_ADMIN) cai em sentinela que não casa com nada.
 */
export function resolveConfigUnitId(req: Request, pedido: string | null | undefined): string | null {
  const user = req.user!;
  if (user.role === 'SUPER_ADMIN') {
    return pedido ?? null;
  }
  return user.unitId ?? '__never_match__';
}

const toolSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
  description: z.string().min(1).max(2000),
});

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
  const unitId = resolveConfigUnitId(req, (req.query.unitId as string | undefined) ?? null);
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

export async function getFlattenedPrompt(req: Request, res: Response): Promise<void> {
  const unitId = resolveConfigUnitId(req, (req.query.unitId as string | undefined) ?? null);
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

  // Trava a escrita na unidade que o usuário pode tocar: UNIT_ADMIN nunca grava
  // config de outra clínica nem a global (null). O `unitId` do corpo é ignorado
  // pra quem não é SUPER_ADMIN.
  const unitId = resolveConfigUnitId(req, parsed.data.unitId ?? null);
  if (unitId === '__never_match__') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  try {
    const saved = await saveConfig({
      unitId,
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
