/**
 * Oferta de 2 horários a quem não vai conseguir ir: o que muda no prompt da Sofia e quando.
 * A regra do João: só remarca se o paciente escolher; «não quero mais» é respeitado; horário nunca é inventado.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Unit } from '@prisma/client';

process.env.DATABASE_URL ??= 'postgresql://t:t@localhost:5432/t';
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.SESSION_JWT_SECRET ??= 'segredo-de-teste-com-mais-de-32-caracteres-ok';

const { composeSystemPrompt } = await import('../agent/prompt-composer.js');
const o = await import('./remarcar-oferta.js');
const { classificarRespostaD1 } = await import('./confirmacao-d1.js');
const { tratarRespostaD1, podeSerRespostaD1, ehRepeticaoDaRespostaD1, ultimaFalaFoiAPergunta, RESPOSTA_OFERTA_SOFIA } = await import('./confirmacao-d1.js');
const { prisma } = await import('./prisma.js');
const { recarregarAutomacoes } = await import('./automacoes-estado.js');

function unidade(slug: string): Unit {
  return {
    id: 'u1', slug, name: slug, category: 'saude', systemPrompt: null, personaResponseLength: 'normal', personaLanguage: 'pt-BR',
    personaEmojis: [], handoffKeywords: [], pipelineIntents: null, spineEnabled: true, spineAgendaStart: '08:00', spineAgendaEnd: '18:00',
    spineAgendaDays: [1, 2, 3, 4, 5], spineSlotMinutes: 30,
  } as unknown as Unit;
}

const antes = process.env.REMARCAR_OFERTA_SLUGS;
const restaurar = () => (antes === undefined ? delete process.env.REMARCAR_OFERTA_SLUGS : (process.env.REMARCAR_OFERTA_SLUGS = antes));

test('desligada (padrão): o prompt da Sofia NÃO muda — nenhuma linha da oferta', () => {
  delete process.env.REMARCAR_OFERTA_SLUGS;
  try {
    const p = composeSystemPrompt({ unit: unidade('doutor-hernia-olimpia') });
    assert.doesNotMatch(p, /QUANDO O PACIENTE NÃO VAI CONSEGUIR IR/);
  } finally { restaurar(); }
});

test('SÓ NO PAPEL (gravado na tela): o prompt NÃO muda e o «Preciso remarcar» segue com a resposta pronta de sempre', async () => {
  const delegado = prisma.unitAutomacao as unknown as { findMany: unknown };
  const original = delegado.findMany;
  delegado.findMany = async () => [{ automacao: 'remarcar-oferta', estado: 'seco', unit: { slug: 'doutor-hernia-olimpia' } }];
  try {
    await recarregarAutomacoes(); // pode devolver uma leitura já em andamento (a do banco que não existe)
    await recarregarAutomacoes();
    assert.equal(o.oferecerNovoHorario('doutor-hernia-olimpia'), 'seco');
    assert.doesNotMatch(composeSystemPrompt({ unit: unidade('doutor-hernia-olimpia') }), /QUANDO O PACIENTE NÃO VAI CONSEGUIR IR/);
    const { kommo, chamadas } = kommoFalso();
    const r = await tratarRespostaD1({ unit: U('doutor-hernia-olimpia'), leadId: 1, texto: 'Preciso remarcar', conv: conversa(), kommo });
    assert.equal(r, 'remarcar', 'o paciente não percebe diferença');
    assert.match(chamadas.respostas[0], /pedir para a equipe/);
  } finally {
    delegado.findMany = async () => [];
    await recarregarAutomacoes();
    await recarregarAutomacoes(); // esvazia o mapa (o banco de teste não existe: sem isto o «seco» ficaria valendo para os testes seguintes)
    delegado.findMany = original;
  }
});

test('ligada: o prompt manda oferecer 2 horários da ferramenta, não cancelar nem remarcar antes de ele escolher, e respeitar «não quero mais»', () => {
  process.env.REMARCAR_OFERTA_SLUGS = 'doutor-hernia-olimpia';
  try {
    const p = composeSystemPrompt({ unit: unidade('doutor-hernia-olimpia') });
    assert.match(p, /QUANDO O PACIENTE NÃO VAI CONSEGUIR IR/);
    assert.match(p, /EXATAMENTE 2 horários da lista devolvida/);
    assert.match(p, /NÃO chame cancelar_consulta nem remarcar_consulta nessa resposta/);
    assert.match(p, /depois que ele escolher/);
    assert.match(p, /NÃO QUER MAIS/);
    assert.match(p, /NUNCA outro horário/);
  } finally { restaurar(); }
});

test('CAXIAS e PETRÓPOLIS: o prompt não muda nem com a lista «*»', () => {
  process.env.REMARCAR_OFERTA_SLUGS = '*';
  try {
    for (const slug of ['doutor-hernia-caxias', 'doutor-hernia-petropolis']) {
      assert.doesNotMatch(composeSystemPrompt({ unit: unidade(slug) }), /QUANDO O PACIENTE NÃO VAI CONSEGUIR IR/, slug);
    }
    assert.match(composeSystemPrompt({ unit: unidade('doutor-hernia-olimpia') }), /QUANDO O PACIENTE NÃO VAI CONSEGUIR IR/);
  } finally { restaurar(); }
});

test('a tarefa da equipe diz que a consulta segue marcada e que a Sofia DEVE ter oferecido (não afirma o que não viu)', () => {
  const t = o.textoTarefaRemarcarComOferta({ slug: 'doutor-hernia-olimpia', nome: 'Maria', quando: '2026-11-30T14:30', texto: 'Preciso remarcar' });
  assert.match(t, /consulta de 30\/11 às 14:30/);
  assert.match(t, /deve ter oferecido 2 horários/);
  assert.match(t, /continua marcada/);
});

test('o toque «Preciso remarcar» e «2» são pedido de remarcar (entram no caminho da oferta); «1» e «sim» nunca', () => {
  assert.equal(classificarRespostaD1('Preciso remarcar'), 'remarcar');
  assert.equal(classificarRespostaD1('2'), 'remarcar');
  assert.equal(classificarRespostaD1('não vou conseguir ir'), 'remarcar');
  assert.equal(classificarRespostaD1('1'), 'confirmou');
  assert.equal(classificarRespostaD1('Confirmo'), 'confirmou');
});

// ── o tratador da resposta à pergunta de confirmação (confirmacao-d1.ts) ──────────────────────────────


function kommoFalso() {
  const chamadas = { tarefas: [] as Array<{ text: string; completeAt: number }>, respostas: [] as string[] };
  return {
    chamadas,
    kommo: {
      getLead: async () => ({ id: 1, name: 'Maria' }),
      createTask: async (t: { text: string; completeAt: number }) => { chamadas.tarefas.push(t); },
      sendChatReply: async (r: { text: string }) => { chamadas.respostas.push(r.text); return { via: 'chat' }; },
    } as never,
  };
}
/** Uma consulta de pé: amanhã às 14:30, confirmada pela franquia. */
const amanha = () => new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
const consultaDePe = async () => ({ idSchedule: 9, quando: `${amanha()}T14:30`, salvo: `${amanha()}T14:30`, estado: 'confirmada', mudou: false, especialista: null, idStatus: 37 }) as never;
const consultaQuePassou = async () => ({ idSchedule: 9, quando: '2020-01-01T14:30', salvo: '2020-01-01T14:30', estado: 'confirmada', mudou: false, especialista: null, idStatus: 37 }) as never;
const conversa = () => ({ id: 'c1', contactName: 'Maria', confirmacaoD1EnviadaEm: new Date(Date.now() - 3600_000), confirmacaoD1Resposta: null }) as never;
const U = (slug: string) => ({ ...unidade(slug), spineEnabled: false, spineToken: null }) as unknown as Unit;

test('LIGADA: «Preciso remarcar» NÃO recebe «vou pedir para a equipe» — recebe uma frase de espera e a conversa segue com a Sofia; tarefa de segurança de 1 h', async () => {
  process.env.REMARCAR_OFERTA_SLUGS = 'doutor-hernia-olimpia';
  try {
    const { kommo, chamadas } = kommoFalso();
    const r = await tratarRespostaD1({ unit: U('doutor-hernia-olimpia'), leadId: 1, texto: 'Preciso remarcar', conv: conversa(), kommo, consultaDoLead: consultaDePe });
    assert.equal(r, 'remarcar_sofia');
    assert.equal(chamadas.respostas.length, 1, 'uma frase de espera: se a Sofia estiver calada o paciente não fica no vazio');
    assert.match(chamadas.respostas[0], /ver os horários mais próximos/);
    assert.doesNotMatch(chamadas.respostas[0], /pedir para a equipe/);
    assert.equal(chamadas.tarefas.length, 1);
    assert.match(chamadas.tarefas[0].text, /deve ter oferecido 2 horários/);
    const prazo = chamadas.tarefas[0].completeAt - Math.floor(Date.now() / 1000);
    assert.ok(prazo > 3000 && prazo <= 3600, `prazo ${prazo}s`);
  } finally { restaurar(); }
});

test('DESLIGADA (padrão): tudo como antes — resposta pronta «vou pedir para a equipe» e tarefa de 30 min', async () => {
  delete process.env.REMARCAR_OFERTA_SLUGS;
  try {
    const { kommo, chamadas } = kommoFalso();
    const r = await tratarRespostaD1({ unit: U('doutor-hernia-olimpia'), leadId: 1, texto: '2', conv: conversa(), kommo });
    assert.equal(r, 'remarcar');
    assert.equal(chamadas.respostas.length, 1);
    assert.match(chamadas.respostas[0], /pedir para a equipe/);
    assert.equal(chamadas.tarefas.length, 1);
  } finally { restaurar(); }
});

test('CAXIAS com a lista «*»: segue o caminho de antes (a oferta não liga lá)', async () => {
  process.env.REMARCAR_OFERTA_SLUGS = '*';
  try {
    const { kommo, chamadas } = kommoFalso();
    const r = await tratarRespostaD1({ unit: U('doutor-hernia-caxias'), leadId: 1, texto: 'Preciso remarcar', conv: conversa(), kommo });
    assert.equal(r, 'remarcar');
    assert.equal(chamadas.respostas.length, 1);
  } finally { restaurar(); }
});

test('depois da oferta, «1» ou «2» digitado é ESCOLHA de horário: não é confirmação nem «repetição» engolida — vai para a Sofia', () => {
  const conv = { confirmacaoD1EnviadaEm: new Date(Date.now() - 600_000), confirmacaoD1Resposta: RESPOSTA_OFERTA_SOFIA };
  for (const texto of ['1', '2', 'Confirmo']) {
    assert.equal(podeSerRespostaD1(conv, texto), false, `«${texto}» não pode ser tratado como resposta à véspera`);
    assert.equal(ehRepeticaoDaRespostaD1({ conv, texto, anteriores: [{ content: texto, createdAt: new Date(Date.now() - 300_000) }] }), false, texto);
  }
});

test('«1» depois de a Sofia oferecer horários NÃO é «confirmo»: só vale se a última fala nossa é a pergunta de confirmação', () => {
  const enviada = new Date('2026-11-30T09:00:00Z');
  const depois = new Date('2026-11-30T09:00:05Z');
  assert.equal(ultimaFalaFoiAPergunta(null, enviada), true, 'sem fala nenhuma depois');
  assert.equal(ultimaFalaFoiAPergunta({ createdAt: depois, meta: { origem: 'confirmacao_d0', via: 'chat_botoes' } }, enviada), true, 'a própria pergunta');
  assert.equal(ultimaFalaFoiAPergunta({ createdAt: new Date('2026-11-30T09:20:00Z'), meta: null }, enviada), false, 'a Sofia falou depois (sem origem)');
  assert.equal(ultimaFalaFoiAPergunta({ createdAt: new Date('2026-11-30T09:20:00Z'), meta: { origem: 'remarcar_oferta_espera' } }, enviada), false);
  assert.equal(ultimaFalaFoiAPergunta({ createdAt: new Date('2026-11-29T09:00:00Z'), meta: null }, enviada), true, 'fala antiga, anterior à pergunta');
});

test('LIGADA + a Sofia já falou depois da pergunta: o «1» do paciente vai para ela e NADA é confirmado', async () => {
  process.env.REMARCAR_OFERTA_SLUGS = 'doutor-hernia-olimpia';
  const original = prisma.message.findFirst;
  (prisma.message as unknown as { findFirst: unknown }).findFirst = async () => ({ createdAt: new Date(), meta: null });
  try {
    const { kommo, chamadas } = kommoFalso();
    const r = await tratarRespostaD1({ unit: U('doutor-hernia-olimpia'), leadId: 1, texto: '1', conv: conversa(), kommo, consultaDoLead: consultaDePe });
    assert.equal(r, null);
    assert.equal(chamadas.respostas.length, 0);
    assert.equal(chamadas.tarefas.length, 0);
  } finally {
    (prisma.message as unknown as { findFirst: unknown }).findFirst = original;
    restaurar();
  }
});

// ── revisão do sênior (PR #523) ───────────────────────────────────────────────────────────────────────

function comFindFirst<T>(fn: () => Promise<unknown>, corpo: () => Promise<T>): Promise<T> {
  const original = prisma.message.findFirst;
  (prisma.message as unknown as { findFirst: unknown }).findFirst = fn;
  return corpo().finally(() => { (prisma.message as unknown as { findFirst: unknown }).findFirst = original; });
}

test('a trava do «1» solto vale com SÓ A MANHÃ ligada (sem a oferta): a Sofia falou depois da pergunta → nada é confirmado', async () => {
  delete process.env.REMARCAR_OFERTA_SLUGS;
  process.env.CONFIRMACAO_MANHA_SLUGS = 'doutor-hernia-olimpia';
  try {
    const { kommo, chamadas } = kommoFalso();
    const r = await comFindFirst(async () => ({ createdAt: new Date(), meta: null }), () =>
      tratarRespostaD1({ unit: U('doutor-hernia-olimpia'), leadId: 1, texto: '1', conv: conversa(), kommo, consultaDoLead: consultaDePe }));
    assert.equal(r, null);
    assert.equal(chamadas.respostas.length, 0);
  } finally { delete process.env.CONFIRMACAO_MANHA_SLUGS; restaurar(); }
});

test('FALHA FECHADO: se a leitura da última fala dá erro, NÃO confirma — a mensagem segue com a Sofia', async () => {
  process.env.CONFIRMACAO_MANHA_SLUGS = 'doutor-hernia-olimpia';
  try {
    const { kommo, chamadas } = kommoFalso();
    const r = await comFindFirst(async () => { throw new Error('banco fora'); }, () =>
      tratarRespostaD1({ unit: U('doutor-hernia-olimpia'), leadId: 1, texto: 'sim', conv: conversa(), kommo, consultaDoLead: consultaDePe }));
    assert.equal(r, null);
    assert.equal(chamadas.respostas.length, 0);
    assert.equal(chamadas.tarefas.length, 0);
  } finally { delete process.env.CONFIRMACAO_MANHA_SLUGS; }
});

test('«Confirmo» DIGITADO depois de uma fala da Sofia passa pela trava (o webhook não distingue o toque do botão) e NÃO confirma a consulta antiga', async () => {
  process.env.CONFIRMACAO_MANHA_SLUGS = 'doutor-hernia-olimpia';
  try {
    for (const texto of ['Confirmo', 'confirmado', '1', 'ok']) {
      const { kommo, chamadas } = kommoFalso();
      const r = await comFindFirst(async () => ({ createdAt: new Date(), meta: { origem: 'sofia' } }), () =>
        tratarRespostaD1({ unit: U('doutor-hernia-olimpia'), leadId: 1, texto, conv: conversa(), kommo, consultaDoLead: consultaDePe }));
      assert.equal(r, null, texto);
      assert.equal(chamadas.respostas.length, 0, texto);
    }
    // e se a última fala nossa FOI a pergunta, o mesmo «Confirmo» confirma
    const { kommo } = kommoFalso();
    const r = await comFindFirst(async () => ({ createdAt: new Date(), meta: { origem: 'confirmacao_d0' } }), () =>
      tratarRespostaD1({ unit: U('doutor-hernia-olimpia'), leadId: 1, texto: 'Confirmo', conv: conversa(), kommo, consultaDoLead: consultaDePe }));
    assert.equal(r, 'confirmou');
  } finally { delete process.env.CONFIRMACAO_MANHA_SLUGS; }
});

test('«Preciso remarcar» (palavras) NUNCA fica sem resposta: sem consulta de pé (franquia sem resposta, já passou) segue o main — resposta pronta + tarefa — mesmo com a oferta ligada', async () => {
  process.env.REMARCAR_OFERTA_SLUGS = 'doutor-hernia-olimpia';
  try {
    for (const consultaDoLead of [async () => null, consultaQuePassou]) {
      const { kommo, chamadas } = kommoFalso();
      const r = await comFindFirst(async () => ({ createdAt: new Date(), meta: null }), () =>
        tratarRespostaD1({ unit: U('doutor-hernia-olimpia'), leadId: 1, texto: 'Preciso remarcar', conv: conversa(), kommo, consultaDoLead }));
      assert.equal(r, 'remarcar');
      assert.match(chamadas.respostas[0], /pedir para a equipe/);
      assert.equal(chamadas.tarefas.length, 1);
    }
  } finally { restaurar(); }
});

test('«2» solto depois de a Sofia oferecer horários é ESCOLHA: não vira «vou pedir para a equipe»', async () => {
  process.env.REMARCAR_OFERTA_SLUGS = 'doutor-hernia-olimpia';
  try {
    const { kommo, chamadas } = kommoFalso();
    const r = await comFindFirst(async () => ({ createdAt: new Date(), meta: null }), () =>
      tratarRespostaD1({ unit: U('doutor-hernia-olimpia'), leadId: 1, texto: '2', conv: conversa(), kommo, consultaDoLead: consultaDePe }));
    assert.equal(r, null);
    assert.equal(chamadas.respostas.length + chamadas.tarefas.length, 0);
  } finally { restaurar(); }
});

test('REENTREGA do Kommo do mesmo «Preciso remarcar» com a conversa em oferta_sofia: não gera 2ª oferta; «1»/«2» e texto novo seguem para a Sofia', () => {
  const conv = { confirmacaoD1EnviadaEm: new Date(Date.now() - 600_000), confirmacaoD1Resposta: RESPOSTA_OFERTA_SOFIA };
  const antes = [{ content: 'Preciso remarcar', createdAt: new Date(Date.now() - 120_000) }];
  assert.equal(ehRepeticaoDaRespostaD1({ conv, texto: 'Preciso remarcar', anteriores: antes }), true);
  assert.equal(ehRepeticaoDaRespostaD1({ conv, texto: 'preciso remarcar!', anteriores: antes }), true);
  assert.equal(ehRepeticaoDaRespostaD1({ conv, texto: 'Preciso remarcar', anteriores: [] }), false, 'sem o pedido anterior não é repetição');
  assert.equal(ehRepeticaoDaRespostaD1({ conv, texto: '2', anteriores: [{ content: '2', createdAt: new Date(Date.now() - 120_000) }] }), false, 'escolha de horário');
  assert.equal(ehRepeticaoDaRespostaD1({ conv, texto: 'quinta às 14h', anteriores: antes }), false);
});

test('«consigo»: SEM chave segue indo para a Sofia (idêntico ao main); com as faltas ligadas confirma', async () => {
  assert.equal(classificarRespostaD1('Consigo sim'), null);
  assert.equal(classificarRespostaD1('consigo vir', false), null);
  assert.equal(podeSerRespostaD1({ confirmacaoD1EnviadaEm: new Date(Date.now() - 60_000), confirmacaoD1Resposta: null }, 'consigo sim'), false);
  assert.equal(podeSerRespostaD1({ confirmacaoD1EnviadaEm: new Date(Date.now() - 60_000), confirmacaoD1Resposta: null }, 'consigo sim', undefined, undefined, true), true);
  const { kommo, chamadas } = kommoFalso();
  assert.equal(await tratarRespostaD1({ unit: U('doutor-hernia-olimpia'), leadId: 1, texto: 'Consigo sim', conv: conversa(), kommo, consultaDoLead: consultaDePe }), null, 'chaves desligadas');
  assert.equal(chamadas.respostas.length, 0);
});

test('faltas ligadas: resposta SEM consulta futura confirmada (já passou, franquia fora) nunca vira CONFIRMADO; com tudo desligado, como sempre', async () => {
  process.env.CONFIRMACAO_MANHA_SLUGS = 'doutor-hernia-olimpia';
  try {
    const { kommo, chamadas } = kommoFalso();
    const r = await comFindFirst(async () => null, () =>
      tratarRespostaD1({ unit: U('doutor-hernia-olimpia'), leadId: 1, texto: 'ok', conv: conversa(), kommo, consultaDoLead: consultaQuePassou }));
    assert.equal(r, null, 'consulta que já passou = conversa solta, nunca CONFIRMADO numa falta');
    assert.equal(chamadas.respostas.length, 0);
    const semFranquia = await comFindFirst(async () => null, () =>
      tratarRespostaD1({ unit: U('doutor-hernia-olimpia'), leadId: 1, texto: 'ok', conv: conversa(), kommo, consultaDoLead: async () => null }));
    assert.equal(semFranquia, null, 'franquia sem resposta: fecha, não confirma');
    const dePe = await comFindFirst(async () => null, () =>
      tratarRespostaD1({ unit: U('doutor-hernia-olimpia'), leadId: 1, texto: 'ok', conv: conversa(), kommo, consultaDoLead: consultaDePe }));
    assert.equal(dePe, 'confirmou', 'consulta de pé e a pergunta foi a última fala: confirma');
  } finally { delete process.env.CONFIRMACAO_MANHA_SLUGS; }
  const { kommo, chamadas } = kommoFalso();
  const r = await tratarRespostaD1({ unit: U('doutor-hernia-olimpia'), leadId: 1, texto: 'ok', conv: conversa(), kommo });
  assert.equal(r, 'confirmou', 'desligadas: idêntico ao de antes');
  assert.match(chamadas.respostas[0], /Confirmado/);
});

test('a frase de espera falhou: a tarefa de segurança de 1 h abre mesmo assim', async () => {
  process.env.REMARCAR_OFERTA_SLUGS = 'doutor-hernia-olimpia';
  try {
    const { kommo, chamadas } = kommoFalso();
    (kommo as unknown as { sendChatReply: unknown }).sendChatReply = async () => { throw new Error('Kommo fora'); };
    const r = await tratarRespostaD1({ unit: U('doutor-hernia-olimpia'), leadId: 1, texto: 'Preciso remarcar', conv: conversa(), kommo, consultaDoLead: consultaDePe });
    assert.equal(r, 'remarcar_sofia');
    assert.equal(chamadas.tarefas.length, 1);
  } finally { restaurar(); }
});

test('com as faltas ligadas: «Consigo sim» confirma; «não consigo» remarca; pergunta não é confirmação', () => {
  for (const t of ['Consigo sim', 'consigo', 'Consigo vir', 'consigo vir sim!']) assert.equal(classificarRespostaD1(t, true), 'confirmou', t);
  assert.equal(classificarRespostaD1('não consigo ir', true), 'remarcar');
  assert.equal(classificarRespostaD1('consigo chegar às 15h30?', true), null);
});
