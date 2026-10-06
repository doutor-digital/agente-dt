/**
 * Quanto e quando o MCP chama a franquia. O token é o MESMO do agente e do dashboard, e a
 * franquia está medindo consumo por token (e-mail de 06/10/2026). Aqui ficam:
 *  - Ritmo: uma requisição por vez por token, com intervalo mínimo entre elas;
 *  - Orcamento: teto de requisições por chamada de ferramenta;
 *  - Cache: o que já foi lido não é lido de novo dentro do prazo;
 *  - Contador: quantas chamadas foram feitas, pra responder à franquia com número medido.
 */

export type Dormir = (ms: number) => Promise<void>;
export const dormir: Dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export class Ritmo {
  private cadeias = new Map<string, Promise<unknown>>();
  private ultimaSaida = new Map<string, number>();

  constructor(
    private intervaloMs: number,
    private esperar: Dormir = dormir,
    private agora: () => number = Date.now,
  ) {}

  /**
   * Roda `fn` na fila da `chave`: só começa quando a anterior da mesma chave terminou E
   * passou `intervaloMs` desde o início dela. Chaves diferentes não esperam uma pela outra.
   */
  vez<T>(chave: string, fn: () => Promise<T>): Promise<T> {
    const anterior = this.cadeias.get(chave) ?? Promise.resolve();
    const atual = anterior.then(async () => {
      const falta = (this.ultimaSaida.get(chave) ?? -Infinity) + this.intervaloMs - this.agora();
      if (falta > 0) await this.esperar(falta);
      this.ultimaSaida.set(chave, this.agora());
      return fn();
    });
    // a fila segue mesmo se esta falhar; quem chamou recebe o erro pelo `atual`
    this.cadeias.set(chave, atual.catch(() => undefined));
    return atual;
  }
}

export class OrcamentoEsgotado extends Error {}

/** Teto de requisições de UMA chamada de ferramenta, somando todas as unidades. */
export class Orcamento {
  private gastas = 0;
  constructor(readonly teto: number) {}

  gastar(): void {
    if (this.gastas >= this.teto) throw new OrcamentoEsgotado(`teto de ${this.teto} requisições atingido`);
    this.gastas++;
  }

  get usadas(): number {
    return this.gastas;
  }
}

export class Cache {
  private itens = new Map<string, { valor: unknown; expira: number }>();

  constructor(private agora: () => number = Date.now) {}

  pegar<T>(chave: string): T | undefined {
    const item = this.itens.get(chave);
    if (!item) return undefined;
    if (item.expira <= this.agora()) {
      this.itens.delete(chave);
      return undefined;
    }
    return item.valor as T;
  }

  guardar(chave: string, valor: unknown, ttlMs: number): void {
    this.itens.set(chave, { valor, expira: this.agora() + ttlMs });
  }
}

export const TTL = {
  bi: 6 * 3_600_000, // §10.7: BI 1 a 2 vezes por dia
  dadosGerais: 24 * 3_600_000,
  busca: 10 * 60_000,
} as const;

interface Contagem {
  chamadas: number;
  erros: number;
}

export class Contador {
  readonly desde = new Date().toISOString();
  private porChave = new Map<string, Contagem>();

  /** `/api/clients/123` e `/api/clients/456` são o mesmo endpoint pra efeito de consumo. */
  static endpoint(metodo: string, caminho: string): string {
    return `${metodo} ${caminho.replace(/\/\d+(?=\/|$)/g, '/{id}')}`;
  }

  registrar(slug: string, metodo: string, caminho: string, ok: boolean): void {
    const chave = `${slug}\u0000${Contador.endpoint(metodo, caminho)}`;
    const c = this.porChave.get(chave) ?? { chamadas: 0, erros: 0 };
    c.chamadas++;
    if (!ok) c.erros++;
    this.porChave.set(chave, c);
  }

  resumo(): { desde: string; total: number; porUnidade: Record<string, Record<string, Contagem>> } {
    const porUnidade: Record<string, Record<string, Contagem>> = {};
    let total = 0;
    for (const [chave, c] of this.porChave) {
      const [slug = '?', endpoint = '?'] = chave.split('\u0000');
      (porUnidade[slug] ??= {})[endpoint] = { ...c };
      total += c.chamadas;
    }
    return { desde: this.desde, total, porUnidade };
  }
}

/** `fn` em cada item, no máximo `limite` ao mesmo tempo, devolvendo na ordem da entrada. */
export async function emParalelo<T, R>(itens: T[], limite: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const saida = new Array<R>(itens.length);
  let proximo = 0;
  const trabalhador = async () => {
    while (proximo < itens.length) {
      const i = proximo++;
      saida[i] = await fn(itens[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, trabalhador));
  return saida;
}
