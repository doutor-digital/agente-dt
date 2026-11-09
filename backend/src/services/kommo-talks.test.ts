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
  filtroDeEnvios,
  contaComoEnvioDaSofia,
} from './kommo-talks.service.js';
import { audiosPerdidos, blocoDaConversaOficial, selecionarItens, JANELA_AUDIO_PERDIDO_MS, JANELA_DO_TURNO_MS, temMidiaSemArquivo } from '../lib/conversa-oficial.js';

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

// ---------------------------------------------------------------- WhatsApp Lite: o áudio que chega depois do aviso (Mossoró, 09/11/2026)

const AVISO = 'Você recebeu uma mensagem de mídia (ID da mensagem: AC5FBE1D8C7FD104AC191A07E4A05ADE. Aguarde o carregamento ou a visualização da mídia no seu aplicativo móvel';
const sofia = (id: string, s: number) => raw({ id, created_at: s, type: 'outgoing', author: { type: 'bot', name: 'Salesbot' }, text: 'Entendi! onde dói?' });
const voz = (id: string, s: number, link: string | null = 'https://x/lite.ogg') => raw({ id, created_at: s, attachment: link ? { type: 'voice', link } : { type: 'voice' } });

function cenario(o: { leituras: Array<ReturnType<typeof normalizar>>; historico?: { avisoNaJanela: boolean; jaTranscritos: Set<string> } }) {
  const passos: Array<{ kind: string; title: string }> = [];
  const esperas: number[] = [];
  const transcritos: string[] = [];
  let leitura = 0;
  const args = {
    unit: { id: 'u1', slug: 'doutor-hernia-mossoro', spineTimezone: 'America/Fortaleza' } as any,
    leadId: 6478775,
    recorder: { step: async (s: any) => { passos.push(s); } } as any,
    ler: async () => o.leituras[Math.min(++leitura, o.leituras.length - 1)]!,
    msgs: o.leituras[0],
    dormir: async (ms: number) => { esperas.push(ms); },
    esperas: [4_000, 6_000, 8_000],
    historico: async () => o.historico ?? { avisoNaJanela: false, jaTranscritos: new Set<string>() },
    transcrever: async (link: string) => { transcritos.push(link); return { text: 'tenho dor na lombar há dois anos' }; },
    registrar: async () => {},
  };
  return { args, passos, esperas, transcritos, leituras: () => leitura };
}

test('Lite: o aviso chega antes do arquivo — espera, relê e transcreve o áudio quando ele carrega', async () => {
  const s = Math.floor(Date.now() / 1000);
  const semLink = normalizar([raw({ id: 't', created_at: s - 30, text: 'Sim' }), voz('v', s - 2, null)]);
  const comLink = normalizar([raw({ id: 't', created_at: s - 30, text: 'Sim' }), voz('v', s - 2)]);
  const c = cenario({ leituras: [semLink, semLink, comLink] });
  const bloco = await blocoDaConversaOficial({ ...c.args, humanMessage: `Sim\n${AVISO}`, nenhumAudioNoWebhook: true });
  assert.deepEqual(c.esperas, [4_000, 6_000], 'esperou até o áudio aparecer, e parou');
  assert.deepEqual(c.transcritos, ['https://x/lite.ogg']);
  assert.match(bloco, /\[áudio transcrito\] "tenho dor na lombar há dois anos"/);
  assert.ok(c.passos.some((p) => /carregou no Kommo depois de 10 s/.test(p.title)));
});

test('Lite: o áudio não carrega a tempo — espera as 3 vezes, segue sem e registra o motivo', async () => {
  const s = Math.floor(Date.now() / 1000);
  const semLink = normalizar([voz('v', s - 2, null)]);
  const c = cenario({ leituras: [semLink] });
  const bloco = await blocoDaConversaOficial({ ...c.args, humanMessage: AVISO, nenhumAudioNoWebhook: true });
  assert.deepEqual(c.esperas, [4_000, 6_000, 8_000]);
  assert.equal(c.transcritos.length, 0);
  assert.equal(bloco, '');
  assert.ok(c.passos.some((p) => p.kind === 'ERROR' && /não carregou no Kommo em 18 s/.test(p.title)));
});

test('sem o aviso de mídia (ou com o áudio vindo pelo webhook) não espera nada', async () => {
  const s = Math.floor(Date.now() / 1000);
  const semLink = normalizar([voz('v', s - 2, null)]);
  for (const [msg, nenhum] of [['bom dia', true], [AVISO, false]] as const) {
    const c = cenario({ leituras: [semLink] });
    await blocoDaConversaOficial({ ...c.args, humanMessage: msg, nenhumAudioNoWebhook: nenhum });
    assert.deepEqual(c.esperas, [], `${msg.slice(0, 10)} / ${nenhum}`);
  }
});

test('Lite: o áudio que a Sofia respondeu sem ouvir volta no turno seguinte, com o aviso de não pedir de novo', async () => {
  const s = Math.floor(Date.now() / 1000);
  // 07:32 áudio, 07:32 Sofia respondeu sem ele, 07:33 "Pode ser em áudio" (turno atual)
  const msgs = normalizar([voz('v', s - 40), sofia('s1', s - 38), raw({ id: 'p', created_at: s - 2, text: 'Pode ser em áudio' })]);
  const c = cenario({ leituras: [msgs], historico: { avisoNaJanela: true, jaTranscritos: new Set() } });
  const bloco = await blocoDaConversaOficial({ ...c.args, humanMessage: 'Pode ser em áudio', nenhumAudioNoWebhook: true });
  assert.deepEqual(c.esperas, [], 'sem aviso neste turno: não espera');
  assert.deepEqual(c.transcritos, ['https://x/lite.ogg']);
  assert.match(bloco, /\[áudio transcrito\] "tenho dor na lombar há dois anos"/);
  assert.match(bloco, /respondeu sem ouvi-lo[\s\S]*NÃO peça de novo[\s\S]*<\/conversa_oficial>$/);
  assert.ok(c.passos.some((p) => /não tinha ouvido: 1 recuperado/.test(p.title)));
});

test('audiosPerdidos: só com o aviso na janela, só o que nunca foi transcrito, só dentro da janela, só antes da última fala da Sofia', () => {
  const s = Math.floor(Date.now() / 1000);
  const agora = s * 1000;
  const velho = Math.floor((agora - JANELA_AUDIO_PERDIDO_MS - 60_000) / 1000);
  const msgs = normalizar([voz('antigo', velho), voz('a', s - 120), voz('b', s - 100), sofia('s1', s - 90), voz('depois', s - 10)]);
  assert.deepEqual(audiosPerdidos(msgs, agora, { avisoNaJanela: false, jaTranscritos: new Set() }), [], 'API oficial: o webhook já trouxe o áudio');
  assert.deepEqual(audiosPerdidos(msgs, agora, { avisoNaJanela: true, jaTranscritos: new Set() }).map((m) => m.id), ['a', 'b']);
  assert.deepEqual(audiosPerdidos(msgs, agora, { avisoNaJanela: true, jaTranscritos: new Set(['a']) }).map((m) => m.id), ['b']);
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

test('envios da Sofia no modo estrito: só mensagem da IA COM traceId (resposta de turno); follow-up, reativação, lembrete, cópia do Kommo e cartão não', () => {
  assert.deepEqual(filtroDeEnvios(true), { traceId: { not: null } });
  assert.deepEqual(filtroDeEnvios(false), {});
  assert.deepEqual(filtroDeEnvios(undefined), {});
  // sem o modo estrito, o comportamento antigo: tudo que não é cópia do chat oficial
  assert.equal(contaComoEnvioDaSofia({ followUp: 2 }, false), true);
  assert.equal(contaComoEnvioDaSofia({ origem: 'kommo_talks' }, false), false);
  assert.equal(contaComoEnvioDaSofia(null, undefined), true);
  // modo estrito: as exclusões da regra única da "mensagem da IA"
  assert.equal(contaComoEnvioDaSofia({ via: 'salesbot' }, true), true, 'resposta do turno via Salesbot');
  assert.equal(contaComoEnvioDaSofia({ via: 'meta', messageId: 'x' }, true), true);
  assert.equal(contaComoEnvioDaSofia(null, true), true);
  assert.equal(contaComoEnvioDaSofia({ origem: 'kommo_talks' }, true), false);
  assert.equal(contaComoEnvioDaSofia({ followUp: 2 }, true), false, 'mesmo que alguém gravasse traceId num toque da régua');
  assert.equal(contaComoEnvioDaSofia({ reactivation: 1 }, true), false);
  assert.equal(contaComoEnvioDaSofia({ origem: 'lembrete_kommo' }, true), false);
  assert.equal(contaComoEnvioDaSofia({ autor: 'equipe' }, true), false);
  assert.equal(contaComoEnvioDaSofia({ via: 'chat_cartao' }, true), false);
  assert.equal(contaComoEnvioDaSofia({ origem: 'confirmacao_d1' }, true), false);
});
