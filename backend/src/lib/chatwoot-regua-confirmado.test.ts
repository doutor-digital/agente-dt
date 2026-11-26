/**
 * Quem já está «Confirmado» não recebe lembrete que PEDE confirmação («Está tudo certo?»): véspera e «hoje» saem de cena, o preparo
 * (que não pede nada) continua. Reclamação das unidades (26/11/2026): «a IA confirma de novo as sessões de hoje que já foram confirmadas
 * no sábado» — paciente idoso não entende a mesma pergunta duas vezes.
 * Datas: 2026-11-18 é quarta; Belém é UTC-3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidirRegua, type ConversaRegua, type DadosDaUnidade, type Visto } from './chatwoot-regua.js';

const U: DadosDaUnidade = { nome: 'Doutor Hérnia Parauapebas', pixKey: 'pix@parau.com', valorAntecipado: 250 };
const Z = (s: string) => new Date(s);

function conv(attrs: Record<string, unknown>): ConversaRegua {
  return { id: 10, nome: 'maria da silva', etiquetas: [], attrs, criadaEm: Z('2026-10-01T12:00:00Z'), atendente: 'Ana', ultima: null };
}
const visto = (valor: string): Visto => ({ valor, desde: Z('2026-11-10T12:00:00Z'), inicial: false });

/** Varre o tempo de 10 em 10 min e devolve as regras que SAÍRAM (cada uma uma vez), como o worker faria. */
function saiu(c: ConversaRegua, de = '2026-11-16T11:00:00Z', ate = '2026-11-19T02:00:00Z'): string[] {
  const feitos = new Set<string>();
  const regras: string[] = [];
  const vistos = new Map<string, Visto>([['_visto', visto('1')]]);
  for (let t = Z(de).getTime(); t <= Z(ate).getTime(); t += 10 * 60_000) {
    for (const d of decidirRegua(c, { vistos, feitos }, new Date(t), U).disparos) {
      feitos.add(`${d.regra}|${d.chave}`);
      regras.push(d.regra);
    }
  }
  return regras.sort();
}

const CONSULTA = { etapa: 'Agendado', categoria_consulta: 'Avaliação', data_consulta: '2026-11-18', hora_consulta: '15:00' };

test('consulta Agendado: véspera, hoje e preparo como sempre (a mudança não toca em quem NÃO confirmou)', () => {
  assert.deepEqual(saiu(conv({ ...CONSULTA, situacao_consulta: 'Agendado' })), ['consulta-dia', 'consulta-preparo', 'consulta-vespera']);
  assert.deepEqual(saiu(conv({ ...CONSULTA, situacao_consulta: 'Remarcado' })), ['consulta-dia', 'consulta-preparo', 'consulta-vespera']);
  assert.deepEqual(saiu(conv({ ...CONSULTA })), ['consulta-dia', 'consulta-preparo', 'consulta-vespera']);
});

test('consulta Confirmado: não recebe a véspera nem o «hoje» (os dois perguntam «está tudo certo?»); o preparo continua', () => {
  assert.deepEqual(saiu(conv({ ...CONSULTA, situacao_consulta: 'Confirmado' })), ['consulta-preparo']);
  assert.deepEqual(saiu(conv({ ...CONSULTA, etapa: 'Confirmado', situacao_consulta: 'Confirmado' })), ['consulta-preparo']);
});

test('«Fechou» + Confirmado: o texto de véspera da sessão também pede confirmação — não sai', () => {
  assert.deepEqual(saiu(conv({ ...CONSULTA, etapa: 'Fechou', situacao_consulta: 'Confirmado' })), ['consulta-preparo']);
  assert.deepEqual(saiu(conv({ ...CONSULTA, etapa: 'Fechou', situacao_consulta: 'Agendado' })), ['consulta-dia', 'consulta-preparo', 'consulta-vespera']);
});

test('sessão da agenda Confirmada: nem véspera nem «sessão de hoje»; Agendada recebe as duas', () => {
  const sessao = { ...CONSULTA, categoria_consulta: 'Sessão', etapa: undefined };
  assert.deepEqual(saiu(conv({ ...sessao, situacao_consulta: 'Confirmado' })), []);
  assert.deepEqual(saiu(conv({ ...sessao, situacao_consulta: 'Agendado' })), ['consulta-vespera', 'sessao-dia']);
});

test('«Em tratamento»: a sessão da equipe é a MESMA da agenda e já confirmada → sem «sessão de hoje»', () => {
  const emTratamento = { funil: 'Tratamento', etapa_tratamento: 'Em tratamento', proxima_sessao: '2026-11-18', hora_sessao: '15:00' };
  assert.deepEqual(saiu(conv({ ...emTratamento, data_consulta: '2026-11-18', hora_consulta: '15:00', situacao_consulta: 'Confirmado' })), []);
  assert.deepEqual(saiu(conv({ ...emTratamento, data_consulta: '2026-11-18', hora_consulta: '15:00', situacao_consulta: 'Agendado' })), ['sessao-dia']);
});

test('«Em tratamento»: «Confirmado» de OUTRO dia ou de OUTRA hora não é desta sessão — ela ainda pergunta', () => {
  const emTratamento = { funil: 'Tratamento', etapa_tratamento: 'Em tratamento', proxima_sessao: '2026-11-18', hora_sessao: '15:00' };
  // a avaliação de semanas atrás ficou «Confirmado»: nunca foi a confirmação desta sessão
  assert.deepEqual(saiu(conv({ ...emTratamento, data_consulta: '2026-10-20', hora_consulta: '09:00', situacao_consulta: 'Confirmado' })), ['sessao-dia']);
  // no mesmo dia, outra hora: outra sessão
  assert.deepEqual(saiu(conv({ ...emTratamento, data_consulta: '2026-11-18', hora_consulta: '09:00', situacao_consulta: 'Confirmado' })), ['sessao-dia']);
  // «Confirmado» sem consulta nenhuma na conversa: não dá para ligar a confirmação a esta sessão
  assert.deepEqual(saiu(conv({ ...emTratamento, situacao_consulta: 'Confirmado' })), ['sessao-dia']);
});
