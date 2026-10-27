/**
 * As contas sobre as avaliações do juiz, em código puro (a consulta só traz uma linha por avaliação).
 * "Avaliável" = a Sofia falou ≥ 1 vez E o paciente respondeu depois da 1ª fala dela.
 */
import { mensagemDaSofiaConversando } from '../mensagem-da-ia.js';
import type { Dia, DiaAvaliado, FaixaDeNota, LinhaDeAvaliacao, UnidadeNota } from './tipos.js';

/** Nota abaixo disto = faixa baixa; de FAIXA_ALTA_DE para cima = alta; o meio é a média. */
export const FAIXA_BAIXA_ATE = 5;
export const FAIXA_ALTA_DE = 7;

export type Destino = 'quebrada' | 'sem-sofia' | 'sumiu' | 'avaliavel';

export function destinoDaAvaliacao(l: Pick<LinhaDeAvaliacao, 'sofiaFalou' | 'pacienteRespondeu'> & { quebrada?: boolean }): Destino {
  if (l.quebrada) return 'quebrada';
  if (!l.sofiaFalou) return 'sem-sofia';
  return l.pacienteRespondeu ? 'avaliavel' : 'sumiu';
}

export const ehAvaliavel = (l: LinhaDeAvaliacao): boolean => destinoDaAvaliacao(l) === 'avaliavel';

export function avaliacoesPorDia(linhas: readonly LinhaDeAvaliacao[]): DiaAvaliado[] {
  const mapa = new Map<Dia, DiaAvaliado & { soma: number }>();
  for (const l of linhas) {
    const d = mapa.get(l.dia) ?? { dia: l.dia, total: 0, quebradas: 0, semSofia: 0, sumiu: 0, avaliaveis: 0, mediaAvaliaveis: null, soma: 0 };
    d.total += 1;
    const destino = destinoDaAvaliacao(l);
    if (destino === 'quebrada') d.quebradas += 1;
    else if (destino === 'sem-sofia') d.semSofia += 1;
    else if (destino === 'sumiu') d.sumiu += 1;
    else {
      d.avaliaveis += 1;
      d.soma += l.nota;
    }
    mapa.set(l.dia, d);
  }
  return [...mapa.values()]
    .sort((a, b) => a.dia.localeCompare(b.dia))
    .map(({ soma, ...d }) => ({ ...d, mediaAvaliaveis: d.avaliaveis > 0 ? soma / d.avaliaveis : null }));
}

/** As unidades de menor nota entre as avaliáveis, ignorando as com menos de `minimo` conversas. */
export function unidadesPiores(linhas: readonly LinhaDeAvaliacao[], minimo: number, quantas = 3): UnidadeNota[] {
  const mapa = new Map<string, { nome: string; n: number; soma: number }>();
  for (const l of linhas.filter(ehAvaliavel)) {
    const u = mapa.get(l.unitId) ?? { nome: l.unidade, n: 0, soma: 0 };
    u.n += 1;
    u.soma += l.nota;
    mapa.set(l.unitId, u);
  }
  return [...mapa.values()]
    .filter((u) => u.n >= minimo)
    .map((u) => ({ nome: u.nome, avaliaveis: u.n, media: u.soma / u.n }))
    .sort((a, b) => a.media - b.media || b.avaliaveis - a.avaliaveis)
    .slice(0, quantas);
}

export function faixaDaNota(nota: number): FaixaDeNota['faixa'] {
  return nota < FAIXA_BAIXA_ATE ? 'baixa' : nota < FAIXA_ALTA_DE ? 'media' : 'alta';
}

/** Faixas de nota (só avaliáveis) com quantas viraram Ganho e quantas têm consulta marcada. */
export function faixasDeNota(linhas: readonly LinhaDeAvaliacao[]): FaixaDeNota[] {
  const faixas: FaixaDeNota[] = (['baixa', 'media', 'alta'] as const).map((faixa) => ({ faixa, conversas: 0, ganhos: 0, comConsulta: 0 }));
  for (const l of linhas.filter(ehAvaliavel)) {
    const f = faixas.find((x) => x.faixa === faixaDaNota(l.nota))!;
    f.conversas += 1;
    if (l.ganhou) f.ganhos += 1;
    if (l.comConsulta) f.comConsulta += 1;
  }
  return faixas;
}

/** A avaliável de menor nota; no empate, a mais recente da lista (a consulta devolve da mais nova para a mais velha). */
export function piorAvaliacao(linhas: readonly LinhaDeAvaliacao[]): LinhaDeAvaliacao | null {
  let pior: LinhaDeAvaliacao | null = null;
  for (const l of linhas.filter(ehAvaliavel)) if (!pior || l.nota < pior.nota) pior = l;
  return pior;
}

export const noPeriodo = (linhas: readonly LinhaDeAvaliacao[], de: Dia, ate: Dia): LinhaDeAvaliacao[] =>
  linhas.filter((l) => l.dia >= de && l.dia <= ate);

/**
 * A definição de "avaliável" em código puro, sobre as mensagens de UMA conversa: só vale o que existia quando o
 * juiz deu a nota (`createdAt <= avaliadaEm`). O SQL (`consulta.ts`) tem de dar a mesma resposta — o teste de SQL
 * confere caso a caso.
 */
export function situacaoNaAvaliacao(
  mensagens: ReadonlyArray<{ role: string; createdAt: Date; meta?: unknown }>,
  avaliadaEm: Date,
): { sofiaFalou: boolean; pacienteRespondeu: boolean } {
  const ate = mensagens.filter((m) => m.createdAt.getTime() <= avaliadaEm.getTime());
  const falas = ate.filter((m) => m.role === 'assistant' && mensagemDaSofiaConversando(m.meta)).map((m) => m.createdAt.getTime());
  if (falas.length === 0) return { sofiaFalou: false, pacienteRespondeu: false };
  const primeira = Math.min(...falas);
  return { sofiaFalou: true, pacienteRespondeu: ate.some((m) => m.role === 'user' && m.createdAt.getTime() > primeira) };
}
