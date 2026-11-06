/**
 * A leitura da conversa oficial que o botão «Sugerir motivo» e a perda-ia compartilham (06/11/2026): ordem por hora,
 * autor certo, anexos como marcas e transcrição só dos áudios MAIS RECENTES.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { lerFalasDoCartao, transcreverAudios } from './conversa-do-cartao.js';

const msg = (id: string, created_at: number, text: string, author: Record<string, unknown>, attachment?: Record<string, unknown>) => ({ id, type: 'x', text, created_at, author, attachment });

const kommo = (porTalk: Record<number, ReturnType<typeof msg>[]>) =>
  ({
    listTalks: async () => Object.keys(porTalk).map((talk_id) => ({ talk_id: Number(talk_id) })),
    listTalkMessages: async (talkId: number) => porTalk[talkId],
  }) as never;

test('junta as talks em ordem de hora, com o autor certo (external = paciente, bot = Sofia, internal = equipe)', async () => {
  const { falas, ultimaId } = await lerFalasDoCartao(
    kommo({
      1: [msg('a3', 300, 'Oi, tudo bem?', { type: 'internal', name: 'Giulia' }), msg('a1', 100, 'quanto custa?', { type: 'external' })],
      2: [msg('b2', 200, 'R$ 250', { type: 'bot', name: 'Salesbot' })],
    }),
    10,
  );
  assert.deepEqual(falas.map((f) => [f.autor, f.em]), [['PACIENTE', 100], ['SOFIA', 200], ['EQUIPE', 300]]);
  assert.equal(ultimaId, 'a3');
});

test('anexos viram marcas; áudio guarda o link; mensagem vazia some', async () => {
  const { falas } = await lerFalasDoCartao(
    kommo({ 1: [msg('1', 1, '', { type: 'external' }, { type: 'voice', link: 'http://a/1.ogg' }), msg('2', 2, '', { type: 'external' }, { type: 'picture' }), msg('3', 3, '  ', { type: 'external' })] }),
    10,
  );
  assert.equal(falas.length, 2);
  assert.equal(falas[0].texto, '[áudio]');
  assert.equal(falas[0].audioLink, 'http://a/1.ogg');
  assert.equal(falas[1].texto, '[imagem]');
});

test('transcreve só os N áudios mais recentes; falha de transcrição deixa o «[áudio]»', async () => {
  const falas = [1, 2, 3, 4].map((i) => ({ autor: 'PACIENTE' as const, texto: '[áudio]', em: i, audioLink: `l${i}` }));
  const pedidos: string[] = [];
  await transcreverAudios({} as Unit, falas, 2, (async (_u: unknown, link: string) => {
    pedidos.push(link);
    if (link === 'l3') throw new Error('falhou');
    return { text: `fala ${link}` };
  }) as never);
  assert.deepEqual(pedidos, ['l3', 'l4']);
  assert.deepEqual(falas.map((f) => f.texto), ['[áudio]', '[áudio]', '[áudio]', '(áudio) fala l4']);
});

test('áudio da Sofia/equipe não gasta transcrição, e o texto transcrito entra literal (R$$ 250 não vira outra coisa)', async () => {
  const falas = [
    { autor: 'SOFIA' as const, texto: '[áudio]', em: 1, audioLink: 'sofia' },
    { autor: 'PACIENTE' as const, texto: '[áudio]', em: 2, audioLink: 'paciente' },
  ];
  const pedidos: string[] = [];
  await transcreverAudios({} as Unit, falas, 1, (async (_u: unknown, link: string) => {
    pedidos.push(link);
    return { text: 'custa R$$ 250 $& pronto' };
  }) as never);
  assert.deepEqual(pedidos, ['paciente']);
  assert.equal(falas[1].texto, '(áudio) custa R$$ 250 $& pronto');
  assert.equal(falas[0].texto, '[áudio]');
});

test('as talks mais recentes entram primeiro no teto (a ordem da API não é garantida)', async () => {
  const k = {
    listTalks: async () => [{ talk_id: 1, updated_at: 10 }, { talk_id: 2, updated_at: 30 }, { talk_id: 3, updated_at: 20 }],
    listTalkMessages: async (talkId: number) => [msg(`t${talkId}`, talkId * 100, `da talk ${talkId}`, { type: 'external' })],
  } as never;
  const { falas } = await lerFalasDoCartao(k, 10, { maxTalks: 2 });
  assert.deepEqual(falas.map((f) => f.texto), ['da talk 2', 'da talk 3'], 'ficam as talks 2 e 3 (as mais recentes), em ordem de hora');
});
