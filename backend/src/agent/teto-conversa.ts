import { logger } from '../lib/logger.js';

/**
 * Teto de gasto por conversa.
 *
 * Existia teto por CHAMADA (maxTokens) e orçamento mensal por unidade — mas o
 * mensal só pintava um aviso no painel: nada bloqueava chamada nenhuma. Entre os
 * dois faltava justamente o que segura o caso ruim: uma conversa que sozinha
 * queima o orçamento do mês.
 *
 * O jeito de isso acontecer não é exótico. Prompt de 46 mil caracteres, paciente
 * que manda quarenta mensagens, histórico crescendo a cada turno — e cada turno
 * relendo tudo. A conta cresce sem ninguém notar, porque cada chamada
 * individualmente parece barata.
 *
 * O QUE ACONTECE AO ESTOURAR
 * --------------------------
 * A IA para naquela conversa e o humano assume. NÃO é para o paciente ficar sem
 * resposta — conversa cara é quase sempre conversa quente, e desligar em
 * silêncio seria perder exatamente o lead que mais interessa. O teto é um sinal
 * de "isto aqui precisa de gente", não um corte de custo cego.
 *
 * A contagem vive em memória, por conversa, e é isso que se quer: o caso que
 * este teto pega é o descontrole DENTRO de uma conversa, que acontece em
 * minutos. Guardar em banco custaria uma escrita por turno para proteger contra
 * o caso raro de o contêiner reiniciar no meio de um descontrole.
 */

/** Teto padrão por conversa, em dólar. Generoso: pegar caso patológico, não uso normal. */
export const TETO_CONVERSA_USD = Number(process.env.TETO_CONVERSA_USD) || 1.5;

/**
 * Fração do teto a partir da qual a conversa já é registrada como cara.
 *
 * Serve pra descobrir a calibragem ANTES de alguém ser cortado errado: se
 * conversa normal desta operação encosta no teto, isso aparece no log como aviso
 * — e o número se ajusta — em vez de aparecer como paciente entregue à
 * secretária sem motivo.
 */
const FRACAO_DE_AVISO = 0.6;

/** Conversa parada por mais que isto some da contagem. */
const TTL_MS = 6 * 60 * 60_000;

const MAX_ENTRADAS = 20_000;

interface Gasto {
  usd: number;
  turnos: number;
  ultimoEm: number;
  jaAvisou: boolean;
  jaChamouAtencao: boolean;
}

const gastos = new Map<string, Gasto>();

function limpar(agora: number): void {
  for (const [k, g] of gastos) {
    if (agora - g.ultimoEm > TTL_MS) gastos.delete(k);
  }
}

export function registrarGasto(threadId: string, usd: number): void {
  if (!threadId || !Number.isFinite(usd) || usd <= 0) return;
  const agora = Date.now();
  if (gastos.size >= MAX_ENTRADAS) limpar(agora);

  const g = gastos.get(threadId) ?? {
    usd: 0,
    turnos: 0,
    ultimoEm: agora,
    jaAvisou: false,
    jaChamouAtencao: false,
  };
  const antes = g.usd;
  g.usd += usd;
  g.turnos += 1;
  g.ultimoEm = agora;
  gastos.set(threadId, g);

  const aviso = TETO_CONVERSA_USD * FRACAO_DE_AVISO;
  if (antes < aviso && g.usd >= aviso && !g.jaChamouAtencao) {
    g.jaChamouAtencao = true;
    logger.warn(
      { threadId, usd: Number(g.usd.toFixed(4)), turnos: g.turnos, teto: TETO_CONVERSA_USD },
      'conversa passou de 60% do teto de gasto — ainda atendendo, mas vale conferir a calibragem',
    );
  }
}

export interface Veredito {
  estourou: boolean;
  usd: number;
  turnos: number;
  teto: number;
}

/**
 * A conversa passou do teto? Chamado ANTES de gastar mais — melhor parar num
 * turno que já custou caro do que descobrir depois de gastar de novo.
 */
export function conferirTeto(threadId: string, tetoUsd = TETO_CONVERSA_USD): Veredito {
  const g = gastos.get(threadId);
  const usd = g?.usd ?? 0;
  return { estourou: usd >= tetoUsd, usd, turnos: g?.turnos ?? 0, teto: tetoUsd };
}

/** Marca que já avisamos, para não repetir o alerta a cada turno da mesma conversa. */
export function marcarAvisado(threadId: string): boolean {
  const g = gastos.get(threadId);
  if (!g || g.jaAvisou) return false;
  g.jaAvisou = true;
  return true;
}

export function gastoDaConversa(threadId: string): Veredito {
  return conferirTeto(threadId);
}

/** Retrato para o painel: as conversas mais caras em andamento. */
export function conversasMaisCaras(limite = 10): Array<{ threadId: string; usd: number; turnos: number }> {
  return [...gastos.entries()]
    .map(([threadId, g]) => ({ threadId, usd: Number(g.usd.toFixed(4)), turnos: g.turnos }))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, limite);
}

export function _resetarGastos(): void {
  gastos.clear();
}

export function logarEstouro(threadId: string, v: Veredito, slug: string): void {
  logger.error(
    { threadId, unit: slug, usd: Number(v.usd.toFixed(4)), turnos: v.turnos, teto: v.teto },
    'conversa passou do teto de gasto — IA parou e o humano assume',
  );
}
