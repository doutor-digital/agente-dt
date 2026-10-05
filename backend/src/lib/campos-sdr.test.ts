/**
 * Campos que a SDR preenchia (teste em seco).
 *
 * O que estes testes prendem:
 *  - Tipo de lead segue a definição do João: quem já estava na base é Resgate MESMO voltando por anúncio;
 *    "Transferido de outra unidade" é humano e não é tocado.
 *  - Responsável só sai de avaliação ainda AGENDADO (depois, a franquia mostra quem deu baixa, não quem marcou);
 *    marcado pela Sofia vira a opção da IA; nome fora da lista não inventa opção.
 *  - Data do cancelamento reconhece o status REAL da franquia ("DESISTÊNCIA A PEDIDO DO PACIENTE").
 *  - Nunca sobrescreve: campo preenchido vira "confere" ou "diverge".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SPINE_STATUS } from '../services/spine.service.js';
import {
  CAMPOS_SDR, dataDoCancelamento, planejarCamposSdr, responsavelDoAgendamento, tipoDoLead, type CampoAtual,
} from './campos-sdr.js';

const DIA = 86_400;
const AGORA = Date.parse('2026-10-03T12:00:00Z') / 1000;
const OPCOES_RESP = ['GIULIA', 'ADRIELE', 'NATYELE', 'DOUTOR DIGITAL', 'GRAZIELLE', 'I.A SOFIA', 'SULAMITA', 'TAMIRES', 'NEIA'];
const avaliacao = (idStatus: number, modifiedBy: string | null) => ({ categoryName: 'AVALIAÇÃO', idStatus, modifiedBy });

test('tipo de lead: importado da base antiga é Resgate mesmo que o cartão seja novo', () => {
  assert.equal(tipoDoLead({ tags: [{ name: 'importar_28052026_1600' }], criadoEmEpoch: AGORA - DIA, referenciaEpoch: AGORA }), 'Resgate');
});

test('tipo de lead: cartão com mais de 90 dias ao agendar é Resgate; novo é Cadastro', () => {
  assert.equal(tipoDoLead({ tags: [], criadoEmEpoch: AGORA - 91 * DIA, referenciaEpoch: AGORA }), 'Resgate');
  assert.equal(tipoDoLead({ tags: [{ name: 'meta-ads' }], criadoEmEpoch: AGORA - 2 * DIA, referenciaEpoch: AGORA }), 'Cadastro');
  // sem data de criação ou sem referência, e sem etiqueta: não decide (nunca usa "agora")
  assert.equal(tipoDoLead({ tags: undefined, criadoEmEpoch: null, referenciaEpoch: AGORA }), null);
  assert.equal(tipoDoLead({ tags: [], criadoEmEpoch: AGORA - 200 * DIA, referenciaEpoch: null }), null);
});

test('responsável: avaliação AGENDADO → primeiro nome de quem marcou, sem acento', () => {
  assert.equal(responsavelDoAgendamento({ consulta: avaliacao(SPINE_STATUS.AGENDADO, 'TAMIRES SANTOS DA SILVA'), feitoPelaIa: false, opcoes: OPCOES_RESP, primeiraVez: true }), 'TAMIRES');
  assert.equal(responsavelDoAgendamento({ consulta: avaliacao(SPINE_STATUS.AGENDADO, 'NÉIA MARTINS'), feitoPelaIa: false, opcoes: OPCOES_RESP, primeiraVez: true }), 'NEIA');
});

test('responsável: depois da baixa (atendido, confirmado, falta) não afirma nada', () => {
  for (const st of [SPINE_STATUS.ATENDIDO, SPINE_STATUS.CONFIRMADO, SPINE_STATUS.NAO_COMPARECEU, SPINE_STATUS.DESMARCADO]) {
    assert.equal(responsavelDoAgendamento({ consulta: avaliacao(st, 'AYLANA SILVA MENDES'), feitoPelaIa: false, opcoes: OPCOES_RESP, primeiraVez: true }), null);
  }
});

test('responsável: Sofia marcou → opção da IA; nome fora da lista e sessão não viram nada', () => {
  assert.equal(responsavelDoAgendamento({ consulta: avaliacao(SPINE_STATUS.CONFIRMADO, 'API'), feitoPelaIa: true, opcoes: OPCOES_RESP, primeiraVez: false }), 'I.A SOFIA');
  assert.equal(responsavelDoAgendamento({ consulta: avaliacao(SPINE_STATUS.AGENDADO, 'MARCELO DE BRITO COSTA'), feitoPelaIa: false, opcoes: OPCOES_RESP, primeiraVez: true }), null);
  assert.equal(responsavelDoAgendamento({ consulta: { categoryName: 'SESSÃO', idStatus: SPINE_STATUS.AGENDADO, modifiedBy: 'TAMIRES' }, feitoPelaIa: false, opcoes: OPCOES_RESP, primeiraVez: true }), null);
  // "DOUTOR" sozinho não pode casar com "DOUTOR DIGITAL" pelo primeiro nome
  assert.equal(responsavelDoAgendamento({ consulta: avaliacao(SPINE_STATUS.AGENDADO, 'DOUTOR FULANO'), feitoPelaIa: false, opcoes: OPCOES_RESP, primeiraVez: true }), null);
});

test('responsável: remarcação continua AGENDADO e troca o nome — depois da 1ª vez não afirma', () => {
  assert.equal(responsavelDoAgendamento({ consulta: avaliacao(SPINE_STATUS.AGENDADO, 'GRAZIELLE SOUSA'), feitoPelaIa: false, opcoes: OPCOES_RESP, primeiraVez: false }), null);
});

test('cancelamento: desistência de um ciclo ANTERIOR ao cartão não vai para o cartão novo', () => {
  const cartao = Date.parse('2026-09-01T00:00:00Z') / 1000;
  assert.equal(dataDoCancelamento({ statusName: 'DESISTÊNCIA A PEDIDO DO PACIENTE', created: '2025-11-02T10:00:00Z', modified: '2025-12-01T10:00:00Z' }, cartao), null);
  assert.equal(dataDoCancelamento({ statusName: 'DESISTÊNCIA A PEDIDO DO PACIENTE', created: '2026-09-10T10:00:00Z', modified: '2026-09-20T14:00:00Z' }, cartao), Date.parse('2026-09-20T14:00:00Z') / 1000);
});

test('cancelamento: reconhece o status real da franquia e usa a data da mudança', () => {
  const quando = Date.parse('2026-09-20T14:00:00Z') / 1000;
  assert.equal(dataDoCancelamento({ statusName: 'DESISTÊNCIA A PEDIDO DO PACIENTE', created: null, modified: '2026-09-20T14:00:00Z' }), quando);
  assert.equal(dataDoCancelamento({ statusName: 'CANCELADO', created: null, modified: '2026-09-20T14:00:00Z' }), quando);
  assert.equal(dataDoCancelamento({ statusName: 'EM ANDAMENTO', created: null, modified: '2026-09-20T14:00:00Z' }), null);
  assert.equal(dataDoCancelamento({ statusName: 'DESISTÊNCIA A PEDIDO DO PACIENTE', created: null, modified: null }), null);
});

function conta(campos: Record<string, CampoAtual>) {
  return (nome: string) => campos[nome] ?? null;
}

test('plano: campo vazio → gravar; preenchido → confere/diverge, nunca sobrescreve', () => {
  const r = planejarCamposSdr({
    campo: conta({
      [CAMPOS_SDR.TIPO_LEAD]: { valor: 'Cadastro', opcoes: ['Resgate', 'Cadastro', 'TRANSFERIDO DE OUTRA UNIDADE'] },
      [CAMPOS_SDR.RESPONSAVEL]: { valor: null, opcoes: OPCOES_RESP },
      [CAMPOS_SDR.DATA_CANCELAMENTO]: { valor: String(Date.parse('2026-09-20T03:00:00Z') / 1000), opcoes: [] },
    }),
    tags: [{ name: 'importar_18062026_1848' }],
    criadoEmEpoch: Date.parse('2026-09-01T00:00:00Z') / 1000,
    referenciaEpoch: AGORA,
    primeiraVez: true,
    consulta: avaliacao(SPINE_STATUS.AGENDADO, 'TAMIRES SANTOS'),
    feitoPelaIa: false,
    tratamento: { statusName: 'DESISTÊNCIA A PEDIDO DO PACIENTE', created: '2026-09-05T10:00:00Z', modified: '2026-09-20T14:00:00Z' },
  });
  const por = Object.fromEntries(r.map((x) => [x.campo, x]));
  assert.equal(por[CAMPOS_SDR.TIPO_LEAD].acao, 'diverge');            // importado = Resgate; a SDR pôs Cadastro
  assert.equal(por[CAMPOS_SDR.RESPONSAVEL].acao, 'gravar');
  assert.equal(por[CAMPOS_SDR.RESPONSAVEL].valor, 'TAMIRES');
  assert.equal(por[CAMPOS_SDR.DATA_CANCELAMENTO].acao, 'confere');    // mesmo dia
});

test('plano: "Transferido de outra unidade" é humano — nem compara nem grava', () => {
  const r = planejarCamposSdr({
    campo: conta({ [CAMPOS_SDR.TIPO_LEAD]: { valor: 'TRANSFERIDO DE OUTRA UNIDADE', opcoes: [] } }),
    tags: [{ name: 'importar_x' }], criadoEmEpoch: AGORA, referenciaEpoch: AGORA, primeiraVez: true,
    consulta: avaliacao(SPINE_STATUS.AGENDADO, 'TAMIRES'), feitoPelaIa: false, tratamento: null,
  });
  assert.equal(r.length, 0);
});

test('plano: sem consulta não decide o tipo de lead; conta sem os campos não faz nada', () => {
  const sem = planejarCamposSdr({
    campo: conta({ [CAMPOS_SDR.TIPO_LEAD]: { valor: null, opcoes: [] } }),
    tags: [], criadoEmEpoch: AGORA, referenciaEpoch: AGORA, primeiraVez: true, consulta: null, feitoPelaIa: false, tratamento: null,
  });
  assert.equal(sem.length, 0);
  const vazia = planejarCamposSdr({
    campo: () => null, tags: [], criadoEmEpoch: AGORA, referenciaEpoch: AGORA, primeiraVez: true,
    consulta: avaliacao(SPINE_STATUS.AGENDADO, 'TAMIRES'), feitoPelaIa: false,
    tratamento: { statusName: 'DESISTÊNCIA A PEDIDO DO PACIENTE', created: '2026-10-01T00:00:00Z', modified: '2026-09-20T14:00:00Z' },
  });
  assert.equal(vazia.length, 0);
});

test('plano: opção que a conta não tem não é proposta (evita 400 a cada varredura); a grafia da conta vence', () => {
  const base = { tags: [{ name: 'importar_x' }], criadoEmEpoch: AGORA, referenciaEpoch: AGORA, primeiraVez: true,
    consulta: avaliacao(SPINE_STATUS.AGENDADO, 'TAMIRES'), feitoPelaIa: false, tratamento: null };
  const outraLista = planejarCamposSdr({ ...base, campo: conta({ [CAMPOS_SDR.TIPO_LEAD]: { valor: null, opcoes: ['RESGATE DA BASE', 'NOVO CADASTRO'] } }) });
  assert.equal(outraLista.length, 0);
  const caixaAlta = planejarCamposSdr({ ...base, campo: conta({ [CAMPOS_SDR.TIPO_LEAD]: { valor: null, opcoes: ['RESGATE', 'CADASTRO'] } }) });
  assert.equal(caixaAlta[0].valor, 'RESGATE');
});
