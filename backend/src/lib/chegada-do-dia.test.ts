/**
 * A chegada do paciente no dia — o caso real que motivou (Açailândia, 03/11/2026, cartão 24830668):
 * Maria Aparecida (idClient 353493) tem DOIS tratamentos, 125336 e 125337, com sessões em sequência no mesmo dia —
 * 03/11, 06/11 e 09/11, sempre 15h30 (125336) e 16h (125337). O cartão guarda o idTreatment 125337 e a
 * «◷ Próxima sessão» 1793732400 (03/11 16:00): o lembrete e a resposta ao "Confirmar presença" falavam 16h, e a
 * paciente chegava meia hora atrasada para a primeira sessão.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';
import {
  agendamentosDoPaciente,
  atendimentosDePeNoDia,
  diaComVariosAtendimentos,
  horaFalada,
  horariosDistintos,
  listaDeHorarios,
  proximaChegada,
} from './chegada-do-dia.js';
import { CAMPOS_SESSOES, escritasDeSessoes, type CampoDoCartao, type EscritaDeSessao } from './sessoes-para-cartao.js';

const A = SPINE_STATUS.AGENDADO;
const C = SPINE_STATUS.CONFIRMADO;
const ATENDIDO = SPINE_STATUS.ATENDIDO;

/** Açailândia é UTC-3 o ano todo. `hora` local → o instante UTC. */
const epoch = (dia: string, hora: string): number => Math.floor(Date.parse(`${dia}T${hora}:00-03:00`) / 1000);

let seq = 3_000_000;
function atendimento(dia: string, hora: string, trat: number | null, status: number, over: Partial<SpineSchedule> = {}): SpineSchedule {
  const utc = new Date(epoch(dia, hora) * 1000).toISOString();
  return {
    idSchedule: seq++, idTreatment: trat, idStatus: status, statusName: null,
    clientName: 'MARIA APARECIDA', categoryName: 'PROTOCOLO 03 MESES - CERVICAL', physicalTherapist: null,
    dateAttendanceUtc: utc, dateAttendanceLocal: `${dia}T${hora}:00`, dayLocal: dia, timeLocal: hora,
    isBusy: true, requiresManualValidation: false, ...over,
  };
}

/** A paciente do caso real: 03/11 15:30 ATENDIDO + 16:00 CONFIRMADO; 06/11 e 09/11 15:30 e 16:00 AGENDADO. */
function maria(): SpineSchedule[] {
  return [
    atendimento('2026-11-03', '15:30', 125336, ATENDIDO),
    atendimento('2026-11-03', '16:00', 125337, C),
    atendimento('2026-11-06', '15:30', 125336, A),
    atendimento('2026-11-06', '16:00', 125337, A),
    atendimento('2026-11-09', '15:30', 125336, A),
    atendimento('2026-11-09', '16:00', 125337, A),
  ];
}

test('texto dos horários: como a recepção escreve', () => {
  assert.equal(horaFalada('15:30'), '15h30');
  assert.equal(horaFalada('16:00'), '16h');
  assert.equal(horaFalada('09:05'), '9h05');
  assert.equal(listaDeHorarios(['15:30', '16:00']), '15h30 e 16h');
  assert.equal(listaDeHorarios(['15:30', '16:00', '16:30']), '15h30, 16h e 16h30');
  assert.equal(listaDeHorarios(['16:00']), '16h');
});

test('CASO REAL, antes do dia: a chegada de 03/11 é 15h30 (não as 16h do tratamento do cartão)', () => {
  const todas = [atendimento('2026-11-03', '15:30', 125336, A), ...maria().slice(1)];
  const agora = epoch('2026-11-03', '09:00');
  const p = proximaChegada(todas, agora)!;
  assert.equal(p.epoch, epoch('2026-11-03', '15:30'));
  assert.equal(p.jaComecou, false);
  assert.deepEqual(p.horarios, ['15:30', '16:00']);
});

test('CASO REAL, com o 1º já ATENDIDO e o 2º por vir: a chegada continua 15h30 e JÁ COMEÇOU (nada é movido)', () => {
  const p = proximaChegada(maria(), epoch('2026-11-03', '15:40'))!;
  assert.equal(p.epoch, epoch('2026-11-03', '15:30'));
  assert.equal(p.jaComecou, true, 'o campo não pula para 16h no meio da tarde — o gatilho do Kommo leria um valor novo');
  assert.deepEqual(p.horarios, ['16:00']);
});

test('depois da última sessão do dia, a próxima é a chegada do próximo dia (15h30 de 06/11, não 16h)', () => {
  const p = proximaChegada(maria(), epoch('2026-11-03', '17:00'))!;
  assert.equal(p.epoch, epoch('2026-11-06', '15:30'));
  assert.equal(p.jaComecou, false);
});

test('desmarcado no meio: a chegada é o que sobrou de pé; sessão desmarcada ou remarcada nunca conta', () => {
  const s = [
    atendimento('2026-11-06', '15:30', 125336, SPINE_STATUS.DESMARCADO),
    atendimento('2026-11-06', '16:00', 125337, A),
    atendimento('2026-11-06', '16:30', 125337, SPINE_STATUS.REMARCADO),
  ];
  const p = proximaChegada(s, epoch('2026-11-04', '10:00'))!;
  assert.equal(p.epoch, epoch('2026-11-06', '16:00'));
  assert.deepEqual(p.horarios, ['16:00']);
  assert.equal(diaComVariosAtendimentos(s, '2026-11-06'), null, 'um horário só: a mensagem de sempre');
});

test('dia com uma sessão só: nada de "vários"', () => {
  const s = [atendimento('2026-11-09', '16:00', 125337, A)];
  assert.equal(diaComVariosAtendimentos(s, '2026-11-09'), null);
  assert.equal(proximaChegada(s, epoch('2026-11-04', '10:00'))!.epoch, epoch('2026-11-09', '16:00'));
});

test('o mesmo agendamento vindo da agenda E da ficha conta uma vez; dois no mesmo horário são um horário', () => {
  const a = atendimento('2026-11-06', '15:30', 125336, A);
  const dobrado = [a, { ...a }];
  assert.equal(atendimentosDePeNoDia(dobrado, '2026-11-06').length, 1);
  const mesmaHora = [atendimento('2026-11-06', '15:30', 125336, A), atendimento('2026-11-06', '15:30', 125337, A)];
  assert.deepEqual(horariosDistintos(mesmaHora), ['15:30']);
  // dois agendamentos, um horário só: o dia inteiro é confirmado, mas o texto não vira "15h30 e 15h30"
  const v = diaComVariosAtendimentos(mesmaHora, '2026-11-06')!;
  assert.equal(v.atendimentos.length, 2);
  assert.deepEqual(v.horarios, ['15:30']);
});

test('avaliação/retorno no mesmo dia da sessão entra na chegada (mas sozinho não move a ◷ Próxima sessão)', () => {
  const retorno = atendimento('2026-11-10', '15:00', null, A, { categoryName: 'Retorno após tratamento' });
  const sessao = atendimento('2026-11-10', '15:30', 125336, A);
  const p = proximaChegada([retorno, sessao], epoch('2026-11-04', '10:00'))!;
  assert.equal(p.epoch, epoch('2026-11-10', '15:00'));
  const v = diaComVariosAtendimentos([retorno, sessao], '2026-11-10')!;
  assert.equal(v.natureza, 'misto');
  assert.equal(v.chegada, '15:00');
  assert.equal(proximaChegada([retorno], epoch('2026-11-04', '10:00')), null, 'só retorno: não é sessão');
});

test('sessão de pé com data passada e sem desfecho não puxa o campo para o passado (regra de sempre)', () => {
  const s = [atendimento('2026-11-02', '15:30', 125336, A), atendimento('2026-11-06', '15:30', 125336, A)];
  assert.equal(proximaChegada(s, epoch('2026-11-04', '10:00'))!.epoch, epoch('2026-11-06', '15:30'));
});

// ── o campo do cartão ───────────────────────────────────────────────────────────────────────────────

const TRATAMENTOS = [
  { idTreatment: 125336, typeName: 'PROTOCOLO 03 MESES, CERVICAL, CRÔNICO' },
  { idTreatment: 125337, typeName: 'PROTOCOLO 03 MESES, LOMBAR, CRÔNICO' },
];

function entradaDoCartao(over: { agora: number; cartao: number | null; chegadaDoDia?: 'ligado' | 'seco' | 'desligado'; schedules?: SpineSchedule[] }) {
  // as sessões desta paciente carregam o rótulo do protocolo no lugar do id, como a ficha manda
  const schedules = (over.schedules ?? maria()).map((s) => ({
    ...s,
    idTreatment: null,
    categoryName: s.dateAttendanceLocal?.includes('15:30') ? 'PROTOCOLO 03 MESES - CERVICAL' : 'PROTOCOLO 03 MESES - LOMBAR',
  }));
  const campos: Record<string, CampoDoCartao> = {
    [CAMPOS_SESSOES.PROXIMA]: { tipo: 'date_time', valor: over.cartao === null ? null : String(over.cartao) },
  };
  return {
    schedules,
    tratamento: { idTreatment: 125337, local: 'LOMBAR', degree: null, statusName: 'EM ANDAMENTO', created: '2026-09-01T00:00:00Z', category: 'PROTOCOLO 03 MESES' },
    tratamentosDoPaciente: TRATAMENTOS,
    agoraEpoch: over.agora,
    campo: (nome: string) => campos[nome] ?? null,
    chegadaDoDia: over.chegadaDoDia,
    schedulesDoPaciente: schedules,
  };
}
const daProxima = (w: EscritaDeSessao[]) => w.filter((x) => x.campo === CAMPOS_SESSOES.PROXIMA);

test('campo, chave DESLIGADA: segue sendo a sessão do tratamento do cartão (16h) — comportamento de antes, byte a byte', () => {
  const w = daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-03', '09:00'), cartao: null })));
  assert.equal(w.length, 1);
  assert.equal((w[0] as { valor: number }).valor, epoch('2026-11-03', '16:00'));
});

test('campo, chave LIGADA: a ◷ Próxima sessão é a chegada (15h30), somando os dois tratamentos', () => {
  const w = daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-03', '09:00'), cartao: epoch('2026-11-03', '16:00'), chegadaDoDia: 'ligado', schedules: [atendimento('2026-11-03', '15:30', 125336, A), ...maria().slice(1)] })));
  assert.equal(w.length, 1);
  assert.equal((w[0] as { valor: number }).valor, epoch('2026-11-03', '15:30'));
  assert.match(w[0].motivo, /chegada do dia/);
  assert.equal(w[0].soNoPapel, undefined);
});

test('campo, chave LIGADA, o cartão já tem a chegada: nenhuma escrita (sem regravação eterna)', () => {
  const entrada = entradaDoCartao({ agora: epoch('2026-11-03', '09:00'), cartao: epoch('2026-11-03', '15:30'), chegadaDoDia: 'ligado', schedules: [atendimento('2026-11-03', '15:30', 125336, A), ...maria().slice(1)] });
  assert.deepEqual(daProxima(escritasDeSessoes(entrada)), []);
});

test('campo, chave LIGADA, o dia já começou (15h30 ATENDIDO, 16h por vir): NÃO mexe — nem para 16h, nem limpa', () => {
  const w = daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-03', '15:40'), cartao: epoch('2026-11-03', '16:00'), chegadaDoDia: 'ligado' })));
  assert.deepEqual(w, []);
  // e com o cartão vazio também não escreve um horário que já passou
  assert.deepEqual(daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-03', '15:40'), cartao: null, chegadaDoDia: 'ligado' }))), []);
});

test('campo, chave LIGADA, depois do último atendimento do dia: avança para a chegada do próximo dia (06/11 15h30)', () => {
  const w = daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-03', '17:00'), cartao: epoch('2026-11-03', '16:00'), chegadaDoDia: 'ligado' })));
  assert.equal((w[0] as { valor: number }).valor, epoch('2026-11-06', '15:30'));
});

test('campo, chave LIGADA, nenhuma sessão de pé por vir: limpa, como sempre', () => {
  const sem = maria().map((s) => ({ ...s, idStatus: ATENDIDO }));
  const w = daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-10', '09:00'), cartao: epoch('2026-11-09', '16:00'), chegadaDoDia: 'ligado', schedules: sem })));
  assert.equal(w.length, 1);
  assert.equal('limpar' in w[0] && w[0].limpar, true);
});

test('campo, SÓ NO PAPEL: grava o de sempre (16h) e devolve à parte, marcado soNoPapel, o que a chegada gravaria (15h30)', () => {
  const todas = [atendimento('2026-11-03', '15:30', 125336, A), ...maria().slice(1)];
  const w = daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-03', '09:00'), cartao: null, chegadaDoDia: 'seco', schedules: todas })));
  assert.equal(w.length, 2);
  const real = w.find((x) => !x.soNoPapel)!;
  const papel = w.find((x) => x.soNoPapel)!;
  assert.equal((real as { valor: number }).valor, epoch('2026-11-03', '16:00'));
  assert.equal((papel as { valor: number }).valor, epoch('2026-11-03', '15:30'));
  assert.equal(papel.soNoPapel, 'chegada-do-dia');
});

test('HOMÔNIMA: a agenda é agrupada por nome, mas a chegada só sai da ficha (idClient) — o horário da outra "Maria" nunca vira o da paciente', () => {
  const minhaFicha = [atendimento('2026-11-03', '16:00', null, C), atendimento('2026-11-06', '15:30', null, A)];
  const agenda = [
    { ...minhaFicha[0], statusName: 'agenda mais fresca' }, // a mesma sessão, versão da agenda
    atendimento('2026-11-03', '14:00', 999001, A), // OUTRA paciente com o mesmo nome (outro tratamento)
    atendimento('2026-11-03', '15:00', 125336, A), // sessão recém-marcada de um tratamento DESTA paciente
  ];
  const doPaciente = agendamentosDoPaciente(minhaFicha, agenda, [125336, 125337]);
  assert.equal(doPaciente.length, 3);
  assert.equal(doPaciente.find((s) => s.idSchedule === minhaFicha[0].idSchedule)?.statusName, 'agenda mais fresca');
  assert.equal(doPaciente.some((s) => s.idTreatment === 999001), false);
  assert.equal(proximaChegada(doPaciente, epoch('2026-11-03', '09:00'))!.epoch, epoch('2026-11-03', '15:00'));
  // e sem a ficha, nada: não adivinha por nome
  assert.deepEqual(agendamentosDoPaciente([], agenda, [125336]).map((s) => s.idTreatment), [125336]);
});

test('campo, chave LIGADA: sessão de uma homônima que está só em `schedules` não vira a chegada (vale `schedulesDoPaciente`)', () => {
  const minhas = [atendimento('2026-11-03', '15:30', 125336, A), ...maria().slice(1)];
  const deOutra = atendimento('2026-11-03', '14:00', 999001, A, { clientName: 'MARIA APARECIDA' });
  const entrada = entradaDoCartao({ agora: epoch('2026-11-03', '09:00'), cartao: null, chegadaDoDia: 'ligado', schedules: [...minhas, deOutra] });
  assert.ok(entrada.schedulesDoPaciente.some((s) => s.idSchedule === deOutra.idSchedule), 'a homônima está na lista misturada');
  const w = daProxima(escritasDeSessoes({ ...entrada, schedulesDoPaciente: entrada.schedules.filter((s) => s.idSchedule !== deOutra.idSchedule) }));
  assert.equal((w[0] as { valor: number }).valor, epoch('2026-11-03', '15:30'));
});

test('campo, SÓ NO PAPEL, onde as duas fontes concordam (dia com um tratamento só): nada a simular', () => {
  const um = [atendimento('2026-11-09', '16:00', 125337, A)];
  const w = daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-04', '09:00'), cartao: null, chegadaDoDia: 'seco', schedules: um })));
  assert.equal(w.length, 1);
  assert.equal(w[0].soNoPapel, undefined);
});

test('campo, chave LIGADA, lista do paciente CURTA (ficha em cache, sessão nova só na agenda): não apaga a data se o tratamento ainda vê sessão por vir', () => {
  const entrada = entradaDoCartao({ agora: epoch('2026-11-03', '09:00'), cartao: epoch('2026-11-03', '16:00'), chegadaDoDia: 'ligado' });
  const w = daProxima(escritasDeSessoes({ ...entrada, schedulesDoPaciente: [] }));
  assert.deepEqual(w, [], 'nem limpa, nem regrava');
});

test('campo, chave LIGADA, sem `schedulesDoPaciente`: nunca recorre à lista misturada por nome', () => {
  const entrada = entradaDoCartao({ agora: epoch('2026-11-03', '09:00'), cartao: null, chegadaDoDia: 'ligado' });
  const { schedulesDoPaciente: _fora, ...semLista } = entrada;
  assert.deepEqual(daProxima(escritasDeSessoes(semLista)), []);
});

test('campo, SÓ NO PAPEL: se o cartão já tem a chegada mas a escrita real (do tratamento) vai desfazê-la, o papel MOSTRA a chegada — o vai-e-volta não se esconde', () => {
  const todas = [atendimento('2026-11-03', '15:30', 125336, A), ...maria().slice(1)];
  const w = daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-03', '09:00'), cartao: epoch('2026-11-03', '15:30'), chegadaDoDia: 'seco', schedules: todas })));
  assert.equal(w.length, 2);
  assert.equal((w.find((x) => !x.soNoPapel) as { valor: number }).valor, epoch('2026-11-03', '16:00'));
  assert.equal((w.find((x) => x.soNoPapel) as { valor: number }).valor, epoch('2026-11-03', '15:30'));
});
