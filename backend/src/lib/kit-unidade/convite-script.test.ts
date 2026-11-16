import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bancoConvitesFalso } from './convites-falso.js';
import { conviteAberto, FORMATO_DO_CODIGO } from './convites.js';
import { executar, origemPublica } from '../../scripts/convite-nova-clinica.js';

const ENV = {} as NodeJS.ProcessEnv;

test('cria o convite, imprime o link UMA vez com o código que abre o formulário, e só o hash fica no banco', async () => {
  const banco = bancoConvitesFalso();
  const r = await executar(['--rotulo', 'Dra. Fulana (Serra)'], banco, ENV, new Date('2026-11-16T12:00:00Z'));
  assert.equal(r.codigo, 0);
  const saida = r.saida.join('\n');
  const m = /https:\/\/cadastro\.doutordigitalconsultoria\.com\/nova-clinica\/([A-Za-z0-9_-]{24})/.exec(saida);
  assert.ok(m, saida);
  assert.match(m![1]!, FORMATO_DO_CODIGO);
  assert.ok(await conviteAberto(banco, m![1], new Date('2026-11-17T00:00:00Z')));
  assert.ok(!JSON.stringify(banco.linhas).includes(m![1]!), 'o código não é guardado');
  assert.match(saida, /até 30\/11\/2026/);
  assert.match(saida, /Não cole em grupo nem no chat do Claude/);
  assert.equal(banco.linhas[0]!.criadoPor, 'script da VPS (root)');
});

test('o link sai no endereço bonito (cadastro.doutordigitalconsultoria.com), não no do agente/MCP; NOVA_CLINICA_URL_BASE só troca a origem', () => {
  assert.equal(origemPublica({} as NodeJS.ProcessEnv), 'https://cadastro.doutordigitalconsultoria.com');
  assert.equal(origemPublica({ MCP_URL_PUBLICA: 'https://agente-vps.exemplo.test/mcp' } as NodeJS.ProcessEnv), 'https://cadastro.doutordigitalconsultoria.com', 'o MCP não manda mais no endereço');
  assert.equal(origemPublica({ NOVA_CLINICA_URL_BASE: 'https://outro.exemplo.test/qualquer' } as NodeJS.ProcessEnv), 'https://outro.exemplo.test');
  assert.equal(origemPublica({ NOVA_CLINICA_URL_BASE: 'lixo' } as NodeJS.ProcessEnv), 'https://cadastro.doutordigitalconsultoria.com');
});

test('--por precisa ser administrador da Doutor Digital; --dias de 1 a 60; sem --rotulo não cria; argumento desconhecido recusado', async () => {
  const banco = bancoConvitesFalso();
  assert.equal((await executar(['--rotulo', 'x', '--por', 'qualquer@gmail.com'], banco, ENV)).codigo, 2);
  assert.equal((await executar(['--rotulo', 'x', '--por', 'Suzanne.Mychelly1@gmail.com'], banco, ENV)).codigo, 0);
  assert.equal(banco.linhas[0]!.criadoPor, 'Suzanne.Mychelly1@gmail.com');
  for (const dias of ['0', '61', 'abc', '1.5']) assert.equal((await executar(['--rotulo', 'x', '--dias', dias], banco, ENV)).codigo, 2, dias);
  assert.equal((await executar([], banco, ENV)).codigo, 2);
  assert.equal((await executar(['--rotulo', '  '], banco, ENV)).codigo, 2);
  assert.equal((await executar(['--rotulo', 'x', '--tudo'], banco, ENV)).codigo, 2);
  assert.equal((await executar(['--rotulo', '--dias', '7'], banco, ENV)).codigo, 2, '«--rotulo --dias» não vira rótulo');
  assert.equal((await executar(['--rotulo', 'x', '--dias'], banco, ENV)).codigo, 2);
  assert.equal((await executar(['--rotulo', 'x', '--por'], banco, ENV)).codigo, 2);
  assert.equal(banco.linhas.length, 1);
});

test('--listar não mostra códigos; --revogar encerra sem apagar e não mexe no que já foi usado', async () => {
  const banco = bancoConvitesFalso();
  await executar(['--rotulo', 'um'], banco, ENV);
  const criado = banco.linhas[0]!;
  const lista = await executar(['--listar'], banco, ENV);
  assert.match(lista.saida.join('\n'), new RegExp(`${criado.id}  aberto até`));
  assert.ok(!lista.saida.join('\n').includes(criado.codigoHash));
  const rev = await executar(['--revogar', criado.id], banco, ENV);
  assert.equal(rev.codigo, 0);
  assert.equal(banco.linhas.length, 1, 'nada apagado');
  assert.match((await executar(['--listar'], banco, ENV)).saida.join('\n'), /vencido\/revogado/);
  assert.equal((await executar(['--revogar', criado.id], banco, ENV)).codigo, 1, 'já encerrado');
  assert.equal((await executar(['--revogar'], banco, ENV)).codigo, 2);
});

// ── o script do computador do João (convite-clinica-joao.sh), com ssh de mentira ──
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../../../../ops/kit-unidade/convite-clinica-joao.sh');
const tmps: string[] = [];
after(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

function ambienteSsh(comChave = true) {
  const dir = mkdtempSync(join(tmpdir(), 'convite-'));
  tmps.push(dir);
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, '.ssh'));
  if (comChave) writeFileSync(join(dir, '.ssh/doutordigital_vps'), 'k');
  writeFileSync(join(dir, 'bin/ssh'), `#!/usr/bin/env bash\necho "SSH $*" >> "${dir}/log"\n`);
  chmodSync(join(dir, 'bin/ssh'), 0o755);
  writeFileSync(join(dir, 'log'), '');
  const rodar = (args: string[], pty = true) => {
    const env = { PATH: `${dir}/bin:${process.env.PATH}`, HOME: dir };
    return pty
      ? spawnSync('script', ['-qefc', ['bash', SCRIPT, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' '), '/dev/null'], { env, encoding: 'utf8' })
      : spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8' });
  };
  return { rodar, log: () => readFileSync(join(dir, 'log'), 'utf8') };
}

test('convite-clinica-joao.sh: manda COMO COMANDO do ssh -t (nunca stdin), com cada argumento entre aspas', () => {
  const e = ambienteSsh();
  const r = e.rodar(['--rotulo', "Dra. D'Ávila (Serra)"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const l = e.log();
  assert.match(l, /SSH -t -i \S+doutordigital_vps -o ConnectTimeout=15 root@89\.116\.214\.130 /);
  assert.match(l, /node dist\/scripts\/convite-nova-clinica\.js --rotulo /);
  assert.ok(l.includes("D\\'Ávila") || l.includes("$'"), 'o apóstrofo não quebra o comando: ' + l);
  assert.ok(!/bash -s/.test(l));
});

test('convite-clinica-joao.sh: sem a chave, sem argumento ou sem terminal, recusa antes de abrir o ssh', () => {
  assert.notEqual(ambienteSsh(false).rodar(['--listar']).status, 0);
  const e = ambienteSsh();
  assert.notEqual(e.rodar([]).status, 0);
  assert.notEqual(e.rodar(['--listar'], false).status, 0);
  assert.equal(e.log(), '');
});
