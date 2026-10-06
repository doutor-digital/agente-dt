/**
 * Freios do conector remoto. Ele roda no MESMO processo da Sofia: tentativa de login roda bcrypt
 * (caro) e chamada de ferramenta gasta os tokens da franquia que ela também usa. Nada aqui pode
 * crescer sem limite.
 */
import type { Request } from 'express';

/**
 * IP de quem chamou. Atrás do Traefik, o `req.ip` é o do Traefik pra todo mundo. O Traefik
 * ACRESCENTA o IP que viu no fim do X-Forwarded-For; o começo da lista quem escreve é o cliente
 * (falsificável). Por isso vale o ÚLTIMO item, nunca o primeiro.
 */
export function ipDoCliente(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const lista = (Array.isArray(xff) ? xff.join(',') : (xff ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
  return lista.at(-1) ?? req.socket?.remoteAddress ?? 'desconhecido';
}

/** Conta eventos por chave numa janela deslizante. Varre as chaves velhas pra não crescer sem fim. */
export class JanelaDeContagem {
  private eventos = new Map<string, number[]>();
  private ultimaVarredura = 0;

  constructor(
    readonly max: number,
    readonly janelaMs: number,
  ) {}

  private recentes(chave: string, agora: number): number[] {
    const r = (this.eventos.get(chave) ?? []).filter((t) => agora - t < this.janelaMs);
    if (r.length) this.eventos.set(chave, r);
    else this.eventos.delete(chave);
    return r;
  }

  excedido(chave: string, agora: number): boolean {
    this.varrer(agora);
    return this.recentes(chave, agora).length >= this.max;
  }

  registrar(chave: string, agora: number): void {
    const r = this.recentes(chave, agora);
    r.push(agora);
    this.eventos.set(chave, r);
  }

  limpar(chave: string): void {
    this.eventos.delete(chave);
  }

  get tamanho(): number {
    return this.eventos.size;
  }

  private varrer(agora: number): void {
    if (agora - this.ultimaVarredura < this.janelaMs && this.eventos.size < 5_000) return;
    this.ultimaVarredura = agora;
    for (const chave of [...this.eventos.keys()]) this.recentes(chave, agora);
  }
}

/** No máximo `limite` ao mesmo tempo; quem passa de `esperaMaxMs` na fila desiste. */
export class Semaforo {
  private ocupados = 0;
  private fila: Array<() => void> = [];

  constructor(
    readonly limite: number,
    private esperaMaxMs: number,
  ) {}

  async entrar(): Promise<() => void> {
    if (this.ocupados < this.limite) {
      this.ocupados++;
      return this.saidaUnica();
    }
    return new Promise((resolve, reject) => {
      const vez = () => {
        clearTimeout(desiste);
        this.ocupados++;
        resolve(this.saidaUnica());
      };
      const desiste = setTimeout(() => {
        this.fila = this.fila.filter((f) => f !== vez);
        reject(new Error('conector ocupado'));
      }, this.esperaMaxMs);
      this.fila.push(vez);
    });
  }

  private saidaUnica(): () => void {
    let saiu = false;
    return () => {
      if (saiu) return;
      saiu = true;
      this.ocupados--;
      this.fila.shift()?.();
    };
  }
}
