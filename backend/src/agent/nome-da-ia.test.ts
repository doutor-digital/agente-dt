/**
 * Nome da IA por unidade (10/11/2026): Salto quer "Aline", mas o nome "Sofia" estava fixo no preset da categoria
 * e no bloco da rede Doutor Hérnia (que vale acima das Fontes). `units.persona_agent_name` vazio = Sofia, como antes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nomeDaIaDH, renderDoutorHernia, renderIdentidadeDoutorHernia } from './rede-doutor-hernia.js';

const salto = { id: 'u-salto', slug: 'doutor-hernia-salto', name: 'Doutor Hérnia Salto', personaCompanyName: null, kommoSubdomain: null };

test('sem nome cadastrado, segue Sofia (nenhuma unidade muda)', () => {
  assert.equal(nomeDaIaDH({ personaAgentName: null }), 'Sofia');
  assert.equal(nomeDaIaDH({ personaAgentName: '   ' }), 'Sofia');
  assert.equal(nomeDaIaDH(undefined), 'Sofia');
  assert.equal(renderIdentidadeDoutorHernia(), renderIdentidadeDoutorHernia('Sofia'));
  assert.doesNotMatch(renderIdentidadeDoutorHernia(), /Você NÃO é a Sofia/);
});

test('com nome cadastrado, o bloco da rede usa o nome e afasta a Sofia', () => {
  const bloco = renderDoutorHernia({ ...salto, personaAgentName: 'Aline' });
  assert.match(bloco, /SEU NOME: você é a Aline — só "Aline"/);
  assert.match(bloco, /Você NÃO é a Sofia/);
  assert.doesNotMatch(bloco, /você é a Sofia/);
});

test('o nome cadastrado nunca leva título de doutora', () => {
  assert.equal(nomeDaIaDH({ personaAgentName: 'Dra. Aline' }), 'Aline');
  assert.equal(nomeDaIaDH({ personaAgentName: 'Doutora Aline' }), 'Aline');
});
