import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import {
  afirmaHorarioGarantido,
  dadosDaTaxa,
  empurrouAChaveParaEquipe,
  ofereceuAChaveEmPergunta,
  pacientePediuAChave,
  pacienteQuerPagarNaClinica,
  RECADO_INSISTIU_NA_CLINICA,
  recadoPagarNaClinica,
  respostaAnteriorDaIA,
  recadoDaChave,
  promptDizEmTratamento,
  recadoSemComprovante,
  travaDaTaxaDeReserva,
  type ContextoDaTaxa,
} from './taxa-de-reserva.js';
import { afirmaConfirmacao, afirmouComConsultaDesmarcada } from './confirmacao-so-com-crm.js';
import { reservaSemMarcar } from './reserva-sem-marcar.js';
import { aplicarGuardrail } from './guardrail.js';
import { semDiminutivo } from '../lib/sem-diminutivo.js';
import { semIntimidade } from '../lib/sem-intimidade.js';
import { detectarVazamento } from '../services/vazamento.js';

/** Unidade com taxa de reserva, como Boa Vista: dados FICTÍCIOS. */
function unidade(over: Partial<Unit> = {}): Unit {
  return {
    category: 'saude',
    spineBookingRequiresPayment: true,
    pixKey: '12.345.678/0001-90',
    pixHolder: 'Clinica Teste Ltda',
    sourceProdutos: 'Consulta: R$ 100 antecipado (taxa de agendamento) ou R$ 250 no dia.',
    sourcePapel: null,
    sourceNegocio: null,
    systemPrompt: '',
    ...over,
  } as Unit;
}
const DADOS = dadosDaTaxa(unidade())!;
const SEM_PROVA: ContextoDaTaxa = { falasDoPaciente: [], consultaDePe: false, emTratamento: false, respostaAnterior: '', comprovanteLido: false };
const com = (over: Partial<ContextoDaTaxa>): ContextoDaTaxa => ({ ...SEM_PROVA, ...over });

// --- dados da taxa --------------------------------------------------------------------------------------------------------

test('dados: chave copiada exata, titular e valor vêm do cadastro', () => {
  assert.deepEqual(DADOS, { chave: '12.345.678/0001-90', titular: 'Clinica Teste Ltda', valor: 100 });
});

test('dados: unidade SEM a flag, sem chave ou sem valor não escreve nada', () => {
  assert.equal(dadosDaTaxa(unidade({ spineBookingRequiresPayment: false })), null);
  assert.equal(dadosDaTaxa(unidade({ pixKey: '  ' })), null);
  assert.equal(dadosDaTaxa(unidade({ pixKey: null })), null);
  assert.equal(dadosDaTaxa(unidade({ sourceProdutos: 'Consulta: valor a combinar.' })), null);
});

// --- A: a chave por código ------------------------------------------------------------------------------------------------

// Frases REAIS da Sofia (27/10, Boa Vista) e o que a paciente pediu.
const SOFIA_27_10_PIX = 'Sobre o Pix, a equipe te envia a chave certa';
const SOFIA_27_10_PIX_2 = 'A equipe já vai te enviar a chave por aqui rápido';

test('A: "E o pix" + "a equipe te envia a chave certa" → chave, titular, valor e pedido de comprovante', () => {
  const r = travaDaTaxaDeReserva(SOFIA_27_10_PIX, DADOS, com({ falasDoPaciente: ['E o pix'] }));
  assert.equal(r?.motivo, 'equipe_envia_a_chave');
  assert.equal(r?.texto, recadoDaChave(DADOS));
  assert.match(r!.texto, /Chave Pix: 12\.345\.678\/0001-90/);
  assert.match(r!.texto, /Titular: Clinica Teste Ltda/);
  assert.match(r!.texto, /R\$ 100/);
  assert.match(r!.texto, /comprovante/);
  assert.match(r!.texto, /foto ou PDF/);
});

test('A: "Mande o pix por gentileza" + "a equipe já vai te enviar a chave" → a chave sai', () => {
  const r = travaDaTaxaDeReserva(SOFIA_27_10_PIX_2, DADOS, com({ falasDoPaciente: ['Mande o pix por gentileza'] }));
  assert.equal(r?.texto, recadoDaChave(DADOS));
});

test('A: o paciente pediu o Pix e o modelo respondeu outra coisa → a chave sai mesmo assim', () => {
  const r = travaDaTaxaDeReserva('Claro! Qual horário fica melhor pra você?', DADOS, com({ falasDoPaciente: ['E o pix'] }));
  assert.equal(r?.motivo, 'chave_pedida');
  assert.equal(r?.texto, recadoDaChave(DADOS));
});

test('A: a equipe "envia a chave" sem o paciente ter pedido também é trocada', () => {
  const r = travaDaTaxaDeReserva('Pode ficar tranquila: a equipe te manda a chave Pix em seguida.', DADOS, com({ falasDoPaciente: ['Quero agendar'] }));
  assert.equal(r?.motivo, 'equipe_envia_a_chave');
});

test('A: o paciente escolheu pagar antecipado (resposta do botão) → a chave sai', () => {
  for (const fala of ['Pix antecipado', 'antecipado', 'Vou pagar antecipado', 'prefiro o pix antecipado']) {
    assert.equal(travaDaTaxaDeReserva('Perfeito!', DADOS, com({ falasDoPaciente: [fala] }))?.motivo, 'chave_pedida', fala);
  }
});

test('A: pedidos de Pix reconhecidos', () => {
  for (const fala of ['E o pix', 'Mande o pix por gentileza', 'qual a chave?', 'me manda a chave pix', 'pode me passar o pix', 'cadê o pix', 'pix', 'Quero pagar no pix', 'chave pfv', 'me passa a chave pix que eu pago e mando o comprovante', 'manda a chave, não paguei ainda', 'Preciso da chave', 'Oi, e o pix?', 'Não sei qual é a chave, me manda o pix']) {
    assert.equal(pacientePediuAChave([fala]), true, fala);
  }
});

test('A: contraexemplos — quem já pagou, não quer, ou mandou o comprovante NÃO pediu a chave', () => {
  for (const fala of [
    'Já fiz o pix',
    'Paguei o pix agora',
    'Acabei de mandar o pix, segue o comprovante',
    'Não tenho pix',
    'não quero pagar no pix',
    'Vou pagar na clínica',
    'Qual o endereço?',
    'quero pagar com cartão ou pix',
    'posso pagar no dia ou preciso do pix?',
    'quero saber o valor do pix',
    'Aceita débito e pix?',
    'vocês aceitam cartão e pix?',
    '[imagem do cliente]: COMPROVANTE: Pix enviado. Valor: R$ 100,00.',
    '[arquivo do cliente]: COMPROVANTE: Transferência Pix. Valor: R$ 100,00.',
    '[imagem do cliente]: Foto de um cartaz escrito "chave pix: manda o pix"',
  ]) {
    assert.equal(pacientePediuAChave([fala]), false, fala);
  }
});

test('A: a resposta que JÁ traz a chave exata e pede o comprovante não é trocada', () => {
  const boa = `Claro! A taxa de agendamento é de R$ 100. Chave Pix: ${DADOS.chave} (Clinica Teste Ltda). Me manda o comprovante aqui, tá?`;
  assert.equal(travaDaTaxaDeReserva(boa, DADOS, com({ falasDoPaciente: ['E o pix'] })), null);
});

test('A: a resposta com a chave mas SEM pedir o comprovante é trocada', () => {
  const semPedido = `Claro! Chave Pix: ${DADOS.chave}`;
  assert.equal(travaDaTaxaDeReserva(semPedido, DADOS, com({ falasDoPaciente: ['E o pix'] }))?.texto, recadoDaChave(DADOS));
});

test('A: a resposta com a chave exata mas que manda a equipe enviar outra é trocada', () => {
  const t = `Chave Pix: ${DADOS.chave}. Depois a equipe te envia a chave certa e o comprovante.`;
  assert.equal(travaDaTaxaDeReserva(t, DADOS, com({ falasDoPaciente: ['E o pix'] }))?.motivo, 'equipe_envia_a_chave');
});

test('A: "a equipe envia" em pergunta ou negação não conta', () => {
  assert.equal(empurrouAChaveParaEquipe('Quer que a equipe te envie a chave?'), false);
  assert.equal(empurrouAChaveParaEquipe('A equipe não envia a chave por telefone.'), false);
  assert.equal(empurrouAChaveParaEquipe('A equipe confere o Pix e confirma.'), false);
  assert.equal(empurrouAChaveParaEquipe('Me manda o comprovante do Pix que a equipe confere.'), false);
});

test('A sem chave ou sem valor cadastrado: o comportamento de antes fica', () => {
  assert.equal(travaDaTaxaDeReserva(SOFIA_27_10_PIX, dadosDaTaxa(unidade({ pixKey: null })), com({ falasDoPaciente: ['E o pix'] })), null);
  assert.equal(travaDaTaxaDeReserva(SOFIA_27_10_PIX, dadosDaTaxa(unidade({ sourceProdutos: '' })), com({ falasDoPaciente: ['E o pix'] })), null);
});

test('A: unidade SEM a flag não é tocada', () => {
  assert.equal(travaDaTaxaDeReserva(SOFIA_27_10_PIX, dadosDaTaxa(unidade({ spineBookingRequiresPayment: false })), com({ falasDoPaciente: ['E o pix'] })), null);
});

test('A e B: paciente em tratamento (sessão, saldo) não recebe a taxa de reserva', () => {
  const ctx = { falasDoPaciente: ['manda o pix'], emTratamento: true };
  assert.equal(travaDaTaxaDeReserva(SOFIA_27_10_PIX, DADOS, com(ctx)), null);
  assert.equal(travaDaTaxaDeReserva(SOFIA_28_10[1], DADOS, com({ emTratamento: true })), null);
  assert.equal(promptDizEmTratamento('- Este paciente JÁ TEM TRATAMENTO na clínica (fechado ou em andamento).'), true);
  assert.equal(promptDizEmTratamento('- ELE ESTÁ EM TRATAMENTO (funil TRATAMENTO). Sessão'), true);
  assert.equal(promptDizEmTratamento('<consulta_do_paciente>Próximo agendamento: 29/10</consulta_do_paciente>'), false);
});

test('A: com consulta de pé no CRM ou com comprovante lido a chave não é refeita', () => {
  const ctx = { falasDoPaciente: ['E o pix'] };
  assert.equal(travaDaTaxaDeReserva(SOFIA_27_10_PIX, DADOS, com({ ...ctx, consultaDePe: true })), null);
  assert.equal(travaDaTaxaDeReserva(SOFIA_27_10_PIX, DADOS, com({ ...ctx, comprovanteLido: true })), null);
});

// --- D: quer pagar só na clínica / a resposta só PERGUNTA se quer a chave (28/10, segundo caso da Boa Vista) -----------------

// A Sofia, literal (o nome do paciente fica de fora): a frase quebrada e a pergunta no lugar da chave.
const SOFIA_28_10_PERGUNTOU =
  'Entendi! sem isso, o horário pode ser ocupado por outra pessoa até lá \n\nQuer que eu te passe a chave Pix pra garantir sua vaga de quinta às 15h30?';
const PACIENTE_SO_NA_HORA = 'Só pago na hora tudo';

test('D: "Só pago na hora tudo" + a Sofia que só PERGUNTA pela chave → taxa em uma frase e a chave na mesma mensagem', () => {
  const r = travaDaTaxaDeReserva(SOFIA_28_10_PERGUNTOU, DADOS, com({ falasDoPaciente: [PACIENTE_SO_NA_HORA] }));
  assert.equal(r?.motivo, 'pagar_na_clinica');
  assert.equal(r?.texto, recadoPagarNaClinica(DADOS));
  assert.match(r!.texto, /só fica separado com a taxa de agendamento de R\$ 100/);
  assert.match(r!.texto, /ocupado por outra pessoa/);
  assert.match(r!.texto, /Chave Pix: 12\.345\.678\/0001-90/);
  assert.match(r!.texto, /Titular: Clinica Teste Ltda/);
  assert.match(r!.texto, /comprovante aqui na conversa \(foto ou PDF\)/);
  assert.doesNotMatch(r!.texto, /Quer que eu/);
});

test('D: a resposta que só pergunta "quer que eu te passe a chave?" é trocada pela versão com a chave, mesmo sem o paciente falar de pagamento', () => {
  const r = travaDaTaxaDeReserva('Quer que eu te passe a chave Pix pra garantir sua vaga de quinta às 15h30?', DADOS, com({ falasDoPaciente: ['Pode ser quinta'] }));
  assert.equal(r?.motivo, 'chave_oferecida');
  assert.equal(r?.texto, recadoDaChave(DADOS));
});

test('D: ofertas da chave em pergunta reconhecidas; escolha entre formas de pagar não é oferta', () => {
  for (const t of ['Quer que eu te passe a chave Pix?', 'Posso te enviar a chave Pix?', 'Quer a chave Pix?', 'Quer que eu te mande a chave pra garantir a vaga?']) {
    assert.equal(ofereceuAChaveEmPergunta(t), true, t);
  }
  for (const t of ['Prefere pagar o Pix antecipado ou na clínica?', 'Qual horário fica melhor pra você?', 'A chave Pix é 12.345.678/0001-90. Me manda o comprovante, tá?', 'Posso confirmar seu agendamento?']) {
    assert.equal(ofereceuAChaveEmPergunta(t), false, t);
  }
});

test('D: "pagar na clínica" reconhecido; quem pediu a chave, escolheu o antecipado ou fala de outra coisa não', () => {
  for (const f of [PACIENTE_SO_NA_HORA, 'pago na clínica', 'Na clínica', 'vou pagar no dia', 'prefiro pagar lá', 'só na clínica mesmo', 'Não quero pagar antecipado, pago na consulta']) {
    assert.equal(pacienteQuerPagarNaClinica([f]), true, f);
  }
  for (const f of ['Me manda a chave que pago no dia', 'E o pix', 'Pix antecipado', 'Quero agendar para quinta', 'Qual o endereço da clínica?', 'Quero pagar no pix']) {
    assert.equal(pacienteQuerPagarNaClinica([f]), false, f);
  }
});

test('D: depois de receber a chave, quem INSISTE em pagar só na clínica fica com a equipe, sem promessa de horário', () => {
  const r = travaDaTaxaDeReserva('Tudo bem! Então seu horário de quinta às 15h30 está reservado, pode vir.', DADOS, com({ falasDoPaciente: ['Mas eu só pago na clínica mesmo'], respostaAnterior: recadoPagarNaClinica(DADOS) }));
  assert.equal(r?.motivo, 'insistiu_na_clinica');
  assert.equal(r?.texto, RECADO_INSISTIU_NA_CLINICA);
  assert.doesNotMatch(r!.texto, /garantid|reservad|confirmad|agendad|marcad|te espero/i);
  assert.match(r!.texto, /equipe/);
});

test('D: sem a chave na resposta anterior não é insistência — é a primeira vez, recebe a chave', () => {
  const r = travaDaTaxaDeReserva('Tudo bem!', DADOS, com({ falasDoPaciente: ['Na clínica'], respostaAnterior: 'Prefere pagar o Pix antecipado ou na clínica?' }));
  assert.equal(r?.motivo, 'pagar_na_clinica');
});

test('D: respostaAnteriorDaIA pega a última resposta ANTES das falas deste turno', () => {
  const m = (tipo: string, texto: string) => ({ tipo, texto });
  assert.equal(respostaAnteriorDaIA([m('human', 'oi'), m('ai', 'Olá! Pix ou clínica?'), m('human', 'clínica'), m('human', 'só isso')]), 'Olá! Pix ou clínica?');
  assert.equal(
    respostaAnteriorDaIA([m('human', 'oi'), m('ai', 'Olá!'), m('human', 'e o pix'), m('ai', ''), m('tool', 'resultado')]),
    'Olá!',
  );
  assert.equal(respostaAnteriorDaIA([m('human', 'oi'), m('ai', 'Olá!'), m('human', 'e o pix'), m('ai', 'Vou conferir a agenda'), m('tool', 'ok')]), 'Olá!');
  assert.equal(respostaAnteriorDaIA([m('human', 'oi')]), '');
});

test('D: a resposta que já traz a chave e pede o comprovante não é trocada', () => {
  const boa = `Entendi! A taxa de R$ 100 separa o horário. Chave Pix: ${DADOS.chave}. Me manda o comprovante, tá?`;
  assert.equal(travaDaTaxaDeReserva(boa, DADOS, com({ falasDoPaciente: [PACIENTE_SO_NA_HORA] })), null);
});

test('D: unidade sem a flag, sem chave, com consulta de pé ou com comprovante não é tocada', () => {
  const ctx = com({ falasDoPaciente: [PACIENTE_SO_NA_HORA] });
  assert.equal(travaDaTaxaDeReserva(SOFIA_28_10_PERGUNTOU, dadosDaTaxa(unidade({ spineBookingRequiresPayment: false })), ctx), null);
  assert.equal(travaDaTaxaDeReserva(SOFIA_28_10_PERGUNTOU, dadosDaTaxa(unidade({ pixKey: null })), ctx), null);
  assert.equal(travaDaTaxaDeReserva(SOFIA_28_10_PERGUNTOU, DADOS, { ...ctx, consultaDePe: true }), null);
  assert.equal(travaDaTaxaDeReserva(SOFIA_28_10_PERGUNTOU, DADOS, { ...ctx, comprovanteLido: true }), null);
  assert.equal(travaDaTaxaDeReserva(SOFIA_28_10_PERGUNTOU, DADOS, { ...ctx, emTratamento: true }), null);
});

// --- B: nenhuma afirmação sem comprovante nem consulta --------------------------------------------------------------------

// Frases REAIS da Sofia (28/10, Boa Vista). Só o que foi medido: os trechos, não a conversa.
const SOFIA_28_10 = [
  'Já deixei tudo registrado com a equipe pra te receber direito às 14h',
  'Até já às 13h30',
  'já está tudo certo com seu horário de 13h30 hoje',
];

test('B: as três frases reais da Sofia são trocadas pelo recado com a chave', () => {
  for (const frase of SOFIA_28_10) {
    const r = travaDaTaxaDeReserva(frase, DADOS, SEM_PROVA);
    assert.equal(r?.motivo, 'horario_sem_comprovante', frase);
    assert.equal(r?.texto, recadoSemComprovante(DADOS), frase);
  }
  const r = travaDaTaxaDeReserva('Perfeito, Maria! Até já às 13h30 🙏', DADOS, SEM_PROVA);
  assert.match(r!.texto, /ainda não está garantido/);
  assert.match(r!.texto, /Me manda o comprovante/);
  assert.match(r!.texto, /Chave Pix: 12\.345\.678\/0001-90/);
  assert.match(r!.texto, /R\$ 100/);
  assert.match(r!.texto, /foto ou PDF/);
});

test('B: outras formas de dar o horário como garantido', () => {
  for (const frase of [
    'Sua consulta está confirmada para hoje às 13h30.',
    'Está reservado, viu? Te espero amanhã!',
    'Combinado, terça às 10h então!',
    'Agendamento confirmado ✅',
    'Tudo certo, seu horário está garantido.',
    'Já deixei seu horário anotado com a equipe, às 14h.',
    'Aguardamos você hoje às 14h!',
    'Já deixei tudo registrado para quarta às 10h, pra garantir é só me mandar o comprovante.',
    'Sua consulta está confirmada para quarta às 10h, quando você chegar é só avisar na recepção.',
    'Já deixei tudo registrado com a equipe pra te receber direito às 14h, me manda o comprovante?',
  ]) {
    assert.equal(afirmaHorarioGarantido(frase), true, frase);
  }
});

test('B: contraexemplos que NÃO podem ser trocados — explicação, pergunta, condição', () => {
  for (const frase of [
    'O horário só é reservado depois do pagamento da taxa de agendamento.',
    'Posso confirmar seu agendamento?',
    'Quer que eu deixe tudo registrado com a equipe?',
    'Deixo tudo registrado com a equipe para as 14h?',
    'Assim que o comprovante chegar, deixo tudo registrado com a equipe.',
    'Seu horário fica reservado assim que o comprovante chegar.',
    'Quando você mandar o comprovante, a gente te espera às 14h.',
    'O horário de 13h30 ainda não está confirmado.',
    'Tenho 13h30 e 14h30 hoje. Qual prefere?',
    'Funcionamos das 8h às 17h. Me diz o melhor horário pra você?',
    'Até já! Me diz o seu nome completo?',
    'Perfeito! Tudo certo, vou precisar do seu nome completo.',
    'Tudo certo! Qual o seu CPF?',
    'Fico no aguardo do comprovante, assim o horário fica reservado.',
    'Estamos aqui pra te receber bem, qualquer dúvida é só chamar!',
    'Deixo agendado para quarta às 10h, pode ser?',
    'Até já às 13h30?',
    'Depois que você pagar o Pix, a equipe te envia a confirmação.',
    'Para garantir o horário das 14h, preciso do comprovante.',
  ]) {
    assert.equal(travaDaTaxaDeReserva(frase, DADOS, SEM_PROVA), null, frase);
  }
});

test('B: existe consulta de pé no CRM → a resposta sai como veio', () => {
  for (const frase of SOFIA_28_10) {
    assert.equal(travaDaTaxaDeReserva(frase, DADOS, com({ consultaDePe: true })), null, frase);
  }
});

test('B: há comprovante lido → quem cuida é a espera da equipe, a trava não troca', () => {
  for (const frase of SOFIA_28_10) {
    assert.equal(travaDaTaxaDeReserva(frase, DADOS, com({ comprovanteLido: true })), null, frase);
  }
});

test('B: unidade SEM a flag não é tocada', () => {
  for (const frase of SOFIA_28_10) {
    assert.equal(travaDaTaxaDeReserva(frase, dadosDaTaxa(unidade({ spineBookingRequiresPayment: false })), SEM_PROVA), null, frase);
  }
});

test('B sem chave ou sem valor cadastrado: o comportamento de antes fica (nada inventado)', () => {
  assert.equal(travaDaTaxaDeReserva(SOFIA_28_10[1], dadosDaTaxa(unidade({ pixKey: '' })), SEM_PROVA), null);
  assert.equal(travaDaTaxaDeReserva(SOFIA_28_10[1], dadosDaTaxa(unidade({ sourceProdutos: null })), SEM_PROVA), null);
});

test('A vem antes de B: pediu o Pix e a resposta também garante o horário → uma troca só, a da chave', () => {
  const r = travaDaTaxaDeReserva('Já deixei tudo registrado com a equipe. A equipe te envia a chave.', DADOS, com({ falasDoPaciente: ['E o pix'] }));
  assert.equal(r?.texto, recadoDaChave(DADOS));
});

// --- o recado não pode ser desfeito pelas outras travas da saída ----------------------------------------------------------

test('os recados fixos passam limpos pelas travas de confirmação, de reserva e de saída', () => {
  for (const recado of [recadoDaChave(DADOS), recadoSemComprovante(DADOS), recadoPagarNaClinica(DADOS), RECADO_INSISTIU_NA_CLINICA]) {
    assert.equal(afirmaConfirmacao(recado), null, recado);
    assert.equal(afirmaConfirmacao(recado, { estrito: true }), null, recado);
    assert.equal(afirmaHorarioGarantido(recado), false, recado);
    assert.equal(reservaSemMarcar(recado, { marcouAgora: false }), null, recado);
    assert.equal(afirmouComConsultaDesmarcada(recado, { marcouAgora: false, bloco: 'foi DESMARCADA no sistema da clínica', promessa: null }), null, recado);
    assert.equal(empurrouAChaveParaEquipe(recado), false, recado);
    assert.equal(detectarVazamento(recado), null, recado);
    assert.equal(semDiminutivo(recado), recado);
    assert.equal(semIntimidade(recado), recado);
    assert.equal(ofereceuAChaveEmPergunta(recado), false, recado);
    const g = aplicarGuardrail(recado, unidade());
    assert.deepEqual(g.triggered, [], recado);
    assert.equal(g.text, recado);
  }
});

test('o recado nunca traz lacuna nem dado fora do cadastro', () => {
  for (const recado of [recadoDaChave(DADOS), recadoSemComprovante(DADOS), recadoPagarNaClinica(DADOS)]) {
    assert.doesNotMatch(recado, /\[|\]|XXX/);
    assert.deepEqual([...recado.matchAll(/R\$\s*[\d.,]+/g)].map((m) => m[0]), ['R$ 100']);
  }
  const semTitular = recadoDaChave({ ...DADOS, titular: null });
  assert.doesNotMatch(semTitular, /Titular/);
});
