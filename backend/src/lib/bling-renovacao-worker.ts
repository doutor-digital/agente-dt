/**
 * Mantém viva a conexão com o Bling (HM Tecnologia, 15/10/2026).
 *
 * O access token do Bling dura ~6 h e o refresh token 30 dias. Se ninguém usar a API por 30 dias, a
 * conexão cai e um administrador do Bling precisa autorizar de novo. Este worker troca o par antes do
 * access token vencer — cada troca traz um refresh token novo, então os 30 dias recomeçam sempre.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { renovar } from './bling/conexao.js';
import { ErroBling, MARGEM_RENOVACAO_MIN } from './bling/oauth.js';

const SWEEP_MS = 15 * 60_000;

let timer: NodeJS.Timeout | null = null;
let rodando = false;

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const limite = new Date(Date.now() + MARGEM_RENOVACAO_MIN * 60_000);
    const vencendo = await prisma.blingConexao.findMany({
      where: { refreshToken: { not: null }, OR: [{ expiraEm: null }, { expiraEm: { lte: limite } }] },
      select: { unitId: true, unit: { select: { slug: true } } },
    });
    for (const c of vencendo) {
      try {
        await renovar(c.unitId);
        logger.info({ unit: c.unit.slug }, 'bling: token renovado');
      } catch (err) {
        const reautorizar = err instanceof ErroBling && err.precisaReautorizar;
        logger.warn({ unit: c.unit.slug, err: String(err), reautorizar }, reautorizar
          ? 'bling: a conexão caiu — um administrador do Bling precisa autorizar de novo'
          : 'bling: renovação falhou, tento na próxima volta');
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'bling: varredura de renovação falhou');
  } finally {
    rodando = false;
  }
}

export function startBlingRenovacaoWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  void varrer();
  logger.info('bling: worker de renovação iniciado');
}

export function stopBlingRenovacaoWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
