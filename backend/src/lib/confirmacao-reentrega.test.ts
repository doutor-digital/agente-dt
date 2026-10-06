import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ehRepeticaoDaRespostaD1,
  JANELA_REPETICAO_D1_MS,
  JANELA_RESPOSTA_D1_MS,
  podeSerRespostaD1,
} from './confirmacao-d1.js';

/**
 * Açailândia, 06/10/2026, lead 28088906: "1" às 10:43 tratado em código; às ~11:05 a mesma
 * mensagem voltou (reentrega do webhook do Kommo) e caiu na IA, que respondeu "Não entendi…".
 */

const PERGUNTA = new Date('2026-10-06T13:43:32Z');
const UM = new Date('2026-10-06T13:43:50Z');
const REENVIO = new Date('2026-10-06T14:05:00Z');

const confirmada = { confirmacaoD1EnviadaEm: PERGUNTA, confirmacaoD1Resposta: 'confirmou' };

// ── defesa 2: repetição exata da resposta já tratada não vai para a IA ───────────────────────

test('repetição: o mesmo "1" reentregue 21 min depois é repetição', () => {
  assert.equal(
    ehRepeticaoDaRespostaD1({ conv: confirmada, texto: '1', anteriores: [{ content: '1', createdAt: UM }], agora: REENVIO }),
    true,
  );
});

test('repetição: tolera caixa, espaço e pontuação final ("Confirmo!" × "confirmo")', () => {
  assert.equal(
    ehRepeticaoDaRespostaD1({
      conv: confirmada,
      texto: ' Confirmo! ',
      anteriores: [{ content: 'confirmo', createdAt: UM }],
      agora: REENVIO,
    }),
    true,
  );
});

test('repetição: pergunta nova depois de confirmar segue para a IA', () => {
  for (const texto of ['qual o endereço?', '1, mas posso chegar 13h30?', 'obrigado', 'ok']) {
    assert.equal(
      ehRepeticaoDaRespostaD1({ conv: confirmada, texto, anteriores: [{ content: '1', createdAt: UM }], agora: REENVIO }),
      false,
      texto,
    );
  }
});

test('repetição: "2" depois de ter confirmado NÃO é repetição (mudou de ideia → IA/equipe)', () => {
  assert.equal(
    ehRepeticaoDaRespostaD1({ conv: confirmada, texto: '2', anteriores: [{ content: '1', createdAt: UM }, { content: '2', createdAt: UM }], agora: REENVIO }),
    false,
  );
});

test('repetição: sem mensagem anterior igual não é repetição (não engole a primeira)', () => {
  assert.equal(ehRepeticaoDaRespostaD1({ conv: confirmada, texto: '1', anteriores: [], agora: REENVIO }), false);
  assert.equal(
    ehRepeticaoDaRespostaD1({ conv: confirmada, texto: '1', anteriores: [{ content: 'oi', createdAt: UM }], agora: REENVIO }),
    false,
  );
});

test('repetição: "1" anterior à pergunta (de outra conversa) não conta', () => {
  const antes = new Date(PERGUNTA.getTime() - 60_000);
  assert.equal(
    ehRepeticaoDaRespostaD1({ conv: confirmada, texto: '1', anteriores: [{ content: '1', createdAt: antes }], agora: REENVIO }),
    false,
  );
});

test('repetição: passada a janela, o "1" volta a ir para a IA', () => {
  const tarde = new Date(UM.getTime() + JANELA_REPETICAO_D1_MS + 60_000);
  assert.equal(
    ehRepeticaoDaRespostaD1({ conv: confirmada, texto: '1', anteriores: [{ content: '1', createdAt: UM }], agora: tarde }),
    false,
  );
});

test('repetição: véspera ainda não respondida, ou "sem_janela", nunca é repetição', () => {
  for (const r of [null, 'sem_janela']) {
    assert.equal(
      ehRepeticaoDaRespostaD1({
        conv: { confirmacaoD1EnviadaEm: PERGUNTA, confirmacaoD1Resposta: r },
        texto: '1',
        anteriores: [{ content: '1', createdAt: UM }],
        agora: REENVIO,
      }),
      false,
      String(r),
    );
  }
});

test('repetição: "2" repetido depois de pedir remarcação também é repetição', () => {
  assert.equal(
    ehRepeticaoDaRespostaD1({
      conv: { confirmacaoD1EnviadaEm: PERGUNTA, confirmacaoD1Resposta: 'remarcar' },
      texto: '2',
      anteriores: [{ content: '2', createdAt: UM }],
      agora: REENVIO,
    }),
    true,
  );
});

// ── defesa 1: o webhook sabe, sem I/O, quando responder 200 antes do trabalho pesado ─────────

test('responder cedo: "1" logo depois da pergunta → sim', () => {
  assert.equal(podeSerRespostaD1({ confirmacaoD1EnviadaEm: PERGUNTA, confirmacaoD1Resposta: null }, '1', UM), true);
});

test('responder cedo: reentrega do "1" já confirmado → sim (vai virar "repetida")', () => {
  assert.equal(podeSerRespostaD1(confirmada, '1', REENVIO), true);
});

test('responder cedo: texto que não é resposta à véspera → não (segue o caminho normal)', () => {
  assert.equal(podeSerRespostaD1({ confirmacaoD1EnviadaEm: PERGUNTA, confirmacaoD1Resposta: null }, 'qual o endereço?', UM), false);
  assert.equal(podeSerRespostaD1(confirmada, '2', REENVIO), false);
  assert.equal(podeSerRespostaD1({ confirmacaoD1EnviadaEm: null, confirmacaoD1Resposta: null }, '1', UM), false);
});

test('responder cedo: fora da janela de resposta → não', () => {
  const tarde = new Date(PERGUNTA.getTime() + JANELA_RESPOSTA_D1_MS + 60_000);
  assert.equal(podeSerRespostaD1({ confirmacaoD1EnviadaEm: PERGUNTA, confirmacaoD1Resposta: null }, '1', tarde), false);
});
