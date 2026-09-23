import { test } from 'node:test';
import assert from 'node:assert/strict';

import { candidatoARevisao, escolherPaciente, termosDeBuscaDoNome, type ClienteFranquia } from './franquia-sync-worker.js';
import { CAMPOS_SYNC, chaveTelefone, nomeDaFranquia } from './franquia-sync.js';
import { ETAPA } from './franquia-move.js';

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
