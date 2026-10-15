/** Fila de chamadas com intervalo mínimo — o Bling aceita 3 requisições/s por conta. */

/**
 * Fila que garante um intervalo mínimo entre o INÍCIO de duas chamadas. Puro (relógio e espera
 * injetáveis) pra testar sem esperar de verdade.
 */
export class Ritmo {
  private proxima = 0;
  constructor(
    private readonly intervaloMs: number,
    private readonly agora: () => number = Date.now,
    private readonly esperar: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async vez(): Promise<void> {
    const t = this.agora();
    const minha = Math.max(t, this.proxima);
    this.proxima = minha + this.intervaloMs;
    if (minha > t) await this.esperar(minha - t);
  }
}

