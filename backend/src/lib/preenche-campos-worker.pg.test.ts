/**
 * `alvos()` e `preencherDaUnidade()` contra um Postgres de verdade — descartável.
 *
 * Por quê. Os testes puros de `montarAlvos` não enxergam as condições do banco: o filtro `unitId` dos passos e dos
 * vínculos, o `spineIdSchedule` não nulo, a janela de 72 h, as unidades irmãs. Tirar qualquer uma dessas linhas do
 * worker deixava a suíte verde (o sênior provou com mutantes em 30/10). Aqui cada uma tem um caso que quebra sem ela.
 *
 * Como. Sobe `postgres:16-alpine` em porta aleatória, cria o esquema com `prisma db push` (NUNCA `migrate dev`: ele
 * reseta o banco) e derruba o contêiner no fim. Sem docker, ou com SEM_DOCKER=1, o arquivo é pulado — e diz que pulou.
 */
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Unit } from '@prisma/client';
import { agoraLocalISO } from '../agent/consulta-que-passou.js';

const BACKEND = fileURLToPath(new URL('../../', import.meta.url));
const temDocker = process.env.SEM_DOCKER !== '1' && spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const PULAR = temDocker ? false : 'sem docker (ou SEM_DOCKER=1): alvos() não foi provado contra um Postgres de verdade';

const nome = `pg-preenche-${randomUUID().slice(0, 8)}`;
let prisma: typeof import('./prisma.js').prisma;
let W: typeof import('./preenche-campos-worker.js');
let classificar: typeof import('./qualificacao-por-sinal.js').classificar;

const horas = (h: number) => new Date(Date.now() - h * 3_600_000);

before(async () => {
  if (PULAR) return;
  execFileSync('docker', ['run', '-d', '--rm', '--name', nome, '-e', 'POSTGRES_PASSWORD=x', '-p', '127.0.0.1::5432', 'postgres:16-alpine'], { stdio: 'ignore' });
  const porta = execFileSync('docker', ['port', nome, '5432/tcp']).toString().trim().split('\n')[0].split(':').pop();
  for (let i = 0; ; i++) {
    const r = spawnSync('docker', ['exec', nome, 'psql', '-U', 'postgres', '-tAc', 'select 1'], { stdio: 'ignore' });
    if (r.status === 0) break;
    if (i > 60) throw new Error('postgres descartável não subiu');
    await new Promise((r2) => setTimeout(r2, 500));
  }
  process.env.DATABASE_URL = `postgresql://postgres:x@127.0.0.1:${porta}/postgres`;
  execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate'], { cwd: BACKEND, env: process.env, stdio: 'ignore' });
  ({ prisma } = await import('./prisma.js'));
  W = await import('./preenche-campos-worker.js');
  ({ classificar } = await import('./qualificacao-por-sinal.js'));
});

after(async () => {
  if (PULAR) return;
  await prisma?.$disconnect().catch(() => undefined);
  spawnSync('docker', ['rm', '-f', nome], { stdio: 'ignore' });
});

async function unidade(slug: string, kommoSubdomain: string | null): Promise<Unit> {
  return prisma.unit.create({ data: { slug, name: slug, kommoSubdomain } });
}

/** Uma conversa que esfriou (última mensagem há 10 h) com `msgs` mensagens do paciente. */
async function conversa(unitId: string, leadId: number, msgs = 1) {
  const c = await prisma.conversation.create({ data: { unitId, leadId: String(leadId) } });
  for (let i = 0; i < msgs; i++) {
    await prisma.message.create({ data: { conversationId: c.id, role: 'user', content: 'x', createdAt: horas(10) } });
  }
}

async function passo(unitId: string, leadId: number, title: string, kind: 'TOOL_RESULT' | 'ERROR' = 'TOOL_RESULT', ha = 9) {
  const t = await prisma.executionTrace.create({
    data: { unitId, threadId: `t-${randomUUID()}`, leadId: String(leadId), input: {}, createdAt: horas(ha) },
  });
  await prisma.executionStep.create({ data: { traceId: t.id, sequence: 1, kind, title, createdAt: horas(ha) } });
}

const vinculo = (unitId: string, kommoLeadId: number, spineIdSchedule: number | null, agendadoPara: string | null) =>
  prisma.spineLeadLink.create({ data: { unitId, kommoLeadId, spineIdSchedule, agendadoPara } });

/** "AAAA-MM-DDTHH:mm" no relógio da clínica (America/Sao_Paulo, o padrão), `h` horas à frente. */
const naClinica = (h: number) => agoraLocalISO('America/Sao_Paulo', new Date(Date.now() + h * 3_600_000));
const FUTURO = '2099-01-01T09:00';
const PASSADO = '2020-01-01T09:00';
const HORARIOS = 'consultar_horarios 2026-11-03: 4 confirmado(s) de 6 livre(s) na grade';

test('alvos() contra Postgres: cada condição do banco tem um caso que quebra sem ela', { skip: PULAR }, async () => {
  const U = await unidade('u-principal', 'conta-a');
  const IRMA = await unidade('u-irma', 'conta-a'); // mesmo Kommo (Petrópolis/Caxias)
  const OUTRA = await unidade('u-outra', 'conta-b'); // outro Kommo, nada a ver
  const alvoDe = async (leadId: number) => (await W.alvos(U)).find((a) => a.leadId === leadId);

  // 1. linha de base: pediu horário (1 mensagem) -> Quente pelo passo
  await conversa(U.id, 101);
  await passo(U.id, 101, HORARIOS);
  // 2. só recusa por falta de escolha, 1 mensagem -> Frio (o defeito do #178)
  await conversa(U.id, 102);
  await passo(U.id, 102, 'agendar_consulta recusado — faltou confirmar o dia ou a forma de pagamento', 'ERROR');
  // 3. passo de OUTRA unidade com o mesmo leadId não vale
  await conversa(U.id, 103);
  await passo(OUTRA.id, 103, HORARIOS);
  // 4. vínculo de OUTRO Kommo com o mesmo leadId não vale
  await conversa(U.id, 104);
  await vinculo(OUTRA.id, 104, 5551, FUTURO);
  // 5. vínculo sem consulta (spineIdSchedule nulo: cancelada/zerada) não vale
  await conversa(U.id, 105);
  await vinculo(U.id, 105, null, FUTURO);
  // 6. vínculo da unidade IRMÃ (mesmo Kommo), consulta por vir -> vale
  await conversa(U.id, 106);
  await vinculo(IRMA.id, 106, 5552, FUTURO);
  // 7. consulta que JÁ PASSOU (NÃO COMPARECEU mantém o vínculo) não vale
  await conversa(U.id, 107);
  await vinculo(U.id, 107, 5553, PASSADO);
  // 8. vínculo sem data gravada: não dá para dizer que passou -> vale
  await conversa(U.id, 108);
  await vinculo(U.id, 108, 5554, null);
  // 9. passo de há 100 h (fora da janela de 72 h) não vale; o de 20 h sim
  await conversa(U.id, 109);
  await passo(U.id, 109, HORARIOS, 'TOOL_RESULT', 100);
  await conversa(U.id, 110);
  await passo(U.id, 110, HORARIOS, 'TOOL_RESULT', 20);
  // 10. consulta por vir na própria unidade -> vale
  await conversa(U.id, 111, 6);
  await vinculo(U.id, 111, 5555, FUTURO);
  // 11. a consulta é daqui a 3 h (viva) / foi há 3 h (passou) — o relógio da clínica é que decide, não só a data
  await conversa(U.id, 112);
  await vinculo(U.id, 112, 5556, naClinica(3));
  await conversa(U.id, 113);
  await vinculo(U.id, 113, 5557, naClinica(-3));

  const r = Object.fromEntries(
    await Promise.all([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113].map(async (id) => [id, await alvoDe(id)] as const)),
  );
  for (const [id, a] of Object.entries(r)) assert.ok(a, `lead ${id} devia estar entre os alvos`);
  const t = (id: number) => classificar(W.sinaisDoAlvo(r[id]!)).temperatura;

  assert.deepEqual(r[101]!.ferramentas, ['consultar_horarios']);
  assert.equal(t(101), 'Quente');
  assert.deepEqual(r[102]!.ferramentas, [], 'recusa por falta de escolha não é intenção');
  assert.equal(t(102), 'Frio');
  assert.deepEqual(r[103]!.ferramentas, [], 'passo de outra unidade vazou');
  assert.equal(t(103), 'Frio');
  assert.equal(r[104]!.temConsultaMarcada, false, 'vínculo de outro Kommo vazou');
  assert.equal(t(104), 'Frio');
  assert.equal(r[105]!.temConsultaMarcada, false, 'vínculo sem spineIdSchedule contou como consulta');
  assert.equal(r[106]!.temConsultaMarcada, true, 'vínculo da unidade irmã devia valer');
  assert.equal(r[107]!.temConsultaMarcada, false, 'consulta que já passou contou como marcada');
  assert.equal(t(107), 'Frio');
  assert.equal(r[108]!.temConsultaMarcada, true);
  assert.deepEqual(r[109]!.ferramentas, [], 'passo fora da janela de 72 h contou');
  assert.equal(t(109), 'Frio');
  assert.deepEqual(r[110]!.ferramentas, ['consultar_horarios']);
  assert.equal(r[111]!.temConsultaMarcada, true);
  assert.equal(t(111), 'Quente');
  assert.equal(r[112]!.temConsultaMarcada, true, 'consulta daqui a 3 h devia estar viva');
  assert.equal(r[113]!.temConsultaMarcada, false, 'consulta de há 3 h não está mais por vir');
});

test('preencherDaUnidade() contra Postgres: grava a temperatura certa e registra por lead o que escreveu, sem dado pessoal', { skip: PULAR }, async () => {
  const U = await unidade('u-log', 'conta-log');
  await prisma.leadFieldRule.create({
    data: { unitId: U.id, kommoFieldId: 900, kommoFieldName: 'Qualificação (IA)', kommoFieldType: 'select', toolName: 'salvar_q', instruction: 'x', kommoFieldEnums: [{ id: 1, value: 'Quente' }] },
  });
  await prisma.leadFieldRule.create({
    data: { unitId: U.id, kommoFieldId: 901, kommoFieldName: 'Sexo', kommoFieldType: 'select', toolName: 'salvar_s', instruction: 'x', kommoFieldEnums: [] },
  });
  await prisma.unit.update({ where: { id: U.id }, data: { kommoAccessToken: 'ficticio' } });
  const unit = (await prisma.unit.findUniqueOrThrow({ where: { id: U.id } }));

  await conversa(U.id, 201, 1);
  await passo(U.id, 201, 'agendar_consulta recusado — faltou confirmar o dia', 'ERROR'); // -> Frio
  await conversa(U.id, 202, 1);
  await passo(U.id, 202, HORARIOS); // -> Quente

  const escritas: Array<[number, number, string]> = [];
  const kommo = {
    getLead: async (id: number) => ({ id, name: 'Joaquim Pereira Segredo', custom_fields_values: null }),
    setLeadCustomFieldValue: async (leadId: number, fieldId: number, _tipo: string, valor: string) => {
      escritas.push([leadId, fieldId, valor]);
    },
  } as unknown as import('./preenche-campos-worker.js').ClienteDoKommo;

  const { logger } = await import('./logger.js');
  const linhas: Array<Record<string, unknown>> = [];
  const espiao = mock.method(logger, 'info', (obj: unknown, msg?: string) => {
    if (msg === 'preenche-campos: preencheu') linhas.push(obj as Record<string, unknown>);
  });

  const seco = await W.preencherDaUnidade(unit, { simular: true, kommo });
  assert.equal(escritas.length, 0, 'modo seco gravou no Kommo');
  assert.equal(seco.qualificacao, 2);
  assert.ok(linhas.every((l) => l.simulado === true));
  linhas.length = 0;

  const r = await W.preencherDaUnidade(unit, { simular: false, kommo });
  espiao.mock.restore();
  assert.equal(r.qualificacao, 2);
  assert.deepEqual(
    escritas.filter((e) => e[1] === 900).sort((a, b) => a[0] - b[0]),
    [[201, 900, 'Frio'], [202, 900, 'Quente']],
  );

  // uma linha por escrita, com leadId, campo, valor e porquê
  const q = linhas.filter((l) => l.campo === 'Qualificação (IA)').sort((a, b) => Number(a.leadId) - Number(b.leadId));
  assert.equal(q.length, 2);
  assert.deepEqual(q.map((l) => [l.leadId, l.valor]), [[201, 'Frio'], [202, 'Quente']]);
  assert.match(String(q[1].porque), /consultar_horarios/);
  assert.equal(q[0].simulado, false);
  const sexo = linhas.filter((l) => l.campo === 'Sexo');
  assert.equal(sexo.length, 2);
  // sem dado pessoal: nem o nome do paciente, em nenhum campo da linha
  assert.doesNotMatch(JSON.stringify(linhas), /joaquim|pereira|segredo/i);
});
