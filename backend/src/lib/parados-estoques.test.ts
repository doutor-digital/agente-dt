import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRAZOS_ESTOQUE,
  candidatoConsultaVelha,
  candidatoDormente,
  candidatoFaltaDoEstoque,
  classeDoTratamentoSemDado,
  decidirAgendadoParado,
  decidirDormente,
  decidirFaltaDoEstoque,
  decidirRetornoParado,
  estadoDosEstoques,
  semDadoDeSessao,
  situacaoDoEstoqueDeFalta,
} from './parados-estoques.js';
import { MOTIVO_PERDA as MOTIVO_PERDA_FRANQUIA } from './franquia-move.js';
import { MOTIVO_PERDA, textoDaNota } from './parados.js';
import { diaDaRetomada } from './espera-retomada.js';
import { automacaoPorId } from './automacoes.js';

// Censo da Açailândia em 20/10/2026 (só leitura): os casos abaixo são cartões reais, só pelo id.
const AGORA = Date.parse('2026-10-20T12:00:00Z') / 1000;
const em = (isoLocal: string) => Date.parse(`${isoLocal}-03:00`) / 1000;
const diaKommo = (iso: string) => Date.parse(`${iso}T03:00:00Z`) / 1000;
const sem = diaDaRetomada(null, AGORA);

test('a chave dos estoques nasce desligada e tem modo seco', () => {
  const a = automacaoPorId('parados-estoques');
  assert.ok(a, 'está no catálogo da tela');
  assert.equal(a.quandoVazio, 'desligado');
  assert.equal(a.temSeco, true);
  assert.equal(estadoDosEstoques('doutor-hernia-acailandia', undefined), 'desligado');
  assert.equal(estadoDosEstoques('doutor-hernia-acailandia', 'doutor-hernia-acailandia'), 'ligado');
});

test('NÃO COMPARECEU: Desmarcado e vazia entram; Atendido, Remarcado e falta recente não', () => {
  assert.equal(situacaoDoEstoqueDeFalta('Desmarcado'), true);
  assert.equal(situacaoDoEstoqueDeFalta(''), true);
  assert.equal(situacaoDoEstoqueDeFalta('Não compareceu'), true);
  assert.equal(situacaoDoEstoqueDeFalta('Atendido'), false, '10817076: atendido em NÃO COMPARECEU é da franquia, não do prazo');
  assert.equal(situacaoDoEstoqueDeFalta('Remarcado'), false, '26504238');
  // 28635116: faltou em 16/10 — dentro dos 7 dias
  assert.equal(candidatoFaltaDoEstoque('Não compareceu', em('2026-10-16T09:00'), sem, AGORA), false);
  // 26570926: a SDR marcou ◷ Retomar em 28/10 — o cartão é dela
  assert.equal(candidatoFaltaDoEstoque('Não compareceu', em('2026-09-28T09:00'), diaDaRetomada(diaKommo('2026-10-28'), AGORA), AGORA), false);
});

test('NÃO COMPARECEU pela jornada: casos reais 26080638 (28 d → EM ESPERA), 10817078 (fev → PERDIDO sem régua), 16762556 (sem data)', () => {
  // 26080638: Desmarcado na avaliação de 22/09 — 28 dias, ainda recuperável
  const recente = decidirFaltaDoEstoque({ dataFaltaEpoch: em('2026-09-22T09:00'), semMudarEtapa: true, franquiaSegura: false, agora: AGORA });
  assert.equal(recente?.para, 'EM ESPERA');
  assert.equal(recente?.retomarEmEpoch, AGORA + 7 * 86_400);
  // 10817078: Desmarcado em 14/02, legado da importação de 28/05 — 248 dias
  const velho = decidirFaltaDoEstoque({ dataFaltaEpoch: em('2026-02-14T09:00'), semMudarEtapa: true, franquiaSegura: false, agora: AGORA });
  assert.equal(velho?.para, 'PERDIDO');
  assert.equal(velho?.motivoPerda, MOTIVO_PERDA_FRANQUIA.NAO_REMARCOU);
  assert.equal(velho?.semRegua, true, 'mais de 90 dias: a régua de PERDIDO não manda nada');
  // 22716436: faltou em 29/08 — 52 dias: PERDIDO, e a régua ainda vale
  const meio = decidirFaltaDoEstoque({ dataFaltaEpoch: em('2026-08-29T09:00'), semMudarEtapa: true, franquiaSegura: false, agora: AGORA });
  assert.equal(meio?.para, 'PERDIDO');
  assert.equal(meio?.semRegua, false);
  // 16762556: sem situação nem data — só se o cartão não muda de etapa há 30 dias
  assert.equal(candidatoFaltaDoEstoque(null, null, sem, AGORA), true);
  assert.equal(decidirFaltaDoEstoque({ dataFaltaEpoch: null, semMudarEtapa: false, franquiaSegura: false, agora: AGORA }), null);
  assert.equal(decidirFaltaDoEstoque({ dataFaltaEpoch: null, semMudarEtapa: true, franquiaSegura: false, agora: AGORA })?.semRegua, true);
  // chegou na etapa há pouco (a campanha do Outubro Rosa moveu em 13/10): com data velha, mesmo assim espera 7 dias de etapa
  assert.equal(decidirFaltaDoEstoque({ dataFaltaEpoch: em('2026-02-14T09:00'), semMudarEtapa: false, franquiaSegura: false, agora: AGORA }), null);
  // a franquia segura: consulta futura ou tratamento em andamento
  assert.equal(decidirFaltaDoEstoque({ dataFaltaEpoch: em('2026-02-14T09:00'), semMudarEtapa: true, franquiaSegura: true, agora: AGORA }), null);
  // a nota diz de onde veio a regra
  assert.match(textoDaNota(velho!, 'NÃO COMPARECEU'), /auditoria da Açailândia/);
});

test('AGENDADO parado: casos reais 10817394 (sem consulta), 24338262 (consulta de 04/09 nunca registrada), 10816984 (janeiro)', () => {
  // as 9 com consulta pra frente nem entram
  assert.equal(candidatoConsultaVelha(em('2026-10-22T08:00'), sem, AGORA), false);
  // a revisão do sincronizador tem 30 dias de vez antes do prazo
  assert.equal(candidatoConsultaVelha(em('2026-10-01T08:00'), sem, AGORA), false);
  assert.equal(candidatoConsultaVelha(null, sem, AGORA), true);
  const fatos = { semMudarEtapa: true, semEscrever: true, franquiaSegura: false, agora: AGORA };
  const semConsulta = decidirAgendadoParado({ ...fatos, dataConsultaEpoch: null });
  assert.equal(semConsulta?.para, 'PERDIDO');
  assert.equal(semConsulta?.motivoPerda, MOTIVO_PERDA.ESPERA);
  assert.equal(semConsulta?.semRegua, true);
  const naoRegistrada = decidirAgendadoParado({ ...fatos, dataConsultaEpoch: em('2026-09-04T08:00') });
  assert.equal(naoRegistrada?.motivoPerda, MOTIVO_PERDA_FRANQUIA.NAO_REMARCOU);
  assert.equal(naoRegistrada?.semRegua, false, '46 dias: a régua de PERDIDO ainda tenta');
  assert.equal(decidirAgendadoParado({ ...fatos, dataConsultaEpoch: em('2026-01-05T08:00') })?.semRegua, true);
  // quem mexeu, escreveu ou tem consulta na franquia fica
  assert.equal(decidirAgendadoParado({ ...fatos, dataConsultaEpoch: null, semMudarEtapa: false }), null);
  assert.equal(decidirAgendadoParado({ ...fatos, dataConsultaEpoch: null, semEscrever: false }), null);
  assert.equal(decidirAgendadoParado({ ...fatos, dataConsultaEpoch: null, franquiaSegura: true }), null);
});

test('RETORNO PÓS-TRATAMENTO parado: caso real 10819214 (sem data desde 18/08) vai pra PERDIDO sempre sem régua; 10851254 (retomada em 23/10) fica', () => {
  const d = decidirRetornoParado({ dataConsultaEpoch: null, semMudarEtapa: true, semEscrever: true, franquiaSegura: false, agora: AGORA });
  assert.equal(d?.para, 'PERDIDO');
  assert.equal(d?.semRegua, true, 'ex-paciente não recebe a régua comercial de PERDIDO');
  assert.equal(candidatoConsultaVelha(em('2026-10-16T08:00'), diaDaRetomada(diaKommo('2026-10-23'), AGORA), AGORA), false);
  assert.equal(decidirRetornoParado({ dataConsultaEpoch: null, semMudarEtapa: true, semEscrever: true, franquiaSegura: true, agora: AGORA }), null);
});

test('EM TRATAMENTO sem dado de sessão (10822162 e mais 13): nunca vai pra ALTA sozinho — entra na fila da /alta', () => {
  assert.equal(semDadoDeSessao([{ field_name: '⚕ Fisioterapeuta', values: [{ value: 'X' }] }]), true);
  assert.equal(semDadoDeSessao([{ field_name: '# Sessões realizadas', values: [{ value: '9' }] }]), false);
  assert.equal(semDadoDeSessao([{ field_name: '◷ Última sessão marcada', values: [{ value: 1791642600 }] }]), false);
  assert.equal(classeDoTratamentoSemDado({ semMudarEtapa: true, conhecido: false, emAndamento: false, finalizado: false }), 'PAROU');
  assert.equal(classeDoTratamentoSemDado({ semMudarEtapa: true, conhecido: true, emAndamento: false, finalizado: true }), 'ALTA');
  assert.equal(classeDoTratamentoSemDado({ semMudarEtapa: true, conhecido: true, emAndamento: true, finalizado: true }), null, 'em andamento: é paciente');
  assert.equal(classeDoTratamentoSemDado({ semMudarEtapa: false, conhecido: false, emAndamento: false, finalizado: false }), null);
});

test('entrada e EM QUALIFICAÇÃO dormentes: a importação de 28/05 sem ninguém escrever vai pra PERDIDO "não interagiu" sem régua', () => {
  const importado = em('2026-05-28T16:00');
  assert.equal(candidatoDormente('EM QUALIFICAÇÃO', importado, null, sem, AGORA), true);
  assert.equal(candidatoDormente('Incoming leads', importado, null, sem, AGORA), true);
  assert.equal(candidatoDormente('EM QUALIFICAÇÃO', em('2026-10-17T10:00'), null, sem, AGORA), false, 'lead novo');
  assert.equal(candidatoDormente('EM QUALIFICAÇÃO', importado, em('2026-10-28T10:00'), sem, AGORA), false, 'consulta pra frente no cartão');
  assert.equal(candidatoDormente('EM QUALIFICAÇÃO', importado, null, diaDaRetomada(diaKommo('2026-11-02'), AGORA), AGORA), false);
  assert.equal(candidatoDormente('AGENDADO', importado, null, sem, AGORA), false);
  const d = decidirDormente({ semMudarEtapa: true, semEscrever: true, conversaRecente: false, franquiaSegura: false });
  assert.equal(d?.para, 'PERDIDO');
  assert.equal(d?.motivoPerda, MOTIVO_PERDA.FOLLOW_UP);
  assert.equal(d?.semRegua, true);
  assert.equal(d?.dias, PRAZOS_ESTOQUE.dormenteDias);
  assert.equal(decidirDormente({ semMudarEtapa: true, semEscrever: true, conversaRecente: true, franquiaSegura: false }), null, 'a Sofia falou com ele');
  assert.equal(decidirDormente({ semMudarEtapa: true, semEscrever: false, conversaRecente: false, franquiaSegura: false }), null);
});
