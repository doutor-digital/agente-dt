import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { dentroDoHorario, inicioDaJanela, semJanelaDeHorario } from './follow-up-worker.js';

/**
 * Quando o follow-up pode cobrar um lead parado.
 *
 * Existe por um caso real: num domingo entraram 15 leads, a IA cumprimentou e
 * perguntou nome e cidade, ninguém respondeu, e nenhuma cobrança saiu — porque
 * a trava de horário segue a agenda da clínica, que não abre domingo. O dono
 * teve que ligar para os 15 na mão na segunda.
 *
 * A trava continua valendo por padrão. O que muda é poder desligá-la por
 * unidade, e o padrão precisa continuar sendo o comportamento antigo: ninguém
 * quer descobrir que passou a cobrar 25 cidades de madrugada por causa de um
 * deploy.
 */

function unidade(over: Partial<Parameters<typeof dentroDoHorario>[0]> = {}) {
  return {
    slug: 'doutor-hernia-parauapebas',
    spineAgendaStart: '08:00',
    spineAgendaEnd: '18:00',
    spineTimezone: 'America/Sao_Paulo',
    spineAgendaDays: [1, 2, 3, 4, 5],
    ...over,
  };
}

afterEach(() => {
  delete process.env.FOLLOW_UP_24H_SLUGS;
});

test('sem a variável, nenhuma unidade ganha 24 horas', () => {
  assert.equal(semJanelaDeHorario('doutor-hernia-parauapebas'), false);
});

test('a unidade listada ganha 24 horas', () => {
  process.env.FOLLOW_UP_24H_SLUGS = 'doutor-hernia-parauapebas';
  assert.equal(semJanelaDeHorario('doutor-hernia-parauapebas'), true);
  assert.equal(semJanelaDeHorario('doutor-hernia-imperatriz'), false);
});

test('lista com espaços e várias unidades', () => {
  process.env.FOLLOW_UP_24H_SLUGS = ' doutor-hernia-porto , doutor-hernia-parauapebas ';
  assert.equal(semJanelaDeHorario('doutor-hernia-porto'), true);
  assert.equal(semJanelaDeHorario('doutor-hernia-parauapebas'), true);
});

test('o asterisco vale para todas', () => {
  process.env.FOLLOW_UP_24H_SLUGS = '*';
  assert.equal(semJanelaDeHorario('qualquer-uma'), true);
});

test('lista vazia ou só vírgulas não libera ninguém sem querer', () => {
  for (const ruim of ['', '   ', ',,', ' , , ']) {
    process.env.FOLLOW_UP_24H_SLUGS = ruim;
    assert.equal(semJanelaDeHorario('doutor-hernia-parauapebas'), false, `"${ruim}" liberou`);
  }
});

test('com o interruptor ligado, domingo de madrugada passa', () => {
  // É o caso que motivou tudo isto: o lead que escreve domingo e some.
  process.env.FOLLOW_UP_24H_SLUGS = 'doutor-hernia-parauapebas';
  assert.equal(dentroDoHorario(unidade()), true);
});

test('sem o interruptor, a trava da agenda continua mandando', () => {
  // `-1` não é dia de semana nenhum, então bloqueia seja qual for o dia de hoje
  // — o teste não pode depender do relógio da máquina que roda a suíte.
  assert.equal(dentroDoHorario(unidade({ spineAgendaDays: [-1] })), false);
});

test('lista de dias vazia cai no padrão de segunda a sexta', () => {
  // Vazio não significa "todos os dias": significa "não configurado". Se
  // significasse todos, uma unidade sem configuração passaria a cobrar no
  // domingo sem ninguém ter pedido.
  const domingo = dentroDoHorario(unidade({ spineAgendaDays: [] }));
  const segundaASexta = dentroDoHorario(unidade({ spineAgendaDays: [1, 2, 3, 4, 5] }));
  assert.equal(domingo, segundaASexta);
});

test('unidade sem 24h e com janela impossível não envia nada', () => {
  const r = dentroDoHorario(unidade({ spineAgendaStart: '23:00', spineAgendaEnd: '23:30' }));
  // A janela é achatada para no máximo 08h–20h; 23:00 vira 20:00 e a abertura
  // nunca alcança o fechamento, então não sai mensagem.
  assert.equal(r, false);
});

// ------------------------------------------------- fila de candidatas

test('a janela de busca é de 23 horas atrás', () => {
  const agora = new Date('2026-09-01T10:00:00Z');
  const corte = inicioDaJanela(agora);
  assert.equal(corte.toISOString(), '2026-08-31T11:00:00.000Z');
});

test('conversa de dez dias atrás fica fora do corte', () => {
  // É o defeito que travava tudo: a fila era ordenada da mais antiga para a
  // mais nova e limitada a 60. Na Parauapebas, as 60 primeiras eram de 18 a 21
  // de agosto — presas na fila porque estão em etapas sem regra, e por isso
  // nunca marcadas como encerradas. As 32 conversas que ainda dava para
  // responder estavam no fim e nunca eram alcançadas.
  const agora = new Date('2026-09-01T10:00:00Z');
  const corte = inicioDaJanela(agora);
  const antiga = new Date('2026-08-21T00:27:00Z');
  const recente = new Date('2026-09-01T09:59:00Z');
  assert.ok(antiga < corte, 'a antiga deveria ficar fora da fila');
  assert.ok(recente > corte, 'a recente deveria entrar na fila');
});
