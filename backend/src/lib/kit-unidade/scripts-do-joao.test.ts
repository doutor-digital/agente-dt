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
  "exec abc123") echo "aviso do rails: deprecated"; echo "TOKEN:${TOKEN}";;
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
  assert.ok(!/rails runner/.test(a.log()));

  const r1 = a.rodar('criar-platform-app-joao.sh', [], env);
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  assert.equal(readFileSync(arquivo, 'utf8').trim(), TOKEN);
  assert.equal(statSync(arquivo).mode & 0o777, 0o600);
  assert.ok(!(r1.stdout + r1.stderr).includes(TOKEN), 'o token não pode aparecer na saída');
  assert.ok(!a.log().includes(TOKEN), 'nem no que se passou ao docker nem ao curl (o token não fica no ps)');
  assert.ok(/curl .*-H @/.test(a.log()), 'o cabeçalho foi por arquivo (-H @arquivo)');
  assert.ok(!existsSync(arquivo + '.cab'), 'o arquivo do cabeçalho foi apagado');
  assert.match(a.log(), /docker exec abc123 /, 'usou o contêiner MAIS NOVO (abc123), não o velho');
  assert.ok(!/velho99/.test(a.log().replace(/ps --filter.*/g, '')));

  const execucoes = (a.log().match(/docker exec/g) ?? []).length;
  const r2 = a.rodar('criar-platform-app-joao.sh', [], env);
  assert.equal(r2.status, 0);
  assert.match(r2.stdout, /Nada a fazer/);
  assert.equal((a.log().match(/docker exec/g) ?? []).length, execucoes, '2ª rodada não roda o rails de novo');
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
