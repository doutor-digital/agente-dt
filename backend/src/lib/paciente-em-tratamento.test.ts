import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  calarPacienteEstado,
  consultarFranquia,
  decidir,
  entradaDoIndice,
  notaNumeroInterno,
  notaPacienteEmTratamento,
  portaRodaNoTurno,
  precisaConsultarFranquia,
  sinalDaFicha,
  TIMEOUT_FRANQUIA_MS,
  type SinalDaFranquia,
} from './paciente-em-tratamento.js';
import { AUTOMACOES, automacaoPorId, verificarCatalogo } from './automacoes.js';
import { _semearParaTeste, estadoDaAutomacao } from './automacoes-estado.js';
import { ehNumeroInterno } from './numeros-internos.js';

const ativo: SinalDaFranquia = { tipo: 'paciente', idClient: 1, tratamentoAtivo: true, sessaoFutura: false };
const base = { interno: false, temIdClient: false, funil: 'COMERCIAL' };

test('paciente com tratamento ativo, cartão novo no COMERCIAL sem idClient: cala', () => {
  const d = decidir({ ...base, sinal: ativo });
  assert.equal(d.calar, true);
  assert.equal(d.calar && d.motivo, 'paciente_em_tratamento');
});

test('paciente com sessão futura (sem tratamento marcado ativo): cala', () => {
  const d = decidir({ ...base, sinal: { tipo: 'paciente', idClient: 1, tratamentoAtivo: false, sessaoFutura: true } });
  assert.equal(d.calar, true);
});

test('paciente SEM tratamento ativo e sem sessão futura (só avaliação / já terminou): a Sofia responde', () => {
  const d = decidir({ ...base, sinal: { tipo: 'paciente', idClient: 1, tratamentoAtivo: false, sessaoFutura: false } });
  assert.equal(d.calar, false);
});

test('lead da franquia ou telefone desconhecido: responde', () => {
  assert.equal(decidir({ ...base, sinal: { tipo: 'lead' } }).calar, false);
  assert.equal(decidir({ ...base, sinal: { tipo: 'nao_achou' } }).calar, false);
});

test('sem idClient e franquia fora do ar / sem sinal: responde (comportamento de hoje)', () => {
  const d1 = decidir({ ...base, sinal: { tipo: 'indisponivel', motivo: 'timeout' } });
  assert.deepEqual(d1, { calar: false, motivo: 'franquia_sem_resposta' });
  assert.equal(decidir({ ...base, sinal: null }).calar, false);
});

test('número interno cala, mesmo com idClient e fora do COMERCIAL', () => {
  const d = decidir({ interno: true, temIdClient: true, funil: 'TRATAMENTO', sinal: null });
  assert.equal(d.calar && d.motivo, 'numero_interno');
});

test('cartão que já tem idClient ou já está em TRATAMENTO segue a regra de hoje, mesmo com o sinal de paciente ativo', () => {
  assert.deepEqual(decidir({ ...base, temIdClient: true, sinal: ativo }), { calar: false, motivo: 'ja_tem_idclient' });
  assert.deepEqual(decidir({ ...base, funil: 'TRATAMENTO', sinal: ativo }), { calar: false, motivo: 'fora_do_comercial' });
  assert.deepEqual(decidir({ ...base, funil: null, sinal: ativo }), { calar: false, motivo: 'fora_do_comercial' });
});

test('só consulta a franquia quando precisa: COMERCIAL, sem idClient, não interno', () => {
  assert.equal(precisaConsultarFranquia(base), true);
  assert.equal(precisaConsultarFranquia({ ...base, funil: 'Comercial ' }), true);
  assert.equal(precisaConsultarFranquia({ ...base, interno: true }), false);
  assert.equal(precisaConsultarFranquia({ ...base, temIdClient: true }), false);
  assert.equal(precisaConsultarFranquia({ ...base, funil: 'TRATAMENTO' }), false);
});

test('a decisão não depende do texto: "Confirmado", "🙏" e "Ok" calam do mesmo jeito; a nota guarda a fala curta', () => {
  for (const fala of ['Confirmado', '🙏', 'Ok']) {
    assert.equal(decidir({ ...base, sinal: ativo }).calar, true, fala);
    const nota = notaPacienteEmTratamento(fala);
    assert.match(nota, /Paciente em tratamento na franquia — a equipe responde\./);
    assert.ok(nota.includes(`Disse: "${fala}"`), nota);
  }
  assert.doesNotMatch(notaPacienteEmTratamento('   '), /Disse/);
  assert.ok(notaPacienteEmTratamento('x'.repeat(400)).length < 260);
  assert.match(notaNumeroInterno('teste'), /Número interno/);
});

test('a ficha vira sinal: tratamento 44/45 ativo, 46 não; sessão futura que não é avaliação conta, avaliação futura não', () => {
  const agora = new Date('2026-11-14T16:00:00Z');
  const sch = (categoryName: string, dia: string, idStatus = 37) =>
    ({ idSchedule: 1, idTreatment: 1, idStatus, statusName: 'Agendado', clientName: null, categoryName, physicalTherapist: null, dateAttendanceUtc: dia, dateAttendanceLocal: dia, dayLocal: null, timeLocal: null, isBusy: true, requiresManualValidation: false });
  const trat = (idStatus: number) => ({ idTreatment: 1, idStatus, statusName: null, typeName: null });

  const recente = sch('Sessão de fisioterapia', '2026-11-05T13:00:00Z', 42);
  const a = sinalDaFicha(7, { schedules: [recente], treatments: [trat(45)] }, agora);
  assert.equal(a.tipo === 'paciente' && a.tratamentoAtivo, true);
  const b = sinalDaFicha(7, { schedules: [recente], treatments: [trat(46)] }, agora);
  assert.equal(b.tipo === 'paciente' && b.tratamentoAtivo, false);
  // abandonou há meses mas a franquia ainda diz "em andamento": é lead que volta, a Sofia responde
  const velha = sch('Sessão de fisioterapia', '2026-03-05T13:00:00Z', 42);
  const abandonou = sinalDaFicha(7, { schedules: [velha], treatments: [trat(45)] }, agora);
  assert.deepEqual(abandonou, { tipo: 'paciente', idClient: 7, tratamentoAtivo: false, sessaoFutura: false });
  assert.equal(decidir({ ...base, sinal: abandonou }).calar, false);
  // tratamento fechado que nunca teve sessão nem agenda: não prova nada
  const semSessao = sinalDaFicha(7, { schedules: [], treatments: [trat(44)] }, agora);
  assert.equal(semSessao.tipo === 'paciente' && semSessao.tratamentoAtivo, false);
  const c = sinalDaFicha(7, { schedules: [sch('Avaliação', '2026-11-20T13:00:00Z')], treatments: [] }, agora);
  assert.equal(c.tipo === 'paciente' && c.sessaoFutura, false, 'avaliação futura é lead agendado, não sessão');
  const d = sinalDaFicha(7, { schedules: [sch('Sessão de fisioterapia', '2026-11-15T13:00:00Z')], treatments: [] }, agora);
  assert.equal(d.tipo === 'paciente' && d.sessaoFutura, true);
  const e = sinalDaFicha(7, { schedules: [sch('Sessão de fisioterapia', '2026-11-15T13:00:00Z', 57)], treatments: [] }, agora);
  assert.equal(e.tipo === 'paciente' && e.sessaoFutura, false, 'sessão desmarcada não conta');
});

test('o índice: paciente vence lead; só lead = lead; vazio = não achou; paciente sem id = indisponível', () => {
  assert.deepEqual(entradaDoIndice([{ origem: 'lead', id: 3 }, { origem: 'paciente', id: 9 }]), { tipo: 'paciente', idClient: 9 });
  assert.deepEqual(entradaDoIndice([{ origem: 'lead', id: 3 }]), { tipo: 'lead' });
  assert.deepEqual(entradaDoIndice([]), { tipo: 'nao_achou' });
  assert.equal(entradaDoIndice([{ origem: 'paciente', id: null }]).tipo, 'indisponivel');
});

const unitOk = { id: 'u1', slug: 'doutor-hernia-petropolis', spineEnabled: true, spineToken: 'x', spineBaseUrl: 'http://x', spineTimezone: 'America/Sao_Paulo' };

test('consultarFranquia: paciente com tratamento ativo → sinal de paciente; ficha ausente, índice que lança e timeout → indisponível', async () => {
  const indiceComPaciente = async () => ({ entradas: [{ chave: '99999999', origem: 'paciente' as const, id: 42, criado: null }], fresco: false, idadeHoras: null });
  const fichaAtiva = async () => ({ schedules: [{ idSchedule: 1, idTreatment: 1, idStatus: 42, statusName: 'Atendido', clientName: null, categoryName: 'Sessão', physicalTherapist: null, dateAttendanceUtc: new Date(Date.now() - 5 * 86_400_000).toISOString(), dateAttendanceLocal: null, dayLocal: null, timeLocal: null, isBusy: true, requiresManualValidation: false }], treatments: [{ idTreatment: 1, idStatus: 45, statusName: null, typeName: null }] });

  const ok = await consultarFranquia(unitOk, '+55 21 98888-9999', { indice: indiceComPaciente, ficha: fichaAtiva });
  assert.deepEqual(ok, { tipo: 'paciente', idClient: 42, tratamentoAtivo: true, sessaoFutura: false });

  const semFicha = await consultarFranquia(unitOk, '21988889999', { indice: indiceComPaciente, ficha: async () => null });
  assert.equal(semFicha.tipo, 'indisponivel');

  const indiceQuebrado = await consultarFranquia(unitOk, '21988889999', { indice: async () => { throw new Error('banco fora'); } });
  assert.equal(indiceQuebrado.tipo, 'indisponivel');

  const fichaTravada = await consultarFranquia(unitOk, '21988889999', { indice: indiceComPaciente, ficha: () => new Promise(() => {}) });
  assert.equal(fichaTravada.tipo, 'indisponivel');
  assert.match(fichaTravada.tipo === 'indisponivel' ? fichaTravada.motivo : '', /timeout/);

  assert.equal((await consultarFranquia({ ...unitOk, spineEnabled: false }, '21988889999')).tipo, 'indisponivel');
  assert.equal((await consultarFranquia(unitOk, '123')).tipo, 'indisponivel');
});

test('o timeout total é de no máximo 3 s', () => {
  assert.ok(TIMEOUT_FRANQUIA_MS <= 3000);
});

test('número interno: últimos 8 dígitos, qualquer formato', () => {
  const raw = 'teste:+55 (98) 91234-5678';
  assert.equal(ehNumeroInterno('98912345678', raw), true);
  assert.equal(ehNumeroInterno('9912345678', raw), true);
  assert.equal(ehNumeroInterno('21987654321', raw), false);
});

test('a chave no catálogo: id estável, nasce desligada, tem modo seco, e o estado por unidade funciona', () => {
  const a = automacaoPorId('calar-paciente-em-tratamento');
  assert.ok(a);
  assert.equal(a.chave, 'CALAR_PACIENTE_EM_TRATAMENTO_SLUGS');
  assert.equal(a.temSeco, true);
  assert.equal(a.quandoVazio, 'desligado');
  assert.deepEqual(verificarCatalogo(AUTOMACOES), []);

  _semearParaTeste([]);
  assert.equal(calarPacienteEstado('doutor-hernia-petropolis', undefined), 'desligado');
  assert.equal(calarPacienteEstado('doutor-hernia-petropolis', 'doutor-hernia-petropolis'), 'ligado');
  assert.equal(calarPacienteEstado('doutor-hernia-caxias', 'doutor-hernia-petropolis'), 'desligado');
  _semearParaTeste([{ slug: 'doutor-hernia-caxias', automacao: 'calar-paciente-em-tratamento', estado: 'seco' }]);
  assert.equal(estadoDaAutomacao('doutor-hernia-caxias', 'calar-paciente-em-tratamento', undefined), 'seco');
  _semearParaTeste([]);
});

test('porta: turno aberto pela Ponte ("Passar para a Sofia") NUNCA cala — a equipe mandou a Sofia falar', () => {
  assert.equal(portaRodaNoTurno({ isChatMessage: true, humanMessage: 'Confirmado', passadoPelaPonte: true }), false);
  assert.equal(portaRodaNoTurno({ isChatMessage: true, humanMessage: 'Confirmado', passadoPelaPonte: false }), true);
  assert.equal(portaRodaNoTurno({ isChatMessage: true, humanMessage: '   ', passadoPelaPonte: false }), false);
  assert.equal(portaRodaNoTurno({ isChatMessage: false, humanMessage: 'Confirmado', passadoPelaPonte: false }), false);
});
