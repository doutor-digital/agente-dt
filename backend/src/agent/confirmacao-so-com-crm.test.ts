import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  RECADO_COMPROVANTE,
  RECUSA_AGUARDANDO_EQUIPE,
  RECUSA_SEM_COMPROVANTE_DA_TAXA,
  abrirTarefaParaEquipe,
  afirmaConfirmacao,
  afirmaPagamentoConferido,
  afirmouComConsultaDesmarcada,
  blocoDizDesmarcada,
  respostaDoComprovante,
  travarAgendamentoPorComprovante,
  turnoDoComprovante,
} from './confirmacao-so-com-crm.js';
import { detectarPromessa } from '../lib/prometeu-sem-marcar.js';
import { reservaSemMarcar } from './reserva-sem-marcar.js';
import { buildAgendarConsulta } from './agenda-tools.js';

const COMPROVANTE = '[imagem do cliente]: COMPROVANTE: Valor: R$ 200,00. Data e hora: 24/10/2026 às 12:41:04. Nome do pagador: Shelly.';

// --- Balsas #28858838 (22/10/2026): a consulta estava desmarcada no CRM e a IA disse que estava tudo certo ---------------
const BALSAS_22_10 =
  'Bom dia, Wagner! 😊 Olha, pra eu te garantir certo: sua consulta está marcada pra hoje, quinta-feira, 22/10, às 13h — já está tudo certo! Pode vir sem preocupação. Chega 15 minutos antes, tá bom? 🤗';

test('Balsas 22/10: o "pra eu te garantir certo:" não cala mais a afirmação (antes: null)', () => {
  const p = detectarPromessa(BALSAS_22_10);
  assert.ok(p, 'devia detectar a afirmação');
  assert.equal(p!.forma, 'estado');
  assert.ok(reservaSemMarcar(BALSAS_22_10, { marcouAgora: false, consultasValidas: [] }), 'e a trava barra quando não há consulta');
});

test('o preâmbulo só sai quando termina em dois-pontos: condição de verdade continua condição', () => {
  assert.equal(detectarPromessa('Pra eu garantir seu horário, me manda o comprovante que deixo reservado pra sexta, 23/10, às 9h.'), null);
  assert.equal(detectarPromessa('Se quiser, pra eu te garantir certo: deixo reservado quinta, 22/10, às 13h.'), null);
});

test('bloco do prompt que diz desmarcada / não compareceu', () => {
  assert.ok(blocoDizDesmarcada('A consulta deste paciente foi DESMARCADA no sistema da clínica.\nEle NÃO tem mais horário'));
  assert.ok(blocoDizDesmarcada('A clínica registrou NÃO COMPARECEU na consulta de terça, 20/10.'));
  assert.equal(blocoDizDesmarcada('Consulta CONFIRMADA agora no sistema da clínica: **quinta, 22/10, às 13h**'), false);
  assert.equal(blocoDizDesmarcada(''), false);
  assert.equal(blocoDizDesmarcada(null), false);
});

test('afirmaConfirmacao pega o que a IA disse em Balsas e em Canaã, e deixa passar o que não afirma', () => {
  assert.ok(afirmaConfirmacao(BALSAS_22_10));
  assert.ok(afirmaConfirmacao('Recebi seu comprovante certo, Shelly! 🥰 Sua vaga está garantida.\n\n✅ Agendamento confirmado, Shelly!\n\n⭐ Data: segunda-feira, 26/10'));
  assert.ok(afirmaConfirmacao('Seu Pix foi confirmado e está tudo certo!'));
  assert.ok(afirmaConfirmacao('Te espero segunda, 26/10, às 8h!'));
  // não afirma
  assert.equal(afirmaConfirmacao(RECADO_COMPROVANTE), null, 'o próprio recado não pode se auto-reprovar');
  assert.equal(afirmaConfirmacao('Recebi seu comprovante! A equipe confere e já te confirma por aqui.'), null);
  assert.equal(afirmaConfirmacao('Sua consulta ainda não está confirmada, a equipe confere o pagamento.'), null);
  assert.equal(afirmaConfirmacao('Quer que eu confirme a consulta de segunda?'), null);
  assert.equal(afirmaConfirmacao('Sua consulta foi desmarcada. Quer marcar de novo?'), null, '"desmarcada" não é "marcada"');
  assert.equal(afirmaConfirmacao('Me manda o nome completo pra eu seguir com o cadastro.'), null);
});

// --- Canaã #28886952 (24/10/2026): foto do comprovante virou consulta marcada e "confirmado" ---------------------------
test('turno com foto de comprovante: pendente; texto comum não', () => {
  assert.deepEqual(turnoDoComprovante([COMPROVANTE]), { noTurno: true, pendente: true });
  assert.deepEqual(turnoDoComprovante(['Oi', 'Obrigada']), { noTurno: false, pendente: false });
  assert.equal(turnoDoComprovante(['[arquivo do cliente]: COMPROVANTE: R$ 100']).noTurno, true, 'PDF também');
  assert.equal(turnoDoComprovante(['[imagem do cliente]: Radiografia de coluna lombar']).noTurno, false, 'exame não é comprovante');
  assert.equal(turnoDoComprovante(['paguei, olha o comprovante']).noTurno, false, 'dizer que pagou não é a foto lida');
});

test('a espera sai do FATO (comprovante nas últimas falas do paciente), não do texto que a IA respondeu', () => {
  // a IA reescreveu o recado, ou nem afirmou nada: o turno seguinte continua em espera
  assert.deepEqual(turnoDoComprovante([COMPROVANTE, 'Obrigada']), { noTurno: false, pendente: true });
  const falas = Array.from({ length: 9 }, (_, i) => `fala ${i}`);
  assert.equal(turnoDoComprovante([COMPROVANTE, ...falas]).pendente, true, 'ainda nas últimas 10');
  assert.equal(turnoDoComprovante([COMPROVANTE, ...falas, 'mais uma']).pendente, false, 'saiu da janela: a equipe já devia ter respondido');
});

test('a equipe criou a consulta no CRM: a espera acaba (só o comprovante deste turno conta)', () => {
  assert.deepEqual(turnoDoComprovante([COMPROVANTE, 'Obrigada'], true), { noTurno: false, pendente: false });
  assert.deepEqual(turnoDoComprovante(['Oi', COMPROVANTE], true), { noTurno: true, pendente: true });
});

test('Canaã 24/10: a resposta que confirma vira o recado; a que não confirma segue', () => {
  const t = turnoDoComprovante([COMPROVANTE]);
  const canaa = 'Recebi seu comprovante certo, Shelly, muito obrigada! 🥰 Sua vaga está garantida.\n\n✅ Agendamento confirmado, Shelly!';
  assert.equal(respostaDoComprovante(canaa, t, false), RECADO_COMPROVANTE);
  assert.equal(respostaDoComprovante(canaa, t, true), null, 'sem falar de pagamento conferido, com a consulta já no CRM, o texto fica');
  assert.equal(respostaDoComprovante('Recebi! Só me confirma seu nome completo? 😊', t, false), null);
});

test('turno seguinte: se a equipe já criou a consulta no CRM, a IA pode falar dela', () => {
  const t = turnoDoComprovante([COMPROVANTE, 'Obrigada']);
  assert.equal(respostaDoComprovante('Sua consulta está confirmada para segunda, 26/10, às 8h.', t, true), null);
  assert.equal(respostaDoComprovante('Sua consulta está confirmada para segunda, 26/10, às 8h.', t, false), RECADO_COMPROVANTE);
});

test('sem comprovante nenhum a regra não mexe na resposta', () => {
  const t = turnoDoComprovante(['Pode ser às 8h']);
  assert.equal(respostaDoComprovante('✅ Agendamento confirmado, Shelly!', t, false), null);
});

function agendarQueMarca(chamadas: unknown[]) {
  return new DynamicStructuredTool({
    name: 'agendar_consulta',
    description: 'teste',
    schema: z.object({ hora: z.string(), remarcando: z.boolean().optional() }),
    func: async (args) => {
      chamadas.push(args);
      return 'Consulta marcada para segunda, 26/10, às 08:00.';
    },
  });
}

test('agendar_consulta recusa no turno do comprovante e não chega na franquia', async () => {
  const chamadas: unknown[] = [];
  const passos: Array<{ title: string }> = [];
  const turno = turnoDoComprovante([COMPROVANTE]);
  const [tool] = travarAgendamentoPorComprovante([agendarQueMarca(chamadas)], turno, { step: async (p: never) => void passos.push(p) } as never);
  const r = await tool.func({ hora: '08:00' } as never);
  assert.match(String(r), /^RECUSADO/);
  assert.match(String(r), /EQUIPE/);
  assert.deepEqual(chamadas, [], 'a franquia não foi tocada');
  assert.match(passos[0].title, /só a equipe confirma/);
});

test('agendar_consulta segue normal sem comprovante; `remarcando` escrito pelo modelo NÃO fura a trava', async () => {
  const chamadas: unknown[] = [];
  const livre = { noTurno: false, pendente: false };
  const [tool] = travarAgendamentoPorComprovante([agendarQueMarca(chamadas)], livre, { step: async () => undefined } as never);
  assert.match(String(await tool.func({ hora: '08:00' } as never)), /^Consulta marcada/);
  assert.equal(chamadas.length, 1);

  const comprovante = { noTurno: true, pendente: true };
  const [barrada] = travarAgendamentoPorComprovante([agendarQueMarca(chamadas)], comprovante, { step: async () => undefined } as never);
  assert.match(String(await barrada.func({ hora: '09:00', remarcando: true } as never)), /^RECUSADO/, 'remarcando:true não abre a porta');
  assert.equal(chamadas.length, 1);
});

test('`remarcando` não está no schema que o modelo vê (só remarcar_consulta o passa, direto na func)', () => {
  const tool = buildAgendarConsulta({ unit: { id: 'u', slug: 's' } as never, recorder: { step: async () => undefined } as never });
  const shape = (tool.schema as unknown as { shape: Record<string, unknown> }).shape;
  assert.equal('remarcando' in shape, false);
  assert.equal(((tool.schema as unknown as { safeParse: (x: unknown) => { data?: Record<string, unknown> } }).safeParse({
    idClient: 1, data: '2026-12-01', hora: '09:00', remarcando: true,
  }).data ?? {}).remarcando, undefined, 'o zod descarta o que o modelo escrever');
});

test('unidade com taxa de reserva (Boa Vista): sem comprovante da taxa recusa; com comprovante a IA marca', async () => {
  const chamadas: unknown[] = [];
  const passos: Array<{ title: string }> = [];
  const rec = { step: async (p: never) => void passos.push(p) } as never;
  const semComprovante = { noTurno: false, pendente: false };
  const [barrada] = travarAgendamentoPorComprovante([agendarQueMarca(chamadas)], semComprovante, rec, { exigePagamento: true });
  assert.equal(await barrada.func({ hora: '09:00' } as never), RECUSA_SEM_COMPROVANTE_DA_TAXA);
  assert.deepEqual(chamadas, []);
  assert.match(passos[0].title, /^agendar_consulta recusado — reserva sem pagamento/, 'o painel de funcionamento conta esse prefixo');

  const comComprovante = turnoDoComprovante([COMPROVANTE]);
  const [livre] = travarAgendamentoPorComprovante([agendarQueMarca(chamadas)], comComprovante, rec, { exigePagamento: true });
  assert.match(String(await livre.func({ hora: '09:00' } as never)), /^Consulta marcada/);
  assert.equal(chamadas.length, 1);
});

test('nas demais unidades o mesmo comprovante recusa (regra geral: só a equipe confirma)', async () => {
  const chamadas: unknown[] = [];
  const [tool] = travarAgendamentoPorComprovante([agendarQueMarca(chamadas)], turnoDoComprovante([COMPROVANTE]), { step: async () => undefined } as never, { exigePagamento: false });
  assert.match(String(await tool.func({ hora: '09:00' } as never)), /^RECUSADO/);
  assert.deepEqual(chamadas, []);
});

test('Boa Vista, no turno do comprovante: consulta marcada pode ser dita; "pagamento confirmado" não', () => {
  const t = turnoDoComprovante([COMPROVANTE]);
  // marcouAgora = a consulta está no CRM → consultaNoCrm true
  assert.equal(respostaDoComprovante('Pronto! Sua consulta está marcada para terça, 27/10, às 8h.', t, true), null);
  assert.equal(respostaDoComprovante('Seu pagamento foi confirmado e sua consulta está marcada para terça.', t, true), RECADO_COMPROVANTE);
  assert.equal(respostaDoComprovante('Pix aprovado! Sua consulta está marcada para terça.', t, true), RECADO_COMPROVANTE);
});

test('o estado do turno é lido na hora da chamada (o grafo o atualiza a cada volta)', async () => {
  const chamadas: unknown[] = [];
  const turno = { noTurno: false, pendente: false };
  const [tool] = travarAgendamentoPorComprovante([agendarQueMarca(chamadas)], turno, { step: async () => undefined } as never);
  Object.assign(turno, turnoDoComprovante([COMPROVANTE]));
  assert.match(String(await tool.func({ hora: '08:00' } as never)), /^RECUSADO/);
});

test('tarefa para a equipe: vence em 1 h, no responsável do cartão, e só marca o aviso depois do Kommo aceitar', async () => {
  const tarefas: Array<Record<string, unknown>> = [];
  const marcados: string[] = [];
  const kommo = {
    getLead: async () => ({ name: 'Shelly', responsible_user_id: 77 }),
    createTask: async (a: Record<string, unknown>) => (tarefas.push(a), { id: 5 }),
  };
  const dedupe = { avisoRecente: async () => false, marcarAviso: async (_u: string, _l: number, k: string) => void marcados.push(k) };
  const r = await abrirTarefaParaEquipe({
    slug: 'doutor-hernia-canaa', unitId: 'u1', leadId: 28886952, kommo: kommo as never,
    recorder: { step: async () => undefined } as never, motivo: 'comprovante', dedupe: dedupe as never, agora: () => 1_000_000_000_000,
  });
  assert.equal(r, 'criada');
  assert.equal(tarefas[0].completeAt, 1_000_000_000 + 3600);
  assert.equal(tarefas[0].responsibleUserId, 77);
  assert.match(String(tarefas[0].text), /CONFERIR COMPROVANTE · doutor-hernia-canaa · Shelly/);
  assert.deepEqual(marcados, ['comprovante_so_equipe']);
});

test('tarefa repetida em 24 h não abre outra; falha do Kommo não marca o aviso e AVISA o João', async () => {
  const kommoOk = { getLead: async () => ({}), createTask: async () => { throw new Error('boom'); } };
  const marcados: string[] = [];
  const alertas: string[] = [];
  const alertar = async (t: string) => void alertas.push(t);
  const base = { slug: 's', unitId: 'u', leadId: 1, recorder: { step: async () => undefined } as never, motivo: 'desmarcada' as const, alertar };
  const repetida = await abrirTarefaParaEquipe({ ...base, kommo: kommoOk as never, dedupe: { avisoRecente: async () => true, marcarAviso: async () => undefined } as never });
  assert.equal(repetida, 'repetida');
  assert.deepEqual(alertas, [], 'repetida não é falha');
  const falhou = await abrirTarefaParaEquipe({
    ...base, kommo: kommoOk as never,
    dedupe: { avisoRecente: async () => false, marcarAviso: async (_u: string, _l: number, k: string) => void marcados.push(k) } as never,
  });
  assert.equal(falhou, 'falhou');
  assert.deepEqual(marcados, [], 'uma falha não cala a próxima tentativa');
  assert.equal(alertas.length, 1);
  assert.match(alertas[0], /tarefa NÃO saiu.*boom/);
});

const BLOCO_DESMARCADA = '\nA consulta deste paciente foi DESMARCADA no sistema da clínica.\nEle NÃO tem mais horário reservado.\n';

test('Balsas 22/10 de ponta a ponta (sem rede): bloco desmarcada + resposta "tudo certo" = trocada', () => {
  const promessa = reservaSemMarcar(BALSAS_22_10, { marcouAgora: false, consultasValidas: [] });
  assert.ok(afirmouComConsultaDesmarcada(BALSAS_22_10, { marcouAgora: false, bloco: BLOCO_DESMARCADA, promessa }));
  // mesmo que a trava de texto calasse, o detector largo pega
  assert.ok(afirmouComConsultaDesmarcada(BALSAS_22_10, { marcouAgora: false, bloco: BLOCO_DESMARCADA, promessa: null }));
});

test('desmarcada: marcou de novo neste turno, ou resposta que não afirma, ou consulta de pé = não troca', () => {
  const promessa = reservaSemMarcar(BALSAS_22_10, { marcouAgora: false, consultasValidas: [] });
  assert.equal(afirmouComConsultaDesmarcada(BALSAS_22_10, { marcouAgora: true, bloco: BLOCO_DESMARCADA, promessa }), null);
  assert.equal(afirmouComConsultaDesmarcada('Sua consulta foi desmarcada. Quer que eu veja um novo horário?', { marcouAgora: false, bloco: BLOCO_DESMARCADA, promessa: null }), null);
  assert.equal(afirmouComConsultaDesmarcada(BALSAS_22_10, { marcouAgora: false, bloco: 'Consulta CONFIRMADA agora no sistema da clínica: **quinta, 22/10, às 13h**', promessa: null }), null);
});

test('desmarcada: explicar preço e oferecer novo horário não é afirmar consulta de pé', () => {
  const oferta = 'Sem problema! A consulta é R$ 350 no dia, ou R$ 200 pagando antes pelo Pix, que já garante seu horário reservado. Tenho quinta, 29/10, às 9h — fica bom pra você?';
  assert.equal(afirmouComConsultaDesmarcada(oferta, { marcouAgora: false, bloco: BLOCO_DESMARCADA, promessa: null }), null);
  assert.equal(afirmaConfirmacao('Te espero aqui então.', { estrito: true }), null, 'sem dia/hora não é consulta');
});

test('detector largo: as formas que escaparam na revisão', () => {
  for (const t of [
    'Pode ficar tranquila, já está tudo certo!',
    'Recebido, confirmado! 🎉 Agora me manda o nome completo.',
    'Tudo certo, recebi seu comprovante!',
    'Confirmei seu horário de terça às 11h.',
    'Não se preocupe, sua consulta está confirmada.',
    'Sua consulta ainda está marcada para terça, 27/10.',
    'Seu pix foi recebido e está confirmado, a consulta fica garantida.',
    'Se precisar, é só chamar: sua consulta está confirmada.',
  ]) assert.ok(afirmaConfirmacao(t), t);
  for (const t of ['Ainda não está confirmada.', 'Se estiver tudo certo, a equipe confirma.', 'Quando a equipe conferir, fica confirmada.']) {
    assert.equal(afirmaConfirmacao(t), null, t);
  }
});

test('desmarcada (modo estrito): "Agendamento confirmado" solto é afirmação; "te espero" sem dia não é', () => {
  assert.ok(afirmaConfirmacao('Agendamento confirmado ✅', { estrito: true }));
  assert.ok(afirmaConfirmacao('Perfeito, sua vaga está garantida 🎉', { estrito: true }));
  assert.ok(afirmaConfirmacao('Te espero terça, 27/10, às 11h!', { estrito: true }));
  assert.equal(afirmaConfirmacao('Te espero aqui então.', { estrito: true }), null);
});

test('depois do comprovante a recusa não diz "recebi seu comprovante" a quem pede outra coisa', async () => {
  const chamadas: unknown[] = [];
  const turno = turnoDoComprovante([COMPROVANTE, 'Quero mudar para sexta']);
  assert.deepEqual(turno, { noTurno: false, pendente: true });
  const [tool] = travarAgendamentoPorComprovante([agendarQueMarca(chamadas)], turno, { step: async () => undefined } as never);
  assert.equal(await tool.func({ hora: '09:00' } as never), RECUSA_AGUARDANDO_EQUIPE);
  assert.deepEqual(chamadas, []);
});

test('rajada de PDFs do mesmo comprovante = uma tarefa (janela de 15 min); desmarcada usa os 24 h padrão', async () => {
  const janelas: Array<number | undefined> = [];
  const dedupe = { avisoRecente: async (_u: string, _l: number, _k: string, j?: number) => (janelas.push(j), true), marcarAviso: async () => undefined };
  const base = { slug: 's', unitId: 'u', leadId: 1, kommo: {} as never, recorder: { step: async () => undefined } as never, dedupe: dedupe as never };
  await abrirTarefaParaEquipe({ ...base, motivo: 'comprovante' });
  await abrirTarefaParaEquipe({ ...base, motivo: 'desmarcada' });
  assert.deepEqual(janelas, [15 * 60_000, undefined]);
});

test('consulta já no CRM + comprovante: falar da consulta fica; dizer que o pagamento foi conferido vira o recado', () => {
  const t = turnoDoComprovante([COMPROVANTE]);
  assert.equal(respostaDoComprovante('Recebi! Sua consulta segue marcada para terça, 27/10, às 8h.', t, true), null);
  assert.equal(respostaDoComprovante('Seu pagamento foi confirmado, e sua consulta segue marcada para terça.', t, true), RECADO_COMPROVANTE);
  assert.equal(respostaDoComprovante('Pix aprovado! Te espero terça.', t, true), RECADO_COMPROVANTE);
  assert.ok(!afirmaPagamentoConferido('A equipe confere o pagamento e confirma em até 1 hora.'));
  assert.ok(!afirmaPagamentoConferido('Seu pagamento ainda não foi confirmado.'));
});

// --- as 4 frases do sênior (#127): explicação, não afirmação — e fora do turno do comprovante nada é trocado ---------------
const FRASES_DE_EXPLICACAO = [
  'A sua mensagem caiu pela metade, pode mandar de novo?',
  'A ligação caiu, tudo bem se eu te retornar por aqui?',
  'O pagamento é confirmado pela equipe, não por mim.',
  'A vaga só é reservada depois do pagamento antecipado conferido pela equipe.',
];

test('as 4 frases do sênior não viram "Recebi seu comprovante!" (nem na espera da equipe)', () => {
  const emEspera = turnoDoComprovante([COMPROVANTE, 'Obrigada']);
  const semComprovante = turnoDoComprovante(['Oi, tudo bem?']);
  for (const f of FRASES_DE_EXPLICACAO) {
    assert.equal(afirmaPagamentoConferido(f), false, f);
    assert.equal(respostaDoComprovante(f, emEspera, false), null, `espera: ${f}`);
    assert.equal(respostaDoComprovante(f, semComprovante, false), null, `sem comprovante: ${f}`);
  }
});

test('"Pagou antecipado" preenchido é informação: na espera da equipe, "pagamento confirmado" vira o recado; fora dela a regra não mexe', () => {
  const emEspera = turnoDoComprovante([COMPROVANTE, 'Quero marcar quinta']);
  assert.equal(respostaDoComprovante('Seu pagamento está confirmado, vou marcar quinta!', emEspera, false), RECADO_COMPROVANTE);
  assert.equal(respostaDoComprovante('Seu Pix já foi aprovado.', emEspera, true), RECADO_COMPROVANTE);
  const fora = turnoDoComprovante(['Quero marcar quinta']);
  assert.equal(respostaDoComprovante('Seu pagamento está confirmado, vou marcar quinta!', fora, false), null, 'sem comprovante na conversa não vira "recebi seu comprovante"');
  assert.equal(respostaDoComprovante('Tenho quinta às 9h. Quer pagar o Pix antecipado ou na clínica?', emEspera, false), null);
});

test('desmarcada: "Tudo certo, Maria! Quer que eu veja um novo horário?" não é consulta de pé (sem tarefa falsa)', () => {
  const t = 'Tudo certo, Maria! Quer que eu veja um novo horário?';
  assert.equal(afirmouComConsultaDesmarcada(t, { marcouAgora: false, bloco: BLOCO_DESMARCADA, promessa: null }), null);
  assert.equal(afirmouComConsultaDesmarcada('Tudo certo, Maria! Te espero quinta, 29/10, às 9h.', { marcouAgora: false, bloco: BLOCO_DESMARCADA, promessa: null }) !== null, true, 'com dia/hora é afirmação');
  assert.equal(afirmaConfirmacao('Já está tudo certo, Maria.', { estrito: true }), null);
});

test('a trava só mexe na instância REGISTRADA de agendar_consulta: o agendar interno de remarcar_consulta não é tocado', () => {
  const ctx = { unit: { id: 'u', slug: 's' } as never, recorder: { step: async () => undefined } as never };
  const registrada = buildAgendarConsulta(ctx);
  const internaDoRemarcar = buildAgendarConsulta(ctx); // o que buildRemarcarConsulta faz por dentro
  const funcAntes = internaDoRemarcar.func;
  travarAgendamentoPorComprovante([registrada], { noTurno: true, pendente: true }, ctx.recorder, { exigePagamento: true });
  assert.notEqual(registrada, internaDoRemarcar);
  assert.equal(internaDoRemarcar.func, funcAntes, 'remarcar em unidade com taxa de reserva não passa pela trava');
});
