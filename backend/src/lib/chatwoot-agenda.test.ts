/**
 * Agenda da franquia → conversa do Chatwoot: situação e categoria traduzidas, o agendamento que vale por pessoa, só o que muda,
 * e o casamento pelo nome do cadastro + telefone (nome ambíguo não casa).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpineSchedule } from '../services/spine.service.js';
import { agendamentoQueVale, casar, categoriaDoChatwoot, descricao, desejadoDe, etapaDaConsulta, mudancas, situacaoDoChatwoot, whatsDoCadastro, type ConversaDaCaixa } from './chatwoot-agenda.js';

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
    { id: 20, telefone: '+5594988887777', attrs: { data_consulta: '2026-11-13', hora_consulta: '14:30', situacao_consulta: 'Agendado', categoria_consulta: 'Avaliação', etapa: 'Agendado' }, atividade: 5 },
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
  assert.equal(r[0]!.muda.etapa, 'Agendado'); // conversa sem etapa + consulta de pé
});

// ── a etapa da consulta de pé (sem ela a régua não monta véspera/dia/preparo) ──

const HOJE = '2026-11-14';
const dePe = (o: Partial<{ data_consulta: string; situacao_consulta: string; categoria_consulta: string | null }> = {}) => ({ data_consulta: '2026-11-16', hora_consulta: '13:30', situacao_consulta: 'Agendado', categoria_consulta: 'Avaliação', ...o });

test('etapa: vazia, Novo lead, Sofia qualifica, Esperando humano e Resgate com consulta de pé viram Agendado (Confirmado se confirmada)', () => {
  for (const etapa of [undefined, '', '  ', 'Novo lead', 'Sofia qualifica', 'Esperando humano', 'Resgate']) {
    assert.deepEqual(etapaDaConsulta({ etapa }, dePe(), HOJE), { etapa: 'Agendado' }, String(etapa));
    assert.deepEqual(etapaDaConsulta({ etapa }, dePe({ situacao_consulta: 'Confirmado' }), HOJE), { etapa: 'Confirmado' }, String(etapa));
  }
  // Remarcado NÃO é de pé: o horário não vale mais (a data nova pode estar fora da janela lida) — nada de gravar Agendado
  assert.deepEqual(etapaDaConsulta({}, dePe({ situacao_consulta: 'Remarcado' }), HOJE), {});
  assert.deepEqual(etapaDaConsulta({}, dePe({ situacao_consulta: 'Remarcado', data_consulta: HOJE }), HOJE), {});
  assert.deepEqual(etapaDaConsulta({}, dePe({ data_consulta: HOJE }), HOJE), { etapa: 'Agendado' }, 'hoje conta');
});

test('etapa: nunca rebaixa nem sobrescreve; Perdido/Frio ficam como estão (só registro); consulta que não está de pé não mexe', () => {
  for (const etapa of ['Agendado', 'Confirmado', 'Compareceu', 'Fechou', 'Pós-consulta']) {
    assert.deepEqual(etapaDaConsulta({ etapa }, dePe({ situacao_consulta: 'Confirmado' }), HOJE), {}, etapa);
  }
  assert.deepEqual(etapaDaConsulta({ etapa: 'Perdido' }, dePe(), HOJE), { segurada: 'Perdido' });
  assert.deepEqual(etapaDaConsulta({ etapa: 'Frio' }, dePe(), HOJE), { segurada: 'Frio' });
  // não está de pé: passada, atendida, faltou, desmarcada
  assert.deepEqual(etapaDaConsulta({}, dePe({ data_consulta: '2026-11-13' }), HOJE), {});
  for (const situacao_consulta of ['Atendido', 'Não compareceu', 'Desmarcado']) assert.deepEqual(etapaDaConsulta({}, dePe({ situacao_consulta }), HOJE), {}, situacao_consulta);
  assert.deepEqual(etapaDaConsulta({ etapa: 'Perdido' }, dePe({ data_consulta: '2026-11-13' }), HOJE), {}, 'Perdido com consulta passada: nem registro');
  // quem está no funil de Tratamento não vai para o comercial
  assert.deepEqual(etapaDaConsulta({ funil: 'Tratamento' }, dePe(), HOJE), {});
  assert.deepEqual(etapaDaConsulta({ etapa_tratamento: 'Em tratamento' }, dePe(), HOJE), {});
});

test('mudancas: a etapa só entra com `hoje`; casar devolve a etapa segurada (Perdido/Frio) sem gravar etapa', () => {
  const d = desejadoDe(ag({ dayLocal: '2026-11-16', statusName: 'Confirmado' }))!;
  assert.equal(mudancas({}, d).etapa, undefined, 'sem hoje, como era');
  assert.equal(mudancas({}, d, HOJE).etapa, 'Confirmado');
  assert.match(descricao(mudancas({}, d, HOJE)), /etapa = Confirmado/);
  const cheia = { data_consulta: '2026-11-16', hora_consulta: '14:30', situacao_consulta: 'Confirmado', categoria_consulta: 'Avaliação' };
  // só a etapa faltava: a mudança é só ela
  assert.deepEqual(mudancas({ ...cheia, etapa: 'Sofia qualifica' }, d, HOJE), { etapa: 'Confirmado' });
  assert.deepEqual(mudancas({ ...cheia, etapa: 'Confirmado' }, d, HOJE), {});
  const conversas: ConversaDaCaixa[] = [{ id: 1, telefone: '+5594999745062', attrs: { ...cheia, etapa: 'Perdido' }, atividade: 1 }];
  const r = casar([ag({ dayLocal: '2026-11-16', statusName: 'Confirmado' })], conversas, () => ['5594999745062'], HOJE);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0]!.muda, {});
  assert.equal(r[0]!.segurada, 'Perdido');
  // nada a fazer e nada segurado: fora do plano
  assert.equal(casar([ag({ dayLocal: '2026-11-16', statusName: 'Confirmado' })], [{ ...conversas[0]!, attrs: { ...cheia, etapa: 'Fechou' } }], () => ['5594999745062'], HOJE).length, 0);
});

test('consulta que passou: a agenda grava Atendido / Não compareceu (sem mexer na etapa); a conversa do histórico com consulta recente chega até aqui por ehArquivo', async () => {
  const { ehArquivo } = await import('./chatwoot-regua.js');
  const ontem = { data_consulta: '2026-11-13', hora_consulta: '14:30', situacao_consulta: 'Agendado', categoria_consulta: 'Avaliação', etapa: 'Sofia qualifica' };
  const r1 = casar([ag({ dayLocal: '2026-11-13', statusName: 'Atendido' })], [{ id: 1, telefone: '+5594999745062', attrs: ontem, atividade: 1 }], () => ['5594999745062'], '2026-11-14');
  assert.deepEqual(r1[0]!.muda, { situacao_consulta: 'Atendido' });
  const r2 = casar([ag({ dayLocal: '2026-11-13', statusName: 'Não compareceu' })], [{ id: 1, telefone: '+5594999745062', attrs: ontem, atividade: 1 }], () => ['5594999745062'], '2026-11-14');
  assert.deepEqual(r2[0]!.muda, { situacao_consulta: 'Não compareceu' });
  // a lista de conversas da agenda pula arquivo: a de 13/11 (historico, parada) entra; a de dois meses atrás não
  const hist = (data: string) => ({ labels: ['historico'], last_activity_at: Math.floor(Date.parse('2026-11-12T12:00:00Z') / 1000), custom_attributes: { data_consulta: data, situacao_consulta: 'Agendado' } });
  const agora = new Date('2026-11-14T22:00:00Z');
  assert.equal(ehArquivo(hist('2026-11-13'), agora), false);
  assert.equal(ehArquivo(hist('2026-09-13'), agora), true);
});

test('consulta de HOJE marcada Remarcado (data nova fora dos 14 dias lidos): a agenda não grava Agendado nem etapa', () => {
  const conversas: ConversaDaCaixa[] = [{ id: 1, telefone: '+5594999745062', attrs: { etapa: 'Sofia qualifica' }, atividade: 1 }];
  const r = casar([ag({ dayLocal: HOJE, statusName: 'Remarcado' })], conversas, () => ['5594999745062'], HOJE);
  for (const x of r) {
    assert.equal(x.muda.etapa, undefined);
    assert.notEqual(x.muda.situacao_consulta, 'Agendado');
  }
  // contraste: a mesma consulta de hoje Agendada grava a etapa
  assert.equal(casar([ag({ dayLocal: HOJE, statusName: 'Agendado' })], conversas, () => ['5594999745062'], HOJE)[0]!.muda.etapa, 'Agendado');
});

test('etapa só para consulta COMERCIAL: Avaliação, Retorno e Retorno com exames promovem; Sessão e Retorno após tratamento (paciente em tratamento) não', () => {
  for (const categoria_consulta of ['Avaliação', 'Retorno', 'Retorno com exames']) {
    assert.deepEqual(etapaDaConsulta({ etapa: 'Sofia qualifica' }, dePe({ categoria_consulta }), HOJE), { etapa: 'Agendado' }, categoria_consulta);
  }
  for (const categoria_consulta of ['Sessão', 'Retorno após tratamento']) {
    assert.deepEqual(etapaDaConsulta({}, dePe({ categoria_consulta }), HOJE), { porCategoria: categoria_consulta }, categoria_consulta);
    assert.deepEqual(etapaDaConsulta({ etapa: 'Novo lead' }, dePe({ categoria_consulta, situacao_consulta: 'Confirmado' }), HOJE), { porCategoria: categoria_consulta });
  }
  // categoria desconhecida também não promove (palpite não vira etapa)
  assert.deepEqual(etapaDaConsulta({}, dePe({ categoria_consulta: null }), HOJE), { porCategoria: '(sem categoria)' });
  // quem já está numa etapa que a agenda não mexe, ou desistiu, segue como antes (sem ruído de categoria)
  assert.deepEqual(etapaDaConsulta({ etapa: 'Compareceu' }, dePe({ categoria_consulta: 'Sessão' }), HOJE), {});
  assert.deepEqual(etapaDaConsulta({ etapa: 'Perdido' }, dePe({ categoria_consulta: 'Sessão' }), HOJE), { segurada: 'Perdido' });
});

test('casar: SESSÃO de pé (paciente em tratamento, funil vazio) não ganha etapa comercial — só data/situação/categoria; Avaliação ganha', () => {
  const sessao = casar([ag({ dayLocal: '2026-11-27', timeLocal: '09:00:00', categoryName: 'Sessão' })], [{ id: 17, telefone: '+5594999745062', attrs: {}, atividade: 1 }], () => ['5594999745062'], HOJE);
  assert.equal(sessao.length, 1);
  assert.equal(sessao[0]!.muda.etapa, undefined);
  assert.equal(sessao[0]!.muda.categoria_consulta, 'Sessão');
  assert.equal(sessao[0]!.muda.data_consulta, '2026-11-27');
  assert.equal(sessao[0]!.porCategoria, 'Sessão');
  const avaliacao = casar([ag({ dayLocal: '2026-11-27', categoryName: 'Avaliação' })], [{ id: 18, telefone: '+5594999745062', attrs: {}, atividade: 1 }], () => ['5594999745062'], HOJE);
  assert.equal(avaliacao[0]!.muda.etapa, 'Agendado');
  assert.equal(avaliacao[0]!.porCategoria, undefined);
});
