/** O modo de uma unidade no disparo (ligado | seco | desligado). Fica à parte para `onda.ts` e `porto.ts` lerem o mesmo sem se importarem. */
import { estadoDaAutomacao } from '../automacoes-estado.js';
import type { Modo } from './lote.js';

/** O id desta automação no catálogo (`lib/automacoes.ts`). */
export const AUTOMACAO_DISPARO = 'disparo-campanha';

export function modoDaUnidade(slug: string, env: NodeJS.ProcessEnv = process.env): Modo {
  return estadoDaAutomacao(slug, AUTOMACAO_DISPARO, env.DISPARO_CAMPANHA_SLUGS);
}
