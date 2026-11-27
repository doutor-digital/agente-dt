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
  refeitaTrazHorarioNovo,
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
    ['sinto dor desde o ano passado', 'desde o ano passado'],
    ['a dor tem uns 6 meses', '6 meses'],
    ['ha anos eu convivo com essa dor', 'ha anos'],
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
  const respondeu = [ia('Entendi, Ana. E há quanto tempo você sente isso?'), p('uns 2 anos')];
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

test('cidade: "moro em casa", "no sítio", "no centro" e bairro NÃO são cidade (achado da revisão)', () => {
  for (const fala of ['moro em casa própria', 'moro no sítio', 'moro em apartamento', 'moro no centro', 'moro na fazenda']) {
    assert.ok(!temas([p(fala)]).includes('cidade'), `não deveria contar: ${fala}`);
  }
  for (const resp of ['no centro', 'bairro Nova Esperança', 'em casa']) {
    assert.ok(!temas([ia('Em qual cidade você mora?'), p(resp)]).includes('cidade'), `não deveria contar: ${resp}`);
  }
});

test('tempo: "desde que horas vocês abrem?" e "antes de 2 semanas" NÃO são o tempo da dor (achado da revisão)', () => {
  for (const fala of ['desde que horas vocês abrem?', 'não consigo antes de 2 semanas', 'só depois de 3 meses']) {
    assert.ok(!temas([p(fala)]).includes('tempo de dor'), `não deveria contar: ${fala}`);
  }
});

test('confirmar a cidade que ele disse ("Você mora em Marabá, né?") não é repetir a pergunta; perguntar a cidade é', () => {
  const ja = jaRespondidas([p('moro em Marabá')]);
  assert.deepEqual(temasRepetidosNaResposta('Perfeito! Você mora em Marabá, né? Tenho terça às 16h.', ja), []);
  assert.deepEqual(temasRepetidosNaResposta('Em qual cidade você mora?', ja), ['cidade']);
});

test('2ª revisão: negação, "vim do Hospital", resposta que é dor, cortesia e idade por extenso NÃO contam', () => {
  for (const fala of ['Não moro aqui', 'nunca morei em Marabá', 'não sou daqui', 'Vim do Hospital Santa Rita, o médico indicou vocês', 'Sou da Unimed']) {
    assert.ok(!temas([p(fala)]).includes('cidade'), `cidade não deveria contar: ${fala}`);
  }
  assert.ok(!temas([ia('Qual é a sua cidade?'), p('sinto dor na lombar')]).includes('cidade'));
  assert.ok(!temas([ia('Qual é a sua cidade?'), p('Meu nome é João')]).includes('cidade'));
  for (const fala of ['Boa tarde, desculpa incomodar, queria saber o preço', 'não quero atrapalhar', 'se não for incomodar']) {
    assert.ok(!temas([p(fala)]).includes('impacto na rotina'), `rotina não deveria contar: ${fala}`);
  }
  for (const fala of ['tenho quarenta anos e dor na lombar', 'tenho trinta anos', 'preciso de 2 dias para pensar']) {
    assert.ok(!temas([p(fala)]).includes('tempo de dor'), `tempo não deveria contar: ${fala}`);
  }
  // e o que é de verdade continua contando
  assert.ok(temas([p('a dor me atrapalha muito no trabalho')]).includes('impacto na rotina'));
  assert.ok(temas([p('isso atrapalha demais')]).includes('impacto na rotina'));
  assert.ok(temas([p('minha dor é de 3 anos')]).includes('tempo de dor'));
});

test('2ª revisão: o trecho do cartão cita a chave que é cidade, não a que é lixo', () => {
  const r = jaRespondidas([p('oi')], { cidade: 'lombar', municipio: 'Parauapebas' }).find((x) => x.tema === 'cidade');
  assert.equal(r?.trecho, 'Parauapebas');
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

/** A chave nasce DESLIGADA (automacoes.ts): o teste liga a unidade de teste, como a tela faria. */
function comChaveLigada<T>(valor: string | undefined, fn: () => T): T {
  const antes = process.env.PERGUNTA_JA_RESPONDIDA_SLUGS;
  if (valor === undefined) delete process.env.PERGUNTA_JA_RESPONDIDA_SLUGS;
  else process.env.PERGUNTA_JA_RESPONDIDA_SLUGS = valor;
  try {
    return fn();
  } finally {
    if (antes === undefined) delete process.env.PERGUNTA_JA_RESPONDIDA_SLUGS;
    else process.env.PERGUNTA_JA_RESPONDIDA_SLUGS = antes;
  }
}
const conversa: Fala[] = [
  p('oi, dor na lombar há 3 anos, moro em Marabá'),
  ia('Entendi! E há quanto tempo você sente essa dor?'),
  p('já disse, 3 anos'),
];

test('o <ja_respondido> entra no prompt do turno (conversa) e o falta_para_agendar não cobra de novo', () =>
  comChaveLigada('unidade-de-teste', () => {
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
  }));

test('o fato do cartão também vale no prompt (a cidade gravada)', () =>
  comChaveLigada('unidade-de-teste', () => {
    const prompt = composeSystemPrompt({
      unit,
      historico: [p('oi, dor na lombar'), ia('Oi! Qual seu nome?'), p('Marcos')],
      leadMemory: { facts: { nome: 'Marcos', queixa: 'lombar', cidade: 'Marabá' } } as never,
    });
    assert.match(prompt, /CIDADE: ele JÁ respondeu \(está no cartão\): "Marabá"/);
  }));

test('chave nasce DESLIGADA: sem ligar, nada de bloco nem de lista enxugada; ligada por "*" ou pelo slug, liga', () => {
  comChaveLigada(undefined, () => {
    assert.equal(perguntaJaRespondidaLigada('unidade-de-teste'), false);
    const prompt = composeSystemPrompt({ unit, historico: conversa, leadMemory: { facts: { nome: 'Marcos', queixa: 'lombar' } } as never });
    assert.doesNotMatch(prompt, /<ja_respondido>/);
    assert.match(prompt, /tempo de dor/);
  });
  comChaveLigada('outra-unidade', () => assert.equal(perguntaJaRespondidaLigada('unidade-de-teste'), false));
  comChaveLigada('unidade-de-teste', () => assert.equal(perguntaJaRespondidaLigada('unidade-de-teste'), true));
  comChaveLigada('*', () => assert.equal(perguntaJaRespondidaLigada('unidade-de-teste'), true));
});

// ── reprovação do sênior (#519) ─────────────────────────────────────────────────────────────────────────

test('E: depois de "há quanto tempo?" ou "atrapalha a rotina?", "sim", "ok", um nome, o aviso do Lite e convênio sem "?" NÃO respondem', () => {
  const lite = 'Você recebeu uma mensagem de mídia (ID da mensagem: 3EB0A1B2C3D4E5F6)';
  for (const fala of ['sim', 'ok', 'Ana', 'não sei', lite, 'vocês atendem unimed', 'aceitam convênio']) {
    assert.ok(!temas([ia('E há quanto tempo você sente essa dor?'), p(fala)]).includes('tempo de dor'), `tempo: ${fala}`);
    assert.ok(!temas([ia('Essa dor atrapalha sua rotina?'), p(fala)]).includes('impacto na rotina'), `rotina: ${fala}`);
  }
  // com conteúdo, responde
  for (const fala of ['uns 2 anos', '6 meses', 'desde janeiro', 'faz tempo', 'ontem']) {
    assert.ok(temas([ia('E há quanto tempo você sente essa dor?'), p(fala)]).includes('tempo de dor'), `tempo: ${fala}`);
  }
  for (const fala of ['no trabalho principalmente', 'não consigo dormir', 'pra sentar e levantar', 'atrapalha muito']) {
    assert.ok(temas([ia('Essa dor atrapalha sua rotina?'), p(fala)]).includes('impacto na rotina'), `rotina: ${fala}`);
  }
});

test('F: "moro perto do hospital", "no Maranhão/Pará", "na mesma rua", "em local afastado" NÃO são cidade; cidade de verdade é', () => {
  for (const fala of [
    'moro perto do hospital', 'moro no Maranhão', 'moro no Pará', 'moro na mesma rua', 'moro em local afastado',
    'moro em outra cidade', 'moro na capital', 'moramos no Tocantins', 'moro em MA', 'Sou do Maranhão',
  ]) {
    assert.ok(!temas([p(fala)]).includes('cidade'), `não deveria contar: ${fala}`);
  }
  for (const fala of ['moro em Marabá', 'moro em marabá mesmo', 'moro em Canaã dos Carajás e trabalho aqui', 'moro no Rio de Janeiro', 'moro em São Paulo', 'Sou de Eldorado dos Carajás']) {
    assert.ok(temas([p(fala)]).includes('cidade'), `deveria contar: ${fala}`);
  }
  assert.equal(jaRespondidas([p('moro em Marabá e trabalho em Parauapebas')]).find((r) => r.tema === 'cidade')?.trecho, 'moro em Marabá');
});

test('G: o tempo tem de ser DA DOR — "operei há 2 anos", "trabalho aqui faz 10 anos", "minha filha de 5 anos" não contam', () => {
  for (const fala of ['operei há 2 anos', 'trabalho nessa empresa faz 10 anos', 'minha filha de 5 anos', 'sou casada há 8 anos', 'moro aqui há 4 anos', 'meu filho nasceu há 3 meses']) {
    assert.ok(!temas([p(fala)]).includes('tempo de dor'), `não deveria contar: ${fala}`);
  }
  for (const fala of ['dói há 2 anos', 'sinto dor nas costas faz 10 anos', 'a dor começou há uns 3 meses', 'tenho hérnia de disco desde 2019', 'dor na lombar há 6 meses', 'estou com dor desde janeiro']) {
    assert.ok(temas([p(fala)]).includes('tempo de dor'), `deveria contar: ${fala}`);
  }
});

test('o cartão lê pela gaveta canônica: tempo_de_dor e localizacao=cidade de verdade contam; localizacao=lombar não', () => {
  assert.ok(temas([p('oi')], { tempo_de_dor: '2 anos' }).includes('tempo de dor'));
  assert.ok(temas([p('oi')], { localizacao: 'Imperatriz' }).includes('cidade'));
  assert.ok(!temas([p('oi')], { localizacao: 'lombar' }).includes('cidade'));
});

// ── 3ª rodada do sênior (#519) ────────────────────────────────────────────────────────────────────────

test('3: "mora" na 3ª pessoa NÃO é a cidade do paciente; só a 1ª pessoa', () => {
  for (const fala of ['minha filha mora em São Paulo', 'meu marido mora em Marabá', 'ela mora em Imperatriz', 'minha mãe está morando em Belém']) {
    assert.ok(!temas([p(fala)]).includes('cidade'), `não deveria contar: ${fala}`);
  }
  for (const fala of ['moro em Marabá', 'estou morando em Imperatriz', 'tô morando em Parauapebas', 'resido em Canaã dos Carajás', 'moramos em Redenção']) {
    assert.ok(temas([p(fala)]).includes('cidade'), `deveria contar: ${fala}`);
  }
});

test('4: "Vim de Uber", "sou de Deus", "Aqui da Igreja" NÃO viram cidade', () => {
  for (const fala of ['Vim de Uber', 'sou de Deus', 'Aqui da Igreja', 'Sou de Jesus', 'Vim da Prefeitura', 'venho de Uber']) {
    assert.ok(!temas([p(fala)]).includes('cidade'), `não deveria contar: ${fala}`);
  }
  assert.ok(temas([p('Sou de Eldorado dos Carajás')]).includes('cidade'));
});

test('5: "Ana", "Josiane", "Kelly", "Dona Maria", "Ombros" em resposta a "Em qual cidade você mora?" NÃO viram cidade', () => {
  for (const fala of ['Ana', 'Josiane', 'Kelly', 'Dona Maria', 'Seu José', 'Lombar (L4-L5)', 'João Pedro', 'joelhos', 'hérnia de disco', 'Ombros']) {
    assert.ok(!temas([ia('Em qual cidade você mora?'), p(fala)]).includes('cidade'), `não deveria contar: ${fala}`);
  }
  for (const fala of ['Marabá', 'Canaã dos Carajás', 'Lucas do Rio Verde', 'alta floresta']) {
    assert.ok(temas([ia('Em qual cidade você mora?'), p(fala)]).includes('cidade'), `deveria contar: ${fala}`);
  }
});

test('6: a resposta refeita não pode trazer horário novo nem vencido; repetir os do rascunho pode', () => {
  const agora = '2026-11-27T10:00';
  const rascunho = 'Tenho terça 01/12 às 16h ou quarta 02/12 às 9h. E há quanto tempo você sente essa dor?';
  assert.equal(refeitaTrazHorarioNovo(rascunho, 'Três anos é bastante. Tenho terça 01/12 às 16h ou quarta 02/12 às 9h, qual prefere?', agora), false);
  assert.equal(refeitaTrazHorarioNovo(rascunho, 'Três anos é bastante. Tenho quinta 03/12 às 14h, pode ser?', agora), true);
  assert.equal(refeitaTrazHorarioNovo(rascunho, 'Três anos é bastante. Tenho terça 01/12 às 17h, pode ser?', agora), true);
  assert.equal(refeitaTrazHorarioNovo('E há quanto tempo dói?', 'Entendi! Tenho amanhã às 8h, pode ser?', agora), true);
  assert.equal(refeitaTrazHorarioNovo('Tenho sexta 27/11 às 8h. Há quanto tempo?', 'Tenho sexta 27/11 às 8h, pode ser?', agora), true); // já passou
  assert.equal(refeitaTrazHorarioNovo('E há quanto tempo dói?', 'Entendi, três anos é bastante. Onde mais dói?', agora), false);
  assert.match(instrucaoRefazerSemPerguntaRepetida(['tempo de dor'], jaRespondidas([p('dói há 3 anos')])), /NÃO ofereça horário novo/);
});

test('nits: "a 2 anos" sem h, "há 5 anos" depois da cidade, bairro "Vila Nova"', () => {
  assert.ok(temas([p('tenho dor na coluna a 2 anos')]).includes('tempo de dor'));
  assert.ok(!temas([p('posso pagar daqui a 2 meses')]).includes('tempo de dor'));
  assert.equal(jaRespondidas([p('moro em Canaã dos Carajás há 5 anos')]).find((r) => r.tema === 'cidade')?.trecho, 'moro em Canaã dos Carajás');
  assert.ok(!temas([p('moro na Vila Nova')]).includes('cidade'));
  assert.ok(!temas([p('moro no Jardim Tropical')]).includes('cidade'));
  assert.ok(temas([p('moro em Vila Velha')]).includes('cidade'));
});

test('4ª rodada: "Sou da Assembleia de Deus" não é cidade; palavra solta que não é cidade conhecida, na dúvida, não aceita', () => {
  for (const fala of ['Sou da Assembleia de Deus', 'sou da Congregação Cristã', 'Sou da Paróquia São José']) {
    assert.ok(!temas([p(fala)]).includes('cidade'), `não deveria contar: ${fala}`);
  }
  // uma palavra desconhecida pode ser o nome dele; com "moro em" é explícito e vale
  assert.ok(!temas([ia('Em qual cidade você mora?'), p('Xambioá')]).includes('cidade'));
  assert.ok(temas([p('moro em Xambioá')]).includes('cidade'));
  assert.ok(temas([ia('Em qual cidade você mora?'), p('Parauapebas')]).includes('cidade'));
  assert.ok(temas([ia('Em qual cidade você mora?'), p('Santa Inês')]).includes('cidade'));
});

test('4ª rodada: "moro em não informado" e placeholders no "moro em" também não valem', () => {
  for (const fala of ['moro em não sei onde', 'moro em outra cidade', 'moro no interior']) {
    assert.ok(!temas([p(fala)]).includes('cidade'), fala);
  }
});
