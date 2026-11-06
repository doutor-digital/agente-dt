/**
 * Em que estado está a automação `despedida-humano` numa unidade. Mora fora de `agent/despedida-humano.ts` para o
 * alerta de "sem resposta" (lib) perguntar sem importar o módulo do agente, e para existir UMA definição do id e da variável.
 */
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';

export const AUTOMACAO_DESPEDIDA_HUMANO = 'despedida-humano';

/**
 * Despedida repetida sem a Sofia ter falado: dentro desta janela, CONTADA DA TAREFA, é o mesmo evento (segue calada e o alerta
 * de "sem resposta" não age). Passada, o aviso de ontem não garante que alguém olhou: vale o caminho normal (tarefa da equipe
 * vigente, ou tarefa nova) e o "sem resposta" volta a agir.
 */
export const JANELA_MESMO_EVENTO_MS = 6 * 3600_000;

export function estadoDaDespedidaHumano(slug: string, env: NodeJS.ProcessEnv = process.env): Estado {
  return estadoDaAutomacao(slug, AUTOMACAO_DESPEDIDA_HUMANO, env.DESPEDIDA_HUMANO_SLUGS);
}
