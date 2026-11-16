/**
 * `abrir-clinica-joao.sh` (o comando único do computador do João), rodado contra um `ssh` DE MENTIRA (um executável no PATH que guarda cada chamada num arquivo)
 * e contra um repositório git temporário com `origin`. Prova o que dá para provar sem a VPS: a ORDEM dos passos, que tudo vai por `ssh -t … "comando"` (nunca
 * script no stdin), a pergunta única, parar no primeiro erro dizendo o que fazer, recusar sem chave, idempotência e que dado pessoal do questionário nunca é impresso.
 * O comportamento dos scripts da VPS de verdade só se prova lá (`--so-conferir` primeiro).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OPS = join(dirname(fileURLToPath(import.meta.url)), '../../../../ops/kit-unidade');

const temporarios: string[] = [];
const tmp = (prefixo: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefixo));
  temporarios.push(d);
  return d;
};
after(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

/** Questionário de clínica REAL, todo fictício, com dado pessoal que nunca pode aparecer na saída. */
const DADOS_PESSOAIS = ['atendente.secreta@clinica-teste.example', 'pix-secreto@clinica-teste.example', '(11) 91234-5678', '+5511912345678'];
const QUESTIONARIO_REAL = `versao: 1
unidade:
  nome: Clínica Teste
  slug: doutor-hernia-teste
  telefone: "(11) 91234-5678"   # [SENSÍVEL]
whatsapp:
  numero_oficial: "+5511912345678"
  modo: real
chatwoot:
  caixa_nome: Teste · WhatsApp
  subdominio: drherniateste     # drherniateste.doutordigitalconsultoria.com
  atendentes:
    - nome: Ana
      email: atendente.secreta@clinica-teste.example
      funcao: gerente
valores:
  chave_pix: pix-secreto@clinica-teste.example
franquia:
  token_env: FRANQUIA_TOKEN_TESTE
meta:
  token_env: META_ADS_TOKEN_TESTE   # comentário
  conta_env: META_ADS_CONTA_TESTE
`;

function ambiente(opcoes: { chave?: boolean } = {}) {
  const dir = tmp('abrir-');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'log');
  writeFileSync(log, '');
  // ssh de mentira: guarda os argumentos (um por linha entre marcas), descarta o stdin (só sem -t) e falha se FALHAR_EM aparecer na linha
  writeFileSync(
    join(bin, 'ssh'),
    `#!/usr/bin/env bash
echo "SSH $*" >> "${log}"
# com -t (terminal) o ssh de verdade não lê o stdin do script; sem -t (tar / questionário) ele recebe o conteúdo
case " $* " in *" -t "*) ;; *) cat > /dev/null;; esac
case "$*" in *'echo "conectou'*) echo "conectou em vps-de-mentira";; esac
if [ -n "\${FALHAR_EM:-}" ] && [[ "$*" == *"$FALHAR_EM"* ]]; then echo "erro de mentira" >&2; exit "\${FALHAR_CODIGO:-3}"; fi
exit 0
`,
  );
  chmodSync(join(bin, 'ssh'), 0o755);
  // a «máquina do João»: HOME com a chave (ou sem), um origin bare e um clone com o kit
  const home = join(dir, 'home');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  if (opcoes.chave !== false) writeFileSync(join(home, '.ssh/doutordigital_vps'), 'chave-de-mentira');
  const origem = join(dir, 'origin.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origem]);
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'ops'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  const empacota = spawnSync('tar', ['-C', join(OPS, '..'), '-c', '--exclude=kit-unidade/unidades/privado', 'kit-unidade']);
  assert.equal(spawnSync('tar', ['-C', join(repo, 'ops'), '-x'], { input: empacota.stdout }).status, 0);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'kit');
  git(repo, 'remote', 'add', 'origin', origem);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  const privado = join(home, 'privado');
  mkdirSync(privado, { mode: 0o700 });
  chmodSync(privado, 0o700);

  /** Com um terminal de verdade (`script` cria um pty): o comando recusa rodar sem terminal, então o teste não pode usar pipe. `semPty` roda sem terminal (para provar a recusa). */
  const rodar = (args: string[], opts: { entrada?: string; env?: Record<string, string>; semPty?: boolean } = {}) => {
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, KIT_PRIVADO_DIR: privado, ...GIT_ENV, ...(opts.env ?? {}) };
    const alvo = join(repo, 'ops/kit-unidade/abrir-clinica-joao.sh');
    const comPty = !opts.semPty && !args.includes('--so-conferir');
    const r = comPty
      ? spawnSync('script', ['-qefc', ['bash', alvo, ...args].map((x) => `'${x}'`).join(' '), '/dev/null'], { cwd: repo, input: opts.entrada ?? '', encoding: 'utf8', env })
      : spawnSync('bash', [alvo, ...args], { cwd: repo, input: opts.entrada ?? '', encoding: 'utf8', env });
    return { ...r, stdout: r.stdout.replace(/\r/g, ''), stderr: r.stderr.replace(/\r/g, '') };
  };
  const chamadas = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const limparLog = () => writeFileSync(log, '');
  const gravarPrivado = (slug: string, conteudo: string) => {
    writeFileSync(join(privado, `${slug}.yaml`), conteudo, { mode: 0o600 });
    chmodSync(join(privado, `${slug}.yaml`), 0o600);
  };
  return { dir, repo, privado, rodar, chamadas, limparLog, gravarPrivado };
}

/** Só as chamadas ao ssh que rodam um script do kit na VPS, na forma curta que a ordem precisa. */
const scriptsDoKit = (linhas: string[]) =>
  linhas
    .map((l) => /cd '[^']+' && bash ops\/kit-unidade\/([a-z-]+)-joao\.sh(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => `${m[1]}${m[2]}`.trim());

const CAMINHO_DEMO = [
  "criar-platform-app --so-conferir",
  "nova-unidade 'clinica-demonstracao' --so-conferir",
  "regra-traefik 'demo' --so-conferir",
  "nova-unidade 'clinica-demonstracao'",
  'criar-platform-app',
  "nova-unidade 'clinica-demonstracao' --aplicar",
  "cofre-para-servico 'DEMO' --so-conferir",
  "regra-traefik 'demo'",
  "cofre-para-servico 'DEMO'",
];

test('caminho todo da demonstração: ordem certa, tudo por «ssh -t … comando», a pergunta única, resumo do que falta', () => {
  const e = ambiente();
  const r = e.rodar(['clinica-demonstracao'], { entrada: 'aplicar\n' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const c = e.chamadas();
  assert.deepEqual(scriptsDoKit(c), CAMINHO_DEMO);
  // o kit foi levado (tar sobre ssh) ANTES de qualquer script da VPS
  const iTar = c.findIndex((l) => l.includes('tar -x'));
  const iPrimeiro = c.findIndex((l) => l.includes('criar-platform-app-joao.sh'));
  assert.ok(iTar >= 0 && iTar < iPrimeiro, 'levar o kit vem primeiro');
  // cada script roda com terminal (-t) e como comando — nunca script no stdin
  for (const l of c.filter((x) => x.includes('-joao.sh'))) assert.match(l, /SSH .* -t root@89\.116\.214\.130 cd '\/root\/kit' && bash ops\//, l);
  assert.ok(!c.some((l) => /bash -s/.test(l)), 'nunca bash -s');
  // chave e destino certos
  assert.ok(c.filter((l) => l.startsWith('SSH ')).every((l) => l.includes('-i ' + join(e.dir, 'home/.ssh/doutordigital_vps'))), c.join('\n'));
  // resumo
  assert.match(r.stdout, /PRONTO: «clinica-demonstracao» está criada/);
  assert.match(r.stdout, /TESTE DA SOFIA/);
  assert.match(r.stdout, /FRANQUIA/);
  assert.match(r.stdout, /--ligar-robo/);
  assert.match(r.stdout, /demo\.doutordigitalconsultoria\.com/);
  assert.equal((r.stdout.match(/Digite {2}aplicar/g) ?? []).length, 1, 'uma única pergunta');
});

test('responder qualquer outra coisa cancela: nada de --aplicar, regra do proxy ou cofre', () => {
  const e = ambiente();
  const r = e.rodar(['clinica-demonstracao'], { entrada: 'sim\n' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Cancelado\. Nada foi aplicado/);
  const passos = scriptsDoKit(e.chamadas());
  assert.deepEqual(passos, CAMINHO_DEMO.slice(0, 4));
  assert.ok(!e.chamadas().some((l) => l.includes('--aplicar') || l.includes('cofre-para-servico')));
});

test('para no primeiro erro, diz o passo e o que fazer, e não segue', () => {
  const e = ambiente();
  const r = e.rodar(['clinica-demonstracao'], { entrada: 'aplicar\n', env: { FALHAR_EM: "'clinica-demonstracao' --aplicar" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /PAREI no passo «6b\. criar a clínica no CRM/);
  assert.match(r.stdout, /O que fazer:/);
  assert.match(r.stdout, /rodar o MESMO comando de novo/);
  const passos = scriptsDoKit(e.chamadas());
  assert.equal(passos[passos.length - 1], "nova-unidade 'clinica-demonstracao' --aplicar");
  assert.ok(!passos.some((p) => p.startsWith('cofre-para-servico') || p === "regra-traefik 'demo'"));
});

test('falha ao levar o kit: para ali, antes de qualquer conferência', () => {
  const e = ambiente();
  const r = e.rodar(['clinica-demonstracao'], { entrada: 'aplicar\n', env: { FALHAR_EM: 'tar -x' } });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /PAREI no passo «2\. levar o kit/);
  assert.deepEqual(scriptsDoKit(e.chamadas()), []);
});

test('repetível: a segunda rodada repete exatamente a mesma sequência, sem erro e sem passo extra (a idempotência em si é dos scripts da VPS)', () => {
  const e = ambiente();
  const a = e.rodar(['clinica-demonstracao'], { entrada: 'aplicar\n' });
  const primeira = scriptsDoKit(e.chamadas());
  e.limparLog();
  const b = e.rodar(['clinica-demonstracao'], { entrada: 'aplicar\n' });
  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
  assert.deepEqual(scriptsDoKit(e.chamadas()), primeira);
  assert.deepEqual(primeira, CAMINHO_DEMO);
});

test('--so-conferir: não envia o kit, não aplica, não toca no proxy nem no cofre; só lê', () => {
  const e = ambiente();
  const r = e.rodar(['clinica-demonstracao', '--so-conferir']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /SÓ CONFERIR: nada foi enviado nem mudado/);
  const c = e.chamadas();
  assert.ok(!c.some((l) => l.includes('tar -x')), 'não envia');
  assert.deepEqual(scriptsDoKit(c), [], 'nenhum script do kit roda');
  // as sondas são só `test -s`
  const sondas = c.filter((l) => l.includes('test -s'));
  assert.equal(sondas.length, 4);
  assert.ok(c.every((l) => !/--aplicar|rm -|mv |>/.test(l.replace(/ -> /g, ''))), c.join('\n'));
});

test('sem a chave ssh: recusa antes de abrir qualquer conexão', () => {
  const e = ambiente({ chave: false });
  const r = e.rodar(['clinica-demonstracao'], { entrada: 'aplicar\n' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /RECUSO: não achei a chave ssh/);
  assert.match(r.stdout, /computador do João/);
  assert.deepEqual(e.chamadas(), []);
});

test('sem terminal não aplica (e não envia nada antes de recusar)', () => {
  const e = ambiente();
  const r = e.rodar(['clinica-demonstracao'], { entrada: 'aplicar\n', semPty: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /sem terminal não dá para aplicar/);
  assert.deepEqual(e.chamadas(), []);
});

test('clínica REAL: questionário privado vai para a VPS (só pelo stdin do ssh), subdomínio e sufixo certos, nenhum dado pessoal impresso, e o resumo pede número e modelos', () => {
  const e = ambiente();
  e.gravarPrivado('doutor-hernia-teste', QUESTIONARIO_REAL);
  const r = e.rodar(['doutor-hernia-teste'], { entrada: 'aplicar\n' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const saida = r.stdout + r.stderr + e.chamadas().join('\n');
  for (const d of DADOS_PESSOAIS) assert.ok(!saida.includes(d), `vazou: ${d}`);
  const c = e.chamadas();
  assert.ok(c.some((l) => l.includes('doutor-hernia-teste.yaml.chegando')), 'o questionário privado foi enviado');
  assert.deepEqual(scriptsDoKit(c), [
    'criar-platform-app --so-conferir',
    "nova-unidade 'doutor-hernia-teste' --so-conferir",
    "regra-traefik 'drherniateste' --so-conferir",
    "nova-unidade 'doutor-hernia-teste'",
    'criar-platform-app',
    "nova-unidade 'doutor-hernia-teste' --aplicar",
    "cofre-para-servico 'TESTE' --so-conferir",
    "regra-traefik 'drherniateste'",
    "cofre-para-servico 'TESTE'",
  ]);
  assert.match(r.stdout, /clínica de verdade/);
  assert.match(r.stdout, /NÚMERO: conectar o número oficial/);
  assert.match(r.stdout, /MODELOS NA META/);
});

test('o slug existir nos dois lugares, ou em nenhum, é recusado com o motivo', () => {
  const e = ambiente();
  const nenhum = e.rodar(['clinica-que-nao-existe']);
  assert.notEqual(nenhum.status, 0);
  assert.match(nenhum.stdout, /não achei o questionário/);
  e.gravarPrivado('clinica-demonstracao', QUESTIONARIO_REAL);
  const dois = e.rodar(['clinica-demonstracao']);
  assert.notEqual(dois.status, 0);
  assert.match(dois.stdout, /existe nos DOIS lugares/);
  assert.deepEqual(e.chamadas(), []);
});

test('argumentos ruins são recusados antes de tudo', () => {
  const e = ambiente();
  for (const args of [[], ['Slug_Ruim'], ['clinica-demonstracao', '--aplicar'], ['a-b', 'c-d']]) {
    const r = e.rodar(args);
    assert.notEqual(r.status, 0, args.join(' '));
  }
  assert.deepEqual(e.chamadas(), []);
});

test('questionário com subdomínio ou sufixo inválido: para antes de ligar no ssh', () => {
  const e = ambiente();
  e.gravarPrivado('clinica-ruim', QUESTIONARIO_REAL.replace('slug: doutor-hernia-teste', 'slug: clinica-ruim').replace('drherniateste', 'Dr_Hernia;rm'));
  const r = e.rodar(['clinica-ruim']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /subdomínio do questionário inválido/);
  e.gravarPrivado('clinica-ruim2', QUESTIONARIO_REAL.replace('slug: doutor-hernia-teste', 'slug: clinica-ruim2').replace('META_ADS_TOKEN_TESTE', 'TOKEN_SOLTO'));
  const r2 = e.rodar(['clinica-ruim2']);
  assert.notEqual(r2.status, 0);
  assert.match(r2.stdout, /meta\.token_env inválido/);
  assert.deepEqual(e.chamadas(), []);
});

test('o que vale é o que a VPS RECEBE: o subdomínio vem de origin/main, não do arquivo editado e não commitado', () => {
  const e = ambiente();
  const arquivo = join(e.repo, 'ops/kit-unidade/unidades/clinica-demonstracao.yaml');
  writeFileSync(arquivo, readFileSync(arquivo, 'utf8').replace('subdominio: demo ', 'subdominio: demo2 '));
  const r = e.rodar(['clinica-demonstracao'], { entrada: 'aplicar\n' });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /AVISO: ops\/kit-unidade aqui difere de origin\/main/);
  assert.ok(scriptsDoKit(e.chamadas()).includes("regra-traefik 'demo'"));
  assert.ok(!e.chamadas().some((l) => l.includes('demo2')));
});

test('etapa recusada (chaves ausentes do cofre): PARA ANTES de mexer no proxy e não diz «PRONTO»', () => {
  const e = ambiente();
  const r = e.rodar(['clinica-demonstracao'], { entrada: 'aplicar\n', env: { FALHAR_EM: "cofre-para-servico-joao.sh 'DEMO' --so-conferir" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /PAREI no passo «7a\. as chaves da conta estão no cofre/);
  assert.match(r.stdout, /O proxy ainda NÃO foi mexido/);
  assert.ok(!scriptsDoKit(e.chamadas()).includes("regra-traefik 'demo'"));
  assert.doesNotMatch(r.stdout, /PRONTO: «/);
});

test('--so-conferir de clínica REAL confere o envio do questionário privado sem enviar', () => {
  const e = ambiente();
  e.gravarPrivado('doutor-hernia-teste', QUESTIONARIO_REAL);
  const r = e.rodar(['doutor-hernia-teste', '--so-conferir']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /enviando SÓ o questionário doutor-hernia-teste/);
  assert.ok(!e.chamadas().some((l) => l.includes('.yaml.chegando')));
  for (const d of DADOS_PESSOAIS) assert.ok(!(r.stdout + r.stderr).includes(d), `vazou: ${d}`);
});

test('ssh que cai (255) na sonda NÃO vira «não»: para dizendo que não conseguiu ver', () => {
  const e = ambiente();
  const r = e.rodar(['clinica-demonstracao', '--so-conferir'], { env: { FALHAR_EM: 'test -s', FALHAR_CODIGO: '255' } });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /NÃO CONSEGUI VER \(ssh devolveu 255\)/);
  assert.doesNotMatch(r.stdout, /: não\n/);
});

test('o slug pedido precisa ser o do arquivo; modo desconhecido é recusado', () => {
  const e = ambiente();
  e.gravarPrivado('outra-clinica', QUESTIONARIO_REAL);
  const r = e.rodar(['outra-clinica']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /o questionário diz que o slug é «doutor-hernia-teste»/);
  e.gravarPrivado('doutor-hernia-teste', QUESTIONARIO_REAL.replace('modo: real', 'modo: demonstração'));
  const r2 = e.rodar(['doutor-hernia-teste']);
  assert.notEqual(r2.status, 0);
  assert.match(r2.stdout, /whatsapp\.modo inválido/);
  assert.deepEqual(e.chamadas(), []);
});

test('a conexão ssh é compartilhada (ControlMaster) e fechada no fim', () => {
  const e = ambiente();
  const r = e.rodar(['clinica-demonstracao'], { entrada: 'aplicar\n' });
  assert.equal(r.status, 0, r.stdout);
  const c = e.chamadas().filter((l) => l.startsWith('SSH ') && l.includes('-t root@'));
  assert.ok(c.length > 0 && c.every((l) => /-o ControlMaster=auto -o ControlPath=\S+\/%C -o ControlPersist=10m/.test(l)));
  assert.ok(e.chamadas().some((l) => l.includes('-O exit')), 'fecha a conexão compartilhada');
});
