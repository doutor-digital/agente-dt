import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import {
  JANELA_DA_EQUIPE_MS,
  conferirEquipe,
  descreverFala,
  ehRespostaAutomatica,
  equipeComAPalavra,
  estadoDaPausaPelaEquipe,
  falaDaEquipeDepoisDe,
  falaDaEquipeDesde,
  falasHumanasDaEquipe,
  portaDaEquipe,
  travaAntesDeEnviar,
  type DepsAntesDeEnviar,
  type DepsPausaEquipe,
} from './pausa-equipe.js';
import { _limparPausasProprias, pausouSozinhaDesde, registrarPausaPropria } from './pausa-propria.js';
import { _semearParaTeste } from './automacoes-estado.js';
import { automacaoPorId } from './automacoes.js';
import type { MensagemOficial } from '../services/kommo-talks.service.js';
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
    ...over,
  };
  return { deps, chamadas };
}

test('desmarcaram "Pausar IA" depois da fala da equipe → devolvida: a mesma fala não pausa de novo', async () => {
  const { deps } = depsFalsas({ pausaMexidaDesde: async () => true });
  const r = await conferirEquipe(unidade, LEAD, deps);
  assert.deepEqual([r.fala, r.motivo], [null, 'devolvida']);
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
  registrarPausaPropria(LEAD, INICIO + 5_000);
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

test('pausa da própria Sofia de um turno ANTERIOR não libera: a marca vale só do início deste turno em diante', () => {
  registrarPausaPropria(LEAD, INICIO - 60_000);
  assert.equal(pausouSozinhaDesde(LEAD, INICIO), false);
  registrarPausaPropria(LEAD, INICIO + 1);
  assert.equal(pausouSozinhaDesde(LEAD, INICIO), true);
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
