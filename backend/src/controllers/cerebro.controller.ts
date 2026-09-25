/**
 * As rotas que o cérebro lê.
 *
 * Só leitura, de propósito: esta primeira versão relata e não escreve. Escrever campo
 * entra depois, quando o relatório tiver rodado alguns dias e a recepção tiver conferido
 * que o que ele diz é verdade. Mover etapa nunca entra.
 */
import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { panoramaDaUnidade, pacienteDoCerebro } from '../services/cerebro.service.js';

type Guarda = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

/**
 * Compara em tempo constante. Com `===`, o tempo da comparação conta quantos caracteres
 * iniciais o palpite acertou — em rede, o ruído esconde isso quase sempre, mas "quase"
 * não é argumento quando a correção cabe em cinco linhas. O comprimento vaza de qualquer
 * jeito (o `timingSafeEqual` exige buffers do mesmo tamanho), e o comprimento não é
 * segredo.
 */
function chaveConfere(dada: string | undefined): boolean {
  const esperada = env.INTERNAL_API_KEY;
  if (!esperada || !dada) return false;
  const a = Buffer.from(dada);
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Deixa a rotina das 17h entrar com CHAVE DE SERVIÇO, não com a senha de uma pessoa.
 *
 * O cérebro roda desatendido, de madrugada ou no fim da tarde, sem ninguém na frente.
 * Guardar a senha do console num cron é ruim por três motivos: ela vale pra tudo no
 * console, some junto quando a pessoa troca de senha, e fica escrita em arquivo. A
 * chave de serviço é só pra isso, dá pra girar sozinha e não abre mais nada.
 *
 * Recebe a CADEIA INTEIRA de quem guarda a rota, não só o último guarda. A primeira
 * versão recebia só o `requireUnitAccess` e ficava pendurada depois do
 * `apiRouter.use(requireAuth)` — então o `requireAuth` global respondia 401 antes de
 * alguém olhar a chave, e o caminho da chave era código morto. Quem monta a rota tem de
 * pendurá-la ANTES daquele `use`, e passar `requireAuth` aqui dentro: com chave válida
 * pulamos a cadeia toda; sem chave, ela roda inteira, na ordem, e quem abre pelo
 * navegador continua entrando logado como antes.
 */
export function chaveDeServicoOuSessao(...cadeia: Guarda[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '').trim();
    if (chaveConfere(req.header('x-internal-key') ?? bearer)) {
      next();
      return;
    }
    // O `erro` repassa o argumento pra frente: um guarda que chama `next(err)` ou
    // `next('route')` tem de chegar ao Express, não virar "siga pro próximo guarda".
    // Engolir isso transformaria uma falha em passagem livre.
    const passo = (i: number): void => {
      if (i >= cadeia.length) {
        next();
        return;
      }
      const seguir = (erro?: unknown) => (erro === undefined ? passo(i + 1) : next(erro as never));
      void Promise.resolve(cadeia[i]!(req, res, seguir as NextFunction)).catch(next);
    };
    passo(0);
  };
}

/**
 * Quem usa escreve o slug, não um cuid — mas o console chama pelo id. Aceita os dois.
 *
 * Atenção ao efeito colateral: `requireUnitAccess` compara `req.user.unitId` (um id) com
 * `req.params.id`, então um usuário comum que mande o SLUG da própria unidade toma 403,
 * mesmo sendo a unidade dele. Fica assim de propósito — falhar fechado é o lado certo de
 * errar, e quem passa slug na prática é a rotina das 17h, que entra por chave e nem
 * chega nesse guarda. O console sempre manda id.
 */
async function unidade(req: Request, res: Response) {
  const chave = String(req.params.id ?? '');
  const unit = await prisma.unit.findFirst({ where: { OR: [{ id: chave }, { slug: chave }] } });
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

/**
 * A lista que o cérebro precisa pra traduzir slug em unidade.
 *
 * Existe separada do `GET /units` de propósito: aquela fica atrás do login do console e
 * devolve a unidade inteira, credencial incluída. Esta devolve o mínimo — slug, nome e se
 * a franquia está ligada — e é a única lista que a chave de serviço abre. Assim a chave
 * do cron continua valendo só pro cérebro, que era o combinado.
 */
export async function cerebroUnidadesHandler(req: Request, res: Response): Promise<void> {
  const so = req.user && req.user.role !== 'SUPER_ADMIN' ? { id: req.user.unitId ?? '' } : {};
  const us = await prisma.unit.findMany({
    where: so,
    select: { slug: true, name: true, spineToken: true },
    orderBy: { slug: 'asc' },
  });
  res.json({
    unidades: us.map((u) => ({ slug: u.slug, nome: u.name, franquiaLigada: !!u.spineToken })),
  });
}

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
