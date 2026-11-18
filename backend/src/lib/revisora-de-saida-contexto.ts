/**
 * O que o GRAFO sabe do paciente e o webhook não: o prompt do turno (com o status lido da franquia) só existe dentro de `graph.ts`, mas a
 * revisora de saída roda DEPOIS do envio, no `processAgent`. Mesma ponte que a marca de consulta marcada (`lib/cartao-de-chegada.ts`):
 * o grafo guarda por `traceId`, o controller consome. Em memória, com validade — nunca vai ao banco e uma réplica nunca lê a de outra
 * (o turno inteiro roda no mesmo processo).
 *
 * Só guarda quando a revisora está LIGADA OU SECA na unidade: desligada na tela, o grafo nem classifica o prompt (nada é pago nem retido).
 */
import { promptDizEmTratamento } from '../agent/taxa-de-reserva.js';
import { blocoDaConsulta, promptTemConsulta } from '../agent/reserva-sem-marcar.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import type { StatusDoPaciente } from './revisora-de-saida.js';

/** `id` no catálogo (`lib/automacoes.ts`) e na tabela `unit_automacoes`. Nunca mude depois de criada. */
export const AUTOMACAO_REVISORA_DE_SAIDA = 'revisora-de-saida';

/** Nasce em SECO na rede toda (`quandoVazio: 'seco'`); a tela desliga por unidade. */
export function estadoDaRevisora(slug: string, env: NodeJS.ProcessEnv = process.env): Estado {
  return estadoDaAutomacao(slug, AUTOMACAO_REVISORA_DE_SAIDA, env.REVISORA_SAIDA_SLUGS);
}

const VALIDADE_MS = 10 * 60_000;
const guardados = new Map<string, { em: number; status: StatusDoPaciente }>();

/** O status do paciente como o prompt DESTE turno o descreveu. Puro: testável sem o grafo. */
export function statusDoPacienteDoPrompt(prompt: string | null | undefined): StatusDoPaciente {
  const p = String(prompt ?? '');
  const bloco = promptTemConsulta(p) ? blocoDaConsulta(p).replace(/\s+/g, ' ').trim() : '';
  return {
    emTratamento: promptDizEmTratamento(p),
    jaAtendido: /Já foi atendido:/.test(p),
    consultaMarcada: bloco || (promptTemConsulta(p) ? 'o prompt confirma consulta/sessão de pé' : null),
  };
}

export function guardarStatusDoTurno(traceId: string, status: StatusDoPaciente, agora: number = Date.now()): void {
  for (const [k, v] of guardados) if (agora - v.em > VALIDADE_MS) guardados.delete(k);
  guardados.set(traceId, { em: agora, status });
}

/** O que o grafo chama: nunca lança — o auxiliar não pode quebrar o turno que ele só observa. */
export function guardarStatusDoPrompt(slug: string, traceId: string, prompt: string | null | undefined): void {
  try {
    if (estadoDaRevisora(slug) === 'desligado') return;
    guardarStatusDoTurno(traceId, statusDoPacienteDoPrompt(prompt));
  } catch {
    /* sem status a revisora trata o paciente como "sem informação" */
  }
}

/** Consome: cada turno é revisado no máximo uma vez. */
export function pegarStatusDoTurno(traceId: string, agora: number = Date.now()): StatusDoPaciente | null {
  const g = guardados.get(traceId);
  guardados.delete(traceId);
  return g && agora - g.em <= VALIDADE_MS ? g.status : null;
}
