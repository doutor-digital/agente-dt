/**
 * Central do João — fase 1b: o armazém dos chamados que a extensão manda (Prisma). A regra mora em `central-chamados.ts`.
 *
 * Um chamado ABERTO por conversa (índice único parcial `status = 'aberto'` na migration): os sinais seguintes da mesma conversa
 * anexam o trecho ao mesmo chamado. "Não lida" que o João abriu no WhatsApp vira `vista` sozinha; menção e manual só saem com
 * "Feito" na extensão. Sinal com o MESMO trecho de um chamado fechado há pouco é ignorado (o Feito e a vista não "voltam" quando
 * a extensão manda de novo, ex.: depois de recarregar a página); mensagem nova (trecho novo) abre outro.
 */
import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { env } from './env.js';
import {
  DIAS_ABERTO,
  DIAS_GUARDA,
  DIAS_LEMBRA_FECHADO,
  DIAS_NAO_LIDA_ABERTA,
  chaveDaConversa,
  juntarTrecho,
  nomeNormalizado,
  tipoMaisForte,
  trechoJaVisto,
  type SinalLimpo,
  type TipoChamado,
} from './central-chamados.js';

const DIA = 86_400_000;

// mesmo segredo da pausa por pessoa (central-pausa-banco.ts)
const segredo = () => env.CENTRAL_PAUSA_SEGREDO || env.SESSION_JWT_SECRET;

export interface ChamadoAberto {
  id: string;
  conversa: string;
  grupo: boolean;
  tipo: TipoChamado;
  trecho: string;
  naoLidas: number;
  vezes: number;
  criadoEm: Date;
  atualizadoEm: Date;
}

async function anexar(id: string, atual: { trecho: string; tipo: string }, s: SinalLimpo): Promise<void> {
  await prisma.centralChamado.update({
    where: { id },
    data: {
      trecho: juntarTrecho(atual.trecho, s.trecho),
      tipo: tipoMaisForte(atual.tipo as TipoChamado, s.tipo),
      naoLidas: s.naoLidas,
      grupo: s.grupo,
      conversa: s.conversa,
      vezes: { increment: 1 },
    },
  });
}

/**
 * Grava os sinais (cria ou anexa) e marca como `vista` as não lidas que o João já abriu. `ids[i]` é o chamado do sinal `i` (null:
 * sinal inválido ou ignorado) — a extensão guarda localmente o nome real de cada id, para o "Abrir" achar a conversa.
 */
export async function registrarSinais(sinais: (SinalLimpo | null)[], lidas: string[]): Promise<{ novos: number; ids: (string | null)[] }> {
  let novos = 0;
  const ids: (string | null)[] = [];
  for (const s of sinais) {
    if (!s) {
      ids.push(null);
      continue;
    }
    const chaveConversa = chaveDaConversa(s.normalizado, segredo());
    const aberto = await prisma.centralChamado.findFirst({ where: { chaveConversa, status: 'aberto' }, select: { id: true, trecho: true, tipo: true } });
    if (aberto) {
      await anexar(aberto.id, aberto, s);
      ids.push(aberto.id);
      continue;
    }
    if (s.tipo !== 'manual') {
      const fechado = await prisma.centralChamado.findFirst({
        where: { chaveConversa, status: { not: 'aberto' }, fechadoEm: { gte: new Date(Date.now() - DIAS_LEMBRA_FECHADO * DIA) } },
        orderBy: { fechadoEm: 'desc' },
        select: { trecho: true },
      });
      if (fechado && trechoJaVisto(fechado.trecho, s.trecho)) {
        ids.push(null);
        continue;
      }
    }
    try {
      const c = await prisma.centralChamado.create({
        data: { chaveConversa, conversa: s.conversa, grupo: s.grupo, tipo: s.tipo, trecho: s.trecho, naoLidas: s.naoLidas },
        select: { id: true },
      });
      novos++;
      ids.push(c.id);
    } catch (e) {
      // outro sinal da mesma conversa criou no meio (índice único parcial): anexa nele
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      const outro = await prisma.centralChamado.findFirst({ where: { chaveConversa, status: 'aberto' }, select: { id: true, trecho: true, tipo: true } });
      if (outro) await anexar(outro.id, outro, s);
      ids.push(outro?.id ?? null);
    }
  }
  const chaves = [...new Set(lidas.map(nomeNormalizado).filter((x): x is string => !!x))].map((n) => chaveDaConversa(n, segredo()));
  if (chaves.length) {
    await prisma.centralChamado.updateMany({
      where: { chaveConversa: { in: chaves }, status: 'aberto', tipo: 'nao_lida' },
      data: { status: 'vista', fechadoEm: new Date() },
    });
  }
  return { novos, ids };
}

/**
 * A fila da extensão: abertos, o mais recente primeiro. Antes, a faxina: não lida parada há DIAS_NAO_LIDA_ABERTA dias vira `vista`,
 * qualquer aberto parado há DIAS_ABERTO dias vira `expirado`, e fechado há mais de DIAS_GUARDA dias é apagado — nada fica guardado
 * sem prazo.
 */
export async function listarAbertos(): Promise<ChamadoAberto[]> {
  const agora = Date.now();
  await prisma.centralChamado.updateMany({
    where: { status: 'aberto', tipo: 'nao_lida', atualizadoEm: { lt: new Date(agora - DIAS_NAO_LIDA_ABERTA * DIA) } },
    data: { status: 'vista', fechadoEm: new Date(agora) },
  });
  await prisma.centralChamado.updateMany({
    where: { status: 'aberto', atualizadoEm: { lt: new Date(agora - DIAS_ABERTO * DIA) } },
    data: { status: 'expirado', fechadoEm: new Date(agora) },
  });
  await prisma.centralChamado.deleteMany({ where: { status: { not: 'aberto' }, fechadoEm: { lt: new Date(agora - DIAS_GUARDA * DIA) } } });
  const ls = await prisma.centralChamado.findMany({ where: { status: 'aberto' }, orderBy: { atualizadoEm: 'desc' }, take: 100 });
  return ls.map((l) => ({
    id: l.id,
    conversa: l.conversa,
    grupo: l.grupo,
    tipo: l.tipo as TipoChamado,
    trecho: l.trecho,
    naoLidas: l.naoLidas,
    vezes: l.vezes,
    criadoEm: l.criadoEm,
    atualizadoEm: l.atualizadoEm,
  }));
}

/** "Feito" na extensão. Devolve se fechou (false = não existe ou já estava fechado). */
export async function marcarFeito(id: string): Promise<boolean> {
  const r = await prisma.centralChamado.updateMany({ where: { id, status: 'aberto' }, data: { status: 'feito', fechadoEm: new Date() } });
  return r.count === 1;
}
