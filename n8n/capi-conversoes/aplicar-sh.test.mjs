// Roda o aplicar-v3.sh INTEIRO (flags, backup, montagem, PUT, desfazer) com `docker` e `curl` de mentira: nada fala com o
// n8n de verdade. O que se prova: o corpo do PUT, o backup, o --seco que não grava, o --desfazer, e que um HTTP != 200
// derruba o script (não pode dizer "aplicado" quando o n8n recusou).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workflow } from './fixture-workflow.mjs';

const aqui = path.dirname(fileURLToPath(import.meta.url));

function sandbox({ httpPut = '200' } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'capi-sh-'));
  const ctr = path.join(d, 'ctr'); fs.mkdirSync(path.join(ctr, 'tmp/capi-v3'), { recursive: true });
  const wf = { id: 'WID1', ...workflow(), settings: { executionOrder: 'v1', availableInMCP: false }, active: true };
  fs.writeFileSync(path.join(d, 'wf-prod.json'), JSON.stringify(wf));
  fs.writeFileSync(path.join(d, 'api.env'), 'N8N_API_URL=http://n8n.invalid/api/v1\nN8N_API_KEY=segredo-de-teste\n');
  return { d, ctr, httpPut };
}

function rodar(sb, args) {
  return spawnSync('bash', [path.join(aqui, 'aplicar-v3.sh'), ...args], {
    env: {
      PATH: `${path.join(aqui, 'falsos')}:${process.env.PATH}`, HOME: sb.d,
      N8N_API_ENV: path.join(sb.d, 'api.env'), HOMOLOG: path.join(sb.d, 'homolog'),
      CTR: sb.ctr, D: sb.d, HTTP_PUT: sb.httpPut, UNIDADE_OK: 'Balsas', DIR: aqui,
    },
    encoding: 'utf8',
  });
}

test('sh: --seco guarda o backup, mostra o que muda e NÃO faz PUT', () => {
  const sb = sandbox();
  const r = rodar(sb, ['--unidade', 'Balsas', '--seco', '--pediu', 'seco']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /muda: Classificar etapa/);
  assert.match(r.stdout, /--seco: nada foi gravado/);
  assert.equal(fs.existsSync(path.join(sb.d, 'put-recebido.json')), false);
  assert.doesNotMatch(r.stdout + r.stderr, /segredo-de-teste/, 'a chave do n8n nunca é impressa');
  const back = fs.readdirSync(path.join(sb.d, 'homolog')).find((x) => x.startsWith('backup-capi-v3-'));
  assert.ok(back && fs.existsSync(path.join(sb.d, 'homolog', back, 'WID1.json')));
});

test('sh: aplicar faz o PUT com nodes v3, connections e settings filtrados (sem availableInMCP)', () => {
  const sb = sandbox();
  const r = rodar(sb, ['--unidade', 'Balsas', '--pediu', 'seco']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PUT -> HTTP 200 · v3 gravado/);
  const body = JSON.parse(fs.readFileSync(path.join(sb.d, 'put-recebido.json'), 'utf8'));
  assert.deepEqual(Object.keys(body).sort(), ['connections', 'name', 'nodes', 'settings']);
  assert.deepEqual(body.settings, { executionOrder: 'v1' });
  const cfg = body.nodes.find((n) => n.name === 'Config').parameters.jsCode;
  assert.match(cfg, /pediuHorario: \{"modo":"seco"/);
  assert.match(r.stdout, /desfazer: /);
});

test('sh: HTTP diferente de 200 no PUT derruba o script (não pode dizer "aplicado")', () => {
  const sb = sandbox({ httpPut: '400' });
  const r = rodar(sb, ['--unidade', 'Balsas', '--pediu', 'seco']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /a v3 NÃO foi aplicada/);
});

test('sh: --desfazer devolve o export guardado; HTTP != 200 também falha', () => {
  const sb = sandbox();
  const bak = path.join(sb.d, 'wf-prod.json');
  const ok = rodar(sb, ['--unidade', 'Balsas', '--desfazer', bak]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /desfeito com .* -> HTTP 200/);
  const body = JSON.parse(fs.readFileSync(path.join(sb.d, 'put-recebido.json'), 'utf8'));
  assert.equal(body.nodes.find((n) => n.name === 'Classificar etapa').parameters.jsCode, '// v2');
  const sb2 = sandbox({ httpPut: '500' });
  const ruim = rodar(sb2, ['--unidade', 'Balsas', '--desfazer', path.join(sb2.d, 'wf-prod.json')]);
  assert.notEqual(ruim.status, 0);
  assert.match(ruim.stdout, /NÃO voltou/);
});

test('sh: sem --unidade, ou com nome estranho, recusa antes de tocar em qualquer coisa', () => {
  const sb = sandbox();
  assert.notEqual(rodar(sb, ['--seco']).status, 0);
  assert.notEqual(rodar(sb, ['--unidade', 'Balsas%\'; DROP TABLE x;--']).status, 0);
  assert.equal(fs.existsSync(path.join(sb.d, 'put-recebido.json')), false);
});

test('sh: unidade sem workflow ativo para no começo', () => {
  const sb = sandbox();
  const r = rodar(sb, ['--unidade', 'Narnia']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /nenhum workflow ativo/);
});

test('sh: --desfazer com o export de OUTRA unidade é recusado (não joga o dataset de uma na outra)', () => {
  const sb = sandbox();
  const outro = JSON.parse(fs.readFileSync(path.join(sb.d, 'wf-prod.json'), 'utf8'));
  outro.id = 'WID-OUTRA'; outro.name = 'DD · CTWA → Meta CAPI · Conversões (Marabá)';
  const arq = path.join(sb.d, 'outra.json');
  fs.writeFileSync(arq, JSON.stringify(outro));
  const r = rodar(sb, ['--unidade', 'Balsas', '--desfazer', arq]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /não é o export deste workflow/);
  assert.equal(fs.existsSync(path.join(sb.d, 'put-recebido.json')), false);
});

test('sh: --desfazer --seco não grava', () => {
  const sb = sandbox();
  const r = rodar(sb, ['--unidade', 'Balsas', '--desfazer', path.join(sb.d, 'wf-prod.json'), '--seco']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(path.join(sb.d, 'put-recebido.json')), false);
});
