/** `BancoConvites` de verdade, sobre a tabela `nova_clinica_convite` do banco do agente. */
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import type { BancoConvites } from './convites.js';

export const bancoConvitesPrisma: BancoConvites = {
  async criar(d) {
    const r = await prisma.novaClinicaConvite.create({ data: { codigoHash: d.codigoHash, rotulo: d.rotulo, criadoPor: d.criadoPor, expiraEm: d.expiraEm }, select: { id: true } });
    return { id: r.id };
  },
  async achar(codigoHash) {
    return prisma.novaClinicaConvite.findUnique({ where: { codigoHash }, select: { id: true, expiraEm: true, enviadoEm: true } });
  },
  async enviar(d) {
    // reivindicação atômica: o UPDATE só casa se o convite ainda está aberto; dois envios ao mesmo tempo, um só vê count = 1
    const r = await prisma.novaClinicaConvite.updateMany({
      where: { codigoHash: d.codigoHash, enviadoEm: null, expiraEm: { gt: d.agora } },
      data: { enviadoEm: d.agora, respostas: d.respostas as unknown as Prisma.InputJsonValue, slugSugerido: d.slugSugerido },
    });
    if (r.count !== 1) return null;
    const c = await prisma.novaClinicaConvite.findUnique({ where: { codigoHash: d.codigoHash }, select: { id: true } });
    return c ? { id: c.id } : null;
  },
  async listar() {
    return prisma.novaClinicaConvite.findMany({
      orderBy: { criadoEm: 'desc' },
      take: 100,
      select: { id: true, rotulo: true, criadoPor: true, criadoEm: true, expiraEm: true, enviadoEm: true, importadoEm: true, slugSugerido: true },
    });
  },
  async revogar(id, agora) {
    // não apaga: só vence agora (e só se ainda não foi enviado)
    const r = await prisma.novaClinicaConvite.updateMany({ where: { id, enviadoEm: null, expiraEm: { gt: agora } }, data: { expiraEm: agora } });
    return r.count === 1;
  },
};
