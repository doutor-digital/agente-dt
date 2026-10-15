/**
 * A conexão de uma unidade com o Bling, no banco (`bling_conexoes`): guardar o aplicativo, gerar o link
 * de autorização, concluir a autorização no retorno e entregar um access token válido (renovando quando
 * precisa). Os tokens nunca saem daqui em resposta nem em log.
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import {
  ErroBling,
  estadoValido,
  linkDeAutorizacao,
  pedirTokens,
  precisaRenovar,
  refreshVenceEm,
  type Fetcher,
  type TokensBling,
} from './oauth.js';

export async function unidadePorSlug(slug: string): Promise<{ id: string; name: string }> {
  const u = await prisma.unit.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!u) throw new ErroBling(`unidade "${slug}" não existe`, null);
  return u;
}

/** Grava (ou troca) o aplicativo do Bling da unidade. Trocar o Client ID apaga os tokens: o app é outro. */
export async function salvarAppDoBling(slug: string, clientId: string, clientSecret: string): Promise<void> {
  const id = clientId.trim();
  const segredo = clientSecret.trim();
  if (!id || !segredo) throw new ErroBling('Client ID e Client Secret são obrigatórios', null);
  const u = await unidadePorSlug(slug);
  const atual = await prisma.blingConexao.findUnique({ where: { unitId: u.id }, select: { clientId: true } });
  const mesmoApp = atual?.clientId === id;
  await prisma.blingConexao.upsert({
    where: { unitId: u.id },
    create: { unitId: u.id, clientId: id, clientSecret: segredo },
    update: mesmoApp
      ? { clientSecret: segredo }
      // App novo: tokens e qualquer link de autorização pendente eram do app antigo.
      : { clientId: id, clientSecret: segredo, accessToken: null, refreshToken: null, expiraEm: null, refreshEm: null, escopos: null, conectadoEm: null, conectadoPor: null, estado: null, estadoEm: null, ultimoErro: null },
  });
}

/** Gera um `state` novo e devolve o link que o administrador do Bling deve abrir. `quem` = quem pediu o link. */
export async function iniciarAutorizacao(slug: string, quem: string): Promise<{ link: string; unidade: string }> {
  const u = await unidadePorSlug(slug);
  const c = await prisma.blingConexao.findUnique({ where: { unitId: u.id }, select: { clientId: true } });
  if (!c) throw new ErroBling(`a unidade "${slug}" ainda não tem o aplicativo do Bling gravado`, null);
  const estado = randomBytes(24).toString('base64url');
  await prisma.blingConexao.update({ where: { unitId: u.id }, data: { estado, estadoEm: new Date(), conectadoPor: quem.slice(0, 120) } });
  return { link: linkDeAutorizacao(c.clientId, estado), unidade: u.name };
}

async function gravarTokens(unitId: string, t: TokensBling, extra: Record<string, unknown> = {}): Promise<void> {
  await prisma.blingConexao.update({
    where: { unitId },
    data: { accessToken: t.accessToken, refreshToken: t.refreshToken, expiraEm: t.expiraEm, refreshEm: new Date(), escopos: t.escopos, ultimoErro: null, ...extra },
  });
}

/** Retorno do Bling: confere o `state`, troca o código pelos tokens e grava. Devolve o nome da unidade. */
export async function concluirAutorizacao(estado: string, code: string, fetcher: Fetcher = fetch): Promise<string> {
  if (!estado || !code) throw new ErroBling('o retorno do Bling veio sem código ou sem state', null);
  const c = await prisma.blingConexao.findUnique({ where: { estado }, include: { unit: { select: { name: true, slug: true } } } });
  if (!c) throw new ErroBling('este link de autorização não é nosso ou já foi usado — gere um novo', null);
  // Reserva o `state` ANTES de ir ao Bling: um segundo retorno com o mesmo link (aba recarregada,
  // pré-carregamento do navegador) não passa daqui nem estraga o status de quem conectou.
  const reservado = await prisma.blingConexao.updateMany({ where: { unitId: c.unitId, estado }, data: { estado: null, estadoEm: null } });
  if (reservado.count === 0) throw new ErroBling('este link de autorização já foi usado — se a conexão não aparecer, gere um novo', null);
  if (!estadoValido(c.estadoEm)) throw new ErroBling('o link de autorização venceu (10 min) — gere um novo', null);
  try {
    const t = await pedirTokens({ clientId: c.clientId, clientSecret: c.clientSecret }, { grant_type: 'authorization_code', code }, fetcher);
    await gravarTokens(c.unitId, t, { conectadoEm: new Date() });
    logger.info({ unit: c.unit.slug, escopos: t.escopos?.split(/\s+/).length ?? 0 }, 'bling: unidade conectada');
    return c.unit.name;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.blingConexao.update({ where: { unitId: c.unitId }, data: { ultimoErro: msg } });
    throw err;
  }
}

// Uma renovação por unidade de cada vez neste processo: duas trocas com o mesmo refresh token
// fariam a segunda falhar (o Bling devolve um par novo e o antigo deixa de valer).
const renovando = new Map<string, Promise<string>>();

/**
 * Troca o refresh token por um par novo e grava. Compare-and-set no refresh token: se outro processo
 * renovou no meio do caminho, usa o que ele gravou em vez de sobrescrever.
 */
export function renovar(unitId: string, fetcher: Fetcher = fetch): Promise<string> {
  const emCurso = renovando.get(unitId);
  if (emCurso) return emCurso;
  const p = (async () => {
    const c = await prisma.blingConexao.findUnique({ where: { unitId } });
    if (!c?.refreshToken) throw new ErroBling('Bling não autorizado nesta unidade', null, true);
    const usado = c.refreshToken;
    try {
      const t = await pedirTokens({ clientId: c.clientId, clientSecret: c.clientSecret }, { grant_type: 'refresh_token', refresh_token: usado }, fetcher);
      const r = await prisma.blingConexao.updateMany({
        where: { unitId, refreshToken: usado },
        data: { accessToken: t.accessToken, refreshToken: t.refreshToken, expiraEm: t.expiraEm, refreshEm: new Date(), escopos: t.escopos, ultimoErro: null },
      });
      if (r.count === 0) {
        const agora = await prisma.blingConexao.findUnique({ where: { unitId }, select: { accessToken: true } });
        if (agora?.accessToken) return agora.accessToken;
      }
      return t.accessToken;
    } catch (err) {
      const morto = err instanceof ErroBling && err.precisaReautorizar;
      // Outro processo pode ter renovado com este mesmo refresh token (o Bling troca o par e recusa o
      // antigo). Se for isso, o banco muda em instantes: espera um pouco e usa o que ele gravou.
      if (morto) await new Promise((r) => setTimeout(r, 1500));
      const agora = await prisma.blingConexao.findUnique({ where: { unitId }, select: { refreshToken: true, accessToken: true } });
      if (agora?.refreshToken && agora.refreshToken !== usado && agora.accessToken) return agora.accessToken;
      const msg = err instanceof Error ? err.message : String(err);
      if (morto) {
        // Refresh token vencido ou revogado: não serve mais. Limpa (o worker para de insistir e o status
        // mostra "precisa autorizar de novo") — só se ainda for o mesmo que falhou.
        await prisma.blingConexao.updateMany({
          where: { unitId, refreshToken: usado },
          data: { accessToken: null, refreshToken: null, expiraEm: null, ultimoErro: `precisa autorizar de novo: ${msg}` },
        });
      } else {
        await prisma.blingConexao.update({ where: { unitId }, data: { ultimoErro: msg } });
      }
      throw err;
    }
  })().finally(() => renovando.delete(unitId));
  renovando.set(unitId, p);
  return p;
}

/** Um access token válido para chamar a API (renova se faltar pouco para vencer). */
export async function tokenDeAcesso(unitId: string, fetcher: Fetcher = fetch): Promise<string> {
  const c = await prisma.blingConexao.findUnique({ where: { unitId }, select: { accessToken: true, expiraEm: true, refreshToken: true } });
  if (!c?.refreshToken) throw new ErroBling('Bling não autorizado nesta unidade', null, true);
  if (c.accessToken && !precisaRenovar(c.expiraEm, new Date(), 5)) return c.accessToken;
  try {
    return await renovar(unitId, fetcher);
  } catch (err) {
    // Falha passageira na renovação (Bling fora, rede): o token atual ainda vale por alguns minutos — usa.
    const vale = c.accessToken && c.expiraEm && c.expiraEm.getTime() - Date.now() > 30_000;
    if (vale && !(err instanceof ErroBling && err.precisaReautorizar)) {
      logger.warn({ unitId, err: String(err) }, 'bling: renovação falhou, uso o token atual enquanto vale');
      return c.accessToken as string;
    }
    throw err;
  }
}

export interface StatusBling {
  unidade: string;
  temApp: boolean;
  conectado: boolean;
  /** Já foi conectado e caiu (token vencido ou revogado): um administrador do Bling precisa autorizar de novo. */
  precisaReautorizar: boolean;
  conectadoPor: string | null;
  conectadoEm: Date | null;
  tokenVenceEm: Date | null;
  reautorizarAte: Date | null;
  escopos: number;
  ultimoErro: string | null;
}

/** Situação da conexão, sem nenhum segredo. */
export async function statusDoBling(slug: string): Promise<StatusBling> {
  const u = await unidadePorSlug(slug);
  const c = await prisma.blingConexao.findUnique({ where: { unitId: u.id } });
  return {
    unidade: u.name,
    temApp: !!c,
    conectado: !!c?.refreshToken,
    precisaReautorizar: !!c && !c.refreshToken && !!c.conectadoEm,
    conectadoPor: c?.conectadoPor ?? null,
    conectadoEm: c?.conectadoEm ?? null,
    tokenVenceEm: c?.expiraEm ?? null,
    reautorizarAte: c?.refreshEm ? refreshVenceEm(c.refreshEm) : null,
    escopos: c?.escopos ? c.escopos.split(/\s+/).filter(Boolean).length : 0,
    ultimoErro: c?.ultimoErro ?? null,
  };
}
