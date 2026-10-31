import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classificarAutor,
  decidirCobranca,
  desdeUltimaFalaDaSofia,
  estadoDeLeitura,
  normalizar,
  renderConversaOficial,
  ESPERA_SEM_LEITURA_MS,
} from './kommo-talks.service.js';
import { selecionarItens, JANELA_DO_TURNO_MS, temMidiaSemArquivo } from '../lib/conversa-oficial.js';

const t0 = 1_789_222_000; // segundos
const raw = (over: Partial<Parameters<typeof normalizar>[0][number]> & { id: string }) => ({
  type: 'incoming',
  text: '',
  created_at: t0,
  author: { type: 'external', name: 'Maria' },
  attachment: null,
  delivery_status: 'sent',
  ...over,
});

test('classificarAutor: paciente, Salesbot (Sofia), usuário "Doutor Digital" (Sofia em voz) e SDR (equipe)', () => {
  assert.equal(classificarAutor({ type: 'incoming', author: { type: 'external', name: 'Maria' } }), 'paciente');
  assert.equal(classificarAutor({ type: 'outgoing', author: { type: 'bot', name: 'Salesbot' } }), 'sofia');
  assert.equal(classificarAutor({ type: 'outgoing', author: { type: 'internal', name: 'Doutor Digital' } }), 'sofia');
  assert.equal(classificarAutor({ type: 'outgoing', author: { type: 'internal', name: 'Néia' } }), 'equipe');
});

test('normalizar ordena do mais antigo para o mais novo e desdeUltimaFalaDaSofia corta na última fala dela', () => {
  const msgs = normalizar([
    raw({ id: '4', created_at: t0 + 40, type: 'outgoing', author: { type: 'internal', name: 'Néia' }, text: 'Oi, sou a Néia' }),
    raw({ id: '1', created_at: t0 + 10, text: 'oi' }),
    raw({ id: '2', created_at: t0 + 20, type: 'outgoing', author: { type: 'bot', name: 'Salesbot' }, text: 'Olá! Sou a Sofia' }),
    raw({ id: '3', created_at: t0 + 30, text: 'quero marcar' }),
    raw({ id: '5', created_at: t0 + 50, text: 'pode ser quinta?' }),
  ]);
  assert.deepEqual(msgs.map((m) => m.id), ['1', '2', '3', '4', '5']);
  const depois = desdeUltimaFalaDaSofia(msgs);
  assert.deepEqual(depois.map((m) => `${m.autor}:${m.id}`), ['paciente:3', 'equipe:4', 'paciente:5']);
});

test('selecionarItens: tira a Sofia, o que já está na entrada do turno e o que é do turno atual', () => {
  const agora = (t0 + 400) * 1000;
  const msgs = normalizar([
    raw({ id: 'a', created_at: t0 + 10, text: 'quero marcar' }), // ficou para trás (6,5 min)
    raw({ id: 'b', created_at: t0 + 20, type: 'outgoing', author: { type: 'internal', name: 'Néia' }, text: 'Oi! Tem quinta 10h' }),
    raw({ id: 'c', created_at: t0 + 30, text: 'pode ser' }), // já está na entrada do turno
    raw({ id: 'd', created_at: t0 + 395, text: 'na verdade sexta' }), // turno atual (< 3 min)
  ]);
  const itens = selecionarItens(msgs, 'pode ser', agora);
  assert.deepEqual(itens.map((m) => m.id), ['a', 'b']);
  assert.ok(JANELA_DO_TURNO_MS >= 60_000);
});

test('temMidiaSemArquivo: reconhece o aviso do WhatsApp Lite e não confunde com texto comum', () => {
  assert.equal(temMidiaSemArquivo('Você recebeu uma mensagem de mídia (ID da mensagem: ACC7E9C93B42E8053461CB284EAA)'), true);
  assert.equal(temMidiaSemArquivo("'messageContextInfo' is not yet supported. Use your device to view this message."), true);
  assert.equal(temMidiaSemArquivo('Bom dia, quero marcar'), false);
});

test('selecionarItens: áudio do turno que o webhook não trouxe (WhatsApp Lite) entra; sem o aviso, continua fora', () => {
  const agora = (t0 + 400) * 1000;
  const msgs = normalizar([
    raw({ id: 'v', created_at: t0 + 395, attachment: { type: 'voice', link: 'https://x/lite.ogg' } }), // turno atual, só pela rota oficial
    raw({ id: 'f', created_at: t0 + 396, attachment: { type: 'picture', link: 'https://x/foto.jpg' } }),
    raw({ id: 'p', created_at: t0 + 397, text: 'Você recebeu uma mensagem de mídia (ID da mensagem: ACC7E9C9)' }),
  ]);
  const aviso = 'Você recebeu uma mensagem de mídia (ID da mensagem: ACC7E9C9)';
  assert.deepEqual(selecionarItens(msgs, aviso, agora, true).map((m) => m.id), ['v']);
  assert.deepEqual(selecionarItens(msgs, aviso, agora, false).map((m) => m.id), []);
  assert.deepEqual(selecionarItens(msgs, aviso, agora).map((m) => m.id), []);
});

test('renderConversaOficial: com equipe no meio, manda não repetir nem se reapresentar', () => {
  const msgs = normalizar([
    raw({ id: 'b', created_at: t0 + 20, type: 'outgoing', author: { type: 'internal', name: 'Néia' }, text: 'Tem quinta 10h' }),
    raw({ id: 'c', created_at: t0 + 30, attachment: { type: 'voice', link: 'https://x/y.ogg' } }),
  ]);
  const bloco = renderConversaOficial([msgs[0], { ...msgs[1], transcricao: 'pode ser quinta' }]);
  assert.match(bloco, /<conversa_oficial>/);
  assert.match(bloco, /Equipe \(Néia\): "Tem quinta 10h"/);
  assert.match(bloco, /Paciente: \[áudio transcrito\] "pode ser quinta"/);
  assert.match(bloco, /NÃO repita nem contradiga/);
  assert.equal(renderConversaOficial([]), '');
});

test('decidirCobranca: lida → cobra; só enviada há 1 h → espera; há 7 h → cobra; erro → para', () => {
  const base = { ultimaEntradaEm: new Date((t0 - 100) * 1000), equipeFalouPorUltimo: false };
  const em = new Date(t0 * 1000);
  const agora1h = new Date(t0 * 1000 + 3600_000);
  assert.equal(decidirCobranca({ ...base, ultimaSaida: { em, status: 'seen', autor: 'sofia' } }, agora1h), 'cobrar');
  assert.equal(decidirCobranca({ ...base, ultimaSaida: { em, status: 'sent', autor: 'sofia' } }, agora1h), 'esperar_leitura');
  assert.equal(decidirCobranca({ ...base, ultimaSaida: { em, status: 'delivered', autor: 'sofia' } }, new Date(t0 * 1000 + ESPERA_SEM_LEITURA_MS)), 'cobrar');
  assert.equal(decidirCobranca({ ...base, ultimaSaida: { em, status: 'error', autor: 'sofia' } }, agora1h), 'parar_nao_entregue');
});

test('decidirCobranca: equipe falou por último ou paciente respondeu depois → não é caso de cobrança', () => {
  const em = new Date(t0 * 1000);
  const agora = new Date(t0 * 1000 + 3600_000);
  assert.equal(decidirCobranca({ ultimaSaida: { em, status: 'seen', autor: 'equipe' }, ultimaEntradaEm: null, equipeFalouPorUltimo: true }, agora), 'parar_equipe');
  assert.equal(
    decidirCobranca({ ultimaSaida: { em, status: 'seen', autor: 'sofia' }, ultimaEntradaEm: new Date(t0 * 1000 + 60_000), equipeFalouPorUltimo: false }, agora),
    'parar_paciente_respondeu',
  );
  const estado = estadoDeLeitura(normalizar([
    raw({ id: '1', created_at: t0, type: 'outgoing', author: { type: 'bot', name: 'Salesbot' }, text: 'oi', delivery_status: 'seen' }),
    raw({ id: '2', created_at: t0 + 10, type: 'outgoing', author: { type: 'internal', name: 'Néia' }, text: 'assumi', delivery_status: 'sent' }),
  ]));
  assert.equal(estado.equipeFalouPorUltimo, true);
  assert.equal(estado.ultimaSaida?.autor, 'equipe');
});

// ── a equipe invisível de Canaã (17/10, lead 28339048) ──

test('classificarAutor: o app WhatsApp Business é a EQUIPE, mesmo marcado como robô pelo Kommo', () => {
  assert.equal(classificarAutor({ type: 'outgoing', author: { type: 'bot', name: 'WhatsApp Business' } }), 'equipe');
  assert.equal(classificarAutor({ type: 'outgoing', author: { type: 'bot', name: 'Salesbot' } }), 'sofia');
});

test('normalizar marca a sessão "Doutor Digital" (pode ser a Sofia em voz ou a equipe); robô não', () => {
  const msgs = normalizar([
    raw({ id: '1', type: 'outgoing', author: { type: 'internal', name: 'Doutor Digital' }, text: 'Agendada consulta para dia 19/10 às 11h00✅' }),
    raw({ id: '2', created_at: t0 + 5, type: 'outgoing', author: { type: 'bot', name: 'Salesbot' }, text: 'Olá!' }),
  ]);
  assert.equal(msgs[0]!.pelaSessao, true);
  assert.equal(msgs[1]!.pelaSessao, undefined);
});

test('separarSessaoDaEquipe: "Doutor Digital" sem envio do agente na janela é a equipe; com envio, é a Sofia', async () => {
  const { separarSessaoDaEquipe, JANELA_DO_ENVIO_MS } = await import('./kommo-talks.service.js');
  const msgs = normalizar([
    raw({ id: '1', created_at: t0, text: 'Sim consigo' }),
    raw({ id: '2', created_at: t0 + 3600, type: 'outgoing', author: { type: 'internal', name: 'Doutor Digital' }, text: 'Agendada consulta para dia 19/10 às 11h00✅' }),
    raw({ id: '3', created_at: t0 + 7200, type: 'outgoing', author: { type: 'internal', name: 'Doutor Digital' }, attachment: { type: 'voice', link: 'x' } as never }),
    raw({ id: '4', created_at: t0 + 7300, type: 'outgoing', author: { type: 'bot', name: 'Salesbot' }, text: 'Lembrete' }),
  ]);
  // o agente só registrou a resposta em voz (1 min antes de ela aparecer no Kommo)
  const envios = [new Date((t0 + 7200) * 1000 - 60_000)];
  const r = separarSessaoDaEquipe(msgs, envios);
  assert.deepEqual(r.map((m) => m.autor), ['paciente', 'equipe', 'sofia', 'sofia']);
  // fora da janela não é dela
  assert.equal(separarSessaoDaEquipe(msgs, [new Date((t0 + 7200) * 1000 + JANELA_DO_ENVIO_MS + 1000)])[2]!.autor, 'equipe');
});

test('com a equipe separada, a Sofia enxerga o "Agendada consulta" antes de responder', async () => {
  const { separarSessaoDaEquipe } = await import('./kommo-talks.service.js');
  const msgs = separarSessaoDaEquipe(
    normalizar([
      raw({ id: '1', created_at: t0, type: 'outgoing', author: { type: 'bot', name: 'Salesbot' }, text: 'Consegue segunda às 11h?' }),
      raw({ id: '2', created_at: t0 + 60, text: 'Sim consigo' }),
      raw({ id: '3', created_at: t0 + 3600, type: 'outgoing', author: { type: 'bot', name: 'WhatsApp Business' }, text: 'Agendada consulta para dia 19/10 às 11h00✅' }),
      raw({ id: '4', created_at: t0 + 9000, text: 'Ok' }),
    ]),
    [],
  );
  const desde = desdeUltimaFalaDaSofia(msgs);
  assert.deepEqual(desde.map((m) => m.id), ['2', '3', '4']);
  assert.match(renderConversaOficial(desde), /Equipe \(WhatsApp Business\): "Agendada consulta/);
  assert.match(renderConversaOficial(desde), /NÃO repita nem contradiga o que a equipe disse/);
});
