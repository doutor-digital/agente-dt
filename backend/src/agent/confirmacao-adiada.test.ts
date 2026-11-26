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

// ── Rodada do sênior depois do #481 (o detector precisava de ajuste ANTES de ligar) ─────────────────────────────────────────────────

test('"não confirmo", "pode ser?" e o "te confirmo" que sobra NÃO contam como sim', () => {
  for (const fala of [
    'Vou ver e te confirmo',
    'Vou ver com meu marido, não confirmo agora',
    'Pode ser? Vou ver com meu marido e te aviso',
    'Vou ver aqui e depois te confirmo o nome',
    'Beleza, te confirmo mais tarde',
    'Ótimo, te confirmo depois',
    'Combinado, te confirmo na parte da tarde',
  ]) {
    assert.ok(adiouConfirmacao(fala), fala);
  }
});

test('"Te confirmo depois se der" adia; o "se" de detalhe continua sendo detalhe', () => {
  assert.ok(adiouConfirmacao('Te confirmo depois se der'));
  assert.ok(adiouConfirmacao('Te confirmo mais tarde se eu puder'));
  assert.equal(adiouConfirmacao('Sim, pode ser. Depois te aviso se precisar remarcar'), null);
  assert.equal(adiouConfirmacao('Quinta 15h tá ótimo. Amanhã te aviso se meu filho vai junto'), null);
});

test('vírgula antes da hora: "Te confirmo amanhã, às 15h" é escolha de horário', () => {
  for (const fala of ['Te confirmo amanhã, às 15h', 'Te confirmo amanhã, 15h', 'Te confirmo amanhã , às 8 da manhã']) {
    assert.equal(adiouConfirmacao(fala), null, fala);
  }
  assert.ok(adiouConfirmacao('Te confirmo amanhã, depois te falo'));
});

test('um aceite com dia ou hora numa mensagem anterior vence o "vou ver" que vem depois; um "sim" solto não', () => {
  for (const fala of [
    'Sim, quinta 15h\nVou ver com meu chefe pra sair mais cedo',
    'Sim, quinta 15h\nVou ver com meu chefe\nDepois te aviso',
    'Quinta 15h tá ótimo\nVou ver aqui com meu chefe',
    'Uhum, pode ser quinta\nDepois te aviso se precisar remarcar',
    'Ok 👍 quinta 15h\nVou ver aqui no trabalho e já chego',
  ]) {
    assert.equal(adiouConfirmacao(fala), null, fala);
  }
  assert.ok(adiouConfirmacao('Sim\nMas te confirmo mais tarde'));
  assert.ok(adiouConfirmacao('15:00\nMaria da Silva\nVou ver com meu marido e te aviso'));
  assert.ok(adiouConfirmacao('Quinta 15h\nTe confirmo na parte da tarde'));
});

test('sondas novas do sênior: aceite sem "sim/confirmo/pode ser" + "vou ver…" ou "depois te retorno…" NÃO adia', () => {
  for (const fala of [
    'Beleza! Te aviso quando chegar aí',
    'Ok, combinado, quinta às 15h. Qualquer coisa depois te chamo',
    'Tá bom, quinta 15h. Vou olhar aqui como faço com as crianças',
    'Show, quinta 15h. Vou checar a rota',
    'Pode deixar, quinta estarei aí. Vou ver com meu marido quem me leva',
    'Perfeito, quinta 15h então. Depois te retorno com o nome completo',
    'Isso, 15h. Te falo amanhã o nome da minha mãe',
    'Ok 👍 quinta 15h. Vou ver aqui no trabalho e já chego',
    'Quinta 15h tá ótimo\nVou ver aqui com meu chefe',
    'Uhum, pode ser quinta\nDepois te aviso se precisar remarcar',
    'Quero quinta 15h. Depois a gente se fala',
    'Certo! Amanhã de manhã te confirmo o endereço que vou sair',
    'Bora, quinta 15h. Mais tarde te mando meus documentos',
    'Isso mesmo, quinta 15h. Vou ver o que levo de exame',
  ]) {
    assert.equal(adiouConfirmacao(fala), null, fala);
  }
  // e o que o sênior mandou travar continua travando
  for (const fala of [
    'Ok, vou ver aqui e te retorno',
    'Mais tarde te confirmo',
    'Amanhã te falo',
    'Vou conferir minha agenda e te aviso',
    'Preciso ver com meu chefe primeiro',
    'Ok, vou ver isso depois',
    // aceite no começo + "vou ver…" SEM dia nem hora: a decisão de ver vence (3ª rodada do sênior, #490)
    'Ótimo! Vou ver se consigo chegar mais cedo',
    'Tudo certo! Preciso ver se tenho exames, mas eu vou',
  ]) {
    assert.ok(adiouConfirmacao(fala), fala);
  }
});

test('seco: a marcação começa ANTES do registro; gravador lento ou que falha não atrasa nem derruba a consulta', async () => {
  const ordem: string[] = [];
  const tool = new DynamicStructuredTool({
    name: 'agendar_consulta',
    description: 't',
    schema: z.object({ hora: z.string() }),
    func: async () => {
      ordem.push('marcou-inicio');
      return 'Consulta marcada';
    },
  });
  let soltar!: () => void;
  const lento = new Promise<void>((r) => (soltar = r));
  const [t] = travarAgendamentoAdiado(
    [tool],
    { adiou: 'vou confirmar mais tarde' },
    { step: async () => { ordem.push('step-inicio'); await lento; ordem.push('step-fim'); } } as never,
    () => 'seco',
  );
  const promessa = t.func({ hora: '15:00' } as never);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ordem.slice(0, 2), ['marcou-inicio', 'step-inicio'], 'o original é chamado antes do step');
  soltar();
  assert.equal(await promessa, 'Consulta marcada');

  const [falha] = travarAgendamentoAdiado(
    [new DynamicStructuredTool({ name: 'agendar_consulta', description: 't', schema: z.object({ hora: z.string() }), func: async () => 'Consulta marcada' })],
    { adiou: 'vou confirmar mais tarde' },
    { step: async () => { throw new Error('banco fora'); } } as never,
    () => 'seco',
  );
  assert.equal(await falha.func({ hora: '15:00' } as never), 'Consulta marcada');
});

// ── 3ª rodada do sênior (#490): a camada de afirmação abriu buraco para adiamento real ───────────────────────────────────────────────

test('aceite fraco + "vou ver/preciso/tenho/deixa…" sem dia nem hora ADIA (reais de 90 dias e sondas do sênior)', () => {
  for (const fala of [
    'Blz vou ver aqui a situação',
    'Ta bom vou ver',
    'Ótimo!!! Já vou ver e dou o retorno assim que possível',
    'Então está ótimo vou ver o que eu faço aqui aí eu aviso vocês',
    'Beleza, vou ver com meu marido e te confirmo',
    'Ótimo, vou ver aqui e te retorno',
    'Perfeito, vou ver minha agenda e te aviso',
    'Tá bom, deixa eu ver com meu chefe e te falo',
    'Certo, vou ver e te confirmo mais tarde',
    'Tudo certo, só vou ver com meu marido e já te falo',
    'Isso mesmo, vou conferir minha agenda e te aviso',
    'Show, deixa eu ver aqui',
    'Pode deixar, preciso ver com meu marido primeiro',
    'Ok, vou ver aqui e te retorno',
    'Não confirmo agora, te falo depois',
    'Te confirmo depois se der',
  ]) {
    assert.ok(adiouConfirmacao(fala), fala);
  }
});

test('o aceite anterior com horário NÃO anula uma nova promessa de confirmar depois', () => {
  for (const fala of [
    'Quinta 15h ótimo\nTe confirmo na parte da tarde',
    'Sim, quinta às 15h\nAh, espera, te confirmo mais tarde',
    'Pode ser quinta 15h?\nVou ver com meu marido e te aviso', // pergunta, não aceite
  ]) {
    assert.ok(adiouConfirmacao(fala), fala);
  }
});

test('"te/lhe confirmo" + dia ou hora é aceite; "Te chamo depois se tiver dúvida" é detalhe', () => {
  for (const fala of [
    'Vou ver com meu marido e te aviso\nTe confirmo quinta 15h',
    'Vou ver\nLhe confirmo para quinta',
    'Vou ver com meu marido\nTe confirmo amanhã às 15h',
    'Quinta 15h\nTe chamo depois se tiver dúvida',
    'Te chamo depois se tiver dúvida',
  ]) {
    assert.equal(adiouConfirmacao(fala), null, fala);
  }
  assert.ok(adiouConfirmacao('Te confirmo amanhã')); // sem dia da semana nem hora: adia
});

test('"Ok/👍 + dia" com negação não é aceite', () => {
  assert.ok(adiouConfirmacao('Ok, hoje não dá\nVou ver com meu chefe'));
  assert.ok(adiouConfirmacao('Ok 👍 quinta não dá, vou ver com meu chefe'));
  assert.equal(adiouConfirmacao('Ok 👍 quinta 15h\nVou ver com meu chefe'), null);
});

test('seco: o retorno NÃO espera o gravador lento (a consulta já foi marcada)', async () => {
  const tool = new DynamicStructuredTool({ name: 'agendar_consulta', description: 't', schema: z.object({ hora: z.string() }), func: async () => 'Consulta marcada' });
  const [t] = travarAgendamentoAdiado(
    [tool],
    { adiou: 'vou confirmar mais tarde' },
    { step: () => new Promise<void>((r) => setTimeout(r, 1500)) } as never,
    () => 'seco',
  );
  const t0 = Date.now();
  assert.equal(await t.func({ hora: '15:00' } as never), 'Consulta marcada');
  assert.ok(Date.now() - t0 < 500, `levou ${Date.now() - t0} ms`);
});

test('"quando chegar": "te aviso quando chegar aí" é aviso de chegada; "quando chegar eu retorno" e "quando chegar o momento" adiam', () => {
  assert.equal(adiouConfirmacao('Beleza! Te aviso quando chegar aí'), null);
  assert.ok(adiouConfirmacao('Eu vô ver cm ele quando chegar eu retorno obrigada'));
  assert.ok(adiouConfirmacao('Eu aviso quando chegar o momento certo'));
});

test('"amanhã cedo" sozinho não é horário; "um ótimo dia" no fim não desfaz o adiamento anterior', () => {
  assert.ok(adiouConfirmacao('Faz assim eu vou ver e amanhã cedo te mando mensagem blz'));
  assert.ok(adiouConfirmacao('Ok, obrigada!\nÉ para mim mesma.\nMas vou ver qdo posso ir e ligo para marcarmos\nGrata pelo retorno e um ótimo dia!'));
  assert.ok(adiouConfirmacao('Antes da sexta vou decidir o dia pois tenho que ver umas coisa aqui ainda, mais vamos nos falando ok'));
  assert.ok(adiouConfirmacao('Tá bom porque com meu esposo depois te falo'));
});
