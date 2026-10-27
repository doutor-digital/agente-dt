import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { julgarConversa, judgeConversation, parseJudgeOutput, type DependenciasDoJuiz, type RespostaDoModelo } from './conversation-judge.service.js';

const unit = { id: 'u1', slug: 'teste', systemPrompt: 'prompt', anthropicApiKey: 'sk-ant-x' } as unknown as Unit;

const BOA = JSON.stringify({ scores: { clareza: 8, empatia: 8, objecoes: 6, cta: 9, tom: 7 }, verdict: 'Conduziu bem.' });

const CONVERSA_BOA = [
  { role: 'user', content: 'Oi, quanto custa a consulta?' },
  { role: 'assistant', content: 'Oi! Me conta onde dói?' },
  { role: 'user', content: 'Na lombar, há meses' },
  { role: 'assistant', content: 'Entendi. Temos horário quinta.' },
];

interface Espiao {
  deps: DependenciasDoJuiz;
  gravadas: unknown[];
  chamadas: Array<{ provedor: string; modelo: string }>;
  registros: Array<Record<string, unknown>>;
}

function falso(opcoes: { mensagens?: Array<{ role: string; content: string }> | null; resposta?: RespostaDoModelo | Error; existe?: boolean }): Espiao {
  const e: Espiao = { gravadas: [], chamadas: [], registros: [], deps: null as unknown as DependenciasDoJuiz };
  e.deps = {
    avaliacaoExiste: async () => opcoes.existe ?? false,
    carregarMensagens: async () => (opcoes.mensagens === undefined ? CONVERSA_BOA : opcoes.mensagens),
    chamarModelo: async (escolha) => {
      e.chamadas.push({ provedor: escolha.provedor, modelo: escolha.modelo });
      const r = opcoes.resposta ?? { text: BOA, promptTokens: 3000, completionTokens: 200, raw: {} };
      if (r instanceof Error) throw r;
      return r;
    },
    gravarAvaliacao: async (data) => void e.gravadas.push(data),
    registrarChamada: (p) => void e.registros.push(p as unknown as Record<string, unknown>),
  };
  return e;
}

const SALVO: Record<string, string | undefined> = {};
const CHAVES = ['JUDGE_PROVIDER', 'JUDGE_MODEL', 'JUDGE_SO_AVALIAVEIS', 'JUDGE_MIN_PATIENT_MSGS', 'ANTHROPIC_API_KEY'];
beforeEach(() => {
  for (const k of CHAVES) { SALVO[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of CHAVES) { if (SALVO[k] === undefined) delete process.env[k]; else process.env[k] = SALVO[k]; }
});

// ── padrão: igual a hoje ─────────────────────────────────────────────────────────────────────────

test('padrão (sem chaves): openai gpt-4o-mini, grava a avaliação, sem provider no llm_calls', async () => {
  const e = falso({});
  const r = await julgarConversa({ conversationId: 'c1', unit }, e.deps);
  assert.equal(r.status, 'avaliada');
  assert.deepEqual(e.chamadas, [{ provedor: 'openai', modelo: 'gpt-4o-mini' }]);
  assert.equal(e.gravadas.length, 1);
  const g = e.gravadas[0] as { model: string; overallScore: number; verdict: string };
  assert.equal(g.model, 'gpt-4o-mini');
  assert.equal(g.overallScore, 7.6);
  assert.ok(!('provider' in e.registros[0]));
});

test('padrão: o JSON quebrado do openai continua virando nota 0 + "(sem veredito)" (comportamento de hoje, fora do escopo)', async () => {
  const e = falso({ resposta: { text: 'isto não é json', promptTokens: 10, completionTokens: 5, raw: {} } });
  const r = await julgarConversa({ conversationId: 'c1', unit }, e.deps);
  assert.equal(r.status, 'avaliada');
  const g = e.gravadas[0] as { overallScore: number; verdict: string };
  assert.equal(g.overallScore, 0);
  assert.equal(g.verdict, '(sem veredito)');
  assert.deepEqual(parseJudgeOutput('x').scores, { clareza: 0, empatia: 0, objecoes: 0, cta: 0, tom: 0 });
});

test('padrão: o pré-filtro está DESLIGADO — conversa sem fala do paciente ainda é julgada como hoje', async () => {
  const e = falso({ mensagens: [{ role: 'user', content: 'oi' }, { role: 'user', content: 'oi?' }, { role: 'user', content: 'alô' }, { role: 'user', content: 'ei' }] });
  const r = await julgarConversa({ conversationId: 'c1', unit }, e.deps);
  assert.equal(r.status, 'avaliada');
  assert.equal(e.chamadas.length, 1);
});

test('avaliação já existente: pula sem chamar o modelo', async () => {
  const e = falso({ existe: true });
  assert.equal((await julgarConversa({ conversationId: 'c1', unit }, e.deps)).status, 'ja_existe');
  assert.equal(e.chamadas.length, 0);
});

// ── anthropic ────────────────────────────────────────────────────────────────────────────────────

test('JUDGE_PROVIDER=anthropic: Haiku 5.5, grava o modelo e identifica o provedor no llm_calls', async () => {
  process.env.JUDGE_PROVIDER = 'anthropic';
  const e = falso({ resposta: { text: BOA, promptTokens: 3000, completionTokens: 200, stopReason: 'end_turn', raw: {} } });
  const r = await julgarConversa({ conversationId: 'c1', unit }, e.deps);
  assert.equal(r.status, 'avaliada');
  assert.deepEqual(e.chamadas, [{ provedor: 'anthropic', modelo: 'claude-haiku-5-5' }]);
  const g = e.gravadas[0] as { model: string; costUsd: { toString(): string } };
  assert.equal(g.model, 'claude-haiku-5-5');
  assert.equal(Number(g.costUsd.toString()), 0.0004); // 3000×0,10/1M + 200×0,50/1M
  assert.equal(e.registros[0].provider, 'anthropic');
});

test('anthropic sem chave: cai para openai (gpt-4o-mini) e segue julgando', async () => {
  process.env.JUDGE_PROVIDER = 'anthropic';
  const semChave = { ...unit, anthropicApiKey: null } as unknown as Unit;
  const e = falso({});
  const r = await julgarConversa({ conversationId: 'c1', unit: semChave }, e.deps);
  assert.equal(r.status, 'avaliada');
  assert.deepEqual(e.chamadas, [{ provedor: 'openai', modelo: 'gpt-4o-mini' }]);
});

test('anthropic + JSON quebrado: NÃO grava nota 0; registra erro; a próxima rodada tenta de novo', async () => {
  process.env.JUDGE_PROVIDER = 'anthropic';
  for (const text of ['isto não é json', '{"scores":{"clareza":8', '{}', JSON.stringify({ scores: { clareza: 8 }, verdict: 'x' })]) {
    const e = falso({ resposta: { text, promptTokens: 3000, completionTokens: 50, stopReason: 'end_turn', raw: {} } });
    const r = await julgarConversa({ conversationId: 'c1', unit }, e.deps);
    assert.deepEqual(r, { status: 'erro', motivo: 'resposta_invalida' }, text);
    assert.equal(e.gravadas.length, 0, `não podia gravar para: ${text}`);
    assert.equal(e.registros.length, 1);
    assert.equal(e.registros[0].status, 'error');
    assert.equal(e.registros[0].errorMessage, 'resposta_invalida');
    assert.equal(e.registros[0].promptTokens, 3000); // o gasto aparece mesmo na falha
  }
});

test('anthropic + recusa ou corte (stop_reason): não grava, mesmo que o texto pareça JSON', async () => {
  process.env.JUDGE_PROVIDER = 'anthropic';
  for (const stopReason of ['refusal', 'max_tokens']) {
    const e = falso({ resposta: { text: BOA, promptTokens: 1, completionTokens: 1, stopReason, raw: {} } });
    assert.deepEqual(await julgarConversa({ conversationId: 'c1', unit }, e.deps), { status: 'erro', motivo: 'resposta_invalida' });
    assert.equal(e.gravadas.length, 0);
  }
});

test('anthropic + erro de rede/API: não grava, registra erro', async () => {
  process.env.JUDGE_PROVIDER = 'anthropic';
  const e = falso({ resposta: new Error('529 overloaded') });
  assert.deepEqual(await julgarConversa({ conversationId: 'c1', unit }, e.deps), { status: 'erro', motivo: 'falha_na_chamada' });
  assert.equal(e.gravadas.length, 0);
  assert.equal(e.registros[0].errorMessage, '529 overloaded');
  assert.equal(e.registros[0].provider, 'anthropic');
});

test('judgeConversation (assinatura antiga) devolve null no erro e o resultado no sucesso', async () => {
  process.env.JUDGE_PROVIDER = 'anthropic';
  const ruim = falso({ resposta: { text: 'x', promptTokens: 0, completionTokens: 0, raw: {} } });
  assert.equal(await judgeConversation({ conversationId: 'c1', unit }, ruim.deps), null);
  const boa = falso({});
  const r = await judgeConversation({ conversationId: 'c1', unit }, boa.deps);
  assert.equal(r?.overallScore, 7.6);
});

// ── pré-filtro ───────────────────────────────────────────────────────────────────────────────────

test('JUDGE_SO_AVALIAVEIS=1: conversa sem fala do paciente não chama o modelo e não grava nada', async () => {
  process.env.JUDGE_SO_AVALIAVEIS = '1';
  const e = falso({ mensagens: [{ role: 'user', content: 'oi' }, { role: 'user', content: 'oi?' }, { role: 'user', content: 'alô' }, { role: 'user', content: 'ei' }] });
  const r = await julgarConversa({ conversationId: 'c1', unit }, e.deps);
  assert.deepEqual(r, { status: 'nao_avaliavel', motivo: 'ia_nao_falou' });
  assert.equal(e.chamadas.length, 0);
  assert.equal(e.gravadas.length, 0);
  assert.equal(e.registros.length, 0);
  assert.equal(await judgeConversation({ conversationId: 'c1', unit }, e.deps), null);
});

test('JUDGE_SO_AVALIAVEIS=1: conversa boa é julgada normalmente; JUDGE_MIN_PATIENT_MSGS ajusta o mínimo', async () => {
  process.env.JUDGE_SO_AVALIAVEIS = '1';
  assert.equal((await julgarConversa({ conversationId: 'c1', unit }, falso({}).deps)).status, 'avaliada');
  process.env.JUDGE_MIN_PATIENT_MSGS = '3';
  assert.deepEqual(await julgarConversa({ conversationId: 'c1', unit }, falso({}).deps), { status: 'nao_avaliavel', motivo: 'paciente_falou_pouco' });
});
