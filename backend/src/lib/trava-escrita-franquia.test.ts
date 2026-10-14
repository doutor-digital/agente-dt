import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  MOTIVO_ESCRITA_SEM_CARTAO,
  _zerarTravaParaTeste,
  definirCarregadorDaTrava,
  definirTokensProtegidos,
  impressaoDoToken,
  motivoParaNaoEscrever,
} from './trava-escrita-franquia.js';
import { cancelSchedule, confirmSchedule, convertLead, createClient, createLead, createSchedule } from '../services/spine.service.js';

beforeEach(() => _zerarTravaParaTeste());

test('trava: sem conta dividida nenhuma, nada muda — toda escrita passa', async () => {
  assert.equal(await motivoParaNaoEscrever({ spineToken: 'token-imperatriz' }), null);
  assert.equal(await motivoParaNaoEscrever({ spineToken: null }), null);
});

test('trava: token de unidade que divide o Kommo é recusado sem a marca; com a marca, passa', async () => {
  definirTokensProtegidos(['token-petropolis', 'token-caxias']);
  assert.equal(await motivoParaNaoEscrever({ spineToken: 'token-petropolis' }), MOTIVO_ESCRITA_SEM_CARTAO);
  assert.equal(await motivoParaNaoEscrever({ spineToken: ' token-caxias ' }), MOTIVO_ESCRITA_SEM_CARTAO, 'espaço sobrando não engana');
  assert.equal(await motivoParaNaoEscrever({ spineToken: 'token-caxias', escritaConferida: true }), null);
  assert.equal(await motivoParaNaoEscrever({ spineToken: 'token-imperatriz' }), null, 'as outras unidades seguem iguais');
});

test('trava: espera a 1ª leitura do banco antes de liberar, e tenta de novo se ela falhar', async () => {
  let chamadas = 0;
  definirCarregadorDaTrava(async () => {
    chamadas++;
    await new Promise((r) => setTimeout(r, 5)); // o banco leva um tempo, como na vida real
    if (chamadas === 1) throw new Error('banco fora');
    definirTokensProtegidos(['token-petropolis']);
  });
  // 1ª: a leitura falhou — esta escrita usa a lista como estava (vazia) e a releitura já sai em segundo plano
  assert.equal(await motivoParaNaoEscrever({ spineToken: 'token-petropolis' }), null);
  // a seguinte já encontra a lista carregada
  assert.equal(await motivoParaNaoEscrever({ spineToken: 'token-petropolis' }), MOTIVO_ESCRITA_SEM_CARTAO);
  assert.ok(chamadas >= 2);
});

test('trava: a lista guarda impressão, nunca o token', () => {
  const i = impressaoDoToken('eyJ.segredo.assinatura');
  assert.ok(i && i.length === 24 && !i.includes('segredo'));
  assert.equal(impressaoDoToken('  '), null);
});

// ── a mesma porta, vista do spine.service: recusa ANTES de qualquer requisição ────────────────────────────────
// Base em porta fechada: se a trava deixasse passar, o erro seria de conexão, não a frase da trava.
const PORTA_FECHADA = 'http://127.0.0.1:9';
const unidade = (token: string, escritaConferida?: boolean) => ({ spineBaseUrl: PORTA_FECHADA, spineToken: token, spineTimezone: 'America/Sao_Paulo', escritaConferida });

test('spine.service: as 6 escritas recusam o token protegido sem a marca, sem tocar na rede', async () => {
  definirTokensProtegidos(['token-petropolis']);
  const u = unidade('token-petropolis');
  const rs = await Promise.all([
    createSchedule(u, { idClient: 1, dateAttendanceLocal: '2026-10-20T10:00:00', idCategory: 1 }),
    createLead(u, { name: 'Maria da Silva', whatsapp: '+5524999990000', idSource: 20 } as never),
    createClient(u, { name: 'Maria da Silva', whatsapp: '+5524999990000', idSource: 20 } as never),
    convertLead(u, { idLead: 1, name: 'Maria da Silva', whatsapp: '+5524999990000', idSource: 20 } as never),
    cancelSchedule(u, 1),
    confirmSchedule(u, 1),
  ]);
  for (const r of rs) {
    assert.equal(r.ok, false);
    assert.equal(r.error, MOTIVO_ESCRITA_SEM_CARTAO);
  }
});

test('spine.service: com a marca (cartão conferido) ou em unidade comum, a escrita segue para a franquia', async () => {
  definirTokensProtegidos(['token-petropolis']);
  const conferida = await confirmSchedule(unidade('token-petropolis', true), 1);
  assert.equal(conferida.ok, false);
  assert.notEqual(conferida.error, MOTIVO_ESCRITA_SEM_CARTAO, 'passou da trava — falhou só porque a porta está fechada');
  const comum = await confirmSchedule(unidade('token-imperatriz'), 1);
  assert.notEqual(comum.error, MOTIVO_ESCRITA_SEM_CARTAO);
});
