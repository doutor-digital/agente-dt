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

test('só no papel: o prompt também NÃO muda (seco não mexe no que o paciente recebe)', () => {
  // em seco o ambiente não liga: o estado «seco» vem da tela; sem linha na tela e sem lista, vale desligado
  assert.equal(o.oferecerNovoHorario('doutor-hernia-olimpia', {} as NodeJS.ProcessEnv), 'desligado');
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

const { tratarRespostaD1, podeSerRespostaD1, ehRepeticaoDaRespostaD1, RESPOSTA_OFERTA_SOFIA } = await import('./confirmacao-d1.js');

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
const conversa = () => ({ id: 'c1', contactName: 'Maria', confirmacaoD1EnviadaEm: new Date(Date.now() - 3600_000), confirmacaoD1Resposta: null }) as never;
const U = (slug: string) => ({ ...unidade(slug), spineEnabled: false, spineToken: null }) as unknown as Unit;

test('LIGADA: «Preciso remarcar» não recebe a resposta pronta — vai para a Sofia, com a tarefa de segurança de 1 h', async () => {
  process.env.REMARCAR_OFERTA_SLUGS = 'doutor-hernia-olimpia';
  try {
    const { kommo, chamadas } = kommoFalso();
    const r = await tratarRespostaD1({ unit: U('doutor-hernia-olimpia'), leadId: 1, texto: 'Preciso remarcar', conv: conversa(), kommo });
    assert.equal(r, 'remarcar_sofia');
    assert.equal(chamadas.respostas.length, 0, 'nenhuma resposta pronta: quem responde é a Sofia');
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
  for (const texto of ['1', '2', 'Confirmo', 'Preciso remarcar']) {
    assert.equal(podeSerRespostaD1(conv, texto), false, `«${texto}» não pode ser tratado como resposta à véspera`);
    assert.equal(ehRepeticaoDaRespostaD1({ conv, texto, anteriores: [{ content: texto, createdAt: new Date(Date.now() - 300_000) }] }), false, texto);
  }
});
