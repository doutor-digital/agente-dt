import { convertToOpenAITool } from '@langchain/core/utils/function_calling';

/**
 * As ferramentas no formato que a OpenAI aceita: `{ type: 'function', function: { name, description, parameters } }`.
 *
 * Por que isto existe: com a unidade no Claude, `limparSchemaDoModelo` / `aplicarStrictAnthropic` gravam em cada ferramenta
 * `extras.providerToolDefinition` = `{ name, description, input_schema }` (formato da Anthropic). O `bindTools` do
 * ChatOpenAI dá PRECEDÊNCIA a esse campo e o repassa cru — sem `type` — e a OpenAI recusa a chamada inteira com
 * `400 Missing required parameter: 'tools[0].type'`. Resultado em 26/10: o plano B (gpt-4o) nunca respondeu em
 * unidade de Claude; ficou escondido por trás do "429 sem crédito" até o crédito voltar.
 *
 * `convertToOpenAITool` lê só o `schema` (Zod) da ferramenta e ignora o `extras`, que é o que queremos aqui.
 */
export function toolsParaOpenAI(tools: unknown[]): unknown[] {
  return tools.map((t) => convertToOpenAITool(t as never));
}
