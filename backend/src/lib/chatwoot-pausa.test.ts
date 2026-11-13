/**
 * Pausa da IA: pessoa respondendo (Chatwoot ou celular) pausa; o robô (usuário 2) não; quem pausa assume; resolver reativa; a Sofia
 * fica calada com a etiqueta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estadoDaPausa, ETIQUETA_PAUSA, eventoDePausa, eventoDeReativacao, pausar, reativar, type ConversaDaPausa, type PortaDaPausa } from './chatwoot-pausa.js';
import { motivoDeNaoResponder } from './chatwoot-sofia.js';

const CAIXAS = { 3: 'doutor-hernia-parauapebas' };
const base = { event: 'message_created', message_type: 'outgoing', private: false, conversation: { id: 50, inbox_id: 3 }, content_attributes: {} };

test('pausa: pessoa pelo Chatwoot pausa e é a autora', () => {
  assert.deepEqual(eventoDePausa({ ...base, sender: { id: 6, type: 'user', name: 'Lorena' } }, CAIXAS), {
    conversa: 50, slug: 'doutor-hernia-parauapebas', autor: { tipo: 'pessoa', id: 6, nome: 'Lorena' },
  });
});

test('pausa: eco do celular (external_echo, sem remetente) e o usuário 7 do Evolution pausam como celular', () => {
  assert.deepEqual(eventoDePausa({ ...base, sender: null, content_attributes: { external_echo: true } }, CAIXAS)?.autor, { tipo: 'celular' });
  assert.deepEqual(eventoDePausa({ ...base, sender: { id: 7, type: 'user', name: '📱 Celular da unidade' } }, CAIXAS)?.autor, { tipo: 'celular' });
});

test('pausa: NÃO pausa com robô (usuário 2), nota privada, mensagem do paciente, caixa fora do mapa', () => {
  assert.equal(eventoDePausa({ ...base, sender: { id: 2, type: 'user', name: 'Conector Claude' } }, CAIXAS), null);
  assert.equal(eventoDePausa({ ...base, private: true, sender: { id: 6, type: 'user' } }, CAIXAS), null);
  assert.equal(eventoDePausa({ ...base, message_type: 'incoming', sender: { id: 9, type: 'contact' } }, CAIXAS), null);
  assert.equal(eventoDePausa({ ...base, conversation: { id: 50, inbox_id: 4 }, sender: { id: 6, type: 'user' } }, CAIXAS), null);
  assert.equal(eventoDePausa({ ...base, event: 'conversation_updated' }, CAIXAS), null);
  assert.equal(eventoDePausa({ ...base, sender: { id: 5, type: 'agent_bot' } }, CAIXAS), null);
});

test('reativação: só conversa resolvida e pausada de caixa do mapa', () => {
  const r = { event: 'conversation_updated', status: 'resolved', id: 50, inbox_id: 3, labels: [ETIQUETA_PAUSA, 'quente'] };
  assert.deepEqual(eventoDeReativacao(r, CAIXAS), { conversa: 50 });
  assert.equal(eventoDeReativacao({ ...r, status: 'open' }, CAIXAS), null);
  assert.equal(eventoDeReativacao({ ...r, labels: ['quente'] }, CAIXAS), null);
  assert.equal(eventoDeReativacao({ ...r, inbox_id: 4 }, CAIXAS), null);
});

function porta(c: ConversaDaPausa) {
  const feitos: string[] = [];
  const atual = { ...c, etiquetas: [...c.etiquetas], attrs: { ...c.attrs } };
  const p: PortaDaPausa = {
    conversa: async () => ({ ...atual, etiquetas: [...atual.etiquetas], attrs: { ...atual.attrs } }),
    etiquetas: async (_id, l) => { atual.etiquetas = l; feitos.push(`etiquetas ${l.join(',')}`); },
    atribuir: async (_id, u) => { atual.atendente = u; feitos.push(`atribuir ${u}`); },
    atributos: async (_id, a) => { atual.attrs = a; feitos.push(`attrs ${Object.keys(a).sort().join(',')}`); },
    nota: async (_id, t) => { feitos.push(`nota ${t.slice(0, 40)}`); },
    agora: () => new Date('2026-11-13T18:00:00Z'),
  };
  return { p, feitos, atual };
}

test('pausar: etiqueta, quem/quando, atribui a quem respondeu e nota — uma vez só', async () => {
  const { p, feitos, atual } = porta({ etiquetas: ['quente'], atendente: 4, attrs: { etapa: 'Sofia qualifica' } });
  assert.equal(await pausar(50, { tipo: 'pessoa', id: 6, nome: 'Lorena' }, p), 'pausou');
  assert.deepEqual(atual.etiquetas, ['quente', ETIQUETA_PAUSA]);
  assert.equal(atual.atendente, 6);
  assert.equal(atual.attrs.ia_pausada_por, 'Lorena');
  assert.equal(atual.attrs.etapa, 'Sofia qualifica');
  assert.ok(feitos.some((f) => f.startsWith('nota ⏸ IA pausada')));
  const n = feitos.length;
  assert.equal(await pausar(50, { tipo: 'pessoa', id: 6, nome: 'Lorena' }, p), 'ja-pausada');
  assert.equal(feitos.length, n, 'já pausada e já dela: nada novo');
});

test('pausar pelo celular não mexe em quem atende', async () => {
  const { p, atual } = porta({ etiquetas: [], atendente: 4, attrs: {} });
  await pausar(50, { tipo: 'celular' }, p);
  assert.equal(atual.atendente, 4);
  assert.equal(atual.attrs.ia_pausada_por, 'celular');
});

test('reativar: tira etiqueta e quem/quando, mantém o resto; sem pausa não faz nada', async () => {
  const { p, atual } = porta({ etiquetas: ['quente', ETIQUETA_PAUSA], atendente: 6, attrs: { etapa: 'Agendado', ia_pausada_por: 'Lorena', ia_pausada_em: 'x' } });
  assert.equal(await reativar(50, 'Cleia', p), 'reativou');
  assert.deepEqual(atual.etiquetas, ['quente']);
  assert.deepEqual(atual.attrs, { etapa: 'Agendado' });
  assert.equal(await reativar(50, 'Cleia', p), 'nao-estava-pausada');
});

test('estado para o painel e a Sofia calada com a etiqueta', () => {
  assert.deepEqual(estadoDaPausa({ etiquetas: [ETIQUETA_PAUSA], atendente: 6, attrs: { ia_pausada_por: 'Lorena', ia_pausada_em: '2026-11-13T18:00:00.000Z' } }), {
    pausada: true, por: 'Lorena', em: '2026-11-13T18:00:00.000Z',
  });
  assert.deepEqual(estadoDaPausa({ etiquetas: [], atendente: null, attrs: { ia_pausada_por: 'velho' } }), { pausada: false, por: null, em: null });
  const lida = { id: 1, nome: 'Maria', telefone: '+5594', attrs: {}, etiquetas: [ETIQUETA_PAUSA], grupo: false, interno: false };
  assert.equal(motivoDeNaoResponder(lida), 'ia-pausada');
  assert.equal(motivoDeNaoResponder({ ...lida, etiquetas: [] }), null);
});
