/**
 * `cofre-para-servico-joao.sh` e `criar-usuario-dd-joao.sh` rodados contra um `docker` DE MENTIRA (executável no PATH que guarda o estado em
 * arquivos). Prova o que dá para provar sem a VPS: o valor do token/senha nunca aparece na saída nem na LINHA DE COMANDO do docker (o `ps`),
 * idempotência, o PARO com valor diferente / kit rodando, o «AUSENTE» que impede o «PRONTO», e o arquivo da senha que FICA quando o rails
 * falha depois de criar o usuário. O docker/rails de verdade só se prova lá (por isso o `--so-conferir`).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OPS = join(dirname(fileURLToPath(import.meta.url)), '../../../../ops/kit-unidade');
const TOKEN_API = 'tok-api-demo-SECRETO-7c1e';
const TOKEN_BOT = 'tok-bot-demo-SECRETO-2b9d';

const temporarios: string[] = [];
const tmp = (prefixo: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefixo));
  temporarios.push(d);
  return d;
};
after(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

/** docker de mentira para o cofre: o env do serviço mora em `svc_env`; `service update --env-add NOME` lê o valor do AMBIENTE (como o docker real). */
function ambienteCofre(opcoes: { envInicial?: string; kitRodando?: boolean; updatePerde?: boolean; semRobo?: boolean } = {}) {
  const dir = tmp('cofre-sh-');
  const bin = join(dir, 'bin');
  const cofre = join(dir, 'cofre');
  mkdirSync(bin, { recursive: true });
  mkdirSync(cofre, { recursive: true });
  writeFileSync(join(cofre, 'CHATWOOT_API_TOKEN_DEMO'), TOKEN_API);
  if (!opcoes.semRobo) writeFileSync(join(cofre, 'CHATWOOT_SOFIA_BOT_TOKEN_DEMO'), TOKEN_BOT);
  writeFileSync(join(dir, 'agente.env'), opcoes.envInicial ?? 'CHATWOOT_API_TOKEN=global\nOUTRA=1');
  writeFileSync(join(dir, 'svc_env'), 'CHATWOOT_API_TOKEN=global\nOUTRA=1\n');
  writeFileSync(join(dir, 'log'), '');
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "${dir}/log"
case "$1" in
  ps) echo "2026-11-16 12:00:00|novo1"; echo "2026-11-15 10:00:00|velho9";;
  inspect) echo healthy;;
  service)
    case "$2" in
      inspect) case "$*" in *"--format"*) cat "${dir}/svc_env";; *) exit 0;; esac;;
      update)
        ${opcoes.updatePerde ? 'exit 0' : `shift 2
        while [ $# -gt 0 ]; do
          if [ "$1" = "--env-add" ]; then n="$2"; shift 2; printf '%s=%s\\n' "$n" "\${!n}" >> "${dir}/svc_env"; else shift; fi
        done`};;
      logs) exit 0;;
    esac;;
  exec)
    cmd="$*"
    case "$cmd" in
      *kit-segredos*) ${opcoes.kitRodando ? 'echo 1' : 'echo 0'};;
      *"test -n"*) n="$(printf '%s' "$cmd" | sed -E 's/.*\\$\\{([A-Z0-9_]+):-.*/\\1/')"; grep -q "^$n=." "${dir}/svc_env";;
      *) exit 1;;
    esac;;
  *) echo "docker de mentira: $*" >&2; exit 1;;
esac
`,
    { mode: 0o755 },
  );
  const rodar = (...args: string[]) =>
    spawnSync('bash', [join(OPS, 'cofre-para-servico-joao.sh'), ...args], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, KIT_SEGREDOS_DIR: cofre, AGENTE_ENV_ARQUIVO: join(dir, 'agente.env'), AGENTE_SERVICO: 'ddagent_agent' },
    });
  return { dir, rodar, log: () => readFileSync(join(dir, 'log'), 'utf8'), env: () => readFileSync(join(dir, 'agente.env'), 'utf8'), svc: () => readFileSync(join(dir, 'svc_env'), 'utf8') };
}

const semSegredo = (texto: string, onde: string) => {
  assert.ok(!texto.includes(TOKEN_API) && !texto.includes(TOKEN_BOT), `token apareceu em ${onde}`);
};

test('cofre: --so-conferir não muda nada; aplicar grava .env (com cópia) e serviço, sem token na saída nem na linha de comando; 2ª vez = nada a fazer', () => {
  const a = ambienteCofre();
  const conf = a.rodar('DEMO', '--so-conferir');
  assert.equal(conf.status, 0, conf.stderr);
  assert.match(conf.stdout, /SÓ CONFERIR/);
  assert.ok(!a.env().includes('_DEMO='), 'conferir não grava');
  assert.ok(!a.log().includes('service update'), 'conferir não atualiza');

  const r = a.rodar('DEMO');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PRONTO/);
  assert.match(a.env(), new RegExp(`^OUTRA=1\\nCHATWOOT_API_TOKEN_DEMO=${TOKEN_API}\\nCHATWOOT_SOFIA_BOT_TOKEN_DEMO=${TOKEN_BOT}\\n$`, 'm'), 'acrescenta com quebra de linha certa');
  assert.ok(readdirSync(a.dir).some((f) => f.startsWith('agente.env.bak-')), 'cópia do .env');
  assert.match(a.svc(), new RegExp(`CHATWOOT_API_TOKEN_DEMO=${TOKEN_API}`), 'o docker recebeu o valor pelo ambiente');
  semSegredo(r.stdout + r.stderr, 'saída');
  semSegredo(a.log(), 'linha de comando do docker (ps)');
  assert.match(a.log(), /service update --detach=false --quiet --env-add CHATWOOT_API_TOKEN_DEMO --env-add CHATWOOT_SOFIA_BOT_TOKEN_DEMO ddagent_agent/);

  const de_novo = a.rodar('DEMO');
  assert.equal(de_novo.status, 0);
  assert.match(de_novo.stdout, /NADA A FAZER/);
});

test('cofre: clínica SEM assistente (sem robô) → --sem-ia leva só a chave da conta; sem a flag exige o robô (e PARA, sem laço silencioso)', () => {
  const a = ambienteCofre({ semRobo: true });
  const exigindo = a.rodar('DEMO', '--so-conferir');
  assert.equal(exigindo.status, 1);
  assert.match(exigindo.stdout, /FALTA no cofre: .*CHATWOOT_SOFIA_BOT_TOKEN_DEMO/);
  for (const args of [['DEMO', '--sem-ia', '--so-conferir'], ['DEMO', '--so-conferir', '--sem-ia']]) {
    const conf = a.rodar(...args);
    assert.equal(conf.status, 0, conf.stdout + conf.stderr);
    assert.match(conf.stdout, /SÓ CONFERIR/);
  }
  assert.ok(!a.log().includes('service update'));
  const r = a.rodar('DEMO', '--sem-ia');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PRONTO/);
  assert.match(a.env(), new RegExp(`CHATWOOT_API_TOKEN_DEMO=${TOKEN_API}\\n$`), 'só a chave da conta no .env');
  assert.doesNotMatch(a.env(), /SOFIA_BOT/);
  assert.match(a.log(), /service update --detach=false --quiet --env-add CHATWOOT_API_TOKEN_DEMO ddagent_agent/);
  assert.doesNotMatch(a.log(), /SOFIA_BOT/);
  semSegredo(r.stdout + r.stderr + a.log(), 'saída e linha de comando');
  assert.match(a.rodar('DEMO', '--sem-ia').stdout, /NADA A FAZER/);
  const ruim = a.rodar('DEMO', '--tudo');
  assert.equal(ruim.status, 2);
  assert.match(ruim.stdout, /argumento desconhecido: --tudo/);
});

test('cofre: valor DIFERENTE no .env → PARA sem tocar em nada', () => {
  const a = ambienteCofre({ envInicial: 'CHATWOOT_API_TOKEN_DEMO=outro-valor\n' });
  const r = a.rodar('DEMO');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /PARO: CHATWOOT_API_TOKEN_DEMO .* DIFERENTE/);
  assert.ok(!a.log().includes('service update'));
  semSegredo(r.stdout + r.stderr, 'saída');
});

test('cofre: kit rodando (/run/kit-segredos.*) → PARA antes de trocar o contêiner', () => {
  const a = ambienteCofre({ kitRodando: true });
  const r = a.rodar('DEMO');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /o kit está rodando/);
  assert.ok(!a.log().includes('service update'));
});

test('cofre: serviço sobe SEM as chaves → AUSENTE e erro, nunca «PRONTO»', () => {
  const a = ambienteCofre({ updatePerde: true });
  const r = a.rodar('DEMO');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /AUSENTE no contêiner/);
  assert.doesNotMatch(r.stdout, /PRONTO/);
});

/** docker de mentira para o criar-usuario: o rails runner responde conforme `modo` (conferir | cria | falha-depois-de-criar | ja-existe). */
function ambienteUsuario(modo: 'cria' | 'falha-depois-de-criar' | 'ja-existe') {
  const dir = tmp('usuario-sh-');
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, 'log'), '');
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
printf 'docker %s\\n' "\${@:1:3}" >> "${dir}/log"
printf '%s' "\${SENHA_NOVA:-}" > "${dir}/senha_vista"
case "$1" in
  ps) echo "2026-11-16 12:00:00|cw1";;
  exec)
    echo "LINHA: usuário x: $([ "${modo}" = ja-existe ] && echo 'já existe (id 13)' || echo 'não existe')"
    [ "\${SO_CONFERIR:-}" = 1 ] && { echo FIM:conferido; exit 0; }
    case "${modo}" in
      cria) echo "LINHA: CRIADO o usuário 42"; echo "LINHA: conta 1 (A): agora ADMINISTRADOR"; echo FIM:senha-usada;;
      falha-depois-de-criar) echo "LINHA: CRIADO o usuário 42"; echo "ActiveRecord::RecordInvalid" >&2; exit 1;;
      ja-existe) echo "LINHA: conta 1 (A): já era administrador"; echo FIM:senha-nao-usada;;
    esac;;
  *) exit 1;;
esac
`,
    { mode: 0o755 },
  );
  const segredos = join(dir, 'segredos');
  const arquivo = join(segredos, 'crm-joao_exemplo.test.senha');
  const rodar = (...args: string[]) =>
    spawnSync('bash', [join(OPS, 'criar-usuario-dd-joao.sh'), ...args], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, SEGREDOS_DIR: segredos, EMAIL_NOVO: 'Joao@Exemplo.test' },
    });
  return { dir, rodar, arquivo, log: () => readFileSync(join(dir, 'log'), 'utf8'), vista: () => readFileSync(join(dir, 'senha_vista'), 'utf8') };
}

test('criar-usuario: cria com senha em arquivo 600, e-mail em minúsculas, senha fora da saída e da linha de comando', () => {
  const u = ambienteUsuario('cria');
  const r = u.rodar();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(u.arquivo), 'arquivo com o e-mail em minúsculas');
  assert.equal(statSync(u.arquivo).mode & 0o777, 0o600);
  const senha = readFileSync(u.arquivo, 'utf8').trim();
  assert.match(senha, /^Dd9!/);
  assert.equal(u.vista(), senha, 'a senha chega ao docker pelo ambiente');
  assert.ok(!(r.stdout + r.stderr).includes(senha), 'senha na saída');
  assert.ok(!u.log().includes(senha), 'senha na linha de comando');
});

test('criar-usuario: rails falha DEPOIS de criar → o arquivo da senha FICA (é a única cópia) e a saída diz isso', () => {
  const u = ambienteUsuario('falha-depois-de-criar');
  const r = u.rodar();
  assert.equal(r.status, 1);
  assert.ok(existsSync(u.arquivo), 'o arquivo não pode sumir');
  assert.match(r.stdout, /CRIADO o usuário 42/);
  assert.match(r.stdout, /mantido/);
});

test('criar-usuario: usuário que já existe → senha não usada, arquivo novo apagado', () => {
  const u = ambienteUsuario('ja-existe');
  const r = u.rodar();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /NÃO foi mexida/);
  assert.ok(!existsSync(u.arquivo));
});

/** ligar-email: sem terminal não pede senha; o caminho de verdade (Gmail + troca do sidekiq) só se prova na VPS. Aqui: conferir e o PARO. */
function ambienteEmail(envInicial: string) {
  const dir = tmp('email-sh-');
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, 'chatwoot.env'), envInicial);
  writeFileSync(join(dir, 'log'), '');
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "${dir}/log"
case "$1" in
  ps) echo "2026-11-16 12:00:00|cw1";;
  service) case "$2" in inspect) exit 0;; *) exit 1;; esac;;
  *) exit 1;;
esac
`,
    { mode: 0o755 },
  );
  const rodar = (...args: string[]) =>
    spawnSync('bash', [join(OPS, 'ligar-email-crm-joao.sh'), ...args], {
      encoding: 'utf8',
      input: '',
      env: { PATH: `${bin}:/usr/bin:/bin`, CHATWOOT_ENV_ARQUIVO: join(dir, 'chatwoot.env') },
    });
  return { dir, rodar, env: () => readFileSync(join(dir, 'chatwoot.env'), 'utf8'), log: () => readFileSync(join(dir, 'log'), 'utf8') };
}

test('ligar-email: --so-conferir não muda nada; sem terminal recusa pedir senha; e-mail já configurado → PARA', () => {
  const a = ambienteEmail('FRONTEND_URL=https://x.test\n');
  const conf = a.rodar('--so-conferir');
  assert.equal(conf.status, 0, conf.stdout + conf.stderr);
  assert.match(conf.stdout, /SÓ CONFERIR/);
  assert.equal(a.env(), 'FRONTEND_URL=https://x.test\n');
  const semTty = a.rodar();
  assert.equal(semTty.status, 2);
  assert.match(semTty.stdout, /ssh -t/);
  assert.equal(a.env(), 'FRONTEND_URL=https://x.test\n', 'nada gravado sem senha');
  assert.ok(!a.log().includes('service update'));

  const b = ambienteEmail('SMTP_ADDRESS=smtp.x.test\nSMTP_PASSWORD=velha\n');
  const r = b.rodar('--so-conferir');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /PARO: .* JÁ tem e-mail configurado \(SMTP_ADDRESS SMTP_PASSWORD \)/);
  assert.ok(!r.stdout.includes('velha'), 'valor do arquivo nunca aparece');
});
