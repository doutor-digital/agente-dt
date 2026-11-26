import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chaveDoPaciente } from './agenda-historico.js';
import {
  TAMANHO_MAXIMO_DA_MENSAGEM, candidatosDaLista, ehAvaliacao, nomeParaOTexto, pacienteEmTratamento, partesDaLista, textosDaLista, tipoDaPerda,
  type AgendamentoDaLista, type ItemDoTexto,
} from './recuperacao-agenda.js';

process.env.AGENDA_HISTORICO_SEGREDO = 'segredo-de-teste-da-agenda-0123456789abcdef';
const U = 'u1';
const HOJE = '2026-11-26';
const AGORA = new Date('2026-11-26T12:00:00.000Z'); // 09h em São Paulo

let seq = 0;
/** Um agendamento da franquia: `dia` AAAA-MM-DD (11h local = 14h UTC). */
const ag = (nome: string, dia: string, idStatus: number, o: Partial<AgendamentoDaLista> = {}): AgendamentoDaLista => ({
  idSchedule: ++seq, idStatus, clientName: nome, categoryName: 'AVALIAÇÃO', dateAttendanceUtc: `${dia}T14:00:00.000Z`, dayLocal: dia, timeLocal: '11:00', modifiedUtc: `${dia}T10:00:00.000Z`, ...o,
});
const DESMARCADO = 57, FALTOU = 40, AGENDADO = 37, ATENDIDO = 42, CONFIRMADO = 38, REMARCADO = 41;

const lista = (agendamentos: AgendamentoDaLista[], emTratamento: string[] = [], extra: { dias?: number; lancamentos?: ReadonlyMap<number, Date> } = {}) =>
  candidatosDaLista({ unitId: U, agendamentos, emTratamento: new Set(emTratamento), hoje: HOJE, agora: AGORA, ...extra });
const nomes = (r: ReturnType<typeof lista>) => r.candidatos.map((c) => c.nome);

// ── quem entra ──────────────────────────────────────────────────────────────────
test('entra a avaliação desmarcada e a faltosa dos últimos 14 dias; reavaliação é variante e entra; sessão e retorno não', () => {
  const r = lista([
    ag('ANA DESMARCOU', '2026-11-20', DESMARCADO),
    ag('BIA FALTOU', '2026-11-19', FALTOU),
    ag('CLARA REAVALIACAO', '2026-11-18', DESMARCADO, { categoryName: 'REAVALIACAO' }),
    ag('DORA SESSAO', '2026-11-18', DESMARCADO, { categoryName: 'SESSAO' }),
    ag('ELZA RETORNO', '2026-11-18', DESMARCADO, { categoryName: 'RETORNO' }),
  ]);
  assert.deepEqual(nomes(r), ['ANA DESMARCOU', 'BIA FALTOU', 'CLARA REAVALIACAO']);
  assert.equal(ehAvaliacao('AVALIAÇÃO'), true);
  assert.equal(ehAvaliacao('Sessão'), false);
});

test('a janela é de 14 a 1 dia atrás: o de hoje (pode remarcar ainda hoje) e o de 15 dias atrás ficam de fora; o de 14 entra', () => {
  const r = lista([
    ag('HOJE', '2026-11-26', DESMARCADO),
    ag('ONTEM', '2026-11-25', DESMARCADO),
    ag('QUATORZE', '2026-11-12', DESMARCADO),
    ag('QUINZE', '2026-11-11', DESMARCADO),
    ag('FUTURO DESMARCADO', '2026-11-30', DESMARCADO),
  ]);
  assert.deepEqual(nomes(r), ['ONTEM', 'QUATORZE']);
});

test('ordem: o mais recente primeiro', () => {
  const r = lista([ag('VELHO', '2026-11-13', DESMARCADO), ag('NOVO', '2026-11-25', FALTOU), ag('MEIO', '2026-11-20', DESMARCADO)]);
  assert.deepEqual(nomes(r), ['NOVO', 'MEIO', 'VELHO']);
});

// ── quem sai ────────────────────────────────────────────────────────────────────
test('quem já voltou a marcar sai: nova avaliação marcada, confirmada, remarcada ou já atendida depois da que caiu', () => {
  for (const status of [AGENDADO, CONFIRMADO, REMARCADO, ATENDIDO]) {
    const r = lista([ag('FULANA VOLTOU', '2026-11-18', DESMARCADO), ag('FULANA VOLTOU', '2026-11-27', status)]);
    assert.deepEqual(nomes(r), [], `status ${status}`);
    assert.equal(r.saidas.voltou, 1);
  }
});

test('quem marcou de novo para o MESMO dia (outro horário) também voltou', () => {
  const r = lista([ag('FULANA', '2026-11-18', DESMARCADO), ag('FULANA', '2026-11-18', AGENDADO, { dateAttendanceUtc: '2026-11-18T18:00:00.000Z' })]);
  assert.deepEqual(nomes(r), []);
});

test('um novo desmarcado depois NÃO é ter voltado: continua na lista (uma vez só, a mais recente)', () => {
  const r = lista([ag('FULANA', '2026-11-18', DESMARCADO), ag('FULANA', '2026-11-24', FALTOU)]);
  assert.equal(r.candidatos.length, 1);
  assert.equal(r.candidatos[0].dia, '2026-11-24');
  assert.equal(r.saidas.repetido, 1);
});

test('uma consulta ANTERIOR atendida não conta como volta (foi antes de desmarcar)', () => {
  const r = lista([ag('FULANA', '2026-11-18', DESMARCADO), ag('FULANA', '2026-11-14', ATENDIDO)]);
  assert.deepEqual(nomes(r), ['FULANA']);
});

test('em tratamento sai: sessão marcada ou feita na agenda, ou tratamento aberto na franquia; sessão só desmarcada não segura', () => {
  const chave = chaveDoPaciente(U, 'GILDA TRATAMENTO')!;
  const r = lista(
    [
      ag('HELOISA SESSAO', '2026-11-18', DESMARCADO), ag('HELOISA SESSAO', '2026-11-12', ATENDIDO, { categoryName: 'SESSAO' }),
      ag('GILDA TRATAMENTO', '2026-11-18', FALTOU),
      ag('IRIS SO DESMARCOU SESSAO', '2026-11-18', DESMARCADO), ag('IRIS SO DESMARCOU SESSAO', '2026-11-22', DESMARCADO, { categoryName: 'SESSAO' }),
    ],
    [chave],
  );
  assert.deepEqual(nomes(r), ['IRIS SO DESMARCOU SESSAO']);
  assert.equal(r.saidas['em-tratamento'], 2);
});

test('sessão marcada para DEPOIS da avaliação que caiu: o paciente voltou (e está em tratamento) — sai também', () => {
  const r = lista([ag('HELOISA', '2026-11-18', DESMARCADO), ag('HELOISA', '2026-11-30', AGENDADO, { categoryName: 'SESSAO' })]);
  assert.deepEqual(nomes(r), []);
});

test('o mesmo nome em OUTRA unidade não mistura (a chave leva a unidade)', () => {
  const outra = chaveDoPaciente('u2', 'GILDA TRATAMENTO')!;
  assert.deepEqual(nomes(lista([ag('GILDA TRATAMENTO', '2026-11-18', FALTOU)], [outra])), ['GILDA TRATAMENTO']);
});

test('em tratamento pela REGRA DO SINCRONIZADOR: «Não iniciado», em andamento, pendente e sem status seguram; status que não se conhece também (na dúvida não liga)', () => {
  for (const s of ['Não iniciado', 'NAO INICIADO', 'Em andamento', 'Pendente', null, '', 'DESISTÊNCIA A PEDIDO DO PACIENTE', 'Aguardando algo novo da franquia', 'Suspenso por falta de pagamento', 'Pausado']) assert.equal(pacienteEmTratamento(s), true, String(s));
  for (const s of ['Finalizado', 'Concluído', 'Alta', 'Cancelado']) assert.equal(pacienteEmTratamento(s), false, s);
});

test('«Não iniciado» na franquia tira da lista (o tratamento ainda não começou, mas o paciente já fechou)', () => {
  const chave = chaveDoPaciente(U, 'NADIA FECHOU')!;
  assert.deepEqual(nomes(lista([ag('NADIA FECHOU', '2026-11-18', FALTOU)], pacienteEmTratamento('Não iniciado') ? [chave] : [])), []);
});

test('sessão = qualquer categoria que não é avaliação nem retorno (a regra do sincronizador): «Fisioterapia», «Procedimento», «Tratamento» seguram, e sessão desmarcada não', () => {
  for (const categoria of ['SESSAO', 'SESSÃO', 'FISIOTERAPIA', 'PROCEDIMENTO', 'TRATAMENTO']) {
    const r = lista([ag('OLGA', '2026-11-18', DESMARCADO), ag('OLGA', '2026-11-12', ATENDIDO, { categoryName: categoria })]);
    assert.deepEqual(nomes(r), [], categoria);
    assert.equal(r.saidas['em-tratamento'], 1, categoria);
  }
  assert.deepEqual(nomes(lista([ag('PAULA', '2026-11-18', DESMARCADO), ag('PAULA', '2026-11-12', DESMARCADO, { categoryName: 'FISIOTERAPIA' })])), ['PAULA']);
});

// ── o tipo: desmarcou, faltou, provável falta ───────────────────────────────────
test('tipo: NÃO COMPARECEU = faltou; DESMARCADO lançado antes do horário = desmarcou; lançado DEPOIS = provável falta', () => {
  const inicio = new Date('2026-11-20T14:00:00.000Z');
  assert.equal(tipoDaPerda(40, inicio, null), 'faltou');
  assert.equal(tipoDaPerda(57, inicio, new Date('2026-11-19T10:00:00.000Z')), 'desmarcou');
  assert.equal(tipoDaPerda(57, inicio, new Date('2026-11-20T18:00:00.000Z')), 'provavel_falta');
  assert.equal(tipoDaPerda(57, inicio, null), 'desmarcou', 'sem a hora do lançamento vale o que o status diz');
  assert.equal(tipoDaPerda(42, inicio, null), null);
  const r = lista([ag('JOANA', '2026-11-20', DESMARCADO, { modifiedUtc: '2026-11-20T18:00:00.000Z' })]);
  assert.equal(r.candidatos[0].tipo, 'provavel_falta');
});

test('a hora do lançamento vem do histórico quando existe: uma edição posterior do registro não faz um desmarque antecipado virar «provável falta»', () => {
  const a = ag('JOANA', '2026-11-20', DESMARCADO, { modifiedUtc: '2026-11-21T18:00:00.000Z' }); // editada no dia seguinte à consulta
  assert.equal(lista([a]).candidatos[0].tipo, 'provavel_falta', 'sem histórico vale a última alteração');
  const lanc = new Map([[a.idSchedule as number, new Date('2026-11-19T12:00:00.000Z')]]);
  assert.equal(lista([a], [], { lancamentos: lanc }).candidatos[0].tipo, 'desmarcou');
  const depois = new Map([[a.idSchedule as number, new Date('2026-11-20T20:00:00.000Z')]]);
  assert.equal(lista([a], [], { lancamentos: depois }).candidatos[0].tipo, 'provavel_falta');
});

// ── o nome e o texto ────────────────────────────────────────────────────────────
test('só o primeiro nome: sem sobrenome, sem o prefixo «IA-» da franquia; nome que não é de gente vira «paciente (sem nome)»', () => {
  assert.equal(nomeParaOTexto('MARIA APARECIDA SOUZA'), 'Maria');
  assert.equal(nomeParaOTexto('IA-ANA PAULA'), 'Ana');
  assert.equal(nomeParaOTexto('N-KELLY'), 'Kelly');
  assert.equal(nomeParaOTexto('Lead #123'), 'paciente (sem nome)');
  assert.equal(nomeParaOTexto(null), 'paciente (sem nome)');
});

const itemTexto = (o: Partial<ItemDoTexto> = {}): ItemDoTexto => ({ nome: 'Maria', dia: '2026-11-25', hora: '14:00', tipo: 'provavel_falta', link: 'https://doutorherniaacailandia.kommo.com/leads/detail/123', ...o });

test('o texto: primeiro nome, dia e hora originais, o que aconteceu e o link — nada de telefone nem CPF', () => {
  const [t] = textosDaLista({ hoje: HOJE, itens: [itemTexto(), itemTexto({ nome: 'João', tipo: 'faltou', link: null, dia: '2026-11-24', hora: '09:30' }), itemTexto({ nome: 'Ana', tipo: 'desmarcou' })], restantes: 0 });
  assert.match(t, /Maria — avaliação de 25\/11 \(qua\) às 14:00 — desmarcou depois do horário \(provável falta\)/);
  assert.match(t, /João — avaliação de 24\/11 \(ter\) às 09:30 — faltou/);
  assert.match(t, /Ana — avaliação de 25\/11 \(qua\) às 14:00 — desmarcou\n/);
  assert.match(t, /https:\/\/doutorherniaacailandia\.kommo\.com\/leads\/detail\/123/);
  assert.match(t, /\(cartão não achado, confira o opt-out\)/);
  assert.doesNotMatch(t, /\d{5}-?\d{4}|\d{3}\.\d{3}\.\d{3}/, 'sem telefone nem CPF');
  assert.doesNotMatch(t, /\+\d/);
});

test('restantes: o texto avisa que ficam para os próximos dias', () => {
  const [t] = textosDaLista({ hoje: HOJE, itens: [itemTexto()], restantes: 4 });
  assert.match(t, /\+4 ainda por conferir ficam para os próximos dias/);
  assert.doesNotMatch(textosDaLista({ hoje: HOJE, itens: [itemTexto()], restantes: 0 })[0], /ficam para os próximos dias/);
});

test('cada mensagem diz quais itens leva (para o desfecho do envio valer item a item) e as faixas cobrem a lista inteira sem buraco', () => {
  const itens = Array.from({ length: 15 }, (_, i) => itemTexto({ nome: `Paciente${i + 1}`, link: `https://doutorherniaacailandia.kommo.com/leads/detail/${30000000 + i}` }));
  const partes = partesDaLista({ hoje: HOJE, itens, restantes: 0 });
  assert.ok(partes.length >= 2);
  assert.equal(partes[0].de, 0);
  for (let k = 1; k < partes.length; k++) assert.equal(partes[k].de, partes[k - 1].ate, 'sem buraco entre as mensagens');
  assert.equal(partes[partes.length - 1].ate, 15);
  for (const p of partes) for (let i = p.de; i < p.ate; i++) assert.match(p.texto, new RegExp(`${i + 1}\\. Paciente${i + 1} —`), `o item ${i + 1} está na mensagem que diz levá-lo`);
});

test('o rodapé nunca vai sozinho: a última mensagem sempre leva pelo menos um paciente, de 1 a 15 itens', () => {
  for (let n = 1; n <= 15; n++) {
    const itens = Array.from({ length: n }, (_, i) => itemTexto({ nome: `Paciente${i + 1}`, link: `https://doutorherniaacailandia.kommo.com/leads/detail/${30000000 + i}` }));
    const partes = partesDaLista({ hoje: HOJE, itens, restantes: 3 });
    const ultima = partes[partes.length - 1];
    assert.ok(ultima.ate > ultima.de, `n=${n}: a última mensagem leva pacientes`);
    assert.match(ultima.texto, /Quem voltar a marcar sai da lista sozinho/);
    assert.equal(partes.filter((p) => /Quem voltar a marcar/.test(p.texto)).length, 1, 'o rodapé aparece uma vez');
    for (const p of partes) assert.ok(p.texto.length <= TAMANHO_MAXIMO_DA_MENSAGEM, `n=${n}: ${p.texto.length} caracteres`);
    assert.equal(partes.reduce((s, p) => s + (p.ate - p.de), 0), n);
  }
});

test('15 pacientes com link não estouram o corte de 1.500 caracteres da Evolution: a lista vira mais de uma mensagem, sem cortar paciente no meio', () => {
  const itens = Array.from({ length: 15 }, (_, i) => itemTexto({ nome: `Paciente${i + 1}`, link: `https://doutorherniaacailandia.kommo.com/leads/detail/${30000000 + i}` }));
  const textos = textosDaLista({ hoje: HOJE, itens, restantes: 2 });
  assert.ok(textos.length >= 2, 'precisou de mais de uma mensagem');
  for (const t of textos) assert.ok(t.length <= TAMANHO_MAXIMO_DA_MENSAGEM, `${t.length} caracteres`);
  const todos = textos.join('\n');
  for (let i = 1; i <= 15; i++) assert.match(todos, new RegExp(`${i}\\. Paciente${i} —`), `paciente ${i} presente`);
  assert.match(textos[textos.length - 1], /\+2 ainda por conferir/, 'o rodapé vai na última');
  assert.match(textos[0], /Avaliações para recuperar/);
});
