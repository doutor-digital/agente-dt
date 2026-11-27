import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _limparOrigensParaTeste, conferirOrigemIaSofia, type DepsDaOrigem, type UnidadeDaOrigem } from './franquia-origem-ia.js';

const unit = (id = 10002): UnidadeDaOrigem => ({ id: 'u1', slug: 'doutor-hernia-serra', spineBaseUrl: 'https://x', spineToken: 't', spineTimezone: 'America/Sao_Paulo', spineIaSourceId: id });
let chamadas = 0;
const com = (r: Awaited<ReturnType<DepsDaOrigem['listar']>>, agora = () => 1_000): DepsDaOrigem => ({ listar: async () => { chamadas++; return r; }, agora });
const LISTA = { ok: true, data: { origens: [{ idSource: 20, name: 'WhatsApp' }, { idSource: 10002, name: 'IA SOFIA' }] } };

beforeEach(() => { _limparOrigensParaTeste(); chamadas = 0; });

test('origem IA SOFIA na lista da franquia: ok', async () => {
  const r = await conferirOrigemIaSofia(unit(), com(LISTA));
  assert.deepEqual(r, { situacao: 'ok', idSource: 10002, nome: 'IA SOFIA' });
});

test('o nome também confere (caixa e espaços não importam)', async () => {
  const r = await conferirOrigemIaSofia(unit(), com({ ok: true, data: { origens: [{ idSource: 10002, name: ' ia sofia ' }] } }));
  assert.equal(r.situacao, 'ok');
});

test('origem que NÃO está na lista: faltando, com aviso claro', async () => {
  const r = await conferirOrigemIaSofia(unit(), com({ ok: true, data: { origens: [{ idSource: 20, name: 'WhatsApp' }] } }));
  assert.equal(r.situacao, 'faltando');
  assert.match((r as { motivo: string }).motivo, /NÃO existe na lista/);
});

test('o id existe mas é outra origem: faltando (nunca carimbar lead com a origem errada)', async () => {
  const r = await conferirOrigemIaSofia(unit(), com({ ok: true, data: { origens: [{ idSource: 10002, name: 'Google' }] } }));
  assert.equal(r.situacao, 'faltando');
  assert.match((r as { motivo: string }).motivo, /Google/);
});

test('unidade sem spine_ia_source_id: faltando — nunca cai na origem padrão', async () => {
  const r = await conferirOrigemIaSofia({ ...unit(), spineIaSourceId: null }, com(LISTA));
  assert.equal(r.situacao, 'faltando');
  assert.equal(chamadas, 0);
});

test('a franquia não deixou ler a lista (403 etc.): não dá para conferir — NÃO é prova de que falta', async () => {
  const r = await conferirOrigemIaSofia(unit(), com({ ok: false, error: '403: token sem permissão para este recurso' }));
  assert.equal(r.situacao, 'nao-deu-para-conferir');
});

test('a lista é guardada: duas conferências, uma chamada; falha é reconferida mais cedo que sucesso', async () => {
  await conferirOrigemIaSofia(unit(), com(LISTA));
  await conferirOrigemIaSofia(unit(), com(LISTA, () => 1_000 + 3600_000));
  assert.equal(chamadas, 1);
  _limparOrigensParaTeste();
  chamadas = 0;
  await conferirOrigemIaSofia(unit(), com({ ok: false, error: '500' }));
  await conferirOrigemIaSofia(unit(), com({ ok: false, error: '500' }, () => 1_000 + 11 * 60_000));
  assert.equal(chamadas, 2);
});

test('a franquia dá o nome que quiser contendo "Sofia" ("IA Sofia - Doutor Digital"): ok — o que barra é o id apontar para OUTRA origem', async () => {
  const r = await conferirOrigemIaSofia(unit(), com({ ok: true, data: { origens: [{ idSource: 10002, name: 'IA Sofia - Doutor Digital' }] } }));
  assert.equal(r.situacao, 'ok');
});

test('origem faltando é reconferida em 10 min (a franquia pode corrigir), não em 6 h', async () => {
  const semOrigem = { ok: true, data: { origens: [{ idSource: 20, name: 'WhatsApp' }] } };
  assert.equal((await conferirOrigemIaSofia(unit(), com(semOrigem))).situacao, 'faltando');
  const r = await conferirOrigemIaSofia(unit(), com(LISTA, () => 1_000 + 11 * 60_000));
  assert.equal(r.situacao, 'ok');
  assert.equal(chamadas, 2);
});
