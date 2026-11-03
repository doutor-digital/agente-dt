/**
 * A «◷ Próxima sessão» do cartão = a chegada do paciente (PR B de 2; a resposta ao botão é o PR A).
 *
 * Caso real (Açailândia, 03/11/2026, cartão 24830668): Maria Aparecida (idClient 353493) tem DOIS tratamentos, 125336 e 125337,
 * com sessões em sequência no mesmo dia — 03/11, 06/11 e 09/11, 15h30 (125336) e 16h (125337). O cartão guarda o 125337 e a
 * ◷ Próxima sessão das 16h; o lembrete do robô do Kommo lê esse campo.
 *
 * Os dois bloqueantes do sênior no #195 viraram teste aqui: cartão em ALTA/FINALIZADO que recebia a sessão de OUTRO tratamento
 * (`alta`), e a consulta/avaliação virando horário do campo de SESSÃO (`aval`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';
import { agendamentosSegurosDoPaciente, chegadaDoCartao } from './chegada-do-dia.js';
import { CAMPOS_SESSOES, escritasDeSessoes, type CampoDoCartao, type EscritaDeSessao } from './sessoes-para-cartao.js';
import { escolherAgendamento } from './resposta-ao-lembrete.js';
import { _semearParaTeste } from './automacoes-estado.js';
import { AUTOMACOES, verificarCatalogo } from './automacoes.js';

const A = SPINE_STATUS.AGENDADO;
const C = SPINE_STATUS.CONFIRMADO;
const ATENDIDO = SPINE_STATUS.ATENDIDO;

/** Açailândia é UTC-3 o ano todo. `hora` local → o instante UTC. */
const epoch = (dia: string, hora: string): number => Math.floor(Date.parse(`${dia}T${hora}:00-03:00`) / 1000);

let seq = 4_000_000;
function atendimento(dia: string, hora: string, trat: number | null, status: number, over: Partial<SpineSchedule> = {}): SpineSchedule {
  const utc = new Date(epoch(dia, hora) * 1000).toISOString();
  return {
    idSchedule: seq++, idTreatment: trat, idStatus: status, statusName: null,
    clientName: 'MARIA APARECIDA', categoryName: 'PROTOCOLO 03 MESES - CERVICAL', physicalTherapist: null,
    dateAttendanceUtc: utc, dateAttendanceLocal: `${dia}T${hora}:00`, dayLocal: dia, timeLocal: hora,
    isBusy: true, requiresManualValidation: false, ...over,
  };
}

/** 03/11 15:30 ATENDIDO + 16:00 CONFIRMADO; 06/11 e 09/11 15:30 e 16:00 AGENDADO. */
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

// ── chegadaDoCartao ──────────────────────────────────────────────────────────────────────────────

test('CASO REAL, antes do dia: a âncora é a das 16h do tratamento do cartão; a chegada, a das 15h30 (sessões em sequência)', () => {
  const todas = [atendimento('2026-11-03', '15:30', 125336, A), ...maria().slice(1)];
  const c = chegadaDoCartao(todas, epoch('2026-11-03', '16:00'), epoch('2026-11-03', '09:00'))!;
  assert.equal(c.epoch, epoch('2026-11-03', '15:30'));
  assert.equal(c.jaComecou, false);
  assert.equal(c.dia, '2026-11-03');
});

test('com o 1º já ATENDIDO e o 2º por vir: a chegada continua 15h30 e JÁ COMEÇOU (o campo não é movido)', () => {
  const c = chegadaDoCartao(maria(), epoch('2026-11-03', '16:00'), epoch('2026-11-03', '15:40'))!;
  assert.equal(c.epoch, epoch('2026-11-03', '15:30'));
  assert.equal(c.jaComecou, true);
});

test('depois da última sessão do dia, a âncora é a do dia seguinte e a chegada é a 15h30 de 06/11, não 16h', () => {
  const c = chegadaDoCartao(maria(), epoch('2026-11-06', '16:00'), epoch('2026-11-03', '17:00'))!;
  assert.equal(c.epoch, epoch('2026-11-06', '15:30'));
  assert.equal(c.jaComecou, false);
});

test('desmarcado no meio: sessão desmarcada ou remarcada não é da sequência; a chegada é a âncora', () => {
  const s = [
    atendimento('2026-11-06', '15:30', 125336, SPINE_STATUS.DESMARCADO),
    atendimento('2026-11-06', '16:00', 125337, A),
    atendimento('2026-11-06', '15:00', 125336, SPINE_STATUS.REMARCADO),
  ];
  assert.equal(chegadaDoCartao(s, epoch('2026-11-06', '16:00'), epoch('2026-11-04', '10:00'))!.epoch, epoch('2026-11-06', '16:00'));
});

test('dia com uma sessão só: a chegada é ela', () => {
  const s = [atendimento('2026-11-09', '16:00', 125337, A)];
  assert.equal(chegadaDoCartao(s, epoch('2026-11-09', '16:00'), epoch('2026-11-04', '10:00'))!.epoch, epoch('2026-11-09', '16:00'));
});

test('BLOQUEANTE aval: consulta/avaliação às 08h e sessão às 16h — o campo da SESSÃO nunca recebe o horário da consulta', () => {
  const aval = atendimento('2026-11-04', '08:00', null, A, { categoryName: 'AVALIAÇÃO' });
  const sess = atendimento('2026-11-04', '16:00', 125337, A, { categoryName: 'PROTOCOLO 03 MESES - LOMBAR' });
  const c = chegadaDoCartao([aval, sess], epoch('2026-11-04', '16:00'), epoch('2026-11-03', '20:00'))!;
  assert.equal(c.epoch, epoch('2026-11-04', '16:00'));
  // e o lembrete de sessão (que lê o campo) acha a sessão: sem "sessão às 08:00" que ninguém confirma
  const achou = escolherAgendamento({ schedules: [aval, sess], tipo: 'sessao', quandoEpoch: c.epoch, idTreatment: 125337, tz: 'America/Fortaleza' });
  assert.equal(achou?.idSchedule, sess.idSchedule);
  // mesmo com o retorno colado na sessão (15h30 e 16h): o campo fica na sessão
  const colado = atendimento('2026-11-04', '15:30', null, A, { categoryName: 'Retorno após tratamento' });
  assert.equal(chegadaDoCartao([colado, sess], epoch('2026-11-04', '16:00'), epoch('2026-11-03', '20:00'))!.epoch, epoch('2026-11-04', '16:00'));
});

test('uma sessão de manhã e outra à noite NÃO são a mesma viagem: a chegada da âncora das 18h é 18h (não 8h)', () => {
  const s = [atendimento('2026-11-06', '08:00', 125336, A), atendimento('2026-11-06', '18:00', 125337, A)];
  assert.equal(chegadaDoCartao(s, epoch('2026-11-06', '18:00'), epoch('2026-11-05', '10:00'))!.epoch, epoch('2026-11-06', '18:00'));
  // a manhã que já foi atendida e a sessão marcada para a tarde: o campo avança para a da tarde (não congela em "já começou")
  const s2 = [atendimento('2026-11-06', '08:00', 125336, ATENDIDO), atendimento('2026-11-06', '18:00', 125337, A)];
  const c = chegadaDoCartao(s2, epoch('2026-11-06', '18:00'), epoch('2026-11-06', '12:00'))!;
  assert.equal(c.epoch, epoch('2026-11-06', '18:00'));
  assert.equal(c.jaComecou, false);
});

test('três sessões em sequência (15h30, 16h, 16h30; âncora 16h30): a chegada é a primeira da corrente', () => {
  const s = [atendimento('2026-11-06', '15:30', 1, A), atendimento('2026-11-06', '16:00', 2, A), atendimento('2026-11-06', '16:30', 3, A)];
  assert.equal(chegadaDoCartao(s, epoch('2026-11-06', '16:30'), epoch('2026-11-05', '10:00'))!.epoch, epoch('2026-11-06', '15:30'));
});

test('âncora que não está na lista do paciente (ficha em cache): null — quem chama volta ao valor do tratamento', () => {
  assert.equal(chegadaDoCartao([], epoch('2026-11-06', '16:00'), epoch('2026-11-05', '10:00')), null);
  assert.equal(chegadaDoCartao(maria(), epoch('2026-11-06', '17:00'), epoch('2026-11-05', '10:00')), null);
});

// ── a lista segura do paciente ───────────────────────────────────────────────────────────────────

test('HOMÔNIMA: a agenda é agrupada por nome, mas só entra o que a ficha conhece ou carrega o id de tratamento DESTE paciente', () => {
  const minhaFicha = [atendimento('2026-11-03', '16:00', null, C), atendimento('2026-11-06', '15:30', null, A)];
  const agenda = [
    { ...minhaFicha[0], statusName: 'agenda mais fresca' }, // a mesma sessão, versão da agenda
    atendimento('2026-11-03', '14:00', 999001, A), // OUTRA paciente com o mesmo nome (outro tratamento)
    atendimento('2026-11-03', '15:00', 125336, A), // sessão recém-marcada de um tratamento DESTE paciente
  ];
  const seguros = agendamentosSegurosDoPaciente(minhaFicha, agenda, [125336, 125337]);
  assert.equal(seguros.length, 3);
  assert.equal(seguros.find((s) => s.idSchedule === minhaFicha[0].idSchedule)?.statusName, 'agenda mais fresca');
  assert.equal(seguros.some((s) => s.idTreatment === 999001), false);
  // sem a ficha, só o que carrega o id do tratamento: não adivinha por nome
  assert.deepEqual(agendamentosSegurosDoPaciente([], agenda, [125336]).map((s) => s.idTreatment), [125336]);
});

// ── o campo do cartão ────────────────────────────────────────────────────────────────────────────

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
const valor = (w: EscritaDeSessao) => (w as { valor: number }).valor;
const ANTES_DO_DIA = [atendimento('2026-11-03', '15:30', 125336, A), ...maria().slice(1)];

test('campo, chave DESLIGADA: segue sendo a sessão do tratamento do cartão (16h) — comportamento de hoje, byte a byte', () => {
  const w = daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-03', '09:00'), cartao: null })));
  assert.equal(w.length, 1);
  assert.equal(valor(w[0]), epoch('2026-11-03', '16:00'));
});

test('campo, chave LIGADA: a ◷ Próxima sessão é a chegada (15h30), somando os dois tratamentos', () => {
  const w = daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-03', '09:00'), cartao: epoch('2026-11-03', '16:00'), chegadaDoDia: 'ligado', schedules: ANTES_DO_DIA })));
  assert.equal(w.length, 1);
  assert.equal(valor(w[0]), epoch('2026-11-03', '15:30'));
  assert.match(w[0].motivo, /chegada do dia/);
  assert.equal(w[0].soNoPapel, undefined);
});

test('campo, chave LIGADA, o cartão já tem a chegada: nenhuma escrita (sem regravação eterna)', () => {
  const entrada = entradaDoCartao({ agora: epoch('2026-11-03', '09:00'), cartao: epoch('2026-11-03', '15:30'), chegadaDoDia: 'ligado', schedules: ANTES_DO_DIA });
  assert.deepEqual(daProxima(escritasDeSessoes(entrada)), []);
});

test('campo, chave LIGADA, o dia já começou (15h30 ATENDIDO, 16h por vir): NÃO mexe — nem para 16h, nem limpa', () => {
  assert.deepEqual(daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-03', '15:40'), cartao: epoch('2026-11-03', '16:00'), chegadaDoDia: 'ligado' }))), []);
  // cartão VAZIO (ou com data de outro dia): não há gatilho armado a proteger, então recebe a próxima sessão (16h), nunca a das 15h30 que já foi
  const vazio = daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-03', '15:40'), cartao: null, chegadaDoDia: 'ligado' })));
  assert.equal(vazio.length, 1);
  assert.equal(valor(vazio[0]), epoch('2026-11-03', '16:00'));
  const ontem = daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-03', '15:40'), cartao: epoch('2026-11-02', '15:30'), chegadaDoDia: 'ligado' })));
  assert.equal(valor(ontem[0]), epoch('2026-11-03', '16:00'));
});

test('campo, chave LIGADA, depois do último atendimento do dia: avança para a chegada do próximo dia (06/11 15h30)', () => {
  const w = daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-03', '17:00'), cartao: epoch('2026-11-03', '16:00'), chegadaDoDia: 'ligado' })));
  assert.equal(valor(w[0]), epoch('2026-11-06', '15:30'));
});

test('campo, chave LIGADA, nenhuma sessão de pé por vir: limpa, como sempre', () => {
  const sem = maria().map((s) => ({ ...s, idStatus: ATENDIDO }));
  const w = daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-10', '09:00'), cartao: epoch('2026-11-09', '16:00'), chegadaDoDia: 'ligado', schedules: sem })));
  assert.equal(w.length, 1);
  assert.equal('limpar' in w[0] && w[0].limpar, true);
});

test('BLOQUEANTE alta: cartão FINALIZADO (tratamento antigo) e paciente com sessão por vir de OUTRO tratamento — limpa/mantém vazio, nunca recebe a do outro', () => {
  const velhas = [atendimento('2026-06-01', '10:00', null, ATENDIDO, { categoryName: 'PROTOCOLO 03 MESES - LOMBAR' }), atendimento('2026-06-05', '10:00', null, ATENDIDO, { categoryName: 'PROTOCOLO 03 MESES - LOMBAR' })];
  const nova = [atendimento('2026-11-05', '15:30', null, A, { categoryName: 'PROTOCOLO 06 MESES - CERVICAL' })];
  const ficha = [...velhas, ...nova];
  const base = (cartao: number | null, modo: 'desligado' | 'seco' | 'ligado') => ({
    schedules: ficha,
    tratamento: { idTreatment: 120000, local: null, degree: null, statusName: 'FINALIZADO', created: null },
    tratamentosDoPaciente: [
      { idTreatment: 120000, typeName: 'PROTOCOLO 03 MESES, LOMBAR, CRÔNICO' },
      { idTreatment: 130000, typeName: 'PROTOCOLO 06 MESES, CERVICAL, CRÔNICO' },
    ],
    agoraEpoch: epoch('2026-11-03', '09:00'),
    campo: (n: string) => (n === CAMPOS_SESSOES.PROXIMA ? ({ tipo: 'date_time', valor: cartao === null ? null : String(cartao) } as CampoDoCartao) : null),
    chegadaDoDia: modo,
    schedulesDoPaciente: ficha,
  });
  for (const modo of ['desligado', 'seco', 'ligado'] as const) {
    assert.deepEqual(daProxima(escritasDeSessoes(base(null, modo))), [], `cartão vazio, ${modo}: nada é escrito`);
    const w = daProxima(escritasDeSessoes(base(epoch('2026-10-20', '10:00'), modo)));
    assert.equal(w.length, 1, `cartão com data velha, ${modo}: limpa, como antes`);
    assert.equal('limpar' in w[0] && w[0].limpar, true);
    assert.equal(w[0].soNoPapel, undefined);
  }
});

test('campo, chave LIGADA, lista do paciente CURTA (ficha em cache): volta ao valor do tratamento — não apaga a data nem chuta', () => {
  const entrada = entradaDoCartao({ agora: epoch('2026-11-03', '09:00'), cartao: null, chegadaDoDia: 'ligado' });
  const w = daProxima(escritasDeSessoes({ ...entrada, schedulesDoPaciente: [] }));
  assert.equal(valor(w[0]), epoch('2026-11-03', '16:00'));
  assert.match(w[0].motivo, /chegada do dia não calculada/, 'o log não finge que foi a chegada');
});

test('campo, chave LIGADA, sem `schedulesDoPaciente`: nunca recorre à lista misturada por nome (valor do tratamento)', () => {
  const { schedulesDoPaciente: _fora, ...semLista } = entradaDoCartao({ agora: epoch('2026-11-03', '09:00'), cartao: null, chegadaDoDia: 'ligado', schedules: ANTES_DO_DIA });
  assert.equal(valor(daProxima(escritasDeSessoes(semLista))[0]), epoch('2026-11-03', '16:00'));
});

test('campo, chave LIGADA: retorno ainda AGENDADO sem baixa às 9h e sessão às 16h — o campo vai para a sessão (não fica congelado)', () => {
  const retorno = atendimento('2026-11-03', '09:00', null, A, { categoryName: 'Retorno após tratamento' });
  const sessao = atendimento('2026-11-03', '16:00', 125337, A);
  const entrada = entradaDoCartao({ agora: epoch('2026-11-03', '10:00'), cartao: null, chegadaDoDia: 'ligado', schedules: [retorno, sessao] });
  const w = daProxima(escritasDeSessoes({ ...entrada, schedulesDoPaciente: [retorno, sessao] }));
  assert.equal(valor(w[0]), epoch('2026-11-03', '16:00'));
});

test('campo, SÓ NO PAPEL: grava o de sempre (16h) e devolve à parte, marcado soNoPapel, o que a chegada gravaria (15h30)', () => {
  const w = daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-03', '09:00'), cartao: null, chegadaDoDia: 'seco', schedules: ANTES_DO_DIA })));
  assert.equal(w.length, 2);
  assert.equal(valor(w.find((x) => !x.soNoPapel)!), epoch('2026-11-03', '16:00'));
  const papel = w.find((x) => x.soNoPapel)!;
  assert.equal(valor(papel), epoch('2026-11-03', '15:30'));
  assert.equal(papel.soNoPapel, 'chegada-do-dia');
});

test('campo, SÓ NO PAPEL, onde as duas fontes concordam (dia com um tratamento só): nada a simular', () => {
  const um = [atendimento('2026-11-09', '16:00', 125337, A)];
  const w = daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-04', '09:00'), cartao: null, chegadaDoDia: 'seco', schedules: um })));
  assert.equal(w.length, 1);
  assert.equal(w[0].soNoPapel, undefined);
});

test('campo, SÓ NO PAPEL: se o cartão já tem a chegada mas a escrita real (do tratamento) vai desfazê-la, o papel MOSTRA a chegada', () => {
  const w = daProxima(escritasDeSessoes(entradaDoCartao({ agora: epoch('2026-11-03', '09:00'), cartao: epoch('2026-11-03', '15:30'), chegadaDoDia: 'seco', schedules: ANTES_DO_DIA })));
  assert.equal(w.length, 2);
  assert.equal(valor(w.find((x) => !x.soNoPapel)!), epoch('2026-11-03', '16:00'));
  assert.equal(valor(w.find((x) => x.soNoPapel)!), epoch('2026-11-03', '15:30'));
});

test('catálogo: a chave chegada-do-dia existe, nasce desligada e tem modo seco; o catálogo segue válido', () => {
  _semearParaTeste([]);
  const a = AUTOMACOES.find((x) => x.id === 'chegada-do-dia')!;
  assert.equal(a.chave, 'CHEGADA_DO_DIA_SLUGS');
  assert.equal(a.quandoVazio, 'desligado');
  assert.equal(a.temSeco, true);
  assert.match(a.pegadinha ?? '', /LIGAR À NOITE, NUMA UNIDADE, PRIMEIRO SÓ NO PAPEL/);
  assert.deepEqual(verificarCatalogo(), []);
});
