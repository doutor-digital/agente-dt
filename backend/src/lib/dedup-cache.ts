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

/**
 * Prazo para mensagens que chegam pelo webhook de CONTA do Kommo.
 *
 * O Kommo dá 2 s para o webhook responder e reenvia quem passa disso: 5 min, +15, +15 e +1 h
 * (≈ 95 min depois da primeira tentativa). Com os 10 min de sempre, a reentrega de 20 min já não
 * era reconhecida e a mesma mensagem era processada de novo — foi o "1" da confirmação de véspera
 * que voltou como mensagem nova e fez a Sofia mandar "Não entendi…" (Açailândia, 06/10/2026).
 *
 * Custo: uma linha de ~60 bytes por mensagem recebida em `message_claims`, que agora é limpa
 * periodicamente (ver `limparSeVencido`); e no máximo `MAX_MEMORIA` chaves no atalho em memória.
 */
export const TTL_REENTREGA_KOMMO_MS = 2 * 60 * 60 * 1000;

/** De quanto em quanto tempo apagar do banco as marcas vencidas. */
const LIMPEZA_MS = 10 * 60 * 1000;
let ultimaLimpeza = 0;

/** Atalho por processo. Só diz "já vi" — a autoridade é o banco. */
const memoria = new Map<string, number>();

function limparMemoria(agora: number): void {
  podarMemoria(memoria, agora, MAX_MEMORIA);
}

/**
 * Tira o que venceu e, se ainda sobrar demais, as chaves mais antigas (o Map guarda a ordem de
 * inserção). Esquecer aqui é seguro: a memória só responde "já vi"; quem não está nela vai ao banco.
 */
export function podarMemoria(mapa: Map<string, number>, agora: number, max: number): void {
  for (const [k, vence] of mapa) {
    if (vence <= agora) mapa.delete(k);
  }
  if (mapa.size < max) return;
  let sobrando = mapa.size - Math.floor(max / 2);
  for (const k of mapa.keys()) {
    if (sobrando-- <= 0) break;
    mapa.delete(k);
  }
}

/** Limpeza do banco em segundo plano, no máximo uma vez a cada `LIMPEZA_MS`. Nunca bloqueia. */
export function deveLimpar(agora: number, ultima: number, intervalo: number = LIMPEZA_MS): boolean {
  return agora - ultima >= intervalo;
}

function limparSeVencido(agora: number): void {
  if (!deveLimpar(agora, ultimaLimpeza)) return;
  ultimaLimpeza = agora;
  void limparClaimsVencidos();
}

/**
 * Reivindica a mensagem. `true` = é a primeira vez, pode processar.
 * `false` = alguém já pegou, ignore.
 */
export async function claimMessageId(
  scope: string,
  messageId: string,
  ttlMs: number = TTL_MS,
): Promise<boolean> {
  if (!messageId) return true;

  const key = `${scope}:${messageId}`;
  const agora = Date.now();
  limparSeVencido(agora);

  const jaVista = memoria.get(key);
  if (jaVista && jaVista > agora) return false;

  if (memoria.size >= MAX_MEMORIA) limparMemoria(agora);

  try {
    const vencimento = new Date(agora + ttlMs);
    // ON CONFLICT DO NOTHING: o banco resolve a corrida. Quem inseriu, processa.
    const inseridas = await prisma.$executeRaw`
      INSERT INTO "message_claims" ("key", "expires_at")
      VALUES (${key}, ${vencimento})
      ON CONFLICT ("key") DO UPDATE
        SET "expires_at" = EXCLUDED."expires_at"
        WHERE "message_claims"."expires_at" <= NOW()
    `;
    const primeiraVez = inseridas > 0;
    if (primeiraVez) memoria.set(key, agora + ttlMs);
    return primeiraVez;
  } catch (err) {
    // Banco fora não pode calar a IA: melhor arriscar duplicata que perder lead.
    logger.warn({ err: String(err), key }, 'dedup: banco indisponível — deixando a mensagem passar');
    memoria.set(key, agora + ttlMs);
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
