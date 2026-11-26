/**
 * Salto, lead 5032777, 25/11/2026 11:43 UTC: a Sofia perguntou "o senhor confirma quinta 26/11 às 15h00?" e o paciente respondeu
 * "Te confirmo na parte da tarde." O modelo chamou agendar_consulta com diaConfirmado=true e mandou "✅ Agendamento confirmado".
 * A ferramenta recusa quando a fala dele neste turno ADIA a confirmação — atrás da chave `confirmacao-adiada` (nasce desligada).
 *
 * A 1ª versão (#469) foi reprovada pelo sênior: travava quem tinha confirmado (Canaã 24/10 "Sim vou confirmar pagamento dia 29 ou 30"
 * e 15 de 20 sondas). Aqui cada falha dele virou teste de "não adia".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import { adiouConfirmacao, confirmacaoAdiadaEstado, textoDaRecusaAdiada, travarAgendamentoAdiado, type TurnoDaConfirmacao } from './confirmacao-adiada.js';
import type { Estado } from '../lib/automacoes-estado.js';

test('o caso de Salto: "Te confirmo na parte da tarde." adia', () => {
  assert.ok(adiouConfirmacao('Te confirmo na parte da tarde.'));
  assert.ok(adiouConfirmacao('15:00\nMaria da Silva\nQual o valor?\nTe confirmo na parte da tarde.'));
});

test('os exemplos do pedido adiam', () => {
  for (const fala of [
    'te confirmo mais tarde',
    'Te confirmo depois',
    'te confirmo amanhã',
    'Te confirmo à noite',
    'Vou confirmar mais tarde',
    'Te confirmo depois que eu falar com meu marido',
    'Vou confirmar depois de ver a agenda',
    'Te confirmo depois do almoço',
    'vou confirmar depois com meu marido',
    'Vou confirmar com meu marido',
    'depois te falo',
    'Depois te confirmo!',
    'depois eu confirmo',
    'vou ver e te aviso',
    'Vou ver aqui',
    'Vou ver com meu marido e te aviso',
    'Deixa eu ver com a minha filha',
    'Deixa eu ver minha agenda',
    'Posso confirmar mais tarde?',
    'Mais tarde te aviso, tá?',
    'Daqui a pouco te respondo',
    'Amanhã eu retorno',
    'me dá um tempo',
    'Me dá um tempinho que eu te falo',
    '15:00\nTe confirmo na parte da tarde.',
    'Vou ver com meu marido\nMaria da Silva',
  ]) {
    assert.ok(adiouConfirmacao(fala), fala);
  }
});

test('Canaã 24/10 e as sondas do sênior: quem CONFIRMA não é travado', () => {
  for (const fala of [
    'Sim vou confirmar pagamento dia 29 ou 30', // real, Canaã 24/10
    'Só posso ir na parte da tarde\nSim\nConfirmar',
    'Pode ser à tarde\nConfirmar',
    'Sim, quinta 15h. Vou ver com meu chefe pra sair mais cedo',
    'Deixa eu ver... pode ser quinta às 15h sim',
    'Sim! Vamos ver se a doutora me ajuda 🙏',
    'Confirmado! Vou ver o caminho no mapa',
    'Fechado! Vou falar com meu marido pra me levar',
    'Ok, vou ver vocês quinta então',
    'Sim, quinta 15h. Preciso confirmar o endereço?',
    'Pode ser, confirmo. Depois te falo se vou de carro',
    'Sim, pode ser às 15h. Te respondo amanhã sobre o convênio',
    'Combinado, quinta 15h! Amanhã te aviso se meu filho vai junto',
    'Ótimo, marca pra mim quinta 15h. Vou ver se levo os exames',
    'Sim. Tenho que ver o horário do ônibus mas eu vou',
    'Sim, confirmo. Vou confirmar o Pix daqui a pouco',
    'Confirmo! Te mando o comprovante mais tarde',
    'Sim confirmo',
    'Confirmo sim',
    'Pode marcar, vou ver o pagamento depois',
    'Paguei, segue o comprovante. Depois te falo o nome do meu marido',
    'Te confirmo amanhã às 15h então',
    'Te confirmo amanhã 15h',
    'Te confirmo amanhã às 8 da manhã',
    'Te confirmo amanhã às 15',
    'Te confirmo amanhã 3 da tarde',
    'Vou ver com meu marido\n…\nConfirmado!',
    'Vou ver com meu marido e te aviso\nSim, pode marcar',
  ]) {
    assert.equal(adiouConfirmacao(fala), null, fala);
  }
});

test('"vou confirmar" sem um quando não adia; nem "confirmar" + pagamento, Pix, sinal, comprovante ou endereço', () => {
  for (const fala of [
    'Vou confirmar',
    'Preciso confirmar o Pix',
    'Vamos confirmar o sinal agora',
    'Vou confirmar o pagamento',
    'Vou confirmar o comprovante',
    'Vou confirmar o endereço',
    'Vou confirmar com vocês o endereço',
    'Pode confirmar?',
  ]) {
    assert.equal(adiouConfirmacao(fala), null, fala);
  }
});

test('o que já passava no #469 continua passando: confirmação sozinha, escolha de horário e áudio sem texto', () => {
  for (const fala of [
    'Confirmo',
    'Confirmado',
    'Sim,confirmado',
    'Pode confirmar!',
    'Pode confirmar a consulta para amanhã Maria da Silva',
    'Pode marcar',
    'Sim',
    '15:00',
    'Pode ser as 8h',
    'Minha esposa, sim, confirmar pra este horário',
    'Segunda pode ser às 4',
    'Confirmo na quinta às 15h',
    'Confirmo amanhã às 15h',
    'Confirmo na semana que vem',
    'Pode ser 15h. Vou ver o endereço no mapa',
    'Preciso ver o valor do Pix depois, mas pode marcar',
    'Fechado, pode agendar',
    'Combinado, quinta às 15h',
    'Confirma o endereço por favor',
    'Eu posso fazer o Pix amanhã cedo no primeiro horário?',
    'Não tem k pagar nada né amanhã',
    '[áudio do cliente — não deu pra ouvir]',
    '',
  ]) {
    assert.equal(adiouConfirmacao(fala), null, fala);
  }
  assert.equal(adiouConfirmacao(null), null);
  assert.equal(adiouConfirmacao(undefined), null);
});

test('uma mensagem por vez: o adiamento não atravessa a quebra de linha, e vale a última decisão', () => {
  assert.equal(adiouConfirmacao('Te confirmo\nmais tarde'), null);
  // adiou e depois confirmou: marca; confirmou e depois adiou: não marca
  assert.equal(adiouConfirmacao('Depois te confirmo\nPode ser quinta 15h, confirmado'), null);
  assert.ok(adiouConfirmacao('Sim\nMas te confirmo mais tarde'));
});

function agendarQueMarca(chamadas: unknown[]) {
  return new DynamicStructuredTool({
    name: 'agendar_consulta',
    description: 'teste',
    schema: z.object({ hora: z.string(), diaConfirmado: z.boolean().optional(), remarcando: z.boolean().optional() }),
    func: async (args) => {
      chamadas.push(args);
      return 'Consulta marcada para quinta, 26/11, às 15:00.';
    },
  });
}

test('chave LIGADA: recusa com mensagem ao modelo quando o paciente adiou, e não chega na franquia', async () => {
  const chamadas: unknown[] = [];
  const passos: Array<{ kind: string; title: string }> = [];
  const turno: TurnoDaConfirmacao = { adiou: adiouConfirmacao('Te confirmo na parte da tarde.') };
  const [tool] = travarAgendamentoAdiado([agendarQueMarca(chamadas)], turno, { step: async (p: never) => void passos.push(p) } as never, () => 'ligado');
  const r = String(await tool.func({ hora: '15:00', diaConfirmado: true } as never));
  assert.match(r, /^Consulta NÃO marcada/);
  assert.match(r, /NÃO diga que está confirmado/);
  assert.equal(r, textoDaRecusaAdiada('Te confirmo na parte da tarde'));
  assert.deepEqual(chamadas, [], 'nada foi marcado');
  assert.equal(passos.length, 1);
  assert.equal(passos[0].kind, 'ERROR');
  assert.match(passos[0].title, /adiou a confirmação/);
  // `remarcando` escrito pelo modelo não abre a porta
  await tool.func({ hora: '15:00', diaConfirmado: true, remarcando: true } as never);
  assert.deepEqual(chamadas, []);
});

test('chave em SECO: marca como sempre e só registra que teria recusado (o portão do seco cobre o caminho novo)', async () => {
  const chamadas: unknown[] = [];
  const passos: Array<{ kind: string; title: string }> = [];
  const turno: TurnoDaConfirmacao = { adiou: 'Te confirmo na parte da tarde' };
  const [tool] = travarAgendamentoAdiado([agendarQueMarca(chamadas)], turno, { step: async (p: never) => void passos.push(p) } as never, () => 'seco');
  assert.match(String(await tool.func({ hora: '15:00', diaConfirmado: true } as never)), /^Consulta marcada/);
  assert.equal(chamadas.length, 1, 'em seco a consulta É marcada');
  assert.equal(passos.length, 1);
  assert.equal(passos[0].kind, 'THINKING');
  assert.match(passos[0].title, /teria recusado/);
});

test('chave DESLIGADA: nem registra, nem recusa', async () => {
  const chamadas: unknown[] = [];
  const passos: unknown[] = [];
  const turno: TurnoDaConfirmacao = { adiou: 'vou confirmar mais tarde' };
  const [tool] = travarAgendamentoAdiado([agendarQueMarca(chamadas)], turno, { step: async (p: never) => void passos.push(p) } as never, () => 'desligado');
  assert.match(String(await tool.func({ hora: '15:00', diaConfirmado: true } as never)), /^Consulta marcada/);
  assert.equal(chamadas.length, 1);
  assert.deepEqual(passos, []);
});

test('sem adiamento a ferramenta marca em qualquer estado; o estado e o turno são relidos a cada chamada', async () => {
  const chamadas: unknown[] = [];
  const turno: TurnoDaConfirmacao = { adiou: null };
  let estado: Estado = 'ligado';
  const [tool] = travarAgendamentoAdiado([agendarQueMarca(chamadas)], turno, { step: async () => undefined } as never, () => estado);
  assert.match(String(await tool.func({ hora: '15:00', diaConfirmado: true } as never)), /^Consulta marcada/);
  assert.equal(chamadas.length, 1);
  turno.adiou = 'vou confirmar mais tarde';
  assert.match(String(await tool.func({ hora: '15:00', diaConfirmado: true } as never)), /^Consulta NÃO marcada/);
  assert.equal(chamadas.length, 1);
  estado = 'desligado'; // desligou na tela: vale na chamada seguinte
  assert.match(String(await tool.func({ hora: '15:00', diaConfirmado: true } as never)), /^Consulta marcada/);
  assert.equal(chamadas.length, 2);
});

test('só mexe em agendar_consulta', () => {
  const outra = new DynamicStructuredTool({ name: 'consultar_horarios', description: 't', schema: z.object({}), func: async () => 'ok' });
  const antes = outra.func;
  travarAgendamentoAdiado([outra], { adiou: 'vou confirmar mais tarde' }, { step: async () => undefined } as never, () => 'ligado');
  assert.equal(outra.func, antes);
});

test('a chave nasce DESLIGADA: sem variável nem linha no banco, nada muda para ninguém', () => {
  assert.equal(confirmacaoAdiadaEstado('doutor-hernia-salto', ''), 'desligado');
  assert.equal(confirmacaoAdiadaEstado('doutor-hernia-salto', 'doutor-hernia-outra'), 'desligado');
  assert.equal(confirmacaoAdiadaEstado('doutor-hernia-salto', 'doutor-hernia-salto'), 'ligado');
});
