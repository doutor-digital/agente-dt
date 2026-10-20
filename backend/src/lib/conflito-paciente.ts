/**
 * Memória do conflito "dois pacientes da franquia no mesmo telefone" (decisão 1 do João, 16/10/2026).
 *
 * Duas coisas precisam sobreviver a deploy e a troca de processo:
 *  - QUEM são os candidatos de cada cartão em conflito — o widget pergunta à SDR "qual destes?", e a franquia não busca
 *    por telefone: sem guardar, o widget não teria como achar de novo o paciente que caiu no cartão pela agenda;
 *  - QUE a SDR já escolheu — com isso o conflito com o outro paciente não volta a pedir decisão a cada 15 min.
 *
 * Mora na tabela `card_alert` (unit_id, lead_id, rule_key), que já existe e tem chave única — sem migration, o mesmo
 * truque de `aviso-dedupe.ts`. O `card-validation-worker` só apaga as próprias regras, nunca estas. Falha de banco não
 * derruba o robô: o pior caso é o widget não mostrar a lista (a SDR ainda tira a etiqueta à mão).
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { ID_AUTOMACAO, PREFIXO_CONFLITO, PREFIXO_ESCOLHA, chaveDoConflito, chaveDoDuplicado, idsDoConflito, notaCadastroDuplicado } from './casamento-jornada.js';
import { avisoRecente, marcarAviso } from './aviso-dedupe.js';
import { registrarSimulacao } from './so-no-papel.js';
import type { KommoClient } from '../services/kommo.service.js';

/** Todos os idClient que o robô já viu em conflito neste cartão. */
export async function candidatosGuardados(unitId: string, leadId: number): Promise<number[]> {
  try {
    const linhas = await prisma.cardAlert.findMany({
      where: { unitId, leadId: String(leadId), ruleKey: { startsWith: PREFIXO_CONFLITO } },
      select: { ruleKey: true },
    });
    return [...new Set(linhas.flatMap((l) => idsDoConflito(l.ruleKey)))];
  } catch (err) {
    logger.warn({ err: String(err), unitId, leadId }, 'conflito-paciente: falha ao ler os candidatos');
    return [];
  }
}

/**
 * Os cartões com a marca do conflito (`conflito-franquia:`) nestas unidades — a trava que o sincronizador grava e o widget
 * lê. `leadId` restringe a um cartão (releitura logo antes de mexer). Falha de banco LANÇA: cada robô decide o que fazer
 * sem saber (o sincronizador segue pela etiqueta; o estoque não mexe em ninguém).
 */
export async function cartoesComConflito(unitIds: readonly string[], leadId?: number): Promise<Set<number>> {
  if (unitIds.length === 0) return new Set();
  const linhas = await prisma.cardAlert.findMany({
    where: { unitId: { in: [...unitIds] }, ruleKey: { startsWith: PREFIXO_CONFLITO }, ...(leadId ? { leadId: String(leadId) } : {}) },
    select: { leadId: true },
  });
  return new Set(linhas.map((l) => Number(l.leadId)).filter((n) => Number.isInteger(n) && n > 0));
}

/** Guarda a UNIÃO do que já estava com os candidatos novos (uma linha só por cartão). */
export async function guardarCandidatos(unitId: string, leadId: number, ids: number[]): Promise<void> {
  const validos = ids.filter((n) => Number.isInteger(n) && n > 0);
  if (validos.length === 0) return;
  try {
    const todos = [...new Set([...(await candidatosGuardados(unitId, leadId)), ...validos])];
    const chave = chaveDoConflito(todos);
    await prisma.cardAlert.upsert({
      where: { unitId_leadId_ruleKey: { unitId, leadId: String(leadId), ruleKey: chave } },
      create: { unitId, leadId: String(leadId), ruleKey: chave },
      update: {},
    });
    await prisma.cardAlert.deleteMany({ where: { unitId, leadId: String(leadId), ruleKey: { startsWith: PREFIXO_CONFLITO, not: chave } } });
  } catch (err) {
    logger.warn({ err: String(err), unitId, leadId }, 'conflito-paciente: falha ao guardar os candidatos');
  }
}

/** O idClient que a SDR escolheu no widget para este cartão, ou null. */
export async function escolhaDaSdr(unitId: string, leadId: number): Promise<number | null> {
  try {
    const l = await prisma.cardAlert.findFirst({
      where: { unitId, leadId: String(leadId), ruleKey: { startsWith: PREFIXO_ESCOLHA } },
      orderBy: { createdAt: 'desc' },
      select: { ruleKey: true },
    });
    const n = l ? Number(l.ruleKey.slice(PREFIXO_ESCOLHA.length)) : NaN;
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch (err) {
    logger.warn({ err: String(err), unitId, leadId }, 'conflito-paciente: falha ao ler a escolha da SDR');
    return null;
  }
}

/** Registra a escolha (troca a anterior, se houver). Os candidatos ficam: a SDR pode mudar de ideia pelo mesmo widget. */
export async function gravarEscolhaDaSdr(unitId: string, leadId: number, idClient: number): Promise<void> {
  const chave = `${PREFIXO_ESCOLHA}${idClient}`;
  await prisma.cardAlert.deleteMany({ where: { unitId, leadId: String(leadId), ruleKey: { startsWith: PREFIXO_ESCOLHA, not: chave } } });
  await prisma.cardAlert.upsert({
    where: { unitId_leadId_ruleKey: { unitId, leadId: String(leadId), ruleKey: chave } },
    create: { unitId, leadId: String(leadId), ruleKey: chave },
    update: { createdAt: new Date() },
  });
}

/** "Uma vez só" de verdade: a marca em `card_alert` vale por dez anos. */
export const PARA_SEMPRE_MS = 10 * 365 * 24 * 3600_000;

/**
 * Mesmo nome e mesmo telefone em dois (ou mais) cadastros da franquia: o robô escolhe sozinho (o de agenda mais recente) e
 * deixa no cartão, UMA vez, a nota pedindo para a unidade juntar os cadastros (decisão do João, 16/10/2026). Em "só no papel"
 * só registra que gravaria. Falha de rede ou banco não derruba ninguém.
 */
export async function avisarCadastroDuplicado(
  unit: { id: string; slug: string }, kommo: KommoClient, leadId: number, ids: number[], escolhido: number | null, seco: boolean,
): Promise<void> {
  const unicos = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
  if (unicos.length < 2) return;
  const chave = chaveDoDuplicado(unicos);
  if (seco) {
    registrarSimulacao(unit, ID_AUTOMACAO, { leadId, acao: 'gravaria', alvo: 'nota: cadastros duplicados na franquia', valor: unicos.join(', ') });
    return;
  }
  try {
    if (await avisoRecente(unit.id, leadId, chave, PARA_SEMPRE_MS)) return;
    await kommo.addLeadNote(leadId, notaCadastroDuplicado(unicos, escolhido));
    await marcarAviso(unit.id, leadId, chave);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'conflito-paciente: não consegui avisar o cadastro duplicado');
  }
}
