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
    assert.equal(pedeDadosAntesDaTaxa(texto, CTX), true, texto);
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
  assert.equal(pedeDadosAntesDaTaxa('Oi! Aqui é a Sofia. Qual o seu nome completo?', { falasDoPaciente: ['quero marcar sexta'], respostaAnterior: 'Olá!' }), false);
  // "como posso te chamar" é o nome de tratamento do primeiro contato
  assert.equal(pedeDadosAntesDaTaxa('Perfeito, quarta às 9h! Como posso te chamar?', CTX), false);
  // já fala da taxa/Pix/comprovante: o pedido de dados vem junto do que importa
  assert.equal(
    pedeDadosAntesDaTaxa('Pra garantir esse horário, a taxa de agendamento é R$ 100 por Pix (chave 49.485.277/0001-40). Me manda o comprovante e seu nome completo?', CTX),
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

test('só vale com a ESCOLHA do horário: pergunta de preço depois da oferta, pedido no primeiro contato e chave já enviada não trocam', () => {
  // ofereceu horários e ele pergunta o preço: "me passa seu nome completo" não é resposta a uma escolha
  assert.equal(
    travaDaTaxaDeReserva('Pode me passar seu nome completo?', DADOS, { ...CTX, falasDoPaciente: ['quanto custa a consulta?'] }),
    null,
  );
  // primeiro contato com um dia, sem proposta de horário antes
  assert.equal(
    travaDaTaxaDeReserva('Claro! Qual o seu nome completo?', DADOS, { ...CTX, falasDoPaciente: ['quero marcar sexta'], respostaAnterior: 'Olá! Aqui é a Sofia.' }),
    null,
  );
  // a chave já foi enviada: o bloco da taxa não se repete a cada turno
  assert.equal(
    travaDaTaxaDeReserva('Ótimo! Pra terça às 16h, me confirma seu nome completo?', DADOS, { ...CTX, respostaAnterior: 'A chave é 49.485.277/0001-40. Me manda o comprovante?' }),
    null,
  );
});

test('o pedido é reconhecido por verbo: «preciso do seu nome» pega; «posso te ligar no seu telefone» e «vou anotar o nome dele» não', () => {
  assert.equal(pedeDadosAntesDaTaxa('Pra eu garantir esse horário, preciso do seu nome, pode me passar?', CTX), true);
  assert.equal(pedeDadosAntesDaTaxa('Me passa o seu telefone, por favor?', CTX), true);
  assert.equal(pedeDadosAntesDaTaxa('Certo, quarta às 9h! Se precisar posso te ligar no seu telefone.', CTX), false);
  assert.equal(pedeDadosAntesDaTaxa('Certo, quarta às 9h! Vou anotar o nome dele.', CTX), false);
});

// --- Os falsos positivos que o sênior apontou (rodada 2): a rede só vale com ESCOLHA de uma hora oferecida ----------------------------

const ofertaDeHorarios = 'Tenho quarta às 09:00 ou às 11:00. Qual fica melhor pra você? 😊';
const ctx = (fala: string, respostaAnterior = ofertaDeHorarios): ContextoDaTaxa => ({ ...CTX, falasDoPaciente: [fala], respostaAnterior });
const PEDE_NOME = 'Claro! Me passa seu nome completo, por favor?';

test('«hoje» não é oferta e «quero» não é aceite: «Como posso te ajudar hoje?» -> «quero marcar consulta» não vira pedido de taxa', () => {
  assert.equal(pedeDadosAntesDaTaxa(PEDE_NOME, ctx('quero marcar consulta', 'Como posso te ajudar hoje? 😊')), false);
  assert.equal(travaDaTaxaDeReserva(PEDE_NOME, DADOS, ctx('quero marcar consulta', 'Como posso te ajudar hoje? 😊')), null);
  // nem com uma oferta de hora de verdade: «quero» não é aceite
  assert.equal(pedeDadosAntesDaTaxa(PEDE_NOME, ctx('quero')), false);
});

test('recusa ou pedido de outro horário não é escolha', () => {
  assert.equal(pedeDadosAntesDaTaxa(PEDE_NOME, ctx('não consigo nesses, só depois das 18h')), false);
  assert.equal(pedeDadosAntesDaTaxa(PEDE_NOME, ctx('quinta não dá, tem sábado?')), false);
  assert.equal(pedeDadosAntesDaTaxa(PEDE_NOME, ctx('às 9 não dá, pode ser outro horário?')), false);
  assert.equal(pedeDadosAntesDaTaxa(PEDE_NOME, ctx('às 9 não consigo')), false);
});

test('número solto não é hora: «sinto dor a 3 meses» depois de uma oferta', () => {
  assert.equal(pedeDadosAntesDaTaxa(PEDE_NOME, ctx('sinto dor a 3 meses')), false);
  assert.equal(pedeDadosAntesDaTaxa(PEDE_NOME, ctx('sinto dor a 3 meses', 'Tenho quarta às 3h ou às 11:00.')), false);
  assert.equal(pedeDadosAntesDaTaxa(PEDE_NOME, ctx('faz 11 meses que sinto dor')), false);
});

test('o paciente cita a hora oferecida (de várias formas) ou aceita a ÚNICA proposta com uma palavra', () => {
  for (const fala of ['9h', 'as 9', 'às 9', 'pode ser 09:00', '11 horas', 'as 11h então', 'Sexta às 9::00', 'pras 11']) {
    assert.equal(pedeDadosAntesDaTaxa(PEDE_NOME, ctx(fala)), true, fala);
  }
  const uma = 'Consegui quarta às 09:00. Fica bom pra você?';
  for (const fala of ['sim', 'Ok!', 'pode ser', 'Combinado 👍', 'fechado', 'Pode sim']) {
    assert.equal(pedeDadosAntesDaTaxa(PEDE_NOME, ctx(fala, uma)), true, fala);
  }
  // aceite a DUAS opções não diz qual; aceite com mais coisa na fala ou hora que não foi oferecida também não
  assert.equal(pedeDadosAntesDaTaxa(PEDE_NOME, ctx('ok')), false);
  assert.equal(pedeDadosAntesDaTaxa(PEDE_NOME, ctx('sim, mas só às 18h', uma)), false);
  assert.equal(pedeDadosAntesDaTaxa(PEDE_NOME, ctx('às 15h', uma)), false);
});

test('CPF e «um telefone» só contam com verbo de pedido', () => {
  assert.equal(pedeDadosAntesDaTaxa('Perfeito, quarta às 9h! Na chegada, leve um documento com CPF.', ctx('9h')), false);
  assert.equal(pedeDadosAntesDaTaxa('Perfeito, quarta às 9h! Tem um telefone fixo na recepção se precisar.', ctx('9h')), false);
  assert.equal(pedeDadosAntesDaTaxa('Perfeito, quarta às 9h! Me passa seu CPF?', ctx('9h')), true);
  assert.equal(pedeDadosAntesDaTaxa('Perfeito, quarta às 9h! Pode me passar um telefone pra contato?', ctx('9h')), true);
});

test('resposta que é só o pedido de nome: sai o pedido da taxa em texto neutro, sem «o seu horário ainda não está garantido»', () => {
  const troca = travaDaTaxaDeReserva('Ótimo! Me confirma seu nome completo?', DADOS, ctx('9h'));
  assert.equal(troca?.motivo, 'dados_antes_da_taxa');
  assert.match(troca!.texto, /49\.485\.277\/0001-40/);
  assert.match(troca!.texto, /taxa de agendamento de R\$ 100/);
  assert.doesNotMatch(troca!.texto, /ainda não está garantido|Só um detalhe importante/);
});
