import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarContextoKommo, kommoConversa } from './kommo.js';
import { fonteFalsa, leadFalso, unidadeKommo } from './kommo-falso.js';
import { historicoOficial } from '../services/kommo-talks-normalizar.js';
import type { KommoTalkMessage } from '../services/kommo.service.js';

const T = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const msg = (id: number, iso: string, extra: Partial<KommoTalkMessage>): KommoTalkMessage => ({ id, created_at: T(iso), ...extra }) as KommoTalkMessage;

test('histórico junta as conversas antigas e a viva, em ordem, e devolve só as últimas N', async () => {
  const kommo = {
    async listTalks() {
      return [{ talk_id: 1, updated_at: T('2026-09-01T10:00:00Z') }, { talk_id: 2, updated_at: T('2026-10-13T12:00:00Z') }] as never;
    },
    async listTalkMessages(talkId: number) {
      return talkId === 2
        ? [msg(21, '2026-10-13T12:32:00Z', { type: 'outgoing', author: { type: 'bot', name: 'SalesBot' }, text: 'Olá, dona Maria!' } as never),
           msg(22, '2026-10-13T12:33:00Z', { type: 'incoming', author: { type: 'external', name: 'Maria' }, text: 'Bom dia' } as never)]
        : [msg(11, '2026-09-01T09:00:00Z', { type: 'incoming', author: { type: 'external' }, text: 'Quanto custa?' } as never),
           msg(12, '2026-09-01T09:05:00Z', { type: 'outgoing', author: { type: 'user', name: 'Brenna' }, text: 'R$ 350' } as never)];
    },
  };
  const r = await historicoOficial(kommo as never, 99, 3);
  assert.equal(r.conversas, 2);
  assert.deepEqual(r.mensagens.map((m) => m.id), ['12', '21', '22']);
  assert.deepEqual(r.mensagens.map((m) => m.autor), ['equipe', 'sofia', 'paciente']);
});

test('kommo_conversa: um lead, cada mensagem com quem falou, hora local, áudio como [áudio] e aviso de saúde', async () => {
  const fonte = fonteFalsa([leadFalso(28099635, '2026-10-01', { name: 'Maria', status_id: 142 })]);
  fonte.conversa = async () => ({
    conversas: 1,
    mensagens: [
      { id: '1', em: new Date('2026-10-13T12:32:00Z'), direcao: 'saida', autor: 'sofia', autorNome: 'SalesBot', texto: 'Olá!', anexo: null, status: 'read' },
      { id: '2', em: new Date('2026-10-13T12:40:00Z'), direcao: 'entrada', autor: 'paciente', autorNome: '', texto: '', anexo: { tipo: 'voice', link: null }, status: null },
      { id: '3', em: new Date('2026-10-13T12:41:00Z'), direcao: 'saida', autor: 'equipe', autorNome: 'Brenna', texto: 'Tenho quinta 10h', anexo: null, status: null },
    ],
  });
  const ctx = criarContextoKommo(new Map([['doutor-hernia-maraba', unidadeKommo('doutor-hernia-maraba', fonte)]]));
  const r = await kommoConversa(ctx, { unidade: 'maraba', leadId: 28099635 });
  assert.equal(r.lead.id, 28099635);
  assert.equal(r.mostrando, 3);
  assert.deepEqual(r.mensagens.map((m) => m.quem), ['sofia', 'paciente', 'equipe']);
  assert.equal(r.mensagens[0]!.quando, '13/10/2026, 09:32');
  assert.equal(r.mensagens[1]!.texto, '[áudio]');
  assert.equal((r.mensagens[2] as { remetente?: string }).remetente, 'Brenna');
  assert.equal((r.mensagens[0] as { remetente?: string }).remetente, 'SalesBot');
  assert.equal((r.mensagens[1] as { remetente?: string }).remetente, undefined);
  assert.match(r.aviso, /registrada/);
});

test('kommo_conversa recusa mais de uma unidade e "todas"', async () => {
  const fonte = fonteFalsa([]);
  fonte.conversa = async () => ({ conversas: 0, mensagens: [] });
  const ctx = criarContextoKommo(new Map([['a-x', unidadeKommo('a-x', fonte)], ['b-y', unidadeKommo('b-y', fonte)]]));
  await assert.rejects(() => kommoConversa(ctx, { unidade: 'todas', leadId: 1 }));
});

test('histórico: lê a 2ª página de uma conversa longa e para se a API repetir a página', async () => {
  const pagina1 = Array.from({ length: 250 }, (_, i) => msg(1000 + i, `2026-10-01T10:${String(i % 60).padStart(2, '0')}:00Z`, { type: 'incoming', author: { type: 'external' }, text: 'x' } as never));
  const pagina2 = Array.from({ length: 10 }, (_, i) => msg(2000 + i, '2026-10-02T10:00:00Z', { type: 'incoming', author: { type: 'external' }, text: 'y' } as never));
  const longa = { async listTalks() { return [{ talk_id: 1, updated_at: T('2026-10-02T10:00:00Z') }] as never; },
    async listTalkMessages(_t: number, _l: number, p?: number) { return p === 2 ? pagina2 : pagina1; } };
  const r = await historicoOficial(longa as never, 1, 500);
  assert.equal(r.total, 260);
  assert.equal(r.truncado, false);
  let chamadas = 0;
  const repete = { async listTalks() { return [{ talk_id: 1 }] as never; }, async listTalkMessages() { chamadas++; return pagina1; } };
  const r2 = await historicoOficial(repete as never, 1, 500);
  assert.equal(r2.total, 250);
  assert.equal(chamadas, 2);
});

test('histórico por período: pula a conversa antiga e filtra as mensagens', async () => {
  let lidas: number[] = [];
  const k = {
    async listTalks() { return [{ talk_id: 1, created_at: T('2026-08-01T00:00:00Z'), updated_at: T('2026-08-05T00:00:00Z') }, { talk_id: 2, created_at: T('2026-10-01T00:00:00Z'), updated_at: T('2026-10-14T00:00:00Z') }] as never; },
    async listTalkMessages(t: number) {
      lidas.push(t);
      return [msg(1, '2026-10-02T12:00:00Z', { type: 'incoming', author: { type: 'external' }, text: 'a' } as never), msg(2, '2026-10-14T12:00:00Z', { type: 'incoming', author: { type: 'external' }, text: 'b' } as never)];
    },
  };
  const r = await historicoOficial(k as never, 1, 500, { desde: T('2026-10-10T03:00:00Z'), ate: T('2026-10-16T02:59:59Z') });
  assert.deepEqual(lidas, [2]);
  assert.deepEqual(r.mensagens.map((m) => m.id), ['2']);
});

test('kommo_conversa: "todas" pede o teto de 500, período vira desde/ate no fuso e o corte é avisado', async () => {
  const pedidos: Array<[number, unknown]> = [];
  const fonte = fonteFalsa([leadFalso(7, '2026-10-01')]);
  fonte.conversa = async (_id, limite, periodo) => { pedidos.push([limite, periodo]); return { conversas: 3, mensagens: [], total: 800, truncado: true }; };
  const ctx = criarContextoKommo(new Map([['doutor-hernia-serra', unidadeKommo('doutor-hernia-serra', fonte)]]));
  const r = await kommoConversa(ctx, { unidade: 'serra', leadId: 7, todas: true });
  assert.equal(pedidos[0]![0], 500);
  assert.match(String(r.ficaramDeFora), /mais antigas/);
  await kommoConversa(ctx, { unidade: 'serra', leadId: 7, inicio: '2026-10-01', fim: '2026-10-16' });
  assert.equal(pedidos[1]![0], 500);
  assert.deepEqual(pedidos[1]![1], { desde: T('2026-10-01T03:00:00Z'), ate: T('2026-10-17T02:59:59Z') });
  await kommoConversa(ctx, { unidade: 'serra', leadId: 7 });
  assert.equal(pedidos[2]![0], 30);
  await assert.rejects(() => kommoConversa(ctx, { unidade: 'serra', leadId: 7, inicio: '2026-10-16', fim: '2026-10-01' }));
});

test('kommo_conversa com 403 de escopo: explica em português quem resolve, guarda a exceção original', async () => {
  const { KommoApiError } = await import('../services/kommo.service.js');
  const original = new KommoApiError('listTalkMessages(9038): Request failed with status code 403', 403, { title: 'Forbidden', detail: 'Invalid scope' });
  const fonte = fonteFalsa([leadFalso(7, '2026-10-01T12:00:00Z')]);
  fonte.conversa = async () => { throw original; };
  const ctx = criarContextoKommo(new Map([['doutor-hernia-parauapebas', unidadeKommo('doutor-hernia-parauapebas', fonte)]]));
  await assert.rejects(
    kommoConversa(ctx, { unidade: 'parauapebas', leadId: 7 }),
    (e: Error) => {
      assert.match(e.message, /Kommo de doutor-hernia-parauapebas recusou a leitura da conversa \(403\)/);
      assert.match(e.message, /token dessa conta não tem a permissão de conversas/);
      assert.match(e.message, /João/);
      assert.match(e.message, /listTalkMessages\(9038\).*403\]$/, 'a auditoria grava o status e a rota originais');
      assert.equal(e.cause, original);
      assert.equal(e.constructor.name, 'Error', 'não é "Pedido inválido": o pedido está certo');
      return true;
    },
  );
});

test('kommo_conversa com 403 SEM marca de escopo: não culpa o token, não promete nada, diz que a causa não foi identificada', async () => {
  const { KommoApiError } = await import('../services/kommo.service.js');
  const falha = async (e: Error) => {
    const fonte = fonteFalsa([leadFalso(7, '2026-10-01T12:00:00Z')]);
    fonte.conversa = async () => { throw e; };
    const ctx = criarContextoKommo(new Map([['doutor-hernia-serra', unidadeKommo('doutor-hernia-serra', fonte)]]));
    return kommoConversa(ctx, { unidade: 'serra', leadId: 7 }).then(() => null, (x: Error) => x);
  };
  for (const corpo of [{ detail: 'Forbidden' }, { title: 'Too many requests' }, null, 'texto qualquer']) {
    const original = new KommoApiError('listTalkMessages(1): Request failed with status code 403', 403, corpo);
    const x = (await falha(original))!;
    assert.match(x.message, /recusou a leitura da conversa \(403\) e o conector não identificou a causa/);
    assert.match(x.message, /excesso de chamadas/);
    assert.doesNotMatch(x.message, /token|chats|permissão de conversas|João|repetir não adianta|cartão abre|kommo_lead/i);
    assert.match(x.message, /listTalkMessages\(1\).*403\]$/);
    assert.equal(x.cause, original);
  }
});

test('kommo_conversa: outros erros passam como vieram (500, rede, 403 que não é do Kommo)', async () => {
  const { KommoApiError } = await import('../services/kommo.service.js');
  const falha = async (e: Error) => {
    const fonte = fonteFalsa([leadFalso(7, '2026-10-01T12:00:00Z')]);
    fonte.conversa = async () => { throw e; };
    const ctx = criarContextoKommo(new Map([['doutor-hernia-serra', unidadeKommo('doutor-hernia-serra', fonte)]]));
    return kommoConversa(ctx, { unidade: 'serra', leadId: 7 }).then(() => null, (x: Error) => x);
  };
  const e500 = new KommoApiError('listTalkMessages(1): Request failed with status code 500', 500, null);
  assert.equal(await falha(e500), e500);
  const rede = new Error('socket hang up');
  assert.equal(await falha(rede), rede);
  const outro403 = Object.assign(new Error('403 de outra coisa'), { status: 403, responseBody: 'Invalid scope' });
  assert.equal(await falha(outro403), outro403);
});
