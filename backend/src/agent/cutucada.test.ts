import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instrucaoDaCutucada } from './cutucada.js';

test('a instrução usa a identidade da unidade e proíbe «da equipe» (a atendente humana acabou de se apresentar com o nome dela)', () => {
  const i = instrucaoDaCutucada({ conversa: 'PACIENTE: oi', sofiaJaFalou: false, ultimaDaEquipeSemTexto: false, nome: null, clinica: 'Doutor Hérnia Petrópolis' });
  assert.match(i, /Aqui é a Sofia, da Doutor Hérnia Petrópolis/);
  assert.match(i, /MESMA identidade que o seu prompt/);
  assert.match(i, /NÃO é "da equipe"/);
  assert.doesNotMatch(i, /Aqui é a Sofia, da equipe da clínica/);
  assert.doesNotMatch(i, /como parte da equipe/);
  assert.match(i, /no máximo 220 caracteres/);
});

test('Sofia que já falou não se reapresenta; áudio da equipe: não inventa o conteúdo', () => {
  const i = instrucaoDaCutucada({ conversa: 'x', sofiaJaFalou: true, ultimaDaEquipeSemTexto: true, nome: 'Maria', clinica: 'Doutor Hérnia Petrópolis' });
  assert.match(i, /NÃO se reapresente/);
  assert.match(i, /áudio ou uma imagem/);
  assert.match(i, /"Maria"/);
});
