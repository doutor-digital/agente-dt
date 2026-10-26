import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  RECADO_COMPROVANTE,
  RECUSA_AGUARDANDO_EQUIPE,
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
  assert.deepEqual(turnoDoComprovante(COMPROVANTE, []), { noTurno: true, pendente: true });
  assert.deepEqual(turnoDoComprovante('Obrigada', ['Oi!']), { noTurno: false, pendente: false });
  assert.equal(turnoDoComprovante('[arquivo do cliente]: COMPROVANTE: R$ 100', []).noTurno, true, 'PDF também');
  assert.equal(turnoDoComprovante('[imagem do cliente]: Radiografia de coluna lombar', []).noTurno, false, 'exame não é comprovante');
  assert.equal(turnoDoComprovante('paguei, olha o comprovante', []).noTurno, false, 'dizer que pagou não é a foto lida');
});

test('depois do recado a conversa segue pendente por algumas respostas, e depois solta', () => {
  const recado = [RECADO_COMPROVANTE];
  assert.equal(turnoDoComprovante('Obrigada', recado).pendente, true);
  const depois = [RECADO_COMPROVANTE, ...Array.from({ length: 10 }, (_, i) => `resposta ${i}`)];
  assert.equal(turnoDoComprovante('Obrigada', depois).pendente, false, 'a equipe já devia ter respondido');
});

test('Canaã 24/10: a resposta que confirma vira o recado; a que não confirma segue', () => {
  const t = turnoDoComprovante(COMPROVANTE, []);
  const canaa = 'Recebi seu comprovante certo, Shelly, muito obrigada! 🥰 Sua vaga está garantida.\n\n✅ Agendamento confirmado, Shelly!';
  assert.equal(respostaDoComprovante(canaa, t, false), RECADO_COMPROVANTE);
  assert.equal(respostaDoComprovante(canaa, t, true), null, 'sem falar de pagamento conferido, com a consulta já no CRM, o texto fica');
  assert.equal(respostaDoComprovante('Recebi! Só me confirma seu nome completo? 😊', t, false), null);
});

test('turno seguinte: se a equipe já criou a consulta no CRM, a IA pode falar dela', () => {
  const t = turnoDoComprovante('Obrigada', [RECADO_COMPROVANTE]);
  assert.equal(respostaDoComprovante('Sua consulta está confirmada para segunda, 26/10, às 8h.', t, true), null);
  assert.equal(respostaDoComprovante('Sua consulta está confirmada para segunda, 26/10, às 8h.', t, false), RECADO_COMPROVANTE);
});

test('sem comprovante nenhum a regra não mexe na resposta', () => {
  const t = turnoDoComprovante('Pode ser às 8h', []);
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
  const turno = turnoDoComprovante(COMPROVANTE, []);
  const [tool] = travarAgendamentoPorComprovante([agendarQueMarca(chamadas)], turno, { step: async (p: never) => void passos.push(p) } as never);
  const r = await tool.func({ hora: '08:00' } as never);
  assert.match(String(r), /^RECUSADO/);
  assert.match(String(r), /EQUIPE/);
  assert.deepEqual(chamadas, [], 'a franquia não foi tocada');
  assert.match(passos[0].title, /só a equipe confirma/);
});

test('agendar_consulta segue normal sem comprovante, e remarcar não é barrado', async () => {
  const chamadas: unknown[] = [];
  const livre = { noTurno: false, pendente: false };
  const [tool] = travarAgendamentoPorComprovante([agendarQueMarca(chamadas)], livre, { step: async () => undefined } as never);
  assert.match(String(await tool.func({ hora: '08:00' } as never)), /^Consulta marcada/);
  assert.equal(chamadas.length, 1);

  const comprovante = { noTurno: true, pendente: true };
  const [remarca] = travarAgendamentoPorComprovante([agendarQueMarca(chamadas)], comprovante, { step: async () => undefined } as never);
  assert.match(String(await remarca.func({ hora: '09:00', remarcando: true } as never)), /^Consulta marcada/, 'quem remarca já tem consulta');
  assert.equal(chamadas.length, 2);
});

test('o estado do turno é lido na hora da chamada (o grafo o atualiza a cada volta)', async () => {
  const chamadas: unknown[] = [];
  const turno = { noTurno: false, pendente: false };
  const [tool] = travarAgendamentoPorComprovante([agendarQueMarca(chamadas)], turno, { step: async () => undefined } as never);
  Object.assign(turno, turnoDoComprovante(COMPROVANTE, []));
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

test('tarefa repetida em 24 h não abre outra; falha do Kommo não marca o aviso', async () => {
  const kommoOk = { getLead: async () => ({}), createTask: async () => { throw new Error('boom'); } };
  const marcados: string[] = [];
  const base = { slug: 's', unitId: 'u', leadId: 1, recorder: { step: async () => undefined } as never, motivo: 'desmarcada' as const };
  const repetida = await abrirTarefaParaEquipe({ ...base, kommo: kommoOk as never, dedupe: { avisoRecente: async () => true, marcarAviso: async () => undefined } as never });
  assert.equal(repetida, 'repetida');
  const falhou = await abrirTarefaParaEquipe({
    ...base, kommo: kommoOk as never,
    dedupe: { avisoRecente: async () => false, marcarAviso: async (_u: string, _l: number, k: string) => void marcados.push(k) } as never,
  });
  assert.equal(falhou, 'falhou');
  assert.deepEqual(marcados, [], 'uma falha não cala a próxima tentativa');
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
  const turno = turnoDoComprovante('Quero mudar para sexta', [RECADO_COMPROVANTE]);
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
  const t = turnoDoComprovante(COMPROVANTE, []);
  assert.equal(respostaDoComprovante('Recebi! Sua consulta segue marcada para terça, 27/10, às 8h.', t, true), null);
  assert.equal(respostaDoComprovante('Seu pagamento foi confirmado, e sua consulta segue marcada para terça.', t, true), RECADO_COMPROVANTE);
  assert.equal(respostaDoComprovante('Pix aprovado! Te espero terça.', t, true), RECADO_COMPROVANTE);
  assert.ok(!afirmaPagamentoConferido('A equipe confere o pagamento e confirma em até 1 hora.'));
  assert.ok(!afirmaPagamentoConferido('Seu pagamento ainda não foi confirmado.'));
});

test('"Pagou antecipado" preenchido é informação: depois da janela, nada de "pagamento confirmado"', () => {
  const longeDoComprovante = turnoDoComprovante('Quero marcar quinta', [RECADO_COMPROVANTE, ...Array.from({ length: 10 }, (_, i) => `r${i}`)]);
  assert.deepEqual(longeDoComprovante, { noTurno: false, pendente: false });
  assert.equal(respostaDoComprovante('Seu pagamento está confirmado, vou marcar quinta!', longeDoComprovante, false), RECADO_COMPROVANTE);
  assert.equal(respostaDoComprovante('Seu Pix já foi aprovado.', longeDoComprovante, true), RECADO_COMPROVANTE);
  // fluxo normal de quem ainda não pagou segue como veio
  assert.equal(respostaDoComprovante('Tenho quinta às 9h. Quer pagar o Pix antecipado ou na clínica?', longeDoComprovante, false), null);
});
