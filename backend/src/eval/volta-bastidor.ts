import { ToolMessage } from '@langchain/core/messages';

/**
 * A "segunda volta" do banco dourado — o que o grafo da produção faz e o eval não fazia.
 *
 * Na produção (`agent/graph.ts`: agent → tools → agent) a Sofia pode começar o turno só com uma
 * ferramenta de BASTIDOR — pôr a etiqueta "Quente", gravar a Queixa, trocar o título do cartão — sem
 * texto nenhum. O grafo executa a ferramenta e chama o modelo de novo, e é NESSA segunda chamada que
 * sai a fala para o paciente (medido em 27/11/2026: 255 de 282 turnos com `aplicar_tag` em 7 dias
 * terminaram com texto; os outros 27 foram "resposta segurada" porque o paciente mandou outra mensagem).
 *
 * O eval só olhava a PRIMEIRA chamada. Quando o modelo escolhia abrir com a etiqueta, o caso saía
 * "(sem texto)" e reprovava — Boa Vista "onde fica?" em 25/11 e 27/11, Porto "quero marcar" em 26/11 —
 * e o relatório diário acusava a Sofia de ficar muda, o que na produção não acontece.
 *
 * Aqui: se a resposta não tem texto e TODAS as chamadas são de bastidor, devolvemos a cada uma um
 * resultado simulado no formato da produção e chamamos o modelo de novo, até `MAX_VOLTAS`. Nada é
 * executado. Ferramenta cujo RESULTADO muda a fala (`consultar_horarios`, `agendar_consulta`,
 * `pausar_ia`…) NÃO entra: inventar o resultado dela seria testar uma conversa que não existe — nesse
 * caso o eval segue avaliando a chamada planejada, como sempre.
 */

/** Ferramentas cujo resultado não muda o que a Sofia fala. `registra_*` são as regras de campo (`lead_field_rules`). */
const BASTIDOR = new Set(['aplicar_tag', 'atualizar_titulo_lead', 'mover_etapa']);

export function ehDeBastidor(nome: string): boolean {
  return BASTIDOR.has(nome) || nome.startsWith('registra_');
}

/** Voltas EXTRAS além da primeira chamada. A produção não tem teto tão baixo, mas um turno de bastidor que não fala em 2 voltas já é sinal de erro. */
export const MAX_VOLTAS = 2;

export interface ChamadaDeFerramenta {
  name: string;
  id?: string;
  args?: Record<string, unknown>;
}

/** PURA: a resposta precisa de outra volta? Só sem texto, com chamadas, todas de bastidor e com id (sem id não há como responder a chamada). */
export function precisaDeOutraVolta(texto: string, chamadas: readonly ChamadaDeFerramenta[]): boolean {
  if (texto.trim() !== '') return false;
  if (chamadas.length === 0) return false;
  return chamadas.every((c) => ehDeBastidor(c.name) && typeof c.id === 'string' && c.id.length > 0);
}

/** PURA: o texto que a ferramenta devolveria na produção — o mesmo "OK — …" de `agent/tools.ts`, sem executar nada. */
export function resultadoSimulado(c: ChamadaDeFerramenta): string {
  if (c.name === 'aplicar_tag') return 'OK — tag aplicada no lead.';
  if (c.name === 'mover_etapa') return 'OK — lead movido de etapa.';
  if (c.name === 'atualizar_titulo_lead') return 'OK — título atualizado.';
  return 'OK — campo gravado no cartão.';
}

/** As respostas de ferramenta que fecham as chamadas de bastidor, na ordem em que vieram. */
export function respostasSimuladas(chamadas: readonly ChamadaDeFerramenta[]): ToolMessage[] {
  return chamadas.map(
    (c) => new ToolMessage({ content: resultadoSimulado(c), tool_call_id: c.id as string, name: c.name }),
  );
}
