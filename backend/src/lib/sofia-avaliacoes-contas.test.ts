/**
 * 👍/👎 por clínica: a conversa 5 da conta 1 e a conversa 5 da conta 2 são conversas DIFERENTES. Toda leitura por conversa leva a unidade.
 * Um banco de mentira (só em memória) que obedece ao `where` — se alguém tirar o `unitSlug` do filtro, a mistura aparece aqui.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { prisma } = await import('./prisma.js');
const A = await import('./sofia-avaliacoes.js');

type Linha = Record<string, unknown>;
const casa = (l: Linha, where: Record<string, unknown> = {}): boolean =>
  Object.entries(where).every(([k, v]) => (v && typeof v === 'object' && 'in' in (v as object) ? ((v as { in: unknown[] }).in).includes(l[k]) : l[k] === v));
function delegado(linhas: Linha[]) {
  return {
    findMany: async (o: { where?: Record<string, unknown>; take?: number }) => linhas.filter((l) => casa(l, o.where)).sort((a, b) => Number(b.messageId ?? 0) - Number(a.messageId ?? 0)).slice(0, o.take ?? 1e9),
    findFirst: async (o: { where?: Record<string, unknown> }) => linhas.filter((l) => casa(l, o.where)).sort((a, b) => Number(b.messageId ?? 0) - Number(a.messageId ?? 0))[0] ?? null,
    findUnique: async (o: { where: { messageId: number } }) => linhas.find((l) => l.messageId === o.where.messageId) ?? null,
  };
}
const original = { m: Object.getOwnPropertyDescriptor(prisma, 'sofiaMensagem'), a: Object.getOwnPropertyDescriptor(prisma, 'sofiaAvaliacao') };
function bancos(mensagens: Linha[], avaliacoes: Linha[]) {
  Object.defineProperty(prisma, 'sofiaMensagem', { value: delegado(mensagens), configurable: true });
  Object.defineProperty(prisma, 'sofiaAvaliacao', { value: delegado(avaliacoes), configurable: true });
}
afterEach(() => {
  for (const [k, d] of [['sofiaMensagem', original.m], ['sofiaAvaliacao', original.a]] as const) {
    if (d) Object.defineProperty(prisma, k, d);
    else delete (prisma as unknown as Record<string, unknown>)[k];
  }
});

const PARAU = 'doutor-hernia-parauapebas';
const DEMO = 'clinica-demonstracao';
// a conversa 5 existe nas duas contas; os ids de mensagem são globais da instalação
const MENSAGENS = [
  { messageId: 100, conversa: 5, unitSlug: PARAU },
  { messageId: 200, conversa: 5, unitSlug: DEMO },
  { messageId: 201, conversa: 5, unitSlug: DEMO },
];
const AVALIACOES = [
  { messageId: 100, conversa: 5, unitSlug: PARAU, nota: 'boa', quemId: 7, quemNome: 'Ana', criadoEm: new Date(1) },
  { messageId: 200, conversa: 5, unitSlug: DEMO, nota: 'ruim', quemId: 8, quemNome: 'Bia', criadoEm: new Date(2) },
  { messageId: null, conversa: 5, unitSlug: DEMO, nota: 'ruim', quemId: 8, quemNome: 'Bia', revisadaEm: null, id: 'x', texto: 'errou', criadoEm: new Date(3) },
];

test('os balões da conversa 5 de cada clínica mostram só as respostas DELA', async () => {
  bancos(MENSAGENS, AVALIACOES);
  assert.deepEqual((await A.respostasDaSofiaNaConversa(PARAU, 5, 7)).map((r) => r.id), [100]);
  assert.deepEqual((await A.respostasDaSofiaNaConversa(DEMO, 5, 8)).map((r) => r.id), [201, 200]);
  // o 👍 de Parauapebas não aparece como «minha» na outra, nem a 👎 da demo como «ruimPor» em Parauapebas
  assert.equal((await A.respostasDaSofiaNaConversa(PARAU, 5, 7))[0]!.ruimPor, null);
  assert.equal((await A.respostasDaSofiaNaConversa(DEMO, 5, 9)).find((r) => r.id === 200)!.ruimPor, 'Bia');
});

test('«a última resposta da Sofia» na conversa 5 é a da clínica certa', async () => {
  bancos(MENSAGENS, AVALIACOES);
  assert.equal(await A.ultimaRespostaDaSofia(PARAU, 5), 100);
  assert.equal(await A.ultimaRespostaDaSofia(DEMO, 5), 201);
  assert.equal(await A.ultimaRespostaDaSofia('outra-clinica', 5), null);
});

test('avaliar uma mensagem de OUTRA clínica, mesmo com o número da conversa igual, é recusado', async () => {
  bancos(MENSAGENS, AVALIACOES);
  assert.deepEqual(await A.respostaDaSofia(100, 5, PARAU), { unitSlug: PARAU });
  assert.equal(await A.respostaDaSofia(100, 5, DEMO), null, 'a 100 é de Parauapebas');
  assert.equal(await A.respostaDaSofia(200, 5, PARAU), null, 'a 200 é da demo');
  assert.equal(await A.respostaDaSofia(100, 6, PARAU), null, 'conversa errada continua recusada');
});

test('a 👎 aberta «sem mensagem» da conversa 5 não é emprestada para a outra clínica', async () => {
  bancos(MENSAGENS, AVALIACOES);
  assert.equal(await A.minhaRuimSemMensagem(PARAU, 5, 8), null);
  assert.equal((await A.minhaRuimSemMensagem(DEMO, 5, 8))?.id, 'x');
});
