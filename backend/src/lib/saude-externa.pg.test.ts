/**
 * `consultarSaude()` contra um Postgres de verdade COM O FUSO DE PRODUÇÃO (America/Sao_Paulo): é o que o vigia externo lê.
 * Sem docker, ou com SEM_DOCKER=1, o arquivo é pulado e diz que pulou.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const BACKEND = fileURLToPath(new URL('../../', import.meta.url));
const temDocker = process.env.SEM_DOCKER !== '1' && spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const PULAR = temDocker ? false : 'sem docker (ou SEM_DOCKER=1): a consulta de saúde não foi provada contra um Postgres de verdade';

const nome = `pg-saude-${randomUUID().slice(0, 8)}`;
let prisma: typeof import('./prisma.js').prisma;
let S: typeof import('./saude-externa.js');
let indisponivel: string | null = null;
const minutosAtras = (m: number) => new Date(Date.now() - m * 60_000);

before(async () => {
  if (PULAR) return;
  try {
    execFileSync('docker', ['run', '-d', '--rm', '--name', nome, '-e', 'POSTGRES_PASSWORD=x', '-p', '127.0.0.1::5432', 'postgres:16-alpine', '-c', 'timezone=America/Sao_Paulo'], { stdio: 'ignore' });
    const porta = execFileSync('docker', ['port', nome, '5432/tcp']).toString().trim().split('\n')[0].split(':').pop();
    for (let i = 0; ; i++) {
      if (spawnSync('docker', ['exec', nome, 'psql', '-U', 'postgres', '-tAc', 'select 1'], { stdio: 'ignore' }).status === 0) break;
      if (i > 60) throw new Error('postgres descartável não subiu em 30 s');
      await new Promise((r) => setTimeout(r, 500));
    }
    process.env.DATABASE_URL = `postgresql://postgres:x@127.0.0.1:${porta}/postgres`;
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate'], { cwd: BACKEND, env: process.env, stdio: 'ignore' });
    ({ prisma } = await import('./prisma.js'));
    S = await import('./saude-externa.js');
  } catch (err) {
    indisponivel = `Postgres descartável indisponível (${String(err).slice(0, 120)}): a consulta de saúde NÃO foi provada`;
    spawnSync('docker', ['rm', '-f', nome], { stdio: 'ignore' });
  }
});
after(async () => {
  if (PULAR) return;
  await prisma?.$disconnect().catch(() => undefined);
  spawnSync('docker', ['rm', '-f', nome], { stdio: 'ignore' });
});

async function chamada(unitId: string, ha: number, status: 'success' | 'error', provider: string, msg?: string) {
  await prisma.llmCall.create({ data: { unitId, provider, model: 'm', status, errorMessage: msg ?? null, createdAt: minutosAtras(ha) } });
}

test('saúde contra o banco: ok → erro antigo não conta → fora por crédito (1.000 erros) → cache de 15 s', { skip: PULAR }, async (ctx) => {
  if (indisponivel) return ctx.skip(indisponivel);
  const tz = await prisma.$queryRawUnsafe<Array<{ tz: string }>>("select current_setting('TimeZone') as tz");
  assert.equal(tz[0].tz, 'America/Sao_Paulo');
  const unidades: Array<{ id: string }> = [];
  for (let i = 0; i < 39; i++) unidades.push(await prisma.unit.create({ data: { slug: `s-${i}`, name: `s-${i}` } }));

  // 1. saudável: 30 chamadas boas nos últimos 10 min
  for (let i = 0; i < 30; i++) await chamada(unidades[i % 39].id, 4, 'success', 'anthropic');
  S.esquecerSaudeGuardada();
  const ok = await S.consultarSaude();
  assert.equal(ok.estado, 'ok');
  assert.equal(ok.chamadas, 30);
  assert.equal(ok.ultimoSucessoMinAtras, 4);

  // 2. erros ANTIGOS (2 h atrás) não contam: com o fuso trocado a janela de 10 min pegava 3h10 e acusava queda sem haver
  await prisma.llmCall.createMany({ data: Array.from({ length: 500 }, (_, i) => ({ unitId: unidades[i % 39].id, provider: 'anthropic', model: 'm', status: 'error', errorMessage: 'x', createdAt: minutosAtras(120) })) });
  S.esquecerSaudeGuardada();
  assert.equal((await S.consultarSaude()).estado, 'ok', 'erro de 2 h atrás não é queda agora');

  // 3. a queda: 1.000 erros de crédito, só do Anthropic, nos últimos 3 min, com as boas de antes já fora da janela de 10 min
  await prisma.llmCall.deleteMany({ where: { status: 'success' } });
  await prisma.llmCall.createMany({
    data: Array.from({ length: 1000 }, (_, i) => ({
      unitId: unidades[i % 39].id,
      provider: 'anthropic',
      model: 'm',
      status: 'error',
      errorMessage: i % 2 ? '400 invalid_request_error: Your credit balance is too low to access the Anthropic API' : '429 You have no credits remaining',
      createdAt: minutosAtras(3),
    })),
  });
  S.esquecerSaudeGuardada();
  const fora = await S.consultarSaude();
  assert.equal(fora.estado, 'fora', JSON.stringify(fora));
  assert.equal(fora.causa, 'credito');
  assert.equal(fora.chamadas, 1000);
  assert.deepEqual(fora.provedores.map((p) => p.nome), ['anthropic']);
  assert.equal(fora.ultimoSucessoMinAtras, null, 'sem sucesso na última hora');

  // 4. o cache de 15 s: a 2ª consulta não vai ao banco (mesmo objeto)
  assert.equal(await S.consultarSaude(), fora);
});

test('a consulta usa o índice de created_at (não varre a tabela): 30 mil linhas em 10 dias, plano com Index/Bitmap', { skip: PULAR }, async (ctx) => {
  if (indisponivel) return ctx.skip(indisponivel);
  const u = await prisma.unit.create({ data: { slug: 'u-plano', name: 'u-plano' } });
  const lote = (i0: number) =>
    Array.from({ length: 5000 }, (_, i) => ({ unitId: u.id, provider: 'openai', model: 'm', status: 'success', createdAt: minutosAtras(180 + ((i0 + i) * 14400) / 30000 * 1) }));
  for (let k = 0; k < 6; k++) await prisma.llmCall.createMany({ data: lote(k * 5000) });
  await prisma.$executeRawUnsafe('ANALYZE llm_calls');
  const plano = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN ${S.SQL_DA_SAUDE}`);
  const texto = plano.map((l) => l['QUERY PLAN']).join('\n');
  assert.match(texto, /Index|Bitmap/, texto);
  assert.ok(!/Seq Scan on llm_calls/.test(texto), texto);
});
