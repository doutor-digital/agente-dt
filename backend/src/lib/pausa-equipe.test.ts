import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import {
  CORRIDA_DA_IA_MS,
  JANELA_DA_EQUIPE_MS,
  conferirEquipe,
  descreverFala,
  ehRespostaAutomatica,
  equipeComAPalavra,
  estadoDaPausaPelaEquipe,
  falaDaEquipeDepoisDe,
  falaDaEquipeDesde,
  falasHumanasDaEquipe,
  minutosDaVolta,
  portaDaEquipe,
  travaAntesDeEnviar,
  MOTIVO_HANDOFF_CALADO,
  type DepsAntesDeEnviar,
  type DepsPausaEquipe,
} from './pausa-equipe.js';
import { _limparPausasProprias, handoffDaSofiaDesde, pausouSozinhaDesde, registrarPausaPropria } from './pausa-propria.js';
import { _semearParaTeste } from './automacoes-estado.js';
import { automacaoPorId } from './automacoes.js';
import { normalizar, type MensagemOficial } from '../services/kommo-talks.service.js';
import type { KommoTalkMessage } from '../services/kommo.service.js';
import { roboSaiuDepois } from './recuperar-turnos.js';
import type { Simulacao } from './so-no-papel.js';

/**
 * Prioridade 3 da lista de 21/10/2026: com a equipe já conversando, a Sofia respondia por cima. O caso que
 * guia os testes é o de Bebedouro (lead 6374469, 20/10): a secretária Melissa se apresentou pelo celular da
 * clínica às 10:25 e a Sofia respondeu às 12:28, 12:36, 12:55 e 13:23.
 */

beforeEach(() => {
  _semearParaTeste([]);
  _limparPausasProprias();
});

const SLUG = 'doutor-hernia-bebedouro';
const unidade = {
  id: 'u-beb',
  slug: SLUG,
  kommoSubdomain: 'doutorherniabebedouro',
  kommoAccessToken: 'x',
  kommoPausedFieldId: 777,
  spineTimezone: 'America/Sao_Paulo',
} as unknown as Unit;
const LEAD = 6374469;

const em = (hhmmss: string) => new Date(`2026-10-20T${hhmmss}-03:00`);
let seq = 0;
const msg = (
  direcao: 'entrada' | 'saida',
  quando: Date,
  texto: string,
  autor: MensagemOficial['autor'] = direcao === 'entrada' ? 'paciente' : 'equipe',
  autorNome = direcao === 'entrada' ? '' : 'WhatsApp Business',
  anexo: MensagemOficial['anexo'] = null,
): MensagemOficial => ({ id: String(++seq), em: quando, direcao, autor, autorNome, texto, anexo, status: null });

const AUSENCIA_RIO_VERDE =
  '⏰Nosso horário de atendimento é de segundas à sexta-feiras, 07h às 19h. Não estamos disponíveis no momento, mas retornaremos assim que possível.';

// a conversa de Bebedouro, como a rota oficial devolve
const conversaBebedouro = (): MensagemOficial[] => [
  msg('entrada', new Date('2026-10-20T00:46:30-03:00'), '17 98143-8710'),
  msg('saida', new Date('2026-10-20T00:46:50-03:00'), 'Anotado! Qual é o seu nome?', 'sofia', 'Salesbot'),
  msg('saida', em('10:25:51'), 'Olá Dona Nilza Bom dia tudo bem?'),
  msg('saida', em('10:26:06'), 'Meu nome é Melissa sou Secretária da Clínica Doutor Hérnia.'),
  msg('entrada', em('12:28:26'), 'Nilza Maria Balieiro Lugato'),
];

// ── resposta automática do WhatsApp Business ────────────────────────────────────────────────────

test('ausência do WhatsApp Business (Rio Verde, 23:59, no mesmo minuto do paciente) não é fala da equipe', () => {
  const entrada = msg('entrada', new Date('2026-10-20T23:59:10-03:00'), 'tem sim principalmente no trabalho');
  const ausencia = msg('saida', new Date('2026-10-20T23:59:12-03:00'), AUSENCIA_RIO_VERDE);
  const msgs = [entrada, ausencia];
  assert.equal(ehRespostaAutomatica(ausencia, msgs), true);
  assert.deepEqual(falasHumanasDaEquipe(msgs), []);
});

test('pelo celular, áudio e texto curto logo depois do paciente são gente; texto longo minutos depois também', () => {
  const entrada = msg('entrada', em('12:50:00'), 'qual o valor?');
  const audio = msg('saida', em('12:50:03'), '', 'equipe', 'WhatsApp Business', { tipo: 'voice', link: null });
  const curto = msg('saida', em('12:50:06'), 'Tenho sim.');
  const longo = msg('saida', em('12:53:00'), 'Nilza vamos agendar um horário! Tenho agenda disponível dia 22/10 às 09:00 da manhã, pode ser?');
  const msgs = [entrada, audio, curto, longo];
  assert.equal(ehRespostaAutomatica(audio, msgs), false);
  assert.equal(ehRespostaAutomatica(curto, msgs), false);
  assert.equal(ehRespostaAutomatica(longo, msgs), false);
  assert.equal(falasHumanasDaEquipe(msgs).length, 3);
});

test('aviso do sistema ("Unable to open this message…") nunca conta como equipe', () => {
  const aviso = msg('saida', em('09:00:00'), 'Unable to open this message. Ask the contact to send it in a supported WhatsApp format.');
  assert.equal(ehRespostaAutomatica(aviso, [aviso]), true);
});

test('texto longo de usuário do Kommo com nome, colado na mensagem do paciente, é gente (só o app do celular tem resposta automática)', () => {
  const entrada = msg('entrada', em('09:00:00'), 'oi');
  const sdr = msg('saida', em('09:00:05'), 'Olá, seja bem-vindo! Me chamo Talita, sou secretária da Clínica Doutor Hérnia.', 'equipe', 'Talita');
  assert.equal(ehRespostaAutomatica(sdr, [entrada, sdr]), false);
});

// ── quem tem a palavra ──────────────────────────────────────────────────────────────────────────

test('Bebedouro 6374469: a Melissa falou depois da última mensagem da Sofia → a equipe tem a palavra', () => {
  const d = equipeComAPalavra(conversaBebedouro(), new Date('2026-10-20T00:46:50-03:00'), em('12:28:30'));
  assert.equal(d.motivo, null);
  assert.equal(d.fala?.texto, 'Meu nome é Melissa sou Secretária da Clínica Doutor Hérnia.');
});

test('a Sofia falou depois da equipe (reativação, devolução) → a conversa é dela', () => {
  const d = equipeComAPalavra(conversaBebedouro(), em('11:00:00'), em('12:28:30'));
  assert.deepEqual([d.fala, d.motivo], [null, 'ia_falou_depois']);
});

test('fala da equipe com mais de 24 h não pausa (ligar a chave não varre conversa antiga)', () => {
  const agora = new Date(em('10:26:06').getTime() + JANELA_DA_EQUIPE_MS + 60_000);
  const d = equipeComAPalavra(conversaBebedouro(), null, agora);
  assert.deepEqual([d.fala, d.motivo], [null, 'antiga']);
});

// ── janela da porta: 60 min (a da volta) SÓ para o app "WhatsApp Lite"; os demais seguem com 24 h ──────────

const DIA = '2026-11-18';
const noDia = (hhmmss: string) => new Date(`${DIA}T${hhmmss}-03:00`);
const JANELA_LITE = minutosDaVolta({} as NodeJS.ProcessEnv) * 60_000;
const BUSINESS = { type: 'bot', name: 'WhatsApp Business' };
const USUARIO_KOMMO = { type: 'internal', name: 'Talita' };
/** Sofia falou de manhã; a equipe (pelo app `quem`) falou em `quandoEquipe`; o paciente escreveu depois. */
const conversaDaEquipe = (quem: { type: string; name: string }, quandoEquipe: string, quandoPaciente: string): MensagemOficial[] =>
  normalizar([
    bruta('1', `${DIA}T05:00:00-03:00`, 'outgoing', { type: 'bot', name: 'Salesbot' }, 'Oi! Aqui é a Sofia, da Doutor Hérnia.'),
    bruta('2', `${DIA}T${quandoEquipe}-03:00`, 'outgoing', quem, 'Poderia me enviar o seu nome completo por gentileza ?'),
    bruta('3', `${DIA}T${quandoPaciente}-03:00`, 'incoming', { type: 'external', name: 'Paciente' }, 'Claro, é Maria da Silva'),
  ]);
const decide = (msgs: MensagemOficial[], agora: string, cutucada: Date | null = null) =>
  equipeComAPalavra(msgs, noDia('05:00:00'), noDia(agora), cutucada, JANELA_LITE);

test('Petrópolis, 20h: fala do Lite às 15h (5 h antes) → a Sofia responde (a volta já teria soltado e não responde a mensagem que ficou)', () => {
  const d = decide(conversaDaEquipe(LITE, '15:00:00', '20:00:00'), '20:00:10');
  assert.deepEqual([d.fala, d.motivo], [null, 'antiga']);
});

test('Caxias: fala do Lite há 10 min → a Sofia pausa', () => {
  const d = decide(conversaDaEquipe(LITE, '08:10:00', '08:20:00'), '08:20:10');
  assert.equal(d.motivo, null);
  assert.equal(d.fala?.texto, 'Poderia me enviar o seu nome completo por gentileza ?');
});

test('fala do Lite há 61 min → a Sofia responde; há 59 min → pausa; a janela é a passada por quem chama (a da volta)', () => {
  const msgs = conversaDaEquipe(LITE, '08:00:00', '09:01:00');
  assert.equal(decide(msgs, '09:01:00').motivo, 'antiga');
  assert.equal(decide(msgs, '08:59:00').motivo, null);
  assert.equal(minutosDaVolta({ PAUSA_EQUIPE_VOLTA_MIN: '120' } as NodeJS.ProcessEnv), 120);
  assert.equal(equipeComAPalavra(msgs, noDia('05:00:00'), noDia('09:01:00'), null, 120 * 60_000).motivo, null);
});

test('Business (Timbó) e usuário do Kommo: a fala de 2 h antes AINDA pausa — a janela é a de 24 h do main (Bebedouro)', () => {
  for (const quem of [BUSINESS, USUARIO_KOMMO]) {
    const msgs = conversaDaEquipe(quem, '08:00:00', '10:00:00');
    assert.equal(decide(msgs, '10:00:10').motivo, null, quem.name);
    assert.equal(decide(conversaDaEquipe(quem, '08:00:00', '10:00:00'), '10:00:10').fala?.autorNome, quem.name);
    // e só deixa de pausar passadas as 24 h
    assert.equal(equipeComAPalavra(msgs, noDia('05:00:00'), new Date(noDia('08:00:00').getTime() + JANELA_DA_EQUIPE_MS + 60_000), null, JANELA_LITE).motivo, 'antiga');
  }
});

test('equipeComAPalavra é pura: sem a janela do Lite passada, o Lite usa as mesmas 24 h (não lê PAUSA_EQUIPE_VOLTA_MIN)', () => {
  const msgs = conversaDaEquipe(LITE, '08:00:00', '16:00:00');
  assert.equal(equipeComAPalavra(msgs, noDia('05:00:00'), noDia('16:00:10')).motivo, null);
});

test('cutucada DEPOIS da equipe: a janela de 24 h conta a partir da cutucada, como no main, inclusive para o Lite', () => {
  for (const quem of [LITE, BUSINESS]) {
    const msgs = conversaDaEquipe(quem, '08:00:00', '16:00:00');
    // com a cutucada às 10h (depois da equipe), o paciente que responde às 16h ainda está na conversa da equipe
    assert.equal(decide(msgs, '16:00:10', noDia('10:00:00')).motivo, null, quem.name);
  }
  // sem cutucada, o Lite de 8 h atrás libera; o Business de 8 h atrás ainda pausa
  assert.equal(decide(conversaDaEquipe(LITE, '08:00:00', '16:00:00'), '16:00:10').motivo, 'antiga');
  assert.equal(decide(conversaDaEquipe(BUSINESS, '08:00:00', '16:00:00'), '16:00:10').motivo, null);
});

test('conferirEquipe (porta, trava e recuperar-turnos): fala do Lite de 2 h atrás não pausa; a do Business de 2 h atrás ainda pausa e vira «equipe na conversa»', async () => {
  const agora = noDia('10:00:10');
  for (const [quem, pausa] of [[LITE, false], [BUSINESS, true]] as const) {
    const { deps } = depsFalsas({
      agora: () => agora,
      mensagens: async () => conversaDaEquipe(quem, '08:00:00', '10:00:00'),
      ultimaFalaDaIa: async () => noDia('05:00:00'),
    });
    const r = await conferirEquipe(unidade, LEAD, deps);
    assert.equal(!!r.fala, pausa, quem.name);
    assert.equal(r.motivo, pausa ? null : 'antiga', quem.name);
  }
});

// ── a corrida: a Sofia respondeu logo DEPOIS da fala da equipe, que ainda não estava na conversa oficial ──────────
// Salto, lead 3185496 (17/11): áudio da secretária (WhatsApp Business) 16:17:20; Sofia 16:17:50, 16:18:31 e 16:19:39; nenhuma pausa registrada.

const SALTO_DIA = '2026-11-17';
const noSalto = (hhmmss: string) => new Date(`${SALTO_DIA}T${hhmmss}-03:00`);
const conversaDoJailton = (): MensagemOficial[] => [
  msg('saida', noSalto('16:16:00'), '❗️ IMPORTANTE Para a sua consulta de hoje, traga seus exames. Ficou alguma dúvida?', 'sofia', 'Salesbot'),
  msg('entrada', noSalto('16:16:51'), 'Tenho uma dúvida'),
  msg('entrada', noSalto('16:17:16'), 'Era 150'),
  msg('saida', noSalto('16:17:20'), '', 'equipe', 'WhatsApp Business', { tipo: 'voice', link: null }),
  msg('entrada', noSalto('16:17:52'), 'Vcs tem acesso a ressonância da Unimed ?'),
];

test('Salto 3185496: a Sofia que saiu 30 s, 71 s ou 3 min depois do áudio da equipe é corrida — a equipe segue com a palavra', () => {
  for (const ia of ['16:17:50', '16:18:31', '16:20:20']) {
    const d = equipeComAPalavra(conversaDoJailton(), noSalto(ia), noSalto('16:20:30'));
    assert.equal(d.motivo, null, ia);
    assert.equal(d.fala?.autorNome, 'WhatsApp Business', ia);
  }
  assert.equal(CORRIDA_DA_IA_MS, 3 * 60_000);
});

test('a Sofia 3 min e 1 s depois da fala (ou mais) é devolução de verdade; a de antes da fala nunca foi problema', () => {
  const d = equipeComAPalavra(conversaDoJailton(), noSalto('16:20:21'), noSalto('16:21:00'));
  assert.deepEqual([d.fala, d.motivo], [null, 'ia_falou_depois']);
  assert.equal(equipeComAPalavra(conversaDoJailton(), noSalto('16:30:00'), noSalto('16:31:00')).motivo, 'ia_falou_depois');
  assert.equal(equipeComAPalavra(conversaDoJailton(), noSalto('16:16:30'), noSalto('16:17:55')).motivo, null);
});

test('conferirEquipe no Salto 3185496: a 2ª tentativa (16:18:31) vê a Sofia das 16:17:50 e ainda pausa pela fala da equipe', async () => {
  const { deps } = depsFalsas({
    agora: () => noSalto('16:18:31'),
    mensagens: async () => conversaDoJailton(),
    ultimaFalaDaIa: async () => noSalto('16:17:50'),
  });
  const r = await conferirEquipe(unidade, LEAD, deps);
  assert.equal(r.motivo, null);
  assert.ok(r.fala);
});

test('a corrida não vence a devolução explícita: caixinha desmarcada depois da fala devolve mesmo com a Sofia dentro dos 3 min', async () => {
  const { deps } = depsFalsas({
    agora: () => noSalto('16:18:31'),
    mensagens: async () => conversaDoJailton(),
    ultimaFalaDaIa: async () => noSalto('16:17:50'),
    pausaMexidaDesde: async () => true,
    pausaMarcadaAgora: async () => false,
  });
  const r = await conferirEquipe(unidade, LEAD, deps);
  assert.deepEqual([r.fala, r.motivo], [null, 'devolvida']);
});

test('só robô (Salesbot, régua, transmissão) e resposta automática do app não dão a palavra à equipe', () => {
  const entrada = msg('entrada', em('23:59:10'), 'oi');
  const msgs = [
    entrada,
    msg('saida', em('23:59:12'), AUSENCIA_RIO_VERDE),
    msg('saida', em('23:59:30'), 'Oi! Sou a Sofia 😊', 'sofia', 'Salesbot'),
  ];
  const d = equipeComAPalavra(msgs, null, em('23:59:40'));
  assert.deepEqual([d.fala, d.motivo], [null, 'sem_equipe']);
});

test('descreverFala diz quem e quando, sem jargão', () => {
  assert.equal(descreverFala({ autorNome: 'WhatsApp Business', em: em('10:25:51') }), 'o celular da clínica (WhatsApp Business) em 20/10, 10:25');
  assert.equal(descreverFala({ autorNome: 'Giulia', em: em('10:25:51') }), 'Giulia em 20/10, 10:25');
});

// ── WhatsApp Lite (QR code): Caxias 3526512 e Petrópolis, 18/11/2026 ─────────────────────────────

const AUSENCIA_PETROPOLIS =
  'Agradecemos o seu contato! \nNosso atendimento é de segunda a sexta de 07:30 às 19:30 e aos sábados de 09:00 às 13:00. Retornaremos assim que possível.';
const SOFIA_AGORA = new Date('2026-11-18T08:10:40-03:00');
/** Como a rota /talks devolve: o celular da clínica pelo Lite é autor `bot` "WhatsApp Lite"; a Sofia, `bot` "Salesbot". */
const bruta = (id: string, quando: string, type: 'incoming' | 'outgoing', autor: { type: string; name: string }, text: string): KommoTalkMessage => ({
  id,
  type,
  text,
  created_at: Math.floor(new Date(quando).getTime() / 1000),
  author: autor,
});
const LITE = { type: 'bot', name: 'WhatsApp Lite' };

test('Caxias 3526512 (18/11): fala da Jéssica pelo Lite depois da Sofia → a equipe tem a palavra (conversa lida como a rota devolve)', () => {
  const msgs = normalizar([
    bruta('1', '2026-11-18T08:10:07-03:00', 'incoming', { type: 'external', name: 'Leonardo' }, 'Bom dia\nEstou precisando da nota fiscal das minhas sessões'),
    bruta('2', '2026-11-18T08:10:40-03:00', 'outgoing', { type: 'bot', name: 'Salesbot' }, 'Bom dia! ☺ Claro, a nota fiscal é emitida certo pela nossa equipe'),
    bruta('3', '2026-11-18T08:10:45-03:00', 'outgoing', LITE, 'Poderia por gentileza me enviar seu nome completo ?'),
    bruta('4', '2026-11-18T08:11:07-03:00', 'incoming', { type: 'external', name: 'Leonardo' }, 'Leonardo Costa da Silva'),
  ]);
  assert.deepEqual(msgs.map((m) => m.autor), ['paciente', 'sofia', 'equipe', 'paciente']);
  const d = equipeComAPalavra(msgs, SOFIA_AGORA, new Date('2026-11-18T08:11:20-03:00'));
  assert.equal(d.motivo, null);
  assert.equal(d.fala?.texto, 'Poderia por gentileza me enviar seu nome completo ?');
  assert.equal(descreverFala({ autorNome: 'WhatsApp Lite', em: d.fala!.em }), 'o celular da clínica (WhatsApp Lite) em 18/11, 08:10');
});

test('Petrópolis, 22h: a ausência "Agradecemos o seu contato!…" do Lite NÃO pausa a Sofia (nem a que chega 229 s depois)', async () => {
  _semearParaTeste([{ slug: SLUG, automacao: 'pausa-equipe', estado: 'ligado' }]);
  const msgs = normalizar([
    bruta('1', '2026-11-17T21:59:00-03:00', 'outgoing', { type: 'bot', name: 'Salesbot' }, 'Oi! Aqui é a Sofia, da Doutor Hérnia Petrópolis.'),
    bruta('2', '2026-11-17T22:00:05-03:00', 'incoming', { type: 'external', name: 'Paciente' }, 'Boa noite, queria saber o valor da consulta'),
    bruta('3', '2026-11-17T22:00:09-03:00', 'outgoing', LITE, AUSENCIA_PETROPOLIS),
    bruta('4', '2026-11-17T22:04:00-03:00', 'outgoing', LITE, AUSENCIA_PETROPOLIS), // chegou 229 s depois: a regra de tempo não a pegaria
  ]);
  assert.deepEqual(msgs.map((m) => m.autor), ['sofia', 'paciente', 'equipe', 'equipe']);
  assert.equal(ehRespostaAutomatica(msgs[2], msgs), true);
  assert.equal(ehRespostaAutomatica(msgs[3], msgs), true);
  assert.deepEqual(falasHumanasDaEquipe(msgs), []);
  const { deps, chamadas } = depsFalsas({
    agora: () => new Date('2026-11-17T22:04:30-03:00'),
    mensagens: async () => msgs,
    ultimaFalaDaIa: async () => new Date('2026-11-17T21:59:00-03:00'),
  });
  const r = await portaDaEquipe({ unit: unidade, leadId: LEAD }, deps);
  assert.equal(r.pausou, false);
  assert.equal(chamadas.marcarPausa, 0);
});

test('Lite: o aviso «messageContextInfo» não é fala da equipe', () => {
  const aviso = msg('saida', em('11:00:10'), "'messageContextInfo' is not yet supported. Use your device to view this message.", 'equipe', 'WhatsApp Lite');
  assert.equal(ehRespostaAutomatica(aviso, [aviso]), true);
  assert.deepEqual(falasHumanasDaEquipe([aviso]), []);
});

test('Lite: o robô de Retomada ("Passando novamente…", Caxias) é ROBÔ como o Salesbot — não pausa a Sofia e conta como robô na recuperação de turnos', () => {
  const msgs = normalizar([
    bruta('1', '2026-11-17T10:50:00-03:00', 'incoming', { type: 'external', name: 'Paciente' }, 'quero saber do tratamento'),
    bruta('2', '2026-11-17T10:58:55-03:00', 'outgoing', LITE, 'Oi! Passando novamente porque vi que você procurou ajuda para sua coluna. Você já tentou algum tratamento antes?'),
  ]);
  assert.equal(msgs[1].autor, 'sofia');
  assert.deepEqual(falasHumanasDaEquipe(msgs), []);
  assert.equal(equipeComAPalavra(msgs, null, new Date('2026-11-17T11:00:00-03:00')).motivo, 'sem_equipe');
  assert.equal(roboSaiuDepois(msgs, new Date('2026-11-17T10:50:00-03:00')), true);
  // a mesma frase com anexo (ou de outro autor humano) não é tratada como robô
  assert.equal(normalizar([bruta('3', '2026-11-17T11:00:00-03:00', 'outgoing', { type: 'internal', name: 'Talita' }, 'Oi! Passando novamente porque vi que você procurou ajuda')])[0].autor, 'equipe');
});

test('Lite: a regra de TEMPO não vale — fala humana longa logo depois do paciente pausa; no Business continua automática (como hoje)', () => {
  const entrada = msg('entrada', em('09:00:00'), 'oi');
  const lite = msg('saida', em('09:00:05'), 'Há quanto tempo ela vem sentindo essas dores ?', 'equipe', 'WhatsApp Lite');
  const business = msg('saida', em('09:00:05'), 'Há quanto tempo ela vem sentindo essas dores ?', 'equipe', 'WhatsApp Business');
  assert.equal(ehRespostaAutomatica(lite, [entrada, lite]), false);
  assert.equal(falasHumanasDaEquipe([entrada, lite]).length, 1);
  assert.equal(ehRespostaAutomatica(business, [entrada, business]), true);
});

test('Lite: modelo de "confirmar sua sessão" e "parcela em aberto" são fala da equipe (a Sofia pausa nesses pacientes em tratamento)', () => {
  const sessao = msg(
    'saida',
    em('08:23:17'),
    '*CLÍNICA DOUTOR HÉRNIA DUQUE DE CAXIAS:*\nOlá, aqui é da Clínica Doutor Hérnia! 😀\n\nEstou entrando em contato para confirmar sua sessão agendada para:\n*Dia 19/11/26 às 18:30*',
    'equipe',
    'WhatsApp Lite',
  );
  const parcela = msg('saida', em('09:24:46'), 'Bom dia Sra Priscila tudo bem? 😊\n\nPassando para lembrar que ficou em aberto a parcela do seu tratamento, no valor de R$ 1.225,00', 'equipe', 'WhatsApp Lite');
  assert.equal(ehRespostaAutomatica(sessao, [sessao]), false);
  assert.equal(ehRespostaAutomatica(parcela, [parcela]), false);
  assert.equal(falasHumanasDaEquipe([sessao, parcela]).length, 2);
});

test('WhatsApp Business: a ausência fora dos 20 s segue sendo fala (regra de tempo de sempre); o texto sem regra de tempo vale só para o Lite', () => {
  const entrada = msg('entrada', em('23:59:10'), 'oi');
  const tarde = msg('saida', em('00:03:00'), AUSENCIA_RIO_VERDE);
  assert.equal(ehRespostaAutomatica(tarde, [entrada, tarde]), false);
  const liteTarde = msg('saida', em('00:03:00'), AUSENCIA_RIO_VERDE, 'equipe', 'WhatsApp Lite');
  assert.equal(ehRespostaAutomatica(liteTarde, [entrada, liteTarde]), true);
});

// ── leitura com dependências falsas ─────────────────────────────────────────────────────────────

function depsFalsas(over: Partial<DepsAntesDeEnviar> = {}) {
  const chamadas = { mensagens: 0, marcarPausa: 0, simulacoes: [] as Simulacao[], notas: [] as string[] };
  const deps: DepsAntesDeEnviar = {
    agora: () => em('12:28:30'),
    mensagens: async () => {
      chamadas.mensagens++;
      return conversaBebedouro();
    },
    ultimaFalaDaIa: async () => new Date('2026-10-20T00:46:50-03:00'),
    pausaMexidaDesde: async () => false,
    pausaMarcadaAgora: async () => false,
    marcarPausa: async () => {
      chamadas.marcarPausa++;
      return 'marcou';
    },
    simular: (_u, _a, s) => {
      chamadas.simulacoes.push(s);
    },
    unidadeEmPausa: async () => false,
    pausaComData: async () => false,
    caixinhaMarcada: async () => false,
    pausouSozinha: () => false,
    anotar: async (_u, _l, texto) => {
      chamadas.notas.push(texto);
    },
    handoffCalado: () => false,
    handoffDaSofia: () => false,
    ...over,
  };
  return { deps, chamadas };
}

test('desmarcaram "Pausar IA" depois da fala da equipe → devolvida: a mesma fala não pausa de novo', async () => {
  const { deps } = depsFalsas({ pausaMexidaDesde: async () => true, pausaMarcadaAgora: async () => false });
  const r = await conferirEquipe(unidade, LEAD, deps);
  assert.deepEqual([r.fala, r.motivo], [null, 'devolvida']);
});

test('"Pausar IA" mudou depois da fala mas segue MARCADO (pausa da própria Sofia, auto-pausa) → não é devolução', async () => {
  const { deps } = depsFalsas({ pausaMexidaDesde: async () => true, pausaMarcadaAgora: async () => true });
  const r = await conferirEquipe(unidade, LEAD, deps);
  assert.equal(r.motivo, null);
  assert.ok(r.fala);
});

test('sem resposta do Kommo sobre a caixinha, o lado seguro é o de antes (a Sofia responde)', async () => {
  const { deps } = depsFalsas({ pausaMexidaDesde: async () => { throw new Error('429'); } });
  const r = await conferirEquipe(unidade, LEAD, deps);
  assert.deepEqual([r.fala, r.motivo], [null, 'nao_conferi']);
});

// ── a porta (antes de gerar) ────────────────────────────────────────────────────────────────────

test('a chave nasce em "só no papel" na rede toda; a lista do .env diz quem está ligado', () => {
  assert.equal(automacaoPorId('pausa-equipe')?.quandoVazio, 'seco');
  assert.equal(estadoDaPausaPelaEquipe(SLUG, {} as NodeJS.ProcessEnv), 'seco');
  assert.equal(estadoDaPausaPelaEquipe(SLUG, { PAUSA_EQUIPE_SLUGS: SLUG } as NodeJS.ProcessEnv), 'ligado');
});

test('porta desligada: nem lê o Kommo', async () => {
  _semearParaTeste([{ slug: SLUG, automacao: 'pausa-equipe', estado: 'desligado' }]);
  const { deps, chamadas } = depsFalsas();
  const r = await portaDaEquipe({ unit: unidade, leadId: LEAD }, deps);
  assert.deepEqual(r, { pausou: false, msgs: null });
  assert.equal(chamadas.mensagens, 0);
});

test('porta em "só no papel": registra "gravaria Pausar IA", a Sofia responde, e a leitura volta pro bloco', async () => {
  _semearParaTeste([{ slug: SLUG, automacao: 'pausa-equipe', estado: 'seco' }]);
  const { deps, chamadas } = depsFalsas();
  const r = await portaDaEquipe({ unit: unidade, leadId: LEAD }, deps);
  assert.equal(r.pausou, false);
  assert.equal(r.msgs?.length, 5);
  assert.equal(chamadas.marcarPausa, 0);
  assert.equal(chamadas.simulacoes.length, 1);
  assert.equal(chamadas.simulacoes[0].alvo, 'Pausar IA');
});

test('porta ligada (Bebedouro 12:28): marca "Pausar IA" e a Sofia não responde', async () => {
  _semearParaTeste([{ slug: SLUG, automacao: 'pausa-equipe', estado: 'ligado' }]);
  const { deps, chamadas } = depsFalsas();
  const r = await portaDaEquipe({ unit: unidade, leadId: LEAD }, deps);
  assert.equal(r.pausou, true);
  assert.equal(chamadas.marcarPausa, 1);
});

test('porta ligada: mesmo sem conseguir marcar a caixinha, este turno fica calado', async () => {
  _semearParaTeste([{ slug: SLUG, automacao: 'pausa-equipe', estado: 'ligado' }]);
  const { deps } = depsFalsas({ marcarPausa: async () => { throw new Error('Kommo fora'); } });
  assert.equal((await portaDaEquipe({ unit: unidade, leadId: LEAD }, deps)).pausou, true);
});

test('porta ligada: conversa oficial ilegível (403 de Parauapebas) = segue como antes', async () => {
  _semearParaTeste([{ slug: SLUG, automacao: 'pausa-equipe', estado: 'ligado' }]);
  const { deps } = depsFalsas({ mensagens: async () => { throw new Error('listTalkMessages(8943): 403'); } });
  assert.deepEqual(await portaDaEquipe({ unit: unidade, leadId: LEAD }, deps), { pausou: false, msgs: null });
});

// ── a trava (antes de enviar) ───────────────────────────────────────────────────────────────────

const INICIO = em('12:28:27').getTime();
const semEquipe = { mensagens: async () => conversaBebedouro().slice(0, 2) };

test('"Pausar IA" marcado enquanto o modelo pensava → a resposta não sai e vira nota no cartão', async () => {
  const { deps, chamadas } = depsFalsas({ ...semEquipe, caixinhaMarcada: async () => true });
  const motivo = await travaAntesDeEnviar({ unit: unidade, leadId: LEAD, inicioDoTurno: INICIO, resposta: 'Prefere manhã ou tarde?' }, deps);
  assert.match(motivo ?? '', /Pausar IA/);
  assert.equal(chamadas.notas.length, 1);
  assert.match(chamadas.notas[0], /Prefere manhã ou tarde\?/);
});

test('a própria Sofia pausou neste turno (pausar_ia, teto) → o aviso do handoff sai', async () => {
  registrarPausaPropria(unidade, LEAD, INICIO + 5_000);
  const { deps, chamadas } = depsFalsas({
    ...semEquipe,
    caixinhaMarcada: async () => true,
    unidadeEmPausa: async () => true,
    pausouSozinha: pausouSozinhaDesde,
  });
  const motivo = await travaAntesDeEnviar({ unit: unidade, leadId: LEAD, inicioDoTurno: INICIO, resposta: 'Vou chamar a equipe 🙏' }, deps);
  assert.equal(motivo, null);
  assert.equal(chamadas.notas.length, 0);
});

const calado = { ...semEquipe, pausouSozinha: pausouSozinhaDesde, handoffDaSofia: handoffDaSofiaDesde, handoffCalado: () => true };

test('handoff calado (Salto): handoff comum da Sofia → o aviso NÃO sai e vira nota', async () => {
  _limparPausasProprias();
  registrarPausaPropria(unidade, LEAD, INICIO + 5_000, 'handoff');
  const { deps, chamadas } = depsFalsas(calado);
  const motivo = await travaAntesDeEnviar({ unit: unidade, leadId: LEAD, inicioDoTurno: INICIO, resposta: 'Já passei seu caso pra nossa equipe 🙏' }, deps);
  assert.equal(motivo, MOTIVO_HANDOFF_CALADO);
  assert.equal(chamadas.notas.length, 1);
  assert.match(chamadas.notas[0], /Já passei seu caso/);
});

test('handoff calado NUNCA cala: sinal de alerta, teto/candidato (origem "outra") e turno que marcou consulta', async () => {
  for (const origem of ['alerta', 'outra'] as const) {
    _limparPausasProprias();
    registrarPausaPropria(unidade, LEAD, INICIO + 5_000, origem);
    const { deps, chamadas } = depsFalsas(calado);
    const motivo = await travaAntesDeEnviar({ unit: unidade, leadId: LEAD, inicioDoTurno: INICIO, resposta: 'aviso' }, deps);
    assert.equal(motivo, null, origem);
    assert.equal(chamadas.notas.length, 0, origem);
  }
  _limparPausasProprias();
  registrarPausaPropria(unidade, LEAD, INICIO + 5_000, 'handoff');
  const { deps } = depsFalsas(calado);
  const motivo = await travaAntesDeEnviar(
    { unit: unidade, leadId: LEAD, inicioDoTurno: INICIO, resposta: 'Consulta marcada para quinta às 9h!', marcouConsulta: true },
    deps,
  );
  assert.equal(motivo, null, 'a confirmação da consulta marcada no turno sai');
});

test('handoff calado: 2º pausar_ia sem sinal no mesmo turno NÃO rebaixa o alerta (o aviso do alerta sai)', async () => {
  _limparPausasProprias();
  registrarPausaPropria(unidade, LEAD, INICIO + 5_000, 'alerta');
  registrarPausaPropria(unidade, LEAD, INICIO + 6_000, 'handoff');
  assert.equal(handoffDaSofiaDesde(unidade, LEAD, INICIO), false);
  // teto/candidato ('outra') também não é rebaixado por um handoff comum no mesmo turno
  _limparPausasProprias();
  registrarPausaPropria(unidade, LEAD, INICIO + 5_000, 'outra');
  registrarPausaPropria(unidade, LEAD, INICIO + 6_000, 'handoff');
  assert.equal(handoffDaSofiaDesde(unidade, LEAD, INICIO), false);
  _limparPausasProprias();
  registrarPausaPropria(unidade, LEAD, INICIO + 5_000, 'alerta');
  registrarPausaPropria(unidade, LEAD, INICIO + 6_000, 'handoff');
  const { deps } = depsFalsas(calado);
  assert.equal(await travaAntesDeEnviar({ unit: unidade, leadId: LEAD, inicioDoTurno: INICIO, resposta: 'aviso do alerta' }, deps), null);
});

test('handoff calado NUNCA cala: remarcou/cancelou no turno, ou a resposta fala de pronto-socorro/UPA/hospital (alerta não marcado)', async () => {
  const casos: Array<{ resposta: string; mexeuNaAgenda?: boolean }> = [
    { resposta: 'Pronto, troquei sua consulta para quinta às 9h!', mexeuNaAgenda: true },
    { resposta: 'Cancelei sua consulta, tudo certo.', mexeuNaAgenda: true },
    { resposta: 'Pode ir ao pronto-socorro sim, a equipe já foi avisada.' }, // "paciente perguntou se deve ir ao PS"
    { resposta: 'Pode ir à UPA, nossa equipe já foi avisada.' }, // "paciente disse que vai para a UPA"
    { resposta: 'Pode ir ao hospital agora, a equipe já está sabendo.' }, // "paciente quer ir ao hospital agora"
  ];
  for (const c of casos) {
    _limparPausasProprias();
    registrarPausaPropria(unidade, LEAD, INICIO + 5_000, 'handoff'); // o modelo não marcou o sinal: origem comum
    const { deps, chamadas } = depsFalsas(calado);
    const motivo = await travaAntesDeEnviar({ unit: unidade, leadId: LEAD, inicioDoTurno: INICIO, resposta: c.resposta, mexeuNaAgenda: c.mexeuNaAgenda }, deps);
    assert.equal(motivo, null, c.resposta);
    assert.equal(chamadas.notas.length, 0, c.resposta);
  }
});

test('handoff calado ligado, mas a Sofia NÃO pausou neste turno → a resposta normal sai', async () => {
  _limparPausasProprias();
  const { deps, chamadas } = depsFalsas(calado);
  const motivo = await travaAntesDeEnviar({ unit: unidade, leadId: LEAD, inicioDoTurno: INICIO, resposta: 'Prefere manhã ou tarde?' }, deps);
  assert.equal(motivo, null);
  assert.equal(chamadas.notas.length, 0);
});

test('pausa da própria Sofia de um turno ANTERIOR não libera: a marca vale só do início deste turno em diante', () => {
  registrarPausaPropria(unidade, LEAD, INICIO - 60_000);
  assert.equal(pausouSozinhaDesde(unidade, LEAD, INICIO), false);
  registrarPausaPropria(unidade, LEAD, INICIO + 1);
  assert.equal(pausouSozinhaDesde(unidade, LEAD, INICIO), true);
  // o mesmo número de cartão em outra conta do Kommo não herda a marca
  assert.equal(pausouSozinhaDesde({ kommoSubdomain: 'outraconta' }, LEAD, INICIO), false);
});

test('pausa da unidade e pausa com data ligadas durante o turno também travam', async () => {
  const a = depsFalsas({ ...semEquipe, unidadeEmPausa: async () => true });
  assert.ok(await travaAntesDeEnviar({ unit: unidade, leadId: LEAD, inicioDoTurno: INICIO, resposta: 'oi' }, a.deps));
  const b = depsFalsas({ ...semEquipe, pausaComData: async () => true });
  assert.ok(await travaAntesDeEnviar({ unit: unidade, leadId: LEAD, inicioDoTurno: INICIO, resposta: 'oi' }, b.deps));
});

test('chave ligada: a equipe escreveu pelo celular enquanto a Sofia pensava → descarta, pausa e avisa da consulta marcada', async () => {
  _semearParaTeste([{ slug: SLUG, automacao: 'pausa-equipe', estado: 'ligado' }]);
  const durante = [...conversaBebedouro().slice(0, 2), msg('saida', em('12:28:40'), 'Nilza, vamos agendar um horário!')];
  const { deps, chamadas } = depsFalsas({ mensagens: async () => durante });
  const motivo = await travaAntesDeEnviar(
    { unit: unidade, leadId: LEAD, inicioDoTurno: INICIO, resposta: 'Fechado, quinta às 11:30!', marcouConsulta: true },
    deps,
  );
  assert.match(motivo ?? '', /a equipe falou/);
  assert.equal(chamadas.marcarPausa, 1);
  assert.match(chamadas.notas[0], /MARCOU consulta/);
});

test('"só no papel": a fala que chegou durante o turno é registrada, a de antes não repete, e nada é descartado', async () => {
  _semearParaTeste([{ slug: SLUG, automacao: 'pausa-equipe', estado: 'seco' }]);
  const durante = [...conversaBebedouro().slice(0, 2), msg('saida', em('12:28:40'), 'Nilza, vamos agendar um horário!')];
  const a = depsFalsas({ mensagens: async () => durante });
  assert.equal(await travaAntesDeEnviar({ unit: unidade, leadId: LEAD, inicioDoTurno: INICIO, resposta: 'oi' }, a.deps), null);
  assert.equal(a.chamadas.simulacoes.length, 1);
  assert.equal(a.chamadas.notas.length, 0);

  const b = depsFalsas(); // a fala da Melissa é das 10:26, antes do turno: a porta já registrou
  assert.equal(await travaAntesDeEnviar({ unit: unidade, leadId: LEAD, inicioDoTurno: INICIO, resposta: 'oi' }, b.deps), null);
  assert.equal(b.chamadas.simulacoes.length, 0);
});

test('nada mudou durante o turno → a resposta sai, sem nota', async () => {
  _semearParaTeste([{ slug: SLUG, automacao: 'pausa-equipe', estado: 'ligado' }]);
  const { deps, chamadas } = depsFalsas(semEquipe);
  assert.equal(await travaAntesDeEnviar({ unit: unidade, leadId: LEAD, inicioDoTurno: INICIO, resposta: 'oi' }, deps), null);
  assert.equal(chamadas.notas.length, 0);
});

// ── reativação de 30 min ────────────────────────────────────────────────────────────────────────

test('reativação: a equipe falou pelo celular depois do handoff → acha a fala (e não reativa)', async () => {
  const handoff = em('10:00:00');
  assert.equal(falaDaEquipeDepoisDe(conversaBebedouro(), handoff)?.texto, 'Olá Dona Nilza Bom dia tudo bem?');
  assert.equal(falaDaEquipeDepoisDe(conversaBebedouro(), em('11:00:00')), null);
  const lida = await falaDaEquipeDesde(unidade, LEAD, handoff, { mensagens: async () => conversaBebedouro() });
  assert.ok(lida);
});

test('reativação: só a mensagem de ausência depois do handoff não conta como gente assumir', () => {
  const handoff = em('22:00:00');
  const msgs = [msg('entrada', em('23:59:10'), 'oi'), msg('saida', em('23:59:12'), AUSENCIA_RIO_VERDE)];
  assert.equal(falaDaEquipeDepoisDe(msgs, handoff), null);
});

test('reativação: conversa ilegível = segue como antes (null)', async () => {
  const r = await falaDaEquipeDesde(unidade, LEAD, em('10:00:00'), { mensagens: async () => { throw new Error('403'); } } as Pick<DepsPausaEquipe, 'mensagens'>);
  assert.equal(r, null);
});
