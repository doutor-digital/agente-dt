import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Unit } from '@prisma/client';
import {
  ECO_AUTOMATICO_SEG,
  _esquecerFreiosDoCrmParaTeste,
  MARCA_DO_CONVITE,
  chaveDoConviteCrm,
  convidarNoCrm,
  equipeJaRespondeu,
  eventoDeRedeSocial,
  eventoDoTextoPronto,
  marcarOrigemDoConvite,
  noConviteDoCrm,
  portasReaisDoConvite,
  slugDaCaixaSocial,
  type EventoSocial,
  type PortasDaOrigemDoConvite,
  type PortasDoConviteCrm,
} from './chatwoot-convite-whatsapp.js';
import { ID_CONVITE_WHATSAPP, _esquecerDecisoesParaTeste, textoPreEscrito } from './convite-whatsapp-estado.js';
import { _esquecerOBancoParaTeste, _semearParaTeste } from './automacoes-estado.js';
import { rotuloRoboJs } from './chatwoot-rotulo-robo.js';
import type { ConversaLida } from './chatwoot-porta.js';

const SLUG = 'doutor-hernia-parauapebas';
const CONTA = 1;
const CAIXA_IG = 7;
const CAIXA_FB = 8;
const CAIXA_ZAP = 3;
const T0 = 1_795_000_000;

beforeEach(() => {
  _semearParaTeste([]);
  _esquecerDecisoesParaTeste();
  _esquecerFreiosDoCrmParaTeste();
});
after(() => _esquecerOBancoParaTeste());

const unidade = (extra: Partial<Unit> = {}): Unit =>
  ({ id: 'u-parau', slug: SLUG, name: 'Doutor Hérnia Parauapebas', igWhatsappNumber: '(94) 98432-5883', fbWhatsappNumber: null, pausaDesde: null, pausaAte: null, ...extra }) as unknown as Unit;

const lida = (extra: Partial<ConversaLida> = {}): ConversaLida => ({ id: 50, nome: 'Fulana', telefone: null, attrs: {}, etiquetas: [], grupo: false, interno: false, ...extra });

const webhook = (extra: Record<string, unknown> = {}, canal = 'Channel::Instagram', caixa = CAIXA_IG) => ({
  event: 'message_created',
  message_type: 'incoming',
  private: false,
  content: 'Oi, quanto custa?',
  account: { id: CONTA },
  sender: { id: 910, name: 'Fulana' },
  conversation: { id: 50, inbox_id: caixa, channel: canal },
  inbox: { id: caixa },
  ...extra,
});

const evento = (extra: Partial<EventoSocial> = {}): EventoSocial => ({ conversa: 50, caixa: CAIXA_IG, canal: 'Instagram', contato: 910, mencaoEmStory: false, ...extra });

const zap = (content: string, extra: Record<string, unknown> = {}) => webhook({ content, ...extra }, 'Channel::Whatsapp', CAIXA_ZAP);

const entrada = (t = T0) => ({ message_type: 0, private: false, created_at: t, sender: { id: 910, type: 'contact' } });
const saida = (extra: Record<string, unknown> = {}) => ({ message_type: 1, private: false, created_at: T0 + 600, ...extra });

function portas(sobre: Partial<PortasDoConviteCrm> = {}) {
  const w = { publicou: [] as Array<{ texto: string; marca: Record<string, unknown> }>, notas: [] as string[], reivindicou: [] as string[], soltou: 0 };
  const vivas = new Set<string>();
  const p: PortasDoConviteCrm = {
    unidade: async () => unidade(),
    conversa: async () => lida(),
    mensagens: async () => [entrada()],
    publica: async (_id, texto, marca) => void w.publicou.push({ texto, marca }),
    nota: async (_id, t) => void w.notas.push(t),
    jaConvidado: async (c) => vivas.has(c),
    reivindicar: async (c) => {
      w.reivindicou.push(c);
      if (vivas.has(c)) return 'perdeu';
      vivas.add(c);
      return 'ganhou';
    },
    primeiraNotaDoSeco: async () => true,
    pacienteNaFranquia: async () => 'nao' as const,
    soltar: async (c) => void (w.soltou++, vivas.delete(c)),
    conectores: () => [2, 14],
    ...sobre,
  };
  return { w, p };
}
const ligar = (estado: 'ligado' | 'seco' = 'ligado') => _semearParaTeste([{ slug: SLUG, automacao: ID_CONVITE_WHATSAPP, estado }]);

// ── o evento ──────────────────────────────────────────────────────────────────────────────────

test('evento: Instagram e Facebook (e só mensagem de ENTRADA, pública)', () => {
  assert.deepEqual(eventoDeRedeSocial(webhook()), { conversa: 50, caixa: CAIXA_IG, canal: 'Instagram', contato: 910, mencaoEmStory: false });
  assert.equal(eventoDeRedeSocial(webhook({}, 'Channel::FacebookPage', CAIXA_FB))?.canal, 'Facebook');
  assert.equal(eventoDeRedeSocial(webhook({ message_type: 0 }))?.canal, 'Instagram');
  assert.equal(eventoDeRedeSocial(webhook({ message_type: 'outgoing' })), null, 'a resposta da equipe não dispara o robô');
  assert.equal(eventoDeRedeSocial(webhook({ private: true })), null);
  assert.equal(eventoDeRedeSocial(webhook({ event: 'conversation_updated' })), null);
  assert.equal(eventoDeRedeSocial(webhook({}, 'Channel::Whatsapp', CAIXA_ZAP)), null, 'WhatsApp não é canal do robô');
  assert.equal(eventoDeRedeSocial(webhook({}, 'Channel::Api')), null);
});

test('evento: Instagram que chega por uma caixa de PÁGINA do Facebook é Instagram (não Facebook)', () => {
  const ev = eventoDeRedeSocial(webhook({ conversation: { id: 50, inbox_id: CAIXA_FB, channel: 'Channel::FacebookPage', additional_attributes: { type: 'instagram_direct_message' } } }, 'Channel::FacebookPage', CAIXA_FB));
  assert.equal(ev?.canal, 'Instagram');
});

test('evento: menção em story não é mensagem para a clínica', () => {
  assert.equal(eventoDeRedeSocial(webhook({ content_attributes: { image_type: 'story_mention' } }))?.mencaoEmStory, true);
  assert.equal(eventoDeRedeSocial(webhook({ content: '[menção em story]' }))?.mencaoEmStory, true);
  assert.equal(eventoDeRedeSocial(webhook())?.mencaoEmStory, false);
});

test('a unidade da caixa social: o mapa, ou a ÚNICA unidade da conta; duas (ou nenhuma) = não adivinha', () => {
  const cfg = [{ slug: SLUG, contaId: null }, { slug: 'clinica-x', contaId: 5 }];
  assert.equal(slugDaCaixaSocial(CAIXA_IG, 1, 1, cfg), SLUG, 'a conta do ambiente é a de Parauapebas');
  assert.equal(slugDaCaixaSocial(40, 5, 1, cfg), 'clinica-x');
  assert.equal(slugDaCaixaSocial(40, 9, 1, cfg), null, 'conta desconhecida');
  assert.equal(slugDaCaixaSocial(CAIXA_IG, 1, 1, [...cfg, { slug: 'outra-na-conta-1', contaId: 1 }]), null, 'duas unidades na conta: não adivinha');
});

// ── «a equipe já respondeu» ───────────────────────────────────────────────────────────────────

test('equipe: usuário do CRM que não é o conector = equipe; conector, AgentBot e a nossa marca = robô', () => {
  assert.equal(equipeJaRespondeu([entrada(), saida({ sender: { id: 4, type: 'user' } })]), true);
  assert.equal(equipeJaRespondeu([entrada(), saida({ sender: { id: 2, type: 'user' } })]), false, 'conector (Sofia, régua)');
  assert.equal(equipeJaRespondeu([entrada(), saida({ sender: { id: 14, type: 'user' } })]), false, 'conector da conta de Timbó');
  assert.equal(equipeJaRespondeu([entrada(), saida({ sender: { id: 3, type: 'agent_bot' } })]), false);
  assert.equal(equipeJaRespondeu([entrada(), saida({ sender: { id: 4, type: 'user' }, content_attributes: { [MARCA_DO_CONVITE]: true } })]), false, 'o nosso convite (mesmo se um dia sair por outro usuário)');
  assert.equal(equipeJaRespondeu([entrada(), saida({ sender: { id: 4, type: 'user' }, content_attributes: { demora_espera: true } })]), false);
  assert.equal(equipeJaRespondeu([entrada(), saida({ sender: { id: 4, type: 'user' }, private: true })]), false, 'nota privada não é resposta');
  assert.equal(equipeJaRespondeu([entrada()]), false);
});

test('equipe: a resposta automática da Meta de uma SEGUNDA sessão (dias depois) não conta — mede-se contra a última mensagem do lead que ela responde', () => {
  const dia = 86_400;
  const msgs = [entrada(T0), saida({ created_at: T0 + 5 }), entrada(T0 + 3 * dia), saida({ created_at: T0 + 3 * dia + 4 })];
  assert.equal(equipeJaRespondeu(msgs), false);
  assert.equal(equipeJaRespondeu([...msgs, saida({ created_at: T0 + 3 * dia + 900 })]), true, 'e a atendente que responde depois conta');
});

test('equipe: resposta SEM remetente (app do Instagram) conta; a que sai em até 20 s é a resposta automática da Meta e não conta', () => {
  assert.equal(ECO_AUTOMATICO_SEG, 20);
  assert.equal(equipeJaRespondeu([entrada(), saida({ created_at: T0 + 5 })]), false, 'Facebook: mediana de 5 s');
  assert.equal(equipeJaRespondeu([entrada(), saida({ created_at: T0 + 20 })]), false);
  assert.equal(equipeJaRespondeu([entrada(), saida({ created_at: T0 + 21 })]), true);
  assert.equal(equipeJaRespondeu([entrada(), saida({ created_at: T0 + 600 })]), true, 'a atendente respondendo pelo app');
  assert.equal(equipeJaRespondeu([saida({ created_at: T0 + 5 })]), true, 'sem mensagem do lead antes dela (histórico cortado): na dúvida, conta como equipe');
});

// ── o robô: desligado não muda nada ───────────────────────────────────────────────────────────

test('DESLIGADO: nenhuma leitura, nenhuma escrita, nenhuma marca — a conversa do Instagram segue como hoje', async () => {
  let chamadas = 0;
  const tudo = new Proxy({} as PortasDoConviteCrm & PortasDaOrigemDoConvite, { get: () => async () => void chamadas++ });
  assert.deepEqual(await convidarNoCrm(evento(), CONTA, tudo, CONTA), { tipo: 'desligado' });
  assert.equal(chamadas, 0);
  // e pelo receptor de eventos: nem monta as portas (o ambiente do Chatwoot diz que a conta 1 é a de Parauapebas)
  const antes = { t: process.env.CHATWOOT_API_TOKEN, c: process.env.CHATWOOT_CONTA_ID };
  process.env.CHATWOOT_API_TOKEN = 'token-de-teste';
  process.env.CHATWOOT_CONTA_ID = '1';
  try {
    assert.deepEqual(await noConviteDoCrm(webhook(), CONTA, tudo), { tipo: 'desligado' });
    assert.equal(chamadas, 0);
    assert.equal(await noConviteDoCrm({ event: 'conversation_updated' }, CONTA, tudo), null);
    assert.equal(await noConviteDoCrm(zap(textoPreEscrito('Instagram')), CONTA, tudo), 'desligado', 'a origem pelo texto pronto também segue a chave');
    assert.equal(chamadas, 0);
  } finally {
    if (antes.t === undefined) delete process.env.CHATWOOT_API_TOKEN;
    else process.env.CHATWOOT_API_TOKEN = antes.t;
    if (antes.c === undefined) delete process.env.CHATWOOT_CONTA_ID;
    else process.env.CHATWOOT_CONTA_ID = antes.c;
  }
});

// ── seco ──────────────────────────────────────────────────────────────────────────────────────

test('SECO: deixa NOTA PRIVADA com o texto que mandaria, não envia e não gasta a marca', async () => {
  ligar('seco');
  const { w, p } = portas();
  const r = await convidarNoCrm(evento(), CONTA, p, CONTA);
  assert.equal(r.tipo, 'seco');
  assert.deepEqual(w.publicou, []);
  assert.deepEqual(w.reivindicou, []);
  assert.equal(w.notas.length, 1);
  assert.match(w.notas[0]!, /só no papel.*mandaria este convite ao WhatsApp \(Instagram\)/s);
  assert.match(w.notas[0]!, /Aqui é da Doutor Hérnia Parauapebas\./);
  assert.match(w.notas[0]!, /wa\.me\/5594984325883\?text=/);
});

test('SECO: a nota privada sai uma vez só por contato (a varredura de mensagens seguintes não empilha nota)', async () => {
  ligar('seco');
  let primeira = true;
  const { w, p } = portas({ primeiraNotaDoSeco: async () => (primeira ? ((primeira = false), true) : false) });
  await convidarNoCrm(evento(), CONTA, p, CONTA);
  await convidarNoCrm(evento(), CONTA, p, CONTA);
  assert.equal(w.notas.length, 1);
});

// ── ligado ────────────────────────────────────────────────────────────────────────────────────

test('LIGADO: manda o convite como mensagem pública com a marca do robô; a 2ª mensagem do mesmo contato não manda de novo', async () => {
  ligar('ligado');
  const { w, p } = portas();
  const a = await convidarNoCrm(evento(), CONTA, p, CONTA);
  assert.equal(a.tipo, 'enviou');
  assert.equal(w.publicou.length, 1);
  assert.deepEqual(w.publicou[0]!.marca, { convite_whatsapp: true });
  assert.match(w.publicou[0]!.texto, /^Oi! 😊 Aqui é da Doutor Hérnia Parauapebas\. Para te atender mais rápido e já ver os horários, continue pelo nosso WhatsApp: 👉 https:\/\/wa\.me\/5594984325883\?text=Ol%C3%A1!%20Vim%20pelo%20Instagram/);
  assert.deepEqual(w.reivindicou, [chaveDoConviteCrm(CONTA, evento())]);
  const b = await convidarNoCrm(evento({ conversa: 51 }), CONTA, p, CONTA); // outra conversa do MESMO contato, dentro dos 7 dias
  assert.deepEqual(b, { tipo: 'ignorou', motivo: 'ja-convidado', detalhe: undefined });
  assert.equal(w.publicou.length, 1);
});

test('LIGADO: Facebook usa o número do Facebook e o texto do Facebook', async () => {
  ligar('ligado');
  const { w, p } = portas({ unidade: async () => unidade({ fbWhatsappNumber: '(94) 91111-2222' }) });
  await convidarNoCrm(evento({ canal: 'Facebook', caixa: CAIXA_FB }), CONTA, p, CONTA);
  assert.match(w.publicou[0]!.texto, /wa\.me\/5594911112222\?text=.*Vim%20pelo%20Facebook/);
});

test('LIGADO: a mensagem é a de textoPreEscrito (o mesmo texto que marca a origem no WhatsApp)', async () => {
  ligar('ligado');
  const { w, p } = portas();
  await convidarNoCrm(evento(), CONTA, p, CONTA);
  const link = w.publicou[0]!.texto.split('👉 ')[1]!;
  assert.equal(decodeURIComponent(link.split('text=')[1]!), textoPreEscrito('Instagram'));
});

// ── os NUNCA ──────────────────────────────────────────────────────────────────────────────────

async function umNao(motivo: string, sobre: Partial<PortasDoConviteCrm> = {}, ev: Partial<EventoSocial> = {}) {
  ligar('ligado');
  _esquecerDecisoesParaTeste(); // cada caso é uma conversa nova (o robô lembra o «não» definitivo por 1 h)
  const { w, p } = portas(sobre);
  const r = await convidarNoCrm(evento(ev), CONTA, p, CONTA);
  assert.equal(r.tipo, 'ignorou', motivo);
  assert.equal((r as { motivo: string }).motivo, motivo);
  assert.deepEqual(w.publicou, [], `${motivo}: nada enviado`);
  assert.deepEqual(w.reivindicou, [], `${motivo}: a marca não é gasta`);
}

test('NUNCA: menção em story, unidade em pausa, unidade sem número', async () => {
  await umNao('menção-em-story', {}, { mencaoEmStory: true });
  await umNao('unidade-pausada', { unidade: async () => unidade({ pausaDesde: new Date(Date.now() - 3600_000), pausaAte: new Date(Date.now() + 3600_000) }) });
  await umNao('sem-numero', { unidade: async () => unidade({ igWhatsappNumber: null }) });
  await umNao('sem-numero', { unidade: async () => unidade({ igWhatsappNumber: '12345' }) });
  await umNao('sem-unidade', { unidade: async () => null });
});

test('NUNCA: conversa pausada (ia-pausada), contato interno, ou a equipe já respondeu', async () => {
  await umNao('conversa-pausada', { conversa: async () => lida({ etiquetas: ['ia-pausada'] }) });
  await umNao('conversa-pausada', { conversa: async () => lida({ interno: true }) });
  await umNao('equipe-ja-respondeu', { mensagens: async () => [entrada(), saida({ sender: { id: 4, type: 'user' } })] });
  await umNao('equipe-ja-respondeu', { mensagens: async () => [entrada(), saida({ created_at: T0 + 300 })] });
});

test('NUNCA: paciente (telefone do contato, quando há, acusa franquia); sem telefone nem consulta a franquia', async () => {
  await umNao('paciente', { conversa: async () => lida({ telefone: '+5594999990000' }), pacienteNaFranquia: async () => 'sim' as const });
  ligar('ligado');
  _esquecerDecisoesParaTeste();
  let consultou = 0;
  const { w, p } = portas({ pacienteNaFranquia: async () => (consultou++, 'sim' as const) });
  assert.equal((await convidarNoCrm(evento(), CONTA, p, CONTA)).tipo, 'enviou');
  assert.equal(consultou, 0);
  assert.equal(w.publicou.length, 1);
});

test('FALHA FECHADA: o contato tem telefone e a franquia não respondeu = não convida', async () => {
  await umNao('nao-consegui-conferir', { conversa: async () => lida({ telefone: '+5594999990000' }), pacienteNaFranquia: async () => 'nao-sei' });
});

test('SECO: a mesma conversa é decidida uma vez por hora (as leituras do Chatwoot não se repetem a cada mensagem)', async () => {
  ligar('seco');
  let leituras = 0;
  const agora = 1_800_000_000_000;
  const { w, p } = portas({ conversa: async () => (leituras++, lida()) });
  assert.equal((await convidarNoCrm(evento(), CONTA, p, CONTA, () => agora)).tipo, 'seco');
  assert.deepEqual(await convidarNoCrm(evento(), CONTA, p, CONTA, () => agora + 60_000), { tipo: 'ja-decidido' });
  assert.equal(leituras, 1);
  assert.equal(w.notas.length, 1);
  assert.equal((await convidarNoCrm(evento(), CONTA, p, CONTA, () => agora + 61 * 60_000)).tipo, 'seco', 'passada 1 h, decide de novo');
});

test('LIGADO: depois de um «não» definitivo (a equipe já respondeu) as mensagens seguintes não repetem as leituras por 1 h; falha passageira não é lembrada', async () => {
  ligar('ligado');
  let leituras = 0;
  const agora = 1_800_000_000_000;
  const { p } = portas({ mensagens: async () => (leituras++, [entrada(), saida({ sender: { id: 4, type: 'user' } })]) });
  for (let i = 0; i < 4; i++) await convidarNoCrm(evento(), CONTA, p, CONTA, () => agora + i * 1000);
  assert.equal(leituras, 1);
  let falhou = true;
  const b = portas({ conversa: async () => (falhou ? null : lida()) });
  assert.equal((await convidarNoCrm(evento({ contato: 911 }), CONTA, b.p, CONTA) as { motivo: string }).motivo, 'nao-consegui-conferir');
  falhou = false;
  assert.equal((await convidarNoCrm(evento({ contato: 911 }), CONTA, b.p, CONTA)).tipo, 'enviou');
});

test('envio RECUSADO pelo Chatwoot (4xx): nada saiu → marca devolvida e freio de 30 min; timeout/5xx: a marca FICA', async () => {
  ligar('ligado');
  const agora = 1_800_000_000_000;
  const recusa = Object.assign(new Error('Chatwoot 422'), { status: 422 });
  const { w, p } = portas({ publica: async () => Promise.reject(recusa) });
  assert.equal((await convidarNoCrm(evento(), CONTA, p, CONTA, () => agora)).tipo, 'falhou');
  assert.equal(w.soltou, 1);
  assert.equal((await convidarNoCrm(evento(), CONTA, p, CONTA, () => agora + 5 * 60_000) as { motivo: string }).motivo, 'nao-consegui-conferir', 'freado por 30 min');
  const c = portas({ publica: async () => Promise.reject(Object.assign(new Error('Chatwoot 502'), { status: 502 })) });
  assert.equal((await convidarNoCrm(evento({ contato: 912 }), CONTA, c.p, CONTA)).tipo, 'falhou');
  assert.equal(c.w.soltou, 0, '5xx: pode ter saído');
});

test('SECO: a nota privada avisa quando o contato não tem telefone (a conferência de paciente não pôde ser feita)', async () => {
  ligar('seco');
  const { w, p } = portas();
  await convidarNoCrm(evento(), CONTA, p, CONTA);
  assert.match(w.notas[0]!, /não tem telefone.*paciente/s);
  const b = portas({ conversa: async () => lida({ telefone: '+5594988887777' }) });
  await convidarNoCrm(evento({ contato: 913 }), CONTA, b.p, CONTA);
  assert.doesNotMatch(b.w.notas[0]!, /não tem telefone/);
});

test('conversa LONGA: a equipe respondeu há mais de uma página atrás — o robô volta pelas páginas e a vê; longa demais = não convida', async () => {
  const pagina = (de: number, ate: number, comEquipe = false) => ({
    payload: Array.from({ length: ate - de + 1 }, (_, i) => ({ id: de + i, message_type: comEquipe && de + i === de ? 1 : 0, private: false, created_at: T0 + de + i, sender: comEquipe && de + i === de ? { id: 4, type: 'user' } : { id: 910, type: 'contact' } })),
  });
  const consultas: string[] = [];
  const respostas = [pagina(81, 100), pagina(61, 80), pagina(41, 60, true)];
  const ctx = {
    conta: { url: 'https://crm.exemplo', conta: 1, token: 'tok' },
    agora: Date.now,
    pendentes: new Map(),
    avisar: () => undefined,
    fetch: (async (url: string) => {
      consultas.push(String(url));
      return new Response(JSON.stringify(respostas.shift() ?? { payload: [] }), { status: 200 });
    }) as unknown as typeof fetch,
  };
  const msgs = await portasReaisDoConvite(ctx as never).mensagens(50);
  assert.equal(msgs.length, 60, 'três páginas lidas');
  assert.match(consultas[1]!, /before=81/);
  assert.match(consultas[2]!, /before=61/);
  assert.equal(equipeJaRespondeu(msgs), true, 'a fala da equipe de 3 páginas atrás foi vista');
  const sempre = { ...ctx, fetch: (async () => new Response(JSON.stringify(pagina(1, 20)), { status: 200 })) as unknown as typeof fetch };
  await assert.rejects(() => portasReaisDoConvite(sempre as never).mensagens(50), /longa demais/);
});

test('FALHA FECHADA: conversa ilegível, Chatwoot ou banco que não respondem = não convida e não gasta a marca', async () => {
  await umNao('nao-consegui-conferir', { conversa: async () => null });
  await umNao('nao-consegui-conferir', { mensagens: async () => Promise.reject(new Error('500')) });
  await umNao('nao-consegui-conferir', { jaConvidado: async () => Promise.reject(new Error('banco fora')) });
  ligar('ligado');
  const { w, p } = portas({ reivindicar: async () => 'incerto' });
  assert.equal((await convidarNoCrm(evento(), CONTA, p, CONTA) as { motivo: string }).motivo, 'nao-consegui-conferir');
  assert.deepEqual(w.publicou, []);
});

test('envio que lança: a marca FICA (pode ter saído) e a próxima mensagem não repete', async () => {
  ligar('ligado');
  let tentativas = 0;
  const { p } = portas({ publica: async () => (tentativas++, Promise.reject(new Error('timeout'))) });
  assert.equal((await convidarNoCrm(evento(), CONTA, p, CONTA)).tipo, 'falhou');
  assert.equal((await convidarNoCrm(evento(), CONTA, p, CONTA) as { motivo: string }).motivo, 'ja-convidado');
  assert.equal(tentativas, 1);
});

// ── a origem pelo texto pronto ────────────────────────────────────────────────────────────────

const CAIXAS = { [CAIXA_ZAP]: SLUG };

test('texto pronto: só mensagem de ENTRADA numa caixa de WhatsApp do mapa; o lead pode acrescentar algo', () => {
  assert.deepEqual(eventoDoTextoPronto(zap(textoPreEscrito('Instagram')), CAIXAS), { conversa: 50, caixa: CAIXA_ZAP, contato: 910, canal: 'Instagram' });
  assert.equal(eventoDoTextoPronto(zap('Olá! Vim pelo Facebook e quero saber mais. Vocês atendem sábado?'), CAIXAS)?.canal, 'Facebook');
  assert.equal(eventoDoTextoPronto(zap('olá, vim pelo site e quero saber mais'), CAIXAS), null);
  assert.equal(eventoDoTextoPronto(zap(textoPreEscrito('Instagram'), { message_type: 'outgoing' }), CAIXAS), null);
  assert.equal(eventoDoTextoPronto(webhook({ content: textoPreEscrito('Instagram') }), CAIXAS), null, 'caixa que não é de WhatsApp do mapa');
});

function portasDaOrigem(atual: Record<string, unknown> = {}, opcoes: string[] = ['Meta Ads', 'Instagram', 'Facebook']) {
  const w = { gravou: [] as Array<[number, string]> };
  const p: PortasDaOrigemDoConvite = {
    contato: async () => atual,
    opcoesDaOrigem: async () => opcoes,
    gravarOrigem: async (c, v) => void w.gravou.push([c, v]),
  };
  return { w, p };
}
const evZap = { conversa: 50, caixa: CAIXA_ZAP, contato: 910, canal: 'Instagram' as const };

test('origem: desligado não lê nada; seco só loga; ligado grava Instagram/Facebook no contato', async () => {
  const { w, p } = portasDaOrigem();
  let leu = 0;
  const espiao: PortasDaOrigemDoConvite = { ...p, contato: async () => (leu++, {}) };
  assert.equal(await marcarOrigemDoConvite(evZap, espiao, CAIXAS), 'desligado');
  assert.equal(leu, 0);
  ligar('seco');
  assert.equal(await marcarOrigemDoConvite(evZap, p, CAIXAS), 'seco');
  assert.deepEqual(w.gravou, []);
  ligar('ligado');
  assert.equal(await marcarOrigemDoConvite(evZap, p, CAIXAS), 'gravada');
  assert.equal(await marcarOrigemDoConvite({ ...evZap, canal: 'Facebook' }, p, CAIXAS), 'gravada');
  assert.deepEqual(w.gravou, [[910, 'Instagram'], [910, 'Facebook']]);
});

test('origem: NUNCA sobrescreve origem que já tem valor, e não grava opção que a conta não tem', async () => {
  ligar('ligado');
  const a = portasDaOrigem({ origem: 'Meta Ads' });
  assert.equal(await marcarOrigemDoConvite(evZap, a.p, CAIXAS), 'ja-tem');
  assert.deepEqual(a.w.gravou, []);
  const b = portasDaOrigem({}, ['Meta Ads', 'Google', 'Orgânico']); // a conta 1 hoje: sem Instagram/Facebook na lista
  assert.equal(await marcarOrigemDoConvite(evZap, b.p, CAIXAS), 'sem-opcao');
  assert.deepEqual(b.w.gravou, []);
});

test('origem: erro do Chatwoot é «erro», não «já tem origem»', async () => {
  ligar('ligado');
  const p: PortasDaOrigemDoConvite = { contato: async () => Promise.reject(new Error('500')), opcoesDaOrigem: async () => [], gravarOrigem: async () => undefined };
  assert.equal(await marcarOrigemDoConvite(evZap, p, CAIXAS), 'erro');
});

test('origem: a atendente preenche enquanto lemos a lista → não sobrescreve (relê antes de gravar)', async () => {
  ligar('ligado');
  const w = { gravou: 0, leituras: 0 };
  const p: PortasDaOrigemDoConvite = {
    contato: async () => (w.leituras++ === 0 ? {} : { origem: 'Indicação' }),
    opcoesDaOrigem: async () => ['Instagram'],
    gravarOrigem: async () => void w.gravou++,
  };
  assert.equal(await marcarOrigemDoConvite(evZap, p, CAIXAS), 'ja-tem');
  assert.equal(w.gravou, 0);
});

// ── a fiação ──────────────────────────────────────────────────────────────────────────────────

test('fiação: o receptor de eventos do Chatwoot chama o robô, e o rótulo do CRM reconhece a marca do convite', () => {
  const ia = readFileSync(new URL('./chatwoot-ia.ts', import.meta.url), 'utf8');
  assert.match(ia, /import \{ noConviteDoCrm \} from '\.\/chatwoot-convite-whatsapp\.js'/);
  assert.match(ia, /void noConviteDoCrm\(req\.body, conta\)/);
  const js = rotuloRoboJs({} as NodeJS.ProcessEnv);
  assert.match(js, /ca\.convite_whatsapp\) return \{ t: 'auto' \}/);
});
