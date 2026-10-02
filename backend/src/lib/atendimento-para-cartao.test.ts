/**
 * Atendimento da franquia → cartão.
 *
 * Riscos presos aqui: escrever no `⬢ Forma de pagamento` ANTIGO (o duplicado de COMERCIAL, com 5 opções);
 * apagar o que a SDR digitou quando a franquia está vazia; regravar o que não mudou (cada escrita é uma chamada
 * ao Kommo); e a data do retorno sair um dia errada por causa do fuso.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CAMPOS_ATENDIMENTO, planejarAtendimento, type CampoCandidato } from './atendimento-para-cartao.js';
import type { AtendimentoTela } from './franquia-tela.js';

const VAZIO: AtendimentoTela = { retornoLocal: null, formaPagamento: null, tratamentoFuturo: null, perfil: null, motivoNaoRealizar: null };
const FUSO = 'America/Sao_Paulo';

const PAGAMENTO_NOVO: CampoCandidato = { id: 11, tipo: 'select', valor: null, opcoes: ['PIX', 'BOLETO', 'CRÉDITO 2X', 'CARTÃO DE DÉBITO', 'Não definido'] };
const PAGAMENTO_ANTIGO: CampoCandidato = { id: 10, tipo: 'select', valor: null, opcoes: ['À vista / PIX', 'Cartão de crédito', 'Cartão de débito', 'Boleto', 'Misto'] };

function conta(campos: Partial<Record<string, CampoCandidato[]>>) {
  return (nome: string) => campos[nome] ?? [];
}

test('forma de pagamento: grava no campo que ACEITA a opção, nunca no antigo', () => {
  const p = planejarAtendimento({
    atendimento: { ...VAZIO, formaPagamento: 'CRÉDITO 2X' },
    campos: conta({ [CAMPOS_ATENDIMENTO.FORMA_PAGAMENTO]: [PAGAMENTO_ANTIGO, PAGAMENTO_NOVO] }),
    fuso: FUSO,
  });
  assert.deepEqual(p.escritas.map((e) => [e.id, e.valor]), [[11, 'CRÉDITO 2X']]);
});

test('forma de pagamento: casa pela grafia sem acento/caixa e grava a grafia do Kommo', () => {
  const p = planejarAtendimento({
    atendimento: { ...VAZIO, formaPagamento: 'cartao de debito' },
    campos: conta({ [CAMPOS_ATENDIMENTO.FORMA_PAGAMENTO]: [PAGAMENTO_NOVO] }),
    fuso: FUSO,
  });
  assert.equal(p.escritas[0].valor, 'CARTÃO DE DÉBITO');
});

test('forma de pagamento: opção que a conta não tem não grava e avisa', () => {
  const p = planejarAtendimento({
    atendimento: { ...VAZIO, formaPagamento: 'PROMISSÓRIA' },
    campos: conta({ [CAMPOS_ATENDIMENTO.FORMA_PAGAMENTO]: [PAGAMENTO_NOVO] }),
    fuso: FUSO,
  });
  assert.equal(p.escritas.length, 0);
  assert.equal(p.avisos.length, 1);
});

test('forma de pagamento: já igual no cartão não regrava', () => {
  const p = planejarAtendimento({
    atendimento: { ...VAZIO, formaPagamento: 'PIX' },
    campos: conta({ [CAMPOS_ATENDIMENTO.FORMA_PAGAMENTO]: [{ ...PAGAMENTO_NOVO, valor: 'PIX' }] }),
    fuso: FUSO,
  });
  assert.equal(p.escritas.length, 0);
});

test('franquia vazia nunca apaga o que está no cartão', () => {
  const p = planejarAtendimento({
    atendimento: VAZIO,
    campos: conta({
      [CAMPOS_ATENDIMENTO.FORMA_PAGAMENTO]: [{ ...PAGAMENTO_NOVO, valor: 'PIX' }],
      [CAMPOS_ATENDIMENTO.MOTIVO]: [{ id: 12, tipo: 'textarea', valor: 'Achou caro', opcoes: [] }],
      [CAMPOS_ATENDIMENTO.RETOMAR_EM]: [{ id: 13, tipo: 'date', valor: '1791000000', opcoes: [] }],
    }),
    fuso: FUSO,
  });
  assert.deepEqual(p, { escritas: [], avisos: [] });
});

test('motivo: grava o texto, e só quando mudou', () => {
  const campo: CampoCandidato = { id: 12, tipo: 'textarea', valor: null, opcoes: [] };
  const novo = planejarAtendimento({ atendimento: { ...VAZIO, motivoNaoRealizar: 'Vai viajar' }, campos: conta({ [CAMPOS_ATENDIMENTO.MOTIVO]: [campo] }), fuso: FUSO });
  assert.deepEqual(novo.escritas.map((e) => [e.id, e.tipo, e.valor]), [[12, 'textarea', 'Vai viajar']]);
  const igual = planejarAtendimento({ atendimento: { ...VAZIO, motivoNaoRealizar: 'Vai viajar' }, campos: conta({ [CAMPOS_ATENDIMENTO.MOTIVO]: [{ ...campo, valor: ' vai  viajar ' }] }), fuso: FUSO });
  assert.equal(igual.escritas.length, 0);
});

test('motivo: campo "text" do Kommo aceita no máximo 256 caracteres — corta antes', () => {
  const p = planejarAtendimento({
    atendimento: { ...VAZIO, motivoNaoRealizar: 'x'.repeat(600) },
    campos: conta({ [CAMPOS_ATENDIMENTO.MOTIVO]: [{ id: 12, tipo: 'text', valor: null, opcoes: [] }] }),
    fuso: FUSO,
  });
  assert.equal(String(p.escritas[0].valor).length, 250);
});

test('retorno: 15/10 14:30 em São Paulo é 17:30 UTC; só grava se o "Retomar em" estiver VAZIO (não briga com a SDR)', () => {
  const epoch = Date.parse('2026-10-15T17:30:00Z') / 1000;
  const campo = (valor: string | null): CampoCandidato => ({ id: 13, tipo: 'date', valor, opcoes: [] });
  const vazio = planejarAtendimento({ atendimento: { ...VAZIO, retornoLocal: '2026-10-15T14:30' }, campos: conta({ [CAMPOS_ATENDIMENTO.RETOMAR_EM]: [campo(null)] }), fuso: FUSO });
  assert.deepEqual(vazio.escritas.map((e) => [e.id, e.tipo, e.valor]), [[13, 'date', epoch]]);
  // a SDR já marcou outra data: a franquia NÃO sobrescreve, nem a cada varredura
  const jaTem = planejarAtendimento({ atendimento: { ...VAZIO, retornoLocal: '2026-10-15T14:30' }, campos: conta({ [CAMPOS_ATENDIMENTO.RETOMAR_EM]: [campo('1790000000')] }), fuso: FUSO });
  assert.equal(jaTem.escritas.length, 0);
});

test('conta sem os campos novos: pula em silêncio', () => {
  const p = planejarAtendimento({
    atendimento: { ...VAZIO, formaPagamento: 'PIX', retornoLocal: '2026-10-15T14:30', motivoNaoRealizar: 'x' },
    campos: conta({}),
    fuso: FUSO,
  });
  assert.deepEqual(p, { escritas: [], avisos: [] });
});
