import { test } from 'node:test';
import assert from 'node:assert/strict';

import { avaliarNome } from './spine-sync.service.js';

// Os casos vieram do CRM da franquia em 26/08/2026 — nomes que entraram de
// verdade. Todo item de LIXO aqui é um cadastro que a recepção da clínica
// abriu e não conseguiu usar.

const COM_SOBRENOME = { exigirSobrenome: true };

// Lixo: nunca foi gente. Barrado nos dois modos, sem nada a perder.
const LIXO: Array<[string, string]> = [
  ['REBENTADO', 'pedaço da mensagem do paciente'],
  ['PELO ESTRAGARAM', 'pedaço da mensagem do paciente'],
  ['Pelo Estragaram', 'pedaço da mensagem do paciente'],
  ['26/08/26', 'data no lugar do nome'],
  ['26/08/2026', 'data no lugar do nome'],
  ['Atende Plano Ou So', 'pergunta do paciente'],
  ['Quais Tipos De Atendimentos', 'pergunta do paciente'],
  ['Quanto custa a consulta', 'pergunta do paciente'],
  ['DOUTOR HÉRNIA IMPERATRIZ', 'nome da própria clínica'],
  ['Bom dia', 'saudação'],
  ['oi tudo bem', 'saudação'],
  ['Lead #22011111', 'título automático do Kommo'],
  ['+55 63 99102-1043', 'telefone'],
  ['WhatsApp', 'nome do canal'],
  ['dor na virilha', 'queixa'],
  ['J', 'letra solta'],
];

// Gente de verdade, mas sem sobrenome. Passa hoje; só é barrado quando
// ligarmos a exigência — e isso custa ~93% desses leads (medido).
const SO_PRIMEIRO_NOME = ['ALZIRA', 'JOANA', 'ANTÔNIO', 'Adriely', 'Alcirene', 'Maria S', 'Maria de'];

const GENTE: Array<[string, string]> = [
  ['MARIA SIMONE FERREIRA MEDRADO', 'MARIA SIMONE FERREIRA MEDRADO'],
  ['RAIMUNDA LUIZA DA SILVA FERREIRA', 'RAIMUNDA LUIZA DA SILVA FERREIRA'],
  ['ELINEUZA LUSTOSA DE OLIVEIRA', 'ELINEUZA LUSTOSA DE OLIVEIRA'],
  ['ERICA LAUANE OLIVEIRA', 'ERICA LAUANE OLIVEIRA'],
  ['WALISON SANTOS COSTA', 'WALISON SANTOS COSTA'],
  ['Benaias Torres de Oliveira', 'Benaias Torres de Oliveira'],
  ['Leonardo Ribeiro dos Santos', 'Leonardo Ribeiro dos Santos'],
  ['Maria das Dores Silva', 'Maria das Dores Silva'],
  ['Fabio Sousa Santos', 'Fabio Sousa Santos'],
  ['Eber da Silva Ramos', 'Eber da Silva Ramos'],
  // O título traz a etiqueta do canal ou a data no fim — isso a gente limpa,
  // não descarta, porque o nome está lá.
  ['Erica Lauane Oliveira Instagram', 'Erica Lauane Oliveira'],
  ['Walison Santos Costa 26/08', 'Walison Santos Costa'],
  ['Maria Simone Ferreira - ', 'Maria Simone Ferreira'],
  ['Fabio Sousa Santos 20/08/2026', 'Fabio Sousa Santos'],
  // A data às vezes vem grudada no sobrenome — o nome ainda se salva.
  ['Erivanilson pimenta Ferreira19/08/26', 'Erivanilson pimenta Ferreira'],
];

for (const [titulo, porque] of LIXO) {
  test(`nunca vira cadastro: "${titulo}" (${porque})`, () => {
    for (const modo of [{}, COM_SOBRENOME]) {
      const r = avaliarNome(titulo, modo);
      assert.equal(r.ok, false, `"${titulo}" passou como nome de gente`);
      assert.ok(r.motivo, 'precisa dizer por que segurou, pro log fazer sentido');
    }
  });
}

for (const [titulo, esperado] of GENTE) {
  test(`vira cadastro nos dois modos: "${titulo}"`, () => {
    for (const modo of [{}, COM_SOBRENOME]) {
      const r = avaliarNome(titulo, modo);
      assert.equal(r.ok, true, `"${titulo}" foi barrado — ${r.motivo}`);
      assert.equal(r.nome, esperado);
    }
  });
}

for (const titulo of SO_PRIMEIRO_NOME) {
  test(`"${titulo}": passa hoje, só cai com a exigência ligada`, () => {
    assert.equal(avaliarNome(titulo).ok, true, 'ligar isso agora derrubaria 93% dos leads');
    const r = avaliarNome(titulo, COM_SOBRENOME);
    assert.equal(r.ok, false);
    assert.match(String(r.motivo), /sobrenome/);
  });
}

test('"Dores" é nome de gente, "dor" é queixa', () => {
  assert.equal(avaliarNome('Maria das Dores Silva').ok, true);
  assert.equal(avaliarNome('dor na virilha').ok, false);
});

test('o motivo sai legível pra aparecer na tela de pendentes', () => {
  assert.match(String(avaliarNome('Quanto custa a consulta').motivo), /pergunta|mensagem/i);
  assert.match(String(avaliarNome('26/08/26').motivo), /número|data/i);
});
