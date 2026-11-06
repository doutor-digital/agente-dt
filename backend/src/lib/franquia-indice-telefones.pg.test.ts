/**
 * O `armazemPadrao` do índice de telefones da franquia contra um Postgres de verdade — descartável.
 *
 * Por quê. O SQL do upsert (`INSERT … ON CONFLICT … LEAST`) e o `timestamp` sem fuso não existem num teste com armazém em memória:
 * um erro de vírgula, de cast ou de fuso só apareceria na primeira carga em produção. Aqui cada regra do contrato tem um caso.
 *
 * Como. Mesmo molde do `preenche-campos-worker.pg.test.ts`: sobe `postgres:16-alpine` em porta aleatória, cria o esquema com
 * `prisma db push` (NUNCA `migrate dev`: ele reseta o banco) e derruba o contêiner no fim. Sem docker, ou com SEM_DOCKER=1, o
 * arquivo é pulado — e diz que pulou.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BACKEND = fileURLToPath(new URL('../../', import.meta.url));
const temDocker = process.env.SEM_DOCKER !== '1' && spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const PULAR = temDocker ? false : 'sem docker (ou SEM_DOCKER=1): o SQL do índice não foi provado contra um Postgres de verdade';

const nome = `pg-indice-${randomUUID().slice(0, 8)}`;
let prisma: typeof import('./prisma.js').prisma;
let I: typeof import('./franquia-indice-telefones.js');
let indisponivel: string | null = null;

before(async () => {
  if (PULAR) return;
  try {
    execFileSync('docker', ['run', '-d', '--rm', '--name', nome, '-e', 'POSTGRES_PASSWORD=x', '-p', '127.0.0.1::5432', 'postgres:16-alpine'], { stdio: 'ignore' });
    const porta = execFileSync('docker', ['port', nome, '5432/tcp']).toString().trim().split('\n')[0].split(':').pop();
    for (let i = 0; ; i++) {
      const r = spawnSync('docker', ['exec', nome, 'psql', '-U', 'postgres', '-tAc', 'select 1'], { stdio: 'ignore' });
      if (r.status === 0) break;
      if (i > 60) throw new Error('postgres descartável não subiu em 30 s');
      await new Promise((r2) => setTimeout(r2, 500));
    }
    process.env.DATABASE_URL = `postgresql://postgres:x@127.0.0.1:${porta}/postgres`;
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate'], { cwd: BACKEND, env: process.env, stdio: 'ignore' });
    ({ prisma } = await import('./prisma.js'));
    I = await import('./franquia-indice-telefones.js');
  } catch (err) {
    indisponivel = `Postgres descartável indisponível (${String(err).slice(0, 120)}): o SQL do índice NÃO foi provado contra um banco de verdade`;
    spawnSync('docker', ['rm', '-f', nome], { stdio: 'ignore' });
  }
});

after(async () => {
  if (PULAR) return;
  await prisma?.$disconnect().catch(() => undefined);
  spawnSync('docker', ['rm', '-f', nome], { stdio: 'ignore' });
});

const e = (chave: string, origem: 'paciente' | 'lead', id: number | null, criado: string | null) => ({ chave, origem, id, criado: criado ? new Date(criado) : null });

test('armazemPadrao contra Postgres: upsert guarda a data mais antiga, sem data ganha a que chegar, e a data fica em UTC', { skip: PULAR }, async (ctx) => {
  if (indisponivel) return ctx.skip(indisponivel);
  const u = await prisma.unit.create({ data: { slug: 'u-indice', name: 'u-indice' } });
  const outra = await prisma.unit.create({ data: { slug: 'u-outra', name: 'u-outra' } });
  const A = I.armazemPadrao;

  await A.gravar(u.id, [e('99991111', 'paciente', 1, null), e('99992222', 'lead', 20, '2025-06-01T12:30:00.000Z')]);
  // sem data ganha a que chegar (e leva o id junto)
  await A.gravar(u.id, [e('99991111', 'paciente', 2, '2025-05-01T00:00:00.000Z')]);
  // mais nova nunca troca
  await A.gravar(u.id, [e('99991111', 'paciente', 3, '2025-09-01T00:00:00.000Z'), e('99992222', 'lead', 21, null)]);
  // mais antiga troca
  await A.gravar(u.id, [e('99991111', 'paciente', 4, '2024-01-01T10:00:00.000Z')]);

  const [p] = await A.procurar(u.id, '99991111');
  assert.equal(p!.id, 4);
  assert.equal(p!.criado?.toISOString(), '2024-01-01T10:00:00.000Z', 'a hora UTC volta igual (sem deslocar pelo fuso da sessão)');
  const [l] = await A.procurar(u.id, '99992222');
  assert.equal(l!.id, 20, 'uma data nunca é trocada por "sem data"');
  assert.equal(l!.criado?.toISOString(), '2025-06-01T12:30:00.000Z');

  // o mesmo telefone como paciente E como lead são duas linhas; outra unidade não enxerga
  await A.gravar(u.id, [e('99991111', 'lead', 9, '2025-01-01T00:00:00.000Z')]);
  assert.equal((await A.procurar(u.id, '99991111')).length, 2);
  assert.equal((await A.procurar(outra.id, '99991111')).length, 0);

  // lote grande (mais de um pedaço de 500) e o mesmo lote de novo: idempotente
  const lote = Array.from({ length: 1200 }, (_, i) => e(String(10000000 + i), 'paciente', i + 1, '2025-02-01T00:00:00.000Z'));
  await A.gravar(u.id, lote);
  await A.gravar(u.id, lote);
  assert.equal(await prisma.franquiaTelefone.count({ where: { unitId: u.id, origem: 'paciente' } }), 1201);
});

test('status contra Postgres: salvar/ler, e a consulta diz fresco só depois de uma carga inteira', { skip: PULAR }, async (ctx) => {
  if (indisponivel) return ctx.skip(indisponivel);
  const u = await prisma.unit.create({ data: { slug: 'u-status', name: 'u-status' } });
  const A = I.armazemPadrao;
  assert.equal(await A.lerStatus(u.id), null);

  const agora = Date.now();
  await A.salvarStatus(u.id, { tentativaEm: new Date(agora) });
  assert.equal((await I.consultarIndice(u.id, '99991111', A, agora)).fresco, false, 'tentou mas não completou: não autoriza');

  const fim = new Date(agora - 3_600_000);
  await A.salvarStatus(u.id, { completoEm: fim, cargaCompletaEm: fim, clientesTotal: 150, leadsAte: '2026-11-06', resultado: 'ok', erro: null, pacientes: 150, leads: 3 });
  const s = await A.lerStatus(u.id);
  assert.equal(s?.clientesTotal, 150);
  assert.equal(s?.leadsAte, '2026-11-06');
  const r = await I.consultarIndice(u.id, '99991111', A, agora);
  assert.equal(r.fresco, true);
  assert.equal(r.idadeHoras, 1);

  // uma carga que falha depois não apaga o completoEm anterior, mas o tempo o torna velho
  await A.salvarStatus(u.id, { resultado: 'erro', erro: 'franquia fora' });
  assert.equal((await A.lerStatus(u.id))?.completoEm?.getTime(), fim.getTime());
  assert.equal((await I.consultarIndice(u.id, '99991111', A, agora + 40 * 3_600_000)).fresco, false);
});
