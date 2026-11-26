/**
 * Retomada de LEAD («tentei te ligar», «faz um tempo…», «fiquei sem a sua resposta», «quer que eu veja os horários?») não vai para quem já tem
 * consulta marcada nem para quem avaliou há pouco: o texto não combina com o caso. Reclamação das unidades (26/11/2026): «nossos pacientes são
 * idosos, eles não entendem essas mensagens fora do contexto».
 * Datas: 2026-11-16 é segunda; Belém é UTC-3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as regua from './chatwoot-regua.js';
import { decidirRegua, type ConversaRegua, type DadosDaUnidade, type Visto } from './chatwoot-regua.js';

/** lida do módulo (e não importada por nome) para o arquivo rodar igual no código antigo e mostrar a mensagem saindo onde não devia */
const temConsultaOuAvaliouRecente = (a: Record<string, unknown>, agora: Date): boolean => (regua as unknown as { temConsultaOuAvaliouRecente: (a: Record<string, unknown>, d: Date) => boolean }).temConsultaOuAvaliouRecente(a, agora);
const DE_LEAD = new Set(['followup-48h', 'followup-96h', 'followup-120h', 'sdr-retomada', 'sdr-reativacao']);

const U: DadosDaUnidade = { nome: 'Doutor Hérnia Parauapebas', pixKey: 'pix@parau.com', valorAntecipado: 250 };
const Z = (s: string) => new Date(s);
const ENTROU = '2026-11-16T12:00:00Z'; // segunda 09:00 em Belém

function conv(attrs: Record<string, unknown>, etiquetas: string[] = []): ConversaRegua {
  return { id: 10, nome: 'maria da silva', etiquetas, attrs, criadaEm: Z('2026-10-01T12:00:00Z'), atendente: 'Ana', ultima: null };
}
const visto = (valor: string): Visto => ({ valor, desde: Z(ENTROU), inicial: false });

/** Varre 6 dias de 10 em 10 min (a partir de ENTROU) e devolve as regras que SAÍRAM. */
function saiu(c: ConversaRegua, vistosExtra: Record<string, Visto>): string[] {
  const feitos = new Set<string>();
  const regras: string[] = [];
  const vistos = new Map<string, Visto>([['_visto', { valor: '1', desde: Z('2026-11-10T12:00:00Z'), inicial: false }], ...Object.entries(vistosExtra)]);
  for (let t = Z(ENTROU).getTime(); t <= Z('2026-11-22T12:00:00Z').getTime(); t += 10 * 60_000) {
    for (const d of decidirRegua(c, { vistos, feitos }, new Date(t), U).disparos) {
      feitos.add(`${d.regra}|${d.chave}`);
      regras.push(d.regra);
    }
  }
  return regras.sort();
}

const PERDIDO = { etapa: 'Perdido' };
/** só as retomadas de lead que saíram (a sequência de decisão de quem avaliou é outra coisa e segue valendo) */
const comPerdido = (extra: Record<string, unknown>) => saiu(conv({ ...PERDIDO, ...extra }), { etapa: visto('Perdido') }).filter((r) => DE_LEAD.has(r));
const SEQUENCIA = ['followup-120h', 'followup-48h', 'followup-96h'];

test('perdido SEM consulta: a sequência de lead sai inteira (nada mudou para quem sumiu de verdade)', () => {
  assert.deepEqual(comPerdido({}), SEQUENCIA);
  assert.deepEqual(comPerdido({ situacao_consulta: 'Não compareceu', data_consulta: '2026-11-10', hora_consulta: '14:00' }), SEQUENCIA);
  assert.deepEqual(comPerdido({ situacao_consulta: 'Desmarcado', data_consulta: '2026-11-30', hora_consulta: '14:00' }), SEQUENCIA);
});

test('perdido COM consulta de pé (agendada, confirmada ou remarcada): nenhuma retomada de lead', () => {
  for (const situacao_consulta of ['Agendado', 'Confirmado', 'Remarcado']) {
    assert.deepEqual(comPerdido({ situacao_consulta, data_consulta: '2026-11-30', hora_consulta: '14:00' }), [], situacao_consulta);
  }
});

test('perdido que AVALIOU há pouco (Atendido nos últimos 30 dias): nenhuma retomada de lead; a de 45 dias atrás ainda recebe', () => {
  assert.deepEqual(comPerdido({ situacao_consulta: 'Atendido', data_consulta: '2026-11-15', hora_consulta: '10:00' }), []); // ontem
  assert.deepEqual(comPerdido({ situacao_consulta: 'Atendido', data_consulta: '2026-11-05', hora_consulta: '10:00' }), []); // 11 dias antes da entrada em Perdido, 16 no último envio
  assert.deepEqual(comPerdido({ situacao_consulta: 'Atendido', data_consulta: '2026-10-01', hora_consulta: '10:00' }), SEQUENCIA); // 46 dias
});

test('etiqueta «retomada» («tentei te ligar»): sai para lead sem consulta; não sai para quem tem consulta de pé ou avaliou ontem', () => {
  const etapas = ['Novo lead', 'Sofia qualifica', 'Esperando humano', 'Agendado'];
  for (const etapa of etapas) {
    const v = { 'etiqueta:retomada': visto('sim') };
    assert.deepEqual(saiu(conv({ etapa }, ['retomada']), v), ['sdr-retomada'], `${etapa} sem consulta`);
    assert.deepEqual(saiu(conv({ etapa, situacao_consulta: 'Agendado', data_consulta: '2026-11-19', hora_consulta: '10:00' }, ['retomada']), v).filter((r) => r === 'sdr-retomada'), [], `${etapa} com consulta de pé`);
    assert.deepEqual(saiu(conv({ etapa, situacao_consulta: 'Atendido', data_consulta: '2026-11-15', hora_consulta: '10:00' }, ['retomada']), v).filter((r) => r === 'sdr-retomada'), [], `${etapa} avaliou ontem`);
  }
  // falta (Não compareceu) segue podendo receber: é exatamente o caso de ligar de novo
  assert.deepEqual(saiu(conv({ etapa: 'Agendado', situacao_consulta: 'Não compareceu', data_consulta: '2026-11-14', hora_consulta: '10:00' }, ['retomada']), { 'etiqueta:retomada': visto('sim') }).filter((r) => r === 'sdr-retomada'), ['sdr-retomada']);
});

test('etiqueta «reativacao» («faz um tempo desde a nossa última conversa»): não sai para quem avaliou ontem ou tem consulta de pé', () => {
  const v = { 'etiqueta:reativacao': visto('sim') };
  assert.deepEqual(saiu(conv({ etapa: 'Perdido' }, ['reativacao']), v).filter((r) => r === 'sdr-reativacao'), ['sdr-reativacao']);
  assert.deepEqual(saiu(conv({ etapa: 'Perdido', situacao_consulta: 'Atendido', data_consulta: '2026-11-15' }, ['reativacao']), v).filter((r) => r === 'sdr-reativacao'), []);
  assert.deepEqual(saiu(conv({ etapa: 'Sofia qualifica', situacao_consulta: 'Confirmado', data_consulta: '2026-11-20', hora_consulta: '09:00' }, ['reativacao']), v).filter((r) => r === 'sdr-reativacao'), []);
});

test('o que NÃO é retomada de lead segue igual: lembretes da consulta e a sequência de decisão depois da avaliação', () => {
  // consulta de pé amanhã em «Agendado»: véspera, hoje e preparo saem
  const agendada = saiu(conv({ etapa: 'Agendado', situacao_consulta: 'Agendado', categoria_consulta: 'Avaliação', data_consulta: '2026-11-17', hora_consulta: '15:00' }), { etapa: visto('Agendado') });
  assert.deepEqual(agendada, ['consulta-dia', 'consulta-preparo', 'consulta-vespera']);
  // atendido ontem em Pós-consulta: a decisão de 4 dias é o texto certo para ele
  const atendido = saiu(conv({ etapa: 'Pós-consulta', situacao_consulta: 'Atendido', categoria_consulta: 'Avaliação', data_consulta: '2026-11-15', hora_consulta: '10:00' }), { etapa: visto('Pós-consulta') });
  assert.ok(atendido.includes('decisao-4d'), atendido.join());
});

test('temConsultaOuAvaliouRecente: sem data ou data impossível não conta', () => {
  const agora = Z('2026-11-16T15:00:00Z');
  assert.equal(temConsultaOuAvaliouRecente({}, agora), false);
  assert.equal(temConsultaOuAvaliouRecente({ situacao_consulta: 'Agendado' }, agora), false);
  assert.equal(temConsultaOuAvaliouRecente({ situacao_consulta: 'Agendado', data_consulta: '2026-02-30' }, agora), false);
  assert.equal(temConsultaOuAvaliouRecente({ situacao_consulta: 'Agendado', data_consulta: '2026-11-10' }, agora), false, 'consulta de pé que já passou há dias é dado velho, não consulta marcada');
  assert.equal(temConsultaOuAvaliouRecente({ situacao_consulta: 'Agendado', data_consulta: '2026-11-16' }, agora), true);
  assert.equal(temConsultaOuAvaliouRecente({ situacao_consulta: 'Atendido', data_consulta: '2026-11-17' }, agora), false, 'atendido «no futuro» é dado errado: não vale');
});
