/**
 * Lê a CAUSA de uma falha de chamada à IA pela mensagem de erro do provedor (`llm_calls.error_message`).
 *
 * Fonte única das regras: os mesmos padrões servem ao JavaScript (`classificarCausa`) e ao SQL (`filtrosSql`), para que um
 * vigia que conta em SQL e outro que lê linha a linha nunca discordem. O teste de paridade em `taxa-erro-worker.pg.test.ts` confere os dois
 * contra um Postgres de verdade. Os padrões são escritos com `\y` (borda de palavra do Postgres); o JS troca por `\b`.
 *
 * A ORDEM importa: «429 … no credits remaining» é crédito, não limite de taxa; «400 invalid_request_error … credit balance»
 * também é crédito (a Anthropic devolve 400 para saldo zerado).
 *
 * Códigos HTTP só valem em contexto de status (início da mensagem, «status 401», «error: 401», «Error code: 429», «http 401»): um «512 tokens»
 * no meio do texto não pode virar «provedor fora do ar».
 */

export type Causa = 'credito' | 'autenticacao' | 'limite' | 'indisponivel' | 'outra';

const COD = String.raw`(^|status( code)?[: ]+|error( code)?[: ]+|http[: ]+|code[: ]+)\s*`;

export const PADROES = {
  credito: String.raw`credit balance|no credits?|out of credits?|insufficient[_ ]quota|exceeded your current quota|billing[_ ]hard[_ ]limit|billing[_ ]not[_ ]active|payment required|saldo (esgotado|insuficiente)|${COD}402\y`,
  autenticacao: String.raw`${COD}40[13]\y|invalid[_ ]api[_ ]key|incorrect api key|invalid x-api-key|authentication[_ ]error|authentication failed|unauthori[sz]ed|permission[_ ]denied|forbidden`,
  limite: String.raw`${COD}429\y|rate[_ ]limit|too many requests`,
  indisponivel: String.raw`${COD}5[0-9][0-9]\y|overloaded|timeout|timed out|connection error|network error|econn(reset|refused)|enotfound|fetch failed|socket hang up|service unavailable`,
} as const;

const paraJs = (p: string) => new RegExp(p.replaceAll(String.raw`\y`, String.raw`\b`), 'i');
const JS = {
  credito: paraJs(PADROES.credito),
  autenticacao: paraJs(PADROES.autenticacao),
  limite: paraJs(PADROES.limite),
  indisponivel: paraJs(PADROES.indisponivel),
};

export function classificarCausa(mensagem: string | null | undefined): Causa {
  const m = mensagem ?? '';
  if (JS.credito.test(m)) return 'credito';
  if (JS.autenticacao.test(m)) return 'autenticacao';
  if (JS.limite.test(m)) return 'limite';
  if (JS.indisponivel.test(m)) return 'indisponivel';
  return 'outra';
}

/**
 * Condições SQL (booleanas, mutuamente exclusivas, na mesma ordem) sobre a coluna `col` — que o chamador controla, nunca entrada
 * de usuário. Só valem junto de `status = 'error'`. `outra` = erro que nenhuma das quatro reconhece (inclui mensagem nula).
 */
export function filtrosSql(col: string) {
  const q = (p: string) => p.replaceAll("'", "''");
  const c = `coalesce(${col}, '')`;
  const credito = `${c} ~* '${q(PADROES.credito)}'`;
  const autenticacao = `not (${credito}) and ${c} ~* '${q(PADROES.autenticacao)}'`;
  const limite = `not (${c} ~* '${q(`${PADROES.credito}|${PADROES.autenticacao}`)}') and ${c} ~* '${q(PADROES.limite)}'`;
  const indisponivel = `not (${c} ~* '${q(`${PADROES.credito}|${PADROES.autenticacao}|${PADROES.limite}`)}') and ${c} ~* '${q(PADROES.indisponivel)}'`;
  return { credito, autenticacao, limite, indisponivel };
}
