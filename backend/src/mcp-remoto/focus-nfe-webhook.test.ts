import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { mascararUrlDoLog } from '../lib/mascara-url-log.js';
import { armazemDeNotasEmMemoria, focusEmMemoria } from './focus-nfe-falso.js';
import { assinaturaDoWebhook, montarRotaDoWebhookFocus, processarAviso, segredoDoWebhookDoAmbiente, urlDoWebhook, type DepsDoAviso } from './focus-nfe-webhook.js';
import { criarContextoFocus, type ContaFocus, type NotaGuardada } from './focus-nfe.js';

const UNI = 'doutor-hernia-acailandia';
const SEGREDO = 'segredo-de-teste-com-mais-de-trinta-e-dois-caracteres';
const REF = 'ddnfaaaaaaaaaaaa';

function nota(sobre: Partial<NotaGuardada> = {}): NotaGuardada {
  return {
    referencia: REF, unidade: UNI, ambiente: 'homologacao', status: 'processando_autorizacao', serieDps: 1, numeroDps: 1, valorCentavos: 15000, dataCompetencia: '2026-11-25', tomadorMascarado: '***.***.247-**', origem: null,
    chaveDuplicata: 'x', criadoPor: 'a', criadoEm: '2026-11-26T14:00:00.000Z', numeroNfse: null, codigoVerificacao: null, urlConsulta: null, urlDanfse: null, caminhoXml: null, emitidaEm: null, canceladaEm: null,
    revisao: null, ultimoEvento: null, erro: null, ...sobre,
  };
}

function montar(op: { ambiente?: 'homologacao' | 'producao'; semConta?: boolean; semNota?: boolean } = {}) {
  const { focus, fonte } = focusEmMemoria();
  const armazem = armazemDeNotasEmMemoria();
  if (!op.semNota) armazem.linhas.push(nota());
  focus.notas.set(REF, { status: 'processando_autorizacao', ref: REF });
  const conta: ContaFocus = { slug: UNI, nome: 'Açailândia', ambiente: op.ambiente ?? 'homologacao', numeroInicial: 1, fonte };
  const ctx = criarContextoFocus(new Map(op.semConta ? [] : [[UNI, conta]]), armazem);
  const avisos: string[] = [];
  const deps: DepsDoAviso = { ctx, armazem, segredo: SEGREDO, alertar: async (t) => (avisos.push(t), true) };
  return { deps, focus, armazem, avisos, p: { unidade: UNI, assinatura: assinaturaDoWebhook(SEGREDO, UNI) } };
}

// o corpo do aviso é o mesmo da consulta (documentação): é só uma DICA
const AVISO_AUTORIZADA = { status: 'autorizado', ref: REF, numero: '74798' };

test('segredo: 32+ caracteres do ambiente; sem ele a rota nem é montada pela ligação', () => {
  assert.equal(segredoDoWebhookDoAmbiente({}), undefined);
  assert.equal(segredoDoWebhookDoAmbiente({ FOCUS_NFE_WEBHOOK_SEGREDO: 'curto' }), undefined);
  assert.equal(segredoDoWebhookDoAmbiente({ FOCUS_NFE_WEBHOOK_SEGREDO: ` ${SEGREDO} ` }), SEGREDO);
});

test('a assinatura é a MESMA que o ligar-focus-acailandia.sh calcula (HMAC-SHA256 de "focus-nfe|<unidade>", 32 primeiros caracteres): vetor fixo', () => {
  assert.equal(assinaturaDoWebhook('segredo-de-teste-com-mais-de-trinta-e-dois-caracteres', 'doutor-hernia-acailandia'), '2b7dbef7a8a898864eb5eba6c6941da7');
});

test('assinatura: a de uma unidade não serve a outra; errada = 404 sem tocar em nada', async () => {
  const m = montar();
  assert.notEqual(assinaturaDoWebhook(SEGREDO, UNI), assinaturaDoWebhook(SEGREDO, 'outra'));
  assert.notEqual(assinaturaDoWebhook(SEGREDO, UNI), assinaturaDoWebhook('outro-segredo-de-teste-com-mais-de-32-caracteres', UNI));
  const r = await processarAviso(m.deps, { unidade: UNI, assinatura: 'x'.repeat(32) }, AVISO_AUTORIZADA);
  assert.deepEqual(r, { http: 404, resultado: 'assinatura' });
  assert.equal(m.focus.consultas.length, 0);
  assert.equal(m.armazem.linhas[0]!.status, 'processando_autorizacao');
});

test('aviso de autorizada: o conector CONFIRMA na Focus e só então marca; o corpo nunca vale sozinho', async () => {
  const m = montar();
  // o aviso diz autorizado, a consulta ainda não: 503 (a Focus tenta de novo) e nada é marcado
  const antes = await processarAviso(m.deps, m.p, AVISO_AUTORIZADA);
  assert.equal(antes.http, 503);
  assert.equal(m.armazem.linhas[0]!.status, 'processando_autorizacao');
  assert.equal(m.focus.consultas.length, 1);
  m.focus.autorizar(REF, '74798');
  const r = await processarAviso(m.deps, m.p, AVISO_AUTORIZADA);
  assert.deepEqual(r, { http: 200, resultado: 'autorizado' });
  const l = m.armazem.linhas[0]!;
  assert.equal(l.status, 'autorizado');
  assert.equal(l.numeroNfse, '74798');
  assert.ok(l.urlDanfse?.startsWith('https://'));
  assert.ok(l.emitidaEm);
  // o mesmo aviso reentregue: continua 1 nota, sem mudança
  assert.deepEqual(await processarAviso(m.deps, m.p, AVISO_AUTORIZADA), { http: 200, resultado: 'sem mudança' });
  assert.equal(m.armazem.linhas.length, 1);
});

test('um corpo FORJADO (valor, número, status inventados) não muda o que a Focus diz', async () => {
  const m = montar();
  const r = await processarAviso(m.deps, m.p, { status: 'autorizado', ref: REF, numero: '999', valor_servico: 1, url_danfse: 'https://malicioso.exemplo.com/x.pdf' });
  assert.equal(r.http, 503);
  assert.equal(m.armazem.linhas[0]!.numeroNfse, null);
  assert.equal(m.armazem.linhas[0]!.urlDanfse, null);
});

test('erro de autorização e cancelamento vistos na confirmação avisam o João', async () => {
  const m = montar();
  m.focus.notas.set(REF, { status: 'erro_autorizacao', ref: REF, erros: [{ codigo: 'E1235', mensagem: 'Falha no esquema XML do DF-e.' }] });
  assert.deepEqual(await processarAviso(m.deps, m.p, { ref: REF }), { http: 200, resultado: 'erro_autorizacao' });
  assert.equal(m.armazem.linhas[0]!.status, 'erro_autorizacao');
  assert.match(m.armazem.linhas[0]!.erro!, /E1235/);
  assert.match(m.avisos[0]!, /NÃO foi autorizada/);
});

test('referência desconhecida (nota do painel da Focus ou do Asaas) = 200 sem fazer nada; sem referência = 200', async () => {
  const m = montar({ semNota: true });
  assert.deepEqual(await processarAviso(m.deps, m.p, { ref: 'outraref1' }), { http: 200, resultado: 'referência desconhecida' });
  assert.deepEqual(await processarAviso(m.deps, m.p, { ref: '../x' }), { http: 200, resultado: 'sem referência' });
  assert.deepEqual(await processarAviso(m.deps, m.p, null), { http: 200, resultado: 'sem referência' });
  assert.equal(m.focus.consultas.length, 0);
});

test('Focus fora do ar na confirmação: 503 (a Focus repete em 1 min, 30 min, 1 h...); unidade não carregada: 503 e avisa o João; ambiente trocado: 200 sem confirmar', async () => {
  const m = montar();
  m.focus.falhas.consultar = new Error('rede');
  assert.equal((await processarAviso(m.deps, m.p, AVISO_AUTORIZADA)).http, 503);
  const s = montar({ semConta: true });
  assert.equal((await processarAviso(s.deps, s.p, AVISO_AUTORIZADA)).http, 503);
  assert.match(s.avisos[0]!, /não tem essa unidade carregada/);
  const a = montar({ ambiente: 'producao' });
  assert.deepEqual(await processarAviso(a.deps, a.p, AVISO_AUTORIZADA), { http: 200, resultado: 'ambiente diferente' });
  assert.equal(a.focus.consultas.length, 0);
});

test('sem o segredo no servidor: 503 (nunca 404) e o João é avisado uma vez só', async () => {
  const m = montar();
  m.deps.segredo = undefined;
  assert.equal((await processarAviso(m.deps, m.p, AVISO_AUTORIZADA)).http, 503);
  await processarAviso(m.deps, m.p, AVISO_AUTORIZADA);
  assert.equal(m.avisos.length, 1);
});

test('a rota HTTP: POST com a assinatura certa responde {ok:true}; errada 404 sem eco e conta no limite por IP; só POST', async () => {
  const m = montar();
  m.focus.autorizar(REF, '1');
  const app = express();
  app.use(express.json());
  montarRotaDoWebhookFocus(app, m.deps);
  const srv = createServer(app);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const ok = await fetch(urlDoWebhook(base, SEGREDO, UNI), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(AVISO_AUTORIZADA) });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    assert.equal(m.armazem.linhas[0]!.status, 'autorizado');
    const ruim = await fetch(`${base}/focus-nfe/webhook/${UNI}/${'0'.repeat(32)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(ruim.status, 404);
    assert.deepEqual(await ruim.json(), { ok: false });
    assert.equal((await fetch(urlDoWebhook(base, SEGREDO, UNI))).status, 404, 'GET não existe');
  } finally {
    srv.close();
  }
});

test('o segredo do endereço nunca vai para o log de URL', () => {
  const caminho = `/focus-nfe/webhook/${UNI}/${assinaturaDoWebhook(SEGREDO, UNI)}`;
  assert.equal(mascararUrlDoLog(caminho), `/focus-nfe/webhook/${UNI}/[assinatura]`);
  assert.ok(!mascararUrlDoLog(caminho).includes(assinaturaDoWebhook(SEGREDO, UNI)));
});
