import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MARCA_DO_HISTORICO,
  MAX_FALAS,
  MAX_HISTORICO,
  dividirFalas,
  juntarNaMemoria,
  lerPedidoDePassagem,
  liberadaAgora,
  montarHistorico,
  type FalaDaTela,
} from './ponte-passar-sofia.js';

const P = (texto: string, hora: string | null = null): FalaDaTela => ({ de: 'paciente', texto, hora });
const E = (texto: string, hora: string | null = null): FalaDaTela => ({ de: 'equipe', texto, hora });

test('lerPedidoDePassagem: aceita e limpa', () => {
  const r = lerPedidoDePassagem({ leadId: '123', por: ' Ana ', falas: [{ de: 'paciente', texto: '  oi\u0000  tudo  ', hora: '10:02' }, { de: 'robô', texto: 'x' }, { de: 'equipe', texto: '' }] });
  assert.ok(r.ok);
  assert.deepEqual(r.pedido, { leadId: 123, por: 'Ana', falas: [{ de: 'paciente', texto: 'oi tudo', hora: '10:02' }] });
});

test('lerPedidoDePassagem: recusa lead ruim e conversa sem fala', () => {
  assert.equal(lerPedidoDePassagem({ leadId: 'x', falas: [P('oi')] }).ok, false);
  assert.equal(lerPedidoDePassagem({ leadId: 1 }).ok, false);
  assert.equal(lerPedidoDePassagem({ leadId: 1, falas: [{ de: 'paciente', texto: '   ' }] }).ok, false);
  assert.equal(lerPedidoDePassagem(null).ok, false);
});

test('lerPedidoDePassagem: muitas falas → fica com as mais recentes', () => {
  const falas = Array.from({ length: MAX_FALAS + 10 }, (_, i) => P(`f${i}`));
  const r = lerPedidoDePassagem({ leadId: 1, falas });
  assert.ok(r.ok);
  assert.equal(r.pedido.falas.length, MAX_FALAS);
  assert.equal(r.pedido.falas.at(-1)!.texto, `f${MAX_FALAS + 9}`);
});

test('dividirFalas: pendentes = falas do paciente depois da última da equipe', () => {
  const { anteriores, pendentes } = dividirFalas([P('oi'), E('olá, tudo bem?'), P('quanto custa?'), P('e tem sábado?')]);
  assert.deepEqual(pendentes, ['quanto custa?', 'e tem sábado?']);
  assert.deepEqual(anteriores.map((f) => f.texto), ['oi', 'olá, tudo bem?']);
});

test('dividirFalas: equipe falou por último → nada pendente; só paciente → tudo pendente', () => {
  assert.deepEqual(dividirFalas([P('oi'), E('olá')]).pendentes, []);
  const so = dividirFalas([P('a'), P('b')]);
  assert.deepEqual(so.pendentes, ['a', 'b']);
  assert.deepEqual(so.anteriores, []);
});

test('montarHistorico: cabeçalho, autores e hora', () => {
  const h = montarHistorico([P('oi', '10:02'), E('olá')], '12/11 14:30', 'Ana');
  assert.ok(h.startsWith(MARCA_DO_HISTORICO));
  assert.match(h, /Ana/);
  assert.match(h, /Paciente \(10:02\): oi/);
  assert.match(h, /\nEquipe: olá$/);
});

test('montarHistorico: longo demais → guarda o fim', () => {
  const falas = Array.from({ length: 60 }, (_, i) => P(`fala ${i} ${'x'.repeat(100)}`));
  const h = montarHistorico(falas, '12/11 14:30', null);
  assert.ok(h.length <= MAX_HISTORICO, String(h.length));
  assert.match(h, /fala 59 /);
  assert.doesNotMatch(h, /fala 0 /);
});

test('juntarNaMemoria: anexa ao resumo e troca o bloco de uma passagem anterior', () => {
  const h1 = montarHistorico([P('a')], '12/11 10:00', null);
  const h2 = montarHistorico([P('b')], '12/11 11:00', null);
  assert.equal(juntarNaMemoria('', h1), h1);
  const m1 = juntarNaMemoria('Paciente com dor lombar.', h1);
  assert.equal(m1, `Paciente com dor lombar.\n\n${h1}`);
  const m2 = juntarNaMemoria(m1, h2);
  assert.equal(m2, `Paciente com dor lombar.\n\n${h2}`);
  assert.equal(m2.split(MARCA_DO_HISTORICO).length, 2);
});

test('liberadaAgora', () => {
  const agora = new Date('2026-11-12T15:00:00Z');
  assert.equal(liberadaAgora(new Date('2026-11-12T16:00:00Z'), agora), true);
  assert.equal(liberadaAgora(new Date('2026-11-12T14:00:00Z'), agora), false);
  assert.equal(liberadaAgora(null, agora), false);
});

test('lerPedidoDeTodos: liga até uma hora futura (máx. 24 h) ou desliga com null', async () => {
  const { lerPedidoDeTodos } = await import('./ponte-passar-sofia.js');
  const agora = new Date('2026-11-12T15:00:00Z');
  const ok = lerPedidoDeTodos({ ate: '2026-11-12T21:00:00Z', por: 'Ana' }, agora);
  assert.ok(ok.ok && ok.ate?.toISOString() === '2026-11-12T21:00:00.000Z' && ok.por === 'Ana');
  const desliga = lerPedidoDeTodos({ ate: null }, agora);
  assert.ok(desliga.ok && desliga.ate === null);
  assert.equal(lerPedidoDeTodos({ ate: '2026-11-12T14:00:00Z' }, agora).ok, false);
  assert.equal(lerPedidoDeTodos({ ate: '2026-11-14T15:00:00Z' }, agora).ok, false);
  assert.equal(lerPedidoDeTodos({ ate: 'ontem' }, agora).ok, false);
  assert.equal(lerPedidoDeTodos({}, agora).ok, false);
});

test('notaDoHistorico: cabeçalho com a origem, autores e corte pelo fim', async () => {
  const { notaDoHistorico, MAX_NOTA } = await import('./ponte-passar-sofia.js');
  const n = notaDoHistorico([P('oi', '10:02'), E('olá')], '13/11 10:00', 'Ana');
  assert.match(n, /^📜 Conversa no WhatsApp antes do Kommo \(lida da tela do WhatsApp Web por Ana em 13\/11 10:00\)/);
  assert.match(n, /Paciente \(10:02\): oi\nEquipe: olá$/);
  assert.match(notaDoHistorico([P('x')], '13/11', null, 'whatsapp'), /lida do WhatsApp da clínica/);
  const longa = notaDoHistorico(Array.from({ length: 200 }, (_, i) => P(`fala ${i} ${'y'.repeat(80)}`)), '13/11', null);
  assert.ok(longa.length <= MAX_NOTA);
  assert.match(longa, /fala 199 /);
});
