/**
 * Carga de implantação, pela API: prévia e aplicação.
 *
 * Duas rotas, e a diferença entre elas é de propósito difícil de errar: a prévia é GET e não escreve
 * nada; aplicar é POST e exige `aplicar: true` no corpo. Sem esse campo, o POST também só simula —
 * mesmo molde do faxina-inbox, e pela mesma razão: não existe apagar lead por API, então o padrão
 * tem de ser o que não faz estrago.
 *
 * Só superadmin (equipe DD). É operação de implantação, não do dia a dia da unidade — decisão do
 * João em 28/09/2026, quando desenhamos isso a partir do caso de Petrópolis.
 */
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { aplicarCarga, previaDaCarga } from '../services/franquia-carga.service.js';
import { grupoDaUnidade, rotulosDoGrupo } from '../lib/crm-compartilhado.js';

async function carregarUnidade(req: Request) {
  const id = String(req.params.id ?? '');
  if (!id) return null;
  return prisma.unit.findFirst({ where: { OR: [{ id }, { slug: id }] } });
}

/** Meses para trás, se quem chamou pediu. Fora de 1..12 é erro de digitação, não intenção. */
function mesesDe(v: unknown): number | undefined {
  // `Number('')` é 0, que é finito: sem esta guarda, `?meses=` vazio virava 1 mês em vez do padrão
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(Math.max(Math.trunc(n), 1), 12);
}

/**
 * Kommo dividido (Petrópolis + Caxias): a carga cria cartão a partir da franquia, e cartão novo sem a ⌂ Unidade de
 * atendimento não é de ninguém (foi assim que nasceram os 180 cartões sem unidade). Até a carga aprender a preencher o
 * campo, ela não roda nessas contas — nem a prévia, que lê o Kommo da unidade (a irmã não tem Kommo próprio).
 */
async function cargaBarrada(unitId: string, res: Response): Promise<boolean> {
  const grupo = await grupoDaUnidade(unitId);
  if (!grupo) return false;
  res.status(409).json({
    error: 'crm_compartilhado',
    detalhe: `Esta unidade divide o Kommo com outra (${rotulosDoGrupo(grupo)}) e a carga ainda não preenche a ⌂ Unidade de atendimento dos cartões que cria.`,
  });
  return true;
}

export async function previaCargaHandler(req: Request, res: Response): Promise<void> {
  const unit = await carregarUnidade(req);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  if (!unit.spineEnabled || !unit.spineToken) {
    res.status(422).json({ error: 'franquia_nao_ligada', detalhe: 'a unidade precisa de spineEnabled e token da franquia' });
    return;
  }
  if (await cargaBarrada(unit.id, res)) return;
  const previa = await previaDaCarga(unit, { meses: mesesDe(req.query.meses) });
  res.json(previa);
}

export async function aplicarCargaHandler(req: Request, res: Response): Promise<void> {
  const unit = await carregarUnidade(req);
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return;
  }
  if (!unit.spineEnabled || !unit.spineToken) {
    res.status(422).json({ error: 'franquia_nao_ligada' });
    return;
  }
  if (await cargaBarrada(unit.id, res)) return;
  const opts = { meses: mesesDe(req.body?.meses) };

  // sem `aplicar: true` explícito, o POST devolve a prévia — o padrão nunca escreve
  if (req.body?.aplicar !== true) {
    res.json({ simulado: true, ...(await previaDaCarga(unit, opts)) });
    return;
  }

  const r = await aplicarCarga(unit, opts);
  if ('bloqueio' in r) {
    res.status(409).json({ error: 'bloqueado', detalhe: r.bloqueio });
    return;
  }
  res.json({ simulado: false, ...r });
}
