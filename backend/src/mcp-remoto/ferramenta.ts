/** Executa uma ferramenta do conector, transforma erro em resposta legível e registra na auditoria. */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { mascararErro } from '../lib/integracoes/mascaras.js';

/** O conteúdo de uma resposta de ferramenta: texto e/ou imagem (base64). */
export type Conteudo = CallToolResult['content'];

/**
 * Corpo comum: roda, transforma erro em resposta legível e registra na auditoria. Só os argumentos vão para a auditoria,
 * nunca o conteúdo devolvido (imagem inclusive).
 */
async function rodar(nome: string, argumentos: unknown, auditar: Auditar | undefined, produzir: () => Promise<Conteudo> | Conteudo): Promise<CallToolResult> {
  const inicio = Date.now();
  let resultado: CallToolResult;
  let erro: string | undefined;
  try {
    resultado = { content: await produzir() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // o erro repete o pedido (CPF na rota, CNPJ no filtro): mascara antes de voltar ao modelo e de ir para a auditoria
    erro = mascararErro(e instanceof ErroDeEntrada ? `Pedido inválido: ${msg}` : msg);
    resultado = { isError: true, content: [{ type: 'text', text: erro }] };
  }
  try {
    auditar?.({ ferramenta: nome, argumentos, ok: !erro, ms: Date.now() - inicio, erro });
  } catch {
    // auditoria que falha não derruba a resposta
  }
  return resultado;
}

export function executar(
  nome: string,
  argumentos: unknown,
  auditar: Auditar | undefined,
  fn: () => Promise<unknown> | unknown,
): Promise<CallToolResult> {
  return rodar(nome, argumentos, auditar, async () => [{ type: 'text', text: JSON.stringify(await fn()) }]);
}

/** Variante para ferramenta que devolve IMAGEM (e texto): `fn` monta os blocos, na ordem em que o modelo os verá. */
export function executarComImagens(
  nome: string,
  argumentos: unknown,
  auditar: Auditar | undefined,
  fn: () => Promise<Conteudo> | Conteudo,
): Promise<CallToolResult> {
  return rodar(nome, argumentos, auditar, fn);
}
