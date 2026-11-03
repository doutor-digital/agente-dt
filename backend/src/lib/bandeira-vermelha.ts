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
 * COMO A EQUIPE SOLTA UM CARTÃO, SEM SQL: tira a etiqueta no Kommo. O livro tem duas marcas: a BANDEIRA (gravada ao detectar o
 * sinal) e a ETIQUETA CONFIRMADA (gravada só depois de o Kommo aceitar a etiqueta). Com a etiqueta confirmada, o cartão sem ela
 * foi solto pela equipe: `reconciliarBandeiras` apaga as duas marcas. Sem a confirmação (a etiqueta falhou), a bandeira segura
 * por `BANDEIRA_DIAS` — o cartão nunca mostrou a etiqueta, então a falta dela não prova que a equipe soltou. Reativação e follow-up
 * conferem o livro com o Kommo antes de cada escolha; quem tem o cartão na mão (`vigente`) solta na hora.
 *
 * O livro vale pela CONTA do Kommo, não pela unidade: comercial, resgate e tratamento dividem o cartão e o lead. O alerta pode
 * sair na resgate e a conversa seguir na principal (10 de 136 leads, 03/11). Por isso toda leitura olha as unidades da conta.
 *
 * Cartões marcados antes do livro existir NÃO estão nele: precisa do preenchimento inicial a partir dos traces (ver o PR).
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import type { KommoClient } from '../services/kommo.service.js';

export const CHAVE_BANDEIRA = 'bandeira-vermelha';
export const BANDEIRA_DIAS = Number(process.env.BANDEIRA_VERMELHA_DIAS) || 30;
/** A etiqueta foi aceita pelo Kommo: daí em diante, cartão sem ela = a equipe soltou. */
export const CHAVE_ETIQUETA_CONFIRMADA = 'bandeira-vermelha-etiqueta';
const DIA_MS = 24 * 3600_000;

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

// ── as unidades da conta ──────────────────────────────────────────────────────────────────────────────────────

const VALIDADE_CONTA_MS = 60_000;
const contas = new Map<string, { ids: string[]; em: number }>();

/** Para teste: esquece as contas guardadas. */
export function esquecerContas(): void {
  contas.clear();
}

/**
 * As unidades que dividem o cartão com esta (mesmo subdomínio do Kommo, e o grupo de CRM compartilhado de Petrópolis/Caxias).
 * Falha na leitura devolve só a própria e NÃO guarda o resultado.
 */
export async function unidadesDaConta(unitId: string): Promise<string[]> {
  const guardado = contas.get(unitId);
  if (guardado && Date.now() - guardado.em < VALIDADE_CONTA_MS) return guardado.ids;
  try {
    const ids = new Set<string>([unitId]);
    const u = await prisma.unit.findUnique({ where: { id: unitId }, select: { kommoSubdomain: true } });
    if (u?.kommoSubdomain) {
      for (const x of await prisma.unit.findMany({ where: { kommoSubdomain: u.kommoSubdomain }, select: { id: true } })) ids.add(x.id);
    }
    let completo = true;
    try {
      const { grupoDaUnidade } = await import('./crm-compartilhado.js'); // import tardio: evita ciclo
      const g = await grupoDaUnidade(unitId);
      if (g) {
        ids.add(g.contaUnitId);
        for (const m of g.membros) ids.add(m.unitId);
      }
    } catch (err) {
      completo = false; // sem o grupo de CRM compartilhado vale o subdomínio, mas NÃO guarda: tenta de novo na próxima
      logger.warn({ err: String(err), unitId }, 'bandeira-vermelha: não consegui ler o grupo de CRM compartilhado — uso só o subdomínio desta vez');
    }
    const lista = [...ids];
    if (completo) contas.set(unitId, { ids: lista, em: Date.now() });
    return lista;
  } catch (err) {
    logger.warn({ err: String(err), unitId }, 'bandeira-vermelha: não consegui listar as unidades da conta — vale só a própria');
    return [unitId];
  }
}

// ── a regra de vigência ───────────────────────────────────────────────────────────────────────────────────────

/** O que o livro sabe de um lead. */
export interface LinhaDoLivro {
  /** quando a bandeira foi gravada (a última vez) */
  em: Date;
  /** o Kommo aceitou a etiqueta DEPOIS dessa gravação: a falta dela no cartão é a equipe que soltou */
  etiquetada: boolean;
}

/**
 * A bandeira está valendo? `linha` = o que o livro sabe (ou null). `noCartao` = o cartão mostra a etiqueta (`undefined` = não
 * deu para olhar o cartão). Etiqueta no cartão sempre vale. Sem etiqueta: se o Kommo chegou a aceitá-la (`etiquetada`), a equipe
 * soltou o cartão; se nunca aceitou, o livro segura até vencer.
 */
export function vigente(linha: LinhaDoLivro | null | undefined, noCartao: boolean | undefined, agora: Date = new Date()): boolean {
  if (noCartao === true) return true;
  if (!linha) return false;
  if (agora.getTime() - linha.em.getTime() >= BANDEIRA_DIAS * DIA_MS) return false;
  if (noCartao === false) return !linha.etiquetada;
  return true;
}

// ── o livro ───────────────────────────────────────────────────────────────────────────────────────────────────

async function gravarMarca(unitId: string, leadId: number | string, ruleKey: string): Promise<boolean> {
  const agora = new Date();
  try {
    await prisma.cardAlert.upsert({
      where: { unitId_leadId_ruleKey: { unitId, leadId: String(leadId), ruleKey } },
      create: { unitId, leadId: String(leadId), ruleKey, createdAt: agora },
      update: { createdAt: agora },
    });
    return true;
  } catch (err) {
    logger.error({ err: String(err), unitId, leadId: String(leadId), ruleKey }, 'bandeira-vermelha: NÃO consegui gravar a marca no livro');
    return false;
  }
}

/**
 * `pausar_ia` por sinal de alerta (e `aplicar_tag` com a etiqueta de bandeira): grava (ou renova) a bandeira no livro, antes
 * de qualquer chamada ao Kommo. Devolve se gravou: quem chama põe um ERROR no rastro quando não. Nunca lança.
 */
export function registrarBandeira(unitId: string, leadId: number | string): Promise<boolean> {
  return gravarMarca(unitId, leadId, CHAVE_BANDEIRA);
}

/** O Kommo ACEITOU a etiqueta neste lead: a partir daqui, cartão sem ela = a equipe soltou. Chamar só depois do `addTag` ok. Nunca lança. */
export function confirmarEtiqueta(unitId: string, leadId: number | string): Promise<boolean> {
  return gravarMarca(unitId, leadId, CHAVE_ETIQUETA_CONFIRMADA);
}

/** As linhas do livro (bandeira + confirmação) → uma `LinhaDoLivro` por lead. */
function juntar(rows: Array<{ leadId: string; ruleKey: string; createdAt: Date }>): Map<string, LinhaDoLivro> {
  const bandeira = new Map<string, Date>();
  const confirmacao = new Map<string, Date>();
  for (const r of rows) {
    const alvo = r.ruleKey === CHAVE_BANDEIRA ? bandeira : confirmacao;
    const antes = alvo.get(r.leadId);
    if (!antes || r.createdAt > antes) alvo.set(r.leadId, r.createdAt);
  }
  const m = new Map<string, LinhaDoLivro>();
  for (const [lead, em] of bandeira) {
    const c = confirmacao.get(lead);
    m.set(lead, { em, etiquetada: !!c && c.getTime() >= em.getTime() });
  }
  return m;
}

/**
 * Este lead tem bandeira vigente? Olha o livro em TODAS as unidades da conta. `noCartao`: o que o chamador sabe do cartão
 * (ver `vigente`). Na dúvida (banco falhou) a resposta é SIM: o erro caro é o robô mover ou fechar quem tem sinal de alerta.
 */
export async function temBandeira(unitId: string, leadId: number | string, opcoes: { noCartao?: boolean; agora?: Date } = {}): Promise<boolean> {
  const agora = opcoes.agora ?? new Date();
  if (opcoes.noCartao === true) return true;
  try {
    const rows = await prisma.cardAlert.findMany({
      where: { unitId: { in: await unidadesDaConta(unitId) }, leadId: String(leadId), ruleKey: { in: [CHAVE_BANDEIRA, CHAVE_ETIQUETA_CONFIRMADA] } },
      select: { leadId: true, ruleKey: true, createdAt: true },
    });
    return vigente(juntar(rows).get(String(leadId)), opcoes.noCartao, agora);
  } catch (err) {
    logger.warn({ err: String(err), unitId, leadId: String(leadId) }, 'bandeira-vermelha: não consegui ler o livro — segurei o cartão por precaução');
    return true;
  }
}

/** O livro da conta inteira (só o que ainda não venceu). `null` se não deu para ler (quem chama decide: pular). */
export async function livroDaConta(unitId: string, agora: Date = new Date()): Promise<Map<string, LinhaDoLivro> | null> {
  try {
    const desde = new Date(agora.getTime() - BANDEIRA_DIAS * DIA_MS);
    const rows = await prisma.cardAlert.findMany({
      where: { unitId: { in: await unidadesDaConta(unitId) }, ruleKey: { in: [CHAVE_BANDEIRA, CHAVE_ETIQUETA_CONFIRMADA] }, createdAt: { gte: desde } },
      select: { leadId: true, ruleKey: true, createdAt: true },
    });
    return juntar(rows);
  } catch (err) {
    logger.warn({ err: String(err), unitId }, 'bandeira-vermelha: não consegui ler o livro — o worker pula a unidade nesta varredura');
    return null;
  }
}

/**
 * Os leads da conta com bandeira no livro. Para os workers que escolhem conversas no banco: `leadId: { notIn }`.
 * Falha na leitura devolve `null` (com rastro): o worker PULA a unidade nesta varredura.
 */
export async function leadsComBandeira(unitId: string, agora: Date = new Date()): Promise<string[] | null> {
  const livro = await livroDaConta(unitId, agora);
  return livro ? [...livro.keys()] : null;
}

/** Filtro pronto para o `where` de `conversation.findMany`: exclui os leads com bandeira (vazio quando não há nenhum). */
export function foraDasBandeiras(leadIds: string[]): { leadId?: { notIn: string[] } } {
  return leadIds.length > 0 ? { leadId: { notIn: leadIds } } : {};
}

// ── soltar quando a equipe tira a etiqueta ────────────────────────────────────────────────────────────────

const RECONCILIA_A_CADA_MS = 5 * 60_000;
const ultimaReconciliacao = new Map<string, number>();

/** Para teste. */
export function esquecerReconciliacoes(): void {
  ultimaReconciliacao.clear();
}

/**
 * A equipe soltou o cartão? Olha no Kommo as etiquetas dos leads cuja etiqueta o Kommo JÁ ACEITOU (`etiquetada`) e apaga as
 * marcas de quem não a tem mais. Lead que o Kommo não devolve (apagado, outra conta) e qualquer falha de leitura: as marcas FICAM
 * (e a próxima varredura tenta de novo). No máximo uma vez a cada 5 min por conta. O apagamento só leva marcas gravadas ATÉ o
 * início desta conferência: um alerta novo que renovou a bandeira no meio do caminho não é apagado. Devolve os leads soltos.
 */
export async function reconciliarBandeiras(
  unit: { id: string; slug?: string },
  kommo: Pick<KommoClient, 'listLeadsPorIds'>,
  agora: Date = new Date(),
): Promise<string[]> {
  const ids = await unidadesDaConta(unit.id);
  const chave = [...ids].sort()[0];
  if (agora.getTime() - (ultimaReconciliacao.get(chave) ?? 0) < RECONCILIA_A_CADA_MS) return [];
  ultimaReconciliacao.set(chave, agora.getTime());
  try {
    const desde = new Date(agora.getTime() - BANDEIRA_DIAS * DIA_MS);
    const rows = await prisma.cardAlert.findMany({
      where: { unitId: { in: ids }, ruleKey: { in: [CHAVE_BANDEIRA, CHAVE_ETIQUETA_CONFIRMADA] }, createdAt: { gte: desde } },
      select: { leadId: true, ruleKey: true, createdAt: true },
    });
    const confirmados = [...juntar(rows)].filter(([, l]) => l.etiquetada).map(([lead]) => Number(lead)).filter((n) => Number.isFinite(n));
    if (confirmados.length === 0) return [];
    const cartoes = await kommo.listLeadsPorIds(confirmados);
    const soltos = cartoes.filter((c) => !cartaoComBandeira(c)).map((c) => String(c.id));
    if (soltos.length === 0) return [];
    await prisma.cardAlert.deleteMany({
      where: { unitId: { in: ids }, ruleKey: { in: [CHAVE_BANDEIRA, CHAVE_ETIQUETA_CONFIRMADA] }, leadId: { in: soltos }, createdAt: { lte: agora } },
    });
    logger.info({ unit: unit.slug, soltos }, 'bandeira-vermelha: a equipe tirou a etiqueta — cartões soltos');
    return soltos;
  } catch (err) {
    ultimaReconciliacao.delete(chave); // não conferiu: a próxima varredura tenta de novo
    logger.warn({ err: String(err), unit: unit.slug }, 'bandeira-vermelha: não consegui conferir as etiquetas — as bandeiras ficam');
    return [];
  }
}
