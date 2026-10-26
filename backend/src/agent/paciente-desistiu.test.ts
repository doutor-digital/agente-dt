/**
 * Item 6 da Suzanne (25/10/2026), decisão do João em 26/10: quando o paciente escreve "cancelei"/"desmarquei"/"não vou",
 * a Sofia TENTA REMARCAR — acolhe em uma frase e oferece novo horário, em vez de perguntar "tem certeza?".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { composeSystemPrompt } from './prompt-composer.js';
import type { Fala } from './repeticao.js';
import { pacienteDesistiu, renderPacienteDesistiu } from './paciente-desistiu.js';
import { oferecuHorario, pareceDesistenciaDaConsulta, perguntouConfirmarCancelamento, quisManter, recusouRemarcarExplicitamente } from '../lib/desistencia-frases.js';

const p = (texto: string): Fala => ({ papel: 'paciente', texto });
const ia = (texto: string): Fala => ({ papel: 'ia', texto });

// Araguaína #28861610 (22/10): respondeu ao lembrete de 24 h.
const LILIANE = [ia('Olá! Sua consulta é amanhã, 23/10, às 14:00. Posso confirmar?'), p('Cancelei.')];

test('"Cancelei." depois do lembrete → o bloco manda REMARCAR, não perguntar "tem certeza?"', () => {
  assert.equal(pacienteDesistiu(LILIANE)?.trecho, 'Cancelei.');
  const bloco = renderPacienteDesistiu(LILIANE);
  assert.match(bloco, /<paciente_desistiu>/);
  assert.match(bloco, /TENTA REMARCAR/);
  assert.match(bloco, /consultar_horarios/);
  assert.match(bloco, /DOIS horários reais/);
  assert.match(bloco, /remarcar_consulta/);
  assert.match(bloco, /NÃO pergunte "tem certeza\?"/);
  assert.match(bloco, /NÃO chame cancelar_consulta agora/);
  assert.match(bloco, /NÃO chame cancelar_consulta agora/);
  assert.match(bloco, /Se não tem/, 'sem consulta marcada o bloco manda ignorar');
});

test('as mensagens seguidas do turno contam; a de antes da última fala da Sofia só como o par da oferta', () => {
  assert.equal(pacienteDesistiu([ia('Quer horário?'), p('oi'), p('tive um imprevisto, não vou poder ir')])?.trecho, 'tive um imprevisto, não vou poder ir');
  // ele escolheu um horário da oferta: ainda é o par "avisou → ofereceu → respondeu", e o bloco manda remarcar
  assert.equal(pacienteDesistiu([p('Cancelei.'), ia('Sem problema! Posso te oferecer sexta às 14h ou segunda às 9h?'), p('segunda às 9h')])?.momento, 'respondeu_a_oferta');
});

test('conversa normal não ganha o bloco', () => {
  assert.equal(renderPacienteDesistiu([ia('Quer que eu veja um horário?'), p('Sim')]), '');
  assert.equal(renderPacienteDesistiu([ia('Segue o contrato'), p('Segue o print do cancelamento de contrato')]), '');
  assert.equal(renderPacienteDesistiu(undefined), '');
  assert.equal(renderPacienteDesistiu([]), '');
});

test('o prompt do turno ganha o bloco só quando ele desistiu, e o texto de "pedido de CANCELAR" aponta para ele', () => {
  const unidade = { id: 'u1', slug: 'teste', name: 'Clínica Teste', personaEmojis: [], handoffKeywords: [] } as unknown as Unit;
  const com = composeSystemPrompt({ unit: unidade, historico: LILIANE });
  assert.match(com, /<paciente_desistiu>/);
  assert.match(com, /Cancelei\./);
  const sem = composeSystemPrompt({ unit: unidade, historico: [ia('Quer que eu veja um horário pra você?'), p('Sim')] });
  assert.doesNotMatch(sem, /<paciente_desistiu>/);
});

const OFERTA = 'Tudo bem! Se quiser, tenho sexta às 10h ou segunda às 14h. Qual fica melhor?';

test('depois da oferta, "pode cancelar mesmo" é a recusa: o bloco NÃO manda oferecer de novo', () => {
  const falas = [ia('Olá! Sua consulta é amanhã, 23/10, às 14:00. Posso confirmar?'), p('Cancelei.'), ia(OFERTA), p('não, pode cancelar mesmo')];
  assert.equal(pacienteDesistiu(falas)?.momento, 'insistiu');
  const bloco = renderPacienteDesistiu(falas, { slug: 'doutor-hernia-araguaina' });
  assert.match(bloco, /JÁ tinha avisado/);
  assert.match(bloco, /NÃO ofereça os mesmos horários/);
  assert.match(bloco, /Confirmo o cancelamento da sua consulta de/);
  assert.match(bloco, /criar_tarefa/);
  assert.doesNotMatch(bloco, /DOIS horários reais/);
  // a primeira vez continua mandando remarcar
  assert.equal(pacienteDesistiu(LILIANE)?.momento, 'avisou');
});

test('a recusa que NÃO parece desistência ("não quero remarcar", "depois eu vejo") ainda recebe o bloco certo, explícita ou não', () => {
  for (const resposta of ['não quero remarcar', 'não, obrigado', 'depois eu vejo e te aviso', 'deixa pra lá']) {
    const falas = [ia('Sua consulta é amanhã. Posso confirmar?'), p('Cancelei.'), ia(OFERTA), p(resposta)];
    assert.equal(pacienteDesistiu(falas)?.momento, 'respondeu_a_oferta', resposta);
    const bloco = renderPacienteDesistiu(falas, { slug: 'doutor-hernia-araguaina' });
    assert.match(bloco, /RESPOSTA dele à oferta/);
    assert.match(bloco, /remarcar_consulta/, 'escolheu horário → remarca');
    assert.match(bloco, /OUTRA coisa/, 'pergunta de outro assunto não ganha o fecho');
  }
  assert.match(renderPacienteDesistiu([ia('Sua consulta é amanhã. Posso confirmar?'), p('Cancelei.'), ia(OFERTA), p('não quero remarcar')], { slug: 'doutor-hernia-araguaina' }), /ALERTA · doutor-hernia-araguaina/);
});

test('só vale se a Sofia de fato ofereceu horário e se a desistência foi o turno logo antes', () => {
  // a Sofia respondeu outra coisa (preço), não ofereceu horário → o "de novo" é um aviso novo, não recusa
  const semOferta = [p('Cancelei.'), ia('Entendi. O valor da consulta é R$ 250.'), p('não vou poder ir')];
  assert.equal(pacienteDesistiu(semOferta)?.momento, 'avisou');
  // desistência antiga, remarcada, e depois uma conversa qualquer: sem bloco
  const antiga = [p('Cancelei.'), ia(OFERTA), p('sexta 10h'), ia('Remarcado para sexta às 10h!'), p('obrigada')];
  assert.equal(pacienteDesistiu(antiga), null);
  assert.equal(renderPacienteDesistiu(antiga), '');
});

test('horário no formato "14h30" também é oferta; "nosso horário de atendimento" não é', () => {
  const oferta30 = [ia('Sua consulta é amanhã. Posso confirmar?'), p('Cancelei.'), ia('Tudo bem! Tenho sexta às 14h30 ou segunda às 10h30. Qual fica melhor?'), p('não quero remarcar')];
  assert.equal(pacienteDesistiu(oferta30)?.momento, 'respondeu_a_oferta');
  // depois do fecho, a despedida fala do "horário de atendimento" — o próximo "obrigada" não reabre o bloco
  const depoisDoFecho = [p('Cancelei.'), ia('Tenho sexta às 10h ou segunda às 14h'), p('pode cancelar mesmo'), ia('Tudo bem! Nosso horário de atendimento é das 8h às 18h; qualquer coisa é só chamar.'), p('obrigada')];
  assert.equal(pacienteDesistiu(depoisDoFecho), null);
});

// ── a decisão de 26/10: recusa EXPLÍCITA cancela na franquia; hesitação não; sem vínculo/erro → tarefa ───────────────

const COM_OFERTA = (resposta: string): Fala[] => [ia('Sua consulta é amanhã. Posso confirmar?'), p('Cancelei.'), ia(OFERTA), p(resposta)];

test('o classificador: recusa explícita × hesitação × negação', () => {
  for (const t of ['não quero remarcar', 'pode cancelar mesmo', 'cancela por favor', 'desisti', 'não quero mais', 'não vou remarcar']) {
    assert.equal(recusouRemarcarExplicitamente(t), true, t);
  }
  for (const t of ['acho que não vou conseguir', 'vou ver', 'depois eu aviso', 'talvez outro dia', 'não cancele', 'posso cancelar?', 'obrigada', 'sexta às 10h', '']) {
    assert.equal(recusouRemarcarExplicitamente(t), false, t);
  }
});

test('CAMINHO 1 — recusa explícita: NÃO cancela ainda; manda perguntar "Confirmo o cancelamento da sua consulta de <dia> às <hora>?"', () => {
  for (const r of ['não quero remarcar', 'pode cancelar mesmo']) {
    const bloco = renderPacienteDesistiu(COM_OFERTA(r), { slug: 'doutor-hernia-araguaina' });
    assert.match(bloco, /RECUSA EXPLÍCITA, mas ainda NÃO cancele/, r);
    assert.match(bloco, /pergunte EXATAMENTE: "Confirmo o cancelamento da sua consulta de/, r);
    assert.match(bloco, /só se ele responder "sim" a ESSA pergunta/, r);
    assert.doesNotMatch(bloco, /Ele disse "sim" à pergunta/, r);
  }
});

test('CAMINHO 1b — depois da pergunta nomeada, SÓ um "sim" a ela chama cancelar_consulta(confirmado=true)', () => {
  const pergunta = ia('Confirmo o cancelamento da sua consulta de quinta-feira, 29/10 às 14h?');
  for (const sim of ['sim', 'Sim, pode', 'confirmo', 'pode cancelar', 'sim, pode cancelar', 'pode sim', 'Sim, pode cancelar, não vou poder ir', 'Isso, não preciso mais', 'sim, deixa cancelar', 'Sim, confirmo o cancelamento', 'isso mesmo', 'com certeza, pode cancelar por favor']) {
    const d = pacienteDesistiu([p('Cancelei.'), ia(OFERTA), p('não quero remarcar'), pergunta, p(sim)]);
    assert.equal(d?.momento, 'confirmando', sim);
    assert.equal(d?.resposta, 'sim', sim);
    assert.match(renderPacienteDesistiu([p('Cancelei.'), ia(OFERTA), p('não quero remarcar'), pergunta, p(sim)], { slug: 'araguaina' }), /chame cancelar_consulta com confirmado=true/, sim);
  }
  // "não", "manter", pergunta ou outro assunto: NÃO cancela
  for (const nao of ['não', 'quero manter', 'espera, qual é o horário mesmo?', 'quanto custa?', 'depois eu vejo', 'pode ser outro dia', 'sim, mas quanto custa o retorno', 'pode me explicar como funciona']) {
    const falas = [p('Cancelei.'), ia(OFERTA), p('não quero remarcar'), pergunta, p(nao)];
    const bloco = renderPacienteDesistiu(falas, { slug: 'araguaina' });
    assert.doesNotMatch(bloco, /chame cancelar_consulta com confirmado=true/, nao);
    assert.match(bloco, /NÃO cancele/, nao);
  }
});

test('CAMINHO 2 — sem vínculo, consulta passada/atendida ou erro: o bloco manda NÃO dizer que cancelou e abrir tarefa ALERTA', () => {
  const falas = [p('Cancelei.'), ia(OFERTA), p('não quero remarcar'), ia('Confirmo o cancelamento da sua consulta de quinta, 29/10 às 14h?'), p('sim')];
  const bloco = renderPacienteDesistiu(falas, { slug: 'doutor-hernia-araguaina' });
  assert.match(bloco, /não há consulta marcada por aqui, que a consulta já passou\/foi atendida, que não conseguiu confirmar na clínica ou devolver erro: NÃO diga que cancelou/);
  assert.match(bloco, /ALERTA · doutor-hernia-araguaina · \[Contato: primeiro nome\] Desistiu da consulta de DD\/MM: cancelar na franquia/);
  assert.match(bloco, /NO_FOLLOW_UP/);
  assert.match(bloco, /Se a ferramenta confirmar: diga em UMA frase/);
  assert.match(bloco, /NÃO ofereça outro horário/);
});

test('CAMINHO 3 — hesitação ("acho que não vou conseguir", "vou ver"): NÃO cancela, oferece remarcar', () => {
  for (const r of ['acho que não vou conseguir', 'vou ver', 'depois eu aviso']) {
    const bloco = renderPacienteDesistiu(COM_OFERTA(r), { slug: 'x' });
    assert.match(bloco, /NÃO cancele a consulta/, r);
    assert.doesNotMatch(bloco, /RECUSA EXPLÍCITA/, r);
    assert.doesNotMatch(bloco, /cancelar_consulta com confirmado=true/, r);
  }
});

test('no PRIMEIRO aviso ("Cancelei"/"pode cancelar") a Sofia nunca cancela: primeiro a oferta de horário', () => {
  for (const t of ['Cancelei.', 'pode cancelar']) {
    const bloco = renderPacienteDesistiu([ia('Posso confirmar?'), p(t)], { slug: 'x' });
    assert.match(bloco, /NÃO chame cancelar_consulta agora/, t);
    assert.doesNotMatch(bloco, /RECUSA EXPLÍCITA/, t);
  }
});

// ── revisão do sênior (#132): um teste por frase ───────────────────────────────────────────────────────────────────

const QUEM_QUER_MANTER = [
  'Não quero remarcar, quero manter',
  'não preciso remarcar, vou sim',
  'não quero outro dia, prefiro manter a de amanhã',
  'consegui me organizar, não vou mais faltar',
  'cancela não',
];
for (const frase of QUEM_QUER_MANTER) {
  test(`"${frase}" é MANTER, não recusa: nunca manda cancelar`, () => {
    assert.equal(recusouRemarcarExplicitamente(frase), false);
    assert.equal(pareceDesistenciaDaConsulta(frase), false, 'e não calaria régua nem véspera');
    const bloco = renderPacienteDesistiu(COM_OFERTA(frase), { slug: 'araguaina' });
    assert.doesNotMatch(bloco, /RECUSA EXPLÍCITA/);
    assert.doesNotMatch(bloco, /Confirmo o cancelamento/);
    assert.match(bloco, /quer MANTER a consulta/);
  });
}

for (const frase of ['cancela a do meu filho, a minha mantém', 'cancela a minha de terça e deixa a de quinta', 'preciso cancelar a consulta da minha mãe']) {
  test(`"${frase}": é OUTRA consulta — a Sofia não cancela sozinha, a equipe confere (tarefa)`, () => {
    const d = pacienteDesistiu([ia('Sua consulta é amanhã. Posso confirmar?'), p(frase)]);
    assert.equal(d?.momento, 'outra_consulta');
    assert.equal(pareceDesistenciaDaConsulta(frase), false, 'não cala a véspera de quem mantém a sua');
    const bloco = renderPacienteDesistiu([ia('Posso confirmar?'), p(frase)], { slug: 'doutor-hernia-araguaina' });
    assert.match(bloco, /NÃO chame cancelar_consulta/);
    assert.match(bloco, /ALERTA · doutor-hernia-araguaina/);
  });
}

test('a oferta em DUAS mensagens da Sofia não faz o bloco sumir: "não quero remarcar" ainda recebe a pergunta de confirmação', () => {
  const falas = [p('Cancelei.'), ia('Entendo, vou ver os horários.'), ia('Tenho sexta 30/10 às 14h ou sábado 31/10 às 10h. Qual prefere?'), p('não quero remarcar')];
  const d = pacienteDesistiu(falas);
  assert.equal(d?.momento, 'respondeu_a_oferta');
  assert.equal(d?.recusaExplicita, true);
  assert.match(renderPacienteDesistiu(falas, { slug: 'x' }), /Confirmo o cancelamento da sua consulta de/);
});

test('"amanhã" conta como dia da oferta; faixa de funcionamento e lembrete NÃO são oferta', () => {
  assert.equal(oferecuHorario('Tenho amanhã às 9h ou às 14h30. Qual prefere?'), true);
  assert.equal(oferecuHorario('Posso te oferecer sexta às 10h'), true);
  assert.equal(oferecuHorario('Atendemos de segunda a sexta das 8h às 18h'), false);
  assert.equal(oferecuHorario('Nosso horário de atendimento é de segunda a sexta, das 8h às 18h'), false);
  assert.equal(oferecuHorario('Sua consulta é amanhã às 14h, confirma?'), false, 'lembrete não é oferta');
  // o lembrete seguido de "não quero mais" não é "recusou a oferta"
  assert.equal(pacienteDesistiu([p('não vou poder ir'), ia('Sua consulta é amanhã às 14h, confirma?'), p('não quero mais')]), null, 'o lembrete não é oferta: não há par');
});

for (const frase of ['não vou mais atrasar, prometo', 'Não vou mais esquecer', 'não vou mais demorar', 'não vou mais faltar']) {
  test(`nit: "${frase}" não é desistência`, () => {
    assert.equal(pareceDesistenciaDaConsulta(frase), false);
  });
}

test('achados da 5ª revisão: outra consulta exige verbo de cancelar; "manter"/"eu vou" não valem quando dizem o contrário', () => {
  // nada de alerta falso para quem só cita a consulta de um familiar
  for (const t of ['quero marcar a consulta da minha esposa também', 'a consulta do meu pai é amanhã']) {
    assert.equal(pacienteDesistiu([ia('Posso ajudar?'), p(t)]), null, t);
  }
  // quem diz o contrário de manter continua sendo desistência
  for (const t of ['Não vou conseguir manter a consulta de amanhã', 'Eu vou viajar, não vou poder ir']) {
    assert.equal(quisManter(t), false, t);
    assert.equal(pareceDesistenciaDaConsulta(t), true, t);
  }
  // a pergunta reescrita pelo modelo ainda é a pergunta de confirmação
  for (const q of ['Posso confirmar o cancelamento da sua consulta de quinta, às 14h?', 'Confirmo o cancelamento da sua consulta de quinta?', 'confirmo o cancelamento da sua  consulta']) {
    assert.equal(perguntouConfirmarCancelamento(q), true, q);
  }
});
