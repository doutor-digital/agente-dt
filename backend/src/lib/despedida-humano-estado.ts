/**
 * Em que estado está a automação `despedida-humano` numa unidade. Mora fora de `agent/despedida-humano.ts` para o
 * alerta de "sem resposta" (lib) perguntar sem importar o módulo do agente, e para existir UMA definição do id e da variável.
 */
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';

export const AUTOMACAO_DESPEDIDA_HUMANO = 'despedida-humano';

export function estadoDaDespedidaHumano(slug: string, env: NodeJS.ProcessEnv = process.env): Estado {
  return estadoDaAutomacao(slug, AUTOMACAO_DESPEDIDA_HUMANO, env.DESPEDIDA_HUMANO_SLUGS);
}
