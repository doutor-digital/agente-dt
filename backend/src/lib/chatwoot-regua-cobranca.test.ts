/**
 * A cobrança da régua (pré-pagamento: `prepagamento` e `prepagamento-pendente`) só sai quando a EQUIPE marcou «Pagamento antecipado» na
 * conversa, e NUNCA em unidade que não recebe antecipado (Timbó: só paga no dia). Entrar em «Agendado» sozinho não cobra ninguém.
 * Datas: 2026-11-16 é segunda; Belém é UTC-3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as regua from './chatwoot-regua.js';
import { decidirRegua, type ConversaRegua, type DadosDaUnidade, type Visto } from './chatwoot-regua.js';
import { dadosDaUnidadeDaRegua } from './chatwoot-regua-worker.js';

/** escrita aqui de propósito (não importada): o teste roda igual no código antigo e mostra a cobrança saindo onde não devia */
const REGRAS_DE_COBRANCA: ReadonlySet<string> = new Set(['prepagamento', 'prepagamento-pendente']);
const U: DadosDaUnidade = { nome: 'Doutor Hérnia Parauapebas', pixKey: 'pix@parau.com', valorAntecipado: 250 };
const Z = (s: string) => new Date(s);
const ENTROU = '2026-11-16T12:00:00Z';

function conv(attrs: Record<string, unknown>, etiquetas: string[] = []): ConversaRegua {
  return { id: 10, nome: 'maria da silva', etiquetas, attrs, criadaEm: Z('2026-10-01T12:00:00Z'), atendente: 'Ana', ultima: null };
}
const vistoEntrou: Map<string, Visto> = new Map([
  ['_visto', { valor: '1', desde: Z('2026-11-10T12:00:00Z'), inicial: false }],
  ['etapa', { valor: 'Agendado', desde: Z(ENTROU), inicial: false }],
]);

/** Varre da hora em que ENTROU em Agendado até a consulta, de 10 em 10 min: tudo que a régua mandaria. */
function cobrancas(c: ConversaRegua, u: DadosDaUnidade = U): string[] {
  const feitos = new Set<string>();
  const saiu: string[] = [];
  for (let t = Z(ENTROU).getTime(); t <= Z('2026-11-17T12:00:00Z').getTime(); t += 10 * 60_000) {
    for (const d of decidirRegua(c, { vistos: vistoEntrou, feitos }, new Date(t), u).disparos) {
      feitos.add(`${d.regra}|${d.chave}`);
      if (REGRAS_DE_COBRANCA.has(d.regra) && d.texto !== null) saiu.push(d.regra);
    }
  }
  return saiu;
}

const AGENDADO = { etapa: 'Agendado', situacao_consulta: 'Agendado', categoria_consulta: 'Avaliação', data_consulta: '2026-11-18', hora_consulta: '14:30' };

test('as regras de cobrança são exatamente as duas do pré-pagamento', () => {
  assert.deepEqual([...(regua as unknown as { REGRAS_DE_COBRANCA: ReadonlySet<string> }).REGRAS_DE_COBRANCA].sort(), [...REGRAS_DE_COBRANCA].sort());
});

test('entrar em Agendado SEM a marca da equipe: nenhuma cobrança (em nenhuma forma de «não marcado»)', () => {
  for (const marca of [undefined, null, '', false, 'não', 'Não', 'nao', 'false', 0]) {
    assert.deepEqual(cobrancas(conv({ ...AGENDADO, pagamento_antecipado: marca })), [], `marca = ${JSON.stringify(marca)}`);
  }
  assert.deepEqual(cobrancas(conv({ ...AGENDADO })), []);
});

test('com a marca da equipe a cobrança sai (o robô não ficou mudo): recado agora e pendência 3 h depois', () => {
  for (const marca of [true, 'sim', 'Sim', 'true', 1]) {
    assert.deepEqual(cobrancas(conv({ ...AGENDADO, pagamento_antecipado: marca })), ['prepagamento', 'prepagamento-pendente'], `marca = ${JSON.stringify(marca)}`);
  }
});

test('unidade SEM antecipado: nem com a marca (que pode ter vindo de uma importação) a régua cobra Pix', () => {
  const semAntecipado: DadosDaUnidade = { ...U, semAntecipado: true };
  assert.deepEqual(cobrancas(conv({ ...AGENDADO, pagamento_antecipado: true }), semAntecipado), []);
  assert.deepEqual(cobrancas(conv({ ...AGENDADO, pagamento_antecipado: 'sim' }), semAntecipado), []);
  // e a marca FALSA do campo também não é lida como «cobrar»: a unidade com antecipado ligado segue cobrando
  assert.deepEqual(cobrancas(conv({ ...AGENDADO, pagamento_antecipado: true }), { ...U, semAntecipado: false }), ['prepagamento', 'prepagamento-pendente']);
});

test('unidade sem antecipado com texto próprio que NÃO pede o valor: antes mandava o recado de Pix; agora nada', () => {
  // um modelo da unidade sem o campo do valor antecipado (o `faltando` do valor não protege): é a trava estrutural que segura
  const textos = { parau_consulta_prepagamento: 'Olá, {{contact.name}}. A sua consulta está pré-agendada para {{lead.cf.2450736}}. Quer a chave Pix?', parau_consulta_prepagamento_pendente: 'Olá, {{contact.name}}. Falta o Pix de {{lead.cf.2450736}}.' };
  assert.deepEqual(cobrancas(conv({ ...AGENDADO, pagamento_antecipado: true }), { ...U, textos, valorAntecipado: null, semAntecipado: true }), []);
  // sem a trava (unidade com antecipado e o mesmo texto) o recado sairia: o teste acima prova a trava, não o texto
  assert.deepEqual(cobrancas(conv({ ...AGENDADO, pagamento_antecipado: true }), { ...U, textos, valorAntecipado: null }), ['prepagamento', 'prepagamento-pendente']);
});

test('quem já pagou não é cobrado, com ou sem trava', () => {
  assert.deepEqual(cobrancas(conv({ ...AGENDADO, pagamento_antecipado: true }, ['pagou-antecipado'])), []);
});

test('o worker monta `semAntecipado` só quando a unidade realmente não recebe antecipado (a taxa de reserva obrigatória vence)', () => {
  const unit = { name: 'Clínica', pixKey: 'k', sourceProdutos: '', systemPrompt: '' };
  assert.equal(dadosDaUnidadeDaRegua(unit, 'nenhuma-unidade').semAntecipado, undefined, 'sem a flag: como sempre');
  assert.equal(dadosDaUnidadeDaRegua({ ...unit, acceptsAdvancePayment: true }, 'nenhuma-unidade').semAntecipado, undefined);
  assert.equal(dadosDaUnidadeDaRegua({ ...unit, acceptsAdvancePayment: null }, 'nenhuma-unidade').semAntecipado, undefined);
  assert.equal(dadosDaUnidadeDaRegua({ ...unit, acceptsAdvancePayment: false }, 'nenhuma-unidade').semAntecipado, true);
  assert.equal(dadosDaUnidadeDaRegua({ ...unit, acceptsAdvancePayment: false, spineBookingRequiresPayment: true }, 'nenhuma-unidade').semAntecipado, undefined, 'a taxa obrigatória é um antecipado');
});
