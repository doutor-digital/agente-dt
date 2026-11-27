/**
 * Freio e conta das chamadas ao Chatwoot (27/11/2026).
 *
 * Por que existe: o Chatwoot da Doutor Digital é UM processo Puma. Medido nos logs dele (27/11), 98% dos pedidos vinham do próprio agente-dt
 * (varreduras da régua, do CAPI, da agenda, leitura do funil) e a rajada chegou a 249 pedidos/min: a tela das atendentes engasgava porque o
 * Rails estava saturado por nós. Duas peças:
 *
 *  1. CONTA por origem (`regua`, `capi`, `agenda`, `funil`…): a cada 10 min o log diz quem pediu quanto. Sem isso o próximo excesso volta a ser
 *     descoberto pelo sintoma («está lento»), não pela causa.
 *  2. FREIO só para o trabalho de FUNDO (`baixa`: varreduras que não têm ninguém esperando): balde de fichas (`porSegundo`, com `rajada`) mais
 *     um teto de pedidos ao mesmo tempo, POR instalação do Chatwoot. Quem está com a atendente esperando (a tela com o login dela) e a resposta
 *     da Sofia ao paciente NUNCA passam pelo freio: só são contados. Quando o freio segura alguém por mais que `LIMIAR_DO_AVISO_MS`, vai para o
 *     log (no máximo um aviso por minuto).
 *
 * `CHATWOOT_LIMITE_POR_SEG=0` desliga o freio (a conta continua). Nada aqui toca no conteúdo dos pedidos.
 */
import { logger } from './logger.js';

export const LIMIAR_DO_AVISO_MS = 2_000;
const JANELA_DO_RESUMO_MS = 10 * 60_000;
const ENTRE_AVISOS_MS = 60_000;

export interface OpcoesDoLimite {
  /** pedidos de fundo por segundo (0 = sem freio) */
  porSegundo: number;
  /** quantos podem sair de uma vez quando o balde está cheio */
  rajada: number;
  /** pedidos de fundo em andamento ao mesmo tempo, por instalação */
  simultaneas: number;
  agora?: () => number;
  dormir?: (ms: number) => Promise<void>;
  /** para o log; o teste injeta */
  registrar?: { aviso: (d: Record<string, unknown>, m: string) => void; resumo: (d: Record<string, unknown>, m: string) => void };
}

interface Balde {
  fichas: number;
  em: number;
  /** a fila: cada pedido espera o anterior (ordem de chegada) */
  cauda: Promise<void>;
  esperando: number;
  emAndamento: number;
  vagas: Array<() => void>;
}

export class LimitadorDoChatwoot {
  private readonly baldes = new Map<string, Balde>();
  private readonly agora: () => number;
  private readonly dormir: (ms: number) => Promise<void>;
  private readonly reg: NonNullable<OpcoesDoLimite['registrar']>;
  private porOrigem = new Map<string, number>();
  private segurados = 0;
  private esperaTotalMs = 0;
  private maiorEsperaMs = 0;
  private janelaDesde: number;
  private ultimoAviso = -Infinity;

  constructor(private readonly o: OpcoesDoLimite) {
    this.agora = o.agora ?? Date.now;
    this.dormir = o.dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.reg = o.registrar ?? { aviso: (d, m) => logger.warn(d, m), resumo: (d, m) => logger.info(d, m) };
    this.janelaDesde = this.agora();
  }

  /** Conta o pedido (sempre) e, se for de fundo e o freio estiver ligado, espera a vez antes de rodar `fn`. */
  async executar<T>(chave: string, origem: string, baixa: boolean, fn: () => Promise<T>): Promise<T> {
    this.contar(origem);
    if (!baixa || !(this.o.porSegundo > 0)) return fn();
    const b = this.balde(chave);
    const t0 = this.agora();
    b.esperando++;
    const minha = b.cauda.then(() => this.pegarFicha(b));
    b.cauda = minha.catch(() => undefined);
    await minha;
    await this.pegarVaga(b);
    b.esperando--;
    this.anotarEspera(origem, this.agora() - t0, b.esperando);
    try {
      return await fn();
    } finally {
      // a vaga passa direto para quem espera (sem abrir brecha para um recém-chegado furar a fila)
      const proximo = b.vagas.shift();
      if (proximo) proximo();
      else b.emAndamento--;
    }
  }

  private balde(chave: string): Balde {
    let b = this.baldes.get(chave);
    if (!b) this.baldes.set(chave, (b = { fichas: this.o.rajada, em: this.agora(), cauda: Promise.resolve(), esperando: 0, emAndamento: 0, vagas: [] }));
    return b;
  }

  private async pegarFicha(b: Balde): Promise<void> {
    for (;;) {
      const t = this.agora();
      b.fichas = Math.min(this.o.rajada, b.fichas + ((t - b.em) * this.o.porSegundo) / 1000);
      b.em = t;
      if (b.fichas >= 1) {
        b.fichas -= 1;
        return;
      }
      await this.dormir(Math.max(1, Math.ceil(((1 - b.fichas) / this.o.porSegundo) * 1000)));
    }
  }

  private async pegarVaga(b: Balde): Promise<void> {
    if (b.emAndamento < this.o.simultaneas) {
      b.emAndamento++;
      return;
    }
    await new Promise<void>((ok) => b.vagas.push(ok)); // quem sai passa a vaga: não soma de novo
  }

  private anotarEspera(origem: string, esperaMs: number, fila: number): void {
    if (esperaMs < 50) return; // o agendamento normal do Node não é «segurar»
    this.segurados++;
    this.esperaTotalMs += esperaMs;
    this.maiorEsperaMs = Math.max(this.maiorEsperaMs, esperaMs);
    const t = this.agora();
    if (esperaMs >= LIMIAR_DO_AVISO_MS && t - this.ultimoAviso >= ENTRE_AVISOS_MS) {
      this.ultimoAviso = t;
      this.reg.aviso({ origem, esperaMs, fila, porSegundo: this.o.porSegundo }, 'chatwoot: o freio segurou um pedido de fundo (é de propósito: poupa o Chatwoot das atendentes)');
    }
  }

  private contar(origem: string): void {
    const t = this.agora();
    if (t - this.janelaDesde >= JANELA_DO_RESUMO_MS) this.resumir(t); // fecha a janela ANTES: este pedido já é da seguinte
    this.porOrigem.set(origem, (this.porOrigem.get(origem) ?? 0) + 1);
  }

  /** O que cada origem pediu desde o último resumo (sai no log a cada 10 min, sem timer: junto do primeiro pedido depois da janela). */
  resumir(t = this.agora()): { minutos: number; total: number; porOrigem: Record<string, number>; segurados: number; maiorEsperaMs: number } {
    const porOrigem = Object.fromEntries([...this.porOrigem].sort((a, b) => b[1] - a[1]));
    const total = [...this.porOrigem.values()].reduce((s, n) => s + n, 0);
    const r = { minutos: Math.max(1, Math.round((t - this.janelaDesde) / 60_000)), total, porOrigem, segurados: this.segurados, maiorEsperaMs: this.maiorEsperaMs };
    this.reg.resumo({ ...r, esperaTotalMs: this.esperaTotalMs }, 'chatwoot: pedidos do agente-dt por origem');
    this.porOrigem = new Map();
    this.segurados = 0;
    this.esperaTotalMs = 0;
    this.maiorEsperaMs = 0;
    this.janelaDesde = t;
    return r;
  }

  /** Só para teste. */
  contagem(): Record<string, number> {
    return Object.fromEntries(this.porOrigem);
  }
}

const numero = (v: string | undefined, padrao: number): number => {
  if (v === undefined || v.trim() === '') return padrao;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : padrao;
};

/** O limitador do processo (um só: o Chatwoot é um só). */
export const limitadorDoChatwoot = new LimitadorDoChatwoot({
  porSegundo: numero(process.env.CHATWOOT_LIMITE_POR_SEG, 3),
  rajada: Math.max(1, numero(process.env.CHATWOOT_LIMITE_RAJADA, 6)),
  simultaneas: Math.max(1, numero(process.env.CHATWOOT_LIMITE_SIMULTANEAS, 3)),
});
