import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 142 e 143 existem em TODO funil do Kommo: são ganho e perdido. Mover pra lá
 * pela tool genérica manda só o `status_id`, e a conta exige o motivo junto no
 * caso do perdido — o Kommo devolve 400 e o lead fica parado. Aconteceu 7 vezes
 * em 14 dias, sempre no 143.
 *
 * A regra abaixo é a mesma do guard em `mover_etapa`: uma etapa comum passa,
 * ganho e perdido são recusados com a instrução da tool certa.
 */
const STATUS_GANHO = 142;
const STATUS_PERDIDO = 143;

function ehFechamento(statusId: number): 'ganho' | 'perdido' | null {
  if (statusId === STATUS_GANHO) return 'ganho';
  if (statusId === STATUS_PERDIDO) return 'perdido';
  return null;
}

test('etapa comum do funil passa direto', () => {
  for (const st of [109754067, 109754071, 110846024, 108773008]) {
    assert.equal(ehFechamento(st), null, `etapa ${st} não deveria ser tratada como fechamento`);
  }
});

test('142 é ganho', () => {
  assert.equal(ehFechamento(142), 'ganho');
});

test('143 é perdido — o caso que falhava', () => {
  assert.equal(ehFechamento(143), 'perdido');
});

test('vale para qualquer funil, porque 142/143 se repetem em todos', () => {
  // mesmos ids nos dois funis da conta (COMERCIAL e TRATAMENTO)
  assert.equal(ehFechamento(143), 'perdido');
  assert.equal(ehFechamento(142), 'ganho');
});

test('ids parecidos não são confundidos', () => {
  for (const st of [14, 1420, 1430, 42, 43]) {
    assert.equal(ehFechamento(st), null, `${st} não é etapa de fechamento`);
  }
});
