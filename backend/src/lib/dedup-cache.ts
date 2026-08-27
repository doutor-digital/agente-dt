import { prisma } from './prisma.js';
import { logger } from './logger.js';

/**
 * Impede que a mesma mensagem seja processada duas vezes.
 *
 * Antes isto vivia num Map em memória de UM processo. Bastava o contêiner
 * reiniciar — e num dia de trabalho normal houve dois deploys — pra memória
 * zerar e o Kommo reentregar a mensagem: a IA respondia de novo e a ação no CRM
 * duplicava. Com uma segunda réplica seria pior: os dois processos atenderiam a
 * mesma mensagem ao mesmo tempo, sem saber um do outro.
 *
 * Agora quem decide é o banco, pela chave primária: quem inserir primeiro ganha,
 * o segundo bate no conflito e desiste. Isso é atômico entre processos, coisa
 * que Map nenhum resolve.
 *
 * A memória continua na frente como atalho — se ESTE processo já viu a
 * mensagem, não precisa perguntar ao banco. Ela nunca contradiz o banco: só
 * responde "já vi", nunca "é nova". Quando ela não sabe, o banco decide.
 *
 * SE O BANCO FALHAR, a mensagem PASSA. É de propósito: banco fora já é
 * incidente, e recusar mensagem de paciente nesse momento transformaria uma
 * falha de infraestrutura em lead perdido. Duplicar é ruim; ficar mudo é pior.
 */

const TTL_MS = 10 * 60 * 1000;
const MAX_MEMORIA = 10_000;

/** Atalho por processo. Só diz "já vi" — a autoridade é o banco. */
const memoria = new Map<string, number>();

function limparMemoria(agora: number): void {
  for (const [k, vence] of memoria) {
    if (vence <= agora) memoria.delete(k);
  }
}

/**
 * Reivindica a mensagem. `true` = é a primeira vez, pode processar.
 * `false` = alguém já pegou, ignore.
 */
export async function claimMessageId(scope: string, messageId: string): Promise<boolean> {
  if (!messageId) return true;

  const key = `${scope}:${messageId}`;
  const agora = Date.now();

  const jaVista = memoria.get(key);
  if (jaVista && jaVista > agora) return false;

  if (memoria.size >= MAX_MEMORIA) limparMemoria(agora);

  try {
    const vencimento = new Date(agora + TTL_MS);
    // ON CONFLICT DO NOTHING: o banco resolve a corrida. Quem inseriu, processa.
    const inseridas = await prisma.$executeRaw`
      INSERT INTO "message_claims" ("key", "expires_at")
      VALUES (${key}, ${vencimento})
      ON CONFLICT ("key") DO UPDATE
        SET "expires_at" = EXCLUDED."expires_at"
        WHERE "message_claims"."expires_at" <= NOW()
    `;
    const primeiraVez = inseridas > 0;
    if (primeiraVez) memoria.set(key, agora + TTL_MS);
    return primeiraVez;
  } catch (err) {
    // Banco fora não pode calar a IA: melhor arriscar duplicata que perder lead.
    logger.warn({ err: String(err), key }, 'dedup: banco indisponível — deixando a mensagem passar');
    memoria.set(key, agora + TTL_MS);
    return true;
  }
}

/** Varre o que venceu. Chamado de vez em quando; a tabela é pequena por desenho. */
export async function limparClaimsVencidos(): Promise<number> {
  try {
    const r = await prisma.messageClaim.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    return r.count;
  } catch {
    return 0;
  }
}

export function _dedupStats(): { size: number } {
  return { size: memoria.size };
}

export function clearDedupCache(): number {
  const n = memoria.size;
  memoria.clear();
  return n;
}
