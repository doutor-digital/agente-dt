// ============================================================================
// lead-field-rules.controller.ts — endpoints REST das regras de captura.
//
// Mesmo padrão multi-tenant dos outros controllers de "/units/:id/...":
//  - requireUnitAccess no router já garante que SUPER ou UNIT_ADMIN da
//    própria unit acessam; outros têm 403.
//  - Aqui dentro só validamos payload + chamamos service + tratamos
//    conflitos (P2002 = tool_name duplicado na mesma unit).
//
// Endpoint extra GET /units/:id/kommo-lead-custom-fields:
//  Front consome pra popular o dropdown "Escolha um campo do Kommo".
//  Já vem filtrado (só tipos suportados) e ordenado.
// ============================================================================

import type { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  createKommoClient,
  KommoApiError,
  type KommoFieldType,
} from '../services/kommo.service.js';
import {
  createLeadFieldRule,
  deleteLeadFieldRule,
  listLeadFieldRules,
  updateLeadFieldRule,
} from '../services/lead-field-rules.service.js';

const FIELD_TYPES: KommoFieldType[] = [
  'text',
  'textarea',
  'numeric',
  'date',
  'birthday',
  'select',
  'multiselect',
  'radiobutton',
];

// toolName deve ser snake_case ASCII pra LangChain aceitar como nome de tool.
const toolNameRegex = /^[a-z][a-z0-9_]{1,48}$/;

const enumSchema = z.object({
  id: z.number().int(),
  value: z.string().min(1).max(200),
});

const ruleInputSchema = z.object({
  kommoFieldId: z.coerce.number().int().positive(),
  kommoFieldName: z.string().min(1).max(200),
  kommoFieldType: z.enum(FIELD_TYPES as [KommoFieldType, ...KommoFieldType[]]),
  kommoFieldEnums: z.array(enumSchema).max(200).nullable().optional(),
  toolName: z.string().regex(toolNameRegex, 'toolName: snake_case ASCII, começando com letra'),
  instruction: z.string().min(3).max(2000),
  valueHint: z.string().max(500).nullable().optional(),
  examples: z.array(z.string().min(1).max(300)).max(20).optional(),
  enabled: z.boolean().optional(),
});

const ruleUpdateSchema = ruleInputSchema.partial();

export async function listLeadFieldRulesHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const rules = await listLeadFieldRules(unitId);
  res.json({ rules });
}

export async function createLeadFieldRuleHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const parsed = ruleInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', issues: parsed.error.format() });
    return;
  }
  try {
    const rule = await createLeadFieldRule(unitId, parsed.data);
    logger.info({ unitId, ruleId: rule.id, toolName: rule.toolName }, 'lead field rule criada');
    res.status(201).json({ rule });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(409).json({ error: 'tool_name_already_used_in_unit' });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, unitId, module: 'lead-field-rules.controller' }, 'falha criando rule');
    res.status(500).json({ error: 'create_failed', message: msg });
  }
}

export async function updateLeadFieldRuleHandler(req: Request, res: Response): Promise<void> {
  const ruleId = String(req.params.ruleId ?? '');
  const parsed = ruleUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', issues: parsed.error.format() });
    return;
  }
  try {
    const rule = await updateLeadFieldRule(ruleId, parsed.data);
    res.json({ rule });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(409).json({ error: 'tool_name_already_used_in_unit' });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, ruleId, module: 'lead-field-rules.controller' }, 'falha atualizando rule');
    res.status(500).json({ error: 'update_failed', message: msg });
  }
}

export async function deleteLeadFieldRuleHandler(req: Request, res: Response): Promise<void> {
  const ruleId = String(req.params.ruleId ?? '');
  try {
    await deleteLeadFieldRule(ruleId);
    res.status(204).end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, ruleId, module: 'lead-field-rules.controller' }, 'falha deletando rule');
    res.status(500).json({ error: 'delete_failed', message: msg });
  }
}

// ---------------------------------------------------------------------------
// Lookup auxiliar — lista de custom fields do Kommo da unit.
// ---------------------------------------------------------------------------

export async function listKommoLeadCustomFieldsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const unit = await prisma.unit.findUnique({ where: { id: unitId } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    res.status(400).json({ error: 'kommo_not_configured' });
    return;
  }
  try {
    const client = createKommoClient(unit);
    const fields = await client.listLeadCustomFieldsTyped();
    res.json({ ok: true, fields });
  } catch (err) {
    if (err instanceof KommoApiError) {
      logger.warn({ err, unitId, module: 'lead-field-rules.controller' }, 'kommo fields lookup falhou');
      res.status(err.status ?? 502).json({
        ok: false,
        error: 'kommo_request_failed',
        message: err.message,
        kommoStatus: err.status,
        kommoBody: err.responseBody,
      });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'lookup_failed', message: msg });
  }
}
