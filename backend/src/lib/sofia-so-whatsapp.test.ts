import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DECISAO_CANAL_NAO_PERMITIDO,
  TITULO_CANAL_CALADO,
  _esquecerOrigensParaTeste,
  cartaoDeRedeSocialCalado,
  decidirCanal,
  origemDeRedeSocial,
  origemDoPayload,
  origemDoTalkMaisRecente,
  pacienteDeRedeSocialCalado,
  portaDoCanal,
  sofiaSoWhatsappEstado,
  type GravadorDoCanal,
} from './sofia-so-whatsapp.js';
import { _esquecerOBancoParaTeste, _semearParaTeste } from './automacoes-estado.js';
import { automacaoPorId, verificarCatalogo } from './automacoes.js';

const TATUI = 'doutor-hernia-tatui';
const SALTO = 'doutor-hernia-salto';

beforeEach(() => {
  _semearParaTeste([]);
  _esquecerOrigensParaTeste();
});
after(() => _esquecerOBancoParaTeste());

function gravador() {
  const w = { steps: [] as Array<{ kind: string; title: string; payload: unknown }>, finais: [] as Array<{ iaDecision: string; latencyMs: number }> };
  const g: GravadorDoCanal = {
    step: async (s) => void w.steps.push({ kind: s.kind, title: s.title, payload: s.payload }),
    finalizar: async (iaDecision, latencyMs) => void w.finais.push({ iaDecision, latencyMs }),
  };
  return { w, g };
}

// ── a chave ────────────────────────────────────────────────────────────────────────────────────

test('a chave nasce DESLIGADA, está no catálogo (com seco) e o catálogo continua válido', () => {
  const a = automacaoPorId('sofia-so-whatsapp');
  assert.ok(a);
  assert.equal(a.chave, 'SOFIA_SO_WHATSAPP_SLUGS');
  assert.equal(a.temSeco, true);
  assert.equal(a.quandoVazio, 'desligado');
  assert.deepEqual(verificarCatalogo(), []);
  // sem linha na tela e sem .env: desligada em toda unidade
  assert.equal(sofiaSoWhatsappEstado(TATUI, undefined), 'desligado');
  assert.equal(sofiaSoWhatsappEstado(SALTO, ''), 'desligado');
});

test('o estado vem da tela (por unidade) e, sem linha, do .env', () => {
  _semearParaTeste([
    { slug: TATUI, automacao: 'sofia-so-whatsapp', estado: 'ligado' },
    { slug: SALTO, automacao: 'sofia-so-whatsapp', estado: 'seco' },
  ]);
  assert.equal(sofiaSoWhatsappEstado(TATUI, undefined), 'ligado');
  assert.equal(sofiaSoWhatsappEstado(SALTO, undefined), 'seco');
  assert.equal(sofiaSoWhatsappEstado('doutor-hernia-timbo', undefined), 'desligado', 'outra unidade não muda');
  _semearParaTeste([]);
  assert.equal(sofiaSoWhatsappEstado(TATUI, `${TATUI}`), 'ligado');
  assert.equal(sofiaSoWhatsappEstado(SALTO, `${TATUI}`), 'desligado');
});

// ── a origem ───────────────────────────────────────────────────────────────────────────────────

test('origem de rede social: instagram/facebook/messenger, sem diferenciar maiúsculas; WhatsApp, vazio e desconhecido não', () => {
  for (const o of ['instagram_business', 'facebook', 'Instagram', 'FACEBOOK', 'facebook_messenger', 'messenger']) assert.equal(origemDeRedeSocial(o), true, o);
  for (const o of ['waba', 'com.amocrm.amocrmwa', 'telegram', '', undefined, null]) assert.equal(origemDeRedeSocial(o), false, String(o));
});

test('origemDoPayload: lê a 1ª mensagem ENTRANTE, em lista ou em objeto de índices; saída, widget e adiado não têm origem', () => {
  assert.equal(origemDoPayload({ message: { add: [{ type: 'incoming', origin: 'instagram_business' }] } }), 'instagram_business');
  assert.equal(origemDoPayload({ message: { add: [{ origin: 'facebook' }] } }), 'facebook', 'sem `type` = entrante (como o webhook trata)');
  assert.equal(origemDoPayload({ message: { add: { '0': { type: 'incoming', origin: 'waba' } } } }), 'waba');
  assert.equal(origemDoPayload({ message: { add: [{ type: 'outgoing', origin: 'instagram_business' }, { type: 'incoming', origin: 'waba' }] } }), 'waba');
  assert.equal(origemDoPayload({ message: { add: [{ type: 'outgoing', origin: 'facebook' }] } }), null);
  assert.equal(origemDoPayload({ via: 'widget_request', message: 'oi' }), null);
  assert.equal(origemDoPayload({ via: 'unidade_ganha', textos: ['oi'] }), null);
  assert.equal(origemDoPayload(null), null);
  assert.equal(origemDoPayload('x'), null);
});

// ── o webhook: a matriz do pedido ──────────────────────────────────────────────────────────────

test('chave DESLIGADA: Instagram e Facebook seguem como hoje (a Sofia responde), sem registrar nada', async () => {
  for (const origem of ['instagram_business', 'facebook']) {
    const { w, g } = gravador();
    assert.equal(await portaDoCanal({ slug: TATUI, leadId: 1, origem, estado: 'desligado' }, g), 'segue');
    assert.deepEqual(w, { steps: [], finais: [] });
  }
});

test('LIGADA + instagram_business: cala, step COMPLETED com o título claro e decisão __channel_not_allowed__', async () => {
  const { w, g } = gravador();
  assert.equal(await portaDoCanal({ slug: TATUI, leadId: 7, origem: 'instagram_business', estado: 'ligado', latenciaMs: () => 42 }, g), 'calou');
  assert.equal(w.steps.length, 1);
  assert.equal(w.steps[0]!.kind, 'COMPLETED');
  assert.equal(w.steps[0]!.title, TITULO_CANAL_CALADO);
  assert.match(w.steps[0]!.title, /Instagram\/Facebook — a Sofia não responde esse canal nesta unidade \(quem atende é a equipe\)/);
  assert.deepEqual(w.finais, [{ iaDecision: '__channel_not_allowed__', latencyMs: 42 }]);
  assert.equal(DECISAO_CANAL_NAO_PERMITIDO, '__channel_not_allowed__');
});

test('LIGADA + facebook (e Messenger): cala do mesmo jeito', async () => {
  for (const origem of ['facebook', 'Messenger']) {
    const { w, g } = gravador();
    assert.equal(await portaDoCanal({ slug: SALTO, leadId: 8, origem, estado: 'ligado' }, g), 'calou', origem);
    assert.equal(w.finais[0]!.iaDecision, '__channel_not_allowed__');
  }
});

test('LIGADA + WhatsApp (waba, Lite) ou origem ausente: a Sofia responde, nada é registrado', async () => {
  for (const origem of ['waba', 'com.amocrm.amocrmwa', undefined, null, '', 'telegram']) {
    const { w, g } = gravador();
    assert.equal(await portaDoCanal({ slug: TATUI, leadId: 9, origem, estado: 'ligado' }, g), 'segue', String(origem));
    assert.deepEqual(w, { steps: [], finais: [] });
  }
});

test('SECO + instagram: responde (segue), registra que calaria e NÃO finaliza o trace', async () => {
  const { w, g } = gravador();
  assert.equal(await portaDoCanal({ slug: TATUI, leadId: 10, origem: 'instagram_business', estado: 'seco' }, g), 'segue');
  assert.equal(w.finais.length, 0, 'seco não termina o turno');
  assert.equal(w.steps.length, 1);
  assert.equal(w.steps[0]!.kind, 'THINKING');
  assert.match(w.steps[0]!.title, /só no papel.*calada.*instagram_business/);
  assert.equal((w.steps[0]!.payload as { reason: string }).reason, 'sofia_so_whatsapp_seco');
});

test('sem `estado` explícito a porta lê a chave da unidade (a tela manda)', async () => {
  _semearParaTeste([{ slug: TATUI, automacao: 'sofia-so-whatsapp', estado: 'ligado' }]);
  const a = gravador();
  assert.equal(await portaDoCanal({ slug: TATUI, leadId: 1, origem: 'instagram_business' }, a.g), 'calou');
  const b = gravador();
  assert.equal(await portaDoCanal({ slug: SALTO, leadId: 1, origem: 'instagram_business' }, b.g), 'segue', 'a outra unidade segue respondendo');
});

test('mensagem do webhook SEM origem, em cartão cuja última origem conhecida é instagram_business, com a chave LIGADA: a Sofia RESPONDE (não herda o canal)', async () => {
  _semearParaTeste([{ slug: TATUI, automacao: 'sofia-so-whatsapp', estado: 'ligado' }]);
  const origemDosTraces = async () => 'instagram_business'; // o cartão escreveu pelo Instagram antes
  // a porta do webhook só olha a origem da mensagem: a leitura dos traces nem existe nela
  for (const origem of [null, undefined, '']) {
    const { w, g } = gravador();
    assert.equal(await portaDoCanal({ slug: TATUI, leadId: 1, origem }, g), 'segue', String(origem));
    assert.deepEqual(w, { steps: [], finais: [] });
  }
  // o contraste: o worker (sem mensagem) CALA esse mesmo cartão pela última origem
  assert.equal(await pacienteDeRedeSocialCalado({ id: 'u1', slug: TATUI }, 1, { origem: origemDosTraces }), true);
  // e a mensagem de WhatsApp de hoje, com origem, também segue
  const { g } = gravador();
  assert.equal(await portaDoCanal({ slug: TATUI, leadId: 1, origem: 'waba' }, g), 'segue');
});

test('decidirCanal é puro e cobre os três estados', () => {
  assert.deepEqual(decidirCanal('ligado', 'facebook'), { acao: 'calar', origem: 'facebook' });
  assert.deepEqual(decidirCanal('seco', 'facebook'), { acao: 'seco', origem: 'facebook' });
  assert.deepEqual(decidirCanal('desligado', 'facebook'), { acao: 'segue' });
  assert.deepEqual(decidirCanal('ligado', 'waba'), { acao: 'segue' });
});

// ── o que sai por iniciativa nossa (escada, reativação, cutucada) ───────────────────────────────

test('iniciativa própria: chave desligada ou em seco NÃO lê nada e não cala', async () => {
  let leu = 0;
  const origem = async () => (leu++, 'instagram_business');
  for (const estado of ['desligado', 'seco'] as const) {
    assert.equal(await pacienteDeRedeSocialCalado({ id: 'u1', slug: TATUI }, 5, { estado, origem }), false);
  }
  assert.equal(leu, 0);
});

test('iniciativa própria: LIGADA cala quem é de Instagram/Facebook e deixa o WhatsApp (e o desconhecido) passar', async () => {
  const u = { id: 'u1', slug: TATUI };
  assert.equal(await pacienteDeRedeSocialCalado(u, 1, { estado: 'ligado', origem: async () => 'instagram_business' }), true);
  assert.equal(await pacienteDeRedeSocialCalado(u, 2, { estado: 'ligado', origem: async () => 'facebook' }), true);
  assert.equal(await pacienteDeRedeSocialCalado(u, 3, { estado: 'ligado', origem: async () => 'waba' }), false);
  assert.equal(await pacienteDeRedeSocialCalado(u, 4, { estado: 'ligado', origem: async () => null }), false, 'sem origem registrada = segue como hoje');
});

test('iniciativa própria: a varredura de minuto a minuto não relê o banco a cada passada (memória de 10 min, por cartão)', async () => {
  const u = { id: 'u1', slug: TATUI };
  let leu = 0;
  let agora = 1_000_000;
  const deps = { estado: 'ligado' as const, origem: async () => (leu++, 'facebook'), agora: () => agora };
  assert.equal(await pacienteDeRedeSocialCalado(u, 1, deps), true);
  agora += 60_000;
  assert.equal(await pacienteDeRedeSocialCalado(u, 1, deps), true);
  assert.equal(leu, 1);
  assert.equal(await pacienteDeRedeSocialCalado(u, 2, deps), true, 'outro cartão pergunta de novo');
  assert.equal(leu, 2);
  agora += 11 * 60_000;
  await pacienteDeRedeSocialCalado(u, 1, deps);
  assert.equal(leu, 3, 'passada a validade, relê (quem trocou de canal volta a ser atendido)');
});

test('iniciativa própria: erro ao ler a origem NÃO vira «é WhatsApp» lembrado por 10 min (segue nesta passada, pergunta de novo na próxima)', async () => {
  const u = { id: 'u1', slug: TATUI };
  let tentativas = 0;
  const deps = {
    estado: 'ligado' as const,
    origem: async () => {
      if (++tentativas === 1) throw new Error('banco fora');
      return 'instagram_business';
    },
  };
  assert.equal(await pacienteDeRedeSocialCalado(u, 1, deps), false);
  assert.equal(await pacienteDeRedeSocialCalado(u, 1, deps), true, 'a falha não ficou na memória');
  assert.equal(tentativas, 2);
});

test('cutucada: além dos traces olha a conversa do Kommo (a equipe pode ter puxado o assunto, sem mensagem do paciente)', async () => {
  const u = { id: 'u1', slug: TATUI };
  const semTrace = async () => null;
  const talks = (origin: string) => async () => [
    { origin: 'waba', updated_at: 1 },
    { origin, updated_at: 9 },
  ];
  assert.equal(await cartaoDeRedeSocialCalado(u, 1, talks('instagram_business'), { estado: 'ligado', origem: semTrace }), true);
  assert.equal(await cartaoDeRedeSocialCalado(u, 2, talks('waba'), { estado: 'ligado', origem: semTrace }), false);
  let leu = 0;
  const conta = async () => (leu++, [{ origin: 'facebook', updated_at: 1 }]);
  assert.equal(await cartaoDeRedeSocialCalado(u, 3, conta, { estado: 'seco', origem: semTrace }), false);
  assert.equal(await cartaoDeRedeSocialCalado(u, 3, conta, { estado: 'desligado', origem: semTrace }), false);
  assert.equal(leu, 0, 'desligada ou em seco não lê a conversa');
  // Kommo fora do ar: segue como WhatsApp (a leitura seguinte da cutucada também falharia)
  const quebra = async (): Promise<Array<{ origin?: string | null }>> => {
    throw new Error('403');
  };
  assert.equal(await cartaoDeRedeSocialCalado(u, 4, quebra, { estado: 'ligado', origem: semTrace }), false);
  // conversa antiga e encerrada de Instagram não decide por cima da que está em atendimento no WhatsApp
  const viva = async () => [
    { origin: 'instagram_business', updated_at: 99, is_in_work: false },
    { origin: 'waba', updated_at: 5, is_in_work: true },
  ];
  assert.equal(await cartaoDeRedeSocialCalado(u, 5, viva, { estado: 'ligado', origem: semTrace }), false);
  assert.equal(origemDoTalkMaisRecente([]), null);
  assert.equal(origemDoTalkMaisRecente([{ origin: null }]), null);
});

// ── fiação (o que um teste de unidade não alcança: a ordem e os pontos de chamada) ───────────────

const fonte = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('webhook: a porta do canal vem DEPOIS de voltar-da-espera e ANTES de Whisper, visão e fora do horário (sem custo, mesmo bookkeeping)', () => {
  const src = fonte('../controllers/webhook.controller.ts');
  const turno = src.slice(src.indexOf('async function processarTurno'));
  const pos = (t: string) => {
    const i = turno.indexOf(t);
    assert.ok(i > 0, `não achei ${t}`);
    return i;
  };
  const ordem = [pos('await voltarDaEsperaNoTurno('), pos('await portaDoCanal('), pos('await transcribeAudio('), pos('await describeImage('), pos('checkBusinessHours(unit)')];
  assert.deepEqual([...ordem].sort((a, b) => a - b), ordem);
  assert.match(turno, /porta === 'calou'[\s\S]{0,300}return TURNO_PULADO/);
  assert.match(turno.slice(pos('await portaDoCanal(') - 120, pos('await portaDoCanal(')), /passadoPelaPonteAgora/, 'a Ponte passa');
});

test('escada, reativação e cutucada: a porta vem ANTES de qualquer envio (e a reativação, antes de despausar o cartão)', () => {
  const escada = fonte('./follow-up-worker.ts');
  assert.ok(escada.indexOf('pacienteDeRedeSocialCalado(') > 0);
  assert.ok(escada.indexOf('pacienteDeRedeSocialCalado(') < escada.indexOf('reserva = await prisma.conversation.updateMany'));
  assert.ok(escada.indexOf('pacienteDeRedeSocialCalado(') > escada.indexOf('const proximo = ESCADA_DA_REGRA[alvo]'), 'só quem tem degrau devido');
  assert.ok(escada.indexOf('pacienteDeRedeSocialCalado(') < escada.indexOf('await enviarDegrau('));
  const reativacao = fonte('./reactivation-worker.ts');
  assert.ok(reativacao.indexOf('pacienteDeRedeSocialCalado(') > 0);
  assert.ok(reativacao.indexOf('pacienteDeRedeSocialCalado(') < reativacao.indexOf('setLeadFieldFlag('));
  assert.ok(reativacao.indexOf('pacienteDeRedeSocialCalado(') < reativacao.indexOf('sendChatReply('));
  const cutucada = fonte('./cutucada-apos-equipe-worker.ts');
  assert.ok(cutucada.indexOf('cartaoDeRedeSocialCalado(') > 0);
  assert.ok(cutucada.indexOf('cartaoDeRedeSocialCalado(') < cutucada.indexOf('deps.escrever('), 'nem gasta o modelo');
  assert.ok(cutucada.indexOf('cartaoDeRedeSocialCalado(') < cutucada.indexOf('await enviar(unit'));
});
