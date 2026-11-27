import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGORA_UTC } from './sql-tempo.js';

/**
 * Trava de regressão do bug de fuso (auditoria de 27/11): SQL cru NÃO compara coluna `timestamp` do agente_dt com `now()`
 * puro. O Prisma grava UTC em `timestamp` sem fuso e a sessão do banco é America/Sao_Paulo, então `created_at > now() -
 * interval '30 minutes'` cobre 3h30. Use `AGORA_UTC` / `agoraUtcSql` (lib/sql-tempo.ts).
 *
 * Exceções, cada uma com motivo:
 *  - worker-lease.ts: `expires_at` e `updated_at` são gravados pelo PRÓPRIO `now()` do banco e lidos contra `now()`:
 *    os dois lados estão em hora local, se compensam (e a linha vive 90 s).
 *  - meta-eventos.ts: consulta o banco do rastreio (capi_descartes), não o agente_dt, e a janela é de 90 dias.
 * (`sistemas-estrutura.ts` e `estrutura-campos.ts` tinham exceção na 1ª versão; só citam `now()` em texto de ajuda e em DDL de `timestamptz`, e o regex
 * atual já não os acusa, então a exceção saiu.)
 */
const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const EXCECOES = new Set(['lib/worker-lease.ts', 'mcp-remoto/meta-eventos.ts']);
// Relógio do banco (now(), current_timestamp, localtimestamp, current_date) em aritmética de janela (+/-) ou comparação, de qualquer
// lado: `created_at > now() - ...`, `now() > col`, `col <= CURRENT_TIMESTAMP`, `$1::timestamptz - ...`. `now() at time zone 'utc'` passa, e atribuição (`SET col = now()`) não é comparação: os escritores de hora local estão
// documentados em docs/fuso-agente-dt.md, seção 4.
const RELOGIO = String.raw`(?<![.\w])(?:now\(\)|current_timestamp|localtimestamp|current_date)`;
const PADRAO = new RegExp(`${RELOGIO}(?!\\s+at\\s+time\\s+zone)\\s*[-+<>]|[<>]=?\\s*${RELOGIO}|\\$\\d+::timestamptz\\s*[-+]`, 'i');

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : arquivos(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

test('a trava pega as formas que o primeiro regex deixava passar', () => {
  for (const ruim of ['where x > now() - interval', 'where now() > col', 'and col <= CURRENT_TIMESTAMP', 'now() < col', 'where d > current_date', 'x < localtimestamp']) assert.ok(PADRAO.test(ruim), ruim);
  for (const boa of ["now() at time zone 'utc'", 'default now()', 'Date.now() - t', 'performance.now() - t0', "(now() at time zone 'utc') - interval '1 minute'"]) assert.ok(!PADRAO.test(boa), boa);
});

test('AGORA_UTC é um timestamp UTC, independente do fuso da sessão', () => {
  assert.equal(AGORA_UTC, "(now() at time zone 'utc')");
});

test('nenhum SQL cru compara coluna timestamp com now() puro (3 h de erro)', () => {
  const culpados: string[] = [];
  for (const f of arquivos(RAIZ)) {
    const rel = relative(RAIZ, f).replaceAll('\\', '/');
    if (EXCECOES.has(rel)) continue;
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((linha, i) => {
        const t = linha.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        if (PADRAO.test(linha)) culpados.push(`${rel}:${i + 1}: ${t.slice(0, 110)}`);
      });
  }
  assert.deepEqual(culpados, [], `use AGORA_UTC (lib/sql-tempo.ts) no lugar de now():\n${culpados.join('\n')}`);
});
