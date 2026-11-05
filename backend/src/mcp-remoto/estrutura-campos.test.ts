// Estrutura por campos (tabela, coluna, índice). O MESMO arquivo (estrutura-campos.ts) e os MESMOS casos (estrutura-campos-casos.json) existem no
// sistemas-dd (src/estrutura-campos.ts, test/estrutura-campos.test.ts): os hashes abaixo travam os dois; se um lado mudar, o outro tem de mudar igual.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ErroEstrutura, impressaoDasPoliticas, nomeFechado, planejar, planejarColuna, planejarIndice, planejarTabela, REGRAS, REGRAS_ACEITAS, TIPOS_ACEITOS, unidadeCriaLinhas, type Existentes } from './estrutura-campos.js';

const HASH_DAS_REGRAS = '3cef31b022378f7060a007d0f287e6587fe25a9723d1f900d872ff97e6f274ee';
const HASH_DOS_CASOS = 'f3f186aa28ac2a54ae1b7baaf4b2596b59f45b3b9b0efd8dded92a6aeb44514c';

interface Caso {
  nome: string;
  entrada: Record<string, unknown>;
  existentes: Record<string, { linhas: number | null; colunas: string[]; tipos?: Record<string, string>; dono?: string; relkind?: string; politicas?: string[]; especial?: string[]; impressao?: string }>;
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
    const ex: Existentes = { tabelas: new Map(Object.entries(c.existentes).map(([k, v]) => [k, { ...v, tipos: v.tipos ? new Map(Object.entries(v.tipos)) : undefined }])) };
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
  // os 4 comandos de privilégio são fixos (papéis e verbos da lista, nome da tabela entre aspas): tiram-se antes de procurar palavra perigosa
  const semPrivilegios = tudo.replace(/^(revoke all on table|grant [a-z, ]+ on table) public\."caixa_seguro" (from|to) [a-z_, ]+$/gm, '');
  assert.equal((tudo.match(/^(revoke|grant) /gm) ?? []).length, 4, 'exatamente 4 comandos de privilégio, todos fixos');
  assert.ok(!/drop|truncate|delete from|insert into|grant|revoke|--|\/\*|\$/i.test(semPrivilegios.replace(/'a; b \(c\) 10%'/, '')), semPrivilegios);
  assert.deepEqual(TIPOS_ACEITOS, ['text', 'integer', 'bigint', 'numeric(12,2)', 'boolean', 'date', 'timestamptz', 'uuid', 'jsonb']);
  for (const n of ['rh_usuarios', 'rh_docs', 'rh_log', 'rh_site_x', 'admin_log', 'auth_users', 'storage_x', 'pg_roles']) assert.equal(nomeFechado(n), true, n);
  for (const n of ['caixa_lanc', 'fin_lanc', 'caixa_precos', 'rh_ferias', 'colaboradores']) assert.equal(nomeFechado(n), false, n);
});

test('regras: exatamente os 4 modelos medidos em produção; unidade_le_e_lanca AVISA sempre que a unidade preenche qualquer coluna; nenhum modelo dá DELETE', () => {
  assert.deepEqual(REGRAS_ACEITAS, ['unidade_le_gestao_grava', 'unidade_le_e_lanca', 'gestao_e_financeiro', 'so_admin_e_gestao']);
  assert.ok(Object.isFrozen(REGRAS));
  const ex: Existentes = { tabelas: new Map() };
  const p = planejarTabela({ nome: 'caixa_w', regra: 'unidade_le_e_lanca', colunas: [{ nome: 'unidade', tipo: 'text' }, { nome: 'aprovado', tipo: 'boolean' }] }, ex);
  assert.match(p.avisos.join(' '), /NÃO tem as travas de status e de autor da caixa_lanc.*aprovação/s);
  assert.match(REGRAS.unidade_le_e_lanca!.descricao, /QUALQUER valor/);
  for (const r of REGRAS_ACEITAS) {
    const col = REGRAS[r]!.precisaUnidade ? [{ nome: 'unidade', tipo: 'text' }] : [{ nome: 'obs', tipo: 'text' }];
    const sql = planejarTabela({ nome: 'caixa_w2', regra: r, colunas: col }, ex).sql.join('\n');
    assert.ok(!/for delete|for all/i.test(sql), r);
    assert.equal((sql.match(/create policy/g) ?? []).length, 3, r);
  }
  assert.equal(planejarTabela({ nome: 'caixa_w3', regra: 'unidade_le_gestao_grava', colunas: [{ nome: 'unidade', tipo: 'text' }] }, ex).avisos.length, 0, 'sem aviso fixo nos outros modelos');
});

test('texto verdadeiro: os 2 modelos de unidade dizem que admin, gestão E FINANCEIRO veem/criam/alteram; índice único em tabela que deixa a unidade criar linhas avisa da duplicidade; impressão das políticas é estável', () => {
  for (const r of ['unidade_le_gestao_grava', 'unidade_le_e_lanca']) assert.match(REGRAS[r]!.descricao, /^admin, gestão e financeiro veem, criam e alteram tudo \(inclusive trocam a unidade de uma linha\)/);
  const base = { linhas: 1, colunas: ['id', 'codigo', 'unidade'] };
  const com = planejarIndice({ tabela: 'caixa_t', colunas: ['codigo'], unico: true }, { tabelas: new Map([['caixa_t', { ...base, unidadeInsere: true }]]) });
  assert.match(com.avisos.join(' '), /deixa a UNIDADE criar linhas.*descobre que o valor existe/);
  assert.doesNotMatch(planejarIndice({ tabela: 'caixa_t', colunas: ['codigo'], unico: true }, { tabelas: new Map([['caixa_t', { ...base, unidadeInsere: false }]]) }).avisos.join(' '), /UNIDADE criar/);
  assert.doesNotMatch(planejarIndice({ tabela: 'caixa_t', colunas: ['codigo'] }, { tabelas: new Map([['caixa_t', { ...base, unidadeInsere: true }]]) }).avisos.join(' '), /UNIDADE criar/, 'índice comum não tem o problema');
  const a = { nome: 'p1', comando: 'SELECT', usando: 'caixa_gestor()', com_check: null, roles: ['authenticated'] };
  const b = { nome: 'p2', comando: 'INSERT', usando: null, com_check: 'caixa_pode(unidade)', roles: ['authenticated', 'anon'] };
  assert.equal(impressaoDasPoliticas([a, b]), impressaoDasPoliticas([b, { ...a, roles: ['authenticated'] }]), 'não depende da ordem das políticas');
  assert.notEqual(impressaoDasPoliticas([a, b]), impressaoDasPoliticas([a, { ...b, com_check: 'true' }]));
  assert.equal(impressaoDasPoliticas([a, b]), impressaoDasPoliticas([a, { ...b, roles: '{anon,authenticated}' }]), 'roles como texto do /esquema dá a mesma impressão que a lista do servidor');
  assert.equal(unidadeCriaLinhas([a, b]), true); assert.equal(unidadeCriaLinhas([a]), false);
  assert.doesNotThrow(() => impressaoDasPoliticas([{ nome: { toString: 1 }, comando: [1], usando: { valueOf: 'x' }, roles: [{ toString: 1 }] }]), 'valor estranho não lança');
});

test('coluna ÚNICA nova em tabela que deixa a unidade criar linhas (unidade_le_e_lanca) avisa da duplicidade; coluna comum ou tabela de outro modelo, não', () => {
  const ex = (unidadeInsere: boolean): Existentes => ({ tabelas: new Map([['caixa_t', { linhas: 0, colunas: ['id', 'unidade'], unidadeInsere }]]) });
  const unica = { tabela: 'caixa_t', coluna: { nome: 'codigo', tipo: 'text', unica: true } };
  assert.match(planejarColuna(unica, ex(true)).avisos.join(' '), /deixa a UNIDADE criar linhas.*coluna ÚNICA.*descobre que o valor existe/);
  assert.doesNotMatch(planejarColuna(unica, ex(false)).avisos.join(' '), /UNIDADE criar/);
  assert.doesNotMatch(planejarColuna({ tabela: 'caixa_t', coluna: { nome: 'codigo', tipo: 'text' } }, ex(true)).avisos.join(' '), /UNIDADE criar/);
});
