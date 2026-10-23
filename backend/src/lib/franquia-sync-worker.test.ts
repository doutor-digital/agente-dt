import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

import { _interno, aplicarMovimento, camposDaConta, candidatoARevisao, type ResumoSync, escolherPaciente, termosDeBuscaDoNome, type ClienteFranquia } from './franquia-sync-worker.js';
import { SPINE_STATUS, SpineService } from '../services/spine.service.js';
import { CAMPOS_SYNC, chaveTelefone, nomeDaFranquia } from './franquia-sync.js';
import { ETAPA } from './franquia-move.js';
import { _semearParaTeste } from './automacoes-estado.js';

// ── quais termos o cartão gera ─────────────────────────────────────────────────
test('termosDeBuscaDoNome: cada pessoa do título vira termos, do específico ao largo, com sobrenome', () => {
  // o paciente era o SEGUNDO nome, e a franquia escreve "ALEXSANDRO"
  const t = termosDeBuscaDoNome('MARIA DA PENHA - ALEXANDRO SANT ANA 17/08/2026');
  assert.ok(t.includes('MARIA DA PENHA'));
  assert.ok(t.includes('ALEXANDRO SANT ANA'));
  assert.ok(t.includes('SANT ANA'), 'sobrenome acha quem tem o primeiro nome escrito diferente');
  // o paciente estava entre PARÊNTESES
  assert.ok(termosDeBuscaDoNome('Ivair Diniz(Victoria Diniz)  25/02/26').includes('Victoria Diniz'));
  assert.ok(termosDeBuscaDoNome('Elci Rocha (Jonas Lourenço) 09/03/26').includes('Jonas Lourenço'));
  // "LUVAS" é erro de digitação de "LUCAS": só o sobrenome sozinho acha
  assert.ok(termosDeBuscaDoNome('LUVAS LINHARES 29/07/26').includes('LINHARES'));
  // barra separa duas pessoas
  assert.ok(termosDeBuscaDoNome('Dina Alves / Felipe Correia da Silva 18/03/26').includes('Felipe Correia da Silva'));
  // partícula não vira termo
  assert.ok(!termosDeBuscaDoNome('Ana da Silva').includes('da'));
  for (const n of ['Lead #22647811', 'Lead 2 23/09/2026', 'Zé', '', null, undefined]) {
    assert.deepEqual(termosDeBuscaDoNome(n), [], String(n));
  }
});

test('termosDeBuscaDoNome: teto de chamadas por cartão', () => {
  assert.ok(termosDeBuscaDoNome('Ana Paula Souza Lima - Jose Carlos Pereira Silva (Maria Aparecida Gomes)').length <= 10);
});

// ── quem é o paciente ──────────────────────────────────────────────────────────
const c = (idClient: number, name: string, whatsapp: string | null): ClienteFranquia => ({ idClient, name, whatsapp });
const alvos = (...ns: string[]) => new Set(ns.map(nomeDaFranquia));
const FONE = chaveTelefone('+5527999232187');

test('escolherPaciente: telefone manda, mesmo com o nome diferente', () => {
  const r = escolherPaciente([c(1, 'ALEXSANDRO SANT ANA', '+5527999232187'), c(2, 'MARIA DA PENHA', '(27) 98813-4299')], FONE, alvos('MARIA DA PENHA'));
  assert.deepEqual(r, { tipo: 'achou', idClient: 1, por: 'telefone' });
});

test('escolherPaciente: telefone com formatos diferentes é o mesmo telefone', () => {
  for (const f of ['+5527999232187', '5527999232187', '(27) 99923-2187', '27999232187']) {
    assert.equal(escolherPaciente([c(9, 'QUALQUER NOME', f)], FONE, alvos('outro')).tipo, 'achou', f);
  }
});

test('escolherPaciente: prefixo IA-/N- da franquia não atrapalha o nome', () => {
  assert.deepEqual(escolherPaciente([c(3, 'N-LUCAS LINHARES AMORIM', null)], '', alvos('n-lucas linhares amorim')), { tipo: 'achou', idClient: 3, por: 'nome' });
  assert.deepEqual(escolherPaciente([c(4, 'IA-MARIA DA PENHA', null)], '', alvos('Maria da Penha')), { tipo: 'achou', idClient: 4, por: 'nome' });
});

test('escolherPaciente: vários no mesmo telefone vão pro desempate pelo histórico', () => {
  const r = escolherPaciente([c(1, 'MARIA SOUZA', '+5527999232187'), c(2, 'JOAO SOUZA', '+5527999232187')], FONE, alvos('desconhecido'));
  assert.equal(r.tipo, 'desempatar');
  assert.deepEqual(r.tipo === 'desempatar' ? r.candidatos.map((x) => x.idClient) : [], [1, 2]);
});

test('escolherPaciente: no mesmo telefone, quem casa pelo nome tem preferência (mãe e filho)', () => {
  const r = escolherPaciente([c(1, 'MARIA SOUZA', '+5527999232187'), c(2, 'JOAO SOUZA', '+5527999232187')], FONE, alvos('Joao Souza'));
  assert.equal(r.tipo, 'desempatar');
  assert.deepEqual(r.tipo === 'desempatar' ? r.candidatos.map((x) => x.idClient) : [], [2]);
});

test('escolherPaciente: sem telefone, nome exato e único vale; homônimo não', () => {
  assert.deepEqual(escolherPaciente([c(1, 'ROBERTO MONTEIRO', null)], '', alvos('Roberto Monteiro')), { tipo: 'achou', idClient: 1, por: 'nome' });
  assert.deepEqual(escolherPaciente([c(1, 'MARIA DA PENHA', null), c(2, 'MARIA DA PENHA', null)], '', alvos('Maria da Penha')), { tipo: 'nenhum', motivo: 'homonimos' });
});

test('escolherPaciente: nome exato com OUTRO telefone conhecido é outra pessoa', () => {
  const r = escolherPaciente([c(1, 'MARIA DA PENHA', '(27) 98813-4299')], FONE, alvos('Maria da Penha'));
  assert.deepEqual(r, { tipo: 'nenhum', motivo: 'nome nao casa' });
});

test('escolherPaciente: nome parecido não basta — só o exato ou o telefone', () => {
  assert.equal(escolherPaciente([c(1, 'ROBERTO MONTEIRO CORREIRA', null)], '', alvos('Roberto Monteiro')).tipo, 'nenhum');
});

test('escolherPaciente: sem candidato nenhum', () => {
  assert.deepEqual(escolherPaciente([], FONE, alvos('x')), { tipo: 'nenhum', motivo: 'sem candidatos' });
  assert.deepEqual(escolherPaciente([{ idClient: null, name: 'SEM ID', whatsapp: null }], FONE, alvos('x')), { tipo: 'nenhum', motivo: 'sem candidatos' });
});

// ── quais cartões a revisão olha ───────────────────────────────────────────────
const CORTE = 1_790_000_000;
const val = (data?: number, situacao?: string) => ({
  ...(data !== undefined ? { [CAMPOS_SYNC.DATA_CONSULTA]: String(data) } : {}),
  ...(situacao !== undefined ? { [CAMPOS_SYNC.SITUACAO]: situacao } : {}),
}) as Record<string, string | null>;

test('candidatoARevisao: CONFERIR NA FRANQUIA é sempre reavaliada', () => {
  assert.equal(candidatoARevisao(ETAPA.CONFERIR, val(), CORTE), true);
  assert.equal(candidatoARevisao(ETAPA.CONFERIR, val(CORTE + 99999, 'Atendido'), CORTE), true);
});

test('candidatoARevisao: AGENDADO só com consulta velha ou sem data', () => {
  assert.equal(candidatoARevisao(ETAPA.AGENDADO, val(CORTE - 1), CORTE), true, 'consulta mais velha que a janela');
  assert.equal(candidatoARevisao(ETAPA.AGENDADO, val(), CORTE), true, 'sem data nenhuma');
  assert.equal(candidatoARevisao(ETAPA.AGENDADO, val(CORTE + 1), CORTE), false, 'consulta recente: a varredura normal cobre');
});

test('candidatoARevisao: COMPARECEU/NEGOCIAÇÃO só quando a franquia não confirmou o atendimento', () => {
  for (const etapa of [ETAPA.COMPARECEU, ETAPA.NEGOCIACAO]) {
    assert.equal(candidatoARevisao(etapa, val(CORTE + 1, 'Atendido'), CORTE), false, `${etapa} confirmado`);
    assert.equal(candidatoARevisao(etapa, val(CORTE + 1, 'Desmarcado'), CORTE), true, `${etapa} com outra situação`);
    assert.equal(candidatoARevisao(etapa, val(CORTE + 1), CORTE), true, `${etapa} sem situação`);
    assert.equal(candidatoARevisao(etapa, val(undefined, 'Atendido'), CORTE), true, `${etapa} sem data`);
  }
});

test('candidatoARevisao: etapa que a revisão não olha', () => {
  for (const etapa of [ETAPA.QUALIFICACAO, ETAPA.ESPERA, ETAPA.NAO_COMPARECEU, ETAPA.GANHO, ETAPA.PERDIDO, ETAPA.RETORNO, ETAPA.INC]) {
    assert.equal(candidatoARevisao(etapa, val(), CORTE), false, etapa);
  }
});

// ── move em seco ───────────────────────────────────────────────────────────────
test('aplicarMovimento: com o move em seco NADA toca no Kommo e o resumo conta por transição', async () => {
  const chamadas: string[] = [];
  const kommo = new Proxy({}, { get: (_t, nome) => async () => { chamadas.push(String(nome)); } }) as never;
  const funis = { idDe: () => ({ pipelineId: 1, statusId: 2 }) } as never;
  const unit = { slug: 'doutor-hernia-acailandia' } as never;
  const resumo: ResumoSync = { unit: 'x', em: '', agendamentos: 0, tratamentos: 0, pacientes: 0, comLead: 0, semLead: 0, escritas: 0, erros: 0, exemplosSemLead: [], movimentos: 0, revisados: 0 };

  _semearParaTeste([{ slug: 'doutor-hernia-acailandia', automacao: 'franquia-move', estado: 'seco' }]);
  try {
    for (const lead of [1, 2]) await aplicarMovimento(unit, kommo, funis, lead, { funil: 'COMERCIAL', para: ETAPA.NEGOCIACAO, motivo: 't' }, resumo, ETAPA.COMPARECEU);
    // PERDIDO também passa pelo portão: sem ele, fecharComoPerdido escreveria no Kommo
    await aplicarMovimento(unit, kommo, funis, 3, { funil: 'COMERCIAL', para: ETAPA.PERDIDO, motivo: 't' }, resumo, ETAPA.COMPARECEU);
  } finally {
    _semearParaTeste([]);
  }
  assert.deepEqual(chamadas, [], 'seco não pode chamar o Kommo');
  assert.equal(resumo.movimentos, 0);
  assert.deepEqual(resumo.simulados, { 'COMPARECEU → EM NEGOCIAÇÃO': 2, 'COMPARECEU → PERDIDO': 1 });
});

// ── quem é o cartão na franquia (⚙ idClient) ───────────────────────────────────
const SLUG = 'doutor-hernia-acailandia';
const CAMPOS = camposDaConta([
  { id: 11, name: '⚙ idClient (franquia)', type: 'numeric' },
  { id: 12, name: '⚙ idTreatment (franquia)', type: 'numeric' },
  { id: 13, name: '# Sessões realizadas', type: 'numeric' },
  { id: 14, name: '# Nº de faltas', type: 'numeric' },
  { id: 15, name: '# Sessões agendadas (por vir)', type: 'numeric' },
  { id: 16, name: '# Sessões no histórico', type: 'numeric' },
  { id: 17, name: '⚕ Status do tratamento', type: 'text' },
]);

const resumoVazio = (): ResumoSync => ({ unit: SLUG, em: '', agendamentos: 0, tratamentos: 0, pacientes: 0, comLead: 0, semLead: 0, escritas: 0, erros: 0, exemplosSemLead: [], movimentos: 0, revisados: 0 });

interface Escrita { leadId: number; campo: number; tipo: string; valor: unknown }

function kommoFalso(escritas: Escrita[], leads: Record<string, unknown[]> = {}) {
  return {
    setLeadCustomFieldValue: async (leadId: number, campo: number, tipo: string, valor: unknown) => { escritas.push({ leadId, campo, tipo, valor }); },
    clearLeadCustomField: async () => {},
    listLeadsPorEtapa: async (pipelineId: number, statusId: number, _l?: number, page = 1) => (page === 1 ? (leads[`${pipelineId}:${statusId}`] ?? []) : []),
  } as never;
}

const ctxDe = (escritas: Escrita[], extra: Record<string, unknown> = {}) => ({
  unit: { id: 'u1', slug: SLUG } as never,
  kommo: kommoFalso(escritas, (extra.leads as Record<string, unknown[]>) ?? {}),
  funis: { idDe: (_f: string, etapa: string) => (etapa === 'EM TRATAMENTO' ? { pipelineId: 1, statusId: 2 } : null) } as never,
  mapa: {},
  ops: { fisio: [], categoria: [], tratamento: [] },
  agoraEpoch: Math.floor(Date.now() / 1000),
  resumo: resumoVazio(),
  camposPorNome: CAMPOS,
  ...extra,
});

test('gravarIdClientNoCartao: grava o idClient que a agenda provou, e nada quando a conta não tem o campo', async () => {
  const escritas: Escrita[] = [];
  const ctx = ctxDe(escritas) as Parameters<typeof _interno.gravarIdClientNoCartao>[0];
  await _interno.gravarIdClientNoCartao(ctx, 70, 777);
  assert.deepEqual(escritas, [{ leadId: 70, campo: 11, tipo: 'numeric', valor: 777 }]);

  // conta nascida de uma versão antiga do cartão: sem o campo, nada acontece (e nada estoura)
  const outras: Escrita[] = [];
  const semCampo = ctxDe(outras, { camposPorNome: camposDaConta([{ id: 99, name: '✎ Queixa', type: 'text' }]) }) as Parameters<typeof _interno.gravarIdClientNoCartao>[0];
  await _interno.gravarIdClientNoCartao(semCampo, 70, 777);
  assert.deepEqual(outras, []);
});

test('gravarIdClientNoCartao: em seco não toca no Kommo', async () => {
  const escritas: Escrita[] = [];
  const ctx = ctxDe(escritas, { seco: true }) as Parameters<typeof _interno.gravarIdClientNoCartao>[0];
  await _interno.gravarIdClientNoCartao(ctx, 70, 777);
  assert.deepEqual(escritas, []);
});

// ── as sessões do cartão em tratamento não congelam ────────────────────────────
const sessao = (idSchedule: number, idTreatment: number | null, idStatus: number, dia: string) => ({
  idSchedule, idTreatment, idStatus, statusName: null, clientName: null, categoryName: 'Sessão',
  physicalTherapist: null, dateAttendanceUtc: `${dia}T13:00:00.000Z`, dateAttendanceLocal: null,
  dayLocal: dia, timeLocal: null, isBusy: true, requiresManualValidation: false,
});

const cartao = (id: number, campos: Array<[number, unknown]>) => ({
  id, name: 'PACIENTE TESTE', pipeline_id: 1, status_id: 2,
  custom_fields_values: campos.map(([field_id, value]) => ({ field_id, values: [{ value }] })),
});

const ATENDIDO = SPINE_STATUS.ATENDIDO;

/**
 * A ficha do paciente, como a franquia a devolve — com os tratamentos SEM `created`, `local` e `grau`,
 * que é justamente o que ela não manda.
 *
 * Cada teste usa um idClient próprio: o detalhe do paciente tem cache de 1 h por unidade+idClient, e
 * repetir o número faria um caso ler a ficha do anterior.
 */
function fichaFalsa(idClient: number, treatments: Array<{ idTreatment: number; statusName: string }>, schedules: unknown[]) {
  return mock.method(SpineService, 'getClient', async () => ({
    ok: true as const,
    data: { client: { idClient, name: 'PACIENTE TESTE', whatsapp: null, schedules, treatments: treatments.map((t) => ({ ...t, idStatus: null, typeName: null })) } },
  }));
}

test('fecharSessoesDoTratamento: o cartão em EM TRATAMENTO deixa de congelar — 7 no cartão, 8 na franquia', async () => {
  const escritas: Escrita[] = [];
  const leads = { '1:2': [cartao(70, [[11, 777], [12, 500], [13, 7], [16, 7]])] };
  const ctx = ctxDe(escritas, { leads }) as Parameters<typeof _interno.fecharSessoesDoTratamento>[0];
  const ficha = fichaFalsa(
    777,
    [{ idTreatment: 500, statusName: 'FINALIZADO' }],
    Array.from({ length: 8 }, (_v, i) => sessao(900 + i, null, ATENDIDO, `2026-09-0${i + 1}`)),
  );
  _semearParaTeste([{ slug: SLUG, automacao: 'franquia-sessoes', estado: 'ligado' }]);
  try {
    await _interno.fecharSessoesDoTratamento(ctx);
  } finally {
    _semearParaTeste([]);
    ficha.mock.restore();
  }
  assert.deepEqual(escritas.filter((e) => e.campo === 13), [{ leadId: 70, campo: 13, tipo: 'numeric', valor: 8 }], 'realizadas corrigidas');
  assert.ok(escritas.some((e) => e.campo === 16 && e.valor === 8), 'histórico corrigido');
});

test('fecharSessoesDoTratamento: cartão sem ⚙ idClient não é adivinhado pelo nome', async () => {
  const escritas: Escrita[] = [];
  const leads = { '1:2': [cartao(71, [[12, 500], [13, 7]])] };
  const ctx = ctxDe(escritas, { leads }) as Parameters<typeof _interno.fecharSessoesDoTratamento>[0];
  const ficha = fichaFalsa(778, [{ idTreatment: 500, statusName: 'FINALIZADO' }], [sessao(900, null, ATENDIDO, '2026-09-01')]);
  _semearParaTeste([{ slug: SLUG, automacao: 'franquia-sessoes', estado: 'ligado' }]);
  try {
    await _interno.fecharSessoesDoTratamento(ctx);
  } finally {
    _semearParaTeste([]);
    ficha.mock.restore();
  }
  assert.deepEqual(escritas, []);
  assert.equal(ficha.mock.callCount(), 0, 'sem idClient não gasta chamada na franquia');
});

test('fecharSessoesDoTratamento: dois ciclos e sessão sem tratamento não fecha — contaria o ciclo errado', async () => {
  const escritas: Escrita[] = [];
  const leads = { '1:2': [cartao(72, [[11, 779], [12, 500], [13, 7]])] };
  const ctx = ctxDe(escritas, { leads }) as Parameters<typeof _interno.fecharSessoesDoTratamento>[0];
  const ficha = fichaFalsa(
    779,
    [{ idTreatment: 500, statusName: 'FINALIZADO' }, { idTreatment: 600, statusName: 'EM ANDAMENTO' }],
    [sessao(900, null, ATENDIDO, '2026-03-01'), sessao(901, null, ATENDIDO, '2026-09-01')],
  );
  _semearParaTeste([{ slug: SLUG, automacao: 'franquia-sessoes', estado: 'ligado' }]);
  try {
    await _interno.fecharSessoesDoTratamento(ctx);
  } finally {
    _semearParaTeste([]);
    ficha.mock.restore();
  }
  assert.deepEqual(escritas, [], 'sem como separar os ciclos, o cartão fica como está');
});

test('fecharSessoesDoTratamento: com a automação desligada não lê a franquia', async () => {
  const escritas: Escrita[] = [];
  const leads = { '1:2': [cartao(73, [[11, 780], [12, 500], [13, 7]])] };
  const ctx = ctxDe(escritas, { leads }) as Parameters<typeof _interno.fecharSessoesDoTratamento>[0];
  const ficha = fichaFalsa(780, [{ idTreatment: 500, statusName: 'FINALIZADO' }], [sessao(900, null, ATENDIDO, '2026-09-01')]);
  _semearParaTeste([{ slug: SLUG, automacao: 'franquia-sessoes', estado: 'desligado' }]);
  try {
    await _interno.fecharSessoesDoTratamento(ctx);
  } finally {
    _semearParaTeste([]);
    ficha.mock.restore();
  }
  assert.deepEqual(escritas, []);
  assert.equal(ficha.mock.callCount(), 0);
});
