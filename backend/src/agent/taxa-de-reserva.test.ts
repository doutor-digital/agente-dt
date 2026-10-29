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
import { afirmaConfirmacao, afirmouComConsultaDesmarcada, respostaDoComprovante } from './confirmacao-so-com-crm.js';
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
const SEM_PROVA: ContextoDaTaxa = { falasDoPaciente: [], consultaDePe: false, emTratamento: false, respostaAnterior: '', comprovanteLido: false, jaMandouComprovante: false, insistenciaJaEncaminhada: false };
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

test('A: o paciente pediu o Pix e o modelo respondeu outra coisa → a resposta fica e a chave é acrescentada', () => {
  const r = travaDaTaxaDeReserva('Claro! Qual horário fica melhor pra você?', DADOS, com({ falasDoPaciente: ['E o pix'] }));
  assert.equal(r?.motivo, 'chave_pedida');
  assert.match(r!.texto, /^Claro! Qual horário fica melhor pra você\?\n\nPara garantir o seu horário/);
  assert.match(r!.texto, /Chave Pix: 12\.345\.678\/0001-90/);
  assert.equal(r?.preservouOResto, true);
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
    'me passa o endereço, aceita pix?',
    'manda o valor, é por pix?',
    'pode passar o preço do pix',
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
  assert.equal(empurrouAChaveParaEquipe('A equipe vai te enviar o endereço e a chave de acesso.'), false);
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
  for (const f of ['ok, pago o restante na clínica', 'O resto pago na clínica, né?', 'Me manda a chave que pago no dia', 'E o pix', 'Pix antecipado', 'Quero agendar para quinta', 'Qual o endereço da clínica?', 'Quero pagar no pix']) {
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

test('D: a insistência é tratada UMA vez por conversa — depois do encaminhamento, repetir "só na clínica" não troca nem refaz o recado', () => {
  const r = travaDaTaxaDeReserva('Certo!', DADOS, com({ falasDoPaciente: ['só na clínica'], respostaAnterior: RECADO_INSISTIU_NA_CLINICA }));
  assert.equal(r, null);
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

test('A vem antes de B: pediu o Pix e a resposta também garante o horário → uma troca só, a da chave (recado inteiro: o resto ainda garante)', () => {
  const r = travaDaTaxaDeReserva('Já deixei tudo registrado com a equipe. A equipe te envia a chave.', DADOS, com({ falasDoPaciente: ['E o pix'] }));
  assert.equal(r?.texto, recadoDaChave(DADOS));
  assert.equal(r?.preservouOResto, false);
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

// --- Correção pós-merge do #158 (reprovação do sênior, 28/10) -------------------------------------------------------------------

import { comprovantesDoTexto, marcarRecebimento, turnoDoComprovante } from './confirmacao-so-com-crm.js';
import { pacienteJaMandouComprovante, jaEncaminhouAInsistencia, insistenciaJaTratada, RECADO_INSISTIU_SEM_PROMESSA, recadoDaInsistencia } from './taxa-de-reserva.js';

const HA_3_DIAS = new Date(Date.now() - 3 * 24 * 3_600_000);
const COMPROVANTE_ANTIGO = marcarRecebimento('[imagem do cliente]: COMPROVANTE: Pix enviado. Valor: R$ 100,00.', HA_3_DIAS);

test('1: comprovante de 3 dias atrás NÃO conta nas 24 h da espera, mas conta como "já pagou" — e a trava não pede a taxa de novo', () => {
  const falas = [COMPROVANTE_ANTIGO, 'e a consulta?'];
  assert.equal(turnoDoComprovante(falas).pendente, false, 'a janela de 24 h da espera é outra regra e continua');
  assert.equal(pacienteJaMandouComprovante(falas), true);
  const ctx = com({ falasDoPaciente: falas, jaMandouComprovante: pacienteJaMandouComprovante(falas) });
  for (const resposta of ['Já deixei tudo registrado com a equipe pra te receber direito às 14h', 'A equipe te envia a chave certa', 'Quer que eu te passe a chave Pix?', 'Certo!']) {
    assert.equal(travaDaTaxaDeReserva(resposta, DADOS, ctx), null, resposta);
  }
  // a recusa da taxa de quem já pagou também não vira o recado, nem o aviso de que vai pagar no Pix
  assert.equal(travaDaTaxaDeReserva('Tudo bem', DADOS, { ...ctx, falasDoPaciente: ['só pago na hora'] }), null);
  assert.equal(travaDaTaxaDeReserva('Perfeito!', DADOS, { ...ctx, falasDoPaciente: ['ok, vou pagar no pix agora'] }), null);
});

test('1: quem já pagou e PEDE a chave de forma explícita (nova consulta) ainda a recebe — pediu, e "a equipe te envia" seria a falha de antes', () => {
  const ctx = com({ falasDoPaciente: ['qual a chave do pix?'], jaMandouComprovante: true });
  assert.equal(travaDaTaxaDeReserva('A equipe te envia a chave certa', DADOS, ctx)?.motivo, 'equipe_envia_a_chave');
  assert.equal(travaDaTaxaDeReserva('Claro!', DADOS, ctx)?.motivo, 'chave_pedida');
  assert.equal(travaDaTaxaDeReserva(recadoDaChave(DADOS), DADOS, ctx), null);
});

test('1: "já mandou comprovante" lê foto/PDF de qualquer idade, com ou sem carimbo; cartaz e conversa comum não', () => {
  assert.equal(pacienteJaMandouComprovante([COMPROVANTE_ANTIGO]), true);
  assert.equal(pacienteJaMandouComprovante(['[arquivo do cliente]: COMPROVANTE: Transferência. Valor: R$ 100,00.']), true, 'sem carimbo = mensagem antiga');
  assert.equal(pacienteJaMandouComprovante(['[imagem do cliente]: Foto de um cartaz escrito "chave pix"']), false);
  assert.equal(pacienteJaMandouComprovante(['paguei o pix', 'oi']), false);
  assert.equal(comprovantesDoTexto(COMPROVANTE_ANTIGO).length, 1);
});

test('4: perguntas sobre o dia (quanto, cartão, remarcar) NÃO são recusa da taxa — a resposta fica', () => {
  const casos: Array<[string, string]> = [
    ['quanto pago no dia?', 'No dia você paga R$ 250, o restante. A taxa de R$ 100 é antes, por Pix.'],
    ['quanto vou pagar no dia?', 'No dia são R$ 250.'],
    ['posso pagar no cartão no dia?', 'Pode sim! No dia o restante de R$ 250 pode ser no cartão.'],
    ['não vou poder ir no dia, posso pagar e remarcar?', 'Claro, a gente remarca. Qual dia fica melhor?'],
  ];
  for (const [fala, resposta] of casos) {
    assert.equal(pacienteQuerPagarNaClinica([fala]), false, fala);
    assert.equal(travaDaTaxaDeReserva(resposta, DADOS, com({ falasDoPaciente: [fala] })), null, fala);
  }
});

test('4: a recusa de verdade segue sendo pega, inclusive depois de uma pergunta na mesma fala', () => {
  for (const f of [PACIENTE_SO_NA_HORA, 'Quanto é a consulta? Só pago na hora tudo', 'posso pagar no dia?', 'Só na clínica.', 'pago na consulta']) {
    assert.equal(pacienteQuerPagarNaClinica([f]), true, f);
  }
});

test('5: "vou ver os horários" e "deixei anotado que o melhor horário é à tarde" NÃO garantem horário', () => {
  for (const frase of ['Tudo certo, vou ver os horários de quinta pra você', 'Deixei anotado aqui que o melhor horário pra você é à tarde']) {
    assert.equal(afirmaHorarioGarantido(frase), false, frase);
    assert.equal(travaDaTaxaDeReserva(frase, DADOS, SEM_PROVA), null, frase);
  }
});

test('5: "quinta às 14h está disponível pra você" informa vaga, não guarda horário', () => {
  assert.equal(afirmaHorarioGarantido('Tudo certo, quinta às 14h está disponível pra você.'), false);
  assert.equal(afirmaHorarioGarantido('Tudo certo, quinta às 14h está disponível e já deixei reservado pra você.'), true);
});

test('5: o que garante de verdade continua pego, mesmo com "vou ver" na frase', () => {
  for (const frase of ['Sua consulta está confirmada para quinta às 14h, vou ver mais horários se quiser', 'Já deixei anotado que seu horário é quarta às 10h', 'Já deixei tudo registrado com a equipe pra te receber direito às 14h']) {
    assert.equal(afirmaHorarioGarantido(frase), true, frase);
  }
});

test('6: "a equipe te envia a confirmação/o recibo depois do Pix" NÃO é "a equipe envia a chave"', () => {
  for (const frase of ['A equipe te envia a confirmação depois do Pix', 'A equipe encaminha o recibo do Pix', 'A equipe te envia o comprovante do Pix por e-mail', 'A equipe te manda o lembrete depois do Pix']) {
    assert.equal(empurrouAChaveParaEquipe(frase), false, frase);
    assert.equal(travaDaTaxaDeReserva(frase, DADOS, com({ falasDoPaciente: ['ok'] })), null, frase);
  }
});

test('7: quem acabou de receber a chave e diz "vou pagar no pix agora" não recebe o recado de novo', () => {
  const ctx = com({ falasDoPaciente: ['ok, vou pagar no pix agora'], respostaAnterior: recadoDaChave(DADOS) });
  assert.equal(travaDaTaxaDeReserva('Perfeito, fico no aguardo!', DADOS, ctx), null);
  assert.equal(pacientePediuAChave(['ok, vou pagar no pix agora'], { soPedidoExplicito: true }), false);
  assert.equal(pacientePediuAChave(['Pix antecipado'], { soPedidoExplicito: true }), false);
  // quem ainda NÃO recebeu a chave segue recebendo; e o pedido explícito vale mesmo depois de recebê-la
  assert.equal(travaDaTaxaDeReserva('Perfeito!', DADOS, com({ falasDoPaciente: ['ok, vou pagar no pix agora'] }))?.motivo, 'chave_pedida');
  assert.equal(travaDaTaxaDeReserva('Perfeito!', DADOS, { ...ctx, falasDoPaciente: ['e o pix? não achei'] })?.motivo, 'chave_pedida');
  assert.equal(travaDaTaxaDeReserva('Perfeito!', DADOS, { ...ctx, falasDoPaciente: ['qual a chave mesmo?'] })?.motivo, 'chave_pedida');
});

test('8: "Não se preocupe, a equipe já vai te enviar a chave" É pego; a negação do envio continua valendo', () => {
  assert.equal(empurrouAChaveParaEquipe('Não se preocupe, a equipe já vai te enviar a chave por aqui'), true);
  assert.equal(empurrouAChaveParaEquipe('Não precisa se preocupar, a equipe te manda a chave'), true);
  assert.equal(travaDaTaxaDeReserva('Não se preocupe, a equipe te manda a chave', DADOS, com({ falasDoPaciente: ['Quero agendar quinta'] }))?.motivo, 'equipe_envia_a_chave');
  assert.equal(empurrouAChaveParaEquipe('Não se preocupe a equipe te manda a chave'), true, 'sem vírgula: o tranquilizador sozinho não é negação');
  assert.equal(empurrouAChaveParaEquipe('Não demora: a equipe te envia a chave'), true, 'o "não" de outra oração não nega o envio');
  assert.equal(empurrouAChaveParaEquipe('A equipe não envia a chave por telefone.'), false);
  assert.equal(empurrouAChaveParaEquipe('Nem a equipe envia a chave por telefone.'), false);
});

test('9: "e o pix?" + "qual o endereço?" — o endereço fica e a chave é acrescentada', () => {
  const r = travaDaTaxaDeReserva('Claro! Fica na Av. Ville Roy, 1234. A chave a equipe te envia.', DADOS, com({ falasDoPaciente: ['e o pix?', 'qual o endereço?'] }));
  assert.equal(r?.motivo, 'equipe_envia_a_chave');
  assert.equal(r?.preservouOResto, true);
  assert.match(r!.texto, /^Claro! Fica na Av\. Ville Roy, 1234\.\n\nPara garantir o seu horário/);
  assert.match(r!.texto, /Chave Pix: 12\.345\.678\/0001-90/);
  assert.doesNotMatch(r!.texto, /a equipe te envia/i);
  // o texto montado já é uma resposta que a trava deixa passar (idempotente)
  assert.equal(travaDaTaxaDeReserva(r!.texto, DADOS, com({ falasDoPaciente: ['e o pix?'] })), null);
});

test('9: quando o resto ainda garante horário, não é seguro — vale o recado inteiro (último recurso)', () => {
  const r = travaDaTaxaDeReserva('Seu horário de quinta às 14h está garantido. A equipe te envia a chave.', DADOS, com({ falasDoPaciente: ['e o pix?'] }));
  assert.equal(r?.texto, recadoDaChave(DADOS));
  assert.equal(r?.preservouOResto, false);
  const sobrou = travaDaTaxaDeReserva('Quer que eu te passe a chave Pix?', DADOS, com({ falasDoPaciente: ['ok'] }));
  assert.equal(sobrou?.texto, recadoDaChave(DADOS), 'sem resto, o recado inteiro');
});

test('9: parte D — o endereço da resposta fica; o pedido de Pix da Sofia (oferta, "sem isso…") sai', () => {
  const sofia = 'Entendi, Edilson! sem isso, o horário pode ser ocupado por outra pessoa até lá\n\nQuer que eu te passe a chave Pix?';
  const r = travaDaTaxaDeReserva(sofia, DADOS, com({ falasDoPaciente: [PACIENTE_SO_NA_HORA] }));
  assert.equal(r?.motivo, 'pagar_na_clinica');
  assert.match(r!.texto, /^Entendi, Edilson!\n\nAqui o horário só fica separado com a taxa/);
  assert.doesNotMatch(r!.texto, /Quer que eu/);
  const comEndereco = travaDaTaxaDeReserva('Tudo bem! Fica na Av. Ville Roy, 1234, com estacionamento. Pode pagar tudo na clínica, no dia.', DADOS, com({ falasDoPaciente: ['qual o endereço? só pago na hora'] }));
  assert.match(comEndereco!.texto, /Fica na Av\. Ville Roy, 1234, com estacionamento\./);
  assert.doesNotMatch(comEndereco!.texto, /Pode pagar tudo na clínica/);
  assert.match(comEndereco!.texto, /Chave Pix: /);
});

test('3: a insistência é tratada UMA vez por conversa — 4 turnos seguidos dão 1 recado', () => {
  let respostaAnterior = recadoPagarNaClinica(DADOS);
  let insistenciaJaEncaminhada = false;
  const motivos: string[] = [];
  for (const fala of ['só na clínica', 'na clínica mesmo', 'pago na hora', 'já disse, pago no dia']) {
    const r = travaDaTaxaDeReserva('Tudo bem!', DADOS, com({ falasDoPaciente: [fala], respostaAnterior, insistenciaJaEncaminhada }));
    motivos.push(r?.motivo ?? 'null');
    if (r) {
      respostaAnterior = r.texto;
      insistenciaJaEncaminhada = insistenciaJaEncaminhada || jaEncaminhouAInsistencia(r.texto);
    } else {
      respostaAnterior = 'Tudo bem!'; // o que o modelo disse, sem a chave
    }
  }
  assert.deepEqual(motivos, ['insistiu_na_clinica', 'null', 'null', 'null']);
});

test('3: depois do encaminhamento, uma resposta comum do modelo no meio não reabre o ciclo (a conversa lembra)', () => {
  const r = travaDaTaxaDeReserva('Tudo bem!', DADOS, com({ falasDoPaciente: ['pago na hora'], respostaAnterior: 'Tudo bem!', insistenciaJaEncaminhada: true }));
  assert.equal(r, null);
});

test('2: o recado sem promessa não diz que a equipe vai falar com ele, e é um recado limpo', () => {
  assert.doesNotMatch(RECADO_INSISTIU_SEM_PROMESSA, /equipe/i);
  assert.equal(jaEncaminhouAInsistencia(RECADO_INSISTIU_SEM_PROMESSA), true, 'o recado sem promessa também fecha o ciclo (o João já recebeu o alerta); senão a chave e o alerta se repetem');
  assert.equal(jaEncaminhouAInsistencia(RECADO_INSISTIU_NA_CLINICA), true);
  assert.equal(afirmaHorarioGarantido(RECADO_INSISTIU_SEM_PROMESSA), false);
  assert.equal(empurrouAChaveParaEquipe(RECADO_INSISTIU_SEM_PROMESSA), false);
  assert.equal(ofereceuAChaveEmPergunta(RECADO_INSISTIU_SEM_PROMESSA), false);
  const g = aplicarGuardrail(RECADO_INSISTIU_SEM_PROMESSA, unidade());
  assert.deepEqual(g.triggered, []);
  assert.equal(g.text, RECADO_INSISTIU_SEM_PROMESSA);
});

test('as respostas com o resto preservado também passam inteiras pelas travas de saída e pelo guardrail', () => {
  const textos = [
    travaDaTaxaDeReserva('Claro! Fica na Av. Ville Roy, 1234. A chave a equipe te envia.', DADOS, com({ falasDoPaciente: ['e o pix?', 'qual o endereço?'] }))!.texto,
    travaDaTaxaDeReserva('Entendi, Edilson! Quer que eu te passe a chave Pix?', DADOS, com({ falasDoPaciente: [PACIENTE_SO_NA_HORA] }))!.texto,
  ];
  for (const t of textos) {
    assert.equal(afirmaConfirmacao(t), null, t);
    assert.equal(reservaSemMarcar(t, { marcouAgora: false }), null, t);
    assert.equal(detectarVazamento(t), null, t);
    assert.equal(semDiminutivo(t), t);
    assert.equal(semIntimidade(t), t);
    const g = aplicarGuardrail(t, unidade());
    assert.deepEqual(g.triggered, [], t);
    assert.equal(g.text, t);
  }
});

test('6 (revisão): "dados/informações do Pix" e "o endereço e a chave Pix" CONTINUAM sendo a chave empurrada para a equipe', () => {
  for (const frase of ['A equipe te envia os dados do Pix', 'A equipe te envia as informações para o Pix', 'A equipe te envia o endereço e a chave Pix', 'A equipe te envia a chave do Pix']) {
    assert.equal(empurrouAChaveParaEquipe(frase), true, frase);
  }
  assert.equal(empurrouAChaveParaEquipe('A equipe te envia o valor do Pix'), false);
});

test('5 (revisão): a oração que anuncia ou informa sai do julgamento, o resto do trecho segue valendo', () => {
  for (const frase of [
    'Tudo certo, vou verificar o horário e já deixo reservado para você',
    'Estarei te esperando amanhã às 14h, o horário está livre',
    'Pode vir amanhã às 14h, o horário está disponível e já está tudo certo',
  ]) {
    assert.equal(afirmaHorarioGarantido(frase), true, frase);
  }
});

test('4 (revisão): "Ok. No dia." solto não é recusa; "quero pagar tudo no dia, quanto fica?" é', () => {
  assert.equal(pacienteQuerPagarNaClinica(['Ok. No dia.']), false);
  assert.equal(pacienteQuerPagarNaClinica(['Sim. Na hora.']), false);
  assert.equal(pacienteQuerPagarNaClinica(['na clínica']), true);
  assert.equal(pacienteQuerPagarNaClinica(['Quero pagar tudo no dia, quanto fica?']), true);
});

test('9 (revisão): "Então, chegue 10 min antes" fica; só o "sem isso, …" pendurado de uma frase que saiu vai junto', () => {
  const r = travaDaTaxaDeReserva('O endereço é Rua X, 10. Então, chegue 10 min antes. A equipe te envia a chave.', DADOS, com({ falasDoPaciente: ['e o pix? qual o endereço?'] }));
  assert.match(r!.texto, /^O endereço é Rua X, 10\. Então, chegue 10 min antes\.\n\nPara garantir/);
});

test('o recado do comprovante e a trava da taxa não se atropelam: sem comprovante pendente, respostaDoComprovante nunca troca (o que o grafo supõe ao tirar o guarda)', () => {
  const textos = ['Pagamento confirmado! Sua consulta está confirmada para quinta às 14h.', 'Tudo certo, seu horário está garantido'];
  for (const t of textos) assert.equal(respostaDoComprovante(t, { noTurno: false, pendente: false }, false), null);
});

test('2ª revisão: a negação não alcança uma oração longa sem vírgula; o Pix coordenado com outro objeto continua sendo o Pix', () => {
  assert.equal(empurrouAChaveParaEquipe('Não tenho acesso à chave aqui mas a equipe te envia a chave certinha'), true);
  assert.equal(empurrouAChaveParaEquipe('A equipe te envia o endereço e o Pix em seguida'), true);
  assert.equal(empurrouAChaveParaEquipe('A equipe te envia o recibo e o Pix'), true);
  assert.equal(empurrouAChaveParaEquipe('A equipe te envia o recibo do Pix'), false);
});

test('2ª revisão: só o "sem isso, …" pendurado sai junto; "Pra isso, basta trazer um documento" é instrução real e fica', () => {
  const r = travaDaTaxaDeReserva('A consulta é no sábado. Pra isso, basta trazer um documento com foto. Qual a chave?', DADOS, com({ falasDoPaciente: ['qual a chave?'] }));
  assert.match(r!.texto, /Pra isso, basta trazer um documento com foto\./);
});

test('2ª revisão: vírgula de decimal não separa oração, e o horário que a oração neutra citava não some do que sobra', () => {
  assert.equal(afirmaHorarioGarantido('Sua consulta está confirmada para quinta, vou ver o valor de R$ 150,00'), true);
  assert.equal(afirmaHorarioGarantido('Deixei reservado, quinta às 14h está disponível'), true);
  assert.equal(afirmaHorarioGarantido('Tudo certo, vou ver o valor de R$ 150,00 pra você'), false);
});

test('2ª revisão: a insistência é tratada UMA vez, com ou sem a promessa da equipe (sem resumo e alerta a cada turno)', () => {
  assert.equal(insistenciaJaTratada([]), false);
  assert.equal(insistenciaJaTratada([RECADO_INSISTIU_SEM_PROMESSA]), true);
  assert.equal(insistenciaJaTratada(['oi', RECADO_INSISTIU_NA_CLINICA]), true);
  assert.equal(insistenciaJaTratada(['oi', 'Tudo bem!']), false);
});

// --- Correção pós-merge do #158, 2ª rodada do sênior (29/10) -----------------------------------------------------------------------------

const END = 'Av. Ville Roy, 1234';
const semChaveNemValorErrado = (t: string) => {
  assert.doesNotMatch(t, /15\.765\.035/, t);
  assert.doesNotMatch(t, /R\$ 50\b/, t);
};

test('2ª rodada, item 2: chave e valor ERRADOS do modelo saem; só os do cadastro ficam', () => {
  const r = travaDaTaxaDeReserva('A chave Pix é 15.765.035/0001-52 e a taxa é R$ 50', DADOS, com({ falasDoPaciente: ['e o pix?'] }));
  assert.equal(r?.motivo, 'chave_pedida');
  semChaveNemValorErrado(r!.texto);
  assert.match(r!.texto, /Chave Pix: 12\.345\.678\/0001-90/);
  assert.match(r!.texto, /R\$ 100/);
  // o endereço da mesma resposta fica
  const comEndereco = travaDaTaxaDeReserva(`Fica na ${END}. A chave Pix é 15.765.035/0001-52 e a taxa é R$ 50.`, DADOS, com({ falasDoPaciente: ['e o pix?', 'qual o endereço?'] }));
  semChaveNemValorErrado(comEndereco!.texto);
  assert.match(comEndereco!.texto, new RegExp(`Fica na ${END}\\.`));
  assert.equal(comEndereco!.preservouOResto, true);
});

test('2ª rodada, item 2: chave errada com o paciente querendo pagar na clínica, e valor errado ao lado da chave certa', () => {
  const clinica = travaDaTaxaDeReserva('Tudo bem! Se quiser garantir, a chave é 15.765.035/0001-52.', DADOS, com({ falasDoPaciente: ['só pago na clínica'] }));
  assert.equal(clinica?.motivo, 'pagar_na_clinica');
  semChaveNemValorErrado(clinica!.texto);
  assert.match(clinica!.texto, /12\.345\.678\/0001-90/);
  const valor = travaDaTaxaDeReserva('A chave é 12.345.678/0001-90, a taxa é R$ 50. Me manda o comprovante, tá?', DADOS, com({ falasDoPaciente: ['e o pix?'] }));
  semChaveNemValorErrado(valor!.texto);
  assert.match(valor!.texto, /R\$ 100/);
});

test('2ª rodada, item 2: o valor da CONSULTA e o valor certo da taxa não são "valor errado"', () => {
  const r = travaDaTaxaDeReserva('A consulta é R$ 350 no total, sendo R$ 100 de taxa de agendamento. A equipe te envia a chave.', DADOS, com({ falasDoPaciente: ['e o pix?'] }));
  assert.match(r!.texto, /R\$ 350 no total, sendo R\$ 100 de taxa/);
  // a resposta correta e completa não é mexida
  assert.equal(travaDaTaxaDeReserva('A taxa é R$ 100. Chave Pix: 12.345.678/0001-90. Me manda o comprovante.', DADOS, com({ falasDoPaciente: ['e o pix?'] })), null);
});

test('2ª rodada, item 3: a oração neutra sai do julgamento mas o dia e a hora que ela citava continuam sendo o assunto', () => {
  for (const frase of [
    'Perfeito, quinta às 14h está disponível, deixei tudo registrado pra você',
    'Ótimo, sexta às 9h está livre, já deixei anotado pra você!',
  ]) {
    assert.equal(afirmaHorarioGarantido(frase), true, frase);
    assert.equal(travaDaTaxaDeReserva(frase, DADOS, com({ falasDoPaciente: ['quinta 14h'] }))?.motivo, 'horario_sem_comprovante', frase);
  }
  // o que já era informação continua sendo
  for (const frase of ['Tudo certo, quinta às 14h está disponível pra você', 'Tudo certo, vou ver os horários de quinta pra você', 'Quinta às 14h está disponível. Qual fica melhor?']) {
    assert.equal(afirmaHorarioGarantido(frase), false, frase);
  }
});

test('2ª rodada, item 5: "deixei anotado que você prefere quinta/amanhã…" é o que ELE disse, não horário garantido', () => {
  for (const frase of [
    'Deixei anotado que você prefere quinta à tarde. Vou ver os horários.',
    'Deixei anotado que você prefere amanhã de manhã.',
    'Anotado! Deixei registrado que você prefere quinta.',
    'Deixei anotado aqui que o melhor horário pra você é à tarde.',
  ]) {
    assert.equal(afirmaHorarioGarantido(frase), false, frase);
    assert.equal(travaDaTaxaDeReserva(frase, DADOS, com({ falasDoPaciente: ['quinta de tarde'] })), null, frase);
  }
  // quando o que vem depois do "que" é o horário dado como fechado, continua pegando
  assert.equal(afirmaHorarioGarantido('Deixei anotado que seu horário é quinta às 14h.'), true);
  assert.equal(afirmaHorarioGarantido('Deixei registrado que sua consulta está confirmada para amanhã.'), true);
});

test('2ª rodada, item 4: no horário sem comprovante o resto da resposta (o endereço) fica', () => {
  const r = travaDaTaxaDeReserva(`Fica na ${END}. Até já às 13h30!`, DADOS, com({ falasDoPaciente: ['qual o endereço?'] }));
  assert.equal(r?.motivo, 'horario_sem_comprovante');
  assert.equal(r?.preservouOResto, true);
  assert.match(r!.texto, new RegExp(`^Fica na ${END}\\.\n\nSó um detalhe importante: o seu horário ainda não está garantido`));
  assert.doesNotMatch(r!.texto, /Até já/);
  assert.match(r!.texto, /Chave Pix: 12\.345\.678\/0001-90/);
  // sem resto aproveitável, o recado inteiro de antes
  const sem = travaDaTaxaDeReserva('Perfeito! Até já às 13h30!', DADOS, com({ falasDoPaciente: ['ok'] }));
  assert.equal(sem?.texto, recadoSemComprovante(DADOS));
  assert.equal(sem?.preservouOResto, false);
});

test('2ª rodada, item 4: na insistência o resto da resposta (o endereço) fica, e o recado sai depois dele — com e sem a promessa da equipe', () => {
  const ctx = com({ falasDoPaciente: ['só pago na clínica', 'qual o endereço?'], respostaAnterior: recadoPagarNaClinica(DADOS) });
  const r = travaDaTaxaDeReserva(`Fica na ${END}. Tudo bem, entendo!`, DADOS, ctx);
  assert.equal(r?.motivo, 'insistiu_na_clinica');
  assert.equal(r?.preservouOResto, true);
  assert.match(r!.texto, new RegExp(`^Fica na ${END}\\. Tudo bem, entendo!\n\nAnotei que você prefere pagar na clínica e a equipe vai falar`));
  assert.equal(r?.resto, `Fica na ${END}. Tudo bem, entendo!`);
  assert.equal(recadoDaInsistencia(false, r!.resto!), `${r!.resto}\n\nEntendi que você prefere pagar na clínica. Só que, sem a taxa de agendamento, o horário não fica separado. Se quiser garantir, é só me avisar que eu te passo a chave Pix. 🙏`);
  // o que o modelo disse que contradiz (pode pagar na clínica) sai
  const contradiz = travaDaTaxaDeReserva(`Fica na ${END}. Pode pagar tudo na clínica, no dia.`, DADOS, ctx);
  assert.doesNotMatch(contradiz!.texto, /Pode pagar tudo/);
  assert.match(contradiz!.texto, new RegExp(`^Fica na ${END}\\.\n\nAnotei`));
  // sem resto, o recado inteiro (e idempotente: marca a conversa como tratada)
  assert.equal(travaDaTaxaDeReserva('Tudo bem!', DADOS, ctx)?.texto, RECADO_INSISTIU_NA_CLINICA);
  assert.equal(jaEncaminhouAInsistencia(r!.texto), true);
  assert.equal(jaEncaminhouAInsistencia(recadoDaInsistencia(false, r!.resto!)), true);
});

test('2ª rodada, item 6: depois que a insistência foi tratada, "pode pagar tudo na clínica" do modelo é trocado — sem a chave de novo e sem nova tarefa', () => {
  const ctx = com({ falasDoPaciente: ['então pago no dia, ok?'], respostaAnterior: RECADO_INSISTIU_NA_CLINICA, insistenciaJaEncaminhada: true });
  for (const resposta of ['Pode sim, você paga tudo na clínica no dia 😊', 'Pode sim! Você paga tudo na hora, sem problema.']) {
    const r = travaDaTaxaDeReserva(resposta, DADOS, ctx);
    assert.equal(r?.motivo, 'pagar_na_clinica', resposta);
    assert.doesNotMatch(r!.texto, /Pode sim|paga tudo/, resposta);
    assert.match(r!.texto, /só fica separado com a taxa de agendamento de R\$ 100/);
    assert.doesNotMatch(r!.texto, /Chave Pix:/);
    // o lembrete não dispara a trava de novo (o grafo reconfere a reescrita)
    assert.equal(travaDaTaxaDeReserva(r!.texto, DADOS, ctx), null, r!.texto);
    assert.match(aplicarGuardrail(r!.texto, unidade()).text, /./);
  }
  // a resposta que não contradiz continua passando direto (o ciclo não reabre)
  assert.equal(travaDaTaxaDeReserva('Tudo bem!', DADOS, ctx), null);
  // "o restante você paga na clínica" é verdade (a taxa é só a parte antecipada) e fica
  assert.equal(travaDaTaxaDeReserva('Isso, o restante você paga na clínica, no dia.', DADOS, ctx), null);
  // também com o recado SEM promessa na conversa
  assert.equal(travaDaTaxaDeReserva('Pode sim, você paga tudo na clínica no dia', DADOS, { ...ctx, respostaAnterior: RECADO_INSISTIU_SEM_PROMESSA })?.motivo, 'pagar_na_clinica');
});

test('2ª rodada, item 7: o recado sem promessa fecha o ciclo — a insistência seguinte não reenvia a chave', () => {
  let respostaAnterior = recadoPagarNaClinica(DADOS); // a chave foi uma vez
  const respostas = [respostaAnterior];
  const motivos: string[] = [];
  for (const fala of ['só na clínica', 'na clínica mesmo', 'pago na hora', 'já disse, pago no dia', 'só pago lá']) {
    const r = travaDaTaxaDeReserva('Tudo bem!', DADOS, com({ falasDoPaciente: [fala], respostaAnterior, insistenciaJaEncaminhada: insistenciaJaTratada(respostas) }));
    motivos.push(r?.motivo ?? 'null');
    // a saída da primeira insistência é a SEM promessa (a equipe não foi avisada)
    respostaAnterior = r ? recadoDaInsistencia(false) : 'Tudo bem!';
    respostas.push(respostaAnterior);
  }
  assert.deepEqual(motivos, ['insistiu_na_clinica', 'null', 'null', 'null', 'null']);
  assert.equal(respostas.filter((t) => t.includes('Chave Pix:')).length, 1);
});

test('2ª rodada, item 8: "Quanto à taxa, vou pagar na clínica mesmo" é recusa; "quanto pago no dia?" segue sendo pergunta', () => {
  for (const fala of ['Quanto à taxa, vou pagar na clínica mesmo.', 'Quanto a taxa, só pago na hora', 'Quanto ao pagamento, pago no dia']) {
    assert.equal(pacienteQuerPagarNaClinica([fala]), true, fala);
  }
  for (const fala of ['quanto pago no dia?', 'Quanto eu pago na clínica?']) {
    assert.equal(pacienteQuerPagarNaClinica([fala]), false, fala);
  }
  assert.equal(pacienteQuerPagarNaClinica(['Quero pagar tudo no dia, quanto fica?']), true);
});
