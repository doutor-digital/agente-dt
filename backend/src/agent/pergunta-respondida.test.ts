/**
 * A Sofia perguntando de novo o que o paciente já respondeu (relatório de 27/11/2026): há quanto tempo dói, a cidade, como a
 * dor atrapalha a rotina. As conversas abaixo seguem o jeito real de escrever dos pacientes (áudio transcrito, caixa baixa,
 * sem pontuação), com nomes trocados.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import {
  instrucaoRefazerSemPerguntaRepetida,
  jaRespondidas,
  perguntaJaRespondidaLigada,
  renderJaRespondido,
  rotulosRespondidos,
  temaDaPergunta,
  temasRepetidosNaResposta,
} from './pergunta-respondida.js';
import { renderFaltaParaAgendar } from './falta-para-agendar.js';
import { composeSystemPrompt } from './prompt-composer.js';
import type { Fala } from './repeticao.js';

const p = (texto: string): Fala => ({ papel: 'paciente', texto });
const ia = (texto: string): Fala => ({ papel: 'ia', texto });
const temas = (falas: Fala[], fatos?: Record<string, unknown>) => jaRespondidas(falas, fatos).map((r) => r.tema);

test('que pergunta é: tempo, cidade e rotina, em várias formulações', () => {
  assert.equal(temaDaPergunta('E há quanto tempo você sente essa dor?'), 'tempo de dor');
  assert.equal(temaDaPergunta('Desde quando isso começou?'), 'tempo de dor');
  assert.equal(temaDaPergunta('Faz quanto tempo que dói?'), 'tempo de dor');
  assert.equal(temaDaPergunta('Você mora em Parauapebas mesmo?'), 'cidade');
  assert.equal(temaDaPergunta('Em qual cidade você mora?'), 'cidade');
  assert.equal(temaDaPergunta('De onde você é?'), 'cidade');
  assert.equal(temaDaPergunta('Essa dor atrapalha sua rotina, o trabalho ou o sono?'), 'impacto na rotina');
  assert.equal(temaDaPergunta('Como essa dor tem impactado o seu dia a dia?'), 'impacto na rotina');
  assert.equal(temaDaPergunta('Isso afeta o seu trabalho?'), 'impacto na rotina');
  // não são destes temas
  assert.equal(temaDaPergunta('Onde dói?'), null);
  assert.equal(temaDaPergunta('Qual horário fica melhor pra você?'), null);
  assert.equal(temaDaPergunta('Posso te ajudar com mais alguma coisa?'), null);
});

test('tempo de dor: o paciente diz do jeito dele, antes mesmo de a Sofia perguntar', () => {
  for (const [fala, trecho] of [
    ['Oi, tenho uma hérnia de disco, dói há 3 anos e agora piorou', 'ha 3 anos'],
    ['faz uns 2 meses que eu sinto essa dor nas costas', 'faz uns 2 meses'],
    ['[áudio do cliente]: oi boa tarde eu tô com dor na coluna já faz um bom tempo, faz tempo mesmo', 'faz tempo'],
    ['dor desde janeiro, só piora', 'desde janeiro'],
    ['desde o ano passado', 'desde o ano passado'],
    ['uns 6 meses', '6 meses'],
    ['ha anos eu convivo com isso', 'ha anos'],
  ] as const) {
    const r = jaRespondidas([p(fala)]).find((x) => x.tema === 'tempo de dor');
    assert.ok(r, `deveria contar: ${fala}`);
    assert.match(r.trecho, new RegExp(trecho), fala);
    assert.equal(r.origem, 'conversa');
  }
});

test('tempo de dor: idade, prazo que vem e "um dia" NÃO são o tempo da dor', () => {
  for (const fala of [
    'tenho 52 anos e dor na lombar',
    'tenho 40 anos',
    'só recebo daqui 15 dias, posso marcar depois?',
    'dá pra marcar em 2 semanas?',
    'um dia eu levantei um peso e senti',
    'minha mãe tem 70 anos e quer consultar',
    'quanto custa a consulta?',
  ]) {
    assert.ok(!temas([p(fala)]).includes('tempo de dor'), `não deveria contar: ${fala}`);
  }
});

test('tempo de dor: a fala logo depois da pergunta (só dela) é a resposta; outra pergunta não é', () => {
  const respondeu = [ia('Entendi, Ana. E há quanto tempo você sente isso?'), p('não lembro direito, bastante')];
  assert.ok(temas(respondeu).includes('tempo de dor'));
  const fugiu = [ia('Entendi, Ana. E há quanto tempo você sente isso?'), p('quanto custa a consulta?')];
  assert.ok(!temas(fugiu).includes('tempo de dor'));
  // pergunta dupla: a fala curta pode ter respondido só a outra metade
  const dupla = [ia('Onde dói e há quanto tempo?'), p('lombar')];
  assert.ok(!temas(dupla).includes('tempo de dor'));
});

test('cidade: "moro em", "sou de", "aqui em" valem; "sou de confiança" e "vim do Instagram" não', () => {
  for (const fala of [
    'moro em Marabá',
    'eu moro aqui em Parauapebas mesmo',
    'moro aqui',
    'Sou de Eldorado dos Carajás',
    'venho de Curionópolis, é longe?',
    '[áudio do cliente]: bom dia eu moro na cidade de Canaã dos Carajás e queria saber',
    'Moramos em Redenção',
  ]) {
    assert.ok(temas([p(fala)]).includes('cidade'), `deveria contar: ${fala}`);
  }
  for (const fala of [
    'sou de confiança, pode marcar',
    'vim do Instagram, vi o anúncio',
    'moro longe, será que compensa?',
    'tenho dor na lombar',
    'Boa tarde, queria o valor',
  ]) {
    assert.ok(!temas([p(fala)]).includes('cidade'), `não deveria contar: ${fala}`);
  }
});

test('cidade: resposta curta logo depois da pergunta só dela conta; sim/não, preço e fala longa não', () => {
  assert.ok(temas([ia('Você mora aqui em Parauapebas?'), p('Parauapebas mesmo')]).includes('cidade'));
  assert.ok(temas([ia('Em qual cidade você mora?'), p('Marabá')]).includes('cidade'));
  assert.ok(!temas([ia('Em qual cidade você mora?'), p('quanto é a consulta')]).includes('cidade'));
  assert.ok(!temas([ia('Em qual cidade você mora?'), p('sim')]).includes('cidade'));
  assert.ok(!temas([ia('Em qual cidade você mora?'), p('lombar')].slice(0, 1)).includes('cidade'));
  assert.ok(!temas([ia('Onde dói e em qual cidade você mora?'), p('lombar')]).includes('cidade'));
});

test('cidade: no cartão só vale se for cidade (localização é onde dói)', () => {
  assert.ok(temas([p('oi')], { cidade: 'Marabá' }).includes('cidade'));
  assert.ok(!temas([p('oi')], { localizacao: 'lombar' }).includes('cidade'));
  assert.ok(!temas([p('oi')], { cidade: 'lombar do lado direito' }).includes('cidade'));
  const doCartao = jaRespondidas([p('oi')], { cidade: 'Marabá' }).find((r) => r.tema === 'cidade');
  assert.equal(doCartao?.origem, 'cartão');
  assert.equal(doCartao?.trecho, 'Marabá');
});

test('impacto na rotina: o que ele conta do dia a dia conta, e o fato do cartão também', () => {
  for (const fala of [
    'a dor atrapalha muito meu trabalho, sou pedreiro',
    'não consigo mais dormir direito',
    'eu acordo com dor de madrugada',
    'não consigo trabalhar mais, tô afastado',
    '[áudio do cliente]: tá me impedindo de brincar com meus filhos, não aguento mais',
  ]) {
    assert.ok(temas([p(fala)]).includes('impacto na rotina'), `deveria contar: ${fala}`);
  }
  assert.ok(temas([p('oi')], { impacto: 'não dorme' }).includes('impacto na rotina'));
  assert.ok(!temas([p('tenho dor na lombar há anos')]).includes('impacto na rotina'));
});

test('caso real: Sofia pergunta o tempo 3 vezes a quem já disse "há 3 anos" no primeiro áudio', () => {
  const conversa: Fala[] = [
    p('[áudio do cliente]: oi eu tenho hérnia de disco há 3 anos e já fiz fisioterapia mas não resolveu moro em Marabá'),
    ia('Oi! Que bom falar com você 😊 Como posso te chamar?'),
    p('Marcos'),
    ia('Prazer, Marcos! E há quanto tempo você sente essa dor?'),
    p('já falei, 3 anos'),
  ];
  const ja = jaRespondidas(conversa);
  assert.deepEqual(ja.map((r) => r.tema), ['tempo de dor', 'cidade']);
  // a resposta do modelo que pergunta de novo é pega, nos dois temas
  assert.deepEqual(temasRepetidosNaResposta('Entendi, Marcos. E há quanto tempo você sente essa dor?', ja), ['tempo de dor']);
  assert.deepEqual(temasRepetidosNaResposta('Me confirma: você mora em qual cidade? E desde quando dói?', ja).sort(), ['cidade', 'tempo de dor']);
  // a que usa a resposta e segue passa
  assert.deepEqual(temasRepetidosNaResposta('Três anos é bastante, Marcos. Tenho terça às 16h ou quarta às 9h, qual fica melhor?', ja), []);
  // pergunta de outro tema não é pega
  assert.deepEqual(temasRepetidosNaResposta('E onde mais dói, só na lombar?', ja), []);
});

test('sem evidência, nada: na dúvida a Sofia ainda pergunta', () => {
  assert.deepEqual(jaRespondidas([p('oi, queria saber o valor da consulta')]), []);
  assert.deepEqual(jaRespondidas([]), []);
  assert.deepEqual(temasRepetidosNaResposta('Há quanto tempo você sente essa dor?', []), []);
});

test('o bloco do prompt cita o que ele disse e proíbe a pergunta; vazio quando não há nada', () => {
  assert.equal(renderJaRespondido([]), '');
  const bloco = renderJaRespondido(jaRespondidas([p('dói há 3 anos'), p('moro em Marabá')]));
  assert.match(bloco, /<ja_respondido>/);
  assert.match(bloco, /TEMPO DE DOR: ele JÁ respondeu \(na conversa\): "ha 3 anos"/);
  assert.match(bloco, /NÃO pergunte "há quanto tempo"/);
  assert.match(bloco, /CIDADE: ele JÁ respondeu/);
  assert.match(bloco, /NÃO pergunte a cidade/);
});

test('a instrução de refazer diz o que ele respondeu e não manda inventar pergunta', () => {
  const ja = jaRespondidas([p('dói há 3 anos')]);
  const t = instrucaoRefazerSemPerguntaRepetida(['tempo de dor'], ja);
  assert.match(t, /instrução interna, não é fala do paciente/);
  assert.match(t, /tempo de dor \("ha 3 anos"\)/);
  assert.match(t, /SEM essa\(s\) pergunta\(s\)/);
});

test('<falta_para_agendar> tira o tempo e a cidade que ele já disse na conversa', () => {
  const ja = rotulosRespondidos(jaRespondidas([p('dói há 3 anos'), p('moro em Marabá')]));
  assert.deepEqual(ja, ['tempo de dor', 'cidade']);
  const sem = renderFaltaParaAgendar({ nome: 'Marcos', queixa: 'hérnia de disco' }, { jaRespondidos: ja });
  assert.doesNotMatch(sem, /tempo de dor/);
  assert.doesNotMatch(sem, /cidade/);
  assert.match(sem, /Ainda falta, nesta ordem: horário escolhido/);
  const com = renderFaltaParaAgendar({ nome: 'Marcos', queixa: 'hérnia de disco' });
  assert.match(com, /tempo de dor → cidade → horário escolhido/);
});

// ── no prompt do turno ──────────────────────────────────────────────────────────────────────────────────

const unit = { slug: 'unidade-de-teste', name: 'T', collectNameEnabled: false, personaEmojis: [], handoffKeywords: [] } as unknown as Unit;
const conversa: Fala[] = [
  p('oi, dor na lombar há 3 anos, moro em Marabá'),
  ia('Entendi! E há quanto tempo você sente essa dor?'),
  p('já disse, 3 anos'),
];

test('o <ja_respondido> entra no prompt do turno (conversa) e o falta_para_agendar não cobra de novo', () => {
  const prompt = composeSystemPrompt({
    unit,
    historico: conversa,
    leadMemory: { facts: { nome: 'Marcos', queixa: 'lombar' } } as never,
  });
  assert.match(prompt, /<ja_respondido>[\s\S]*TEMPO DE DOR/);
  const falta = prompt.slice(prompt.indexOf('<falta_para_agendar>'), prompt.indexOf('</falta_para_agendar>'));
  assert.ok(falta.length > 0);
  assert.doesNotMatch(falta, /tempo de dor/);
  assert.doesNotMatch(falta, /cidade/);
});

test('o fato do cartão também vale no prompt (a cidade gravada)', () => {
  const prompt = composeSystemPrompt({
    unit,
    historico: [p('oi, dor na lombar'), ia('Oi! Qual seu nome?'), p('Marcos')],
    leadMemory: { facts: { nome: 'Marcos', queixa: 'lombar', cidade: 'Marabá' } } as never,
  });
  assert.match(prompt, /CIDADE: ele JÁ respondeu \(está no cartão\): "Marabá"/);
});

test('chave desligada: nada de bloco nem de lista enxugada', () => {
  const antes = process.env.PERGUNTA_JA_RESPONDIDA_SLUGS;
  // a chave nasce ligada (quandoVazio: 'todas'); com a lista preenchida sem a unidade, fica desligada
  process.env.PERGUNTA_JA_RESPONDIDA_SLUGS = 'outra-unidade';
  try {
    assert.equal(perguntaJaRespondidaLigada('unidade-de-teste'), false);
    const prompt = composeSystemPrompt({ unit, historico: conversa, leadMemory: { facts: { nome: 'Marcos', queixa: 'lombar' } } as never });
    assert.doesNotMatch(prompt, /<ja_respondido>/);
    assert.match(prompt, /tempo de dor/);
  } finally {
    if (antes === undefined) delete process.env.PERGUNTA_JA_RESPONDIDA_SLUGS;
    else process.env.PERGUNTA_JA_RESPONDIDA_SLUGS = antes;
  }
  assert.equal(perguntaJaRespondidaLigada('unidade-de-teste'), true);
});
