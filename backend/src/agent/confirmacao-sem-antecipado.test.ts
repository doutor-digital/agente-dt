/**
 * A mensagem de confirmação de agendamento de Timbó (unidade SEM antecipado), formato pedido pelo João em 03/11/2026:
 *
 *   ✅ Agendamento confirmado, {primeiro nome}!
 *
 *   ⭐ Data: *Sexta-feira 06/11*
 *   ⏰ Horário: *17:30*
 *   ⭐ Local: …
 *   ⏳ Chegue 15 minutos antes.
 *   ✨ Valor: R$ 250,00 no dia, dinheiro, pix, cartão de débito ou crédito.
 *
 *   Qualquer dúvida, é só chamar. Até breve! ☺️
 *
 * Aqui: o prompt monta exatamente isto; o que o modelo escrever desse jeito atravessa os saneadores de saída sem mudar; as demais
 * unidades continuam com o texto de antes, palavra por palavra; e o ☺️ só chega inteiro onde a unidade liga o sorriso colorido.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { composeSystemPrompt } from './prompt-composer.js';
import { aplicarGuardrail } from './guardrail.js';
import { semOAntecipadoNaSaida } from './sem-antecipado-saida.js';
import { semIntimidade } from '../lib/sem-intimidade.js';
import { semDiminutivo } from '../lib/sem-diminutivo.js';
import { datasDeConsultaCitadas } from './consulta-que-passou.js';
import { quandoCitado } from '../lib/prometeu-sem-marcar.js';
import { dataDaConfirmacao } from '../lib/feriados.js';
import { downgradeEmoji } from '../services/kommo.service.js';
import { linhaProntaDaData } from './agenda-tools.js';
import { FORMAS_NO_DIA, SORRISO_DA_CONFIRMACAO, valorDaConsultaNoDia } from './pagamento-da-unidade.js';

// A automação do sorriso colorido ligada para Timbó (é assim que a unidade roda quando o João a liga na tela de Automações).
// Cada arquivo de teste roda no seu processo: o env não vaza. Os testes do estado desligado trocam o valor com comEnv().
process.env.SORRISO_COLORIDO_SLUGS = 'doutor-hernia-timbo';

function comEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const antes: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) antes[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(antes)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  }
}

const SLUG = 'doutor-hernia-timbo';

const ENDERECO = 'Rua Blumenau, 1290, Estados, Timbó/SC, 89.093-438 — Comercial AMS, 1º andar, sala 17';

/** As fontes de Timbó como estão em produção (03/11/2026), sem tirar nem pôr. */
const FONTES_TIMBO = [
  'A CONSULTA presencial com o especialista: R$ 250,00, pago no dia, na clínica (dinheiro, pix, cartão de débito ou crédito) — sem desconto. A unidade NÃO trabalha com pagamento antecipado nem envia chave Pix para reservar horário. É o exame de perto em que o especialista entende a queixa e explica, em linguagem simples, o que está acontecendo e o que dá pra fazer — o "mapa" do caso.',
  '',
  'TRATAMENTO (pacote conservador): fortalece e descomprime a coluna, atua na causa da dor em vez de mascarar. O VALOR do pacote é definido SÓ na consulta, conforme o caso, e NUNCA é passado pelo WhatsApp.',
].join('\n');

const BASE = {
  id: 'u',
  slug: 'x',
  name: 'Unidade X',
  category: 'saude',
  systemPrompt: null,
  personaResponseLength: 'normal',
  personaLanguage: 'pt-BR',
  personaEmojis: [],
  handoffKeywords: [],
  pipelineIntents: { scheduled_meeting: 1 },
  spineEnabled: true,
  spineAgendaStart: '08:00',
  spineAgendaEnd: '18:00',
  spineAgendaDays: [1, 2, 3, 4, 5],
  spineTimezone: 'America/Sao_Paulo',
  clinicAddress: ENDERECO,
};

const timbo = (over: Record<string, unknown> = {}) =>
  ({ ...BASE, slug: 'doutor-hernia-timbo', name: 'Doutor Hérnia Timbó', sourceProdutos: FONTES_TIMBO, acceptsAdvancePayment: false, ...over }) as unknown as Unit;

/** O trecho do prompt que ensina a mensagem de confirmação, do cabeçalho até o fim das regras. */
function blocoDaConfirmacao(u: Unit): string {
  const p = composeSystemPrompt({ unit: u });
  const i = p.indexOf('QUANDO A CONSULTA FOR MARCADA COM SUCESSO');
  const j = p.indexOf('</agendamento>', i);
  assert.ok(i >= 0 && j > i, 'o prompt traz o bloco da confirmação');
  return p.slice(i, j);
}

/** O modelo de mensagem (entre o cabeçalho ✅ e "REGRAS DESTA MENSAGEM"). */
function modelo(u: Unit): string {
  const b = blocoDaConfirmacao(u);
  return b.slice(b.indexOf('✅ Agendamento confirmado'), b.indexOf('\n\nREGRAS DESTA MENSAGEM')).trimEnd();
}

/** O que o modelo escreve ao seguir o formato, com os dados do caso real do João (sexta 06/11, 17:30). */
const MENSAGEM_ESPERADA = [
  '✅ Agendamento confirmado, Maria!',
  '',
  '⭐ Data: *Sexta-feira 06/11*',
  '⏰ Horário: *17:30*',
  `⭐ Local: ${ENDERECO}`,
  '⏳ Chegue 15 minutos antes.',
  '✨ Valor: R$ 250,00 no dia, dinheiro, pix, cartão de débito ou crédito.',
  '',
  'Qualquer dúvida, é só chamar. Até breve! ☺️',
].join('\n');

test('Timbó: o modelo de confirmação do prompt é a mensagem do João, linha por linha', () => {
  const renderizada = modelo(timbo())
    .replace('{primeiro nome}', 'Maria')
    .replace(/\*\{dia da semana e dd\/mm[^}]*\}\*/, '*Sexta-feira 06/11*')
    .replace('{HH:mm}', '17:30');
  assert.equal(renderizada, MENSAGEM_ESPERADA);
});

test('Timbó: sem a linha "Atendimento com" e sem o parágrafo do pagamento no modelo', () => {
  const m = modelo(timbo());
  assert.doesNotMatch(m, /Atendimento com/);
  assert.doesNotMatch(m, /O pagamento é feito no dia/);
  assert.doesNotMatch(m, /😊/);
  // e a regra diz isso ao modelo, para ele não acrescentar por conta própria
  assert.match(blocoDaConfirmacao(timbo()), /NÃO tem a linha "Atendimento com" nem o parágrafo "O pagamento é feito no dia/);
});

test('Timbó: o fecho é ☺️ com o seletor de variação (U+263A U+FE0F) e a regra de emojis o permite — e só ele', () => {
  assert.equal(SORRISO_DA_CONFIRMACAO, '☺️');
  const m = modelo(timbo());
  assert.ok(m.endsWith('Até breve! ☺️'));
  const b = blocoDaConfirmacao(timbo());
  assert.match(b, /no fecho, ☺️\) — são BMP/);
  assert.match(b, /ÚNICO rosto permitido/);
  assert.match(b, /NUNCA use 📅 📍 💰 👏 👨‍⚕️ 🎉 😊 🙏/, 'os 4 bytes continuam proibidos');
});

test('Timbó: negrito é UM asterisco de cada lado, só em data e horário', () => {
  const b = blocoDaConfirmacao(timbo());
  assert.match(b, /⭐ Data: \*\{[^}]*\}\*\n⏰ Horário: \*\{HH:mm\}\*\n/);
  assert.match(b, /UM asterisco de cada lado/);
  assert.match(b, /nada de \*\*duplo\*\*/);
});

test('Timbó: o valor vem das fontes da unidade, não do código', () => {
  assert.match(modelo(timbo()), /✨ Valor: R\$ 250,00 no dia, dinheiro, pix, cartão de débito ou crédito\.\n/);
  const outro = modelo(timbo({ sourceProdutos: 'A consulta custa R$ 1.320,50, paga no dia.' }));
  assert.match(outro, /✨ Valor: R\$ 1320,50 no dia, /);
  // sem valor nas fontes: o modelo é mandado ler as fontes (e omitir a linha se não achar), sem chutar número
  const sem = modelo(timbo({ sourceProdutos: 'Tratamento conservador, valor definido na consulta.' }));
  assert.match(sem, /✨ Valor: R\$ \{o valor da consulta que está nas fontes\/produtos DESTA unidade, com centavos/);
  assert.doesNotMatch(sem, /R\$ 250/);
});

test('valorDaConsultaNoDia: a primeira linha de CONSULTA com R$; retorno, sessão e tratamento não valem', () => {
  assert.equal(valorDaConsultaNoDia(FONTES_TIMBO), '250,00');
  assert.equal(valorDaConsultaNoDia('Consulta: R$ 250'), '250,00');
  assert.equal(valorDaConsultaNoDia('Consulta: R$ 99,9'), '99,90');
  assert.equal(valorDaConsultaNoDia('Consulta de retorno: R$ 100\nConsulta com o especialista: R$ 250'), '250,00');
  // sobra de ficha antiga: o valor colado em "antecipado" não é o do dia
  assert.equal(valorDaConsultaNoDia('Consulta: R$ 250 antecipado ou R$ 350 no dia'), null, 'na dúvida, o modelo lê as fontes');
  assert.equal(valorDaConsultaNoDia('Consulta: R$ 350 no dia, ou R$ 250 com pagamento antecipado.'), '350,00');
  assert.equal(valorDaConsultaNoDia('A consulta custa R$ 250, paga no dia, na clínica. Sessões: R$ 120 cada.'), '250,00');
  assert.equal(valorDaConsultaNoDia('Sessões: R$ 120 cada\nTratamento: R$ 3.000'), null);
  assert.equal(valorDaConsultaNoDia('Consulta sem valor cadastrado'), null);
  assert.equal(valorDaConsultaNoDia(null), null);
  assert.equal(valorDaConsultaNoDia(''), null);
});

test('Timbó: o texto exato que o modelo escreve atravessa os saneadores de saída SEM mudar (asteriscos e ☺️ incluídos)', () => {
  const u = timbo();
  assert.equal(semOAntecipadoNaSaida(MENSAGEM_ESPERADA).texto, MENSAGEM_ESPERADA, '"pix" como forma de pagar no dia não é antecipado');
  assert.equal(semDiminutivo(MENSAGEM_ESPERADA), MENSAGEM_ESPERADA);
  assert.equal(semIntimidade(MENSAGEM_ESPERADA), MENSAGEM_ESPERADA);
  const g = aplicarGuardrail(semIntimidade(semDiminutivo(MENSAGEM_ESPERADA)), u, { consultaMarcada: true });
  assert.deepEqual(g.triggered, [], `nenhuma trava mexeu: ${g.triggered.join(', ')}`);
  assert.equal(g.text, MENSAGEM_ESPERADA);
});

test('Timbó: os vigias que leem a confirmação continuam entendendo a data e a hora do novo formato', () => {
  const velho = '✅ Agendamento confirmado, Maria!\n\n⭐ Data: sexta-feira, 06/11/2026\n⏰ Horário: 17:30\n⏳ Chegue 15 minutos antes.';
  assert.deepEqual(datasDeConsultaCitadas(MENSAGEM_ESPERADA, '2026-11-03'), ['2026-11-06T17:30']);
  assert.deepEqual(datasDeConsultaCitadas(velho, '2026-11-03'), ['2026-11-06T17:30'], 'controle: o formato antigo dá o mesmo');
  assert.equal(quandoCitado(MENSAGEM_ESPERADA), quandoCitado(velho));
});

test('dataDaConfirmacao: dia da semana com inicial maiúscula + dd/mm, sem ano e sem vírgula', () => {
  assert.equal(dataDaConfirmacao('2026-11-06'), 'Sexta-feira 06/11');
  assert.equal(dataDaConfirmacao('2026-11-07'), 'Sábado 07/11');
  assert.equal(dataDaConfirmacao('2026-11-08'), 'Domingo 08/11');
  assert.equal(dataDaConfirmacao('2026-11-10'), 'Terça-feira 10/11');
  assert.equal(dataDaConfirmacao('2027-01-04'), 'Segunda-feira 04/01');
  assert.equal(dataDaConfirmacao('lixo'), '');
  assert.equal(dataDaConfirmacao(''), '');
});

test('linhaProntaDaData: só para unidade sem antecipado; as demais recebem o mesmo retorno de sempre', () => {
  assert.equal(
    linhaProntaDaData('2026-11-06', true),
    ' Linha pronta da data para a confirmação (copie exatamente, sem ano): Sexta-feira 06/11.',
  );
  assert.equal(linhaProntaDaData('2026-11-06', false), '');
  assert.equal(linhaProntaDaData('lixo', true), '');
});

test('Timbó com o sorriso colorido DESLIGADO: o prompt não pede o ☺️ (o envio o estragaria) — fecha só com "Até breve!"', () => {
  comEnv({ SORRISO_COLORIDO_SLUGS: undefined }, () => {
    const b = blocoDaConfirmacao(timbo());
    assert.ok(modelo(timbo()).endsWith('Qualquer dúvida, é só chamar. Até breve!'));
    assert.doesNotMatch(b, /☺/);
    assert.match(b, /NENHUM emoji de rosto, nem no fecho/);
    assert.doesNotMatch(b, /ÚNICO rosto permitido/);
    // o resto do formato não depende da automação
    assert.match(b, /⭐ Data: \*\{[^}]*\}\*\n⏰ Horário: \*\{HH:mm\}\*\n/);
  });
});

test('valorDaConsultaNoDia: "à vista" colado ao valor também o descarta (o \\b do JS não enxerga o "à")', () => {
  assert.equal(valorDaConsultaNoDia('Consulta: R$ 200 à vista ou R$ 250 no dia'), null);
  assert.equal(valorDaConsultaNoDia('Consulta: R$ 250 no dia, ou R$ 200 à vista.'), '250,00');
});

// ---------------------------------------------------------------------------------------------------------------------
// Regressão: as outras unidades ficam com o texto de antes, palavra por palavra
// ---------------------------------------------------------------------------------------------------------------------

const FONTES_COM = 'Consulta: R$ 350 no dia, ou R$ 250 com pagamento antecipado. Sessões: R$ 120.';

const REGRAS_DE_ANTES = [
  'REGRAS DESTA MENSAGEM:',
  '- Só depois de a tool confirmar. Nunca antes, nunca "vou marcar".',
  '- Use SÓ os emojis do formato acima (✅ ⭐ ⏰ ⏳ ✨) — são BMP e chegam coloridos',
  '  neste canal. NUNCA use 📅 📍 💰 👏 👨‍⚕️ 🎉 😊 🙏 nem emoji de rosto/pessoa/objeto:',
  '  são 4 bytes, quebram no Kommo e cortam a mensagem no meio.',
  '- NUNCA chame quem atende de médico, doutor, Dr. ou Dra.: quem faz a consulta é',
  '  FISIOTERAPEUTA. Se o paciente citar "o médico", ele está falando de outro',
  '  profissional, fora daqui — aí tudo bem usar a palavra.',
  '- Não invente endereço, nome de profissional nem chave PIX. Linha sem dado',
  '  confirmado sai da mensagem — o paciente pergunta, e a equipe responde certo.',
];

function esperadoDeAntes(valor: string, linhaPix: string, regraDoValor: string[]): string {
  return [
    'QUANDO A CONSULTA FOR MARCADA COM SUCESSO, mande EXATAMENTE este formato — é o',
    'momento em que o paciente vai reler pra conferir, então precisa ser blocado e',
    'não um parágrafo corrido:',
    '',
    '✅ Agendamento confirmado, {primeiro nome}!',
    '',
    '⭐ Data: {dia da semana e data EXATAMENTE como a ferramenta agendar_consulta devolveu — ex.: terça-feira, 08/09}',
    '⏰ Horário: {HH:mm}',
    `⭐ Local: ${ENDERECO}`,
    '⏳ Chegue 15 minutos antes.',
    valor,
    '⭐ Atendimento com: {exatamente o que a tool devolveu — ela já vem como "a fisioterapeuta Fulana"; se não devolveu, omita esta linha}',
    '',
    linhaPix,
    '',
    'Qualquer dúvida, é só chamar. Até breve!',
    '',
    ...REGRAS_DE_ANTES,
    ...regraDoValor,
    '- O dia da semana vem da ferramenta ou do bloco <calendario> — nunca de cabeça.',
    '',
  ].join('\n');
}

const REGRA_COM_ANTECIPADO = [
  '- O valor menor é o ANTECIPADO (pago antes da consulta); o maior é o valor no dia.',
  '  NUNCA escreva "à vista". Não arredonde nem ofereça desconto.',
];

test('regressão: unidade comum (Serra e demais, Pix cadastrado) — a confirmação é a de antes, byte a byte', () => {
  for (const slug of ['doutor-hernia-serra', 'x']) {
    for (const flag of [undefined, true]) {
      const u = {
        ...BASE,
        slug,
        sourceProdutos: FONTES_COM,
        pixKey: '12.345.678/0001-90',
        pixHolder: 'Clinica LTDA',
        ...(flag === undefined ? {} : { acceptsAdvancePayment: flag }),
      } as unknown as Unit;
      assert.equal(
        blocoDaConfirmacao(u),
        esperadoDeAntes(
          '✨ Valor: R$ 250 antecipado (pago antes da consulta) ou R$ 350 no dia',
          'A vaga é garantida com o pagamento antecipado no PIX: 12.345.678/0001-90 (Clinica LTDA).',
          REGRA_COM_ANTECIPADO,
        ),
      );
    }
  }
});

test('regressão: Boa Vista (taxa de reserva) — a confirmação é a de antes, byte a byte, mesmo com a flag nova false', () => {
  for (const flag of [undefined, false]) {
    const u = {
      ...BASE,
      slug: 'boa-vista',
      sourceProdutos: 'Consulta: R$ 250 no dia + taxa de R$ 100 antecipado.',
      spineBookingRequiresPayment: true,
      pixKey: '11999999999',
      ...(flag === undefined ? {} : { acceptsAdvancePayment: flag }),
    } as unknown as Unit;
    assert.equal(
      blocoDaConfirmacao(u),
      esperadoDeAntes(
        '✨ Valor: R$ 350 no total — R$ 100 antecipado (já pago, garante o horário) + R$ 250 no dia',
        'Pagamento antecipado recebido — o horário está garantido. No dia, fica só o restante do valor.',
        REGRA_COM_ANTECIPADO,
      ),
    );
  }
});

test('regressão: nenhuma outra unidade ganha asterisco, ☺️ ou "Linha pronta da data" na confirmação', () => {
  const comum = blocoDaConfirmacao({ ...BASE, sourceProdutos: FONTES_COM } as unknown as Unit);
  assert.doesNotMatch(comum, /\*|☺|Linha pronta/);
  assert.match(comum, /⭐ Atendimento com:/);
});

// ---------------------------------------------------------------------------------------------------------------------
// ☺️: o envio tira o seletor de variação; só onde a unidade liga o sorriso colorido ele chega inteiro
// ---------------------------------------------------------------------------------------------------------------------


test('envio: sem a automação ligada o ☺️ perde o seletor (comportamento de sempre) — fica o ☺ puro', () => {
  comEnv({ SORRISO_COLORIDO_SLUGS: undefined, SEM_CARINHA_SLUGS: undefined }, () => {
    assert.equal(downgradeEmoji(MENSAGEM_ESPERADA, SLUG), MENSAGEM_ESPERADA.replace('️', ''));
    assert.equal(downgradeEmoji(MENSAGEM_ESPERADA), MENSAGEM_ESPERADA.replace('️', ''));
  });
});

test('envio: com sorriso-colorido ligado para a unidade, a mensagem do João chega IDÊNTICA (asteriscos e ☺️)', () => {
  comEnv({ SORRISO_COLORIDO_SLUGS: SLUG, SEM_CARINHA_SLUGS: undefined }, () => {
    assert.equal(downgradeEmoji(MENSAGEM_ESPERADA, SLUG), MENSAGEM_ESPERADA);
    assert.ok(downgradeEmoji(MENSAGEM_ESPERADA, SLUG).endsWith('☺️'));
  });
});

test('envio: ligado só para Timbó — outra unidade, outro slug ou sem slug seguem como antes', () => {
  comEnv({ SORRISO_COLORIDO_SLUGS: SLUG, SEM_CARINHA_SLUGS: undefined }, () => {
    const sem = MENSAGEM_ESPERADA.replace('️', '');
    assert.equal(downgradeEmoji(MENSAGEM_ESPERADA, 'doutor-hernia-serra'), sem);
    assert.equal(downgradeEmoji(MENSAGEM_ESPERADA, null), sem);
    assert.equal(downgradeEmoji(MENSAGEM_ESPERADA), sem);
  });
});

test('envio: onde a carinha antiga está desligada (sem-carinha) o ☺️ da confirmação sobrevive, mas o 😊 continua saindo', () => {
  comEnv({ SORRISO_COLORIDO_SLUGS: SLUG, SEM_CARINHA_SLUGS: SLUG }, () => {
    assert.equal(downgradeEmoji(MENSAGEM_ESPERADA, SLUG), MENSAGEM_ESPERADA);
    assert.equal(downgradeEmoji('Tudo certo 😊', SLUG), 'Tudo certo');
    assert.equal(downgradeEmoji('Tudo certo ☺', SLUG), 'Tudo certo', 'o ☺ puro continua sob a regra sem-carinha');
  });
  // controle: sem o sorriso colorido, o sem-carinha apaga o ☺️ inteiro (o destino de antes)
  comEnv({ SORRISO_COLORIDO_SLUGS: undefined, SEM_CARINHA_SLUGS: SLUG }, () => {
    assert.equal(downgradeEmoji('Até breve! ☺️', SLUG), 'Até breve!');
  });
});

test('envio: ligado, o resto do saneador segue valendo (4 bytes saem, outros seletores caem, 😊 vira ☺ puro)', () => {
  comEnv({ SORRISO_COLORIDO_SLUGS: SLUG, SEM_CARINHA_SLUGS: undefined }, () => {
    const r = downgradeEmoji('Olá 💰 tudo certo ☺️', SLUG);
    assert.ok(!r.includes('💰') && r.startsWith('Olá') && r.endsWith('tudo certo ☺️'), r);
    assert.equal(downgradeEmoji('Atenção ⚠️', SLUG), 'Atenção ⚠');
    assert.equal(downgradeEmoji('Oi 😊', SLUG), 'Oi ☺');
  });
});

test('FORMAS_NO_DIA é a forma de pagamento que o João pediu na linha do valor', () => {
  assert.equal(FORMAS_NO_DIA, 'dinheiro, pix, cartão de débito ou crédito');
});
