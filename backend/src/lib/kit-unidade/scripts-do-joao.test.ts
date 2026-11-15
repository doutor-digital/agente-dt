/**
 * Os scripts que o João roda na VPS (Platform App e regra do Traefik), rodados contra `docker` e `curl` DE MENTIRA (um diretório no PATH com dois
 * executáveis que guardam o estado em arquivos). Prova o que dá para provar sem a VPS: idempotência, «só acrescenta» na regra, token que nunca
 * aparece na saída e arquivo em modo 600. O comportamento do docker/rails de verdade só se prova rodando lá (por isso o `--so-conferir`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OPS = join(dirname(fileURLToPath(import.meta.url)), '../../../../ops/kit-unidade');
const TOKEN = 'plat-token-super-secreto-9f3a';

function ambiente(regraInicial = 'Host(`atendimento.exemplo.test`) || Host(`outra.exemplo.test`)') {
  const dir = mkdtempSync(join(tmpdir(), 'kit-sh-'));
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(join(dir, 'regra'), regraInicial);
  writeFileSync(join(dir, 'log'), '');
  // docker de mentira: ps, service inspect/update, exec (rails runner devolve o token)
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
echo "docker $*" >> "${dir}/log"
case "$1 $2" in
  "ps --filter") echo "2026-11-15 10:00:00|abc123"; echo "2026-11-14 10:00:00|velho99";;
  "service inspect")
    case "$*" in
      *"--format"*"range"*) echo "traefik.http.routers.franquias.rule";;
      *"--format"*"index"*) cat "${dir}/regra";;
      *) exit 0;;
    esac;;
  "service update") printf '%s' "\${4#*=}" > "${dir}/regra";;
  "exec abc123") touch "${dir}/app"; echo "aviso do rails: deprecated"; echo "TOKEN:${TOKEN}";;
  *) echo "docker de mentira: $*" >&2; exit 1;;
esac
`,
  );
  // curl de mentira: lê o cabeçalho de `-H @arquivo` (como o curl de verdade); aceita o token certo (404 = conta 0 não existe, mas autenticou), recusa o resto (401)
  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env bash
echo "curl $*" >> "${dir}/log"
cab=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-H" ]; then shift; v="$1"; if [ "\${v:0:1}" = "@" ]; then cab="$(cat "\${v:1}")"; else cab="$v"; fi; fi
  shift
done
if printf '%s' "$cab" | grep -q "api_access_token: ${TOKEN}"; then printf '404'; else printf '401'; fi
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
  const rodar = (script: string, args: string[], extra: Record<string, string> = {}) =>
    spawnSync('bash', [join(OPS, script), ...args], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ...extra }, encoding: 'utf8' });
  return { dir, rodar, log: () => readFileSync(join(dir, 'log'), 'utf8'), regra: () => readFileSync(join(dir, 'regra'), 'utf8') };
}

test('regra do Traefik: só ACRESCENTA o Host; a segunda vez não muda nada; --so-conferir não altera', () => {
  const a = ambiente();
  const seco = a.rodar('regra-traefik-joao.sh', ['demo', '--so-conferir']);
  assert.equal(seco.status, 0, seco.stderr);
  assert.match(seco.stdout, /SÓ CONFERIR: nada foi alterado/);
  assert.equal(a.regra(), 'Host(`atendimento.exemplo.test`) || Host(`outra.exemplo.test`)');
  assert.ok(!/service update/.test(a.log()));

  const r1 = a.rodar('regra-traefik-joao.sh', ['demo']);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(a.regra(), 'Host(`atendimento.exemplo.test`) || Host(`outra.exemplo.test`) || Host(`demo.doutordigitalconsultoria.com`)');

  const antes = a.log();
  const r2 = a.rodar('regra-traefik-joao.sh', ['demo']);
  assert.equal(r2.status, 0);
  assert.match(r2.stdout, /já está na regra/);
  assert.equal(a.log(), antes + 'docker service inspect chatwoot_franquias\ndocker service inspect chatwoot_franquias --format {{range $k, $v := .Spec.Labels}}{{$k}}{{"\\n"}}{{end}}\ndocker service inspect chatwoot_franquias --format {{index .Spec.Labels "traefik.http.routers.franquias.rule"}}\n', 'a 2ª rodada só LÊ (nenhum service update)');
});

test('regra do Traefik: subdomínio inválido é recusado antes de tocar em qualquer coisa', () => {
  const a = ambiente();
  for (const ruim of ['De', 'a b', '../x', 'ab', 'x'.repeat(41), 'com-hifen']) {
    const r = a.rodar('regra-traefik-joao.sh', [ruim]);
    assert.notEqual(r.status, 0, ruim);
  }
  assert.equal(a.log(), '');
});

test('Platform App: cria uma vez, o token vai para o arquivo (modo 600) e NÃO aparece na saída; a 2ª rodada não faz nada; --so-conferir não cria', () => {
  const a = ambiente();
  const arquivo = join(a.dir, 'segredos', 'chatwoot-platform.token');
  const env = { ARQUIVO_DO_TOKEN: arquivo, CHATWOOT_URL: 'https://crm.exemplo.test' };
  const seco = a.rodar('criar-platform-app-joao.sh', ['--so-conferir'], env);
  assert.equal(seco.status, 0, seco.stderr);
  assert.ok(!existsSync(arquivo));
  assert.ok(!/PlatformApp\.find_or_create_by/.test(a.log()), 'o app não foi criado em --so-conferir');

  const r1 = a.rodar('criar-platform-app-joao.sh', [], env);
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  assert.equal(readFileSync(arquivo, 'utf8').trim(), TOKEN);
  assert.equal(statSync(arquivo).mode & 0o777, 0o600);
  assert.ok(!(r1.stdout + r1.stderr).includes(TOKEN), 'o token não pode aparecer na saída');
  assert.ok(!a.log().includes(TOKEN), 'nem no que se passou ao docker nem ao curl (o token não fica no ps)');
  assert.ok(/curl .*-H @/.test(a.log()), 'o cabeçalho foi por arquivo (-H @arquivo)');
  assert.ok(!existsSync(arquivo + '.cab'), 'o arquivo do cabeçalho foi apagado');
  assert.match(a.log(), /docker exec .*abc123 /, 'usou o contêiner MAIS NOVO (abc123), não o velho');
  assert.ok(!/velho99/.test(a.log().replace(/ps --filter.*/g, '')));

  const criacoes = (a.log().match(/PlatformApp\.find_or_create_by/g) ?? []).length;
  assert.equal(criacoes, 1);
  const r2 = a.rodar('criar-platform-app-joao.sh', [], env);
  assert.equal(r2.status, 0, r2.stdout);
  assert.match(r2.stdout, /já existe e o Chatwoot aceita/);
  assert.equal((a.log().match(/PlatformApp\.find_or_create_by/g) ?? []).length, criacoes, '2ª rodada não cria o app de novo');
});

test('Platform App: NUNCA cria permissão sobre usuário existente (PlatformAppPermissible daria ao token do app o poder de entrar como a Suzanne) e não precisa de e-mail nenhum', () => {
  const sh = readFileSync(join(OPS, 'criar-platform-app-joao.sh'), 'utf8');
  assert.doesNotMatch(sh.replace(/^#.*$/gm, ''), /PlatformAppPermissible|--emails|EMAILS_DOS_ADMINISTRADORES/, 'o código do script não toca em permissão de usuário');
  const a = ambiente();
  const env = { ARQUIVO_DO_TOKEN: join(a.dir, 'segredos', 'chatwoot-platform.token'), CHATWOOT_URL: 'https://crm.exemplo.test' };
  assert.equal(a.rodar('criar-platform-app-joao.sh', [], env).status, 0, 'sem lista de e-mails: nada de erro');
  assert.doesNotMatch(a.log(), /Permissible/);
});

test('Platform App: com o token já aceito, a conferência NÃO falha mesmo sem o contêiner chatwoot_rails neste host (nem chama o docker)', () => {
  const a = ambiente();
  const arquivo = join(a.dir, 'segredos', 'chatwoot-platform.token');
  spawnSync('mkdir', ['-p', join(a.dir, 'segredos')]);
  writeFileSync(arquivo, `${TOKEN}\n`, { mode: 0o600 });
  // docker que NÃO acha o contêiner (ps vazio)
  writeFileSync(join(a.dir, 'bin', 'docker'), `#!/usr/bin/env bash\necho "docker $*" >> "${a.dir}/log"\nexit 0\n`);
  for (const args of [[], ['--so-conferir']]) {
    const r = a.rodar('criar-platform-app-joao.sh', args, { ARQUIVO_DO_TOKEN: arquivo, CHATWOOT_URL: 'https://crm.exemplo.test' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /já existe e o Chatwoot aceita/);
    assert.match(r.stdout, /PRÓXIMO: cd \/root\/kit/);
  }
  assert.ok(!/docker/.test(a.log()), 'o docker nem foi chamado');
});

test('Platform App: arquivo com token que o Chatwoot RECUSA → para e não cria outro por cima', () => {
  const a = ambiente();
  const arquivo = join(a.dir, 'chatwoot-platform.token');
  writeFileSync(arquivo, 'token-velho-recusado\n', { mode: 0o600 });
  const r = a.rodar('criar-platform-app-joao.sh', [], { ARQUIVO_DO_TOKEN: arquivo });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /RECUSA/);
  assert.equal(readFileSync(arquivo, 'utf8').trim(), 'token-velho-recusado');
  assert.ok(!/docker exec/.test(a.log()));
});

/** docker de mentira para o nova-unidade-joao: contêiner mais novo, `exec`, `cp` (a volta do cofre cria um arquivo de segredo no destino). */
function ambienteDoKit(opcoes: { semKit?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kit-sh2-'));
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(join(dir, 'log'), '');
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
echo "docker $*" >> "${dir}/log"
case "$1" in
  ps) echo "2026-11-15 10:00:00|novo111aaaabbbb"; echo "2026-11-14 10:00:00|velho222";;
  exec)
    case "$*" in
      *"test -f"*) ${opcoes.semKit ? 'exit 1' : 'exit 0'};;
      *"node dist/scripts/nova-unidade.js"*) echo "PLANO simulado"; exit 0;;
      *) exit 0;;
    esac;;
  cp)
    # volta do cofre: o contêiner "gerou" um segredo
    case "$2" in novo111aaaabbbb:/run/kit-segredos/.) printf 'segredo-gerado' > "$3/CHATWOOT_API_TOKEN_DEMO";; esac;;
  *) exit 0;;
esac
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  const plataforma = join(dir, 'plataforma.token');
  writeFileSync(plataforma, 'TOKEN-DA-PLATAFORMA-9z\n', { mode: 0o600 });
  const cofre = join(dir, 'cofre');
  const rodar = (args: string[]) =>
    spawnSync('bash', [join(OPS, 'nova-unidade-joao.sh'), ...args], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ARQUIVO_PLATAFORMA: plataforma, KIT_SEGREDOS_DIR: cofre }, encoding: 'utf8', input: '' });
  return { dir, cofre, rodar, log: () => readFileSync(join(dir, 'log'), 'utf8') };
}

test('nova-unidade-joao: --so-conferir só confere (nada copiado, nada executado) e usa o contêiner MAIS NOVO', () => {
  const a = ambienteDoKit();
  const r = a.rodar(['clinica-demonstracao', '--so-conferir']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /SÓ CONFERIR/);
  assert.ok(!/docker cp|node dist/.test(a.log()), 'nada copiado nem executado');
  assert.ok(!/velho222/.test(a.log().replace(/docker ps.*\n/, '')));
});

test('nova-unidade-joao: roda o kit DENTRO do contêiner (node dist/scripts/nova-unidade.js), com o token da plataforma SEM valor na linha de comando; o cofre volta ao host (700/600) e é apagado do contêiner', () => {
  const a = ambienteDoKit();
  const r = a.rodar(['clinica-demonstracao']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const log = a.log();
  assert.match(log, /docker exec .*-e CHATWOOT_PLATFORM_TOKEN -e KIT_SEGREDOS_DIR=\/run\/kit-segredos -w \/repo\/backend novo111aaaabbbb node dist\/scripts\/nova-unidade\.js \/repo\/ops\/kit-unidade\/unidades\/clinica-demonstracao\.yaml/);
  assert.ok(!log.includes('TOKEN-DA-PLATAFORMA-9z'), 'o valor do token não aparece na linha de comando');
  assert.ok(!(r.stdout + r.stderr).includes('TOKEN-DA-PLATAFORMA-9z'));
  assert.match(log, /docker cp .*molde-sofia novo111aaaabbbb:\/repo\/ops\/kit-unidade\//);
  assert.match(log, /docker cp .*clinica-demonstracao\.yaml novo111aaaabbbb:\/repo\/ops\/kit-unidade\/unidades\/clinica-demonstracao\.yaml/);
  // o segredo gerado voltou ao host com os modos certos e foi apagado do contêiner
  assert.equal(readFileSync(join(a.cofre, 'CHATWOOT_API_TOKEN_DEMO'), 'utf8'), 'segredo-gerado');
  assert.equal(statSync(a.cofre).mode & 0o777, 0o700);
  assert.equal(statSync(join(a.cofre, 'CHATWOOT_API_TOKEN_DEMO')).mode & 0o777, 0o600);
  assert.match(log, /docker exec novo111aaaabbbb rm -rf \/run\/kit-segredos/);
  assert.ok(!(r.stdout + r.stderr).includes('segredo-gerado'));
});

test('nova-unidade-joao: sem terminal, --aplicar exige --sim; e contêiner sem o kit publicado é recusado com a razão', () => {
  const a = ambienteDoKit();
  const sem = a.rodar(['clinica-demonstracao', '--aplicar']);
  assert.equal(sem.status, 2);
  assert.match(sem.stdout, /sem terminal só dá para aplicar com --sim/);
  assert.ok(!/node dist/.test(a.log()));
  const b = ambienteDoKit({ semKit: true });
  const r = b.rodar(['clinica-demonstracao']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /ainda não tem o kit/);
  assert.ok(!/docker cp/.test(b.log()));
});

test('nova-unidade-joao e README avisam: não publique deploy enquanto o kit roda (/run/kit-segredos, token entregue uma vez)', () => {
  const sh = readFileSync(join(OPS, 'nova-unidade-joao.sh'), 'utf8');
  const readme = readFileSync(join(OPS, 'README.md'), 'utf8');
  for (const t of [sh, readme]) {
    assert.match(t, /NÃO PUBLIQUE DEPLOY ENQUANTO O KIT RODA/);
    assert.match(t, /\/run\/kit-segredos/);
    assert.match(t, /UMA vez/);
  }
});

// ── a VPS não tem cópia do repositório: o kit chega por tar sobre ssh e roda de /root/kit ─────────────────────────────

/** Um repositório de mentira (origin + clone) com a pasta ops/kit-unidade REAL commitada em origin/main, e um `ssh` de mentira que executa o comando remoto aqui. */
function repositorioDeMentira() {
  const dir = mkdtempSync(join(tmpdir(), 'kit-levar-'));
  const sh = (cwd: string, ...args: string[]) => spawnSync(args[0]!, args.slice(1), { cwd, encoding: 'utf8' });
  const origin = join(dir, 'origin.git');
  const clone = join(dir, 'clone');
  sh(dir, 'git', 'init', '-q', '--bare', '-b', 'main', origin);
  sh(dir, 'git', 'clone', '-q', origin, clone);
  spawnSync('mkdir', ['-p', join(clone, 'ops')]);
  spawnSync('cp', ['-r', OPS, join(clone, 'ops', 'kit-unidade')]);
  for (const c of [['config', 'user.email', 't@t'], ['config', 'user.name', 't'], ['add', '-A'], ['commit', '-q', '-m', 'kit'], ['push', '-q', 'origin', 'HEAD:main']]) sh(clone, 'git', ...c);
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(join(dir, 'ssh.log'), '');
  // ssh de mentira: ignora -i <chave> e o host; executa o comando remoto aqui, com o stdin repassado (como o ssh de verdade)
  writeFileSync(join(bin, 'ssh'), `#!/usr/bin/env bash\necho "ssh $*" >> "${dir}/ssh.log"\nargs=("$@"); cmd="\${args[\${#args[@]}-1]}"\nbash -c "$cmd"\n`);
  chmodSync(join(bin, 'ssh'), 0o755);
  writeFileSync(join(dir, 'chave'), 'chave-de-mentira\n', { mode: 0o600 });
  const destino = join(dir, 'vps-kit');
  const rodar = (args: string[] = [], extra: Record<string, string> = {}) =>
    spawnSync('bash', [join(clone, 'ops/kit-unidade/levar-kit-para-vps.sh'), ...args], { cwd: clone, env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, CHAVE_SSH: join(dir, 'chave'), DESTINO: destino, ...extra }, encoding: 'utf8' });
  return { dir, clone, destino, rodar, sshLog: () => readFileSync(join(dir, 'ssh.log'), 'utf8') };
}

test('levar-kit-para-vps: --so-conferir lista os arquivos de origin/main e NÃO abre o ssh', () => {
  const r = repositorioDeMentira();
  const seco = r.rodar(['--so-conferir']);
  assert.equal(seco.status, 0, seco.stdout + seco.stderr);
  assert.match(seco.stdout, /ops\/kit-unidade\/nova-unidade-joao\.sh/);
  assert.match(seco.stdout, /ops\/kit-unidade\/unidades\/clinica-demonstracao\.yaml/);
  assert.match(seco.stdout, /SÓ CONFERIR: nada foi enviado/);
  assert.equal(r.sshLog(), '');
  assert.ok(!existsSync(r.destino));
});

test('levar-kit-para-vps: envia por tar sobre ssh o que está em origin/main (não o que está só na sua pasta); repetir sobrescreve; destino/ref inválidos são recusados', () => {
  const r = repositorioDeMentira();
  // um arquivo só local (não commitado) NÃO vai
  writeFileSync(join(r.clone, 'ops/kit-unidade/so-local.txt'), 'não commitado');
  const env1 = r.rodar();
  assert.equal(env1.status, 0, env1.stdout + env1.stderr);
  assert.ok(existsSync(join(r.destino, 'ops/kit-unidade/nova-unidade-joao.sh')));
  assert.ok(existsSync(join(r.destino, 'ops/kit-unidade/molde-sofia/bloco-conversa.md')));
  assert.ok(!existsSync(join(r.destino, 'ops/kit-unidade/so-local.txt')), 'só o que está em origin/main');
  assert.match(env1.stdout, /PRONTO: o kit está em/);
  assert.match(r.sshLog(), /-i .*chave/);
  assert.equal(r.rodar().status, 0, 'repetir funciona');
  assert.notEqual(r.rodar([], { DESTINO: '/tmp/x; rm -rf /' }).status, 0);
  assert.notEqual(r.rodar([], { REF: 'origin/nao-existe' }).status, 0);
  assert.notEqual(r.rodar([], { CHAVE_SSH: join(r.dir, 'nao-existe') }).status, 0);
});

test('levar-kit-para-vps: a pasta da VPS é SUBSTITUÍDA (script apagado/renomeado no repositório não sobra lá) e funciona rodando de uma subpasta do repositório', () => {
  const r = repositorioDeMentira();
  assert.equal(r.rodar().status, 0);
  // sobras da VPS: um script que já não existe no repositório, e um arquivo de fora do kit que NÃO pode ser tocado
  writeFileSync(join(r.destino, 'ops/kit-unidade/script-apagado-no-repo.sh'), '#!/bin/bash\n');
  writeFileSync(join(r.destino, 'outra-coisa.txt'), 'não é do kit');
  // rodando de DENTRO de ops/kit-unidade (git archive relativo precisaria da raiz)
  const sub = spawnSync('bash', [join(r.clone, 'ops/kit-unidade/levar-kit-para-vps.sh')], { cwd: join(r.clone, 'ops/kit-unidade'), env: { PATH: `${join(r.dir, 'bin')}:${process.env.PATH}`, HOME: r.dir, CHAVE_SSH: join(r.dir, 'chave'), DESTINO: r.destino }, encoding: 'utf8' });
  assert.equal(sub.status, 0, sub.stdout + sub.stderr);
  assert.ok(!existsSync(join(r.destino, 'ops/kit-unidade/script-apagado-no-repo.sh')), 'o script que não existe mais no repositório sumiu da VPS');
  assert.ok(existsSync(join(r.destino, 'ops/kit-unidade/levar-kit-para-vps.sh')));
  assert.ok(existsSync(join(r.destino, 'outra-coisa.txt')), 'o que não é do kit não é tocado');
  assert.deepEqual(spawnSync('ls', ['-A', r.destino], { encoding: 'utf8' }).stdout.split('\n').filter((x) => x.startsWith('.chegando')), [], 'a pasta temporária foi embora');
});

test('os .sh funcionam a partir da cópia em /root/kit/ops/kit-unidade (AQUI = dirname): nova-unidade-joao --so-conferir acha o questionário e o molde pela cópia', () => {
  const r = repositorioDeMentira();
  assert.equal(r.rodar().status, 0);
  const a = ambienteDoKit();
  const sh = spawnSync('bash', [join(r.destino, 'ops/kit-unidade/nova-unidade-joao.sh'), 'clinica-demonstracao', '--so-conferir'], { cwd: r.destino, env: { PATH: `${join(a.dir, 'bin')}:${process.env.PATH}`, HOME: a.dir, ARQUIVO_PLATAFORMA: join(a.dir, 'plataforma.token'), KIT_SEGREDOS_DIR: join(a.dir, 'cofre') }, encoding: 'utf8' });
  assert.equal(sh.status, 0, sh.stdout + sh.stderr);
  assert.match(sh.stdout, /SÓ CONFERIR/);
  // o questionário que ele procurou é o da CÓPIA (e a ausência dele é reportada com o caminho da cópia)
  const sem = spawnSync('bash', [join(r.destino, 'ops/kit-unidade/nova-unidade-joao.sh'), 'clinica-que-nao-existe', '--so-conferir'], { cwd: r.destino, env: { PATH: `${join(a.dir, 'bin')}:${process.env.PATH}`, HOME: a.dir }, encoding: 'utf8' });
  assert.notEqual(sem.status, 0);
  assert.match(sem.stdout, new RegExp(`${r.destino.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/ops/kit-unidade/unidades/clinica-que-nao-existe\\.yaml`));
  // e os outros dois scripts também rodam da cópia
  assert.equal(spawnSync('bash', ['-n', join(r.destino, 'ops/kit-unidade/criar-platform-app-joao.sh')]).status, 0);
  assert.equal(spawnSync('bash', ['-n', join(r.destino, 'ops/kit-unidade/regra-traefik-joao.sh')]).status, 0);
});

test('README: documenta como levar o kit (a VPS não tem cópia do repositório) e roda de /root/kit', () => {
  const readme = readFileSync(join(OPS, 'README.md'), 'utf8');
  assert.match(readme, /a VPS NÃO tem cópia do repositório/);
  assert.match(readme, /levar-kit-para-vps\.sh/);
  assert.match(readme, /git archive origin\/main ops\/kit-unidade \| ssh -i ~\/\.ssh\/doutordigital_vps root@89\.116\.214\.130/);
  assert.match(readme, /cd \/root\/kit/);
  assert.match(readme, /KIT_ADMINS_DD/);
  assert.match(readme, /\/home\/joaoof\/agente-dt/);
  assert.match(readme, /\/opt\/doutordigital\/agente-dt/);
});
