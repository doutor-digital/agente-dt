/**
 * A carga de implantação cria cartão onde não há — e o risco é criar errado.
 *
 * Não existe apagar lead por API, nem no Kommo nem na franquia. Um cartão criado na etapa errada
 * fica errado para sempre, e criar 180 de uma vez multiplica o engano por 180. Estes testes fixam
 * as três coisas que não podem escorregar: a etapa onde o cartão nasce, quem fica de fora, e o
 * telefone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { destinoDoCartao, planejarCarga, porEtapa, telefoneE164, MAX_PASSOS } from './franquia-carga.js';
import { ETAPA, TRATAMENTO_FINALIZADO, TRATAMENTO_EM_ANDAMENTO } from './franquia-move.js';
import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';

const AGORA = Math.floor(Date.parse('2026-09-28T12:00:00Z') / 1000);
const DIA = 24 * 3600;
const iso = (epoch: number) => new Date(epoch * 1000).toISOString();

function consulta(quando: number, idStatus: number, categoria = 'AVALIAÇÃO'): SpineSchedule {
  return {
    idSchedule: Math.floor(Math.random() * 1e6),
    idStatus,
    statusName: null,
    clientName: 'FULANO',
    categoryName: categoria,
    dateAttendanceUtc: iso(quando),
  } as SpineSchedule;
}
const sessao = (quando: number, idStatus: number) => consulta(quando, idStatus, 'SESSÃO');

const base = { agoraEpoch: AGORA, horasAteNegociacao: 48 };

test('consulta marcada no futuro: o cartão nasce em AGENDADO', () => {
  const d = destinoDoCartao({ ...base, agendamentos: [consulta(AGORA + 3 * DIA, SPINE_STATUS.AGENDADO)], tratamentos: [] });
  assert.equal(d.funil, 'COMERCIAL');
  assert.equal(d.status, ETAPA.AGENDADO);
});

test('atendido ontem e sem tratamento: nasce em COMPARECEU, não em negociação', () => {
  const d = destinoDoCartao({ ...base, agendamentos: [consulta(AGORA - DIA, SPINE_STATUS.ATENDIDO)], tratamentos: [] });
  assert.equal(d.status, ETAPA.COMPARECEU);
});

test('atendido há 10 dias e sem tratamento: a jornada já levou pra EM NEGOCIAÇÃO', () => {
  const d = destinoDoCartao({ ...base, agendamentos: [consulta(AGORA - 10 * DIA, SPINE_STATUS.ATENDIDO)], tratamentos: [] });
  assert.equal(d.status, ETAPA.NEGOCIACAO);
});

test('atendido há muito tempo e nunca fechou: nasce PERDIDO', () => {
  // Só funciona porque o berço é AGENDADO: da etapa de entrada a máquina se recusa a declarar perda
  // (quem está lá é da Sofia). Nascendo em AGENDADO, o fato da franquia decide.
  const d = destinoDoCartao({ ...base, agendamentos: [consulta(AGORA - 200 * DIA, SPINE_STATUS.ATENDIDO)], tratamentos: [] });
  assert.equal(d.status, ETAPA.PERDIDO);
  assert.match(d.caminho.join(' | '), /200 d/, 'o caminho tem de dizer a idade do fato que decidiu');
});

test('faltou esta semana: nasce em NÃO COMPARECEU', () => {
  const d = destinoDoCartao({ ...base, agendamentos: [consulta(AGORA - 2 * DIA, SPINE_STATUS.NAO_COMPARECEU)], tratamentos: [] });
  assert.equal(d.status, ETAPA.NAO_COMPARECEU);
});

test('em tratamento na franquia: nasce no funil TRATAMENTO, não no COMERCIAL', () => {
  const d = destinoDoCartao({
    ...base,
    agendamentos: [consulta(AGORA - 30 * DIA, SPINE_STATUS.ATENDIDO), sessao(AGORA - DIA, SPINE_STATUS.ATENDIDO)],
    tratamentos: [{ idStatus: TRATAMENTO_EM_ANDAMENTO, statusName: 'EM ANDAMENTO' }],
  });
  assert.equal(d.funil, 'TRATAMENTO');
  assert.equal(d.status, ETAPA.EM_TRATAMENTO);
});

test('tratamento finalizado: nasce em ALTA', () => {
  const d = destinoDoCartao({
    ...base,
    agendamentos: [consulta(AGORA - 120 * DIA, SPINE_STATUS.ATENDIDO), sessao(AGORA - 60 * DIA, SPINE_STATUS.ATENDIDO)],
    tratamentos: [{ idStatus: TRATAMENTO_FINALIZADO, statusName: 'FINALIZADO' }],
  });
  assert.equal(d.status, ETAPA.ALTA);
});

test('sem fato nenhum o cartão fica no berço — e por isso quem não tem fato é filtrado antes', () => {
  // A máquina não tem o que decidir, então devolve o berço (AGENDADO). Um cartão em AGENDADO sem
  // consulta seria mentira, e é `planejarCarga` que impede isso com o motivo 'sem-fato'.
  const d = destinoDoCartao({ ...base, agendamentos: [], tratamentos: [] });
  assert.equal(d.status, ETAPA.AGENDADO);
  assert.equal(d.caminho.length, 0);
});

test('o caminhar tem teto — duas regras que se apontam não podem girar pra sempre', () => {
  const d = destinoDoCartao({
    ...base,
    agendamentos: [consulta(AGORA - 60 * DIA, SPINE_STATUS.ATENDIDO), sessao(AGORA - 5 * DIA, SPINE_STATUS.ATENDIDO)],
    tratamentos: [{ idStatus: TRATAMENTO_EM_ANDAMENTO, statusName: 'EM ANDAMENTO' }],
  });
  assert.ok(d.caminho.length <= MAX_PASSOS, `andou ${d.caminho.length} passos`);
});

// ── quem entra na carga ──

const paciente = (nome: string, telefone: string | null, ags: SpineSchedule[] = []) => ({
  nome, idClient: 1, telefone, agendamentos: ags, tratamentos: [],
});

test('quem já tem cartão não entra — a carga não duplica o que o sincronizador já acha', () => {
  const p = paciente('MARIA', '24988374861', [consulta(AGORA + DIA, SPINE_STATUS.AGENDADO)]);
  const plano = planejarCarga({ ...base, pacientes: [p], temCartao: () => true });
  assert.equal(plano.criar.length, 0);
  assert.equal(plano.fora[0]?.motivo, 'ja-tem-cartao');
});

test('sem telefone não entra: cartão sem contato ninguém trabalha, e o Kommo aceitaria calado', () => {
  const p = paciente('JOÃO', null, [consulta(AGORA + DIA, SPINE_STATUS.AGENDADO)]);
  const plano = planejarCarga({ ...base, pacientes: [p], temCartao: () => false });
  assert.equal(plano.criar.length, 0);
  assert.equal(plano.fora[0]?.motivo, 'sem-telefone');
});

test('cadastro solto na franquia, sem agenda e sem tratamento, não vira cartão', () => {
  const plano = planejarCarga({ ...base, pacientes: [paciente('ZE', '24988374861')], temCartao: () => false });
  assert.equal(plano.criar.length, 0);
  assert.equal(plano.fora[0]?.motivo, 'sem-fato');
});

test('a prévia conta por etapa — é esse número que alguém confere antes de aplicar', () => {
  const plano = planejarCarga({
    ...base,
    temCartao: () => false,
    pacientes: [
      paciente('A', '24988374861', [consulta(AGORA + DIA, SPINE_STATUS.AGENDADO)]),
      paciente('B', '24988374862', [consulta(AGORA + 2 * DIA, SPINE_STATUS.CONFIRMADO)]),
      paciente('C', '24988374863', [consulta(AGORA - DIA, SPINE_STATUS.ATENDIDO)]),
    ],
  });
  const contagem = porEtapa(plano);
  assert.equal(contagem[ETAPA.AGENDADO], 2);
  assert.equal(contagem[ETAPA.COMPARECEU], 1);
});

test('todo cartão criado leva o caminho que a máquina percorreu — sem isso ninguém audita a decisão', () => {
  const plano = planejarCarga({
    ...base,
    temCartao: () => false,
    pacientes: [paciente('A', '24988374861', [consulta(AGORA - 200 * DIA, SPINE_STATUS.ATENDIDO)])],
  });
  assert.ok(plano.criar[0]!.caminho.length > 0);
});

// ── telefone ──

test('o telefone da franquia vira E.164', () => {
  assert.equal(telefoneE164('(24) 98837-4861'), '+5524988374861');
  assert.equal(telefoneE164('2432653205'), '+552432653205');
  assert.equal(telefoneE164('5524988374861'), '+5524988374861');
});

test('telefone curto demais ou vazio devolve null — é o que tira o paciente da carga', () => {
  for (const v of ['', null, undefined, '123', '99999']) {
    assert.equal(telefoneE164(v), null, JSON.stringify(v));
  }
});
