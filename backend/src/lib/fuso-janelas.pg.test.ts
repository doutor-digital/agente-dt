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

/** Um turno da Sofia SEM consultar a agenda: só o passo «IA respondeu» (a oferta do turno seguinte à consulta). */
async function turnoSoRespondendo(unitId: string, leadId: string, ha: Date, texto: string) {
  const t = await prisma.executionTrace.create({
    data: { id: randomUUID(), unitId, threadId: `t-${randomUUID()}`, leadId, input: {}, status: 'SUCCESS', createdAt: ha },
  });
  await prisma.executionStep.create({ data: { traceId: t.id, sequence: 1, kind: 'THINKING', title: 'IA respondeu (sem tool call)', payload: { text: texto }, createdAt: ha } });
}

/** Um turno da Sofia: consultou a agenda e RESPONDEU (`texto` é o que o passo «IA respondeu» grava). */
async function turnoComConsulta(unitId: string, leadId: string, ha: Date, texto: string) {
  const t = await prisma.executionTrace.create({
    data: { id: randomUUID(), unitId, threadId: `t-${randomUUID()}`, leadId, input: {}, status: 'SUCCESS', createdAt: ha },
  });
  await prisma.executionStep.create({ data: { traceId: t.id, sequence: 1, kind: 'TOOL_RESULT', title: 'consultar_horarios 2026-11-30: 4 confirmado(s) de 6 livre(s) na grade', createdAt: ha } });
  await prisma.executionStep.create({ data: { traceId: t.id, sequence: 2, kind: 'THINKING', title: 'IA respondeu (sem tool call)', payload: { text: texto }, createdAt: ha } });
}

test('agendamento perdido: a carência e a janela de 24 h são de verdade (e não +3 h)', { skip: PULAR }, async (ctx) => {
  if (indisponivel) return ctx.skip(indisponivel);
  const { _internos } = await import('./agendamento-perdido-worker.js');
  const u = await prisma.unit.create({ data: { slug: 'u-perdido', name: 'u-perdido', kommoSubdomain: 'perdido' } });

  // ofereceu há CARENCIA + 10 min: já passou a carência (90 min) -> candidato. Com o fuso trocado só entraria 3 h depois.
  const oferta = 'Tenho segunda-feira (30/11) às 08:30 ou às 13:30. Qual fica melhor pra você?';
  await turnoComConsulta(u.id, '1001', minutosAtras(_internos.CARENCIA_MIN + 10), oferta);
  // ofereceu há 30 min: ainda na carência -> NÃO é candidato (com o fuso trocado também não; é o controle)
  await turnoComConsulta(u.id, '1002', minutosAtras(30), oferta);
  // ofereceu há JANELA + 1 h: velho demais -> fora. Com o fuso trocado a janela ganhava 3 h e ele entrava.
  await turnoComConsulta(u.id, '1003', horasAtras(_internos.JANELA_HORAS + 1), oferta);

  const leads = (await _internos.candidatos()).map((c) => c.leadId).sort();
  assert.deepEqual(leads, ['1001']);
});

test('agendamento perdido: só OFERTA de verdade, em qualquer turno; sem aviso depois de sinal de alerta ou da EQUIPE, COM aviso na passagem comum da Sofia (28/11/2026)', { skip: PULAR }, async (ctx) => {
  if (indisponivel) return ctx.skip(indisponivel);
  const { _internos } = await import('./agendamento-perdido-worker.js');
  const u = await prisma.unit.create({ data: { slug: 'u-perdido-2', name: 'u-perdido-2', kommoSubdomain: 'perdido2' } });
  const ofereceuHa = minutosAtras(_internos.CARENCIA_MIN + 60);
  const depois = (min = 30) => minutosAtras(_internos.CARENCIA_MIN + 60 - min);
  const oferta = 'Tenho segunda-feira (30/11) às 08:30 ou às 13:30. Qual fica melhor pra você?';
  // um passo gravado DEPOIS da oferta (o tipo do passo não entra no filtro, só o título)
  const passoDepois = (leadId: string, titulo: string, min = 30) => rastro(u.id, leadId, depois(min), titulo);

  // 3001: consultou e ofereceu no mesmo turno e sumiu -> AVISA (o caso de sempre)
  await turnoComConsulta(u.id, '3001', ofereceuHa, oferta);
  // 3002: Porto 30288526 — consultou a agenda mas só perguntou da dor: NÃO ofereceu
  await turnoComConsulta(u.id, '3002', ofereceuHa, 'Que bom que você quer cuidar da sua coluna! 😊 Antes de marcar, me conta: onde é a dor e há quanto tempo você sente isso?');
  // 3003: Canaã 31395380 — ofereceu e depois passou para a equipe por SINAL DE ALERTA: NÃO avisa
  await turnoComConsulta(u.id, '3003', ofereceuHa, oferta);
  await passoDepois('3003', 'Decisão: pausar IA no lead 3003 (Sinal de alerta clínico: fraqueza na perna) — SINAL DE ALERTA');
  // 3004: o aviso urgente do sinal de alerta saiu depois da oferta: NÃO avisa
  await turnoComConsulta(u.id, '3004', ofereceuHa, oferta);
  await passoDepois('3004', 'Sinal de alerta avisado no Telegram do João (lead 3004)');
  // 3005: a equipe falou à mão depois da oferta (pausa-equipe marcou «Pausar IA»): NÃO avisa
  await turnoComConsulta(u.id, '3005', ofereceuHa, oferta);
  await passoDepois('3005', '⏸ A equipe falou com o paciente (o celular da clínica (WhatsApp Business) em 27/11, 14:54) — "Pausar IA" marcado, a Sofia não responde por cima');
  // 3010: alguém marcou «Pausar IA» na mão e a mensagem seguinte gravou «IA pausada por humano», sem pausar_ia da Sofia: NÃO avisa
  await turnoComConsulta(u.id, '3010', ofereceuHa, oferta);
  await passoDepois('3010', 'IA pausada por humano — agente não respondeu');
  // 3006: a PRÓPRIA Sofia passou o cartão (os passos que a produção grava, lead 3971096 / 8227913) — a próxima mensagem do paciente grava
  // «IA pausada por humano» mas quem pausou foi a Sofia: CONTINUA avisando, a venda pode ter ficado parada
  await turnoComConsulta(u.id, '3006', ofereceuHa, oferta);
  await passoDepois('3006', 'Decisão: pausar IA no lead 3006 (Paciente repetiu "?" sem escolher horário após 3 ofertas)', 10);
  await passoDepois('3006', 'IA pausada no lead 3006', 10);
  await passoDepois('3006', 'Handoff carimbado (data + assumido por humano + motivo "Pedido do lead") no lead 3006', 10);
  await passoDepois('3006', '⏸ Resposta descartada antes de enviar — a Sofia passou o atendimento para a equipe e esta unidade pede que o paciente não seja avisado', 11);
  await passoDepois('3006', 'IA pausada por humano — agente não respondeu', 20);
  // 3011: a Sofia passou o cartão NO MESMO turno da oferta (o pausar_ia grava segundos antes da resposta): continua avisando
  await rastro(u.id, '3011', new Date(ofereceuHa.getTime() - 10_000), 'Decisão: pausar IA no lead 3011 (agenda sem vaga)');
  await turnoComConsulta(u.id, '3011', ofereceuHa, oferta);
  await passoDepois('3011', 'IA pausada por humano — agente não respondeu');
  // 3007: a pausa ANTES da oferta não conta (a oferta veio depois e foi perdida)
  await rastro(u.id, '3007', horasAtras(5), 'IA pausada por humano — agente não respondeu');
  await turnoComConsulta(u.id, '3007', ofereceuHa, oferta);
  // 3008: horário escrito em outras formas
  await turnoComConsulta(u.id, '3008', ofereceuHa, 'Consigo às 9hrs ou às 14hrs, qual prefere?');
  // 3009: a Sofia CONSULTOU num turno (perguntou da dor) e OFERECEU no seguinte, sem consultar de novo (Salto 5428579, Bebedouro 7775157…): AVISA
  await turnoComConsulta(u.id, '3009', minutosAtras(_internos.CARENCIA_MIN + 180), 'Antes de marcar, onde é a dor?');
  await turnoSoRespondendo(u.id, '3009', ofereceuHa, 'Consigo segunda 30/11 às 09:00 ou 16:30. Qual prefere?');
  // 3012: resposta com horário SEM nenhuma consulta de agenda antes ("Funcionamos das 08:00 às 18:00"): não é oferta
  await turnoSoRespondendo(u.id, '3012', ofereceuHa, 'Funcionamos das 08:00 às 18:00.');

  // o banco é compartilhado entre os casos do arquivo: só os desta unidade
  const leads = (await _internos.candidatos()).filter((c) => c.unitId === u.id).map((c) => c.leadId).sort();
  assert.deepEqual(leads, ['3001', '3006', '3007', '3008', '3009', '3011']);
});

test('AGENDADO só com consulta viva: o passo «Consulta marcada:» de consulta que já passou não conta (SQL contra o Postgres de verdade)', { skip: PULAR }, async (ctx) => {
  if (indisponivel) return ctx.skip(indisponivel);
  const { marcouPelaSofiaNoRastro } = await import('./agendado-so-depois-de-marcar.js');
  const u = await prisma.unit.create({ data: { slug: 'u-agendado', name: 'u-agendado' } });
  const dia = (mais: number) => new Date(Date.now() + mais * 86_400_000).toISOString().slice(0, 10);
  const marcou = (leadId: string, data: string, ha: Date) => rastro(u.id, leadId, ha, `Consulta marcada: ${data} 09:00 (idSchedule 1)`, randomUUID(), { data, hora: '09:00' });

  await marcou('4001', dia(2), horasAtras(1)); // marcou agora para depois de amanhã: viva
  await marcou('4002', dia(-18), horasAtras(24 * 20)); // marcou há 20 dias para há 18: de outro ciclo
  await marcou('4003', dia(0), horasAtras(3)); // marcou hoje para hoje: viva
  await marcou('4004', dia(5), horasAtras(24 * 60)); // marcação de 60 dias atrás: fora da janela de 45 dias

  assert.equal(await marcouPelaSofiaNoRastro(u.id, 4001), true);
  assert.equal(await marcouPelaSofiaNoRastro(u.id, 4002), false);
  assert.equal(await marcouPelaSofiaNoRastro(u.id, 4003), true);
  assert.equal(await marcouPelaSofiaNoRastro(u.id, 4004), false);
  assert.equal(await marcouPelaSofiaNoRastro(u.id, 4999), false); // lead sem passo nenhum
  // marcou para daqui a 3 dias e CANCELOU depois: a consulta não está viva
  await rastro(u.id, '4005', horasAtras(5), `Consulta marcada: ${dia(3)} 09:00 (idSchedule 777)`, randomUUID(), { data: dia(3), hora: '09:00', idSchedule: 777 });
  await rastro(u.id, '4005', horasAtras(1), 'cancelar_consulta 777: cancelada');
  assert.equal(await marcouPelaSofiaNoRastro(u.id, 4005), false);
  // cancelou OUTRA consulta (idSchedule diferente): a marcada continua viva
  await rastro(u.id, '4006', horasAtras(5), `Consulta marcada: ${dia(3)} 09:00 (idSchedule 888)`, randomUUID(), { data: dia(3), hora: '09:00', idSchedule: 888 });
  await rastro(u.id, '4006', horasAtras(1), 'cancelar_consulta 111: cancelada');
  assert.equal(await marcouPelaSofiaNoRastro(u.id, 4006), true);
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
