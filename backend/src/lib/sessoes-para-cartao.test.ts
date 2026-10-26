/**
 * Sessões e tratamento no cartão.
 *
 * Os riscos que estes testes prendem: contar desmarcação ou avaliação como sessão (o tratamento
 * pareceria maior que é), gravar ZERO quando só não temos a agenda do tratamento em mãos, deixar
 * uma "próxima sessão" no passado, e reescrever no Kommo o que não mudou (cada escrita é uma
 * chamada; 40 pacientes × 10 campos × a cada 15 min estouraria a cota).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';
import {
  CAMPOS_SESSOES, acharCampoDeSessao, diaParaTexto, escritasDeSessoes, protocoloDoTipo, resumirSessoes, separarCiclo,
  type CampoDoCartao, type TratamentoDaFicha,
} from './sessoes-para-cartao.js';

const TRAT = 777;
const AGORA = Date.parse('2026-10-02T12:00:00Z') / 1000;

let seq = 100;
function sessao(over: Partial<SpineSchedule> & { dia: string }): SpineSchedule {
  const { dia, ...resto } = over;
  return {
    idSchedule: seq++, idTreatment: TRAT, idStatus: SPINE_STATUS.ATENDIDO, statusName: 'ATENDIDO',
    clientName: 'Maria', categoryName: 'Sessão', physicalTherapist: 'Dra. Ana',
    dateAttendanceUtc: `${dia}T13:00:00Z`, dateAttendanceLocal: `${dia}T10:00`, dayLocal: dia, timeLocal: '10:00',
    isBusy: true, requiresManualValidation: false, ...resto,
  };
}

const AGENDA: SpineSchedule[] = [
  // a avaliação e o retorno não são sessão, mesmo com o idTreatment do tratamento
  sessao({ dia: '2026-08-01', categoryName: 'AVALIAÇÃO' }),
  sessao({ dia: '2026-09-01', categoryName: 'Retorno após tratamento' }),
  // sessões do tratamento
  sessao({ dia: '2026-09-10' }),
  sessao({ dia: '2026-09-17' }),
  sessao({ dia: '2026-09-24' }),
  sessao({ dia: '2026-09-27', idStatus: SPINE_STATUS.NAO_COMPARECEU, statusName: 'NÃO COMPARECEU' }),
  sessao({ dia: '2026-10-06', idStatus: SPINE_STATUS.AGENDADO, statusName: 'AGENDADO' }),
  sessao({ dia: '2026-10-09', idStatus: SPINE_STATUS.CONFIRMADO, statusName: 'CONFIRMADO' }),
  // não contam: desmarcada, remarcada, e agendada que já passou sem desfecho
  sessao({ dia: '2026-10-13', idStatus: SPINE_STATUS.DESMARCADO, statusName: 'DESMARCADO' }),
  sessao({ dia: '2026-10-14', idStatus: SPINE_STATUS.REMARCADO, statusName: 'REMARCADO' }),
  sessao({ dia: '2026-09-30', idStatus: SPINE_STATUS.AGENDADO, statusName: 'AGENDADO' }),
  // de OUTRO tratamento
  sessao({ dia: '2026-10-07', idTreatment: 999, idStatus: SPINE_STATUS.AGENDADO }),
];

test('conta cada coisa pelo desfecho — avaliação, desmarcada, remarcada e outro tratamento ficam de fora', () => {
  const r = resumirSessoes(AGENDA, TRAT, AGORA)!;
  assert.equal(r.realizadas, 3);
  assert.equal(r.faltas, 1);
  assert.equal(r.marcadas, 2);
  assert.equal(r.previstas, 6);
});

test('próxima é a primeira marcada por vir; última é a última ATENDIDA', () => {
  const r = resumirSessoes(AGENDA, TRAT, AGORA)!;
  assert.equal(r.proxima, Date.parse('2026-10-06T13:00:00Z') / 1000);
  assert.equal(r.ultima?.dia, '2026-09-24');
});

test('a mesma sessão em duas listas conta uma vez só', () => {
  const dobrada = [...AGENDA, ...AGENDA];
  const r = resumirSessoes(dobrada, TRAT, AGORA)!;
  assert.equal(r.realizadas, 3);
  assert.equal(r.previstas, 6);
});

test('histórico sem idTreatment (é como a ficha chega): conta só o que é posterior à criação do tratamento', () => {
  const semId = (dia: string, over: Partial<SpineSchedule> = {}) => sessao({ dia, idTreatment: null, ...over });
  const historico = [
    semId('2026-03-05'), semId('2026-03-12'),                    // ciclo anterior, antes da alta
    semId('2026-09-10'), semId('2026-09-17'),                    // este tratamento
    semId('2026-09-27', { idStatus: SPINE_STATUS.NAO_COMPARECEU }),
    semId('2026-10-06', { idStatus: SPINE_STATUS.AGENDADO }),
  ];
  const r = resumirSessoes(historico, TRAT, AGORA, '2026-09-05T12:00:00Z')!;
  assert.equal(r.realizadas, 2);
  assert.equal(r.faltas, 1);
  assert.equal(r.marcadas, 1);
  // sem data de criação não dá pra separar os ciclos: conta tudo, como o painel da franquia já faz
  assert.equal(resumirSessoes(historico, TRAT, AGORA, null)!.realizadas, 4);
  // sessão com idTreatment de OUTRO tratamento nunca conta, com ou sem data de criação
  assert.equal(resumirSessoes([semId('2026-09-10', { idTreatment: 999 })], TRAT, AGORA, null), null);
});

test('sem nenhuma sessão do tratamento na lista, devolve null — não afirma zero', () => {
  assert.equal(resumirSessoes([sessao({ dia: '2026-09-10', idTreatment: 1 })], TRAT, AGORA), null);
  assert.equal(resumirSessoes(AGENDA, null, AGORA), null);
});

test('dia vira texto dd/mm/aaaa', () => {
  assert.equal(diaParaTexto('2026-09-24'), '24/09/2026');
  assert.equal(diaParaTexto(null), null);
  assert.equal(diaParaTexto('lixo'), null);
});

// --- o planejador ---

/** Conta de Petrópolis/Serra: Última sessão é TEXTO, Próxima é data. Campo nenhum preenchido. */
function conta(valores: Record<string, string | null> = {}, tipos: Record<string, string> = {}) {
  const padrao: Record<string, string> = {
    [CAMPOS_SESSOES.PREVISTAS]: 'numeric', [CAMPOS_SESSOES.REALIZADAS]: 'numeric', [CAMPOS_SESSOES.MARCADAS]: 'numeric',
    [CAMPOS_SESSOES.FALTAS]: 'numeric', [CAMPOS_SESSOES.PROXIMA]: 'date', [CAMPOS_SESSOES.ULTIMA]: 'text',
    [CAMPOS_SESSOES.LOCAL]: 'text', [CAMPOS_SESSOES.GRAU]: 'text', [CAMPOS_SESSOES.STATUS_TRAT]: 'text', [CAMPOS_SESSOES.ID_TRAT]: 'numeric',
    ...tipos,
  };
  return (nome: string): CampoDoCartao | null => (nome in padrao ? { tipo: padrao[nome]!, valor: valores[nome] ?? null } : null);
}

const TRATAMENTO = { idTreatment: TRAT, local: 'LOMBAR', degree: 'CRÔNICO', statusName: 'EM ANDAMENTO', created: null as string | null };
const acha = (l: ReturnType<typeof escritasDeSessoes>, c: string) => l.find((x) => x.campo === c);

test('cartão vazio: grava tudo, com o tipo certo de cada campo', () => {
  const w = escritasDeSessoes({ schedules: AGENDA, tratamento: TRATAMENTO, agoraEpoch: AGORA, campo: conta() });
  assert.equal(acha(w, CAMPOS_SESSOES.REALIZADAS)?.limpar, undefined);
  assert.deepEqual(
    Object.fromEntries(w.map((x) => [x.campo, 'valor' in x ? x.valor : null])),
    {
      [CAMPOS_SESSOES.ID_TRAT]: TRAT,
      [CAMPOS_SESSOES.LOCAL]: 'LOMBAR',
      [CAMPOS_SESSOES.GRAU]: 'CRÔNICO',
      [CAMPOS_SESSOES.STATUS_TRAT]: 'EM ANDAMENTO',
      [CAMPOS_SESSOES.REALIZADAS]: 3,
      [CAMPOS_SESSOES.FALTAS]: 1,
      [CAMPOS_SESSOES.MARCADAS]: 2,
      [CAMPOS_SESSOES.PREVISTAS]: 6,
      [CAMPOS_SESSOES.PROXIMA]: Date.parse('2026-10-06T13:00:00Z') / 1000,
      [CAMPOS_SESSOES.ULTIMA]: '24/09/2026',
    },
  );
});

test('o que não mudou não é reescrito (e zero é um valor, não ausência)', () => {
  const valores = {
    [CAMPOS_SESSOES.ID_TRAT]: String(TRAT), [CAMPOS_SESSOES.LOCAL]: 'lombar', [CAMPOS_SESSOES.GRAU]: 'CRÔNICO', [CAMPOS_SESSOES.STATUS_TRAT]: 'EM ANDAMENTO',
    [CAMPOS_SESSOES.REALIZADAS]: '3', [CAMPOS_SESSOES.FALTAS]: '1', [CAMPOS_SESSOES.MARCADAS]: '2', [CAMPOS_SESSOES.PREVISTAS]: '6',
    [CAMPOS_SESSOES.PROXIMA]: String(Date.parse('2026-10-06T13:00:00Z') / 1000), [CAMPOS_SESSOES.ULTIMA]: '24/09/2026',
  };
  assert.deepEqual(escritasDeSessoes({ schedules: AGENDA, tratamento: TRATAMENTO, agoraEpoch: AGORA, campo: conta(valores) }), []);

  // faltas = 0 num cartão vazio é informação ("nenhuma falta"), então grava
  const semFalta = AGENDA.filter((s) => s.idStatus !== SPINE_STATUS.NAO_COMPARECEU);
  const w = escritasDeSessoes({ schedules: semFalta, tratamento: TRATAMENTO, agoraEpoch: AGORA, campo: conta() });
  assert.equal((acha(w, CAMPOS_SESSOES.FALTAS) as { valor: number }).valor, 0);
});

test('o contador velho é corrigido (a franquia vence)', () => {
  const w = escritasDeSessoes({ schedules: AGENDA, tratamento: TRATAMENTO, agoraEpoch: AGORA, campo: conta({ [CAMPOS_SESSOES.REALIZADAS]: '1' }) });
  assert.equal((acha(w, CAMPOS_SESSOES.REALIZADAS) as { valor: number }).valor, 3);
});

test('sem sessão por vir, a "próxima" que ficou no passado é LIMPA; cartão sem ela não gera escrita', () => {
  const semFutura = AGENDA.filter((s) => s.idStatus !== SPINE_STATUS.AGENDADO && s.idStatus !== SPINE_STATUS.CONFIRMADO);
  const velha = conta({ [CAMPOS_SESSOES.PROXIMA]: String(Date.parse('2026-09-28T13:00:00Z') / 1000) });
  const limpa = acha(escritasDeSessoes({ schedules: semFutura, tratamento: TRATAMENTO, agoraEpoch: AGORA, campo: velha }), CAMPOS_SESSOES.PROXIMA);
  assert.equal(limpa?.limpar, true);
  assert.equal(acha(escritasDeSessoes({ schedules: semFutura, tratamento: TRATAMENTO, agoraEpoch: AGORA, campo: conta() }), CAMPOS_SESSOES.PROXIMA), undefined);
});

test('sem a agenda do tratamento em mãos: grava o que é do tratamento, não inventa contador zerado', () => {
  const w = escritasDeSessoes({ schedules: [], tratamento: TRATAMENTO, agoraEpoch: AGORA, campo: conta() });
  assert.deepEqual(w.map((x) => x.campo).sort(), [CAMPOS_SESSOES.GRAU, CAMPOS_SESSOES.ID_TRAT, CAMPOS_SESSOES.LOCAL, CAMPOS_SESSOES.STATUS_TRAT].sort());
});

test('sem tratamento (ou sem id dele) não escreve nada', () => {
  assert.deepEqual(escritasDeSessoes({ schedules: AGENDA, tratamento: null, agoraEpoch: AGORA, campo: conta() }), []);
  assert.deepEqual(escritasDeSessoes({ schedules: AGENDA, tratamento: { ...TRATAMENTO, idTreatment: null }, agoraEpoch: AGORA, campo: conta() }), []);
});

test('campo que a conta não tem é pulado em silêncio', () => {
  const soNumeros = (nome: string) => (nome === CAMPOS_SESSOES.REALIZADAS ? { tipo: 'numeric', valor: null } : null);
  const w = escritasDeSessoes({ schedules: AGENDA, tratamento: TRATAMENTO, agoraEpoch: AGORA, campo: soNumeros });
  assert.deepEqual(w.map((x) => x.campo), [CAMPOS_SESSOES.REALIZADAS]);
});

test('onde "Última sessão" é campo de DATA, grava a data e não o texto', () => {
  const w = escritasDeSessoes({ schedules: AGENDA, tratamento: TRATAMENTO, agoraEpoch: AGORA, campo: conta({}, { [CAMPOS_SESSOES.ULTIMA]: 'date' }) });
  const u = acha(w, CAMPOS_SESSOES.ULTIMA) as { tipo: string; valor: number };
  assert.equal(u.tipo, 'date');
  assert.equal(u.valor, Date.parse('2026-09-24T13:00:00Z') / 1000);
});

test('campo de tipo incompatível é pulado, em vez de dar 400 do Kommo a cada varredura', () => {
  // Grau virou seleção, Próxima virou texto, Realizadas virou seleção: nada disso aceita o que mandaríamos
  const w = escritasDeSessoes({
    schedules: AGENDA, tratamento: TRATAMENTO, agoraEpoch: AGORA,
    campo: conta({}, { [CAMPOS_SESSOES.GRAU]: 'select', [CAMPOS_SESSOES.PROXIMA]: 'text', [CAMPOS_SESSOES.REALIZADAS]: 'select' }),
  });
  assert.equal(acha(w, CAMPOS_SESSOES.GRAU), undefined);
  assert.equal(acha(w, CAMPOS_SESSOES.PROXIMA), undefined);
  assert.equal(acha(w, CAMPOS_SESSOES.REALIZADAS), undefined);
  // o resto, que tem tipo certo, continua saindo
  assert.ok(acha(w, CAMPOS_SESSOES.FALTAS));
  assert.ok(acha(w, CAMPOS_SESSOES.LOCAL));
});

test('campo só de DIA não é regravado a cada varredura; campo com hora, sim, se a hora mudou', () => {
  const sessao13h = Date.parse('2026-10-06T13:00:00Z') / 1000;
  const meiaNoiteDoDia = Date.parse('2026-10-06T03:00:00Z') / 1000; // 00:00 em Brasília: como o Kommo guarda um `date`
  const soDia = escritasDeSessoes({ schedules: AGENDA, tratamento: TRATAMENTO, agoraEpoch: AGORA, campo: conta({ [CAMPOS_SESSOES.PROXIMA]: String(meiaNoiteDoDia) }, { [CAMPOS_SESSOES.PROXIMA]: 'date' }) });
  assert.equal(acha(soDia, CAMPOS_SESSOES.PROXIMA), undefined);
  // o dia seguinte é outra sessão, mesmo no campo só de dia
  const diaErrado = escritasDeSessoes({ schedules: AGENDA, tratamento: TRATAMENTO, agoraEpoch: AGORA, campo: conta({ [CAMPOS_SESSOES.PROXIMA]: String(meiaNoiteDoDia - 86_400) }, { [CAMPOS_SESSOES.PROXIMA]: 'date' }) });
  assert.equal((acha(diaErrado, CAMPOS_SESSOES.PROXIMA) as { valor: number }).valor, sessao13h);
  // com hora (date_time), 10 h de diferença é remarcação
  const comHora = escritasDeSessoes({ schedules: AGENDA, tratamento: TRATAMENTO, agoraEpoch: AGORA, campo: conta({ [CAMPOS_SESSOES.PROXIMA]: String(sessao13h - 36_000) }, { [CAMPOS_SESSOES.PROXIMA]: 'date_time' }) });
  assert.equal((acha(comHora, CAMPOS_SESSOES.PROXIMA) as { valor: number }).valor, sessao13h);
});

test('os dois campos renomeados são achados pelo nome novo ou pelo antigo; o novo vence', () => {
  const chave = (n: string) => n.toLowerCase();
  const soAntigo = new Map([['# sessões marcadas', 'antigo'], ['# sessões previstas', 'antigo']]);
  assert.equal(acharCampoDeSessao(soAntigo, CAMPOS_SESSOES.MARCADAS, chave), 'antigo');
  assert.equal(acharCampoDeSessao(soAntigo, CAMPOS_SESSOES.PREVISTAS, chave), 'antigo');
  const ambos = new Map([['# sessões agendadas (por vir)', 'novo'], ['# sessões marcadas', 'antigo']]);
  assert.equal(acharCampoDeSessao(ambos, CAMPOS_SESSOES.MARCADAS, chave), 'novo');
  // campo sem nome antigo não ganha plano B, e conta sem nenhum dos dois devolve nada
  assert.equal(acharCampoDeSessao(new Map([['# sessões realizadas', 'x']]), CAMPOS_SESSOES.MARCADAS, chave), undefined);
});

// --- paciente com DOIS tratamentos ao mesmo tempo (cervical + lombar) ---
//
// Caso real da Açailândia (24/10/2026, paciente 363881, tratamentos 128410 CERVICAL e 128411 LOMBAR): a ficha
// do paciente manda a sessão SEM idTreatment, só com o rótulo "PROTOCOLO 03 MESES - LOMBAR". Somar tudo dava
// 14 atendidas no cartão do lombar, que tem 7.

const CERV = 128410;
const LOMB = 128411;
const FICHA: TratamentoDaFicha[] = [
  { idTreatment: CERV, typeName: 'PROTOCOLO 03 MESES, CERVICAL, CRÔNICO' },
  { idTreatment: LOMB, typeName: 'PROTOCOLO 03 MESES, LOMBAR, CRÔNICO' },
];
const CRIADO_LOMB = '2026-10-01T14:42:06.000Z';
const HOJE = Date.parse('2026-10-24T14:00:00Z') / 1000;

/** Como a ficha entrega: sem idTreatment, com o rótulo do protocolo na categoria. */
function daFicha(dia: string, hora: string, rotulo: string, idStatus: number): SpineSchedule {
  return sessao({ dia, idTreatment: null, categoryName: rotulo, dateAttendanceUtc: `${dia}T${hora}Z`, idStatus });
}
const FICHA_DUPLA: SpineSchedule[] = [
  sessao({ dia: '2026-09-30', idTreatment: null, categoryName: 'AVALIAÇÃO' }),
  ...['2026-10-01', '2026-10-07', '2026-10-10', '2026-10-14', '2026-10-17', '2026-10-21', '2026-10-24'].flatMap((dia) => [
    daFicha(dia, '19:00:00.000', 'PROTOCOLO 03 MESES - CERVICAL', SPINE_STATUS.ATENDIDO),
    daFicha(dia, '19:30:00.000', 'PROTOCOLO 03 MESES - LOMBAR', SPINE_STATUS.ATENDIDO),
  ]),
  daFicha('2026-10-28', '20:30:00.000', 'PROTOCOLO 03 MESES - CERVICAL', SPINE_STATUS.AGENDADO),
  daFicha('2026-10-28', '21:00:00.000', 'PROTOCOLO 03 MESES - LOMBAR', SPINE_STATUS.AGENDADO),
  daFicha('2026-10-31', '14:00:00.000', 'PROTOCOLO 03 MESES - CERVICAL', SPINE_STATUS.REMARCADO),
  daFicha('2026-10-31', '13:30:00.000', 'PROTOCOLO 03 MESES - LOMBAR', SPINE_STATUS.REMARCADO),
];
const LOMBAR = { idTreatment: LOMB, category: 'PROTOCOLO 03 MESES', local: 'LOMBAR', degree: 'CRÔNICO', statusName: 'EM ANDAMENTO', created: CRIADO_LOMB };
const CERVICAL = { idTreatment: CERV, category: 'PROTOCOLO 03 MESES', local: 'CERVICAL', degree: 'CRÔNICO', statusName: 'EM ANDAMENTO', created: '2026-10-01T14:41:09.000Z' };
const valorDe = (w: ReturnType<typeof escritasDeSessoes>, c: string) => (acha(w, c) as { valor: number } | undefined)?.valor;

test('dois tratamentos, ficha sem idTreatment: cada cartão conta só as sessões do SEU protocolo', () => {
  const lombar = escritasDeSessoes({ schedules: FICHA_DUPLA, tratamento: LOMBAR, tratamentosDoPaciente: FICHA, agoraEpoch: HOJE, campo: conta() });
  assert.equal(valorDe(lombar, CAMPOS_SESSOES.REALIZADAS), 7);
  assert.equal(valorDe(lombar, CAMPOS_SESSOES.MARCADAS), 1);
  assert.equal(valorDe(lombar, CAMPOS_SESSOES.PREVISTAS), 8);
  assert.equal(valorDe(lombar, CAMPOS_SESSOES.FALTAS), 0);
  const cervical = escritasDeSessoes({ schedules: FICHA_DUPLA, tratamento: CERVICAL, tratamentosDoPaciente: FICHA, agoraEpoch: HOJE, campo: conta() });
  assert.equal(valorDe(cervical, CAMPOS_SESSOES.REALIZADAS), 7);
  assert.equal(valorDe(cervical, CAMPOS_SESSOES.PREVISTAS), 8);
});

test('o defeito de antes: sem o rótulo, os dois tratamentos eram somados (14 em vez de 7)', () => {
  const antes = resumirSessoes(FICHA_DUPLA, LOMB, HOJE, CRIADO_LOMB)!; // sem o 5º argumento = como era
  assert.equal(antes.realizadas, 14);
  assert.equal(antes.previstas, 16);
  const depois = resumirSessoes(FICHA_DUPLA, LOMB, HOJE, CRIADO_LOMB, 'PROTOCOLO 03 MESES - LOMBAR')!;
  assert.equal(depois.realizadas, 7);
});

test('a agenda traz o idTreatment e vale mais que o rótulo; a ficha completa o resto', () => {
  // janela da agenda: a sessão do lombar com id certo e a do cervical com id do OUTRO tratamento
  const agenda = [
    sessao({ dia: '2026-10-28', idTreatment: LOMB, categoryName: 'SESSÃO', idStatus: SPINE_STATUS.AGENDADO }),
    sessao({ dia: '2026-10-28', idTreatment: CERV, categoryName: 'SESSÃO', idStatus: SPINE_STATUS.AGENDADO }),
  ];
  const ids = new Set(agenda.map((a) => a.idSchedule));
  const historico = FICHA_DUPLA.filter((s) => !ids.has(s.idSchedule) && s.idStatus !== SPINE_STATUS.AGENDADO);
  const w = escritasDeSessoes({ schedules: [...agenda, ...historico], tratamento: LOMBAR, tratamentosDoPaciente: FICHA, agoraEpoch: HOJE, campo: conta() });
  assert.equal(valorDe(w, CAMPOS_SESSOES.REALIZADAS), 7);
  assert.equal(valorDe(w, CAMPOS_SESSOES.MARCADAS), 1); // só a do lombar; a agendada do cervical (id 128410) não entra
});

test('ciclo anterior com protocolo diferente (inclusive sem local) não entra na conta do atual', () => {
  const ficha: TratamentoDaFicha[] = [{ idTreatment: 93000, typeName: 'PROTOCOLO 02 MESES' }, { idTreatment: LOMB, typeName: 'PROTOCOLO 03 MESES, LOMBAR, CRÔNICO' }];
  const hist = [
    daFicha('2026-05-05', '13:00:00.000', 'PROTOCOLO 02 MESES - N/A', SPINE_STATUS.ATENDIDO),
    daFicha('2026-05-12', '13:00:00.000', 'PROTOCOLO 02 MESES - N/A', SPINE_STATUS.ATENDIDO),
    daFicha('2026-10-07', '13:00:00.000', 'PROTOCOLO 03 MESES - LOMBAR', SPINE_STATUS.ATENDIDO),
  ];
  assert.equal(valorDe(escritasDeSessoes({ schedules: hist, tratamento: LOMBAR, tratamentosDoPaciente: ficha, agoraEpoch: HOJE, campo: conta() }), CAMPOS_SESSOES.REALIZADAS), 1);
  // e o contrário: o cartão do ciclo antigo conta as dele, sem a `desde` (que não existe na ficha)
  const antigo = { idTreatment: 93000, category: 'PROTOCOLO 02 MESES', local: 'N/A', degree: null, statusName: 'FINALIZADO', created: null };
  assert.equal(valorDe(escritasDeSessoes({ schedules: hist, tratamento: antigo, tratamentosDoPaciente: ficha, agoraEpoch: HOJE, campo: conta() }), CAMPOS_SESSOES.REALIZADAS), 2);
});

test('paciente com um tratamento só: nada muda — a sessão conta qualquer que seja o rótulo', () => {
  const unica = [daFicha('2026-10-07', '13:00:00.000', 'Sessão de fisioterapia', SPINE_STATUS.ATENDIDO)];
  const w = escritasDeSessoes({ schedules: unica, tratamento: LOMBAR, tratamentosDoPaciente: [FICHA[1]!], agoraEpoch: HOJE, campo: conta() });
  assert.equal(valorDe(w, CAMPOS_SESSOES.REALIZADAS), 1);
  const semFicha = escritasDeSessoes({ schedules: unica, tratamento: LOMBAR, agoraEpoch: HOJE, campo: conta() });
  assert.equal(valorDe(semFicha, CAMPOS_SESSOES.REALIZADAS), 1);
});

test('não dá para separar: grava o que é do tratamento e NENHUM contador', () => {
  // dois tratamentos e o meu não aparece na ficha nem traz categoria/local
  const semRotulo = { idTreatment: 555, local: null, degree: null, statusName: 'EM ANDAMENTO', created: null };
  const w = escritasDeSessoes({ schedules: FICHA_DUPLA, tratamento: semRotulo, tratamentosDoPaciente: FICHA, agoraEpoch: HOJE, campo: conta() });
  assert.deepEqual(w.map((x) => x.campo), [CAMPOS_SESSOES.ID_TRAT, CAMPOS_SESSOES.STATUS_TRAT]);
  // renovação do mesmo protocolo e sem a data de criação (é o caso do fechamento): também não afirma
  const renovado: TratamentoDaFicha[] = [{ idTreatment: 1, typeName: 'PROTOCOLO 03 MESES, LOMBAR, CRÔNICO' }, { idTreatment: 2, typeName: 'PROTOCOLO 03 MESES, LOMBAR, AGUDO' }];
  assert.equal(separarCiclo(2, renovado, null, false).separavel, false);
  // com a data de criação, a regra antiga (`desde`) separa os ciclos como sempre separou
  assert.equal(separarCiclo(2, renovado, null, true).separavel, true);
});

test('o rótulo da ficha a partir do typeName do tratamento', () => {
  assert.equal(protocoloDoTipo('PROTOCOLO 03 MESES, LOMBAR, CRÔNICO'), 'PROTOCOLO 03 MESES - LOMBAR');
  assert.equal(protocoloDoTipo('PROTOCOLO 01 MÊS, CERVICAL, PREVENTIVO'), 'PROTOCOLO 01 MÊS - CERVICAL');
  assert.equal(protocoloDoTipo('PROTOCOLO 02 MESES'), 'PROTOCOLO 02 MESES - N/A');
  assert.equal(protocoloDoTipo('A, B'), null); // formato que não conheço: não adivinha
  assert.equal(protocoloDoTipo(null), null);
  assert.equal(protocoloDoTipo(''), null);
});

test('REGRA EM ABERTO (pergunta ao João): sessão no dia da avaliação, ANTES de o tratamento ser criado, fica de fora', () => {
  // idClient 363357 na Açailândia: avaliação 18:00, 1ª sessão 18:30, tratamento criado às 19:17 do mesmo dia.
  // A franquia tem 8 atendidas do protocolo; o cartão mostra 7 porque a 1ª é anterior à criação do tratamento.
  // Este teste PRENDE o comportamento atual para que mudá-lo seja uma decisão, não um acidente.
  const hist = [
    daFicha('2026-09-29', '18:30:00.000', 'PROTOCOLO 03 MESES - LOMBAR', SPINE_STATUS.ATENDIDO),
    daFicha('2026-10-01', '13:00:00.000', 'PROTOCOLO 03 MESES - LOMBAR', SPINE_STATUS.ATENDIDO),
  ];
  const r = resumirSessoes(hist, LOMB, HOJE, '2026-09-29T19:17:03.000Z')!;
  assert.equal(r.realizadas, 1);
  assert.equal(resumirSessoes(hist, LOMB, HOJE, null)!.realizadas, 2);
});
