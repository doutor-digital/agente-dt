/**
 * AS MARCAS DO ROBÔ «CONVITE AO WHATSAPP» (Kommo) e a espera do robô em andamento. Mora à parte (sem Kommo, sem franquia) para a Sofia
 * (`sofia-so-whatsapp.ts`) poder perguntar «este lead RECEBEU o convite?» sem importar o robô.
 *
 * DUAS marcas em `message_claims`, ambas por CONTA do Kommo + lead e válidas por 7 dias:
 *  - `convite-whatsapp:…`          («uma vez»): gravada ANTES do envio; fica mesmo se o envio deu erro sem sabermos se saiu;
 *  - `convite-whatsapp-enviado:…`  («recebeu»): gravada SÓ quando o envio foi confirmado como entregue.
 * A Sofia só se cala por causa do robô quando existe a segunda, viva. Erro de leitura, resposta «não sei» da franquia, 403, erro de envio, envio que
 * virou nota e a passagem do seco para o ligado NÃO deixam a segunda marca: nesses casos a Sofia responde normalmente.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { reivindicarComCerteza } from './dedup-cache.js';
import { VALIDADE_DO_CONVITE_MS } from './convite-whatsapp-estado.js';

export const PREFIXO_DA_MARCA = 'convite-whatsapp:';
export const PREFIXO_DO_ENVIADO = 'convite-whatsapp-enviado:';

/** A chave da conversa: por CONTA do Kommo (o lead 123 de uma conta não é o de outra; resgate e comercial dividem a conta e o cartão). */
export function chaveDoConvite(unit: { id: string; kommoSubdomain?: string | null }, leadId: number): string {
  return `${PREFIXO_DA_MARCA}${unit.kommoSubdomain || unit.id}:${leadId}`;
}

export const chaveDoEnviado = (chave: string): string => `${PREFIXO_DO_ENVIADO}${chave.slice(PREFIXO_DA_MARCA.length)}`;

async function marcaViva(key: string): Promise<boolean> {
  const linha = await prisma.messageClaim.findUnique({ where: { key }, select: { expiresAt: true } });
  return !!linha && linha.expiresAt.getTime() > Date.now();
}

/** Há convite VIVO (≤ 7 dias) para esta chave, entregue ou não? Só leitura. Lança se não deu para saber. */
export const jaConvidado = (chave: string): Promise<boolean> => marcaViva(chave);

/** O lead RECEBEU o convite (entrega confirmada) nos últimos 7 dias? Nunca lança: na dúvida, `false` (a Sofia responde). */
export async function conviteEnviado(chave: string): Promise<boolean> {
  try {
    return await marcaViva(chaveDoEnviado(chave));
  } catch (err) {
    logger.warn({ err: String(err), chave }, 'convite-whatsapp: não li a marca de «recebeu o convite» (a Sofia responde)');
    return false;
  }
}

/** Grava «recebeu» (só depois de a entrega ser confirmada). Nunca lança; `false` = não gravou (a Sofia seguirá respondendo). */
export async function gravarEnviado(chave: string): Promise<boolean> {
  const k = chaveDoEnviado(chave);
  try {
    const r = await reivindicarComCerteza('convite-whatsapp-enviado', k.slice(PREFIXO_DO_ENVIADO.length), VALIDADE_DO_CONVITE_MS);
    return r === 'ganhou' || r === 'perdeu';
  } catch (err) {
    logger.error({ err: String(err), chave }, 'convite-whatsapp: o convite saiu, mas não gravei «recebeu» — a Sofia continua respondendo este lead');
    return false;
  }
}

// ── o robô em andamento: a Sofia espera o desfecho antes de decidir se responde ──────────────────────────

/**
 * Teto da espera da Sofia pelo robô. Cada leitura do Kommo tem prazo próprio e o robô normalmente leva poucos segundos; a espera acompanha o robô enquanto ele
 * trabalha e só desiste daqui. RISCO MEDIDO/ASSUMIDO: um robô preso por mais de 2 min (Kommo fora do ar) deixa a Sofia seguir sozinha — e então, se o convite sair
 * depois, falam as duas naquela mensagem. O contrário (esperar sem teto) pararia a Sofia do lead inteiro por causa de um Kommo travado.
 */
export const ESPERA_MAXIMA_MS = 120_000;
const emAndamento = new Map<string, Promise<void>>();

/**
 * Registra o robô que decide este lead. Numa RAJADA (3 mensagens seguidas) cada mensagem chama o robô: o registro ENCADEIA o trabalho anterior com o novo
 * (`allSettled`), senão a Sofia esperaria só o da ÚLTIMA mensagem e falaria por cima do convite que a primeira ainda está enviando.
 */
export function registrarEmAndamento(chave: string, trabalho: Promise<unknown>): void {
  const anterior = emAndamento.get(chave);
  const junto: Promise<void> = (anterior ? Promise.allSettled([anterior, trabalho]) : Promise.allSettled([trabalho])).then(() => undefined);
  emAndamento.set(chave, junto);
  void junto.then(() => {
    if (emAndamento.get(chave) === junto) emAndamento.delete(chave);
  });
}

/** Espera (no máximo `ms`, padrão 2 min) TODOS os robôs que estão decidindo este lead agora; sem robô em andamento volta na hora. Nunca lança. */
export async function esperarConvite(chave: string, ms = ESPERA_MAXIMA_MS): Promise<void> {
  const t = emAndamento.get(chave);
  if (!t) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([t, new Promise<void>((ok) => (timer = setTimeout(ok, ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
