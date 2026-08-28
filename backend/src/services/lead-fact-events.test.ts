import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diferenca, prepararEvidencia } from './lead-fact-events.js';

/**
 * O histórico de fatos só vale se for enxuto. O updater de memória roda a cada
 * poucos turnos, e a maior parte deles não muda nada — se cada passada gravasse
 * linha, a tabela viraria lixo e ninguém iria olhar.
 *
 * Então quase todo teste aqui é sobre o que NÃO deve virar evento.
 */

const CHEIO = {
  queixa: 'Dor lombar há 3 dias',
  qualificacao: 'Quente',
  cidade: 'Boa Vista',
};

test('primeira vez que um fato aparece vira evento, sem anterior', () => {
  const d = diferenca({}, { qualificacao: 'Quente' });
  assert.equal(d.length, 1);
  assert.equal(d[0].chave, 'qualificacao');
  assert.equal(d[0].valor, 'Quente');
  assert.equal(d[0].valorAnterior, null);
});

test('mudança guarda o valor que estava antes — é o ponto da coisa', () => {
  const d = diferenca({ qualificacao: 'Frio' }, { qualificacao: 'Quente' });
  assert.deepEqual(d, [{ chave: 'qualificacao', valor: 'Quente', valorAnterior: 'Frio' }]);
});

test('rodar de novo sem mudança não grava nada', () => {
  assert.equal(diferenca(CHEIO, { ...CHEIO }).length, 0);
});

test('só o que mudou entra, o resto fica de fora', () => {
  const d = diferenca(CHEIO, { ...CHEIO, qualificacao: 'Morno' });
  assert.equal(d.length, 1);
  assert.equal(d[0].chave, 'qualificacao');
});

test('espaço e quebra de linha não contam como mudança', () => {
  // O LLM reescreve o mesmo valor com espaçamento diferente o tempo todo.
  const d = diferenca({ queixa: 'Dor lombar há 3 dias' }, { queixa: '  Dor lombar   há 3 dias  ' });
  assert.equal(d.length, 0);
});

test('chave que sumiu NÃO vira evento', () => {
  // O prompt manda a IA "remover chaves obsoletas": sumiço é faxina dela, não
  // o paciente desdizendo. Registrar isso encheria o histórico de ruído.
  assert.equal(diferenca(CHEIO, { queixa: CHEIO.queixa }).length, 0);
});

test('valor vazio não apaga histórico nem vira evento', () => {
  assert.equal(diferenca({ qualificacao: 'Quente' }, { qualificacao: '' }).length, 0);
});

test('ultimo_contato é ignorado — muda toda vez e não diz nada', () => {
  const d = diferenca(
    { ultimo_contato: '2026-08-01T10:00:00Z', queixa: 'Dor' },
    { ultimo_contato: '2026-08-28T10:00:00Z', queixa: 'Dor' },
  );
  assert.equal(d.length, 0);
});

test('memória vazia dos dois lados não quebra', () => {
  assert.equal(diferenca({}, {}).length, 0);
});

// ── evidência ───────────────────────────────────────────────────────────────

test('a evidência sai sem telefone — é auditoria, não cadastro', () => {
  const e = prepararEvidencia('PACIENTE: pode me ligar no 95 98403-2929, tenho dor lombar');
  assert.ok(e && !e.includes('98403'), 'telefone não pode ficar no histórico');
  assert.ok(e!.includes('dor lombar'), 'o que importa pra auditoria tem que ficar');
});

test('evidência longa é cortada, não guardada inteira', () => {
  const e = prepararEvidencia('a'.repeat(2000));
  assert.ok(e && e.length <= 400);
});

test('sem evidência não quebra', () => {
  assert.equal(prepararEvidencia(null), null);
  assert.equal(prepararEvidencia('   '), null);
});
