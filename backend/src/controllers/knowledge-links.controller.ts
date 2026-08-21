import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import {
  listLinks,
  createLink,
  deleteLink,
  processarLink,
  urlPermitida,
} from '../services/knowledge-links.service.js';

export async function listKnowledgeLinksHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  res.json({ links: await listLinks(unitId) });
}

export async function createKnowledgeLinkHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const url = String(req.body?.url ?? '').trim();
  if (!urlPermitida(url)) {
    res.status(400).json({ error: 'Cole um link válido começando com http:// ou https://.' });
    return;
  }
  const unit = await prisma.unit.findUnique({ where: { id: unitId } });
  if (!unit) {
    res.status(404).json({ error: 'Unidade não encontrada.' });
    return;
  }
  const link = await createLink(unitId, url);
  const resultado = await processarLink(unit, link.id);
  const atualizado = await prisma.knowledgeLink.findUnique({ where: { id: link.id } });
  res.json({ link: atualizado, resultado });
}

export async function reprocessKnowledgeLinkHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const linkId = String(req.params.linkId ?? '');
  const unit = await prisma.unit.findUnique({ where: { id: unitId } });
  if (!unit) {
    res.status(404).json({ error: 'Unidade não encontrada.' });
    return;
  }
  const resultado = await processarLink(unit, linkId);
  const link = await prisma.knowledgeLink.findFirst({ where: { id: linkId, unitId } });
  res.json({ link, resultado });
}

export async function deleteKnowledgeLinkHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const linkId = String(req.params.linkId ?? '');
  const count = await deleteLink(unitId, linkId);
  res.json({ ok: count > 0 });
}
