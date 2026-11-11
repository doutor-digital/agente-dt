/**
 * A lista de segredos conferida contra o schema.prisma de verdade: coluna nova com cara de segredo tem de ser classificada aqui
 * (escondida pela regra ou revisada como inofensiva). Sem isso, um token novo numa tabela viraria legível pelo conector em silêncio.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { colunaSecreta, FUNCOES_PROIBIDAS, FUNCOES_PG_LIBERADAS, tabelaSecreta, TABELAS_SECRETAS } from './banco-segredos.js';

interface ColunaSchema {
  tabela: string;
  coluna: string;
}

/** Lê os modelos do schema.prisma: nome real da tabela (@@map) e das colunas (@map), sem os campos de relação. */
export function lerSchema(arquivo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/schema.prisma')): ColunaSchema[] {
  const texto = readFileSync(arquivo, 'utf8');
  const modelos = new Set([...texto.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]!));
  const saida: ColunaSchema[] = [];
  for (const m of texto.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const corpo = m[2]!;
    const tabela = /@@map\("([^"]+)"\)/.exec(corpo)?.[1] ?? m[1]!;
    for (const linha of corpo.split('\n')) {
      const l = linha.trim();
      if (!l || l.startsWith('//') || l.startsWith('@@') || l.startsWith('/*') || l.startsWith('*')) continue;
      const f = /^(\w+)\s+([\w.]+)(\[\])?(\?)?/.exec(l);
      if (!f) continue;
      if (modelos.has(f[2]!) || l.includes('@relation')) continue; // relação, não coluna
      saida.push({ tabela, coluna: /@map\("([^"]+)"\)/.exec(l)?.[1] ?? f[1]! });
    }
  }
  return saida;
}

const SCHEMA = lerSchema();

test('o leitor do schema.prisma acha as tabelas e colunas que conhecemos', () => {
  assert.ok(SCHEMA.length > 500);
  assert.ok(SCHEMA.some((c) => c.tabela === 'units' && c.coluna === 'kommo_access_token'));
  assert.ok(SCHEMA.some((c) => c.tabela === 'users' && c.coluna === 'password_hash'));
  assert.ok(SCHEMA.some((c) => c.tabela === 'chaves_de_integracao' && c.coluna === 'chave_cifrada'));
  assert.ok(!SCHEMA.some((c) => c.coluna === 'unit' && c.tabela === 'unit_actions'), 'campo de relação não é coluna');
});

test('tabelas de segredo conhecidas estão fechadas', () => {
  for (const t of ['chaves_de_integracao', 'mcp_oauth_clients', 'mcp_oauth_codigos', 'mcp_oauth_tokens', 'bling_conexoes', 'kommo_web_sessions', 'kommo_chat_sessions']) {
    assert.ok(SCHEMA.some((c) => c.tabela === t), `${t} existe no schema`);
    assert.ok(tabelaSecreta(t), t);
  }
  // as demais tabelas do schema continuam abertas (a regra não pode fechar o banco inteiro por engano)
  const fechadas = [...new Set(SCHEMA.map((c) => c.tabela))].filter((t) => tabelaSecreta(t)).sort();
  assert.deepEqual(fechadas, [...TABELAS_SECRETAS].sort());
});

test('colunas de segredo conhecidas estão escondidas', () => {
  const esperadas: Array<[string, string]> = [
    ['users', 'password_hash'],
    ['units', 'kommo_access_token'], ['units', 'kommo_widget_secret'], ['units', 'anthropic_api_key'], ['units', 'google_api_key'], ['units', 'openai_api_key'], ['units', 'openai_admin_key'],
    ['units', 'meta_access_token'], ['units', 'meta_verify_token'], ['units', 'meta_app_secret'], ['units', 'ig_access_token'], ['units', 'ig_verify_token'], ['units', 'ig_app_secret'],
    ['units', 'fb_access_token'], ['units', 'fb_verify_token'], ['units', 'fb_app_secret'], ['units', 'spine_token'], ['units', 'google_access_token'], ['units', 'google_refresh_token'],
    ['bling_conexoes', 'client_secret'], ['bling_conexoes', 'access_token'], ['bling_conexoes', 'refresh_token'],
    ['chaves_de_integracao', 'chave_cifrada'], ['mcp_oauth_tokens', 'token_hash'], ['mcp_oauth_codigos', 'codigo_hash'],
    ['kommo_chat_sessions', 'access_token'], ['kommo_chat_sessions', 'refresh_token'], ['kommo_web_sessions', 'refresh_token'],
  ];
  for (const [tabela, coluna] of esperadas) {
    assert.ok(SCHEMA.some((c) => c.tabela === tabela && c.coluna === coluna), `${tabela}.${coluna} existe no schema (renomeou? atualize a lista)`);
    assert.ok(colunaSecreta(coluna), `${tabela}.${coluna}`);
  }
});

/** O que PARECE segredo no nome. Toda coluna aberta que casar aqui tem de estar em REVISADAS, com o motivo. */
const PARECE = /(key|chave|token|secret|senha|passw|hash|cred|cookie|session|sess[aã]o|auth|signature|salt|cipher|cifrad|jwt|otp|bearer|private|webhook|pix|cpf|cnpj)/i;

const REVISADAS: Record<string, string> = {
  prompt_tokens: 'contagem de tokens de LLM',
  completion_tokens: 'contagem de tokens de LLM',
  total_tokens: 'contagem de tokens de LLM',
  max_tokens: 'limite de tokens de LLM',
  openai_max_tokens: 'limite de tokens de LLM',
  prompt_hash: 'hash do texto do prompt na avaliação: identifica versão, não abre nada',
  final_da_chave: 'só os últimos dígitos da chave, como a tela mostra',
  chave: 'chave de busca/idempotência (telefone, fato, mensagem), não credencial',
  chave_telefone: 'telefone normalizado para casar paciente',
  rule_key: 'nome da regra do alerta',
  key: 'chave de idempotência da mensagem',
  trigger_keywords: 'palavras que disparam o modelo de mensagem',
  handoff_keywords: 'palavras que passam a conversa a uma pessoa',
  pix_key: 'chave Pix da clínica para o paciente pagar (dado do negócio, aparece no sinal)',
  private_reply: 'resposta privada a comentário do Instagram (texto)',
  private_sent_at: 'data de envio da resposta privada',
  code_challenge: 'desafio PKCE (a tabela inteira está fechada)',
  sinal_pix_centavos: 'valor do sinal em centavos',
  pix_holder: 'nome do titular da chave Pix mostrado ao paciente',
  google_authorized_email: 'e-mail que autorizou a agenda (sem token)',
  google_authorized_at: 'data da autorização da agenda',
  author: 'quem fez a mudança no histórico da unidade',
  author_id: 'id do autor do comentário público do Instagram',
  author_username: 'usuário público do autor do comentário do Instagram',
  chaves: 'chaves primárias das linhas alteradas (registro de mcp_banco_alteracoes)',
};

test('toda coluna com cara de segredo ou está escondida ou foi revisada à mão', () => {
  const sobra = SCHEMA.filter((c) => !tabelaSecreta(c.tabela) && !colunaSecreta(c.coluna) && PARECE.test(c.coluna) && !(c.coluna in REVISADAS)).map((c) => `${c.tabela}.${c.coluna}`);
  assert.deepEqual(sobra, [], 'classifique estas colunas: esconda (banco-segredos.ts) ou acrescente a REVISADAS com o motivo');
});

test('a lista de revisadas não esconde nada de graça: cada uma ainda existe e está aberta', () => {
  for (const nome of Object.keys(REVISADAS)) {
    assert.ok(SCHEMA.some((c) => c.coluna === nome), `${nome} não existe mais no schema: tire de REVISADAS`);
  }
});

test('nomes: camelCase, maiúsculas e variações', () => {
  for (const c of ['passwordHash', 'PASSWORD_HASH', 'apiKey', 'api_key', 'ApiKey', 'accessToken', 'refreshToken', 'clientSecret', 'senha', 'senha_hash', 'chaveCifrada', 'secret', 'token', 'authToken', 'x_token_y', 'cookie', 'jwt', 'salt', 'otp_code']) {
    assert.ok(colunaSecreta(c), c);
  }
  for (const c of ['name', 'email', 'status', 'prompt_tokens', 'tokens', 'max_tokens', 'created_at', 'is_active', 'phone', 'slug', 'keywords', 'monkey', 'hashtag']) {
    assert.ok(!colunaSecreta(c), c);
  }
  for (const t of ['mcp_oauth_tokens', 'oauth_clients', 'user_sessions', 'sessoes', 'cofre_de_arquivos', 'credenciais_x', 'segredos', 'app_secrets', 'chaves_de_integracao']) assert.ok(tabelaSecreta(t), t);
  for (const t of ['units', 'users', 'conversations', 'mcp_auditoria', 'mcp_banco_alteracoes', 'llm_calls']) assert.ok(!tabelaSecreta(t), t);
});

test('funções proibidas', () => {
  for (const f of ['pg_read_file', 'pg_sleep', 'lo_import', 'dblink', 'dblink_exec', 'set_config', 'current_setting', 'nextval', 'query_to_xml', 'table_to_xml_and_xmlschema', 'ts_stat', 'txid_current', 'file_fdw']) assert.ok(FUNCOES_PROIBIDAS.test(f), f);
  for (const f of ['count', 'sum', 'lower', 'now', 'jsonb_build_object', 'date_trunc', 'coalesce', 'generate_series']) assert.ok(!FUNCOES_PROIBIDAS.test(f), f);
  assert.ok(FUNCOES_PG_LIBERADAS.has('pg_typeof'));
});
