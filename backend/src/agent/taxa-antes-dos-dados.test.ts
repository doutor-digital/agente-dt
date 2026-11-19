/**
 * Boa Vista (taxa de reserva obrigatória), 19/11/2026: ao escolher o horário, a Sofia respondia "Pra eu deixar sua vaga garantida, me
 * passa seu nome completo e um telefone com DDD" — sem falar da taxa nem pedir o comprovante. A causa era o prompt MONTADO pelo código:
 * a SEQUÊNCIA OBRIGATÓRIA da agenda mandava "escolheu → buscar_paciente → pergunte nome e telefone → agendar", e as regras gerais
 * diziam "dia → horário → dados → Pix". Para a unidade com taxa o passo seguinte ao horário é a taxa (Pix + comprovante).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { composeSystemPrompt, renderRulesGlobal, sequenciaDepoisDoHorario } from './prompt-composer.js';

const BOA_VISTA = {
  id: 'u-bv',
  slug: 'doutor-hernia-boa-vista',
  name: 'Boa Vista',
  category: 'saude',
  spineEnabled: true,
  spineAgendaStart: '08:00',
  spineAgendaEnd: '17:00',
  spineAgendaDays: [1, 2, 3, 4, 5],
  spineBookingRequiresPayment: true,
  acceptsAdvancePayment: true,
  pixKey: '49.485.277/0001-40',
  pixHolder: 'BENSAG FISIOTERAPIA LTDA',
  clinicAddress: 'Av. Ville Roy, 4301 — Canarinho, Boa Vista/RR',
  sourceProdutos: 'Consulta: R$ 350 no total — R$ 100 antecipados (taxa de agendamento) + R$ 250 no dia.',
  sourcePapel: null,
  sourceNegocio: null,
  systemPrompt: '',
  sinalPixCentavos: null,
  pipelineIntents: null,
} as unknown as Unit;

const OUTRA = { ...BOA_VISTA, id: 'u-x', slug: 'doutor-hernia-x', spineBookingRequiresPayment: false } as unknown as Unit;

/** O trecho da SEQUÊNCIA OBRIGATÓRIA entre o passo 2 e o "QUANDO A TOOL RECUSAR". */
function sequencia(prompt: string): string {
  const ini = prompt.indexOf('SEQUÊNCIA OBRIGATÓRIA');
  const fim = prompt.indexOf('QUANDO A TOOL RECUSAR');
  assert.ok(ini >= 0 && fim > ini, 'a sequência da agenda precisa estar no prompt');
  return prompt.slice(ini, fim);
}

test('taxa obrigatória: escolher o horário leva à taxa e ao comprovante, e nome/telefone só depois', () => {
  const seq = sequencia(composeSystemPrompt({ unit: BOA_VISTA }));
  const passo3 = seq.slice(seq.indexOf('3. '), seq.indexOf('4. '));
  assert.match(passo3, /ESCOLHER o horário/);
  assert.match(passo3, /taxa de\s+agendamento de R\$ 100 \(abate do total: ficam R\$ 250 no dia\)/);
  assert.match(passo3, /não pede nome nem telefone/);
  assert.match(passo3, /chave Pix 49\.485\.277\/0001-40 \(BENSAG FISIOTERAPIA LTDA\)/);
  assert.match(passo3, /comprovante/);
  // a resposta à escolha não vira uma nova consulta de agenda (a rodada local de 19/11 caía em "vou confirmar a disponibilidade")
  assert.match(passo3, /NÃO chame consultar_horarios de novo/);
  assert.match(passo3, /não diz que a vaga JÁ está garantida/);
  // o pedido de nome e telefone vem DEPOIS do comprovante, no passo 4
  const passo4 = seq.slice(seq.indexOf('4. '), seq.indexOf('5. '));
  assert.match(passo4, /é AGORA que entram os dados/);
  assert.match(passo4, /Nunca busque\s+com um nome que você adivinhou/);
  assert.ok(seq.indexOf('comprovante') < seq.indexOf('é AGORA que entram os dados'));
  // agendar_consulta continua sendo o último passo
  assert.match(seq, /6\. Com o idClient em mãos, chame agendar_consulta/);
  // pagou e o horário foi ocupado: a Sofia sabe o que dizer
  assert.match(seq, /ele JÁ pagou: peça desculpas/);
});

test('taxa obrigatória: as regras gerais não mandam mais "dados → Pix"', () => {
  const regras = renderRulesGlobal(BOA_VISTA);
  assert.doesNotMatch(regras, /dia → horário → dados → Pix/);
  assert.match(regras, /dia → horário → taxa de agendamento \(Pix \+ comprovante\) → só então os dados/);
});

test('o passo da mover_etapa, quando existe, continua depois de agendar_consulta (passo 7 com a taxa, 6 sem ela)', () => {
  const comEtapa = { ...BOA_VISTA, pipelineIntents: { scheduled_meeting: 123 } } as unknown as Unit;
  const seq = sequencia(composeSystemPrompt({ unit: comEtapa }));
  assert.match(seq, /\n7\. SÓ DEPOIS de a consulta ser marcada com sucesso, chame mover_etapa\(\{ statusId: 123 \}\)/);
  assert.doesNotMatch(seq, /\n6\. SÓ DEPOIS/);
  const outra = sequencia(composeSystemPrompt({ unit: { ...OUTRA, pipelineIntents: { scheduled_meeting: 123 } } as unknown as Unit }));
  assert.match(outra, /\n6\. SÓ DEPOIS de a consulta ser marcada com sucesso, chame mover_etapa/);
});

test('sem taxa obrigatória: a sequência é a de sempre, palavra por palavra', () => {
  const texto = sequenciaDepoisDoHorario(OUTRA, (n) => `\n${n}. X`);
  assert.equal(
    texto,
    `3. Quando ele escolher, chame buscar_paciente({ nome }) para achar o cadastro.
4. Se NÃO achar, pergunte o nome completo e o telefone com DDD e chame
   cadastrar_paciente({ nome, telefone }). Ela devolve o idClient e o
   agendamento segue normalmente — não transfira por causa disso.
5. Com o idClient em mãos, chame agendar_consulta({ idClient, data, hora }).
6. X`,
  );
  const prompt = composeSystemPrompt({ unit: OUTRA });
  assert.doesNotMatch(prompt, /taxa de\s+agendamento de R\$/);
  assert.match(renderRulesGlobal(OUTRA), /dia → horário → dados → Pix/);
});

test('taxa obrigatória sem chave Pix cadastrada: manda ler <dados_da_clinica> e nunca inventar', () => {
  const semChave = { ...BOA_VISTA, pixKey: null, pixHolder: null } as unknown as Unit;
  const texto = sequenciaDepoisDoHorario(semChave, () => '');
  assert.match(texto, /chave Pix de <dados_da_clinica> \(nunca invente uma\)/);
});

test('taxa obrigatória com fontes sem valor legível: a frase continua inteira (sem "taxa de agendamento de a taxa ...")', () => {
  const semValor = { ...BOA_VISTA, sourceProdutos: 'Consulta com o especialista.' } as unknown as Unit;
  const texto = sequenciaDepoisDoHorario(semValor, () => '');
  assert.match(texto, /taxa de\s+agendamento \(o valor exato está nas Fontes Oficiais\) \(ela abate do total\), paga por Pix/);
  assert.match(texto, /a taxa de agendamento é \{o valor das Fontes Oficiais\} por Pix/);
  assert.doesNotMatch(texto, /agendamento de a taxa/);
});

test('taxa obrigatória: a tabela de estados e a regra CONFIRMAÇÃO não mandam marcar ao escolher o horário', () => {
  const prompt = composeSystemPrompt({ unit: BOA_VISTA });
  assert.match(prompt, /escolheu horário\s+→\s+pedir a taxa de agendamento \(Pix\) e o comprovante; só com ele, cadastro e agenda/);
  assert.doesNotMatch(prompt, /escolheu horário\s+→\s+buscar\/cadastrar paciente e agendar/);
  assert.match(prompt, /o dia está combinado: siga para a taxa de agendamento \(Pix \+ comprovante\) e NÃO\s+marque ainda/);
  assert.match(prompt, /JÁ É confirmação — vá à taxa sem perguntar "consegue vir\?" de novo/);
  assert.doesNotMatch(prompt, /siga e\s+marque\./);
  assert.doesNotMatch(prompt, /marque sem perguntar "consegue vir\?"/);
});

test('sem taxa obrigatória: a tabela de estados e a regra CONFIRMAÇÃO são as de sempre, letra por letra', () => {
  const prompt = composeSystemPrompt({ unit: OUTRA });
  assert.match(prompt, /escolheu horário             →  buscar\/cadastrar paciente e agendar\n/);
  assert.ok(prompt.includes('"combinado" — siga e\n  marque. Também JÁ É confirmação — marque sem perguntar "consegue vir?" de novo: a própria\n'));
});

test('o prompt de taxa chama a cobrança de «taxa de agendamento», sem «taxa de reserva» no texto que o paciente poderia copiar', () => {
  const prompt = composeSystemPrompt({ unit: BOA_VISTA });
  const regras = renderRulesGlobal(BOA_VISTA);
  assert.doesNotMatch(regras, /taxa de reserva/);
  assert.doesNotMatch(sequencia(prompt), /taxa de reserva/);
});

test('a recusa da ferramenta sem comprovante não manda dizer que o horário "fica separado"', async () => {
  const { RECUSA_SEM_COMPROVANTE_DA_TAXA } = await import('./confirmacao-so-com-crm.js');
  assert.doesNotMatch(RECUSA_SEM_COMPROVANTE_DA_TAXA, /fica separado/);
  assert.match(RECUSA_SEM_COMPROVANTE_DA_TAXA, /NÃO diga que o horário está separado, reservado ou garantido/);
});
