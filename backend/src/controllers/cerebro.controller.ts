/**
 * As rotas que o cérebro lê.
 *
 * Só leitura, de propósito: esta primeira versão relata e não escreve. Escrever campo
 * entra depois, quando o relatório tiver rodado alguns dias e a recepção tiver conferido
 * que o que ele diz é verdade. Mover etapa nunca entra.
 */
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { panoramaDaUnidade, pacienteDoCerebro } from '../services/cerebro.service.js';

async function unidade(req: Request, res: Response) {
  const id = String(req.params.id ?? '');
  const unit = await prisma.unit.findUnique({ where: { id } });
  if (!unit) {
    res.status(404).json({ error: 'unit_not_found' });
    return null;
  }
  if (!unit.spineToken) {
    res.status(409).json({ error: 'sem_token_da_franquia', unidade: unit.slug });
    return null;
  }
  return unit;
}

const inteiro = (v: unknown, padrao: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : padrao;
};

export async function cerebroPanoramaHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidade(req, res);
  if (!unit) return;
  try {
    const pano = await panoramaDaUnidade(unit, {
      dias: inteiro(req.query.dias, 60),
      meses: inteiro(req.query.meses, 6),
    });
    res.json(pano);
  } catch (err) {
    logger.error({ err: String(err), unit: unit.slug }, 'cérebro: panorama falhou');
    res.status(502).json({ error: 'franquia_indisponivel', detalhe: String(err).slice(0, 200) });
  }
}

export async function cerebroPacienteHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidade(req, res);
  if (!unit) return;
  const busca = String(req.query.busca ?? '').trim();
  if (!busca) {
    res.status(400).json({ error: 'busca_vazia', comoUsar: '?busca=<nome ou telefone>' });
    return;
  }
  try {
    const p = await pacienteDoCerebro(unit, busca, {
      dias: inteiro(req.query.dias, 60),
      meses: inteiro(req.query.meses, 6),
    });
    if (!p) {
      res.status(404).json({ error: 'nao_encontrado', busca });
      return;
    }
    res.json(p);
  } catch (err) {
    logger.error({ err: String(err), unit: unit.slug }, 'cérebro: ficha do paciente falhou');
    res.status(502).json({ error: 'franquia_indisponivel', detalhe: String(err).slice(0, 200) });
  }
}
