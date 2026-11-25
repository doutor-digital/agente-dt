import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SH = resolve(process.cwd(), '..', 'ops/kit-unidade/importar-modelos-kommo-joao.sh');

function rodar(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SH, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } });
  return { codigo: r.status, saida: `${r.stdout}${r.stderr}` };
}

test('.sh --arquivo: recusa arquivo legível por outros (modo 644) ANTES de abrir o ssh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-'));
  try {
    const chave = join(dir, 'chave');
    const arq = join(dir, 'backup.json');
    writeFileSync(chave, 'x');
    writeFileSync(arq, '[]');
    chmodSync(arq, 0o644);
    const r = rodar(['doutor-hernia-timbo', '--arquivo', arq], { CHAVE_SSH: chave });
    assert.equal(r.codigo, 1);
    assert.match(r.saida, /modo 644/);
    assert.match(r.saida, /chmod 600/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('.sh --arquivo: recusa arquivo que não existe, --aplicar com --so-conferir e slug repetido', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-'));
  try {
    const chave = join(dir, 'chave');
    writeFileSync(chave, 'x');
    assert.match(rodar(['timbo', '--arquivo', join(dir, 'nao-existe.json')], { CHAVE_SSH: chave }).saida, /não achei o arquivo/);
    assert.match(rodar(['timbo', '--aplicar', '--so-conferir'], { CHAVE_SSH: chave }).saida, /escolha um/);
    assert.match(rodar(['timbo', 'salto'], { CHAVE_SSH: chave }).saida, /mais de um slug/);
    assert.match(rodar(['timbo', '--arquivo'], { CHAVE_SSH: chave }).saida, /precisa do caminho/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
