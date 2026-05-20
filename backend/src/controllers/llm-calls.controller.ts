// ============================================================================
// llm-calls.controller.ts — API REST das chamadas à LLM (painel "ByteGPT").
//
// LÓGICA DE ENGENHARIA
// --------------------
// Esta é a "vitrine" da observabilidade do consumo: lista todas as
// requisições à OpenAI com tokens, custo, latência e payload completo.
// Filtragem por unitId (consultoria) — o front sempre passa o unitId
// selecionado.
// ============================================================================

import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';

export async function listLlmCallsHandler(req: Request, res: Response): Promise<void> {
  // UNIT_ADMIN sempre fica preso à própria unit. SUPER_ADMIN respeita o query.
  const unitId =
    req.user?.role === 'UNIT_ADMIN'
      ? (req.user.unitId ?? '__never_match__')
      : ((req.query.unitId as string | undefined) ?? undefined);
  const traceId = (req.query.traceId as string | undefined) ?? undefined;
  const limit = Math.min(Number(req.query.limit ?? 100), 500);

  const calls = await prisma.llmCall.findMany({
    where: {
      ...(unitId ? { unitId } : {}),
      ...(traceId ? { traceId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      unitId: true,
      traceId: true,
      provider: true,
      model: true,
      endpoint: true,
      promptTokens: true,
      completionTokens: true,
      totalTokens: true,
      costUsd: true,
      latencyMs: true,
      status: true,
      errorMessage: true,
      createdAt: true,
    },
  });

  res.json({
    calls: calls.map((c) => ({
      ...c,
      costUsd: Number(c.costUsd),
    })),
  });
}

export async function getLlmCallHandler(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id ?? '');
  const call = await prisma.llmCall.findUnique({ where: { id } });
  if (!call) {
    res.status(404).json({ error: 'llm_call_not_found' });
    return;
  }
  // UNIT_ADMIN só vê chamadas da própria unit.
  if (req.user?.role === 'UNIT_ADMIN' && call.unitId !== req.user.unitId) {
    res.status(404).json({ error: 'llm_call_not_found' });
    return;
  }
  res.json({
    call: {
      ...call,
      costUsd: Number(call.costUsd),
    },
  });
}
