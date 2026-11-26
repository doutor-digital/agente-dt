/**
 * Quem já está «Confirmado» não recebe o lembrete que PEDE confirmação («Está tudo certo?»): véspera e «hoje» saem na versão SEM a pergunta (mesma data, horário,
 * endereço e mapa), e o preparo (que não pede nada) continua igual. Reclamação das unidades (26/11/2026): «a IA confirma de novo as sessões de hoje que já foram
 * confirmadas no sábado» — paciente idoso não entende a mesma pergunta duas vezes.
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

/** Varre o tempo de 10 em 10 min e devolve `regra:modelo` do que SAIU (cada um uma vez), como o worker faria; `textos` = os textos que saíram. */
function saiu(c: ConversaRegua, de = '2026-11-16T11:00:00Z', ate = '2026-11-19T02:00:00Z', textos?: string[]): string[] {
  const feitos = new Set<string>();
  const saidas: string[] = [];
  const vistos = new Map<string, Visto>([['_visto', visto('1')]]);
  for (let t = Z(de).getTime(); t <= Z(ate).getTime(); t += 10 * 60_000) {
    for (const d of decidirRegua(c, { vistos, feitos }, new Date(t), U).disparos) {
      feitos.add(`${d.regra}|${d.chave}`);
      saidas.push(`${d.regra}:${d.modelo}`);
      if (d.texto) textos?.push(d.texto);
    }
  }
  return saidas.sort();
}

const CONSULTA = { etapa: 'Agendado', categoria_consulta: 'Avaliação', data_consulta: '2026-11-18', hora_consulta: '15:00' };
const NORMAL = ['consulta-dia:parau_consulta_confirmacao_dia', 'consulta-preparo:parau_consulta_preparo', 'consulta-vespera:parau_consulta_lembrete_vespera'];
const SEM_PEDIDO = ['consulta-dia:parau_consulta_dia_confirmada', 'consulta-preparo:parau_consulta_preparo', 'consulta-vespera:parau_consulta_lembrete_vespera_confirmada'];

test('consulta Agendado: véspera, hoje e preparo como sempre (a mudança não toca em quem NÃO confirmou)', () => {
  assert.deepEqual(saiu(conv({ ...CONSULTA, situacao_consulta: 'Agendado' })), NORMAL);
  assert.deepEqual(saiu(conv({ ...CONSULTA, situacao_consulta: 'Remarcado' })), NORMAL);
  assert.deepEqual(saiu(conv({ ...CONSULTA })), NORMAL);
});

test('consulta Confirmado: véspera e «hoje» saem SEM a pergunta (continuam levando data, horário, endereço e mapa); o preparo é o de sempre', () => {
  const textos: string[] = [];
  assert.deepEqual(saiu(conv({ ...CONSULTA, situacao_consulta: 'Confirmado' }), undefined, undefined, textos), SEM_PEDIDO);
  assert.deepEqual(saiu(conv({ ...CONSULTA, etapa: 'Confirmado', situacao_consulta: 'Confirmado' })), SEM_PEDIDO);
  const vespera = textos.find((t) => /é amanhã/.test(t))!;
  assert.match(vespera, /Data e horário: 18\/11 às 15:00/);
  assert.match(vespera, /Endereço: .*Parauapebas/);
  assert.match(vespera, /Como chegar/);
  for (const t of textos.filter((x) => !/leve:/.test(x))) assert.doesNotMatch(t, /\?/, `sem pergunta: ${t}`);
  // e os do paciente que NÃO confirmou seguem com a pergunta
  const normais: string[] = [];
  saiu(conv({ ...CONSULTA, situacao_consulta: 'Agendado' }), undefined, undefined, normais);
  assert.equal(normais.filter((t) => /Está tudo certo/.test(t)).length, 2);
});

test('o cartão na etapa «Confirmado» com a situação em branco também conta como confirmado; com a situação «Agendado» (a franquia diz que não) não', () => {
  assert.deepEqual(saiu(conv({ ...CONSULTA, etapa: 'Confirmado' })), SEM_PEDIDO);
  assert.deepEqual(saiu(conv({ ...CONSULTA, etapa: 'Confirmado', situacao_consulta: 'Agendado' })), NORMAL);
});

test('«Fechou» + Confirmado: o texto de véspera da sessão também perguntava — sai a versão sem pedido', () => {
  assert.deepEqual(saiu(conv({ ...CONSULTA, etapa: 'Fechou', situacao_consulta: 'Confirmado' })), ['consulta-dia:parau_consulta_dia_confirmada', 'consulta-preparo:parau_consulta_preparo', 'consulta-vespera:parau_sessao_lembrete_vespera_confirmada']);
  assert.deepEqual(saiu(conv({ ...CONSULTA, etapa: 'Fechou', situacao_consulta: 'Agendado' })), ['consulta-dia:parau_consulta_confirmacao_dia', 'consulta-preparo:parau_consulta_preparo', 'consulta-vespera:parau_sessao_lembrete_vespera']);
});

test('sessão da agenda Confirmada: véspera e «sessão de hoje» sem a pergunta; Agendada recebe as com pergunta', () => {
  const sessao = { ...CONSULTA, categoria_consulta: 'Sessão', etapa: undefined };
  assert.deepEqual(saiu(conv({ ...sessao, situacao_consulta: 'Confirmado' })), ['consulta-vespera:parau_sessao_lembrete_vespera_confirmada', 'sessao-dia:parau_sessao_dia_confirmada']);
  assert.deepEqual(saiu(conv({ ...sessao, situacao_consulta: 'Agendado' })), ['consulta-vespera:parau_sessao_lembrete_vespera', 'sessao-dia:parau_sessao_confirmacao_dia']);
});

test('«Em tratamento»: a sessão da equipe é a MESMA sessão da agenda e já confirmada → «sessão de hoje» sem a pergunta', () => {
  const emTratamento = { funil: 'Tratamento', etapa_tratamento: 'Em tratamento', proxima_sessao: '2026-11-18', hora_sessao: '15:00' };
  const doDia = { data_consulta: '2026-11-18', hora_consulta: '15:00', categoria_consulta: 'Sessão' };
  assert.deepEqual(saiu(conv({ ...emTratamento, ...doDia, situacao_consulta: 'Confirmado' })), ['consulta-vespera:parau_sessao_lembrete_vespera_confirmada', 'sessao-dia:parau_sessao_dia_confirmada']);
  assert.deepEqual(saiu(conv({ ...emTratamento, ...doDia, situacao_consulta: 'Agendado' })), ['consulta-vespera:parau_sessao_lembrete_vespera', 'sessao-dia:parau_sessao_confirmacao_dia']);
});

test('«Em tratamento»: «Confirmado» de OUTRO dia, de OUTRA hora, de uma avaliação ou sem consulta não é desta sessão — ela ainda pergunta', () => {
  const emTratamento = { funil: 'Tratamento', etapa_tratamento: 'Em tratamento', proxima_sessao: '2026-11-18', hora_sessao: '15:00' };
  const pergunta = ['sessao-dia:parau_sessao_confirmacao_dia'];
  // a avaliação de semanas atrás ficou «Confirmado»: nunca foi a confirmação desta sessão
  assert.deepEqual(saiu(conv({ ...emTratamento, data_consulta: '2026-10-20', hora_consulta: '09:00', categoria_consulta: 'Sessão', situacao_consulta: 'Confirmado' })), pergunta);
  // no mesmo dia, outra hora: outra sessão
  assert.deepEqual(saiu(conv({ ...emTratamento, data_consulta: '2026-11-18', hora_consulta: '09:00', categoria_consulta: 'Sessão', situacao_consulta: 'Confirmado' })), pergunta);
  // a mesma data e hora, mas é uma AVALIAÇÃO/retorno confirmado, não a sessão
  assert.deepEqual(saiu(conv({ ...emTratamento, data_consulta: '2026-11-18', hora_consulta: '15:00', categoria_consulta: 'Avaliação', situacao_consulta: 'Confirmado' })).filter((x) => x.startsWith('sessao-dia')), pergunta);
  // «Confirmado» sem consulta nenhuma na conversa: não dá para ligar a confirmação a esta sessão
  assert.deepEqual(saiu(conv({ ...emTratamento, situacao_consulta: 'Confirmado' })), pergunta);
});

test('os 4 textos «sem pedido» existem em TEXTOS_PARAU, usam só campos que a régua conhece e não perguntam nada', async () => {
  const { TEXTOS_PARAU } = await import('./chatwoot-regua-textos.js');
  const { camposDoModelo } = await import('./chatwoot-regua.js');
  const modelos = ['parau_consulta_lembrete_vespera_confirmada', 'parau_consulta_dia_confirmada', 'parau_sessao_lembrete_vespera_confirmada', 'parau_sessao_dia_confirmada'];
  for (const m of modelos) {
    assert.ok(TEXTOS_PARAU[m], m);
    assert.doesNotMatch(TEXTOS_PARAU[m]!, /\?/, `${m} não pergunta`);
    assert.ok(camposDoModelo(m).every((c) => c === 'contact.name' || c === 'lead.cf.2450736' || c === 'lead.cf.2450928'), m);
  }
});
