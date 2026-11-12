/**
 * Agenda da franquia → conversa do Chatwoot: situação e categoria traduzidas, o agendamento que vale por pessoa, só o que muda,
 * e o casamento pelo nome do cadastro + telefone (nome ambíguo não casa).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpineSchedule } from '../services/spine.service.js';
import { agendamentoQueVale, casar, categoriaDoChatwoot, descricao, desejadoDe, mudancas, situacaoDoChatwoot, whatsDoCadastro, type ConversaDaCaixa } from './chatwoot-agenda.js';

const ag = (o: Partial<SpineSchedule>): SpineSchedule => ({
  idSchedule: 1,
  idTreatment: null,
  idStatus: null,
  statusName: 'Agendado',
  clientName: 'Maria da Silva',
  categoryName: 'Avaliação',
  physicalTherapist: null,
  dateAttendanceUtc: null,
  dateAttendanceLocal: null,
  dayLocal: '2026-11-13',
  timeLocal: '14:30:00',
  isBusy: false,
  requiresManualValidation: false,
  ...o,
});

test('situação da franquia → lista do Chatwoot', () => {
  assert.equal(situacaoDoChatwoot({ statusName: 'Agendado' }), 'Agendado');
  assert.equal(situacaoDoChatwoot({ statusName: 'Confirmado' }), 'Confirmado');
  assert.equal(situacaoDoChatwoot({ statusName: 'Atendido' }), 'Atendido');
  assert.equal(situacaoDoChatwoot({ statusName: 'Não compareceu' }), 'Não compareceu');
  assert.equal(situacaoDoChatwoot({ statusName: 'Desmarcado' }), 'Desmarcado');
  assert.equal(situacaoDoChatwoot({ statusName: 'Remarcado' }), 'Remarcado');
});

test('categoria: a mais específica primeiro; desconhecida = null', () => {
  assert.equal(categoriaDoChatwoot('Retorno após tratamento'), 'Retorno após tratamento');
  assert.equal(categoriaDoChatwoot('RETORNO COM EXAMES'), 'Retorno com exames');
  assert.equal(categoriaDoChatwoot('Sessão'), 'Sessão');
  assert.equal(categoriaDoChatwoot('Consulta inicial'), 'Avaliação');
  assert.equal(categoriaDoChatwoot('Outra coisa'), null);
  assert.equal(categoriaDoChatwoot(null), null);
});

test('vale o próximo de pé; sem ele, o mais recente que passou', () => {
  const ontem = ag({ idSchedule: 1, dayLocal: '2026-11-11', statusName: 'Atendido' });
  const amanha = ag({ idSchedule: 2, dayLocal: '2026-11-13' });
  const depois = ag({ idSchedule: 3, dayLocal: '2026-11-20' });
  const desmarcado = ag({ idSchedule: 4, dayLocal: '2026-11-12', statusName: 'Desmarcado' });
  assert.equal(agendamentoQueVale([depois, ontem, amanha, desmarcado], '2026-11-12')!.idSchedule, 2);
  assert.equal(agendamentoQueVale([ontem, desmarcado], '2026-11-12')!.idSchedule, 4);
  assert.equal(agendamentoQueVale([ontem], '2026-11-12')!.idSchedule, 1);
  assert.equal(agendamentoQueVale([], '2026-11-12'), null);
});

test('desejado e mudanças: só o que muda; hora HH:MM', () => {
  const d = desejadoDe(ag({}))!;
  assert.deepEqual(d, { data_consulta: '2026-11-13', hora_consulta: '14:30', situacao_consulta: 'Agendado', categoria_consulta: 'Avaliação' });
  assert.deepEqual(mudancas({}, d), { data_consulta: '2026-11-13', hora_consulta: '14:30', situacao_consulta: 'Agendado', categoria_consulta: 'Avaliação' });
  assert.deepEqual(mudancas({ data_consulta: '2026-11-13T03:00:00.000Z', hora_consulta: '14:30', situacao_consulta: 'Agendado', categoria_consulta: 'Avaliação' }, d), {});
  assert.deepEqual(mudancas({ data_consulta: '2026-11-13', hora_consulta: '14:30', situacao_consulta: 'Agendado' }, { ...d, situacao_consulta: 'Confirmado', categoria_consulta: null }), {
    situacao_consulta: 'Confirmado',
  });
  assert.equal(descricao({ data_consulta: '2026-11-13', situacao_consulta: 'Confirmado' }), 'data = 13/11/2026 · situação = Confirmado');
});

test('WhatsApp do cadastro: só nome igual; põe o 55; telefones distintos ficam todos', () => {
  const c = [
    { name: 'Maria da Silva', whatsapp: '(94) 99974-5062' },
    { name: 'MARIA DA SILVA', whatsapp: '94999745062' },
    { name: 'Maria da Silva Souza', whatsapp: '94911112222' },
    { name: 'Maria da Silva', whatsapp: null },
  ];
  assert.deepEqual(whatsDoCadastro(c, 'maria da silva'), ['5594999745062']);
  assert.deepEqual(whatsDoCadastro([...c, { name: 'Maria da Silva', whatsapp: '94988887777' }], 'Maria da Silva').length, 2);
  assert.deepEqual(whatsDoCadastro(c, 'João'), []);
});

test('casar: pelo telefone do cadastro (com e sem o 9); nome ambíguo ou sem cadastro não casa; nada a mudar fica de fora', () => {
  const conversas: ConversaDaCaixa[] = [
    { id: 14, telefone: '+559499745062', attrs: {}, atividade: 10 },
    { id: 20, telefone: '+5594988887777', attrs: { data_consulta: '2026-11-13', hora_consulta: '14:30', situacao_consulta: 'Agendado', categoria_consulta: 'Avaliação' }, atividade: 5 },
  ];
  const agenda = [ag({ clientName: 'Maria da Silva' }), ag({ clientName: 'Ana Souza' }), ag({ clientName: 'Duas Pessoas' }), ag({ clientName: 'Sem Cadastro' })];
  const fones: Record<string, string[] | null> = {
    'maria da silva': ['5594999745062'],
    'ana souza': ['5594988887777'],
    'duas pessoas': ['5594911112222', '5594933334444'],
    'sem cadastro': [],
  };
  const r = casar(agenda, conversas, (n) => fones[n] ?? null, '2026-11-12');
  assert.equal(r.length, 1);
  assert.equal(r[0]!.conversa.id, 14);
  assert.equal(r[0]!.muda.situacao_consulta, 'Agendado');
});
