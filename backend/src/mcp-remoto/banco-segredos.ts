/**
 * O que o conector NUNCA mostra nem altera nos bancos (`banco_*`): cofre de chaves, tokens, sessões, OAuth, senhas e hashes.
 * A lista vale para leitura E escrita e é conferida contra o `schema.prisma` por teste (banco-segredos.test.ts): coluna nova
 * que pareça segredo e não esteja classificada ali derruba o teste, em vez de vazar em silêncio.
 *
 * Duas camadas, de propósito:
 *  1. TABELAS inteiras (nome na lista ou no padrão): não se lê nem se escreve; nem aparecem no esquema.
 *  2. COLUNAS de segredo dentro de tabelas boas (ex.: `users.password_hash`, `units.openai_api_key`): o nome é recusado em qualquer
 *     lugar da consulta e a tabela passa a ser lida por um invólucro que só tem as colunas boas (ver banco-sql.ts), de modo que
 *     `select *` e `select row_to_json(u)` também não trazem o segredo.
 */

/** Tabelas do banco do próprio agente-dt que guardam segredo (credencial, sessão, OAuth). Minúsculas. */
export const TABELAS_SECRETAS = new Set<string>([
  'chaves_de_integracao', // cofre de chaves cifradas das integrações (Asaas, Convênia, Tiquetaque, sistemas…)
  'mcp_oauth_clients', // clientes OAuth do conector
  'mcp_oauth_codigos', // códigos de autorização (hash + code_challenge)
  'mcp_oauth_tokens', // tokens de acesso do conector (hash)
  'bling_conexoes', // client_secret + access/refresh token do Bling
  'kommo_web_sessions', // sessão web do Kommo (cookie/refresh)
  'kommo_chat_sessions', // token de chat do Kommo
]);

/** Padrão do NOME de tabela: sessão, OAuth, cofre, credencial, segredo — vale também nos bancos do RH e do Descontratos. */
const PADRAO_TABELA = /(^|_)(oauth|sess(ao|oes|ion|ions)|cofre|credenciais?|credentials?|segredos?|secrets?)(_|$)/i;

/** camelCase e maiúsculas viram snake_case minúsculo (`passwordHash` → `password_hash`) antes de comparar */
function normalizar(nome: string): string {
  return nome.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Palavras que denunciam segredo mesmo coladas em outras (senhahash, apikeyx…). */
const FORTES = /(password|passwd|senha|secret|apikey|api_key|cipher|cifrad|credential|private_key|access_key|admin_key|client_secret)/;
/** Palavras ambíguas: só valem como palavra inteira entre `_` (token ≠ prompt_tokens, hash ≠ ... mas prompt_hash é liberado abaixo). */
const INTEIRAS = /(^|_)(token|hash|salt|otp|refresh|cookie|jwt|signature|sessao|session)(_|$)/;

/** Colunas que casam com o padrão mas NÃO são segredo (conferidas uma a uma). */
export const COLUNAS_LIBERADAS = new Set<string>([
  'prompt_hash', // hash do texto do prompt na avaliação da conversa: identifica versão, não abre nada
]);

/** Colunas de segredo por nome exato que o padrão acima não pegaria. Minúsculas. */
export const COLUNAS_SECRETAS_EXTRAS = new Set<string>([]);

export function colunaSecreta(nome: string): boolean {
  const n = normalizar(nome);
  if (COLUNAS_LIBERADAS.has(n)) return false;
  return COLUNAS_SECRETAS_EXTRAS.has(n) || FORTES.test(n) || INTEIRAS.test(n);
}

export function tabelaSecreta(nome: string): boolean {
  const n = normalizar(nome);
  return TABELAS_SECRETAS.has(n) || PADRAO_TABELA.test(n);
}

/**
 * Tabelas que se LEEM mas nunca se escrevem pelo conector: o registro e o backup das escritas (senão uma escrita apagaria a própria trilha, ou
 * forjaria um "backup" para o desfazer reinserir linhas à mão), a auditoria do conector e o controle de migrações. Minúsculas.
 */
export const TABELAS_SO_LEITURA = new Set<string>(['mcp_banco_alteracoes', 'mcp_auditoria', '_prisma_migrations']);

/**
 * Segredo guardado como LINHA de uma tabela genérica (o RH guarda os convites de acesso, com o token do link, em `rh_docs` com col = 'acesso_convites'):
 * a tabela é lida por um invólucro que já tira essas linhas, então nenhum truque de texto (concatenar, chr(), escape) chega nelas.
 * `coluna` precisa existir na tabela; se não existir, a tabela fica fechada.
 */
export const LINHAS_FECHADAS: ReadonlyArray<{ tabela: string; coluna: string; valor: string }> = [{ tabela: 'rh_docs', coluna: 'col', valor: 'acesso_convites' }];

/**
 * Esquemas que o RH e o Descontratos (que vieram do Supabase) podem ter e que guardam segredo/credencial. A API do sistema só lê o `public`, mas o nome
 * é recusado aqui também. Vale só para esses dois bancos (o do agente lista os esquemas de verdade).
 */
export const ESQUEMAS_DE_SISTEMA = ['auth', 'storage', 'extensions', 'realtime', 'vault', 'graphql', 'graphql_public', 'pgsodium', 'supabase_functions', 'supabase_migrations', 'cron', 'net', 'pgbouncer'];

/** Funções que leem arquivo, executam texto como SQL, mexem em configuração/sequência ou saem do banco: proibidas em qualquer consulta e escrita. */
export const FUNCOES_PROIBIDAS = /^(lo_\w*|dblink\w*|set_config|current_setting|nextval|setval|currval|lastval|query_to_xml\w*|table_to_xml\w*|cursor_to_xml|schema_to_xml\w*|database_to_xml\w*|ts_stat|txid_\w+|pg_\w+|\w+_fdw)$/;

/** Funções do pg_ que são só aritmética/formatação e ficam liberadas. */
export const FUNCOES_PG_LIBERADAS = new Set(['pg_typeof', 'pg_size_pretty']);
