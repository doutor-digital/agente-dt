import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Unit } from '@prisma/client';

import {
  DEPS_DA_REABERTURA,
  ID_PERDIDO_REABRE,
  JANELA_DA_REABERTURA_MS,
  ehCodigoDeVerificacao,
  ehPerdidoDoComercial,
  ehRecusaOuEncerramento,
  notaCartaoReaberto,
  trechoDaFala,
  pacienteEmTratamentoNaFranquia,
  pedeParaSair,
  perdidoReabreEstado,
  portaPerdidoReabre,
  type DepsDaReabertura,
  type PedidoDeReabertura,
} from './perdido-reabre.js';
import { _semearParaTeste } from './automacoes-estado.js';
import { AUTOMACOES, automacaoPorId, verificarCatalogo } from './automacoes.js';
import { montarEsquema } from './kommo-schema.js';
import { conferirEquipe, type DepsPausaEquipe } from './pausa-equipe.js';
import type { MensagemOficial } from '../services/kommo-talks.service.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import type { Simulacao } from './so-no-papel.js';
import { consultarFranquia, type SinalDaFranquia } from './paciente-em-tratamento.js';

/**
 * O caso do Jairo (Timbó, lead 6624948, 22–23/11/2026): cartão em PERDIDO do COMERCIAL, o robô de reativação do Kommo mandou os botões
 * "Quer que eu veja os horários desta semana?"; o paciente tocou "Ver horários" às 08:38 e ninguém respondeu por 11 h
 * (`__stage_not_allowed__`: a lista de etapas de Timbó não tem o 143).
 */

beforeEach(() => _semearParaTeste([]));

const SLUG = 'doutor-hernia-timbo';
const COMERCIAL = 14523243;
const TRATAMENTO = 14540271;
const ENTRADA = 112189467;
const QUALIFICACAO = 112321351;
const AGENDADO = 112321359;
const ESPERA = 112321355;
const PERMITIDAS = [ENTRADA, QUALIFICACAO, AGENDADO, ESPERA];
const PAUSAR_IA = 386198;

const unidade = {
  id: 'u-timbo',
  slug: SLUG,
  kommoPausedFieldId: PAUSAR_IA,
  spineTimezone: 'America/Sao_Paulo',
  spineEnabled: true,
  spineToken: 'tok',
} as unknown as Unit;

const esquema = montarEsquema(
  [],
  [
    {
      id: COMERCIAL,
      name: 'COMERCIAL',
      statuses: [
        { id: ENTRADA, name: 'Etapa de leads de entrada' },
        { id: QUALIFICACAO, name: 'EM QUALIFICAÇÃO' },
        { id: AGENDADO, name: 'AGENDADO' },
        { id: ESPERA, name: 'EM ESPERA' },
        { id: 142, name: 'GANHO / CONCLUÍDO' },
        { id: 143, name: 'PERDIDO' },
      ],
    },
    {
      id: TRATAMENTO,
      name: 'TRATAMENTO',
      statuses: [
        { id: 112322687, name: 'EM TRATAMENTO' },
        { id: 142, name: 'ALTA' },
        { id: 143, name: 'TRATAMENTO CANCELADO' },
      ],
    },
  ],
);

const cartao = (over: Partial<KommoLead> = {}): KommoLead => ({
  id: 6624948,
  name: 'Jairo Luiz Da Costa',
  status_id: 143,
  pipeline_id: COMERCIAL,
  custom_fields_values: [],
  _embedded: { tags: [], contacts: [{ id: 99, is_main: true }] },
  ...over,
});

const msg = (direcao: 'entrada' | 'saida', quando: string, texto: string, autor: MensagemOficial['autor'], autorNome = ''): MensagemOficial => ({
  id: `${quando}-${texto.slice(0, 6)}`,
  em: new Date(quando),
  direcao,
  autor,
  autorNome,
  texto,
  anexo: null,
  status: null,
});

/** A conversa de 22/11: o robô do Kommo (autor `bot` = 'sofia') mandou os botões; o paciente tocou "Ver horários". */
const conversaDe22 = (): MensagemOficial[] => [
  msg('saida', '2026-11-22T08:28:00-03:00', 'Olá! Quer que eu veja os horários desta semana? Responda esta mensagem que eu reabro o seu cadastro.', 'sofia', 'Salesbot'),
  msg('entrada', '2026-11-22T08:38:00-03:00', 'Ver horários', 'paciente'),
];

function fake(over: Partial<DepsDaReabertura> = {}, conversa: () => MensagemOficial[] = conversaDe22, agora = '2026-11-22T08:38:20-03:00') {
  const reg = { moves: [] as unknown[], notas: [] as string[], marcas: 0, simulacoes: [] as Simulacao[], franquia: 0, telefone: 0, equipe: 0, motivosNativos: 0 };
  const kommo = {
    moveStage: async (p: unknown) => void reg.moves.push(p),
    addLeadNote: async (_id: number, t: string) => {
      reg.notas.push(t);
      return { id: 1 };
    },
    getContactPhone: async () => '+5547999990000',
  } as unknown as KommoClient;
  const equipeFalsa: DepsPausaEquipe = {
    agora: () => new Date(agora),
    mensagens: async () => conversa(),
    ultimaFalaDaIa: async () => null,
    pausaMexidaDesde: async () => false,
    pausaMarcadaAgora: async () => false,
    marcarPausa: async () => 'marcou',
    simular: () => undefined,
  };
  const deps: DepsDaReabertura = {
    estado: () => 'ligado',
    esquema: async () => esquema,
    contaDividida: async () => false,
    reabertoRecentemente: async () => false,
    marcarReaberto: async () => void reg.marcas++,
    motivosNativos: async () => {
      reg.motivosNativos++;
      return new Map([
        [1, 'Sem interesse'],
        [2, 'Sem condições financeira'],
      ]);
    },
    // a decisão da equipe é A MESMA da pausa-equipe: `conferirEquipe` de verdade, só a leitura do Kommo é falsa
    equipe: (u, leadId) => conferirEquipe(u, leadId, equipeFalsa),
    telefone: async () => {
      reg.telefone++;
      return '+5547999990000';
    },
    naoPacienteMarcado: async () => false,
    franquia: async () => {
      reg.franquia++;
      return { tipo: 'nao_achou' } as SinalDaFranquia;
    },
    simular: (_u, _a, s) => void reg.simulacoes.push(s),
    agora: () => new Date(agora),
    ...over,
  };
  const pedido = (p: Partial<PedidoDeReabertura> = {}): PedidoDeReabertura => ({
    unit: unidade,
    leadId: 6624948,
    lead: cartao(),
    humanMessage: 'Ver horários',
    contactId: '99',
    isChatMessage: true,
    retomada: false,
    allowedStatusIds: PERMITIDAS,
    funis: esquema,
    kommo,
    ...p,
  });
  return { deps, reg, pedido };
}

// ── partes puras ────────────────────────────────────────────────────────────────────────────────

test('a chave nasce desligada e liga por unidade (lista do ambiente, "só no papel" pela tela)', () => {
  assert.equal(perdidoReabreEstado(SLUG, undefined), 'desligado');
  assert.equal(perdidoReabreEstado(SLUG, 'doutor-hernia-serra'), 'desligado');
  assert.equal(perdidoReabreEstado(SLUG, 'doutor-hernia-timbo'), 'ligado');
  _semearParaTeste([{ slug: SLUG, automacao: ID_PERDIDO_REABRE, estado: 'seco' }]);
  assert.equal(perdidoReabreEstado(SLUG, undefined), 'seco');
});

test('a chave está no catálogo, com modo seco, desligada por padrão, e o catálogo continua válido', () => {
  const a = automacaoPorId(ID_PERDIDO_REABRE);
  assert.ok(a);
  assert.equal(a.chave, 'PERDIDO_REABRE_SLUGS');
  assert.equal(a.temSeco, true);
  assert.equal(a.quandoVazio, 'desligado');
  assert.equal(a.risco, 'move-cartao');
  assert.deepEqual(verificarCatalogo(AUTOMACOES), []);
});

test('pedido para parar não reabre; pergunta de horário reabre', () => {
  for (const t of ['SAIR', 'sair', 'Sair.', 'Parar', 'pare', 'pare de mandar mensagem', 'parar de me enviar mensagens', 'não quero mais receber', 'Não quero receber mensagens', 'stop', 'descadastrar', 'me tire dessa lista']) assert.equal(pedeParaSair(t), true, t);
  for (const t of ['Ver horários', 'Quanto custa?', 'Tenho uma dúvida', 'A tarde', 'Qual é o último horário que você tem disponível?', 'quero sair da dor']) assert.equal(pedeParaSair(t), false, t);
  // a palavra solta só vale SOZINHA: estes são pacientes
  for (const t of ['Parar de tomar o remédio piora?', 'Sair de casa dói muito, quero marcar', 'Pare, não consigo nem andar, preciso de horário']) assert.equal(pedeParaSair(t), false, t);
});

test('PERDIDO do COMERCIAL é; o 143 do TRATAMENTO (TRATAMENTO CANCELADO) não é', () => {
  assert.equal(ehPerdidoDoComercial(esquema, COMERCIAL, 143).ok, true);
  assert.equal(ehPerdidoDoComercial(esquema, TRATAMENTO, 143).ok, false);
  assert.equal(ehPerdidoDoComercial(esquema, COMERCIAL, 142).ok, false); // GANHO
  assert.equal(ehPerdidoDoComercial(esquema, COMERCIAL, QUALIFICACAO).ok, false);
  assert.equal(ehPerdidoDoComercial(esquema, 999, 143).ok, false); // funil que a conta não tem
});

test('franquia: só paciente com tratamento ativo ou sessão futura segura o cartão', () => {
  assert.match(pacienteEmTratamentoNaFranquia({ tipo: 'paciente', idClient: 7, tratamentoAtivo: true, sessaoFutura: false }) ?? '', /tratamento ativo/);
  assert.match(pacienteEmTratamentoNaFranquia({ tipo: 'paciente', idClient: 7, tratamentoAtivo: false, sessaoFutura: true }) ?? '', /sessão futura/);
  assert.equal(pacienteEmTratamentoNaFranquia({ tipo: 'paciente', idClient: 7, tratamentoAtivo: false, sessaoFutura: false }), null);
  assert.equal(pacienteEmTratamentoNaFranquia({ tipo: 'lead' }), null);
  assert.equal(pacienteEmTratamentoNaFranquia({ tipo: 'nao_achou' }), null);
  assert.equal(pacienteEmTratamentoNaFranquia(null), null);
});

test('a nota diz o que aconteceu e o que o paciente disse', () => {
  const n = notaCartaoReaberto('Ver horários', 'Sem condições financeira');
  assert.match(n, /Cartão reaberto: o paciente respondeu em PERDIDO/);
  assert.match(n, /EM QUALIFICAÇÃO/);
  assert.match(n, /Sem condições financeira/);
  assert.match(n, /"Ver horários"/);
});

// ── o caso do Jairo ─────────────────────────────────────────────────────────────────────────────

test('JAIRO (22/11 08:38): tocou "Ver horários" em PERDIDO → vai para EM QUALIFICAÇÃO do COMERCIAL, nota e marca, e o turno segue', async () => {
  const { deps, reg, pedido } = fake();
  const r = await portaPerdidoReabre(pedido(), deps);
  assert.ok(r);
  assert.equal(r.reabriu, true);
  assert.equal(r.decisao, 'reabrir');
  assert.deepEqual(r.para, { statusId: QUALIFICACAO, pipelineId: COMERCIAL, nome: 'EM QUALIFICAÇÃO' });
  assert.deepEqual(reg.moves, [{ leadId: 6624948, statusId: QUALIFICACAO, pipelineId: COMERCIAL }]);
  assert.equal(reg.notas.length, 1);
  assert.match(reg.notas[0], /Cartão reaberto: o paciente respondeu em PERDIDO/);
  assert.equal(reg.marcas, 1);
  assert.equal(reg.simulacoes.length, 0);
});

test('JAIRO (23/11 07:39): a Camila já está falando com ele → o cartão FICA em PERDIDO (a equipe tem a palavra)', async () => {
  const conversa = () => [
    ...conversaDe22(),
    msg('saida', '2026-11-23T07:20:00-03:00', 'Bom dia, Jairo! Tudo bem? Aqui é a Camila, da clínica.', 'equipe', 'Camila'),
    msg('entrada', '2026-11-23T07:39:00-03:00', 'A tarde', 'paciente'),
  ];
  const { deps, reg, pedido } = fake({}, conversa, '2026-11-23T07:39:20-03:00');
  const r = await portaPerdidoReabre(pedido({ humanMessage: 'A tarde' }), deps);
  assert.ok(r);
  assert.equal(r.reabriu, false);
  assert.equal(r.motivo, 'equipe_falou');
  assert.match(r.detalhe ?? '', /Camila/);
  assert.equal(reg.moves.length, 0);
  assert.equal(reg.notas.length, 0);
  assert.equal(reg.franquia, 0, 'nem gasta a franquia');
});

test('a fala da equipe de 3 dias atrás já não segura o cartão', async () => {
  const conversa = () => [
    msg('saida', '2026-11-19T10:00:00-03:00', 'Oi, aqui é a Camila.', 'equipe', 'Camila'),
    ...conversaDe22(),
  ];
  const { deps, pedido } = fake({}, conversa);
  const r = await portaPerdidoReabre(pedido(), deps);
  assert.equal(r?.reabriu, true);
});

// ── chave e modo seco ───────────────────────────────────────────────────────────────────────────

test('chave DESLIGADA: não lê nem escreve nada (devolve null)', async () => {
  let leu = 0;
  const { deps, reg, pedido } = fake({
    estado: () => 'desligado',
    esquema: async () => {
      leu++;
      return esquema;
    },
  });
  assert.equal(await portaPerdidoReabre(pedido(), deps), null);
  assert.equal(leu, 0);
  assert.equal(reg.moves.length + reg.notas.length + reg.marcas, 0);
});

test('SÓ NO PAPEL: decide "reabriria", registra na tela e NÃO toca no Kommo (nem nota, nem marca)', async () => {
  const { deps, reg, pedido } = fake({ estado: () => 'seco' });
  const r = await portaPerdidoReabre(pedido(), deps);
  assert.ok(r);
  assert.equal(r.estado, 'seco');
  assert.equal(r.decisao, 'reabrir');
  assert.equal(r.reabriu, false, 'o turno segue pulado como hoje');
  assert.equal(reg.moves.length, 0);
  assert.equal(reg.notas.length, 0);
  assert.equal(reg.marcas, 0);
  assert.equal(reg.simulacoes.length, 1);
  assert.equal(reg.simulacoes[0].acao, 'moveria');
  assert.equal(reg.simulacoes[0].alvo, 'EM QUALIFICAÇÃO');
  assert.equal(reg.simulacoes[0].leadId, 6624948);
  assert.equal(reg.simulacoes[0].valor, 'Ver horários', 'a tela mostra o que o paciente disse');
});

test('SÓ NO PAPEL: a fala vai cortada em 140 caracteres e numa linha só', async () => {
  const longa = `Bom dia\n\n${'quero ver os horários '.repeat(20)}`;
  const { deps, reg, pedido } = fake({ estado: () => 'seco' });
  await portaPerdidoReabre(pedido({ humanMessage: longa }), deps);
  const v = String(reg.simulacoes[0].valor);
  assert.equal(v.length, 141);
  assert.ok(v.endsWith('…') && !v.includes('\n'));
});

test('a fala cortada não parte emoji ao meio (por caractere, não por unidade UTF-16)', () => {
  const v = trechoDaFala('😀'.repeat(200));
  assert.equal(Array.from(v).length, 141);
  assert.doesNotMatch(v, /[\ud800-\udbff](?![\udc00-\udfff])/);
  assert.match(notaCartaoReaberto('😀'.repeat(200), null), /😀…"/);
});

test('SÓ NO PAPEL também registra por que NÃO reabriria (é isso que se confere antes de ligar)', async () => {
  const { deps, reg, pedido } = fake({ estado: () => 'seco' });
  const r = await portaPerdidoReabre(pedido({ lead: cartao({ _embedded: { tags: [{ id: 1, name: 'NO_FOLLOW_UP' }], contacts: [] } }) }), deps);
  assert.equal(r?.decisao, 'nao_reabrir');
  assert.equal(r?.motivo, 'cartao');
  assert.equal(reg.simulacoes.length, 0);
});

// ── onde não roda ───────────────────────────────────────────────────────────────────────────────

test('cartão que não está em 143 → null (nada a fazer)', async () => {
  const { deps, pedido } = fake();
  assert.equal(await portaPerdidoReabre(pedido({ lead: cartao({ status_id: ESPERA }) }), deps), null);
});

test('143 do funil TRATAMENTO (TRATAMENTO CANCELADO) nunca reabre', async () => {
  const { deps, reg, pedido } = fake();
  assert.equal(await portaPerdidoReabre(pedido({ lead: cartao({ pipeline_id: TRATAMENTO }) }), deps), null);
  assert.equal(reg.moves.length, 0);
});

// ── o que NÃO é lead ────────────────────────────────────────────────────────────────────────────

async function naoReabre(over: Partial<PedidoDeReabertura>, depsOver: Partial<DepsDaReabertura> = {}, esperado?: string) {
  const { deps, reg, pedido } = fake(depsOver);
  const r = await portaPerdidoReabre(pedido(over), deps);
  assert.ok(r);
  assert.equal(r.reabriu, false);
  assert.equal(r.decisao, 'nao_reabrir');
  if (esperado) assert.equal(r.motivo, esperado);
  assert.equal(reg.moves.length, 0, 'não move');
  assert.equal(reg.notas.length, 0, 'não anota');
  assert.equal(reg.marcas, 0, 'não marca');
  return { r, reg };
}

test('NÃO reabre: cortesia pura ("ok, obrigado"), pedido de sair, mensagem sem conteúdo, turno que não é de chat', async () => {
  await naoReabre({ humanMessage: 'ok, obrigado' }, {}, 'cortesia');
  await naoReabre({ humanMessage: 'SAIR' }, {}, 'pediu_para_sair');
  await naoReabre({ humanMessage: '   ' }, {}, 'sem_conteudo');
  await naoReabre({ humanMessage: '[áudio sem fala detectada]' }, {}, 'sem_conteudo');
  await naoReabre({ isChatMessage: false }, {}, 'sem_conteudo');
});

test('recusa curta e encerramento: "pode encerrar", "não quero", "não tenho interesse", "não, obrigado" (com e sem acento)', () => {
  for (const t of ['Pode encerrar', 'pode encerrar!', 'Sim, pode encerrar', 'pode encerrar por favor', 'Encerrar', 'Não quero', 'nao quero', 'Não quero mais', 'Não tenho interesse', 'nao tenho interesse', 'Já não tenho interesse', 'Sem interesse', 'Não, obrigado', 'nao obrigada', 'Não obrigado.', 'Não preciso mais']) {
    assert.equal(ehRecusaOuEncerramento(t), true, t);
  }
  // pacientes de verdade, mesmo com "não" no meio
  for (const t of ['Ver horários', 'Quanto custa?', 'Não quero cirurgia, quero saber o valor da consulta', 'Quero ver horários, não tenho interesse em cirurgia', 'Não consigo ir de manhã, tem à tarde?', 'não tenho plano, é particular?', 'Pode ser amanhã?', 'Pode marcar para terça', 'Pode fechar para terça', 'Pode fechar o agendamento', 'Pode finalizar a marcação', 'Não quero ir de manhã', 'Não quero pagar sinal', 'Não quero cirurgia, quanto custa?', 'Não tenho interesse nesse horário', 'Pode encerrar o agendamento de terça']) {
    assert.equal(ehRecusaOuEncerramento(t), false, t);
  }
});

test('código de confirmação de remetente automático (Facebook etc.) não é o paciente', () => {
  for (const t of ['FB-12345 é seu código de confirmação do Facebook', '123456 é o seu código de confirmação do Facebook', 'Seu código de verificação do Instagram é 884412', 'Your Facebook code is 551234', 'fb-48213', 'Codigo de confirmacao 4455']) {
    assert.equal(ehCodigoDeVerificacao(t), true, t);
  }
  for (const t of ['Ver horários', 'Meu CEP é 88000000', 'Quero marcar às 15:30', 'Meu telefone é 47999990000', 'o código da consulta qual é?', 'Meu CEP é 88000-000, qual o código da unidade?', 'Quero a confirmação para 2026', 'Prometa que atende às 15:30 de 2026']) {
    assert.equal(ehCodigoDeVerificacao(t), false, t);
  }
});

test('NÃO reabre: recusa/encerramento e código de verificação (pela porta)', async () => {
  for (const t of ['Pode encerrar', 'Não tenho interesse', 'não, obrigado']) await naoReabre({ humanMessage: t }, {}, 'recusa_ou_encerramento');
  await naoReabre({ humanMessage: 'FB-12345 é seu código de confirmação do Facebook' }, {}, 'codigo_de_verificacao');
});

test('NÃO reabre: turno refeito depois de um deploy (a etapa não se mexe)', async () => {
  await naoReabre({ retomada: true }, {}, 'turno_retomado');
});

test('NÃO reabre: etiqueta de não contatar (NO_FOLLOW_UP, NAO_PERTURBAR, BLOQUEADO_WHATSAPP, opt-out, CURRÍCULO)', async () => {
  for (const tag of ['NO_FOLLOW_UP', 'NAO_PERTURBAR', 'BLOQUEADO_WHATSAPP', 'Fluxo · Opt-out WhatsApp', 'CURRÍCULO']) {
    await naoReabre({ lead: cartao({ _embedded: { tags: [{ id: 1, name: tag }], contacts: [] } }) }, {}, 'cartao');
  }
});

test('NÃO reabre: ✓ Opt-out WhatsApp = Sim', async () => {
  await naoReabre({ lead: cartao({ custom_fields_values: [{ field_id: 1, field_name: '✓ Opt-out WhatsApp', values: [{ value: 'Sim' }] }] }) }, {}, 'cartao');
});

test('NÃO reabre: motivo de perda encerrado (campo ⊘) — engano, outra cidade, plano, outra patologia, sem interesse', async () => {
  for (const motivo of ['Clicou por engano', 'Outra cidade', 'Plano de Saúde', 'Outra patologia', 'Sem interesse']) {
    await naoReabre(
      { lead: cartao({ custom_fields_values: [{ field_id: 2, field_name: '⊘ Motivo do não agendamento', values: [{ value: motivo }] }] }) },
      {},
      'cartao',
    );
  }
});

test('NÃO reabre: motivo de perda encerrado escolhido no diálogo NATIVO do Kommo; ilegível também fica (na dúvida, não reabre)', async () => {
  await naoReabre({ lead: cartao({ loss_reason_id: 1 }) }, {}, 'cartao'); // 1 = Sem interesse
  await naoReabre({ lead: cartao({ loss_reason_id: 1 }) }, { motivosNativos: async () => null }, 'motivos_de_perda_ilegiveis');
});

test('reabre: motivo "Sem condições financeira" (trabalhável) e motivo nativo que não é encerrado', async () => {
  const { deps, reg, pedido } = fake();
  const r = await portaPerdidoReabre(
    pedido({ lead: cartao({ loss_reason_id: 2, custom_fields_values: [{ field_id: 2, field_name: '⊘ Motivo do não agendamento', values: [{ value: 'Sem condições financeira' }] }] }) }),
    deps,
  );
  assert.equal(r?.reabriu, true);
  assert.match(reg.notas[0], /Motivo da perda: Sem condições financeira/);
});

test('NÃO reabre: «Pausar IA» marcado, ◷ Retomar em pra frente, consulta futura no cartão', async () => {
  await naoReabre({ lead: cartao({ custom_fields_values: [{ field_id: PAUSAR_IA, field_name: 'Pausar IA', values: [{ value: true }] }] }) }, {}, 'cartao');
  const amanha = Math.floor(Date.parse('2026-11-23T12:00:00-03:00') / 1000);
  await naoReabre({ lead: cartao({ custom_fields_values: [{ field_id: 5, field_name: '◷ Retomar em', values: [{ value: amanha }] }] }) }, {}, 'cartao');
  const marcada = Math.floor(Date.parse('2026-11-30T10:00:00-03:00') / 1000);
  await naoReabre({ lead: cartao({ custom_fields_values: [{ field_id: 6, field_name: '◷ Data da Consulta', values: [{ value: marcada }] }] }) }, {}, 'cartao');
});

test('NÃO reabre: paciente da franquia com tratamento ativo ou sessão futura', async () => {
  const emTratamento = async () => ({ tipo: 'paciente', idClient: 1234, tratamentoAtivo: true, sessaoFutura: false }) as SinalDaFranquia;
  const { r } = await naoReabre({}, { franquia: emTratamento }, 'paciente_em_tratamento');
  assert.match(r.detalhe ?? '', /idClient 1234/);
  await naoReabre({}, { franquia: async () => ({ tipo: 'paciente', idClient: 1234, tratamentoAtivo: false, sessaoFutura: true }) as SinalDaFranquia }, 'paciente_em_tratamento');
});

test('NÃO reabre: franquia sem resposta (o erro caro é reabrir quem está em tratamento)', async () => {
  await naoReabre({}, { franquia: async () => ({ tipo: 'indisponivel', motivo: 'timeout' }) as SinalDaFranquia }, 'franquia_sem_resposta');
});

/** O índice de telefones da franquia como o banco o devolve: `fresco` vem do status da última carga completa. */
const indice = (entradas: Array<{ origem: 'paciente' | 'lead'; id: number | null }>, fresco: boolean, idadeHoras: number | null = fresco ? 2 : null) => async () => ({
  entradas: entradas.map((e) => ({ chave: '99990000', criado: null, ...e })),
  fresco,
  idadeHoras,
});
const ficha = (tratamentoAtivo: boolean) => async () => ({
  schedules: tratamentoAtivo
    ? [{ idSchedule: 1, idTreatment: 1, idStatus: 42, statusName: 'Atendido', clientName: null, categoryName: 'Sessão', physicalTherapist: null, dateAttendanceUtc: new Date(Date.now() - 3 * 86_400_000).toISOString(), dateAttendanceLocal: null, dayLocal: null, timeLocal: null, isBusy: true, requiresManualValidation: false }]
    : [],
  treatments: [{ idTreatment: 1, idStatus: tratamentoAtivo ? 45 : 46, statusName: null, typeName: null }],
});
const franquiaPeloIndice = (ind: ReturnType<typeof indice>, f = ficha(false)) => (u: Unit, tel: string) => consultarFranquia(u as never, tel, { indice: ind, ficha: f });

test('reabre: com o índice FRESCO, paciente que só avaliou/terminou, lead da franquia e telefone que a franquia não conhece', async () => {
  const casos = [
    franquiaPeloIndice(indice([{ origem: 'paciente', id: 1 }], true)),
    franquiaPeloIndice(indice([{ origem: 'lead', id: 3 }], true)),
    franquiaPeloIndice(indice([], true)),
  ];
  for (const franquia of casos) {
    const { deps, reg, pedido } = fake({ franquia });
    assert.equal((await portaPerdidoReabre(pedido(), deps))?.reabriu, true);
    assert.equal(reg.moves.length, 1);
  }
});

test('ÍNDICE VAZIO (nunca carregado): "não achei" não prova que não é paciente — o cartão FICA', async () => {
  const { r } = await naoReabre({}, { franquia: franquiaPeloIndice(indice([], false, null)) }, 'franquia_sem_resposta');
  assert.match(r.detalhe ?? '', /ainda não carregado/);
});

test('ÍNDICE VENCIDO (> 36 h): "não achei" e "só lead" não provam nada — o cartão FICA', async () => {
  const vazio = await naoReabre({}, { franquia: franquiaPeloIndice(indice([], false, 40)) }, 'franquia_sem_resposta');
  assert.match(vazio.r.detalhe ?? '', /vencido \(40 h\)/);
  await naoReabre({}, { franquia: franquiaPeloIndice(indice([{ origem: 'lead', id: 3 }], false, 40)) }, 'franquia_sem_resposta');
});

test('índice vencido que ACHA o paciente em tratamento continua segurando o cartão (achado positivo vale)', async () => {
  await naoReabre({}, { franquia: franquiaPeloIndice(indice([{ origem: 'paciente', id: 9 }], false, 40), ficha(true)) }, 'paciente_em_tratamento');
});

test('unidade SEM franquia conectada: não pergunta à franquia e reabre', async () => {
  const semFranquia = { ...unidade, spineEnabled: false } as unknown as Unit;
  const { deps, reg, pedido } = fake();
  const r = await portaPerdidoReabre(pedido({ unit: semFranquia }), deps);
  assert.equal(r?.reabriu, true);
  assert.equal(reg.franquia, 0);
});

test('NÃO reabre: telefone marcado pela equipe como não-paciente (antes de ler a conversa); telefone ilegível', async () => {
  let leuAConversa = 0;
  await naoReabre({}, { naoPacienteMarcado: async () => true, equipe: async () => { leuAConversa++; throw new Error('não devia ler'); } }, 'nao_paciente_marcado');
  assert.equal(leuAConversa, 0, 'o que é só banco local vem antes da conversa oficial');
  await naoReabre({}, { telefone: async () => null }, 'telefone_ilegivel');
});

test('NÃO reabre: a conversa oficial não pôde ser lida (na dúvida a equipe decide)', async () => {
  await naoReabre({}, { equipe: async () => { throw new Error('403'); } }, 'equipe_nao_lida');
});

test('NÃO reabre: EM QUALIFICAÇÃO fora das etapas em que a Sofia atende (o cartão andaria e ela continuaria muda)', async () => {
  const { r } = await naoReabre({ allowedStatusIds: [ENTRADA, AGENDADO, ESPERA] }, {}, 'qualificacao_fora_da_lista');
  assert.match(r.detalhe ?? '', /112321351/);
});

test('NÃO reabre: EM QUALIFICAÇÃO com a IA pausada por regra global (pause_in_stages): o cartão andaria e a Sofia continuaria muda', async () => {
  await naoReabre({ pausedStages: new Set([`*:${QUALIFICACAO}`]) }, {}, 'qualificacao_pausada_por_regra_global');
  await naoReabre({ pausedStages: new Set([`${COMERCIAL}:${QUALIFICACAO}`]) }, {}, 'qualificacao_pausada_por_regra_global');
  // regra de outra etapa não atrapalha
  const { deps, pedido } = fake();
  assert.equal((await portaPerdidoReabre(pedido({ pausedStages: new Set([`*:${ESPERA}`]) }), deps))?.reabriu, true);
});

test('NÃO reabre: funil sem a etapa EM QUALIFICAÇÃO', async () => {
  const sem = montarEsquema([], [{ id: COMERCIAL, name: 'COMERCIAL', statuses: [{ id: ENTRADA, name: 'Etapa de leads de entrada' }, { id: 143, name: 'PERDIDO' }] }]);
  await naoReabre({}, { esquema: async () => sem }, 'sem_etapa_de_qualificacao');
});

test('NÃO reabre: o cartão já foi reaberto nas últimas 24 h e fechado de novo (freio anti-vaivém)', async () => {
  assert.equal(JANELA_DA_REABERTURA_MS, 24 * 3600_000);
  await naoReabre({}, { reabertoRecentemente: async () => true }, 'ja_reaberto_recentemente');
});

test('NÃO reabre: conta do Kommo dividida entre unidades (Petrópolis/Caxias)', async () => {
  await naoReabre({}, { contaDividida: async () => true }, 'conta_dividida');
});

test('o Kommo recusa mover (campo obrigatório): o cartão fica, sem nota e sem marca — e o turno segue pulado', async () => {
  const { deps, reg, pedido } = fake();
  const kommoQueRecusa = {
    moveStage: async () => {
      throw new Error('400 required field');
    },
    addLeadNote: async () => {
      reg.notas.push('não devia');
      return null;
    },
  } as unknown as KommoClient;
  const r = await portaPerdidoReabre(pedido({ kommo: kommoQueRecusa }), deps);
  assert.equal(r?.reabriu, false);
  assert.equal(r?.motivo, 'falha_ao_mover');
  assert.equal(reg.notas.length, 0);
  assert.equal(reg.marcas, 0);
});

test('falha de leitura no meio (esquema fora do ar): nunca lança e o cartão fica', async () => {
  const { deps, reg, pedido } = fake({ esquema: async () => { throw new Error('rede'); } });
  const r = await portaPerdidoReabre(pedido(), deps);
  assert.equal(r?.reabriu, false);
  assert.equal(r?.motivo, 'erro');
  assert.equal(reg.moves.length, 0);
});

test('a marca ou a nota que falha depois do movimento não desfaz a reabertura: o turno segue', async () => {
  const { deps, pedido } = fake({ marcarReaberto: async () => { throw new Error('banco'); } });
  const kommo = {
    moveStage: async () => undefined,
    addLeadNote: async () => {
      throw new Error('429');
    },
  } as unknown as KommoClient;
  const r = await portaPerdidoReabre(pedido({ kommo }), deps);
  assert.equal(r?.reabriu, true);
});

// ── a ligação no webhook ────────────────────────────────────────────────────────────────────────

test('webhook: a porta roda ANTES de o turno ser pulado por etapa fora da lista, e só quando está fora dela', () => {
  const fonte = readFileSync(new URL('../controllers/webhook.controller.ts', import.meta.url), 'utf8');
  const porta = fonte.indexOf('portaPerdidoReabre({');
  const pula = fonte.indexOf("iaDecision: '__stage_not_allowed__'");
  assert.ok(porta > 0 && pula > porta, 'a porta vem antes de finalizar o turno como __stage_not_allowed__');
  const bloco = fonte.slice(fonte.lastIndexOf('let foraDaAllowlist', porta), pula);
  assert.match(bloco, /if \(foraDaAllowlist\) \{\s*const reabertura = await portaPerdidoReabre/);
  assert.match(bloco, /if \(reabertura\.reabriu && reabertura\.para\) \{\s*sid = reabertura\.para\.statusId;\s*lead\.status_id = reabertura\.para\.statusId;[^\n]*\n\s*foraDaAllowlist = false;/);
  assert.match(bloco, /retomada: !!args\.retomada/);
  assert.match(bloco, /pausedStages,/);
  // o turno continua pulado quando não reabriu
  assert.match(fonte.slice(porta, pula + 200), /if \(foraDaAllowlist\) \{\s*await finishWidgetSilently\(\);/);
});

test('as dependências de verdade existem (o teste acima usa falsas)', () => {
  for (const k of Object.keys(DEPS_DA_REABERTURA)) assert.ok((DEPS_DA_REABERTURA as unknown as Record<string, unknown>)[k], k);
});
