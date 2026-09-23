import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chaveDaConfirmacao } from './reminder-worker.js';

/**
 * A chave do dedupe é o que impede a Sofia de perguntar duas vezes pela mesma consulta — e o que
 * garante que ela pergunte de novo quando o horário muda. O caso que motivou: Luciana, Serra,
 * 23/09/2026, recebeu a pergunta de véspera às 14h11 e outra vez às 18h59.
 */

test('a mesma consulta dá sempre a mesma chave', () => {
  const a = chaveDaConfirmacao('d1', '2026-09-24T11:00:00');
  const b = chaveDaConfirmacao('d1', '2026-09-24T11:00:00');
  assert.equal(a, b);
  assert.equal(a, 'confirmacao_d1:2026-09-24T11:00');
});

test('remarcou o dia: chave nova, então a pergunta volta a sair', () => {
  // Antes isso ficava preso na janela de 36 h da pergunta antiga e o paciente do horário
  // novo não recebia confirmação nenhuma.
  const antes = chaveDaConfirmacao('d1', '2026-09-24T11:00:00');
  const depois = chaveDaConfirmacao('d1', '2026-09-25T11:00:00');
  assert.notEqual(antes, depois);
});

test('remarcou só a hora, no mesmo dia: também é consulta outra', () => {
  const dez = chaveDaConfirmacao('d1', '2026-09-24T10:00:00');
  const quinze = chaveDaConfirmacao('d1', '2026-09-24T15:00:00');
  assert.notEqual(dez, quinze);
});

test('os dois toques da mesma consulta não se confundem', () => {
  // O reforço de D-2 e a véspera falam da mesma consulta e precisam de marcas separadas:
  // responder ao D-2 não pode apagar a véspera, nem o contrário.
  const d1 = chaveDaConfirmacao('d1', '2026-09-24T11:00:00');
  const d2 = chaveDaConfirmacao('d2', '2026-09-24T11:00:00');
  assert.notEqual(d1, d2);
  assert.match(d1, /^confirmacao_d1:/);
  assert.match(d2, /^reforco_d2:/);
});

test('segundos a mais não viram consulta diferente', () => {
  // O `quando` guardado é "AAAA-MM-DDTHH:mm" (schema.prisma), mas a franquia às vezes devolve
  // com segundos. Se isso mudasse a chave, a pergunta sairia de novo por causa de formatação.
  assert.equal(
    chaveDaConfirmacao('d1', '2026-09-24T11:00:00'),
    chaveDaConfirmacao('d1', '2026-09-24T11:00'),
  );
});

test('a chave é o horário LOCAL da clínica, do jeito que a agenda guarda', () => {
  // Fuso na string produziria chave diferente para o mesmo instante. Não acontece porque o
  // `quando` nasce de dia+hora locais (agenda-reconcile), e este teste é o lembrete disso:
  // quem passar um ISO com Z aqui está passando o valor errado.
  const daAgenda = chaveDaConfirmacao('d1', '2026-09-24T11:00');
  assert.equal(daAgenda, 'confirmacao_d1:2026-09-24T11:00');
  assert.notEqual(daAgenda, chaveDaConfirmacao('d1', '2026-09-24T14:00:00Z'));
});
