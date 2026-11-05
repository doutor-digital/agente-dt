import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';

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

/**
 * `cache_control` (e o `ttl` dentro dele) é marca de prompt caching da Anthropic: o prompt do sistema sai em blocos
 * `[{type:'text', text, cache_control}]` e a conversa pode levar a marca no último bloco. O conversor do ChatOpenAI repassa
 * o bloco CRU — o campo desconhecido chega na OpenAI dentro de `messages[i].content[j]`. Para o plano B de outro provedor
 * a marca não significa nada: sai, e o que sobrar só de blocos de texto volta a ser string (o formato que OpenAI e Google
 * esperam de uma mensagem simples; o prompt do sistema junta os blocos com linha em branco).
 *
 * Função pura: não altera as mensagens recebidas (o principal as manda intactas, com a marca) e devolve a MESMA referência
 * para a mensagem que não tem marca nenhuma.
 */
function temMarcaDeCache(content: unknown): boolean {
  return Array.isArray(content) && content.some((b) => !!b && typeof b === 'object' && 'cache_control' in (b as object));
}

function semMarcaDeCache(m: BaseMessage): BaseMessage {
  if (!temMarcaDeCache(m.content)) return m;
  const blocos = (m.content as unknown[]).map((b) => {
    if (!b || typeof b !== 'object') return b;
    const { cache_control: _marca, ...resto } = b as Record<string, unknown>;
    return resto;
  });
  const soTexto = blocos.every((b) => typeof b === 'string' || (b as { type?: string })?.type === 'text');
  const content = (
    soTexto
      ? blocos.map((b) => (typeof b === 'string' ? b : ((b as { text?: string }).text ?? ''))).join(m.getType() === 'system' ? '\n\n' : '')
      : blocos
  ) as never;
  switch (m.getType()) {
    case 'system':
      return new SystemMessage({ content, id: m.id, name: m.name, additional_kwargs: m.additional_kwargs, response_metadata: m.response_metadata });
    case 'human':
      return new HumanMessage({ content, id: m.id, name: m.name, additional_kwargs: m.additional_kwargs, response_metadata: m.response_metadata });
    case 'ai': {
      const ai = m as AIMessage;
      return new AIMessage({
        content,
        tool_calls: ai.tool_calls,
        additional_kwargs: ai.additional_kwargs,
        response_metadata: ai.response_metadata,
        usage_metadata: ai.usage_metadata,
        id: ai.id,
        name: ai.name,
      });
    }
    case 'tool': {
      const t = m as ToolMessage;
      return new ToolMessage({ content, tool_call_id: t.tool_call_id, name: t.name, status: t.status, artifact: t.artifact, id: t.id });
    }
    default:
      return m;
  }
}

/**
 * O que o plano B recebe: com o plano B na própria Anthropic, as mensagens vão como estão (a marca de cache e o raciocínio
 * valem lá); com OpenAI ou Google, sem os blocos de raciocínio e sem a marca de cache.
 */
export function mensagensParaPlanoB(provider: string, messages: BaseMessage[]): BaseMessage[] {
  if (provider === 'anthropic') return messages;
  return semRaciocinioParaPlanoB(messages).map(semMarcaDeCache);
}
