/**
 * Central do João — pausa por pessoa: o armazém de verdade (Prisma). A regra mora em `central-pausa.ts`; aqui só há I/O.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { env } from './env.js';
import { chaveDaPessoa, finalDoNumero, numeroCanonico, numerosDaMensagem } from './central-pausa.js';

// Segredo do HMAC: CENTRAL_PAUSA_SEGREDO se existir, senão SESSION_JWT_SECRET. Trocar o segredo usado faz todas as pausas por
// pessoa caírem (as linhas antigas ficam órfãs; apague a tabela suporte_pausa_pessoa) — por isso existe o segredo próprio.
export const segredoCentral = () => env.CENTRAL_PAUSA_SEGREDO || env.SESSION_JWT_SECRET;
const segredo = segredoCentral;

export interface PessoaPausada {
  final: string;
  nome: string | null;
  desde: Date;
  por: string;
  ignoradas: number;
}

/**
 * O menu pergunta antes de cada mensagem. Pausada = conta a mensagem (só no modo ligado) e devolve true. Erro de banco = false
 * (log): a pausa GERAL, lida antes, já trata banco fora como "pausado", então aqui não precisa calar ninguém a mais.
 */
export async function pessoaPausada(jid: string, jidAlt: string | null, contar: boolean): Promise<boolean> {
  const chaves = numerosDaMensagem(jid, jidAlt).map((n) => chaveDaPessoa(n, segredo()));
  if (!chaves.length) return false;
  try {
    if (!contar) return (await prisma.suportePausaPessoa.count({ where: { chave: { in: chaves } } })) > 0;
    const r = await prisma.suportePausaPessoa.updateMany({ where: { chave: { in: chaves } }, data: { ignoradas: { increment: 1 } } });
    return r.count > 0;
  } catch (err) {
    logger.warn({ err: String(err) }, 'central-pausa: não consegui ler a pausa por pessoa — seguindo sem ela');
    return false;
  }
}

export async function estadoDaPessoa(numero: string): Promise<{ final: string; pausada: PessoaPausada | null } | null> {
  const n = numeroCanonico(numero);
  if (!n) return null;
  const l = await prisma.suportePausaPessoa.findUnique({ where: { chave: chaveDaPessoa(n, segredo()) } });
  return { final: finalDoNumero(n), pausada: l ? { final: l.final, nome: l.nome, desde: l.pausadoEm, por: l.pausadoPor, ignoradas: l.ignoradas } : null };
}

/** Pausa (ou mantém, sem zerar a hora nem a conta) ou retoma. Devolve se mudou e o estado anterior. */
export async function mudarPessoa(
  numero: string,
  pausar: boolean,
  nome: string | null,
  por: string,
): Promise<{ mudou: boolean; final: string; anterior: PessoaPausada | null } | null> {
  const n = numeroCanonico(numero);
  if (!n) return null;
  const chave = chaveDaPessoa(n, segredo());
  const final = finalDoNumero(n);
  const l = await prisma.suportePausaPessoa.findUnique({ where: { chave } });
  const anterior = l ? { final: l.final, nome: l.nome, desde: l.pausadoEm, por: l.pausadoPor, ignoradas: l.ignoradas } : null;
  if (pausar) {
    if (anterior) return { mudou: false, final, anterior };
    // dois cliques ao mesmo tempo: só quem de fato inseriu conta como mudança (um aviso só no Telegram)
    const r = await prisma.suportePausaPessoa.createMany({ data: [{ chave, final, nome, pausadoPor: por }], skipDuplicates: true });
    return { mudou: r.count === 1, final, anterior };
  }
  if (!anterior) return { mudou: false, final, anterior };
  const r = await prisma.suportePausaPessoa.deleteMany({ where: { chave } });
  return { mudou: r.count === 1, final, anterior };
}

export async function listarPausadas(): Promise<PessoaPausada[]> {
  const ls = await prisma.suportePausaPessoa.findMany({ orderBy: { pausadoEm: 'desc' }, take: 100 });
  return ls.map((l) => ({ final: l.final, nome: l.nome, desde: l.pausadoEm, por: l.pausadoPor, ignoradas: l.ignoradas }));
}
