import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import {
  afirmaHorarioGarantido,
  dadosDaTaxa,
  empurrouAChaveParaEquipe,
  pacientePediuAChave,
  recadoDaChave,
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
const SEM_PROVA: ContextoDaTaxa = { falasDoPaciente: [], consultaDePe: false, comprovanteLido: false };
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
  for (const fala of ['E o pix', 'Mande o pix por gentileza', 'qual a chave?', 'me manda a chave pix', 'pode me passar o pix', 'cadê o pix', 'pix', 'Quero pagar no pix', 'chave pfv']) {
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

test('A: com consulta de pé no CRM ou com comprovante lido a chave não é refeita', () => {
  const ctx = { falasDoPaciente: ['E o pix'] };
  assert.equal(travaDaTaxaDeReserva(SOFIA_27_10_PIX, DADOS, com({ ...ctx, consultaDePe: true })), null);
  assert.equal(travaDaTaxaDeReserva(SOFIA_27_10_PIX, DADOS, com({ ...ctx, comprovanteLido: true })), null);
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
  for (const recado of [recadoDaChave(DADOS), recadoSemComprovante(DADOS)]) {
    assert.equal(afirmaConfirmacao(recado), null, recado);
    assert.equal(afirmaConfirmacao(recado, { estrito: true }), null, recado);
    assert.equal(afirmaHorarioGarantido(recado), false, recado);
    assert.equal(reservaSemMarcar(recado, { marcouAgora: false }), null, recado);
    assert.equal(afirmouComConsultaDesmarcada(recado, { marcouAgora: false, bloco: 'foi DESMARCADA no sistema da clínica', promessa: null }), null, recado);
    assert.equal(empurrouAChaveParaEquipe(recado), false, recado);
    assert.equal(detectarVazamento(recado), null, recado);
    assert.equal(semDiminutivo(recado), recado);
    assert.equal(semIntimidade(recado), recado);
    const g = aplicarGuardrail(recado, unidade());
    assert.deepEqual(g.triggered, [], recado);
    assert.equal(g.text, recado);
  }
});

test('o recado nunca traz lacuna nem dado fora do cadastro', () => {
  for (const recado of [recadoDaChave(DADOS), recadoSemComprovante(DADOS)]) {
    assert.doesNotMatch(recado, /\[|\]|XXX/);
    assert.deepEqual([...recado.matchAll(/R\$\s*[\d.,]+/g)].map((m) => m[0]), ['R$ 100']);
  }
  const semTitular = recadoDaChave({ ...DADOS, titular: null });
  assert.doesNotMatch(semTitular, /Titular/);
});
