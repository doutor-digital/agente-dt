/**
 * Bandeira vermelha: o cartão com sinal de alerta clínico NUNCA é mexido por robô (Suzanne, 21/10 e fechamento de outubro).
 *
 * Medido em produção (26/10 a 03/11): 95 leads pararam a IA por sinal de alerta. Dezesseis deles foram REABERTOS pelo
 * worker de reativação (30 min depois do handoff: despausa e manda mensagem de venda — Mossoró, lead 6111855, 35 min
 * depois) e seis receberam a escada de follow-up. Nada no código sabia que aquele cartão tinha uma bandeira vermelha:
 * a única memória era a caixinha «Pausar IA» do Kommo, que o próprio robô de reativação desmarca.
 *
 * Duas memórias, de propósito:
 *  - o LIVRO (`card_alert`, chave `bandeira-vermelha`): gravado por `pausar_ia` no sinal de alerta, vale `BANDEIRA_DIAS`
 *    e é o que os workers que escolhem conversas no banco (reativação, follow-up) leem — uma consulta por unidade;
 *  - a ETIQUETA no cartão («Alerta · Bandeira vermelha», que a regra da unidade põe, e «PRIORIDADE», que `pausar_ia` põe):
 *    é o que os workers que JÁ têm o cartão na mão (PERDIDO e EM ESPERA por prazo, franquia, Sofia) leem sem custo, e
 *    cobre os cartões marcados antes do livro existir (Olímpia, 23 e 25/10).
 *
 * Como a bandeira sai: a etiqueta, a equipe tira no cartão (vale na hora para quem lê o cartão); o livro NÃO enxerga isso e
 * vence sozinho em `BANDEIRA_DIAS` — para soltar antes, apagar a linha (`delete from card_alert where rule_key =
 * 'bandeira-vermelha' and unit_id = … and lead_id = …`). Cartões marcados antes do livro existir NÃO estão nele: o livro
 * começa vazio no deploy e precisa do preenchimento inicial a partir dos traces (ver o PR), senão reativação e follow-up
 * só passam a protegê-los quando o sinal for detectado de novo.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';

export const CHAVE_BANDEIRA = 'bandeira-vermelha';
export const BANDEIRA_DIAS = Number(process.env.BANDEIRA_VERMELHA_DIAS) || 30;

/** Sem acento, sem pontuação, minúsculo: «Alerta · Bandeira vermelha» → «alertabandeiravermelha»; « PRIORIDADE» → «prioridade». */
function simples(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

/**
 * Esta etiqueta é a bandeira vermelha? O Kommo tira o emoji do nome e deixa um espaço na frente (92 de 95 cartões ficaram
 * com « PRIORIDADE»), por isso a comparação ignora emoji, espaço e pontuação.
 */
export function ehEtiquetaDeBandeira(nome: string | null | undefined): boolean {
  return NOMES_DA_BANDEIRA.has(simples(nome ?? ''));
}

/** Exatos, de propósito: «Sem bandeira vermelha» e «Bandeira vermelha resolvida» não seguram cartão nenhum para sempre. */
const NOMES_DA_BANDEIRA = new Set(['prioridade', 'bandeiravermelha', 'alertabandeiravermelha']);

/** O cartão que o chamador já leu tem a etiqueta de bandeira vermelha? */
export function cartaoComBandeira(cartao: { _embedded?: { tags?: ReadonlyArray<{ name?: string | null }> | null } | null } | null | undefined): boolean {
  return (cartao?._embedded?.tags ?? []).some((t) => ehEtiquetaDeBandeira(t.name));
}

/**
 * `pausar_ia` por sinal de alerta: grava (ou renova) a bandeira no livro, antes de qualquer chamada ao Kommo. Devolve se
 * gravou: quem chama põe um ERROR no rastro quando não — sem a linha, reativação e follow-up não enxergam o cartão. Nunca lança.
 */
export async function registrarBandeira(unitId: string, leadId: number | string): Promise<boolean> {
  const agora = new Date();
  try {
    await prisma.cardAlert.upsert({
      where: { unitId_leadId_ruleKey: { unitId, leadId: String(leadId), ruleKey: CHAVE_BANDEIRA } },
      create: { unitId, leadId: String(leadId), ruleKey: CHAVE_BANDEIRA, createdAt: agora },
      update: { createdAt: agora },
    });
    return true;
  } catch (err) {
    logger.error({ err: String(err), unitId, leadId: String(leadId) }, 'bandeira-vermelha: NÃO consegui gravar a bandeira no livro');
    return false;
  }
}

/**
 * Este lead tem bandeira vigente no livro? Na dúvida (banco falhou) a resposta é SIM: o erro caro é o robô mover ou fechar
 * quem tem sinal de alerta; segurar um cartão a mais por uma varredura não custa nada.
 */
export async function temBandeira(unitId: string, leadId: number | string, agora: Date = new Date()): Promise<boolean> {
  try {
    const atual = await prisma.cardAlert.findUnique({
      where: { unitId_leadId_ruleKey: { unitId, leadId: String(leadId), ruleKey: CHAVE_BANDEIRA } },
      select: { createdAt: true },
    });
    return !!atual && agora.getTime() - atual.createdAt.getTime() < BANDEIRA_DIAS * 24 * 3600_000;
  } catch (err) {
    logger.warn({ err: String(err), unitId, leadId: String(leadId) }, 'bandeira-vermelha: não consegui ler o livro — segurei o cartão por precaução');
    return true;
  }
}

/**
 * Os leads da unidade com bandeira vigente no livro. Para os workers que escolhem conversas no banco: `leadId: { notIn }`.
 * Falha na leitura devolve `null` (com rastro): o worker PULA a unidade nesta varredura em vez de seguir sem a exclusão —
 * mandar venda a quem tem sinal de alerta é o erro caro, esperar a próxima varredura não custa nada.
 */
export async function leadsComBandeira(unitId: string, agora: Date = new Date()): Promise<string[] | null> {
  try {
    const desde = new Date(agora.getTime() - BANDEIRA_DIAS * 24 * 3600_000);
    const linhas = await prisma.cardAlert.findMany({
      where: { unitId, ruleKey: CHAVE_BANDEIRA, createdAt: { gte: desde } },
      select: { leadId: true },
    });
    return linhas.map((l) => l.leadId);
  } catch (err) {
    logger.warn({ err: String(err), unitId }, 'bandeira-vermelha: não consegui ler o livro — o worker pula a unidade nesta varredura');
    return null;
  }
}

/** Filtro pronto para o `where` de `conversation.findMany`: exclui os leads com bandeira (vazio quando não há nenhum). */
export function foraDasBandeiras(leadIds: string[]): { leadId?: { notIn: string[] } } {
  return leadIds.length > 0 ? { leadId: { notIn: leadIds } } : {};
}
