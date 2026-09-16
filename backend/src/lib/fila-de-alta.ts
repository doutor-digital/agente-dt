/**
 * A fila que a recepção decide na página `/alta/:slug`.
 *
 * Duas listas, com origens opostas:
 *  - **terminou o protocolo** → candidato a ALTA. Nunca move sozinho: ALTA é o
 *    "Ganho" nativo do funil de tratamento e o gatilho dela dispara um bot SEM
 *    nenhuma condição. Mover 48 cartões de uma vez mandaria 48 mensagens de
 *    "parabéns pela conclusão", inclusive para quem terminou em 2025.
 *  - **parou no meio** → ninguém olha essa lista hoje. Em Araguaína, 28 dos 57
 *    estavam a TRÊS SESSÕES ou menos de concluir: Balbina fez 47 de 48 e sumiu
 *    há 79 dias. É gente que pagou e não recebeu o que comprou.
 *
 * A assinatura existe para o "recusado" não virar ruído: se a recepção disse
 * "ainda está em tratamento", o nome só volta à fila quando o quadro clínico
 * mudar de verdade (nova sessão feita, ou outra data de última sessão). Sem
 * isso, o mesmo nome reaparece a cada varredura e ninguém abre a página.
 */

export type ClasseDaFila = 'ALTA' | 'PAROU';
export type EstadoDaFila = 'pendente' | 'aprovado' | 'recusado';

export interface CandidatoBruto {
  leadId: number;
  nome: string | null;
  classe: ClasseDaFila;
  realizadas: number;
  previstas: number;
  /** ISO da última sessão já ocorrida */
  ultimaSessao: string | null;
}

/**
 * O que define "o quadro mudou". Sessões feitas e data da última: é o que a
 * recepção olhou para decidir. Valor diferente = decisão velha, volta pra fila.
 */
export function assinaturaDoQuadro(c: Pick<CandidatoBruto, 'realizadas' | 'ultimaSessao'>): string {
  return `${c.realizadas}|${String(c.ultimaSessao ?? '').slice(0, 10)}`;
}

export interface JaNaFila {
  estado: EstadoDaFila;
  assinatura: string | null;
}

/**
 * Deve entrar (ou voltar) para a fila de pendentes?
 *  - nunca visto → sim
 *  - pendente → continua pendente (atualiza os números)
 *  - já decidido → só volta se a assinatura mudou
 */
export function devePendenciar(novo: CandidatoBruto, atual: JaNaFila | null | undefined): boolean {
  if (!atual) return true;
  if (atual.estado === 'pendente') return true;
  return atual.assinatura !== assinaturaDoQuadro(novo);
}

/** Quantas sessões faltam para fechar o protocolo. Nunca negativo. */
export function faltam(c: Pick<CandidatoBruto, 'realizadas' | 'previstas'>): number {
  return Math.max(0, (c.previstas || 0) - (c.realizadas || 0));
}

export function diasParado(ultimaSessao: string | null, agora: Date): number | null {
  if (!ultimaSessao) return null;
  const t = Date.parse(ultimaSessao);
  return Number.isFinite(t) ? Math.floor((agora.getTime() - t) / 86_400_000) : null;
}

/**
 * Ordem da lista de "parou no meio": primeiro quem está mais perto de concluir,
 * e entre esses, quem parou há menos tempo. É a ordem de quem tem mais chance de
 * voltar — e não a ordem alfabética, que faria a recepção começar pelo errado.
 */
export function ordenarParados<T extends CandidatoBruto>(lista: T[], agora: Date): T[] {
  return [...lista].sort((a, b) => {
    const fa = faltam(a);
    const fb = faltam(b);
    if (fa !== fb) return fa - fb;
    return (diasParado(a.ultimaSessao, agora) ?? 1e9) - (diasParado(b.ultimaSessao, agora) ?? 1e9);
  });
}

/** Ordem da lista de alta: quem terminou há mais tempo aparece primeiro. */
export function ordenarAltas<T extends CandidatoBruto>(lista: T[]): T[] {
  return [...lista].sort(
    (a, b) => Date.parse(a.ultimaSessao ?? '') - Date.parse(b.ultimaSessao ?? ''),
  );
}

export function resumoDoCandidato(c: CandidatoBruto, agora: Date): string {
  const f = faltam(c);
  const dias = diasParado(c.ultimaSessao, agora);
  const sessoes = c.previstas > 0 ? `${c.realizadas}/${c.previstas} sessões` : `${c.realizadas} sessões`;
  if (c.classe === 'ALTA') {
    return dias === null ? sessoes : `${sessoes} · última há ${dias} dia${dias === 1 ? '' : 's'}`;
  }
  const falta = f === 0 ? 'concluiu as sessões' : `falta${f === 1 ? '' : 'm'} ${f}`;
  return dias === null ? `${sessoes} · ${falta}` : `${sessoes} · ${falta} · parado há ${dias} dia${dias === 1 ? '' : 's'}`;
}
