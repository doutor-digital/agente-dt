import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acharCampoPorNome, planejarRegras, tiposCompativeis, type CampoDaConta, type ModeloDeRegra } from './regras-de-campo-por-nome.js';

/** Regras do modelo (Timbó): o que vem daqui é só TEXTO; o id do campo do Timbó nem existe neste tipo. */
const modelo = (nome: string, tipo: string, tool: string, extra: Partial<ModeloDeRegra> = {}): ModeloDeRegra => ({
  kommoFieldName: nome,
  kommoFieldType: tipo,
  toolName: tool,
  instruction: `instrução de ${nome}`,
  ...extra,
});

const QUEIXA = modelo('✎ Queixa', 'textarea', 'registra_queixa', { valueHint: 'texto curto', examples: ['dor lombar'] });
const QUALIF = modelo('★ Qualificação (Quente/Morno/Frio)', 'select', 'registra_qualificacao');
const REGIAO = modelo('⚕ Região da dor', 'multiselect', 'registra_regiao_dor');
const CIDADE = modelo('⌂ Cidade', 'textarea', 'registra_cidade');

const conta: CampoDaConta[] = [
  { id: 901, name: '✎ Queixa', type: 'textarea', enums: [] },
  { id: 902, name: '★ Qualificação (Quente/Morno/Frio)', type: 'select', enums: [{ id: 1, value: 'Quente' }, { id: 2, value: 'Morno' }, { id: 3, value: 'Frio' }] },
  // Salto: "Região da dor" é select; Tatuí: multiselect. As duas são lista.
  { id: 903, name: '⚕ Região da dor', type: 'select', enums: [{ id: 10, value: 'Lombar' }, { id: 11, value: 'Cervical' }] },
];

test('resolve o campo pelo NOME: id, tipo e opções vêm da conta, o texto vem do modelo', () => {
  const p = planejarRegras([QUEIXA, QUALIF, REGIAO], conta, []);
  assert.equal(p.criar.length, 3);
  const q = p.criar.find((r) => r.toolName === 'registra_queixa')!;
  assert.equal(q.kommoFieldId, 901);
  assert.equal(q.instruction, 'instrução de ✎ Queixa');
  assert.equal(q.valueHint, 'texto curto');
  assert.deepEqual(q.examples, ['dor lombar']);
  assert.equal(q.kommoFieldEnums, null);
  const qual = p.criar.find((r) => r.toolName === 'registra_qualificacao')!;
  assert.deepEqual(qual.kommoFieldEnums, [{ id: 1, value: 'Quente' }, { id: 2, value: 'Morno' }, { id: 3, value: 'Frio' }]);
  const reg = p.criar.find((r) => r.toolName === 'registra_regiao_dor')!;
  assert.equal(reg.kommoFieldType, 'select', 'o tipo é o da CONTA (modelo multiselect, conta select)');
  assert.equal(reg.kommoFieldId, 903);
  assert.equal(p.deFora.length, 0);
});

test('campo que não existe na conta fica de fora e é listado (nada é criado nem chutado)', () => {
  const p = planejarRegras([QUEIXA, CIDADE], conta, []);
  assert.deepEqual(p.criar.map((r) => r.toolName), ['registra_queixa']);
  assert.deepEqual(p.deFora, [{ nome: '⌂ Cidade', motivo: 'não existe na conta' }]);
});

test('casa por nome normalizado (sem símbolo, acento e caixa) quando o exato não existe', () => {
  const p = planejarRegras([modelo('★ Qualificação (Quente/Morno/Frio)', 'select', 't')], [{ id: 5, name: 'Qualificacao (quente/morno/frio)', type: 'select', enums: [{ id: 1, value: 'Quente' }] }], []);
  assert.equal(p.criar[0]?.kommoFieldId, 5);
});

test('dois campos com o mesmo nome na conta: fica de fora (escolher um é palpite)', () => {
  const dupla: CampoDaConta[] = [
    { id: 1, name: '⌂ Cidade', type: 'text', enums: [] },
    { id: 2, name: '⌂ Cidade', type: 'text', enums: [] },
  ];
  const p = planejarRegras([CIDADE], dupla, []);
  assert.equal(p.criar.length, 0);
  assert.equal(p.deFora[0]?.motivo, 'mais de um campo com esse nome');
  assert.match(p.deFora[0]?.detalhe ?? '', /1:.*2:/);
  // e o normalizado ambíguo também
  const sim = planejarRegras([CIDADE], [{ id: 1, name: 'Cidade', type: 'text', enums: [] }, { id: 2, name: '#Cidade', type: 'text', enums: [] }], []);
  assert.equal(sim.deFora[0]?.motivo, 'mais de um campo com esse nome');
});

test('tipo incompatível, tipo sem suporte e lista sem opções ficam de fora', () => {
  const p = planejarRegras(
    [QUEIXA, QUALIF, REGIAO],
    [
      { id: 1, name: '✎ Queixa', type: 'numeric', enums: [] },
      { id: 2, name: '★ Qualificação (Quente/Morno/Frio)', type: 'select', enums: [] },
      { id: 3, name: '⚕ Região da dor', type: 'checkbox', enums: [] },
    ],
    [],
  );
  assert.equal(p.criar.length, 0);
  assert.deepEqual(p.deFora.map((f) => f.motivo), ['tipo incompatível', 'lista sem opções na conta', 'tipo sem suporte']);
});

test('idempotente: regra com a mesma ferramenta OU para o mesmo campo não é duplicada', () => {
  const p1 = planejarRegras([QUEIXA, QUALIF, REGIAO], conta, []);
  assert.equal(p1.criar.length, 3);
  // segunda rodada, depois de gravar: as 3 já existem
  const gravadas = p1.criar.map((r) => ({ toolName: r.toolName, kommoFieldId: r.kommoFieldId }));
  const p2 = planejarRegras([QUEIXA, QUALIF, REGIAO], conta, gravadas);
  assert.equal(p2.criar.length, 0);
  assert.deepEqual(p2.jaExistem.map((j) => j.porque), ['mesma ferramenta', 'mesma ferramenta', 'mesma ferramenta']);
  // regra manual do campo com OUTRO nome de ferramenta: também não duplica
  const p3 = planejarRegras([QUEIXA], conta, [{ toolName: 'minha_queixa', kommoFieldId: 901 }]);
  assert.equal(p3.criar.length, 0);
  assert.equal(p3.jaExistem[0]?.porque, 'mesmo campo');
});

test('dois modelos para o mesmo campo da conta viram UMA regra só', () => {
  const p = planejarRegras([QUEIXA, modelo('✎ Queixa', 'textarea', 'outra_queixa')], conta, []);
  assert.equal(p.criar.length, 1);
  assert.equal(p.jaExistem.length, 1);
});

test('família de tipos', () => {
  assert.ok(tiposCompativeis('select', 'multiselect'));
  assert.ok(tiposCompativeis('text', 'textarea'));
  assert.ok(tiposCompativeis('numeric', 'monetary'));
  assert.ok(!tiposCompativeis('select', 'text'));
  assert.ok(!tiposCompativeis('date', 'numeric'));
});

test('acharCampoPorNome: nome vazio ou só símbolo não casa com nada', () => {
  assert.deepEqual(acharCampoPorNome(conta, '★'), { ausente: true });
});
