/**
 * Teste das DEFINIÇÕES que moram no SQL de `consulta.ts`, contra um Postgres de verdade. Opt-in: sem
 * `TESTE_POSTGRES_URL` o arquivo inteiro é pulado (a suíte normal do repositório não tem Postgres).
 *
 * Como rodar: `backend/scripts/teste-sql-qualidade-ia.sh` (sobe um Postgres descartável no docker, cria as tabelas
 * com `prisma db push`, roda este arquivo duas vezes — fuso da sessão em UTC e em America/Sao_Paulo — e apaga o
 * container). Ou, à mão, num banco SEU de teste já com o schema:
 *   TESTE_POSTGRES_URL=postgresql://postgres:teste@127.0.0.1:55432/teste pnpm exec tsx --test src/lib/qualidade-ia/consulta.sql.test.ts
 *
 * Trava: o teste APAGA as tabelas (TRUNCATE). Só roda em 127.0.0.1/localhost e em banco cujo nome contém "teste";
 * qualquer outra coisa é recusada. Nunca aponte para produção.
 *
 * O que ele derruba (cada um já foi uma mutação que sobreviveu na revisão do #144): fuso invertido no dia de
 * São Paulo, fala da equipe contando como Sofia, régua contando como Sofia, "paciente respondeu" sem ser DEPOIS da
 * 1ª fala, resposta que não chegou (`lead_note`) contando como Sofia, e a conversa inteira em vez do que existia
 * quando o juiz deu a nota. Os casos de `meta` vêm da mesma tabela do teste puro, e o SQL tem de concordar com
 * `mensagemDaSofiaConversando` e `situacaoNaAvaliacao` (JavaScript) em cada um.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CASOS_DE_META } from '../mensagem-da-ia.casos.js';
import { mensagemDaSofiaConversando } from '../mensagem-da-ia.js';
import { situacaoNaAvaliacao } from './agregar.js';

const URL_DE_TESTE = process.env.TESTE_POSTGRES_URL ?? '';

function urlSegura(url: string): boolean {
  try {
    const u = new URL(url);
    return ['127.0.0.1', 'localhost'].includes(u.hostname) && /teste/i.test(u.pathname);
  } catch {
    return false;
  }
}

const habilitado = URL_DE_TESTE !== '';
if (habilitado && !urlSegura(URL_DE_TESTE)) {
  throw new Error('TESTE_POSTGRES_URL recusada: só 127.0.0.1/localhost e banco com "teste" no nome (o teste apaga as tabelas).');
}

const T = (iso: string) => new Date(iso);

describe('SQL do resumo de qualidade (Postgres de teste)', { skip: habilitado ? false : 'defina TESTE_POSTGRES_URL (ver o cabeçalho do arquivo)' }, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any;
  let unitId = '';
  let seq = 0;

  before(async () => {
    process.env.DATABASE_URL = URL_DE_TESTE;
    ({ prisma } = await import('../prisma.js'));
    q = await import('./consulta.js');
    await prisma.$executeRawUnsafe('TRUNCATE messages, conversation_evaluations, spine_lead_links, conversations, units CASCADE');
    unitId = (await prisma.unit.create({ data: { slug: 'serra', name: 'Serra' } })).id;
  });
  after(async () => {
    await prisma?.$disconnect();
  });

  type Msg = [role: string, content: string, em: string, meta?: unknown];
  async function conversa(msgs: Msg[], avaliadaEm: string, nota = 5) {
    const c = await prisma.conversation.create({
      data: { unitId, leadId: String(5000 + seq++), contactName: 'Ana Souza', phone: '+55 11 99999-1234' },
    });
    for (const [role, content, em, meta] of msgs) {
      await prisma.message.create({ data: { conversationId: c.id, role, content, createdAt: T(em), meta: meta ?? undefined } });
    }
    await prisma.conversationEvaluation.create({
      data: { conversationId: c.id, unitId, promptHash: 'h', promptSnapshot: 's', model: 'm', scores: {}, verdict: 'v', overallScore: nota, createdAt: T(avaliadaEm) },
    });
    return { id: c.id as string, leadId: c.leadId as string };
  }
  async function linha(id: string, de: string, ate: string) {
    const todas = await q.avaliacoesDoPeriodo(de, ate);
    const l = todas.find((x: { conversationId: string }) => x.conversationId === id);
    assert.ok(l, 'a avaliação tem de aparecer no período');
    return l as { dia: string; sofiaFalou: boolean; pacienteRespondeu: boolean; comConsulta: boolean; ganhou: boolean };
  }

  test('fuso: avaliação às 23:30 de São Paulo cai no dia de São Paulo, não no do UTC', async () => {
    // 2026-10-26T02:30Z = 25/10 23:30 em Brasília
    const a = await conversa(
      [['user', 'oi', '2026-10-25T12:00:00Z'], ['assistant', 'Olá, sou a Sofia, como posso ajudar?', '2026-10-25T12:01:00Z', { via: 'salesbot' }], ['user', 'dor nas costas', '2026-10-25T12:05:00Z']],
      '2026-10-26T02:30:00Z',
    );
    const l = await linha(a.id, '2026-10-25', '2026-10-26');
    assert.equal(l.dia, '2026-10-25');
    // e a borda: 03:00Z é a meia-noite de Brasília (dia 26), 02:59:59Z ainda é dia 25
    const borda1 = await conversa([['user', 'oi', '2026-10-26T01:00:00Z']], '2026-10-26T02:59:59Z');
    const borda2 = await conversa([['user', 'oi', '2026-10-26T01:00:00Z']], '2026-10-26T03:00:00Z');
    assert.equal((await linha(borda1.id, '2026-10-25', '2026-10-26')).dia, '2026-10-25');
    assert.equal((await linha(borda2.id, '2026-10-25', '2026-10-26')).dia, '2026-10-26');
    // a janela [25, 25] não pega a avaliação das 03:00Z do dia 26
    const so25 = await q.avaliacoesDoPeriodo('2026-10-25', '2026-10-25');
    assert.ok(!so25.some((x: { conversationId: string }) => x.conversationId === borda2.id));
    assert.ok(so25.some((x: { conversationId: string }) => x.conversationId === borda1.id));
  });

  test('só vale o que existia quando o juiz deu a nota: paciente que sumiu e VOLTOU depois continua "sumiu"', async () => {
    const d = await conversa(
      [['user', 'oi', '2026-10-25T12:00:00Z'], ['assistant', 'Olá! Qual é a sua dor principal hoje?', '2026-10-25T12:01:00Z', { via: 'salesbot' }], ['user', 'voltei, quero marcar', '2026-10-26T15:00:00Z']],
      '2026-10-25T20:00:00Z',
      2,
    );
    const l = await linha(d.id, '2026-10-25', '2026-10-25');
    assert.deepEqual({ s: l.sofiaFalou, r: l.pacienteRespondeu }, { s: true, r: false });
    // a Sofia só falou DEPOIS da nota: no momento da nota ela não tinha falado
    const g = await conversa([['user', 'oi', '2026-10-25T12:00:00Z'], ['assistant', 'Olá! Tudo bem com você?', '2026-10-26T12:01:00Z', { via: 'salesbot' }]], '2026-10-25T20:00:00Z');
    assert.equal((await linha(g.id, '2026-10-25', '2026-10-25')).sofiaFalou, false);
  });

  test('"respondeu" tem de ser DEPOIS da 1ª fala da Sofia (mensagem do paciente só antes não conta)', async () => {
    const h = await conversa([['user', 'oi', '2026-10-25T12:00:00Z'], ['user', 'alguém?', '2026-10-25T12:00:30Z'], ['assistant', 'Olá, tudo bem?', '2026-10-25T12:01:00Z', { via: 'salesbot' }]], '2026-10-25T20:00:00Z');
    const l = await linha(h.id, '2026-10-25', '2026-10-25');
    assert.deepEqual({ s: l.sofiaFalou, r: l.pacienteRespondeu }, { s: true, r: false });
    const ok = await conversa([['assistant', 'Olá, tudo bem?', '2026-10-25T12:01:00Z', { via: 'salesbot' }], ['user', 'tudo', '2026-10-25T12:02:00Z']], '2026-10-25T20:00:00Z');
    assert.equal((await linha(ok.id, '2026-10-25', '2026-10-25')).pacienteRespondeu, true);
  });

  test('o SQL concorda com mensagemDaSofiaConversando e situacaoNaAvaliacao em CADA caso de meta', async () => {
    for (const [meta, , sofiaEsperada] of CASOS_DE_META) {
      const msgs: Msg[] = [['user', 'oi', '2026-10-25T12:00:00Z'], ['assistant', 'Texto da resposta de teste', '2026-10-25T12:01:00Z', meta], ['user', 'e agora?', '2026-10-25T12:05:00Z']];
      const c = await conversa(msgs, '2026-10-25T20:00:00Z');
      const l = await linha(c.id, '2026-10-25', '2026-10-25');
      const js = situacaoNaAvaliacao(msgs.map(([role, , em, m]) => ({ role, createdAt: T(em), meta: m })), T('2026-10-25T20:00:00Z'));
      assert.equal(mensagemDaSofiaConversando(meta), sofiaEsperada, `JS ${JSON.stringify(meta)}`);
      assert.equal(l.sofiaFalou, sofiaEsperada, `SQL sofiaFalou ${JSON.stringify(meta)}`);
      assert.deepEqual({ sofiaFalou: l.sofiaFalou, pacienteRespondeu: l.pacienteRespondeu }, js, `SQL x JS ${JSON.stringify(meta)}`);
    }
  });

  test('ganho e consulta marcada vêm de converted_at e spine_lead_links', async () => {
    const c = await conversa([['assistant', 'Olá, tudo bem?', '2026-10-25T12:01:00Z', { via: 'salesbot' }], ['user', 'tudo', '2026-10-25T12:02:00Z']], '2026-10-25T20:00:00Z');
    await prisma.spineLeadLink.create({ data: { unitId, kommoLeadId: Number(c.leadId), spineIdSchedule: 77 } });
    await prisma.conversation.update({ where: { id: c.id }, data: { convertedAt: T('2026-10-27T10:00:00Z') } });
    const l = await linha(c.id, '2026-10-25', '2026-10-25');
    assert.deepEqual({ g: l.ganhou, c: l.comConsulta }, { g: true, c: true });
  });

  test('mensagens por dia: fuso, mensagem vazia, "Sofia sem falar" só no dia, e sinais com frases clínicas', async () => {
    // dia 29/10 (SP) = [2026-10-29T03:00Z, 2026-10-30T03:00Z)
    // P1: paciente escreve no dia 29; a Sofia só falou no dia 28 -> "sem falar no dia"
    await conversa([['user', 'oi', '2026-10-28T12:00:00Z'], ['assistant', 'Olá, sou a Sofia, como posso ajudar?', '2026-10-28T12:01:00Z', { via: 'salesbot' }], ['user', 'e então?', '2026-10-29T12:00:00Z']], '2026-10-30T20:00:00Z');
    // P2: paciente escreve no dia 29 e a Sofia responde no mesmo dia
    await conversa([['user', 'oi', '2026-10-29T13:00:00Z'], ['assistant', 'Olá, sou a Sofia, como posso ajudar?', '2026-10-29T13:01:00Z', { via: 'salesbot' }]], '2026-10-30T20:00:00Z');
    // P3: só a equipe respondeu (kommo_talks) -> a Sofia não falou
    await conversa([['user', 'oi', '2026-10-29T14:00:00Z'], ['assistant', 'Oi, aqui é a recepção', '2026-10-29T14:01:00Z', { origem: 'kommo_talks', autor: 'equipe' }]], '2026-10-30T20:00:00Z');
    // P4: mensagens vazias e o marcador de áudio, às 23:30 de SP do dia 29 (= 30/10 02:30Z)
    await conversa([['user', '', '2026-10-30T02:30:00Z'], ['user', '[áudio do cliente — não deu pra ouvir]', '2026-10-30T02:31:00Z'], ['user', 'texto normal', '2026-10-30T02:32:00Z']], '2026-10-31T20:00:00Z');
    // S: sinais — repetida (cruzando a meia-noite de SP), vazamento, falha técnica, e frases clínicas que NÃO contam
    const S = (c: string, em: string, meta: unknown = { via: 'salesbot' }): Msg => ['assistant', c, em, meta];
    await conversa(
      [
        ['user', 'oi', '2026-10-29T10:00:00Z'],
        S('A consulta custa R$ 250,00 e inclui avaliação.', '2026-10-30T02:50:00Z'), // 29/10 23:50 SP
        S('A consulta custa R$ 250,00 e inclui avaliação.', '2026-10-30T03:10:00Z'), // 30/10 00:10 SP -> repetida do dia 30
        S('Ok!', '2026-10-29T11:00:00Z'),
        S('Ok!', '2026-10-29T11:01:00Z'), // curta: não é repetida
        S('Vou acolher a dor dela antes de falar de preço.', '2026-10-29T11:02:00Z'), // vazamento
        S('Tivemos uma instabilidade aqui, pode repetir?', '2026-10-29T11:03:00Z'), // falha
        S('A instabilidade da coluna lombar pode causar essa dor.', '2026-10-29T11:04:00Z'), // clínico: não conta
        S('Não entendi qual região da coluna dói, é a lombar?', '2026-10-29T11:05:00Z'), // clínico: não conta
        S('Desculpe, não entendi. Pode repetir?', '2026-10-29T11:06:00Z'), // falha
        S('Lembrete: sua consulta é amanhã', '2026-10-29T11:07:00Z', { origem: 'confirmacao_d1' }), // fora
        S('Ainda está por aí? Posso ajudar com a sua dor.', '2026-10-29T11:08:00Z', { followUp: 1 }), // fora
        S('Tivemos uma instabilidade (equipe)', '2026-10-29T11:09:00Z', { origem: 'kommo_talks', autor: 'equipe' }), // fora
      ],
      '2026-10-31T20:00:00Z',
    );

    const dias = await q.mensagensPorDia('2026-10-29', '2026-10-30');
    const d29 = dias.find((d: { dia: string }) => d.dia === '2026-10-29');
    const d30 = dias.find((d: { dia: string }) => d.dia === '2026-10-30');
    assert.ok(d29 && d30);

    // pacientes no dia 29: P1, P2, P3, S + P4 (23:30 SP) = 5 conversas; sem Sofia no dia: P1, P3 e P4 = 3
    assert.equal(d29.conversasComPaciente, 5);
    assert.equal(d29.conversasSemSofia, 3, 'P1 (Sofia só no dia anterior), P3 (só a equipe) e P4 (ninguém); a fala de ontem não vale');
    assert.equal(d29.mensagensPacienteVazias, 2, 'vazia + marcador de áudio, no dia 29 de SP (não no 30 do UTC)');
    assert.equal(d29.mensagensPaciente, 3 + 4, 'P4 (3) + P1, P2, P3, S (1 cada)');

    // sinais no dia 29: a repetida das 23:50 é a 1ª (não repetida); no dia 30 a das 00:10 é repetida
    assert.deepEqual(d29.sinais, { repetidas: 0, vazamento: 1, falha: 2 });
    assert.equal(d30.sinais.repetidas, 1, 'repetida cruzando a meia-noite de SP cai no dia 30');
    // mensagens da Sofia no dia 29: P2 (1) + S (23:50, Ok x2, vazamento, instabilidade, 2 clínicas, desculpe = 8); sem confirmação, régua e equipe
    assert.equal(d29.mensagensSofia, 9);
  });

  test('independente do fuso da sessão do Postgres (o script roda este arquivo também com timezone = America/Sao_Paulo)', async () => {
    const [{ tz: timezone }] = (await prisma.$queryRawUnsafe("SELECT current_setting('timezone') AS tz")) as Array<{ tz: string }>;
    const esperado = process.env.TESTE_POSTGRES_FUSO;
    if (esperado) assert.equal(timezone, esperado, 'o script deveria ter posto o banco neste fuso');
    // a janela do dia 25 pega exatamente [03:00Z do 25, 03:00Z do 26), com a sessão em UTC ou em Brasília
    const c = await conversa([['user', 'oi', '2026-11-05T12:00:00Z']], '2026-11-05T03:00:00Z');
    assert.equal((await linha(c.id, '2026-11-05', '2026-11-05')).dia, '2026-11-05');
    const fora = await conversa([['user', 'oi', '2026-11-05T12:00:00Z']], '2026-11-05T02:59:59Z');
    assert.equal((await linha(fora.id, '2026-11-04', '2026-11-04')).dia, '2026-11-04');
  });
});
