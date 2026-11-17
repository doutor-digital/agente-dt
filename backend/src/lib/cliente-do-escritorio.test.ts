import test from 'node:test';
import assert from 'node:assert/strict';
import { portaClienteDoEscritorio, notaClienteDoEscritorio, calarClienteEstado, type PortaDeps } from './cliente-do-escritorio.js';
import { regraDeClienteDoAmbiente } from './disparo/conferencia.js';
import type { SituacaoNaFranquia } from './disparo/regras.js';

const unit = { id: 'u1', slug: 'magalhaes-advocacia' };
const REGRA = regraDeClienteDoAmbiente('magalhaes-advocacia', {
  DISPARO_REGRA_CLIENTE: 'magalhaes-advocacia=14026239,13964971/108260519,13964971/142',
} as NodeJS.ProcessEnv);

function deps(situacao: SituacaoNaFranquia | Error, estado: 'ligado' | 'seco' | 'desligado' = 'ligado') {
  const calls = { conferiu: 0, notas: [] as string[], marcou: 0 };
  const d: PortaDeps = {
    estado,
    regra: REGRA,
    conferir: async () => {
      calls.conferiu += 1;
      if (situacao instanceof Error) throw situacao;
      return situacao;
    },
    jaAvisou: async () => false,
    anotar: async (_id, texto) => {
      calls.notas.push(texto);
      return { id: 9 };
    },
    marcou: async () => {
      calls.marcou += 1;
    },
  };
  return { d, calls };
}

test('a regra do teste é a do disparo (funil Jurídico inteiro, Contrato assinado, ganho)', () => {
  assert.ok(REGRA);
  assert.ok(REGRA.funis.has(14026239));
  assert.ok(REGRA.etapas.has('13964971/108260519'));
  assert.ok(REGRA.etapas.has('13964971/142'));
});

test('chave desligada: nem lê o cartão', async () => {
  const { d, calls } = deps('ja-cliente', 'desligado');
  assert.equal(await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, d), null);
  assert.equal(calls.conferiu, 0);
});

test('ligada + já é cliente: cala e deixa UMA nota', async () => {
  const { d, calls } = deps('ja-cliente');
  const r = await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'Dr, e o meu processo?' }, d);
  assert.equal(r?.calar, true);
  assert.equal(r?.anotou, true);
  assert.equal(calls.notas.length, 1);
  assert.match(calls.notas[0], /CLIENTE do escritório/);
  assert.match(calls.notas[0], /meu processo/);
  assert.equal(calls.marcou, 1);
});

test('o Kommo criou a nota mas não devolveu o id: marca o aviso do dia (senão sairia uma nota por mensagem)', async () => {
  const { d, calls } = deps('ja-cliente');
  d.anotar = async (_id, texto) => {
    calls.notas.push(texto);
    return null;
  };
  const r = await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, d);
  assert.equal(r?.anotou, true);
  assert.equal(calls.marcou, 1);
});

test('ligada, mas já avisou hoje: cala sem repetir a nota', async () => {
  const { d, calls } = deps('ja-cliente');
  d.jaAvisou = async () => true;
  const r = await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, d);
  assert.equal(r?.calar, true);
  assert.equal(r?.anotou, false);
  assert.equal(calls.notas.length, 0);
});

test('só no papel: decide que calaria, mas não escreve nada (o webhook só registra neste estado)', async () => {
  const { d, calls } = deps('ja-cliente', 'seco');
  const r = await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, d);
  assert.equal(r?.estado, 'seco');
  assert.equal(r?.calar, true);
  assert.equal(r?.anotou, false);
  assert.equal(calls.notas.length, 0);
  assert.equal(calls.marcou, 0);
});

test('lead de verdade (livre) e cartão sumido: a IA segue', async () => {
  for (const s of ['livre', 'lead-inexistente'] as const) {
    const { d } = deps(s);
    const r = await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, d);
    assert.equal(r?.calar, false, s);
  }
});

test('Kommo indisponível ou erro na leitura: a IA segue (uma falha não cala o atendimento) e a porta nunca lança', async () => {
  const a = deps('indisponivel');
  assert.equal((await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, a.d))?.calar, false);
  const b = deps(new Error('boom'));
  const r = await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, b.d);
  assert.equal(r?.calar, false);
  assert.equal(r?.situacao, 'falhou');
});

test('chave ligada sem regra da unidade: não decide, a IA segue, e diz que faltou a regra', async () => {
  const { d, calls } = deps('ja-cliente');
  d.regra = null;
  const r = await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, d);
  assert.equal(r?.calar, false);
  assert.equal(r?.situacao, 'sem-regra');
  assert.equal(calls.conferiu, 0);
});

test('falha ao deixar a nota não destrava a IA: segue calada', async () => {
  const { d } = deps('ja-cliente');
  d.anotar = async () => {
    throw new Error('429');
  };
  const r = await portaClienteDoEscritorio({ unit, leadId: 1, humanMessage: 'oi' }, d);
  assert.equal(r?.calar, true);
  assert.equal(r?.anotou, false);
});

test('a chave nasce desligada (nada muda no deploy) e liga pela lista do ambiente', () => {
  assert.equal(calarClienteEstado('magalhaes-advocacia', undefined), 'desligado');
  assert.equal(calarClienteEstado('magalhaes-advocacia', 'magalhaes-advocacia'), 'ligado');
  assert.equal(calarClienteEstado('doutor-hernia-salto', 'magalhaes-advocacia'), 'desligado');
});

test('a nota é curta e corta a fala longa', () => {
  const n = notaClienteDoEscritorio('x'.repeat(500));
  assert.ok(n.length < 300);
  assert.match(n, /…/);
});
