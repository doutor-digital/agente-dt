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
  // curl de mentira: aceita o token certo (404 = conta 0 não existe, mas autenticou), recusa o resto (401)
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash\nif printf '%s' "$*" | grep -q "api_access_token: ${TOKEN}"; then printf '404'; else printf '401'; fi\n`);
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
  assert.ok(!a.log().includes(TOKEN), 'nem no que se passou ao docker');
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
