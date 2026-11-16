/**
 * `do-formulario-joao.sh` (o script da VPS que leva o questionário gerado do contêiner para `unidades/privado/`), rodado contra um `docker` DE MENTIRA que
 * tem um «sistema de arquivos do contêiner» numa pasta. Prova: modo 600/700, o contêiner é limpo no fim (mesmo com erro), o conteúdo nunca é impresso,
 * não troca um arquivo diferente sem --sobrescrever (e guarda o antigo), `--set` validado, importador ausente recusado.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OPS = join(dirname(fileURLToPath(import.meta.url)), '../../../../ops/kit-unidade');
const PII = 'atendente.secreta@clinica-teste.example';

const temporarios: string[] = [];
after(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

function ambiente() {
  const dir = mkdtempSync(join(tmpdir(), 'doform-'));
  temporarios.push(dir);
  const bin = join(dir, 'bin');
  const conteiner = join(dir, 'conteiner');
  const kit = join(dir, 'kit/ops/kit-unidade');
  mkdirSync(bin);
  mkdirSync(conteiner);
  mkdirSync(join(kit, 'unidades'), { recursive: true });
  spawnSync('cp', ['-r', join(OPS, 'do-formulario-joao.sh'), kit]);
  const log = join(dir, 'log');
  writeFileSync(log, '');
  // docker de mentira. O «node» imprime o que a variável FAKE_SAIDA manda e, com --saida, grava o questionário (com dado pessoal) no «contêiner».
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
echo "docker $*" >> "${log}"
case "$1" in
  ps) echo "2026-11-16 10:00:00|abc123"; exit 0;;
  cp) src="\${2#abc123:}"; cp "${conteiner}$src" "$3"; exit $?;;
  exec)
    shift; [ "$1" = "-w" ] && shift 2
    shift   # o contêiner
    case "$1" in
      test) [ -z "\${FAKE_SEM_IMPORTADOR:-}" ]; exit $?;;
      rm) rm -rf "${conteiner}$3"; exit 0;;
      node)
        saida=""; prev=""
        for a in "$@"; do [ "$prev" = "--saida" ] && saida="$a"; prev="$a"; done
        if [ -n "$saida" ]; then mkdir -p "${conteiner}$saida"; printf 'unidade: ${PII}\\nconteudo %s\\n' "\${FAKE_CONTEUDO:-v1}" > "${conteiner}$saida/doutor-hernia-serra.yaml"; fi
        [ -n "\${FAKE_ERRO:-}" ] && { echo "Não achei formulário RECEBIDO"; exit 1; }
        echo "Clínica: Doutor Hérnia Serra (Serra/ES)"
        echo "KIT_RESUMO slug=doutor-hernia-serra subdominio=drherniaserra sufixo=SERRA modo=real valido=nao"
        exit 0;;
    esac;;
esac
echo "docker de mentira: $*" >&2; exit 1
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  const rodar = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('bash', [join(kit, 'do-formulario-joao.sh'), ...args], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ...env }, encoding: 'utf8' });
  const privado = join(kit, 'unidades/privado');
  return { dir, kit, conteiner, privado, rodar, log: () => readFileSync(log, 'utf8') };
}

test('--so-conferir: roda o importador só-leitura e não cria arquivo nenhum', () => {
  const e = ambiente();
  const r = e.rodar(['abc123def', '--so-conferir']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /KIT_RESUMO slug=doutor-hernia-serra/);
  assert.ok(e.log().includes('--so-conferir'));
  assert.ok(!existsSync(e.privado));
});

test('gera: privado/ 700, arquivo 600, conteúdo NUNCA impresso, e o contêiner é limpo', () => {
  const e = ambiente();
  const r = e.rodar(['abc123def', '--set', 'whatsapp.waba_id=2146287749563217']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes(PII), 'o dado pessoal não pode aparecer na saída');
  assert.equal(statSync(e.privado).mode & 0o777, 0o700);
  const f = join(e.privado, 'doutor-hernia-serra.yaml');
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.ok(readFileSync(f, 'utf8').includes(PII));
  assert.match(r.stdout, /PRONTO: .*doutor-hernia-serra\.yaml \(modo 600/);
  assert.ok(e.log().includes('--set whatsapp.waba_id=2146287749563217'), '--set repassado');
  assert.deepEqual(readdirSync(e.conteiner).filter((n) => n.startsWith('run')), ['run'], 'só a pasta pai; a pasta do formulário foi apagada');
  assert.deepEqual(readdirSync(join(e.conteiner, 'run')), []);
  assert.deepEqual(readdirSync(e.privado).filter((n) => n.startsWith('.chegando')), [], 'sem arquivo temporário sobrando');
});

test('rodar de novo com o mesmo conteúdo: «já está igual», nada muda; conteúdo diferente: PARA; --sobrescrever guarda o antigo', () => {
  const e = ambiente();
  assert.equal(e.rodar(['abc123def']).status, 0);
  const igual = e.rodar(['abc123def']);
  assert.equal(igual.status, 0);
  assert.match(igual.stdout, /já está igual ao gerado/);
  const diferente = e.rodar(['abc123def'], { FAKE_CONTEUDO: 'v2' });
  assert.notEqual(diferente.status, 0);
  assert.match(diferente.stdout, /PARO: já existe um questionário DIFERENTE/);
  assert.match(readFileSync(join(e.privado, 'doutor-hernia-serra.yaml'), 'utf8'), /conteudo v1/);
  const troca = e.rodar(['abc123def', '--sobrescrever'], { FAKE_CONTEUDO: 'v2' });
  assert.equal(troca.status, 0, troca.stdout);
  assert.match(readFileSync(join(e.privado, 'doutor-hernia-serra.yaml'), 'utf8'), /conteudo v2/);
  const guardados = readdirSync(e.privado).filter((n) => n.includes('.anterior-'));
  assert.equal(guardados.length, 1, 'nada é apagado: o antigo fica ao lado');
  assert.equal(statSync(join(e.privado, guardados[0]!)).mode & 0o777, 0o600);
  assert.match(readFileSync(join(e.privado, guardados[0]!), 'utf8'), /conteudo v1/);
});

test('erro do importador: devolve o erro, não cria arquivo e ainda limpa o contêiner', () => {
  const e = ambiente();
  const r = e.rodar(['abc123def'], { FAKE_ERRO: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /Não achei formulário RECEBIDO/);
  assert.ok(!existsSync(join(e.privado, 'doutor-hernia-serra.yaml')));
  assert.deepEqual(readdirSync(join(e.conteiner, 'run')), []);
});

test('importador ausente no contêiner, slug também versionado, --set ruim e argumento desconhecido: recusados', () => {
  const e = ambiente();
  assert.match(e.rodar(['abc123def'], { FAKE_SEM_IMPORTADOR: '1' }).stdout, /ainda não tem o importador do formulário/);
  writeFileSync(join(e.kit, 'unidades/doutor-hernia-serra.yaml'), 'x');
  const r = e.rodar(['abc123def']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /também existe em .*unidades\/ \(versionado\)/);
  for (const args of [['abc123def', '--set', 'whatsapp.waba_id=1 2'], ['abc123def', '--set', 'x'], ['abc123def', '--set', 'Whatsapp=1'], ['abc123def', '--x'], ['a b'], []]) {
    assert.notEqual(e.rodar(args).status, 0, args.join(' '));
  }
});
