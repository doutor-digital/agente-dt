import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contagemVazia,
  decidirCampos,
  etapaPermiteMotivo,
  extrairComRetentativa,
  lerExtracoes,
  valorNaoInformado,
  type Extracao,
  type RegraDeLeitura,
} from './backfill-campos-regras.js';

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
  for (const v of ['Não informada', 'não informado', 'NÃO INFORMOU', 'Sem informação', 'sem informacao', 'Não informada.']) {
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
