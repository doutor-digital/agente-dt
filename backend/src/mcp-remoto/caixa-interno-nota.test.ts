import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { registrarEmissorDeNotaDoCaixa, unidadesComNotaDoCaixa, type EmissorDeNotaDoCaixa, type PedidoDeNotaDoCaixa } from '../lib/caixa-nota.js';
import { assinarPedidoDoCaixa } from './caixa-interno.js';
import { documentoValido, montarRotasDaNotaDoCaixa } from './caixa-interno-nota.js';

const UNI = 'doutor-hernia-acailandia';
const TOKEN = 't'.repeat(40);
const AGORA = Date.parse('2026-11-26T15:00:00Z');
const CPF = '52998224725';
const LANC = '8f0c1c1e-9d3e-4b52-8d0f-0a6a1f5a7c11';
const NOTA = { unidade: UNI, lanc_id: LANC, valor_centavos: 15000, competencia: '2026-11-26', tomador: { nome: 'Fulana de Tal', documento: '529.982.247-25' } };

const servidores: Server[] = [];
afterEach(() => {
  registrarEmissorDeNotaDoCaixa(null);
  while (servidores.length) servidores.pop()!.close();
});

async function montar(op: { nota?: string[]; alertaSai?: boolean; token?: string } = {}) {
  const avisos: string[] = [];
  const logs: string[] = [];
  let alertaSai = op.alertaSai ?? true;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  montarRotasDaNotaDoCaixa(app, {
    token: 'token' in op ? op.token : TOKEN,
    alertar: async (t) => (alertaSai ? (avisos.push(t), true) : false),
    unidadesNota: () => new Set(op.nota ?? []),
    agora: () => AGORA,
    log: { info: (o, m) => logs.push(JSON.stringify([o, m])), warn: (o, m) => logs.push(JSON.stringify([o, m])) },
  });
  const srv = createServer(app);
  servidores.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const chamar = async (metodo: 'GET' | 'POST', caminho: string, corpo?: unknown, segredo: string | null = TOKEN) => {
    const bruto = corpo === undefined ? '' : JSON.stringify(corpo);
    const ts = String(Math.floor(AGORA / 1000));
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...(segredo ? { 'x-dd-timestamp': ts, 'x-dd-assinatura': assinarPedidoDoCaixa(segredo, ts, metodo, caminho, bruto) } : {}) },
      ...(corpo === undefined ? {} : { body: bruto }),
    });
    return { http: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  return { chamar, avisos, logs, alertaSai: (v: boolean) => void (alertaSai = v) };
}

test('sem token as rotas da nota NÃO existem (404); token errado = 401', async () => {
  const sem = await montar({ token: undefined });
  assert.equal((await sem.chamar('POST', '/interno/caixa/nota', NOTA)).http, 404);
  const m = await montar({ nota: [UNI] });
  assert.equal((await m.chamar('POST', '/interno/caixa/nota', NOTA, 'errado')).http, 401);
  assert.equal((await m.chamar('POST', '/interno/caixa/nota', NOTA, null)).http, 401);
});

test('emitir: desligada por padrão (403); aberta sem emissor = 501 e nada emitido (consultar e avisar não dependem da lista)', async () => {
  assert.equal(unidadesComNotaDoCaixa({}).size, 0);
  const desligada = await montar({ nota: [] });
  assert.equal((await desligada.chamar('POST', '/interno/caixa/nota', NOTA)).http, 403);
  // consultar não depende da lista de unidades: sem emissor responde 501 (não 403)
  assert.equal((await desligada.chamar('GET', `/interno/caixa/nota?unidade=${UNI}&lanc_id=${LANC}`)).http, 501);
  const semEmissor = await montar({ nota: [UNI] });
  const r = await semEmissor.chamar('POST', '/interno/caixa/nota', NOTA);
  assert.equal(r.http, 501);
  assert.match(String(r.json.erro), /Focus NFe\) ainda não está no ar/);
});

test('nota: com emissor, ele recebe só dígitos do documento e o valor do pedido; a idempotência é dele (devolve a mesma nota); documento inválido nem chega nele', async () => {
  const pedidos: PedidoDeNotaDoCaixa[] = [];
  const emissor: EmissorDeNotaDoCaixa = {
    emitir: async (p) => {
      const jaExistia = pedidos.some((x) => x.lancId === p.lancId);
      pedidos.push(p);
      return { estado: 'em_processamento', jaExistia };
    },
    consultar: async () => ({ estado: 'emitida', numero: '12' }),
  };
  registrarEmissorDeNotaDoCaixa(emissor);
  const m = await montar({ nota: [UNI] });
  const a = await m.chamar('POST', '/interno/caixa/nota', NOTA);
  assert.equal(a.http, 200);
  assert.equal(pedidos[0]!.tomador.documento, CPF);
  assert.equal(pedidos[0]!.valorCentavos, 15000);
  assert.equal(pedidos[0]!.unidade, UNI);
  const b = await m.chamar('POST', '/interno/caixa/nota', NOTA);
  assert.equal((b.json.nota as { jaExistia: boolean }).jaExistia, true);
  const ruim = await m.chamar('POST', '/interno/caixa/nota', { ...NOTA, tomador: { nome: 'Fulana de Tal', documento: '529.982.247-26' } });
  assert.equal(ruim.http, 422);
  assert.equal(pedidos.length, 2, 'o emissor não foi chamado com documento inválido');
  assert.equal((await m.chamar('POST', '/interno/caixa/nota', { ...NOTA, valor_centavos: 12.5 })).http, 400);
  assert.equal((await m.chamar('POST', '/interno/caixa/nota', { ...NOTA, lanc_id: 'nao-e-uuid' })).http, 400);
  const c = await m.chamar('GET', `/interno/caixa/nota?unidade=${UNI}&lanc_id=${LANC}`);
  assert.deepEqual(c.json.nota, { estado: 'emitida', numero: '12' });
});

test('nota: o CPF e o nome nunca vão ao log, ao Telegram nem à resposta de erro, nem quando o emissor quebra', async () => {
  registrarEmissorDeNotaDoCaixa({ emitir: async () => { throw new Error(`falhou para ${CPF} Fulana de Tal`); }, consultar: async () => null });
  const m = await montar({ nota: [UNI] });
  const r = await m.chamar('POST', '/interno/caixa/nota', NOTA);
  assert.equal(r.http, 500);
  const tudo = JSON.stringify([m.logs, m.avisos, r.json]);
  assert.equal(tudo.includes(CPF), false);
  assert.equal(tudo.includes('Fulana'), false);
});

test('revisão: lançamento cancelado/alterado depois da nota AVISA («cancelar a nota»), uma vez por hora, e não cancela nada', async () => {
  let cancelou = false;
  registrarEmissorDeNotaDoCaixa({ emitir: async () => ({ estado: 'emitida' }), consultar: async () => null, cancelar: async () => { cancelou = true; } } as never);
  const m = await montar({ nota: [UNI] });
  const corpo = { unidade: UNI, lanc_id: LANC, motivo: 'cancelado' };
  const a = await m.chamar('POST', '/interno/caixa/nota/revisao', corpo);
  const b = await m.chamar('POST', '/interno/caixa/nota/revisao', corpo);
  assert.equal(a.json.avisado, true);
  assert.equal(b.json.avisado, false);
  assert.equal(m.avisos.filter((t) => /CANCELAR A NOTA/.test(t)).length, 1);
  assert.match(m.avisos.join('\n'), /8f0c1c1e/);
  assert.equal(m.avisos.join('\n').includes(LANC), false, 'só o id curto');
  assert.equal(cancelou, false);
  assert.equal((await m.chamar('POST', '/interno/caixa/nota/revisao', { ...corpo, motivo: 'qualquer' })).http, 400);
  // o aviso que não saiu (Telegram fora) NÃO vale como avisado: 502, e a repetição tenta de novo
  const sem = await montar({ nota: [UNI], alertaSai: false });
  const r1 = await sem.chamar('POST', '/interno/caixa/nota/revisao', corpo);
  assert.equal(r1.http, 502);
  sem.alertaSai(true);
  assert.equal((await sem.chamar('POST', '/interno/caixa/nota/revisao', corpo)).json.avisado, true);
  // tirar a unidade da lista NÃO cala o alerta: uma nota válida não pode ficar sem aviso
  const fora = await montar({ nota: [] });
  assert.equal((await fora.chamar('POST', '/interno/caixa/nota/revisao', corpo)).json.avisado, true);
  // duas chamadas AO MESMO TEMPO mandam UM alerta só
  const dupla = await montar({ nota: [UNI] });
  const outro = { ...corpo, lanc_id: '1f0c1c1e-9d3e-4b52-8d0f-0a6a1f5a7c22' };
  await Promise.all([dupla.chamar('POST', '/interno/caixa/nota/revisao', outro), dupla.chamar('POST', '/interno/caixa/nota/revisao', outro)]);
  assert.equal(dupla.avisos.filter((t) => /CANCELAR A NOTA/.test(t)).length, 1);
  // competência que não existe no calendário é recusada antes do emissor
  const ruim = await montar({ nota: [UNI] });
  assert.equal((await ruim.chamar('POST', '/interno/caixa/nota', { ...NOTA, competencia: '2026-13-45' })).http, 400);
});

test('documentoValido: CPF e CNPJ com dígito certo passam; errado, repetido ou de tamanho torto, não', () => {
  assert.equal(documentoValido('529.982.247-25'), CPF);
  assert.equal(documentoValido('11.222.333/0001-81'), '11222333000181');
  assert.equal(documentoValido('529.982.247-26'), null);
  assert.equal(documentoValido('111.111.111-11'), null);
  assert.equal(documentoValido('1234'), null);
  assert.equal(documentoValido('11.222.333/0001-82'), null);
});
