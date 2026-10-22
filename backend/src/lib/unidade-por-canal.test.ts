/**
 * Unidade de atendimento (Petrópolis × Caxias no mesmo número) — regra de 13/10/2026.
 *
 * O que estes testes prendem:
 *  - a conta de anúncios do anúncio decide primeiro (pela Meta ou pela lista conferida à mão);
 *  - sem anúncio conhecido, só o DDD 24 decide (Petrópolis); o 21 fica vazio para a SDR (15/10); sem nada, ninguém decide;
 *  - o paciente de DDD 21 que veio do anúncio de Petrópolis é Petrópolis (o anúncio vem antes do DDD);
 *  - campo preenchido pela SDR nunca é trocado; o que o robô pôs, ele corrige — mas só quando o ANÚNCIO decide;
 *  - a etiqueta segue o que está no campo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REGRAS_POR_UNIDADE, cidadesDe, dddDe, decidirUnidade, etiquetaDe, etiquetasSobrando, planejarUnidade, roboCorrige } from './unidade-por-canal.js';

const REGRAS = REGRAS_POR_UNIDADE['doutor-hernia-petropolis'];
const AN_CAXIAS = '120250266913310207'; // "AGENDAR AVALIAÇÃO", conta de Caxias
const AN_PETRO = '120248238857800289'; // "AGENDAR CONSULTA", conta de Petrópolis

test('DDD: com ou sem 55, fixo ou celular; lixo não vira DDD', () => {
  assert.equal(dddDe('+55 (21) 99876-5432'), '21');
  assert.equal(dddDe('5524988887777'), '24');
  assert.equal(dddDe('24 2242-1234'), '24');
  assert.equal(dddDe('2199876543'), '21');
  assert.equal(dddDe('12345'), null);
  assert.equal(dddDe(null), null);
});

test('anúncio da lista: a conta dele decide, mesmo contra o DDD', () => {
  assert.equal(decidirUnidade({ anuncio: AN_CAXIAS, contaDoAnuncio: null, ddd: '24', regras: REGRAS })?.unidade, 'Caxias');
  // 37 pacientes de DDD 21 vieram do anúncio de Petrópolis em out/2026: são de Petrópolis
  assert.equal(decidirUnidade({ anuncio: AN_PETRO, contaDoAnuncio: null, ddd: '21', regras: REGRAS })?.unidade, 'Petrópolis');
});

test('anúncio novo: a conta que a Meta devolveu decide', () => {
  const caxias = decidirUnidade({ anuncio: '999', contaDoAnuncio: '650695850658904', ddd: '24', regras: REGRAS });
  assert.equal(caxias?.unidade, 'Caxias');
  assert.match(caxias!.motivo, /conta de anúncios de Caxias/);
  assert.equal(decidirUnidade({ anuncio: '999', contaDoAnuncio: '1055937202829106', ddd: null, regras: REGRAS })?.unidade, 'Petrópolis');
});

test('anúncio de conta desconhecida ou sem anúncio: cai no DDD; sem DDD conhecido, ninguém decide', () => {
  const r = decidirUnidade({ anuncio: '999', contaDoAnuncio: null, ddd: '24', regras: REGRAS });
  assert.equal(r?.unidade, 'Petrópolis');
  assert.match(r!.motivo, /conta desconhecida/);
  assert.equal(decidirUnidade({ anuncio: null, contaDoAnuncio: null, ddd: '24', regras: REGRAS })?.unidade, 'Petrópolis');
  assert.equal(decidirUnidade({ anuncio: '999', contaDoAnuncio: '123', ddd: '11', regras: REGRAS }), null);
  assert.equal(decidirUnidade({ anuncio: null, contaDoAnuncio: null, ddd: null, regras: REGRAS }), null);
});

test('sem anúncio, DDD 21 NÃO decide: fica vazio para a SDR (15/10 — lead 3469615 era de Petrópolis)', () => {
  assert.equal(decidirUnidade({ anuncio: null, contaDoAnuncio: null, ddd: '21', regras: REGRAS }), null);
  assert.equal(decidirUnidade({ anuncio: '999', contaDoAnuncio: null, ddd: '21', regras: REGRAS }), null);
  // com o anúncio de Caxias, o 21 continua indo para Caxias — quem decide é o anúncio
  assert.equal(decidirUnidade({ anuncio: AN_CAXIAS, contaDoAnuncio: null, ddd: '21', regras: REGRAS })?.unidade, 'Caxias');
});

test('campo vazio: grava a unidade e a etiqueta da cidade', () => {
  const decisao = { unidade: 'Caxias', motivo: 'DDD 21', fonte: 'ddd' as const };
  assert.deepEqual(planejarUnidade({ decisao, noCartao: null, etiquetas: [] }), { acao: 'gravar', unidade: 'Caxias', etiqueta: 'CAXIAS', motivo: 'DDD 21' });
  assert.equal(planejarUnidade({ decisao: null, noCartao: null, etiquetas: [] }), null);
});

test('campo preenchido: confere ou diverge; a etiqueta segue o campo e só quando falta', () => {
  const petro = { unidade: 'Petrópolis', motivo: 'x', fonte: 'anuncio' as const };
  const confere = planejarUnidade({ decisao: petro, noCartao: 'Petrópolis', etiquetas: ['PETRÓPOLIS'] });
  assert.deepEqual(confere, { acao: 'confere', unidade: 'Petrópolis', noCartao: 'Petrópolis', etiqueta: null, motivo: 'x' });
  const diverge = planejarUnidade({ decisao: { unidade: 'Caxias', motivo: 'y', fonte: 'anuncio' }, noCartao: 'Petrópolis', etiquetas: [] });
  assert.equal(diverge?.acao, 'diverge');
  assert.equal(diverge?.etiqueta, 'PETRÓPOLIS');
});

test('o robô corrige só o que ele mesmo pôs (created_by 0), e só quando o anúncio decide', () => {
  const pelaConta = { unidade: 'Caxias', motivo: 'y', fonte: 'anuncio' as const };
  const pelaDdd = { unidade: 'Caxias', motivo: 'DDD 21', fonte: 'ddd' as const };
  const diverge = planejarUnidade({ decisao: pelaConta, noCartao: 'Petrópolis', etiquetas: ['PETRÓPOLIS'] });
  assert.equal(roboCorrige(diverge, pelaConta, 0), true);
  assert.equal(roboCorrige(diverge, pelaConta, 15314243), false); // uma SDR
  assert.equal(roboCorrige(diverge, pelaConta, undefined), false); // não deu pra saber
  // o DDD sozinho não desfaz o que o robô antigo marcou pelo número (QR de Caxias antes de 10/10)
  const divergeDdd = planejarUnidade({ decisao: pelaDdd, noCartao: 'Petrópolis', etiquetas: [] });
  assert.equal(roboCorrige(divergeDdd, pelaDdd, 0), false);
  const confere = planejarUnidade({ decisao: pelaConta, noCartao: 'Caxias', etiquetas: [] });
  assert.equal(roboCorrige(confere, pelaConta, 0), false);
  assert.equal(roboCorrige(null, null, 0), false);
});

test('etiqueta da outra cidade sai; a da cidade do campo e as outras etiquetas ficam', () => {
  assert.deepEqual(etiquetasSobrando('Caxias', ['PETRÓPOLIS', 'CAXIAS', 'Quente', 'FACEBOOK'], REGRAS), ['PETRÓPOLIS']);
  assert.deepEqual(etiquetasSobrando('Petrópolis', ['petrópolis', 'Origem: Anuncio pago'], REGRAS), []);
});

test('nada decide e a SDR preencheu a cidade: a etiqueta vem mesmo assim (Inbox, 22/10)', () => {
  const cidades = cidadesDe(REGRAS);
  // 4064639 (21/10): Petrópolis preenchido, anúncio que o robô não conhecia, sem a etiqueta
  assert.deepEqual(planejarUnidade({ decisao: null, noCartao: 'Petrópolis', etiquetas: ['Origem: Anuncio pago'], cidades }), {
    acao: 'etiqueta', unidade: 'Petrópolis', noCartao: 'Petrópolis', etiqueta: 'PETRÓPOLIS', motivo: 'nada decide a unidade: a etiqueta segue o campo',
  });
  assert.equal(planejarUnidade({ decisao: null, noCartao: 'caxias', etiquetas: ['CAXIAS'], cidades })?.etiqueta, null, 'já tem: nada a pôr');
  // campo vazio, ou valor que não é uma cidade da conta: nada a fazer
  assert.equal(planejarUnidade({ decisao: null, noCartao: null, etiquetas: [], cidades }), null);
  assert.equal(planejarUnidade({ decisao: null, noCartao: 'Outra', etiquetas: [], cidades }), null);
  // sem as cidades (quem chama sem regras): como antes
  assert.equal(planejarUnidade({ decisao: null, noCartao: 'Petrópolis', etiquetas: [] }), null);
});

test('anúncios das campanhas de 20–22/10 (conferidos na Meta em 22/10) decidem a cidade', () => {
  const caxias = decidirUnidade({ anuncio: '120250490002070207', contaDoAnuncio: null, ddd: '24', regras: REGRAS });
  assert.equal(caxias?.unidade, 'Caxias');
  assert.equal(caxias?.fonte, 'anuncio');
  assert.equal(decidirUnidade({ anuncio: '120248371149960289', contaDoAnuncio: null, ddd: '21', regras: REGRAS })?.unidade, 'Petrópolis');
});

test('etiqueta: caixa alta com acento', () => {
  assert.equal(etiquetaDe('Petrópolis'), 'PETRÓPOLIS');
});
