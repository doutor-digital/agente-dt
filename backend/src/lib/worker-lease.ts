import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';
import { logger } from './logger.js';

/**
 * Um líder só para os workers periódicos.
 *
 * O caso que motivou (05/09/2026, Lucilene, Araguaína): duas cobranças de Pix
 * com 3 segundos de diferença e texto diferente. Não era o Salesbot reenviando —
 * eram DOIS processos do backend, cada um com o seu follow-up-worker, porque o
 * Swarm marcou uma task como morta (exit 137) sem o container ter morrido. Em
 * 18 h, 148 pacientes de 9 unidades receberam o mesmo toque duas vezes.
 *
 * A mesma janela se abre em TODO deploy: a atualização é start-first, então o
 * container novo e o velho convivem por ~1 min, ambos varrendo a cada 60 s.
 *
 * A solução é um lease no banco (única coisa que os dois processos compartilham):
 * quem grava o próprio nome em `worker_leases` roda os workers; quem não
 * consegue, espera. O lease vence em 90 s e é renovado a cada 30 s, então a
 * troca de líder depois de um deploy leva no máximo meio minuto (o processo que
 * recebe SIGTERM libera o lease na hora).
 *
 * O que NÃO passa por aqui: o monitor de resposta parada, porque ele vigia
 * respostas pendentes em memória DESTE processo — precisa rodar onde o webhook
 * chega, não onde o líder está.
 */

export const LEASE_NOME = 'workers';
export const LEASE_TTL_MS = Number(process.env.WORKER_LEASE_TTL_MS) || 90_000;
export const LEASE_TICK_MS = Number(process.env.WORKER_LEASE_TICK_MS) || 30_000;
/**
 * Tentativas seguidas com erro de banco até rodar SEM lease.
 *
 * Se a tabela não existir (migração que não rodou) ou o banco estiver fora, calar
 * follow-up e alerta em silêncio é pior do que duplicar: duplicar foi o que sempre
 * aconteceu em deploy e ninguém morreu; um lead quente sem cobrança some.
 */
export const FALHAS_PARA_ABRIR = 3;

export const DONO = `${hostname()}#${process.pid}#${randomUUID().slice(0, 8)}`;

export type Reivindicacao = 'minha' | 'de-outro' | 'erro';

/**
 * Tenta virar (ou continuar) líder. Atômico no banco: o INSERT … ON CONFLICT só
 * grava se o lease for meu ou já tiver vencido. Uma linha afetada = sou o líder.
 */
export async function reivindicarLease(
  nome: string = LEASE_NOME,
  dono: string = DONO,
  ttlMs: number = LEASE_TTL_MS,
): Promise<Reivindicacao> {
  try {
    const n = await prisma.$executeRaw`
      INSERT INTO worker_leases (name, owner, expires_at, updated_at)
      VALUES (${nome}, ${dono}, now() + make_interval(secs => ${ttlMs / 1000}), now())
      ON CONFLICT (name) DO UPDATE
        SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at, updated_at = now()
        WHERE worker_leases.owner = EXCLUDED.owner OR worker_leases.expires_at < now()`;
    return n === 1 ? 'minha' : 'de-outro';
  } catch (err) {
    logger.error({ err: String(err), nome, dono }, 'worker-lease: falha ao reivindicar');
    return 'erro';
  }
}

/** Solta o lease na saída, para o sucessor não esperar os 90 s de vencimento. */
export async function liberarLease(nome: string = LEASE_NOME, dono: string = DONO): Promise<void> {
  try {
    await prisma.$executeRaw`DELETE FROM worker_leases WHERE name = ${nome} AND owner = ${dono}`;
  } catch (err) {
    logger.warn({ err: String(err), nome, dono }, 'worker-lease: falha ao liberar');
  }
}

/** O que o banco diz: quem é o dono e até quando. Nulo = ninguém (ou tabela ausente). */
export async function quemLidera(
  nome: string = LEASE_NOME,
): Promise<{ owner: string; expiresAt: Date; vencido: boolean } | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ owner: string; expires_at: Date; vencido: boolean }>>`
      SELECT owner, expires_at, expires_at < now() AS vencido FROM worker_leases WHERE name = ${nome}`;
    const r = rows[0];
    return r ? { owner: r.owner, expiresAt: r.expires_at, vencido: r.vencido } : null;
  } catch {
    return null;
  }
}

export interface EstadoLideranca {
  /** Este processo está rodando os workers agora. */
  lider: boolean;
  /** `lease` = com o lease do banco · `sem-lease` = banco indisponível, rodando por precaução · `aguardando` = outro processo lidera. */
  modo: 'lease' | 'sem-lease' | 'aguardando';
  desde: Date | null;
  dono: string;
  falhasSeguidas: number;
  ultimaVerificacao: Date | null;
}

export interface SupervisorDeps {
  reivindicar: () => Promise<Reivindicacao>;
  /** Liga todos os workers. Precisa ser idempotente (cada `start*` já ignora timer existente). */
  iniciar: () => void;
  /** Desliga todos os workers. */
  parar: () => void;
  dono?: string;
  falhasParaAbrir?: number;
}

/**
 * Máquina de estados da liderança, sem banco, para dar para testar:
 *   minha     → liga os workers se estavam desligados
 *   de-outro  → desliga se estavam ligados
 *   erro      → líder continua líder (erro transitório não derruba follow-up);
 *               não-líder abre depois de N erros seguidos (fail-open)
 */
export function criarSupervisor(deps: SupervisorDeps): {
  tick: () => Promise<EstadoLideranca>;
  estado: () => EstadoLideranca;
} {
  const limite = deps.falhasParaAbrir ?? FALHAS_PARA_ABRIR;
  const estado: EstadoLideranca = {
    lider: false,
    modo: 'aguardando',
    desde: null,
    dono: deps.dono ?? DONO,
    falhasSeguidas: 0,
    ultimaVerificacao: null,
  };

  const assumir = (modo: 'lease' | 'sem-lease') => {
    if (!estado.lider) {
      estado.lider = true;
      estado.desde = new Date();
      deps.iniciar();
      logger.info({ dono: estado.dono, modo }, 'workers: este processo assumiu a liderança');
    }
    estado.modo = modo;
  };

  async function tick(): Promise<EstadoLideranca> {
    const r = await deps.reivindicar();
    estado.ultimaVerificacao = new Date();

    if (r === 'erro') {
      estado.falhasSeguidas += 1;
      if (!estado.lider && estado.falhasSeguidas >= limite) {
        logger.error(
          { dono: estado.dono, falhas: estado.falhasSeguidas },
          'workers: banco não responde ao lease — ligando os workers SEM lease (pode duplicar com outra réplica)',
        );
        assumir('sem-lease');
      }
      return { ...estado };
    }

    estado.falhasSeguidas = 0;
    if (r === 'minha') {
      assumir('lease');
    } else if (estado.lider) {
      estado.lider = false;
      estado.desde = null;
      estado.modo = 'aguardando';
      deps.parar();
      logger.warn({ dono: estado.dono }, 'workers: outro processo detém o lease — workers desligados aqui');
    } else {
      estado.modo = 'aguardando';
    }
    return { ...estado };
  }

  return { tick, estado: () => ({ ...estado }) };
}

let supervisorAtual: ReturnType<typeof criarSupervisor> | null = null;
let timer: NodeJS.Timeout | null = null;
let pararWorkers: (() => void) | null = null;

/** Liga o supervisor: tenta o lease agora e a cada 30 s. */
export async function iniciarSupervisorDosWorkers(workers: { iniciar: () => void; parar: () => void }): Promise<void> {
  if (supervisorAtual) return;
  pararWorkers = workers.parar;
  supervisorAtual = criarSupervisor({ reivindicar: () => reivindicarLease(), ...workers });
  await supervisorAtual.tick();
  timer = setInterval(() => void supervisorAtual?.tick(), LEASE_TICK_MS);
  logger.info({ dono: DONO, tickMs: LEASE_TICK_MS, ttlMs: LEASE_TTL_MS }, 'workers: supervisor de liderança ligado');
}

/** Na saída: para os workers, solta o lease e deixa o sucessor assumir já. */
export async function encerrarSupervisorDosWorkers(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  const era = supervisorAtual?.estado();
  supervisorAtual = null;
  if (era?.lider) pararWorkers?.();
  pararWorkers = null;
  if (era?.lider && era.modo === 'lease') await liberarLease();
}

export function estadoDosWorkers(): EstadoLideranca | null {
  return supervisorAtual?.estado() ?? null;
}
