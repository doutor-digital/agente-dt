/**
 * As rotas que o cérebro lê.
 *
 * Só leitura, de propósito: esta primeira versão relata e não escreve. Escrever campo
 * entra depois, quando o relatório tiver rodado alguns dias e a recepção tiver conferido
 * que o que ele diz é verdade. Mover etapa nunca entra.
 */
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { panoramaDaUnidade, pacienteDoCerebro } from '../services/cerebro.service.js';

/**
 * Deixa a rotina das 17h entrar com CHAVE DE SERVIÇO, não com a senha de uma pessoa.
 *
 * O cérebro roda desatendido, de madrugada ou no fim da tarde, sem ninguém na frente.
 * Guardar a senha do console num cron é ruim por três motivos: ela vale pra tudo no
 * console, some junto quando a pessoa troca de senha, e fica escrita em arquivo. A
 * chave de serviço é só pra isso, dá pra girar sozinha e não abre mais nada.
 *
 * Mesmo padrão de `sla-report` e `session-stats`. Sem chave válida, a requisição
 * simplesmente segue pro caminho de sempre (sessão do console) — quem abre a rota pelo
 * navegador continua entrando logado, como antes.
 */
export function chaveDeServicoOuSessao(
  adiante: (req: Request, res: Response, next: NextFunction) => void,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '').trim();
    const dada = req.header('x-internal-key') ?? bearer;
    if (env.INTERNAL_API_KEY && dada === env.INTERNAL_API_KEY) {
      next();
      return;
    }
    adiante(req, res, next);
  };
}

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
