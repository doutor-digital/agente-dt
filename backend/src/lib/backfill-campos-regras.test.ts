import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  contagemVazia,
  decidirCampos,
  etapaPermiteMotivo,
  extrairComRetentativa,
  lerExtracoes,
  regrasDoBackfill,
  valorNaoInformado,
  type Extracao,
  type RegraDeLeitura,
} from './backfill-campos-regras.js';
import { _esquecerOBancoParaTeste, _semearParaTeste } from './automacoes-estado.js';

afterEach(() => _esquecerOBancoParaTeste());

const regra = (id: number, nome: string, tipo: string, opcoes: string[] = []): RegraDeLeitura => ({
  kommoFieldId: id,
  kommoFieldName: nome,
  kommoFieldType: tipo,
  kommoFieldEnums: opcoes.map((v, i) => ({ id: i + 1, value: v })),
});
const REGRAS = [
  regra(1, '✎ Queixa', 'textarea'),
  regra(2, '★ Qualificação (Quente/Morno/Frio)', 'select', ['Quente', 'Morno', 'Frio']),
  regra(3, '⚕ Região da dor', 'select', ['Lombar', 'Cervical', 'Não informada']),
  regra(4, '⊘ Motivo do não agendamento', 'select', ['Sem condições financeira', 'Está viajando']),
];
const porNome = new Map(REGRAS.map((r) => [r.kommoFieldName.toLowerCase(), r]));
const decidir = (campos: Record<string, string | null>, etapa: string | null, preenchidos: number[] = []) =>
  decidirCampos({ campos, porNome, preenchidos: new Set(preenchidos), nomeDaEtapa: etapa });

test('"Motivo do não agendamento" só em Em espera ou Perdido (24/11: 76 de 101 caíam em etapa errada em Salto)', () => {
  const campos = { '✎ Queixa': 'dor lombar', '⊘ Motivo do não agendamento': 'Está viajando' };
  for (const etapa of ['EM QUALIFICAÇÃO', 'AGENDADO', 'EM TRATAMENTO', 'EM NEGOCIAÇÃO', 'TRATAMENTO CANCELADO', null]) {
    const d = decidir(campos, etapa);
    assert.deepEqual(d.aGravar.map((g) => g.regra.kommoFieldId), [1], `etapa ${etapa}: só a queixa`);
    assert.equal(d.motivoForaDaEtapa, 1);
  }
  for (const etapa of ['EM ESPERA', 'PERDIDO', 'Em Espera']) {
    const d = decidir(campos, etapa);
    assert.deepEqual(d.aGravar.map((g) => g.regra.kommoFieldId), [1, 4], `etapa ${etapa}: queixa e motivo`);
    assert.equal(d.motivoForaDaEtapa, 0);
  }
});

test('"Não informada" e equivalentes nunca são gravados, mesmo sendo opção da lista da conta', () => {
  for (const v of ['Não informada', 'N/I', 'n/i', 'não informado', 'NÃO INFORMOU', 'Sem informação', 'sem informacao', 'Não informada.']) {
    assert.ok(valorNaoInformado(v), v);
  }
  for (const v of ['Lombar', 'dor informada pelo marido', 'Informada', '', null, 'informação sobre exame']) assert.ok(!valorNaoInformado(v), String(v));
  const d = decidir({ '⚕ Região da dor': 'Não informada', '✎ Queixa': 'dor lombar' }, 'EM ESPERA');
  assert.deepEqual(d.aGravar.map((g) => g.regra.kommoFieldId), [1]);
  assert.equal(d.naoInformados, 1);
});

test('"Queixa: não informada" não libera a Qualificação (sem dor contada não há base)', () => {
  const d = decidir({ '✎ Queixa': 'Não informada', '★ Qualificação (Quente/Morno/Frio)': 'Quente' }, 'EM QUALIFICAÇÃO');
  assert.equal(d.aGravar.length, 0);
  const ok = decidir({ '✎ Queixa': 'dor lombar', '★ Qualificação (Quente/Morno/Frio)': 'Quente' }, 'EM QUALIFICAÇÃO');
  assert.deepEqual(ok.aGravar.map((g) => g.regra.kommoFieldId), [1, 2]);
});

test('nunca sobrescreve campo preenchido; opção que a conta não tem é descartada; null não grava', () => {
  const d = decidir({ '✎ Queixa': 'nova queixa', '★ Qualificação (Quente/Morno/Frio)': 'Morno', '⚕ Região da dor': 'Sacral', '⊘ Motivo do não agendamento': null }, 'PERDIDO', [1]);
  assert.deepEqual(d.aGravar.map((g) => g.regra.kommoFieldId), [2]);
  assert.equal(d.jaPreenchidos, 1);
});

test('a opção da lista volta na grafia da conta', () => {
  const d = decidir({ '✎ Queixa': 'x', '★ Qualificação (Quente/Morno/Frio)': 'quente' }, 'EM ESPERA');
  assert.equal(d.aGravar.find((g) => g.regra.kommoFieldId === 2)?.valor, 'Quente');
});

test('etapaPermiteMotivo', () => {
  assert.ok(etapaPermiteMotivo('EM ESPERA'));
  assert.ok(etapaPermiteMotivo('PERDIDO'));
  assert.ok(!etapaPermiteMotivo('AGENDADO'));
  assert.ok(!etapaPermiteMotivo(undefined));
});

test('lerExtracoes aguenta colchete solto e cerca de código antes/depois do array', () => {
  const arr = '[{"leadId":7,"campos":{"✎ Queixa":"dor"}}]';
  assert.deepEqual(lerExtracoes(`Segue [resultado]:\n\`\`\`json\n${arr}\n\`\`\`\n[fim]`), [{ leadId: 7, campos: { '✎ Queixa': 'dor' } }]);
  assert.equal(lerExtracoes('[1, 2, 3]'), null, 'array que não é de extrações não vale');
  assert.equal(lerExtracoes('[Observação] nada aqui'), null);
});

test('lerExtracoes: array válido, vazio válido, o resto é ilegível (null)', () => {
  assert.deepEqual(lerExtracoes('texto [{"leadId":1,"campos":{"a":"b"}}] fim'), [{ leadId: 1, campos: { a: 'b' } }]);
  assert.deepEqual(lerExtracoes('[]'), []);
  assert.equal(lerExtracoes('sem array nenhum'), null);
  assert.equal(lerExtracoes('[{"leadId":1,"campos":{"✎ Queixa": Dores na coluna}}]'), null, 'o JSON quebrado de 24/11');
});

const conversas = (n: number) => Array.from({ length: n }, (_, i) => ({ leadId: 100 + i }));
const ext = (c: { leadId: number }): Extracao => ({ leadId: c.leadId, campos: { '✎ Queixa': 'x' } });

test('lote legível: uma chamada só, nada contado', async () => {
  let chamadas = 0;
  const cont = contagemVazia();
  const r = await extrairComRetentativa(conversas(10), async (l) => (chamadas++, l.map(ext)), cont);
  assert.equal(chamadas, 1);
  assert.equal(r.length, 10);
  assert.deepEqual(cont, contagemVazia());
});

test('lote ilegível: parte ao meio e repete; só a conversa que continua ilegível é perdida (e contada)', async () => {
  const ruim = 103;
  const tamanhos: number[] = [];
  const cont = contagemVazia();
  const r = await extrairComRetentativa(
    conversas(10),
    async (l) => {
      tamanhos.push(l.length);
      return l.some((c) => c.leadId === ruim) ? null : l.map(ext);
    },
    cont,
  );
  assert.deepEqual(cont.perdidas, [ruim]);
  assert.equal(r.length, 9);
  assert.ok(!r.some((e) => e.leadId === ruim));
  assert.equal(tamanhos[0], 10);
  assert.equal(tamanhos[1], 5, 'a 2ª tentativa é metade do lote');
  assert.ok(cont.respostasInvalidas >= 2, 'cada resposta ilegível é contada');
});

test('tudo ilegível: nenhuma conversa some sem rastro', async () => {
  const cont = contagemVazia();
  const r = await extrairComRetentativa(conversas(5), async () => null, cont);
  assert.equal(r.length, 0);
  assert.equal(cont.perdidas.length, 5);
});

test('erro de chamada (chave, limite, rede): não repete, conta o lote e as conversas', async () => {
  let chamadas = 0;
  const cont = contagemVazia();
  const r = await extrairComRetentativa(
    conversas(4),
    async () => {
      chamadas++;
      throw new Error('Anthropic: rate_limit');
    },
    cont,
  );
  assert.equal(chamadas, 1);
  assert.equal(r.length, 0);
  assert.equal(cont.lotesComErro, 1);
  assert.equal(cont.perdidas.length, 4);
  assert.match(cont.erros[0] ?? '', /rate_limit/);
});

test('leadId que o modelo devolve e NÃO é do lote enviado é descartado (nunca grava em outro cartão)', async () => {
  const cont = contagemVazia();
  const r = await extrairComRetentativa(
    conversas(3),
    async () => [
      { leadId: 100, campos: { '✎ Queixa': 'a' } },
      { leadId: 999, campos: { '✎ Queixa': 'de outro cartão' } },
      { leadId: '101' as unknown as number, campos: { '✎ Queixa': 'b' } },
    ],
    cont,
  );
  assert.deepEqual(r.map((e) => e.leadId), [100, 101]);
});

test('etapa de perda com outro feitio de nome ("Venda perdida") também vale', () => {
  assert.ok(etapaPermiteMotivo('Venda perdida'));
  assert.ok(etapaPermiteMotivo('Fechado - Perdido'));
});

test('com o robô tipo-lead-chegada LIGADO, o backfill NÃO grava "⬢ Tipo de lead" (escritor único; palpite ficaria para sempre)', () => {
  const rules = [
    { ...regra(5, '⬢ Tipo de lead', 'select', ['Cadastro', 'Resgate']) },
    ...REGRAS,
  ];
  _semearParaTeste([{ slug: 'doutor-hernia-salto', automacao: 'tipo-lead-chegada', estado: 'ligado' }]);
  const usadas = regrasDoBackfill('doutor-hernia-salto', rules);
  assert.ok(!usadas.some((r) => r.kommoFieldName === '⬢ Tipo de lead'));
  assert.equal(usadas.length, REGRAS.length, 'as outras regras de conversa seguem');
  // ponta a ponta: mesmo que o modelo devolva o Tipo de lead, não há regra para gravar
  const d = decidirCampos({
    campos: { '✎ Queixa': 'dor lombar', '⬢ Tipo de lead': 'Cadastro' },
    porNome: new Map(usadas.map((r) => [r.kommoFieldName.toLowerCase(), r])),
    preenchidos: new Set(),
    nomeDaEtapa: 'EM QUALIFICAÇÃO',
  });
  assert.deepEqual(d.aGravar.map((g) => g.regra.kommoFieldName), ['✎ Queixa']);
});

test('robô tipo-lead-chegada desligado ou em outra unidade: o Tipo de lead segue entre as regras; campo antigo sem símbolo não é o mesmo', () => {
  const rules = [regra(5, '⬢ Tipo de lead', 'select', ['Cadastro', 'Resgate']), regra(6, 'Tipo de lead', 'select', ['Cadastro'])];
  _semearParaTeste([{ slug: 'doutor-hernia-salto', automacao: 'tipo-lead-chegada', estado: 'ligado' }, { slug: 'doutor-hernia-caxias', automacao: 'tipo-lead-chegada', estado: 'desligado' }]);
  assert.deepEqual(regrasDoBackfill('doutor-hernia-salto', rules).map((r) => r.kommoFieldId), [6], 'só o nome exato com símbolo sai');
  assert.deepEqual(regrasDoBackfill('doutor-hernia-caxias', rules).map((r) => r.kommoFieldId), [5, 6]);
});

test('o modelo omite um cartão numa resposta legível: ele entra em perdidas (não some)', async () => {
  const cont = contagemVazia();
  const r = await extrairComRetentativa(conversas(3), async () => [ext({ leadId: 100 }), ext({ leadId: 102 })], cont);
  assert.deepEqual(r.map((e) => e.leadId), [100, 102]);
  assert.deepEqual(cont.perdidas, [101]);
  assert.equal(cont.omitidas, 1);
});

test('resposta "[]" para um lote de 3: as 3 conversas entram em perdidas', async () => {
  const cont = contagemVazia();
  const r = await extrairComRetentativa(conversas(3), async () => [], cont);
  assert.equal(r.length, 0);
  assert.deepEqual(cont.perdidas, [100, 101, 102]);
  assert.equal(cont.omitidas, 3);
  assert.equal(cont.respostasInvalidas, 0, 'a resposta era legível, só incompleta');
});

test('leadId fora do lote devolvido pelo modelo não conta como cobertura do cartão que faltou', async () => {
  const cont = contagemVazia();
  await extrairComRetentativa(conversas(2), async () => [ext({ leadId: 100 }), ext({ leadId: 999 })], cont);
  assert.deepEqual(cont.perdidas, [101]);
});
