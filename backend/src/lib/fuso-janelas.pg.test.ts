/**
 * Toda janela «agora − X» do agente, contra um Postgres com O FUSO DE PRODUÇÃO (America/Sao_Paulo).
 *
 * O Prisma grava `created_at` em UTC num `timestamp` sem fuso; `now()` é `timestamptz` e a sessão está em São Paulo, então
 * `created_at > now() - interval '10 minutes'` cobria 3h10 (auditoria de 27/11). O contêiner padrão do Postgres é UTC e
 * esconde o defeito — aqui ele sobe com `-c timezone=America/Sao_Paulo`. Cada caso põe uma linha a ~2 h/3 h da borda
 * (onde o fuso trocado erra) e outra do lado certo. Sem docker, ou com SEM_DOCKER=1, o arquivo é pulado e diz que pulou.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { protegerContainer } from './pg-descartavel.js';

const BACKEND = fileURLToPath(new URL('../../', import.meta.url));
const temDocker = process.env.SEM_DOCKER !== '1' && spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const PULAR = temDocker ? false : 'sem docker (ou SEM_DOCKER=1): as janelas de tempo não foram provadas contra um Postgres de verdade';

const nome = `pg-fuso-${randomUUID().slice(0, 8)}`;
let prisma: typeof import('./prisma.js').prisma;
let indisponivel: string | null = null;

const minutosAtras = (m: number) => new Date(Date.now() - m * 60_000);
const horasAtras = (h: number) => minutosAtras(h * 60);

before(async () => {
  if (PULAR) return;
  try {
    execFileSync(
      'docker',
      ['run', '-d', '--rm', '--name', nome, '-e', 'POSTGRES_PASSWORD=x', '-p', '127.0.0.1::5432', 'postgres:16-alpine', '-c', 'timezone=America/Sao_Paulo'],
      { stdio: 'ignore' },
    );
    protegerContainer(nome);
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
    const tz = await prisma.$queryRawUnsafe<Array<{ tz: string }>>("select current_setting('TimeZone') as tz");
    assert.equal(tz[0].tz, 'America/Sao_Paulo', 'o banco de teste precisa ter o fuso de produção');
  } catch (err) {
    indisponivel = `Postgres descartável indisponível (${String(err).slice(0, 120)}): as janelas NÃO foram provadas`;
    spawnSync('docker', ['rm', '-f', nome], { stdio: 'ignore' });
  }
});

after(async () => {
  if (PULAR) return;
  await prisma?.$disconnect().catch(() => undefined);
  spawnSync('docker', ['rm', '-f', nome], { stdio: 'ignore' });
});

async function rastro(unitId: string, leadId: string, ha: Date, titulo: string, id: string = randomUUID(), payload?: object) {
  const t = await prisma.executionTrace.create({
    data: { id, unitId, threadId: `t-${randomUUID()}`, leadId, input: {}, status: 'SUCCESS', createdAt: ha },
  });
  await prisma.executionStep.create({ data: { traceId: t.id, sequence: 1, kind: 'TOOL_RESULT', title: titulo, payload: payload ?? undefined, createdAt: ha } });
}

test('agendamento perdido: a carência e a janela de 24 h são de verdade (e não +3 h)', { skip: PULAR }, async (ctx) => {
  if (indisponivel) return ctx.skip(indisponivel);
  const { _internos } = await import('./agendamento-perdido-worker.js');
  const u = await prisma.unit.create({ data: { slug: 'u-perdido', name: 'u-perdido', kommoSubdomain: 'perdido' } });

  // ofereceu há CARENCIA + 10 min: já passou a carência (90 min) -> candidato. Com o fuso trocado só entraria 3 h depois.
  await rastro(u.id, '1001', minutosAtras(_internos.CARENCIA_MIN + 10), 'consultar_horarios 2026-11-30: 3 livres');
  // ofereceu há 30 min: ainda na carência -> NÃO é candidato (com o fuso trocado também não; é o controle)
  await rastro(u.id, '1002', minutosAtras(30), 'consultar_horarios 2026-11-30: 3 livres');
  // ofereceu há JANELA + 1 h: velho demais -> fora. Com o fuso trocado a janela ganhava 3 h e ele entrava.
  await rastro(u.id, '1003', horasAtras(_internos.JANELA_HORAS + 1), 'consultar_horarios 2026-11-30: 3 livres');

  const leads = (await _internos.candidatos()).map((c) => c.leadId).sort();
  assert.deepEqual(leads, ['1001']);
});

test('aviso à clínica: "houve aviso recente" e "pendentes" olham a janela pedida, não +3 h', { skip: PULAR }, async (ctx) => {
  if (indisponivel) return ctx.skip(indisponivel);
  const { marcadorNoBanco } = await import('./aviso-clinica-agendamento.js');
  const u = await prisma.unit.create({ data: { slug: 'u-aviso', name: 'u-aviso' } });
  const pfx = `aviso-${randomUUID().slice(0, 6)}:`;

  await rastro(u.id, '2001', horasAtras(2), 'aviso velho', `${pfx}velho`, { estado: 'enviado' });
  await rastro(u.id, '2002', minutosAtras(1), 'aviso novo', `${pfx}novo`, { estado: 'enviado' });
  await rastro(u.id, '2003', horasAtras(2), 'pendente velha', `${pfx}pv`, { estado: 'pendente' });
  await rastro(u.id, '2004', minutosAtras(1), 'pendente nova', `${pfx}pn`, { estado: 'pendente' });

  // janela de 10 min: o de 2 h atrás NÃO conta (com o fuso trocado contava: a janela virava 3h10)
  assert.equal(await marcadorNoBanco.houveRecente(u.id, '2001', pfx, 10 * 60_000), false);
  assert.equal(await marcadorNoBanco.houveRecente(u.id, '2002', pfx, 10 * 60_000), true);
  const pend = (await marcadorNoBanco.pendentes(pfx, 10 * 60_000)).map((p) => p.leadId);
  assert.deepEqual(pend, ['2004']);
});

test('preenche campos: a conversa "esfriou" com 6 h de verdade e a janela é de 72 h de verdade', { skip: PULAR }, async (ctx) => {
  if (indisponivel) return ctx.skip(indisponivel);
  const W = await import('./preenche-campos-worker.js');
  const u = await prisma.unit.create({ data: { slug: 'u-preenche', name: 'u-preenche' } });
  const conversa = async (lead: number, ha: Date) => {
    const c = await prisma.conversation.create({ data: { unitId: u.id, leadId: String(lead) } });
    await prisma.message.create({ data: { conversationId: c.id, role: 'user', content: 'oi', createdAt: ha } });
  };
  await conversa(3001, horasAtras(7)); // esfriou (>6 h) -> alvo. Com o fuso trocado parecia ter 4 h e ficava de fora.
  await conversa(3002, horasAtras(4)); // ainda quente (<6 h) -> não
  await conversa(3003, horasAtras(73)); // velha demais (>72 h) -> não. Com o fuso trocado parecia ter 70 h e entrava.
  const alvos = (await W.alvos(u as never)).map((a) => a.leadId).sort();
  assert.deepEqual(alvos, [3001]);
});

test('dedup: chave que venceu há 1 h pode ser reivindicada de novo (e não só 3 h depois)', { skip: PULAR }, async (ctx) => {
  if (indisponivel) return ctx.skip(indisponivel);
  const { reivindicarComCerteza } = await import('./dedup-cache.js');
  // a 1ª chamada dispara a limpeza em segundo plano (que apaga vencidas pelo relógio do JS, certo); gasta-a antes, para o
  // caso valer só pelo `ON CONFLICT ... WHERE expires_at <= now`, que é o que corre entre uma limpeza e outra.
  await reivindicarComCerteza('fuso', 'aquecimento');
  await new Promise((r) => setTimeout(r, 300));
  const msg = randomUUID();
  await prisma.messageClaim.create({ data: { key: `fuso:${msg}`, expiresAt: horasAtras(1) } });
  assert.equal(await reivindicarComCerteza('fuso', msg), 'ganhou');
  // e uma que ainda vale (vence daqui a 1 h) continua sendo de quem pegou
  const viva = randomUUID();
  await prisma.messageClaim.create({ data: { key: `fuso:${viva}`, expiresAt: new Date(Date.now() + 3_600_000) } });
  assert.equal(await reivindicarComCerteza('fuso', viva), 'perdeu');
});

test('dedup pelo caminho REAL (INSERT cru): a mesma mensagem reivindicada 2x ganha uma vez só, e a limpeza não apaga marca viva', { skip: PULAR }, async (ctx) => {
  if (indisponivel) return ctx.skip(indisponivel);
  const { claimMessageId, clearDedupCache, limparClaimsVencidos } = await import('./dedup-cache.js');
  const msg = randomUUID();
  assert.equal(await claimMessageId('real', msg), true);
  clearDedupCache(); // sem a memória do processo: só o banco decide (outra réplica, ou depois de um reinício)
  assert.equal(await claimMessageId('real', msg), false, 'marca nascida vencida deixaria a Sofia responder 2x');
  // o vencimento gravado é daqui a ~TTL (UTC), não 3 h antes
  const [m] = await prisma.$queryRawUnsafe<Array<{ min: number }>>(
    `select extract(epoch from (expires_at - (now() at time zone 'utc')))::int / 60 as min from message_claims where key = $1`,
    `real:${msg}`,
  );
  assert.ok(m.min >= 8 && m.min <= 11, `vencimento ${m.min} min à frente (esperado ~10, o TTL padrão)`);
  // reentrega de 2 h (TTL_REENTREGA_KOMMO_MS): a limpeza do JS não pode apagá-la
  const { TTL_REENTREGA_KOMMO_MS } = await import('./dedup-cache.js');
  const longa = randomUUID();
  assert.equal(await claimMessageId('real', longa, TTL_REENTREGA_KOMMO_MS), true);
  const [l] = await prisma.$queryRawUnsafe<Array<{ min: number }>>(`select extract(epoch from (expires_at - (now() at time zone 'utc')))::int / 60 as min from message_claims where key = $1`, `real:${longa}`);
  assert.ok(l.min >= 118 && l.min <= 121, `vencimento ${l.min} min à frente (esperado ~120)`);
  await limparClaimsVencidos();
  clearDedupCache();
  assert.equal(await claimMessageId('real', longa, TTL_REENTREGA_KOMMO_MS), false, 'a marca de 2 h tem de sobreviver à limpeza');
});
