/**
 * Unidade sem pagamento antecipado (Timbó, 29/10/2026) — o agente tratava TODA unidade como se tivesse Pix antecipado.
 *
 * Aqui: a decisão (`unidadeSemAntecipado`), o PROMPT montado (nenhuma frase de antecipado, de chave Pix para reservar
 * nem de "garantir a vaga") e a regressão: com a flag ligada (padrão) o texto é o de sempre, palavra por palavra.
 * A parte da ferramenta `agendar_consulta` e da régua está em pagamento-da-unidade-agendar.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import {
  composeFlattenedPrompt,
  composeFollowUpSystemPrompt,
  composeSystemPrompt,
  composeSystemPromptParts,
  precosDaConsulta,
  renderFatosDaUnidade,
} from './prompt-composer.js';
import { PAGAMENTO_NO_DIA, REGRA_SEM_ANTECIPADO, intencaoDoDegrauParaAUnidade, unidadeSemAntecipado } from './pagamento-da-unidade.js';
import { regraDePagamento } from './follow-up.js';
import { orientacaoDePagamento, porQueNaoReservar } from './agenda-tools.js';
import { aplicarGuardrail } from './guardrail.js';
import type { Fala } from './repeticao.js';
import { INSTRUCAO_RESERVA_SEM_MARCAR, instrucaoReservaSemMarcar } from './reserva-sem-marcar.js';
import { degrauDoPixNaoSeAplica } from '../lib/follow-up-worker.js';
import { PRESETS } from '../lib/follow-up-presets.js';

const BASE = {
  id: 'u-timbo',
  slug: 'doutor-hernia-timbo',
  name: 'Doutor Hérnia Timbó',
  category: 'saude',
  systemPrompt: null,
  personaResponseLength: 'normal',
  personaLanguage: 'pt-BR',
  personaEmojis: [],
  handoffKeywords: [],
  pipelineIntents: { scheduled_meeting: 108773008 },
  spineEnabled: true,
  spineAgendaStart: '08:00',
  spineAgendaEnd: '18:00',
  spineAgendaDays: [1, 2, 3, 4, 5],
  spineTimezone: 'America/Sao_Paulo',
  clinicAddress: 'Rua Blumenau, 1290, Timbó/SC',
};

/** As fontes de Timbó: um valor só, pago no dia. Sem a palavra do conceito (ela apareceria no prompt pelas fontes). */
const FONTES_TIMBO = 'A consulta com o especialista custa R$ 250, paga no dia, na clínica. Sessões: R$ 120 cada.';
/** Fontes de uma unidade COM antecipado. */
const FONTES_COM = 'Consulta: R$ 350 no dia, ou R$ 250 com pagamento antecipado. Sessões: R$ 120.';

const unidade = (over: Record<string, unknown> = {}) => ({ ...BASE, sourceProdutos: FONTES_TIMBO, ...over }) as unknown as Unit;

const SEM = (over: Record<string, unknown> = {}) => unidade({ acceptsAdvancePayment: false, ...over });

const hist: Fala[] = [
  { papel: 'paciente', texto: 'Qual o valor da consulta?' },
  { papel: 'ia', texto: 'Antes me conta, onde dói?' },
  { papel: 'paciente', texto: 'Só me diz o valor' },
];

/** Todos os prompts que o agente monta para uma unidade. */
function prompts(u: Unit): Record<string, string> {
  const partes = composeSystemPromptParts({ unit: u });
  return {
    conversa: composeSystemPrompt({ unit: u }),
    conversaComHistorico: composeSystemPrompt({ unit: u, historico: hist }),
    cacheavel: partes.cacheable,
    dinamico: partes.dynamic,
    achatado: composeFlattenedPrompt({ unit: u }),
    followUp: composeFollowUpSystemPrompt(u, new Date('2026-10-29T15:00:00Z')),
    fatos: renderFatosDaUnidade(u),
  };
}

const PROIBIDO: Array<[string, RegExp]> = [
  ['antecipad', /antecipad/i],
  ['Pix antecipado', /Pix antecipado/i],
  ['garantir a vaga', /garantir (?:a|sua) vaga/i],
  ['menor é o ANTECIPADO', /menor é o ANTECIPADO/i],
  ['à vista no PIX', /à vista no PIX/i],
  ['envia a chave do PIX', /envia a chave do PIX/i],
  ['botão Pix antecipado | Na clínica', /Pix antecipado.{0,12}Na clínica/i],
];

// ---------------------------------------------------------------------------------------------------------------------
// A decisão
// ---------------------------------------------------------------------------------------------------------------------

test('unidadeSemAntecipado: só false explícito desliga; ausente, null e true seguem como hoje', () => {
  assert.equal(unidadeSemAntecipado({ acceptsAdvancePayment: false }), true);
  assert.equal(unidadeSemAntecipado({ acceptsAdvancePayment: true }), false);
  assert.equal(unidadeSemAntecipado({ acceptsAdvancePayment: null }), false);
  assert.equal(unidadeSemAntecipado({}), false);
  assert.equal(unidadeSemAntecipado(null), false);
  assert.equal(unidadeSemAntecipado(undefined), false);
});

test('flag false + taxa de reserva obrigatória (Boa Vista) é incompatível: a taxa VENCE e a unidade segue como hoje', () => {
  assert.equal(unidadeSemAntecipado({ acceptsAdvancePayment: false, spineBookingRequiresPayment: true }), false);
  assert.equal(unidadeSemAntecipado({ acceptsAdvancePayment: false, spineBookingRequiresPayment: false }), true);
});

// ---------------------------------------------------------------------------------------------------------------------
// O prompt de uma unidade sem antecipado
// ---------------------------------------------------------------------------------------------------------------------

test('unidade sem antecipado: NENHUM prompt montado fala de antecipado, chave Pix para reservar ou garantir a vaga', () => {
  for (const [nome, texto] of Object.entries(prompts(SEM()))) {
    for (const [rotulo, re] of PROIBIDO) {
      assert.doesNotMatch(texto, re, `${nome} contém "${rotulo}"`);
    }
  }
});

test('unidade sem antecipado, mesmo com chave Pix cadastrada: a chave não vai para o prompt', () => {
  const u = SEM({ pixKey: '12.345.678/0001-90', pixHolder: 'Clinica Timbo LTDA' });
  for (const [nome, texto] of Object.entries(prompts(u))) {
    assert.doesNotMatch(texto, /12\.345\.678\/0001-90/, `${nome} traz a chave`);
    for (const [rotulo, re] of PROIBIDO) assert.doesNotMatch(texto, re, `${nome} contém "${rotulo}"`);
  }
  assert.doesNotMatch(renderFatosDaUnidade(u), /Chave Pix/);
});

test('unidade sem antecipado: a confirmação diz que se paga no dia, na clínica; valor sem a palavra "antecipado"', () => {
  const p = composeSystemPrompt({ unit: SEM() });
  assert.ok(p.includes(PAGAMENTO_NO_DIA), 'linha do pagamento da confirmação');
  assert.ok(p.includes(REGRA_SEM_ANTECIPADO), 'a regra que fecha a porta');
  assert.match(p, /✨ Valor: R\$ \{[^}]*\} no dia, na clínica/);
  assert.match(p, /UM PASSO POR MENSAGEM: dia → horário → dados\./, 'sem o passo "Pix"');
  assert.doesNotMatch(p, /"Pix antecipado" ou "Na clínica"/);
});

test('unidade sem antecipado: o roteiro de preço não inventa "à vista no PIX" nem valor menor', () => {
  const p = composeSystemPrompt({ unit: SEM() });
  assert.match(p, /pago no dia, na clínica/);
  assert.match(p, /SEM oferecer desconto/);
  assert.doesNotMatch(p, /é antecipado no PIX/);
});

test('unidade sem antecipado: o follow-up leva o pagamento no dia nos fatos e a regra na instrução', () => {
  const fatos = renderFatosDaUnidade(SEM());
  assert.ok(fatos.includes(PAGAMENTO_NO_DIA));
  assert.match(regraDePagamento(SEM()), /pagar antes da consulta/);
  assert.equal(regraDePagamento(unidade()), '', 'nas demais unidades a instrução do follow-up não ganha nada');
});

test('fontes antigas com o par antecipado/no dia NÃO viram "antecipado" numa unidade sem antecipado', () => {
  // sobra de cadastro: a unidade foi migrada e a ficha ainda tem os dois valores
  const u = SEM({ sourceProdutos: FONTES_COM });
  assert.equal(precosDaConsulta(u), null, 'sem preço antecipado para o prompt, o guardrail, a trava do preço');
  const conversa = composeSystemPrompt({ unit: u });
  assert.doesNotMatch(conversa.split('<fontes>')[0] + conversa.split('</fontes>').slice(1).join(''), /antecipad|garantir a vaga/i);
  const fatos = renderFatosDaUnidade(u);
  assert.doesNotMatch(fatos, /antecipad/i);
  assert.doesNotMatch(composeFollowUpSystemPrompt(u, new Date('2026-10-29T15:00:00Z')), /antecipad/i);
  // e a mesma ficha, com a flag ligada, continua achando o par
  assert.deepEqual(precosDaConsulta(unidade({ sourceProdutos: FONTES_COM })), { antecipado: 250, noDia: 350 });
});

test('guardrail: numa unidade sem antecipado, "[chave]" não é trocado pela chave Pix da clínica', () => {
  const comPix = SEM({ pixKey: '12.345.678/0001-90' });
  const r = aplicarGuardrail('A chave Pix é [chave], pode pagar.', comPix);
  assert.doesNotMatch(r.text, /12\.345\.678\/0001-90/);
  assert.ok(r.rewritten, 'a lacuna sem dado vira a frase de reserva, não a chave');
  // controle: unidade com antecipado preenche, como sempre
  const r2 = aplicarGuardrail('A chave Pix é [chave], pode pagar.', unidade({ pixKey: '12.345.678/0001-90' }));
  assert.match(r2.text, /12\.345\.678\/0001-90/);
});

test('orientação pós-agendamento: qualquer forma numa unidade sem antecipado vira "paga no dia", sem chave nem valor', () => {
  const u = SEM({ pixKey: '12.345.678/0001-90', sourceProdutos: FONTES_COM });
  for (const forma of ['pix_antecipado', 'na_clinica']) {
    const t = orientacaoDePagamento(forma, u);
    assert.ok(t.includes(PAGAMENTO_NO_DIA), forma);
    assert.doesNotMatch(t, /antecipad|12\.345\.678|ESCOLHEU PIX/i, forma);
  }
  // remarcação (sem forma): a unidade sem antecipado ainda recebe o lembrete de que se paga no dia; as demais seguem sem texto
  assert.ok(orientacaoDePagamento(undefined, u).includes(PAGAMENTO_NO_DIA));
  assert.equal(orientacaoDePagamento(undefined, unidade({ sourceProdutos: FONTES_COM })), '');
  // a decisão de quem chama vale sobre a leitura da unidade (o handler decide uma vez por turno)
  assert.ok(orientacaoDePagamento('na_clinica', unidade(), true).includes(PAGAMENTO_NO_DIA));
  assert.match(orientacaoDePagamento('na_clinica', SEM(), false), /NÃO mencione Pix nem valor antecipado daqui em diante/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Regressão: a flag ligada (padrão) é o texto de hoje
// ---------------------------------------------------------------------------------------------------------------------

test('flag ligada ou ausente: as frases de hoje continuam, palavra por palavra', () => {
  for (const flag of [undefined, true]) {
    const u = unidade({ sourceProdutos: FONTES_COM, pixKey: '12.345.678/0001-90', pixHolder: 'Clinica LTDA', ...(flag === undefined ? {} : { acceptsAdvancePayment: flag }) });
    const p = composeSystemPrompt({ unit: u });
    assert.ok(p.includes('✨ Valor: R$ 250 antecipado (pago antes da consulta) ou R$ 350 no dia'));
    assert.ok(p.includes('A vaga é garantida com o pagamento antecipado no PIX: 12.345.678/0001-90 (Clinica LTDA).'));
    assert.ok(p.includes('- O valor menor é o ANTECIPADO (pago antes da consulta); o maior é o valor no dia.\n  NUNCA escreva "à vista". Não arredonde nem ofereça desconto.'));
    assert.ok(p.includes('- UM PASSO POR MENSAGEM: dia → horário → dados → Pix. Nunca peça duas coisas na mesma'));
    assert.ok(p.includes('(escolher entre os horários que você ofereceu; "Pix antecipado" ou "Na clínica";\n  "Confirmo" ou "Preciso remarcar"'));
    assert.ok(p.includes('A consulta com o especialista é\n     R$ 350, ou R$ 120 à vista no PIX. É nela que se descobre a'));
    assert.ok(renderFatosDaUnidade(u).includes('- Chave Pix: 12.345.678/0001-90 (titular: Clinica LTDA)'));
    assert.ok(renderFatosDaUnidade(u).includes('- Consulta: R$ 250 antecipado (pago antes) ou R$ 350 no dia'));
    assert.ok(orientacaoDePagamento('pix_antecipado', u).includes('A chave Pix é 12.345.678/0001-90'));
    assert.ok(orientacaoDePagamento('na_clinica', u).includes('NÃO mencione Pix nem valor antecipado daqui em diante.'));
    assert.deepEqual(precosDaConsulta(u), { antecipado: 250, noDia: 350 });
  }
});

test('flag ligada sem chave Pix: "A equipe envia a chave do PIX para garantir a vaga." continua (o texto de hoje)', () => {
  const p = composeSystemPrompt({ unit: unidade({ sourceProdutos: FONTES_COM, acceptsAdvancePayment: true }) });
  assert.ok(p.includes('A equipe envia a chave do PIX para garantir a vaga.'));
});

test('a porta do agendamento com a flag ligada: a mesma recusa de hoje, com a pergunta de pagamento e os botões', () => {
  const r = porQueNaoReservar({ diaConfirmado: true });
  assert.ok(r?.includes('perguntar como ele prefere pagar: Pix antecipado (valor antecipado) ou na clínica no dia'));
  assert.ok(r?.includes('formaPagamento preenchido'));
  assert.ok(r?.includes('[[botoes: Pix antecipado | Na clínica]]'));
  // só o dia faltando, com a forma já escolhida: texto de hoje (o ramo novo só vale para semAntecipado)
  const soDia = porQueNaoReservar({ formaPagamento: 'na_clinica' });
  assert.ok(soDia?.includes('formaPagamento preenchido'));
  assert.equal(porQueNaoReservar({ diaConfirmado: true, formaPagamento: 'pix_antecipado' }), null);
  assert.equal(porQueNaoReservar({ remarcando: true }), null);
});

test('a porta do agendamento sem antecipado: só o dia é exigido; nunca pergunta de pagamento nem botões', () => {
  assert.equal(porQueNaoReservar({ diaConfirmado: true, semAntecipado: true }), null, 'sem formaPagamento marca');
  const r = porQueNaoReservar({ semAntecipado: true });
  assert.ok(r, 'a recusa por dia continua');
  assert.match(r, /CONSEGUE ir nesse dia e horário/);
  assert.doesNotMatch(r, /antecipad|Pix|botoes|formaPagamento|como ele prefere pagar/i);
  assert.equal(porQueNaoReservar({ semAntecipado: true, remarcando: true }), null);
});

test('Boa Vista (taxa de reserva obrigatória) não muda; e flag false + taxa = Boa Vista de hoje, palavra por palavra', () => {
  const boaVista = unidade({ sourceProdutos: 'Consulta: R$ 250 no dia + taxa de R$ 100 antecipado.', spineBookingRequiresPayment: true, pixKey: '11999999999' });
  const comAFlagFalse = { ...boaVista, acceptsAdvancePayment: false } as unknown as Unit;
  const a = prompts(boaVista);
  const b = prompts(comAFlagFalse);
  for (const nome of Object.keys(a)) assert.equal(b[nome], a[nome], `${nome}: a taxa vence a flag`);
  assert.match(a.conversa, /Pagamento antecipado recebido — o horário está garantido/);
  assert.match(a.conversa, /R\$ 350 no total — R\$ 100 antecipado/);
  assert.deepEqual(precosDaConsulta(comAFlagFalse), { antecipado: 100, noDia: 250 });
});

// ---------------------------------------------------------------------------------------------------------------------
// A régua de follow-up
// ---------------------------------------------------------------------------------------------------------------------

const DEGRAUS = PRESETS.flatMap((p) => p.steps.map((d) => ({ etapa: p.statusName, motivo: p.lossReasonName, d })));

test('régua: nenhum degrau do Pix sai numa unidade sem antecipado — nem para cartão marcado pela recepção (sem escolha gravada)', () => {
  const doPix = DEGRAUS.filter((x) => x.d.soPix);
  assert.ok(doPix.length >= 2, 'a escada AGENDADO tem os degraus do Pix');
  for (const { d } of doPix) {
    assert.equal(degrauDoPixNaoSeAplica(d, null, SEM()), true, 'sem pagamentoEscolhido');
    assert.equal(degrauDoPixNaoSeAplica(d, undefined, SEM()), true);
    assert.equal(degrauDoPixNaoSeAplica(d, 'pix_antecipado', SEM()), true, 'mesmo com Pix gravado por engano');
  }
});

test('régua: nas demais unidades nada muda — o Pix sai para quem escolheu Pix ou não escolheu nada; "na clínica" não ouve', () => {
  for (const { d } of DEGRAUS.filter((x) => x.d.soPix)) {
    assert.equal(degrauDoPixNaoSeAplica(d, null, unidade()), false);
    assert.equal(degrauDoPixNaoSeAplica(d, 'pix_antecipado', unidade()), false);
    assert.equal(degrauDoPixNaoSeAplica(d, 'na_clinica', unidade()), true);
    assert.equal(degrauDoPixNaoSeAplica(d, null, unidade({ acceptsAdvancePayment: true })), false);
    // Boa Vista: a taxa vence a flag e a régua do Pix continua valendo
    assert.equal(degrauDoPixNaoSeAplica(d, null, unidade({ acceptsAdvancePayment: false, spineBookingRequiresPayment: true })), false);
  }
  for (const { d } of DEGRAUS.filter((x) => !x.d.soPix)) {
    assert.equal(degrauDoPixNaoSeAplica(d, 'na_clinica', SEM()), false, 'degrau que não é do Pix nunca é pulado por aqui');
  }
});

test('régua: o degrau que fala de antecipado/Pix e NÃO é soPix só é seguro por causa da regra da unidade (levantamento)', () => {
  const fora = DEGRAUS.filter((x) => !x.d.soPix && /antecipad|pix/i.test(x.d.intencao));
  // hoje: PERDIDO "Achou caro" ("Termine oferecendo o antecipado de R$ 150"). Se aparecer outro, entra na regra de pagamento do
  // follow-up (regraDePagamento) — este teste existe para quem criar o próximo degrau saber que a regra da unidade o cobre.
  assert.deepEqual(fora.map((x) => `${x.etapa}/${x.motivo}`), ['PERDIDO/Achou caro']);
  assert.match(regraDePagamento(SEM()), /Pix, de pagar antes ou de desconto, ignore essa parte/);
});

test('régua: o degrau que oferece o antecipado perde essa frase na unidade sem antecipado; nas demais o texto é o mesmo', () => {
  const caro = DEGRAUS.find((x) => x.motivo === 'Achou caro')!.d.intencao;
  assert.match(caro, /antecipado de R\$ 150/);
  const sem = intencaoDoDegrauParaAUnidade(caro, SEM());
  assert.doesNotMatch(sem, /antecipad|R\$ 150|pix/i);
  assert.match(sem, /NÃO dê desconto/, 'a proibição fica');
  assert.match(sem, /Deixe ele fazer a conta\./);
  // frase de proibição que cita Pix também fica; frase que oferece sai
  assert.equal(
    intencaoDoDegrauParaAUnidade('NÃO fale em Pix. Ofereça o Pix antecipado. Pergunte como ele está.', SEM()),
    'NÃO fale em Pix. Pergunte como ele está.',
  );
  // as demais unidades (e Boa Vista): idêntico, byte a byte, em todos os degraus
  for (const { d } of DEGRAUS) {
    assert.equal(intencaoDoDegrauParaAUnidade(d.intencao, unidade()), d.intencao);
    assert.equal(intencaoDoDegrauParaAUnidade(d.intencao, unidade({ acceptsAdvancePayment: false, spineBookingRequiresPayment: true })), d.intencao);
  }
});

test('retry de "reservado sem marcar": a instrução da unidade sem antecipado não manda checar como o paciente vai pagar', () => {
  const sem = instrucaoReservaSemMarcar(true);
  assert.doesNotMatch(sem, /chave Pix|como vai pagar|antecipad/i);
  assert.match(sem, /chame agendar_consulta AGORA/);
  assert.match(sem, /nunca sobre pagamento/);
  assert.equal(instrucaoReservaSemMarcar(false), INSTRUCAO_RESERVA_SEM_MARCAR, 'as demais: a instrução de hoje');
  // o texto de hoje, byte a byte (a constante agora é montada de pedaços compartilhados com a da unidade sem antecipado)
  assert.equal(
    INSTRUCAO_RESERVA_SEM_MARCAR,
    '[instrução interna, não é fala do paciente] Sua resposta acima diz que o horário está reservado ou marcado, ' +
      'mas NENHUMA consulta foi marcada no sistema da clínica — nada fica guardado, e outro paciente pode pegar esse horário. ' +
      'Se o paciente JÁ escolheu o dia e a hora (ou mandou o comprovante depois da chave Pix) e já disse como vai pagar, ' +
      'chame agendar_consulta AGORA. Se falta alguma dessas respostas, reescreva a mensagem SEM dizer que está reservado, ' +
      'marcado, guardado ou garantido, e pergunte só o que falta. Responda só com a mensagem final ou com a chamada da ferramenta.',
  );
  assert.match(INSTRUCAO_RESERVA_SEM_MARCAR, /depois da chave Pix\) e já disse como vai pagar/);
});
