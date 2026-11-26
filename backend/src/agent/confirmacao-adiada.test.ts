/**
 * Salto, lead 5032777, 25/11/2026 11:43 UTC: a Sofia perguntou "o senhor confirma quinta 26/11 às 15h00?" e o paciente respondeu
 * "Te confirmo na parte da tarde." O modelo chamou agendar_consulta com diaConfirmado=true e mandou "✅ Agendamento confirmado".
 * A ferramenta agora recusa quando a fala dele neste turno ADIA a confirmação.
 *
 * Medido em 30 dias na rede (142 consultas marcadas, TOOL_RESULT "Consulta marcada"): 1 tinha o adiamento como última fala (esta).
 * Varredura de 169.441 falas de pacientes em 90 dias: 1.137 casam (0,67 %), quase todas "vou ver…/vou falar com…" — aí nenhuma
 * marcação devia sair mesmo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import { adiouConfirmacao, textoDaRecusaAdiada, travarAgendamentoAdiado, type TurnoDaConfirmacao } from './confirmacao-adiada.js';

test('o caso de Salto: "Te confirmo na parte da tarde." adia', () => {
  assert.ok(adiouConfirmacao('Te confirmo na parte da tarde.'));
});

test('os exemplos do pedido adiam', () => {
  for (const fala of [
    'te confirmo mais tarde',
    'Te confirmo depois',
    'te confirmo amanhã',
    'Vou confirmar',
    'vou confirmar com meu marido e te falo',
    'depois te falo',
    'Depois te confirmo!',
    'depois eu confirmo',
    'vou ver e te aviso',
    'Vou ver aqui',
    'Deixa eu ver com a minha filha',
    'Posso confirmar mais tarde?',
    'Mais tarde te aviso, tá?',
    'Daqui a pouco te respondo',
    'Amanhã eu retorno',
    'me dá um tempo',
    '15:00\nTe confirmo na parte da tarde.',
    'Combinado, te confirmo na parte da tarde',
    'Ok, fechado. Te aviso amanhã',
  ]) {
    assert.ok(adiouConfirmacao(fala), fala);
  }
});

test('"confirmo" sozinho, "pode confirmar" e as respostas reais de quem marcou NÃO são adiamento', () => {
  for (const fala of [
    'Confirmo',
    'Confirmo sim',
    'Confirmado',
    'Sim,confirmado',
    'Pode confirmar!',
    'Pode confirmar a consulta para amanhã Maria da Silva',
    'Pode marcar',
    'Sim',
    'Sim sim',
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
    'Confirma o endereço por favor',
    'tá confirmado o agendamento',
    'Eu posso fazer o Pix amanhã cedo no primeiro horário?',
    'Somente amanha na segunda-feira PIX',
    'Não tem k pagar nada né amanhã',
    'Vou para no dia',
    'Pode confirmar vou paga na clínica no dia 06/11/26 , ok .',
    'Pode marcar, vou ver o pagamento depois',
    '[áudio do cliente — não deu pra ouvir]',
    '',
  ]) {
    assert.equal(adiouConfirmacao(fala), null, fala);
  }
  assert.equal(adiouConfirmacao(null), null);
  assert.equal(adiouConfirmacao(undefined), null);
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

test('agendar_consulta recusa com mensagem ao modelo quando o paciente adiou, e não chega na franquia', async () => {
  const chamadas: unknown[] = [];
  const passos: Array<{ kind: string; title: string }> = [];
  const turno: TurnoDaConfirmacao = { adiou: adiouConfirmacao('Te confirmo na parte da tarde.') };
  const [tool] = travarAgendamentoAdiado([agendarQueMarca(chamadas)], turno, { step: async (p: never) => void passos.push(p) } as never);
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

test('sem adiamento a ferramenta marca como sempre; o estado do turno é relido a cada chamada', async () => {
  const chamadas: unknown[] = [];
  const turno: TurnoDaConfirmacao = { adiou: null };
  const [tool] = travarAgendamentoAdiado([agendarQueMarca(chamadas)], turno, { step: async () => undefined } as never);
  assert.match(String(await tool.func({ hora: '15:00', diaConfirmado: true } as never)), /^Consulta marcada/);
  assert.equal(chamadas.length, 1);
  turno.adiou = 'vou confirmar';
  assert.match(String(await tool.func({ hora: '15:00', diaConfirmado: true } as never)), /^Consulta NÃO marcada/);
  assert.equal(chamadas.length, 1);
  turno.adiou = null; // ele voltou e confirmou: no turno seguinte a ferramenta marca
  assert.match(String(await tool.func({ hora: '15:00', diaConfirmado: true } as never)), /^Consulta marcada/);
  assert.equal(chamadas.length, 2);
});

test('só mexe em agendar_consulta', () => {
  const outra = new DynamicStructuredTool({ name: 'consultar_horarios', description: 't', schema: z.object({}), func: async () => 'ok' });
  const antes = outra.func;
  travarAgendamentoAdiado([outra], { adiou: 'vou confirmar' }, { step: async () => undefined } as never);
  assert.equal(outra.func, antes);
});
