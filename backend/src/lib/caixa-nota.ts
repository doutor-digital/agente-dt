import { listaDeUnidades } from './caixa-unidades.js';

/**
 * A nota fiscal dos lançamentos do Caixa (uma nota por lançamento, de qualquer forma de pagamento). Este arquivo é só o ENCAIXE: a emissão de verdade (Focus NFe, PR #500)
 * se registra aqui quando entrar no main. Enquanto não houver emissor registrado, `/interno/caixa/nota` responde 501 e nada é emitido.
 *
 * Duas travas, as duas precisam estar abertas:
 *  - `CAIXA_NOTA_UNIDADES` (slugs separados por vírgula; vazia ou ausente = desligada em todas; "*" não vale);
 *  - um emissor registrado (o gatilho da Focus; sem ele, 501).
 *
 * O CPF e o nome de quem paga passam por aqui na memória, a caminho do emissor, e NUNCA são gravados, logados nem mandados ao Telegram.
 */

export interface PedidoDeNotaDoCaixa {
  /** o slug da unidade (o mesmo da InfinitePay) */
  unidade: string;
  /** o id do lançamento do Caixa: UMA nota por lançamento (a chave da idempotência é `caixa:<lancId>`) */
  lancId: string;
  /** o valor do lançamento, lido pelo RH no banco dele (nunca da tela) */
  valorCentavos: number;
  /** data de competência do lançamento (AAAA-MM-DD) */
  competencia: string;
  tomador: { nome: string; documento: string };
}

export type EstadoDaNotaDoCaixa = 'emitida' | 'em_processamento' | 'recusada' | 'incerta' | 'cancelada';

export interface ResultadoDaNotaDoCaixa {
  estado: EstadoDaNotaDoCaixa;
  /** número e endereço da nota, quando a emissão terminou */
  numero?: string;
  url?: string;
  /** o motivo, SEM dado pessoal (a recusa do emissor já vem mascarada) */
  erro?: string;
  /** true = já existia uma nota deste lançamento (a segunda chamada não emitiu outra) */
  jaExistia?: boolean;
}

export interface EmissorDeNotaDoCaixa {
  /** idempotente por `lancId`: nunca emite duas notas do mesmo lançamento */
  emitir(p: PedidoDeNotaDoCaixa): Promise<ResultadoDaNotaDoCaixa>;
  consultar(unidade: string, lancId: string): Promise<ResultadoDaNotaDoCaixa | null>;
}

let atual: EmissorDeNotaDoCaixa | null = null;

export function registrarEmissorDeNotaDoCaixa(e: EmissorDeNotaDoCaixa | null): void {
  atual = e;
}

export function emissorDeNotaDoCaixa(): EmissorDeNotaDoCaixa | null {
  return atual;
}

/** Slugs com a nota do Caixa ligada. Vazio ou ausente = desligada em todas; "*" e "todas" não valem. */
export function unidadesComNotaDoCaixa(e: NodeJS.ProcessEnv = process.env): Set<string> {
  return listaDeUnidades(e.CAIXA_NOTA_UNIDADES);
}
