/** O armazém do OAuth no Postgres. Separado de `armazem.ts` pra os testes não carregarem o Prisma. */
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import type { ArmazemOAuth, TokenGuardado } from './armazem.js';

export const armazemPrisma: ArmazemOAuth = {
  async pegarCliente(clientId) {
    const c = await prisma.mcpOauthClient.findUnique({ where: { clientId } });
    return c ? (c.dados as unknown as OAuthClientInformationFull) : undefined;
  },
  async salvarCliente(cliente) {
    await prisma.mcpOauthClient.create({
      data: { clientId: cliente.client_id, dados: cliente as unknown as Prisma.InputJsonValue },
    });
  },
  async salvarCodigo(codigo) {
    await prisma.mcpOauthCodigo.create({ data: codigo });
  },
  async lerCodigo(codigoHash) {
    return (await prisma.mcpOauthCodigo.findUnique({ where: { codigoHash } })) ?? undefined;
  },
  async usarCodigo(codigoHash, agora) {
    const r = await prisma.mcpOauthCodigo.updateMany({
      where: { codigoHash, usadoEm: null, expiraEm: { gt: agora } },
      data: { usadoEm: agora },
    });
    return r.count === 1;
  },
  async salvarToken(token) {
    await prisma.mcpOauthToken.create({ data: token });
  },
  async lerToken(tokenHash) {
    const t = await prisma.mcpOauthToken.findUnique({ where: { tokenHash } });
    return t ? { ...t, tipo: t.tipo as TokenGuardado['tipo'] } : undefined;
  },
  async revogarSeAtivo(tokenHash, agora) {
    const r = await prisma.mcpOauthToken.updateMany({ where: { tokenHash, revogadoEm: null }, data: { revogadoEm: agora } });
    return r.count === 1;
  },
  async revogarConcessao(concessaoId, agora) {
    await prisma.mcpOauthToken.updateMany({ where: { concessaoId, revogadoEm: null }, data: { revogadoEm: agora } });
  },
  async auditar(r) {
    await prisma.mcpAuditoria.create({
      data: {
        userId: r.userId,
        clientId: r.clientId,
        ferramenta: r.ferramenta,
        argumentos: (r.argumentos ?? {}) as Prisma.InputJsonValue,
        ok: r.ok,
        duracaoMs: r.duracaoMs,
        erro: r.erro?.slice(0, 2000),
      },
    });
  },
};
