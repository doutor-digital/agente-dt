/**
 * Worker do lembrete das demandas abertas do suporte (9h e 17h, SP). A regra está em `suporte-lembrete.ts`; aqui só o timer e o banco.
 * Roda só no líder (`worker-lease.ts`, registrado em `server.ts`). Nasce DESLIGADO: `SUPORTE_LEMBRETE=seco|ligado` liga.
 * Mudar a variável vale no próximo reinício do backend (como as demais chaves globais).
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { reivindicarLease, liberarLease } from './worker-lease.js';
import { enviarTelegramChamados } from './telegram.js';
import { armazemPausaPrisma } from './suporte-pausa-banco.js';
import { modoDoLembrete, passoDoLembrete, memoriaNova, valorDoLembreteReconhecido, type DemandaAberta, type DepsLembrete } from './suporte-lembrete.js';

/** Passa a cada minuto: é só um relógio em memória; o banco só é consultado dentro das horas 9 e 17 (e uma vez por horário). */
const PASSO_MS = 60_000;

export const depsReaisDoLembrete: DepsLembrete = {
  agora: () => new Date(),
  modo: () => modoDoLembrete(process.env.SUPORTE_LEMBRETE),
  async demandasAbertas(limite) {
    const onde = { status: { in: ['aberta', 'reaberta'] } };
    const [linhas, total, reabertas] = await Promise.all([
      prisma.suporteDemanda.findMany({
        where: onde,
        // 'reaberta' vem depois de 'aberta' em ordem alfabética: decrescente põe as reabertas primeiro
        orderBy: [{ status: 'desc' }, { criadoEm: 'asc' }],
        take: limite,
        select: { protocolo: true, nome: true, unidadeSlug: true, relato: true, criadoEm: true, status: true },
      }),
      prisma.suporteDemanda.count({ where: onde }),
      prisma.suporteDemanda.count({ where: { status: 'reaberta' } }),
    ]);
    const slugs = [...new Set(linhas.map((l) => l.unidadeSlug).filter((s): s is string => Boolean(s)))];
    const unidades = slugs.length ? await prisma.unit.findMany({ where: { slug: { in: slugs } }, select: { slug: true, name: true } }) : [];
    const nomeDe = new Map(unidades.map((u) => [u.slug, u.name]));
    const demandas: DemandaAberta[] = linhas.map((l) => ({
      protocolo: l.protocolo,
      nome: l.nome,
      unidade: l.unidadeSlug ? (nomeDe.get(l.unidadeSlug) ?? l.unidadeSlug) : null,
      relato: l.relato,
      criadoEm: l.criadoEm,
      status: l.status,
    }));
    return { demandas, total, reabertas };
  },
  pausa: () => armazemPausaPrisma.ler(),
  reivindicar: (nome, ttlMs) => reivindicarLease(nome, undefined, ttlMs),
  liberar: (nome) => liberarLease(nome),
  enviar: (texto) => enviarTelegramChamados(texto),
  registrar: (nivel, dados, mensagem) => logger[nivel](dados, mensagem),
};

let timer: NodeJS.Timeout | null = null;
let rodando = false;
const memoria = memoriaNova();

async function passo(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    await passoDoLembrete(depsReaisDoLembrete, memoria);
  } catch (err) {
    logger.error({ err: String(err) }, 'suporte-lembrete: passo falhou');
  } finally {
    rodando = false;
  }
}

export function startSuporteLembreteWorker(): void {
  if (timer) return;
  const raw = process.env.SUPORTE_LEMBRETE;
  if (!valorDoLembreteReconhecido(raw)) {
    logger.warn({ valor: raw }, 'suporte-lembrete: SUPORTE_LEMBRETE com valor desconhecido — tratado como desligado. Use desligado, seco ou ligado');
  }
  const modo = modoDoLembrete(raw);
  if (modo === 'desligado') {
    logger.info('suporte-lembrete: desligado (SUPORTE_LEMBRETE) — worker não iniciado');
    return;
  }
  timer = setInterval(() => void passo(), PASSO_MS);
  timer.unref?.();
  logger.info({ modo, passoMs: PASSO_MS }, 'suporte-lembrete: worker ligado');
}

export function stopSuporteLembreteWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
