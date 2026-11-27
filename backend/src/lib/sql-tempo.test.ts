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
 *  - estrutura-campos.ts: gera DDL de tabelas novas do usuário, com `timestamptz` (aí `now()` puro está certo).
 */
const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const EXCECOES = new Set(['lib/worker-lease.ts', 'mcp-remoto/meta-eventos.ts', 'mcp-remoto/estrutura-campos.ts', 'mcp-remoto/sistemas-estrutura.ts']);
// now() que NÃO é Date.now()/performance.now(), seguido de +/- (aritmética de janela) ou numa comparação
const PADRAO = /(?<![.\w])now\(\)\s*[-+]|[<>]=?\s*now\(\)|\$\d+::timestamptz\s*[-+]/i;

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : arquivos(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

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
