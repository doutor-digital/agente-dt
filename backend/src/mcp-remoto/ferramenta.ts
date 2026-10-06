/** Executa uma ferramenta do conector, transforma erro em resposta legível e registra na auditoria. */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';

export async function executar(
  nome: string,
  argumentos: unknown,
  auditar: Auditar | undefined,
  fn: () => Promise<unknown> | unknown,
): Promise<CallToolResult> {
  const inicio = Date.now();
  let resultado: CallToolResult;
  let erro: string | undefined;
  try {
    resultado = { content: [{ type: 'text', text: JSON.stringify(await fn()) }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    erro = e instanceof ErroDeEntrada ? `Pedido inválido: ${msg}` : msg;
    resultado = { isError: true, content: [{ type: 'text', text: erro }] };
  }
  try {
    auditar?.({ ferramenta: nome, argumentos, ok: !erro, ms: Date.now() - inicio, erro });
  } catch {
    // auditoria que falha não derruba a resposta
  }
  return resultado;
}
