/**
 * Rede de código da taxa de reserva (Boa Vista, 19/11/2026): a resposta que pede nome/telefone na hora do horário, sem falar da taxa,
 * não sai como veio. As frases são as de produção (05/11 a 17/11).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { dadosDaTaxa, pedeDadosAntesDaTaxa, travaDaTaxaDeReserva, type ContextoDaTaxa } from './taxa-de-reserva.js';
import { decidirATaxa } from './taxa-de-reserva-saida.js';

const unidade = {
  category: 'saude',
  spineBookingRequiresPayment: true,
  pixKey: '49.485.277/0001-40',
  pixHolder: 'BENSAG FISIOTERAPIA LTDA',
  sourceProdutos: 'Consulta: R$ 100 antecipado (taxa de agendamento) ou R$ 250 no dia.',
  sourcePapel: null,
  sourceNegocio: null,
  systemPrompt: '',
} as unknown as Unit;
const DADOS = dadosDaTaxa(unidade)!;
const CTX: ContextoDaTaxa = {
  falasDoPaciente: ['pode ser as 9 então'],
  consultaDePe: false,
  emTratamento: false,
  respostaAnterior: 'Consegui dois horários na quarta: 09:00 e 11:00. Qual fica melhor pra você? 😊',
  comprovanteLido: false,
  jaMandouComprovante: false,
  insistenciaJaEncaminhada: false,
};

const ERROS_DE_PRODUCAO = [
  'Perfeito, terça-feira (17/11) às 16h! 😊 Pra eu deixar seu cadastro pronto, me confirma seu nome completo, por favor?',
  'Perfeito, 11h fica ótimo! 😊 Pra eu deixar reservado: pode me confirmar o nome completo do seu filho e um telefone com DDD pra contato?',
  'Perfeito, 08:00 de amanhã, sexta (13/11)! Pra eu já deixar seu agendamento certo, me confirma um telefone com DDD (pode ser esse mesmo que você está usando aqui)?',
  'Perfeito, 09:00 de quarta fica ótimo! Pra eu deixar sua vaga garantida, me passa seu nome completo e um telefone com DDD',
];

test('pede nome/telefone com horário em jogo e sem falar da taxa: a resposta é trocada pelo pedido da taxa com a chave', () => {
  for (const texto of ERROS_DE_PRODUCAO) {
    assert.equal(pedeDadosAntesDaTaxa(texto, CTX.respostaAnterior), true, texto);
    const troca = travaDaTaxaDeReserva(texto, DADOS, CTX);
    // a frase com «vaga garantida» já era pega pelo detector de horário garantido; as outras, só pela rede nova
    assert.ok(troca?.motivo === 'dados_antes_da_taxa' || troca?.motivo === 'horario_sem_comprovante', `${troca?.motivo}: ${texto}`);
    assert.match(troca!.texto, /49\.485\.277\/0001-40/);
    assert.match(troca!.texto, /comprovante/);
    assert.match(troca!.texto, /R\$ 100/);
    assert.doesNotMatch(troca!.texto, /nome completo|telefone com DDD/i);
  }
});

test('o que NÃO é o erro: primeiro contato, resposta que já fala da taxa, pergunta de nome sem horário', () => {
  // sem horário em jogo (nem na resposta nem na anterior)
  assert.equal(pedeDadosAntesDaTaxa('Oi! Aqui é a Sofia. Qual o seu nome completo?', 'Olá!'), false);
  // "como posso te chamar" é o nome de tratamento do primeiro contato
  assert.equal(pedeDadosAntesDaTaxa('Perfeito, quarta às 9h! Como posso te chamar?', ''), false);
  // já fala da taxa/Pix/comprovante: o pedido de dados vem junto do que importa
  assert.equal(
    pedeDadosAntesDaTaxa('Pra garantir esse horário, a taxa de agendamento é R$ 100 por Pix (chave 49.485.277/0001-40). Me manda o comprovante e seu nome completo?', ''),
    false,
  );
  assert.equal(travaDaTaxaDeReserva('Pra garantir quarta às 9h, a taxa é R$ 100 por Pix. Me manda o comprovante e seu nome completo?', DADOS, CTX), null);
});

test('depois do comprovante, com consulta de pé ou cartão pago: pedir o nome é o certo e a trava não mexe', async () => {
  const texto = ERROS_DE_PRODUCAO[0];
  assert.equal(travaDaTaxaDeReserva(texto, DADOS, { ...CTX, comprovanteLido: true }), null);
  assert.equal(travaDaTaxaDeReserva(texto, DADOS, { ...CTX, consultaDePe: true }), null);
  // comprovante antigo (qualquer data): nada é pedido por conta da Sofia
  assert.equal(travaDaTaxaDeReserva(texto, DADOS, { ...CTX, jaMandouComprovante: true }), null);
  // cartão com «✓ Consulta pg antecipado»: quem já pagou não recebe a taxa de novo
  const d = await decidirATaxa(texto, DADOS, CTX, { consultaGravada: async () => false, cartaoDizPago: async () => true });
  assert.equal(d.troca, null);
  assert.equal(d.liberadaPor, 'cartao_pago');
  // e sem prova de pagamento a troca vale
  const sem = await decidirATaxa(texto, DADOS, CTX, { consultaGravada: async () => false, cartaoDizPago: async () => false });
  assert.equal(sem.troca?.motivo, 'dados_antes_da_taxa');
});

test('o resto útil da resposta fica: o endereço que ele também perguntou', () => {
  const texto = 'Ficamos na Av. Ville Roy, 4301, no Canarinho. Quarta às 9h, certo? Me confirma seu nome completo?';
  const troca = travaDaTaxaDeReserva(texto, DADOS, CTX);
  assert.equal(troca?.motivo, 'dados_antes_da_taxa');
  assert.match(troca!.texto, /Ville Roy/);
  assert.match(troca!.texto, /49\.485\.277\/0001-40/);
  assert.doesNotMatch(troca!.texto, /nome completo/);
});
