// Estrutura por campos (tabela, coluna, índice). O MESMO arquivo (estrutura-campos.ts) e os MESMOS casos (estrutura-campos-casos.json) existem no
// sistemas-dd (src/estrutura-campos.ts, test/estrutura-campos.test.ts): os hashes abaixo travam os dois; se um lado mudar, o outro tem de mudar igual.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ErroEstrutura, nomeFechado, planejar, planejarTabela, TIPOS_ACEITOS, type Existentes } from './estrutura-campos.js';

const HASH_DAS_REGRAS = '1357df6acc6e49ec7a2126bed5c9579a510481f776c1238548a836eadb311f04';
const HASH_DOS_CASOS = '3a3350d0bfd57d555dd194ea9e5ca2498e7191d068482076cdb56ab6d938b8a6';

interface Caso {
  nome: string;
  entrada: Record<string, unknown>;
  existentes: Record<string, { linhas: number | null; colunas: string[] }>;
  esperado: 'ok' | 'recusa';
  sql?: string[];
  msg?: string;
}
const casos = JSON.parse(readFileSync(new URL('./estrutura-campos-casos.json', import.meta.url), 'utf8')) as Caso[];
const sha = (arquivo: string) => createHash('sha256').update(readFileSync(new URL(arquivo, import.meta.url))).digest('hex');

test('arquivo de regras e conjunto de casos são os mesmos nos dois repositórios (hashes travados)', () => {
  assert.equal(sha('./estrutura-campos.ts'), HASH_DAS_REGRAS, 'estrutura-campos.ts mudou: copie para ~/sistemas-dd/src/estrutura-campos.ts e atualize o hash nos DOIS testes');
  assert.equal(sha('./estrutura-campos-casos.json'), HASH_DOS_CASOS, 'estrutura-campos-casos.json mudou: copie para ~/sistemas-dd/test/ e atualize o hash nos DOIS testes');
});

test(`conjunto de casos (${casos.length}): o SQL gerado é o esperado e toda entrada ruim é recusada pelo motivo certo`, () => {
  assert.ok(casos.length > 100);
  const erros: string[] = [];
  for (const c of casos) {
    const ex: Existentes = { tabelas: new Map(Object.entries(c.existentes)) };
    let sql: string[] | null = null;
    let msg = '';
    try {
      sql = planejar(c.entrada, ex).sql;
    } catch (e) {
      if (!(e instanceof ErroEstrutura)) throw e;
      msg = e.message;
    }
    if (c.esperado === 'ok') {
      if (sql === null) erros.push(`DEVIA ACEITAR: ${c.nome} -> ${msg}`);
      else if (c.sql && JSON.stringify(c.sql) !== JSON.stringify(sql)) erros.push(`SQL DIFERENTE: ${c.nome}\n  esperado ${JSON.stringify(c.sql)}\n  gerado   ${JSON.stringify(sql)}`);
    } else if (sql !== null) erros.push(`DEVIA RECUSAR: ${c.nome} -> ${JSON.stringify(sql).slice(0, 120)}`);
    else if (c.msg && !new RegExp(c.msg).test(msg)) erros.push(`MOTIVO ERRADO: ${c.nome} -> ${msg.slice(0, 120)} (esperava /${c.msg}/)`);
  }
  assert.deepEqual(erros, []);
});

test('nada do que a pessoa escreve vira SQL solto: todo SQL gerado só tem nomes entre aspas, tipos da lista e padrões validados', () => {
  const ex: Existentes = { tabelas: new Map() };
  const p = planejarTabela({ nome: 'caixa_seguro', colunas: [{ nome: 'obs', tipo: 'text', padrao: 'a; b (c) 10%' }, { nome: 'valor', tipo: 'numeric(12,2)', padrao: 1.5 }] }, ex);
  const tudo = p.sql.join('\n');
  assert.ok(!/drop|truncate|delete from|insert into|grant|--|\/\*|\$/i.test(tudo.replace(/'a; b \(c\) 10%'/, '')), tudo);
  assert.deepEqual(TIPOS_ACEITOS, ['text', 'integer', 'bigint', 'numeric(12,2)', 'boolean', 'date', 'timestamptz', 'uuid', 'jsonb']);
  for (const n of ['rh_usuarios', 'rh_docs', 'rh_log', 'rh_site_x', 'admin_log', 'auth_users', 'storage_x', 'pg_roles']) assert.equal(nomeFechado(n), true, n);
  for (const n of ['caixa_lanc', 'fin_lanc', 'caixa_precos', 'rh_ferias', 'colaboradores']) assert.equal(nomeFechado(n), false, n);
});
