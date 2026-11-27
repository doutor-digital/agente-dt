/**
 * A InfinitePay DESTE servidor: o contexto das contas e o estado da escrita (tetos, trava por unidade, livro no banco) que o conector do claude.ai usa
 * (mcp-remoto/producao.ts) e que a Sofia usa para cobrar o sinal por link (lib/sinal-infinitepay.ts). Uma instância só: assim o teto do dia, o limite por
 * hora e a trava de «uma criação por vez» valem para os DOIS caminhos juntos. Antes de o conector subir (ou num processo sem ele) não há nada: quem pede recebe null.
 */
import type { ContextoInfinitepay } from '../mcp-remoto/infinitepay.js';
import type { EstadoEscritaInfinitepay } from '../mcp-remoto/infinitepay-escrita.js';

export interface InfinitepayDoServidor {
  ctx: ContextoInfinitepay;
  esc: EstadoEscritaInfinitepay;
}

let atual: InfinitepayDoServidor | null = null;

export function registrarInfinitepayDoServidor(i: InfinitepayDoServidor | null): void {
  atual = i;
}

export function infinitepayDoServidor(): InfinitepayDoServidor | null {
  return atual;
}
