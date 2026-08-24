import type { Unit } from '@prisma/client';
import type { KommoClient } from '../services/kommo.service.js';
import { logger } from './logger.js';

const TTL_MS = 30 * 60_000;

export interface EsquemaKommo {
  campoPorNome: (nome: string) => number | null;
  camposPorNome: (nome: string) => number[];
  pipelinePorNome: (nome: string) => number | null;
  statusPorNome: (pipeline: string, status: string) => number | null;
}

export function normalizarNome(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

export function montarEsquema(
  campos: Array<{ id: number; name: string }>,
  pipelines: Array<{ id: number; name: string; statuses: Array<{ id: number; name: string }> }>,
): EsquemaKommo {
  const porNome = new Map<string, number[]>();
  for (const c of campos) {
    const k = normalizarNome(c.name);
    porNome.set(k, [...(porNome.get(k) ?? []), c.id]);
  }
  const pipes = new Map<string, { id: number; statuses: Map<string, number> }>();
  for (const p of pipelines) {
    const sts = new Map<string, number>();
    for (const s of p.statuses ?? []) sts.set(normalizarNome(s.name), s.id);
    pipes.set(normalizarNome(p.name), { id: p.id, statuses: sts });
  }

  const camposPorNome = (nome: string) => porNome.get(normalizarNome(nome)) ?? [];
  return {
    camposPorNome,
    campoPorNome: (nome) => camposPorNome(nome)[0] ?? null,
    pipelinePorNome: (nome) => pipes.get(normalizarNome(nome))?.id ?? null,
    statusPorNome: (pipeline, status) =>
      pipes.get(normalizarNome(pipeline))?.statuses.get(normalizarNome(status)) ?? null,
  };
}

const cache = new Map<string, { esquema: EsquemaKommo; expiraEm: number }>();

export async function esquemaDaUnidade(unit: Unit, kommo: KommoClient): Promise<EsquemaKommo> {
  const guardado = cache.get(unit.id);
  if (guardado && guardado.expiraEm > Date.now()) return guardado.esquema;

  const [bruto, pipelines] = await Promise.all([kommo.listLeadCustomFields(), kommo.listPipelines()]);
  const campos =
    (bruto as { _embedded?: { custom_fields?: Array<{ id: number; name: string }> } })?._embedded
      ?.custom_fields ?? [];
  const esquema = montarEsquema(
    campos,
    pipelines.map((p) => ({ id: p.id, name: p.name, statuses: p.statuses ?? [] })),
  );
  cache.set(unit.id, { esquema, expiraEm: Date.now() + TTL_MS });
  logger.info({ unit: unit.slug, campos: campos.length, funis: pipelines.length }, 'kommo-schema: esquema carregado');
  return esquema;
}

export function limparCacheEsquema(unitId?: string): void {
  if (unitId) cache.delete(unitId);
  else cache.clear();
}
