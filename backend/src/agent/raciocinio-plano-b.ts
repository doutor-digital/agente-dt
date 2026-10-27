import { AIMessage, type BaseMessage } from '@langchain/core/messages';

/**
 * Blocos de raciocínio da Anthropic (`thinking` / `redacted_thinking`) são ligados ao modelo que os gerou. Com a
 * família 5.5 o raciocínio fica no conteúdo das mensagens da IA guardadas no histórico, e o conversor do LangChain
 * para OpenAI/Google repassa esses blocos crus — o que quebra o plano B. Aqui eles saem, SÓ da cópia que vai ao plano
 * B não-Anthropic. O principal NÃO passa por aqui: no modelo que os gerou, os blocos têm de voltar intactos
 * (tirá-los pode dar 400 de assinatura).
 *
 * Função pura: não altera as mensagens recebidas; só recria (com os mesmos tool_calls e metadados) as que tinham bloco.
 */
const TIPOS_DE_RACIOCINIO = new Set(['thinking', 'redacted_thinking']);

function ehBlocoDeRaciocinio(b: unknown): boolean {
  return !!b && typeof b === 'object' && TIPOS_DE_RACIOCINIO.has((b as { type?: unknown }).type as string);
}

export function semRaciocinioParaPlanoB(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((m) => {
    if (m.getType() !== 'ai' || !Array.isArray(m.content) || !m.content.some(ehBlocoDeRaciocinio)) return m;
    const ai = m as AIMessage;
    const resto = (ai.content as unknown[]).filter((b) => !ehBlocoDeRaciocinio(b));
    // Só sobrou texto: volta a string, que é o que OpenAI e Google esperam de uma mensagem simples.
    const soTexto = resto.every((b) => typeof b === 'string' || (b as { type?: string })?.type === 'text');
    const content = soTexto
      ? resto.map((b) => (typeof b === 'string' ? b : ((b as { text?: string }).text ?? ''))).join('')
      : resto;
    return new AIMessage({
      content: content as never,
      tool_calls: ai.tool_calls,
      additional_kwargs: ai.additional_kwargs,
      response_metadata: ai.response_metadata,
      usage_metadata: ai.usage_metadata,
      id: ai.id,
      name: ai.name,
    });
  });
}
