import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BANCO } from './banco.js';

/**
 * Testes do banco, não do agente: nenhum deles chama modelo nem banco de dados.
 *
 * Servem para o caso não morrer em silêncio. Um `chamaFerramenta:
 * ['consultar_horario']` — no singular, por engano — nunca seria satisfeito, e
 * o caso passaria a reprovar para sempre até alguém desistir do banco inteiro.
 */

/** Os nomes reais, tirados de agent/tools.ts e agent/agenda-tools.ts. */
const FERRAMENTAS_REAIS = new Set([
  'aplicar_tag',
  'remover_tag',
  'mover_etapa',
  'mover_funil',
  'pausar_ia',
  'atualizar_titulo_lead',
  'resumir_lead_para_sdr',
  'criar_tarefa',
  'atribuir_responsavel',
  'definir_valor_lead',
  'fechar_lead',
  'agendar_consulta',
  'buscar_paciente',
  'cadastrar_paciente',
  'cancelar_consulta',
  'confirmar_presenca',
  'consultar_horarios',
  'remarcar_consulta',
]);

test('o banco não está vazio', () => {
  assert.ok(BANCO.length >= 10, `só ${BANCO.length} casos`);
});

test('cada caso tem id único', () => {
  const ids = BANCO.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'id repetido: ' + ids.join(', '));
});

test('todo caso explica por que existe', () => {
  for (const c of BANCO) {
    assert.ok(c.porque.trim().length >= 60, `${c.id}: o "porque" está raso demais`);
  }
});

test('todo caso termina com o paciente falando', () => {
  // Se o último turno for da Sofia, a IA seria chamada para responder a si
  // mesma e o caso mediria outra coisa.
  for (const c of BANCO) {
    assert.ok(c.historico.length > 0, `${c.id} sem histórico`);
    assert.equal(c.historico.at(-1)?.de, 'paciente', `${c.id}: último turno não é do paciente`);
  }
});

test('toda ferramenta citada existe de verdade', () => {
  for (const c of BANCO) {
    for (const nome of [...(c.espera.chamaFerramenta ?? []), ...(c.espera.naoChamaFerramenta ?? [])]) {
      assert.ok(FERRAMENTAS_REAIS.has(nome), `${c.id}: "${nome}" não é ferramenta do agente`);
    }
  }
});

test('nenhum caso exige e proíbe a mesma ferramenta', () => {
  for (const c of BANCO) {
    const exigidas = new Set(c.espera.chamaFerramenta ?? []);
    for (const proibida of c.espera.naoChamaFerramenta ?? []) {
      assert.ok(!exigidas.has(proibida), `${c.id}: ${proibida} é exigida e proibida ao mesmo tempo`);
    }
  }
});

test('todo caso aponta para uma unidade', () => {
  for (const c of BANCO) {
    assert.match(c.unidade, /^[a-z0-9-]+$/, `${c.id}: slug estranho "${c.unidade}"`);
  }
});

test('o banco tem contrapeso: pelo menos um caso onde transferir é o certo', () => {
  // Sem isso o banco vira uma máquina de ensinar a IA a nunca passar o paciente
  // para ninguém — inclusive quando ele pede um humano com todas as letras.
  const contrapeso = BANCO.filter((c) => c.espera.naoTransfere === false);
  assert.ok(contrapeso.length >= 1, 'nenhum caso permite handoff legítimo');
});

test('o banco cobre mais de uma unidade', () => {
  // Um banco de uma unidade só esconde exatamente a família de erro que mais
  // apareceu: dado de uma cidade vazando para outra.
  const unidades = new Set(BANCO.map((c) => c.unidade));
  assert.ok(unidades.size >= 3, `só ${unidades.size} unidade(s) no banco`);
});
