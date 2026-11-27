/**
 * O SQL do vigia de taxa de erro contra um Postgres de verdade, COM O FUSO DE PRODUÇÃO.
 *
 * Por quê. Em produção o banco roda em `America/Sao_Paulo` e o Prisma grava `created_at` em UTC num `timestamp` sem
 * fuso. `created_at > now() - interval '30 minutes'` cobria 3h30. Um banco de teste em UTC (o padrão do contêiner) NÃO
 * mostra isso — por isso aqui o contêiner sobe com `-c timezone=America/Sao_Paulo`, como o de produção. Sem docker, ou
 * com SEM_DOCKER=1, o arquivo é pulado e diz que pulou.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BACKEND = fileURLToPath(new URL('../../', import.meta.url));
const temDocker = process.env.SEM_DOCKER !== '1' && spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const PULAR = temDocker ? false : 'sem docker (ou SEM_DOCKER=1): o SQL do vigia não foi provado contra um Postgres de verdade';

const nome = `pg-taxa-${randomUUID().slice(0, 8)}`;
let prisma: typeof import('./prisma.js').prisma;
let W: typeof import('./taxa-erro-worker.js');
let indisponivel: string | null = null;

const minutosAtras = (m: number) => new Date(Date.now() - m * 60_000); // instante real; o Prisma grava em UTC

before(async () => {
  if (PULAR) return;
  try {
    execFileSync(
      'docker',
      ['run', '-d', '--rm', '--name', nome, '-e', 'POSTGRES_PASSWORD=x', '-p', '127.0.0.1::5432', 'postgres:16-alpine', '-c', 'timezone=America/Sao_Paulo'],
      { stdio: 'ignore' },
    );
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
    W = await import('./taxa-erro-worker.js');
  } catch (err) {
    indisponivel = `Postgres descartável indisponível (${String(err).slice(0, 120)}): o SQL do vigia NÃO foi provado`;
    spawnSync('docker', ['rm', '-f', nome], { stdio: 'ignore' });
  }
});

after(async () => {
  if (PULAR) return;
  await prisma?.$disconnect().catch(() => undefined);
  spawnSync('docker', ['rm', '-f', nome], { stdio: 'ignore' });
});

async function chamada(unitId: string, ha: number, status: 'success' | 'error', msg?: string, provider = 'anthropic') {
  await prisma.llmCall.create({ data: { unitId, provider, model: 'm', status, errorMessage: msg ?? null, createdAt: minutosAtras(ha) } });
}

test('a janela de 30 min é de 30 min (e não 3h30) com o banco em America/Sao_Paulo', { skip: PULAR }, async (ctx) => {
  if (indisponivel) return ctx.skip(indisponivel);
  const fuso = await prisma.$queryRawUnsafe<Array<{ tz: string }>>('select current_setting(\'TimeZone\') as tz');
  assert.equal(fuso[0].tz, 'America/Sao_Paulo', 'o banco de teste precisa ter o fuso de produção');

  const u = await prisma.unit.create({ data: { slug: 'u-janela', name: 'u-janela' } });
  // 10 chamadas de 10 min atrás (dentro dos 30 min) e 4 de 2 h atrás (FORA: pertencem à linha de base)
  for (let i = 0; i < 10; i++) await chamada(u.id, 10, 'error', 'x');
  for (let i = 0; i < 4; i++) await chamada(u.id, 120, 'success');
  // e uma de 5 h atrás, ainda dentro das 24 h da base
  await chamada(u.id, 300, 'success');

  const [a] = (await W._internos.medir()).filter((x) => x.slug === 'u-janela');
  assert.equal(a.recentesTotal, 10, 'só o que aconteceu nos últimos 30 min');
  assert.equal(a.recentesErro, 10);
  assert.equal(a.baseTotal, 5, 'o resto das 24 h é a base');
  assert.equal(a.baseErro, 0);
});

test('queda geral contra o banco: 1.000 erros de crédito em 39 unidades, com 4.000 sucessos antigos que NÃO podem diluir', { skip: PULAR }, async (ctx) => {
  if (indisponivel) return ctx.skip(indisponivel);
  const unidades: Array<{ id: string }> = [];
  for (let i = 0; i < 39; i++) unidades.push(await prisma.unit.create({ data: { slug: `q-${i}`, name: `q-${i}` } }));
  const dados = [];
  for (let i = 0; i < 1000; i++) {
    dados.push({
      unitId: unidades[i % 39].id,
      provider: 'anthropic',
      model: 'm',
      status: 'error',
      errorMessage: i % 2 ? '400 invalid_request_error: Your credit balance is too low to access the Anthropic API' : '429 You have no credits remaining',
      createdAt: minutosAtras(3),
    });
  }
  await prisma.llmCall.createMany({ data: dados });
  // sucesso antigo (fora dos 10 min) não pode diluir: a janela é de 10 min, não de 3h30
  await prisma.llmCall.createMany({
    data: Array.from({ length: 4000 }, () => ({ unitId: unidades[0].id, provider: 'anthropic', model: 'm', status: 'success', createdAt: minutosAtras(60) })),
  });

  const amostras = await W._internos.medirRede();
  const v = W.quedaGeral(amostras);
  assert.equal(v.alarme, true, JSON.stringify(amostras));
  assert.equal(v.causa, 'credito');

});
