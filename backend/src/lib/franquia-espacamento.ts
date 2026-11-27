/**
 * Espaçamento das criações de lead na franquia (27/11/2026).
 *
 * Em 06/10 a franquia reclamou do consumo da API. Com o cadastro de todo lead no 1º contato (`cadastro-lead-primeiro-contato`), uma
 * rajada (o deploy reinicia, a unidade volta do pause, uma campanha derrama gente) viraria dezenas de POST /api/leads no mesmo segundo.
 * Aqui as criações de UMA mesma franquia (mesmo endereço e token — a unidade e o `-resgate` dela dividem) passam numa fila de uma
 * por vez, com no mínimo `ESPACO_ENTRE_CRIACOES_MS` entre o fim de uma e o começo da outra. Em memória: reiniciar zera a fila, e
 * o que estava nela volta na próxima mensagem do paciente (o cadastro nunca é perdido, só adiado).
 */
export const ESPACO_ENTRE_CRIACOES_MS = 1500;

const filas = new Map<string, { cauda: Promise<unknown>; ultimaEm: number }>();

export async function espacarCriacao<T>(
  franquia: string,
  fn: () => Promise<T>,
  espacoMs: number = ESPACO_ENTRE_CRIACOES_MS,
  dormir: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  agora: () => number = Date.now,
): Promise<T> {
  const f = filas.get(franquia) ?? { cauda: Promise.resolve(), ultimaEm: 0 };
  const minha = f.cauda
    .catch(() => undefined)
    .then(async () => {
      const espera = f.ultimaEm + espacoMs - agora();
      if (espera > 0) await dormir(espera);
      try {
        return await fn();
      } finally {
        f.ultimaEm = agora();
      }
    });
  f.cauda = minha;
  filas.set(franquia, f);
  try {
    return await minha;
  } finally {
    // fila vazia não fica na memória
    if (f.cauda === minha && filas.size > 100) filas.delete(franquia);
  }
}

/** A franquia de uma unidade: o endereço da API + o token (unidade e `-resgate` com o mesmo token são uma fila só). */
export function chaveDaFranquia(unit: { spineBaseUrl?: string | null; spineToken?: string | null }): string {
  return `${unit.spineBaseUrl ?? ''}|${unit.spineToken ?? ''}`;
}
