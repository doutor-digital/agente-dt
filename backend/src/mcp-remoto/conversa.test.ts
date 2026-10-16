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
