/**
 * Sequência do SIGTERM, num lugar só para ser testável (o server.ts só liga as pontas).
 *
 * Por que esperar ANTES de fechar a porta: no deploy start-first o Swarm manda SIGTERM ao container antigo, mas o Traefik
 * só tira o container da lista de destinos na próxima atualização dele (o provider Swarm consulta o Docker a cada ~15 s;
 * a config do Traefik mora na VPS, não neste repositório). Fechar a porta antes disso dava 502 em quem o Traefik
 * ainda mandava para cá — inclusive o webhook do Kommo/Meta. Durante a espera o processo segue atendendo normalmente
 * (os turnos em curso e a janela do coalescer andam); só depois a porta fecha e a fila é drenada.
 *
 * Orçamento dentro do `stop_grace_period: 60s` do docker-compose.yml (SIGKILL depois disso):
 *   0 ──── 20 s espera do Traefik ──── porta fecha ──── drenagem (até o teto) ──── 55 s limite ──── 60 s SIGKILL
 * Os 5 s finais sobram para soltar o lease e desconectar o banco. A drenagem nunca passa de 55 s CONTADOS DO SIGTERM,
 * qualquer que seja o valor das variáveis.
 */

export const PRAZO_TOTAL_PADRAO_MS = 55_000;
export const ESPERA_TRAEFIK_PADRAO_MS = 20_000;
export const TETO_DRENAGEM_PADRAO_MS = 35_000;

export interface PlanoDesligamento {
  esperaTraefikMs: number;
  /** Quanto a drenagem pode durar, depois que a porta fecha. */
  tetoDrenagemMs: number;
  prazoTotalMs: number;
}

function numero(v: string | undefined, padrao: number): number {
  if (v === undefined || v.trim() === '') return padrao;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : padrao;
}

export function planoDeDesligamento(env: NodeJS.ProcessEnv = process.env): PlanoDesligamento {
  return {
    esperaTraefikMs: numero(env.SHUTDOWN_ESPERA_TRAEFIK_MS, ESPERA_TRAEFIK_PADRAO_MS),
    tetoDrenagemMs: numero(env.SHUTDOWN_AGUARDA_TURNOS_MS, TETO_DRENAGEM_PADRAO_MS) || TETO_DRENAGEM_PADRAO_MS,
    prazoTotalMs: PRAZO_TOTAL_PADRAO_MS,
  };
}

export interface DepsDesligamento {
  agora(): number;
  dormir(ms: number): Promise<void>;
  fecharPorta(): void;
  drenar(maxMs: number): Promise<{ filaRestante: number; restantes: number; esperouMs: number }>;
}

export interface ResultadoDesligamento {
  esperouTraefikMs: number;
  tetoUsadoMs: number;
  filaRestante: number;
  restantes: number;
}

/** Espera o Traefik, fecha a porta e drena com o que sobrar do prazo total. Nunca lança por causa da espera. */
export async function desligarComGraca(plano: PlanoDesligamento, deps: DepsDesligamento): Promise<ResultadoDesligamento> {
  const inicio = deps.agora();
  // A espera também cabe no prazo: configuração absurda não estoura o stop_grace_period.
  const espera = Math.min(plano.esperaTraefikMs, plano.prazoTotalMs);
  if (espera > 0) await deps.dormir(espera);
  deps.fecharPorta();
  const decorrido = deps.agora() - inicio;
  const teto = Math.max(0, Math.min(plano.tetoDrenagemMs, plano.prazoTotalMs - decorrido));
  const r = await deps.drenar(teto);
  return { esperouTraefikMs: espera, tetoUsadoMs: teto, filaRestante: r.filaRestante, restantes: r.restantes };
}
