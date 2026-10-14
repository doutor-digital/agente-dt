/**
 * Ponte, fase 3 — cache por CONTA do Kommo para o que muda pouco e a Ponte pede muito: as etiquetas da conta,
 * os campos do cartão e as respostas prontas. Chave = subdomínio (unidades que dividem o Kommo dividem o cache),
 * como a fila do dia. Vários pedidos juntos viram UMA ida ao Kommo (a mesma promessa): o limitador do Kommo é um
 * só para o processo, e cada chamada a mais atrasa a Sofia.
 */
export class CacheDaConta<T> {
  private readonly guardado = new Map<string, { em: number; valor: T }>();
  private readonly emAndamento = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxContas = 500,
  ) {}

  /** O valor da conta: o guardado, se ainda vale; senão busca (e guarda). `forcar` ignora o guardado. */
  async obter(conta: string, buscar: () => Promise<T>, forcar = false): Promise<T> {
    const k = conta.trim().toLowerCase();
    const g = this.guardado.get(k);
    if (!forcar && g && Date.now() - g.em < this.ttlMs) return g.valor;
    let p = this.emAndamento.get(k);
    if (!p) {
      p = buscar()
        .then((valor) => {
          if (this.guardado.size >= this.maxContas) this.guardado.clear();
          this.guardado.set(k, { em: Date.now(), valor });
          return valor;
        })
        .finally(() => this.emAndamento.delete(k));
      this.emAndamento.set(k, p);
    }
    return p;
  }

  limpar(conta?: string): void {
    if (conta) this.guardado.delete(conta.trim().toLowerCase());
    else this.guardado.clear();
  }
}

/** A chave da conta de uma unidade: o subdomínio do Kommo. */
export function contaDaUnidade(unit: { kommoSubdomain: string | null }): string {
  return String(unit.kommoSubdomain ?? '').trim().toLowerCase();
}
