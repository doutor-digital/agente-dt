/**
 * Leitura das conversas do funil (quadro, Hoje, Oportunidades, Marketing, Gestor) no Chatwoot.
 *
 * Por que existe (pedido do João, 23/11/2026): a aba «Funil» ficou lenta conforme os leads crescem. Cada abertura lia ~14 páginas EM FILA
 * (o Chatwoot atende em fila: ≈0,8 s cada ≈ 11 s) e a mesma leitura era refeita para cada pessoa e cada clique. Duas peças:
 *
 *  1. `lerPaginasCruas`: a leitura em si, SEM filtrar o arquivo (a decisão «acabou a caixa» já se faz pela página crua). Por ser crua, uma
 *     leitura só serve a todas as telas; quem filtra o arquivo (`semArquivo`: «fora» ou «com-etapa») faz isso DEPOIS, sobre a cópia.
 *  2. `MemoriaDeLeitura`: a leitura pronta fica na memória por CONTA e conjunto de caixas (a mesma serve a todas as atendentes que enxergam
 *     as mesmas caixas), pedidos iguais em andamento viram um só, e passado o prazo «fresco» o valor velho ainda serve por um tempo curto
 *     enquanto UMA releitura corre em segundo plano (stale-while-revalidate). Escrita pelo servidor (mover etapa, responder, atribuir…)
 *     invalida a conta: quem acabou de mover um cartão nunca vê o quadro velho.
 *
 * O que NÃO muda: as mesmas páginas, na mesma ordem, com a mesma regra de parada (a de hoje), uma por vez.
 */
import { arquivoComEtapa, ehArquivo, importadaDaKommo } from './chatwoot-regua.js';

/**
 * Conversas de ARQUIVO (histórico unificado no canal oficial, ninguém mexeu depois — `ehArquivo`): 'fora' = some da tela
 * (Hoje, Marketing, Gestor); 'com-etapa' = só as que têm etapa (quadro do funil e Oportunidades).
 */
export type Arquivo = 'fora' | 'com-etapa';
export function semArquivo(pg: any, arquivo: Arquivo): any {
  const lista = pg?.data?.payload;
  if (!Array.isArray(lista)) return pg;
  const fica = lista.filter((c: any) => !ehArquivo(c) || (arquivo === 'com-etapa' && arquivoComEtapa(c)));
  return fica.length === lista.length ? pg : { ...pg, data: { ...pg.data, payload: fica } };
}

export type Buscar = (caminho: string, query?: Record<string, string>) => Promise<unknown>;

export interface LeituraCrua {
  paginas: unknown[];
  /** alguma caixa tinha mais conversas que o teto de páginas */
  cortou: boolean;
  /** quantos pedidos ao Chatwoot a leitura fez (vai para o log quando demora) */
  pedidos: number;
}

/**
 * As páginas da listagem de conversas, caixa por caixa, `lote` páginas por vez. A lista vem pela última atividade (mais nova primeiro) e o
 * arquivo é sempre mais velho que as conversas vivas: página CHEIA SÓ DE ARQUIVO = dali para trás é tudo arquivo, a caixa para de ser lida
 * (sem «cortou» falso). O fim da caixa se mede pela página CRUA (25 por página).
 *
 * EXCEÇÃO — o histórico da Kommo: a conversa importada leva a data REAL do cartão (recente, às vezes de ontem) e não obedece a «o arquivo é sempre mais
 * velho que as vivas»: uma conversa viva e quieta (consulta de pé, paciente que voltou há uma semana, conversa normal) pode ficar ABAIXO de uma página
 * inteira de cartões importados. Página com conversa importada da Kommo nunca encerra a leitura da caixa: a leitura segue até o fim da caixa ou o teto.
 */
export async function lerPaginasCruas(buscar: Buscar, caixas: number[], maxPaginas: number, lote = 1): Promise<LeituraCrua> {
  const paginas: unknown[] = [];
  let cortou = false;
  let pedidos = 0;
  for (const id of caixas) {
    for (let p = 1; p <= maxPaginas; p += lote) {
      const numeros = Array.from({ length: Math.min(lote, maxPaginas - p + 1) }, (_, i) => p + i);
      pedidos += numeros.length;
      const lidas = (await Promise.all(numeros.map((n) => buscar('conversations', { status: 'all', assignee_type: 'all', inbox_id: String(id), page: String(n) })))) as any[];
      let acabou = false;
      for (const pg of lidas) {
        const crua: any[] = Array.isArray(pg?.data?.payload) ? pg.data.payload : [];
        if (crua.length < 25) acabou = true;
        if (crua.length > 0 && crua.every((c) => ehArquivo(c) && !importadaDaKommo(c))) acabou = true;
        paginas.push(pg);
      }
      if (acabou) break;
      if (p + lote - 1 >= maxPaginas) cortou = true;
    }
  }
  return { paginas, cortou, pedidos };
}

interface Entrada<T> {
  geracao: number;
  /** quando o valor foi lido (ms) */
  em: number;
  valor?: T;
  /** a busca em andamento (a mesma para todo mundo que pedir enquanto ela corre) */
  andando?: Promise<T>;
  /** quando a última renovação em segundo plano falhou: espera um pouco antes de tentar de novo (não vira uma leitura inteira por clique) */
  falhouEm?: number;
}

/** Depois de uma renovação em segundo plano que falhou, só tenta de novo passado este tempo (o velho segue servindo). */
export const ESPERA_APOS_FALHA_MS = 15_000;

export type DeOndeVeio = 'fresco' | 'velho' | 'junto' | 'lido';

export class MemoriaDeLeitura<T> {
  private readonly entradas = new Map<string, Entrada<T>>();
  private readonly geracoes = new Map<number, number>();

  constructor(
    private readonly frescoMs: number,
    private readonly velhoMs: number,
    private readonly agora: () => number = Date.now,
    private readonly aoFalharEmSegundoPlano: (e: unknown) => void = () => {},
  ) {}

  private geracaoDe(conta: number): number {
    return this.geracoes.get(conta) ?? 0;
  }

  /** Alguém escreveu na conta: nada do que está guardado (nem o que está sendo lido agora) vale mais. */
  invalidar(conta: number): void {
    this.geracoes.set(conta, this.geracaoDe(conta) + 1);
    for (const k of this.entradas.keys()) if (k.startsWith(`${conta}|`)) this.entradas.delete(k);
  }

  /**
   * Faz as entradas cuja chave o teste aceita deixarem de ser «frescas»: o valor ainda serve na hora (marcado como velho) e a PRÓXIMA leitura dispara
   * a renovação em segundo plano. Para o que mudou mas não vale a pena pagar a leitura fria na cara de quem pediu.
   */
  envelhecerSe(testa: (chave: string) => boolean): void {
    for (const [k, e] of this.entradas) if (testa(k) && e.valor !== undefined) e.em = Math.min(e.em, this.agora() - this.frescoMs);
  }

  esquecerTudo(): void {
    this.entradas.clear();
  }

  private ler(conta: number, chave: string, buscar: () => Promise<T>): Promise<T> {
    const geracao = this.geracaoDe(conta);
    const e: Entrada<T> = { geracao, em: this.agora() };
    const p = buscar();
    e.andando = p;
    this.entradas.set(chave, e);
    p.then(
      (valor) => {
        // se a conta foi invalidada no meio da leitura, o que veio já nasceu velho: não guarda
        if (this.entradas.get(chave) === e && this.geracaoDe(conta) === geracao) { e.valor = valor; e.em = this.agora(); delete e.andando; }
        else if (this.entradas.get(chave) === e) this.entradas.delete(chave);
      },
      () => { if (this.entradas.get(chave) === e) this.entradas.delete(chave); },
    );
    return p;
  }

  /** `chave` = conta + o que muda a leitura (caixas, teto de páginas). Devolve o valor e de onde veio (para o log). */
  async obter(conta: number, chave: string, buscar: () => Promise<T>): Promise<{ valor: T; de: DeOndeVeio }> {
    const k = `${conta}|${chave}`;
    const e = this.entradas.get(k);
    const t = this.agora();
    // entrada vencida (passou do «velho», sem leitura em andamento) não fica guardada para sempre: as páginas cruas pesam
    if (this.entradas.size > 20) for (const [kk, v] of this.entradas) if (kk !== k && !v.andando && v.valor !== undefined && t - v.em >= this.velhoMs) this.entradas.delete(kk);
    if (e && e.geracao === this.geracaoDe(conta)) {
      if (e.valor !== undefined) {
        const idade = t - e.em;
        if (idade < this.frescoMs) return { valor: e.valor, de: 'fresco' };
        if (idade < this.velhoMs) {
          if (!e.andando && t - (e.falhouEm ?? -Infinity) >= ESPERA_APOS_FALHA_MS) this.renovar(conta, k, e, buscar);
          return { valor: e.valor, de: 'velho' };
        }
      } else if (e.andando) {
        return { valor: await e.andando, de: 'junto' };
      }
    }
    return { valor: await this.ler(conta, k, buscar), de: 'lido' };
  }

  /** Releitura em segundo plano: o valor velho segue servindo até a nova chegar; falhou, o velho fica até vencer. */
  private renovar(conta: number, k: string, velha: Entrada<T>, buscar: () => Promise<T>): void {
    const geracao = this.geracaoDe(conta);
    const p = buscar();
    velha.andando = p;
    p.then(
      (valor) => {
        delete velha.andando;
        if (this.entradas.get(k) === velha && this.geracaoDe(conta) === geracao) { velha.valor = valor; velha.em = this.agora(); }
      },
      (e: unknown) => {
        delete velha.andando;
        velha.falhouEm = this.agora();
        this.aoFalharEmSegundoPlano(e);
      },
    );
  }
}

/**
 * Fresco: serve direto. Velho: serve na hora e renova em segundo plano. Passou disso: lê de novo e espera.
 *
 * 27/11/2026: era 20 s / 2 min. As telas se atualizam sozinhas a cada 60 s (Hoje) e 120 s (as outras) e a leitura são ~41 páginas em fila; com 20 s de
 * «fresco» TODA atualização de TODA aba aberta passava do prazo e disparava uma varredura inteira em segundo plano (medido: ~300 páginas em 10 min só
 * por isso, num Chatwoot de um processo só). Com 90 s a atualização de 60 s cai dentro do prazo e a renovação vira uma a cada ~2 min; quem MOVE ou
 * escreve pelo funil continua invalidando na hora (nunca vê o quadro velho). O «velho» sobe só de 2 para 3 min: é o máximo de idade que a tela mostra enquanto a renovação corre.
 */
export const FUNIL_FRESCO_MS = 90_000;
export const FUNIL_VELHO_MS = 180_000;
