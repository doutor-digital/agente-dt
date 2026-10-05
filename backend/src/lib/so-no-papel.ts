/**
 * "Só no papel" (seco) visível na tela de Automações.
 *
 * Pedido do João (05/10/2026): em seco a automação decide e só escreve no log do servidor — e o log ele
 * não abre ("eu não conseguiria ver isso no front"). Aqui cada decisão vira uma linha em
 * `automacao_simulacoes`: qual cartão, o que faria (mover para tal etapa, gravar tal campo) e, nos robôs
 * de campo, se o calculado CONFERE ou DIVERGE do que a SDR já pôs. A tela lê dessa tabela.
 *
 * Uma linha por (unidade, automação, cartão, ação, alvo): a mesma decisão repetida a cada varredura só
 * atualiza `ultimaEm` — a lista mostra cartões, não o número de varreduras. Nunca derruba a automação:
 * gravar aqui é melhor-esforço.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';

export type AcaoSimulada = 'moveria' | 'gravaria' | 'confere' | 'diverge';

export interface Simulacao {
  leadId: number;
  acao: AcaoSimulada;
  /** campo que gravaria, ou a etapa para onde moveria */
  alvo: string;
  valor?: unknown;
  noCartao?: unknown;
  deEtapa?: string | null;
  motivo?: string | null;
}

/** Quanto tempo a tela guarda: o que a automação decidiu há mais de um mês já não ajuda a decidir hoje. */
const DIAS_GUARDADOS = 30;
const LIMPEZA_A_CADA_MS = 6 * 3600_000;
let ultimaLimpeza = 0;

const texto = (v: unknown, max = 500): string | null => {
  if (v === undefined || v === null) return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** Grava a decisão para a tela. Não espera nem lança: a automação segue igual se o banco falhar. */
export function registrarSimulacao(unit: { id: string; slug: string }, automacao: string, s: Simulacao): void {
  if (!Number.isFinite(s.leadId) || s.leadId <= 0) return;
  const dados = {
    valor: texto(s.valor),
    noCartao: texto(s.noCartao),
    deEtapa: texto(s.deEtapa, 120),
    motivo: texto(s.motivo),
    ultimaEm: new Date(),
  };
  void prisma.automacaoSimulacao
    .upsert({
      where: { unitId_automacao_kommoLeadId_acao_alvo: { unitId: unit.id, automacao, kommoLeadId: s.leadId, acao: s.acao, alvo: s.alvo } },
      create: { unitId: unit.id, automacao, kommoLeadId: s.leadId, acao: s.acao, alvo: s.alvo, ...dados },
      update: dados,
    })
    .catch((err) => logger.warn({ err: String(err), unit: unit.slug, automacao }, 'so-no-papel: não gravei a simulação'));

  if (Date.now() - ultimaLimpeza > LIMPEZA_A_CADA_MS) {
    ultimaLimpeza = Date.now();
    void prisma.automacaoSimulacao
      .deleteMany({ where: { ultimaEm: { lt: new Date(Date.now() - DIAS_GUARDADOS * 86_400_000) } } })
      .catch(() => undefined);
  }
}

export interface ResumoSimulacoes {
  moveria: number;
  gravaria: number;
  confere: number;
  diverge: number;
  /** cartões distintos com alguma decisão */
  cartoes: number;
}

/** Placar do topo da lista. Puro, para testar sem banco. */
export function resumirSimulacoes(itens: ReadonlyArray<{ acao: string; kommoLeadId: number }>): ResumoSimulacoes {
  const r: ResumoSimulacoes = { moveria: 0, gravaria: 0, confere: 0, diverge: 0, cartoes: 0 };
  const cartoes = new Set<number>();
  for (const i of itens) {
    if (i.acao === 'moveria' || i.acao === 'gravaria' || i.acao === 'confere' || i.acao === 'diverge') r[i.acao]++;
    cartoes.add(i.kommoLeadId);
  }
  r.cartoes = cartoes.size;
  return r;
}
