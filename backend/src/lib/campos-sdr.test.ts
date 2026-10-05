/**
 * Campos que a SDR preenchia (teste em seco).
 *
 * O que estes testes prendem:
 *  - Tipo de lead segue a definição do João: quem já estava na base é Resgate MESMO voltando por anúncio;
 *    "Transferido de outra unidade" é humano e não é tocado. O 1º contato é a data mais antiga entre a criação
 *    do cartão, o campo "Data do primeiro contato" e a data que a SDR escreve no nome; a etiqueta `importar_`
 *    não decide (05/10: ela marcava Resgate quem chegou em abril/maio e só foi importado em 28/05).
 *  - Responsável só sai de avaliação ainda AGENDADO (depois, a franquia mostra quem deu baixa, não quem marcou);
 *    marcado pela Sofia vira a opção da IA; nome fora da lista não inventa opção.
 *  - Data do cancelamento reconhece o status REAL da franquia ("DESISTÊNCIA A PEDIDO DO PACIENTE").
 *  - Nunca sobrescreve: campo preenchido vira "confere" ou "diverge".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SPINE_STATUS } from '../services/spine.service.js';
import {
  CAMPOS_SDR, dataDoCancelamento, datasNoNome, planejarCamposSdr, responsavelDoAgendamento, tipoDoLead, type CampoAtual,
} from './campos-sdr.js';

const DIA = 86_400;
const AGORA = Date.parse('2026-10-03T12:00:00Z') / 1000;
const OPCOES_RESP = ['GIULIA', 'ADRIELE', 'NATYELE', 'DOUTOR DIGITAL', 'GRAZIELLE', 'I.A SOFIA', 'SULAMITA', 'TAMIRES', 'NEIA'];
const avaliacao = (idStatus: number, modifiedBy: string | null) => ({ categoryName: 'AVALIAÇÃO', idStatus, modifiedBy });

const dia = (iso: string) => Date.parse(`${iso}T15:00:00Z`) / 1000;
const DATA = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const lidas = (nome: string, ref: number) => datasNoNome(nome, ref).map((e) => DATA(e * 1000));

test('datas no nome: com ano de 4 e de 2 dígitos, e sem ano (o ano anterior só na virada de ano)', () => {
  assert.deepEqual(lidas('Rosimar 14/5/2026', dia('2026-06-02')), ['2026-05-14']);
  assert.deepEqual(lidas('Eurides Paiva dos Santos 21/01/26', dia('2026-02-02')), ['2026-01-21']);
  assert.deepEqual(lidas('ELANE DA SILVA NOGUEIRA 26/1', dia('2026-09-30')), ['2026-01-26']);
  assert.deepEqual(lidas('Maria 20/12', dia('2026-01-10')), ['2025-12-20']);
  // sem ano e só um pouco à frente do agendamento não é virada de ano: é outra data, fica de fora
  assert.deepEqual(lidas('Maria 26/1', dia('2026-01-10')), []);
});

test('datas no nome: duas datas voltam as duas (a regra pega a mais antiga)', () => {
  assert.deepEqual(lidas('Nivas Alves 09/12/25 19/5/2026', dia('2026-06-01')), ['2025-12-09', '2026-05-19']);
});

test('datas no nome: sem data, impossível, colada em outros dígitos, depois do agendamento ou velha demais → nada', () => {
  assert.deepEqual(lidas('JOAQUIM', dia('2026-06-01')), []);
  assert.deepEqual(lidas('JOSÉ RUFINO 04/*12/26', dia('2026-06-01')), []);
  assert.deepEqual(lidas('Ivanete 25/02/26/02/26', dia('2026-06-01')), []);
  assert.deepEqual(lidas('Zilda 25/03/2617/03/26', dia('2026-06-01')), []);
  assert.deepEqual(lidas('Ana 31/02/26', dia('2026-06-01')), []);
  assert.deepEqual(lidas('Ana 10/13/26', dia('2026-06-01')), []);
  assert.deepEqual(lidas('NEDIANA 03/12/26', dia('2026-10-01')), []);   // dezembro de 2026 ainda não chegou
  assert.deepEqual(lidas('Lead (63) 99102-1043', dia('2026-10-01')), []);
  assert.deepEqual(lidas('CRISTIANE 26/06/06', dia('2026-10-01')), []);   // digitação de 26/06/26
  assert.deepEqual(lidas('Maria 15/03/1990', dia('2026-10-01')), []);     // nascimento não é 1º contato
});

test('tipo de lead: 1º contato = a data mais antiga entre criação, campo e nome; Resgate se agendou 90+ dias depois', () => {
  // importado em 28/05, mas o nome diz que chegou em 21/01 e agendou em 02/02 → Cadastro (a etiqueta não decide mais)
  assert.equal(tipoDoLead({ nome: 'Eurides 21/01/26', criadoEmEpoch: dia('2026-05-28'), primeiroContatoEpoch: null, referenciaEpoch: dia('2026-02-02') }), 'Cadastro');
  // cartão criado no dia do agendamento, mas o nome diz que o 1º contato foi em janeiro → Resgate
  assert.equal(tipoDoLead({ nome: 'ELANE 26/1', criadoEmEpoch: dia('2026-09-30'), primeiroContatoEpoch: null, referenciaEpoch: dia('2026-09-30') }), 'Resgate');
  // o campo "Data do primeiro contato" também conta
  assert.equal(tipoDoLead({ nome: 'Lead #1', criadoEmEpoch: dia('2026-09-30'), primeiroContatoEpoch: dia('2026-05-01'), referenciaEpoch: dia('2026-09-30') }), 'Resgate');
  // duas datas no nome: vale a mais antiga
  assert.equal(tipoDoLead({ nome: 'Nivas 09/12/25 19/5/2026', criadoEmEpoch: dia('2026-05-28'), primeiroContatoEpoch: null, referenciaEpoch: dia('2026-06-01') }), 'Resgate');
});

test('tipo de lead: cartão com mais de 90 dias ao agendar é Resgate; novo é Cadastro; sem referência não decide', () => {
  assert.equal(tipoDoLead({ nome: 'Lead', criadoEmEpoch: AGORA - 91 * DIA, primeiroContatoEpoch: null, referenciaEpoch: AGORA }), 'Resgate');
  assert.equal(tipoDoLead({ nome: 'Lead', criadoEmEpoch: AGORA - 2 * DIA, primeiroContatoEpoch: null, referenciaEpoch: AGORA }), 'Cadastro');
  // sem nenhuma data de 1º contato, ou sem referência: não decide (nunca usa "agora")
  assert.equal(tipoDoLead({ nome: 'Lead', criadoEmEpoch: null, primeiroContatoEpoch: null, referenciaEpoch: AGORA }), null);
  assert.equal(tipoDoLead({ nome: 'Lead 01/01/26', criadoEmEpoch: AGORA - 200 * DIA, primeiroContatoEpoch: null, referenciaEpoch: null }), null);
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
    nome: 'Maria 10/03/26',
    criadoEmEpoch: Date.parse('2026-09-01T00:00:00Z') / 1000,
    primeiroContatoEpoch: null,
    referenciaEpoch: AGORA,
    primeiraVez: true,
    consulta: avaliacao(SPINE_STATUS.AGENDADO, 'TAMIRES SANTOS'),
    feitoPelaIa: false,
    tratamento: { statusName: 'DESISTÊNCIA A PEDIDO DO PACIENTE', created: '2026-09-05T10:00:00Z', modified: '2026-09-20T14:00:00Z' },
  });
  const por = Object.fromEntries(r.map((x) => [x.campo, x]));
  assert.equal(por[CAMPOS_SDR.TIPO_LEAD].acao, 'diverge');            // 1º contato em março pelo nome = Resgate; a SDR pôs Cadastro
  assert.equal(por[CAMPOS_SDR.RESPONSAVEL].acao, 'gravar');
  assert.equal(por[CAMPOS_SDR.RESPONSAVEL].valor, 'TAMIRES');
  assert.equal(por[CAMPOS_SDR.DATA_CANCELAMENTO].acao, 'confere');    // mesmo dia
});

test('plano: "Transferido de outra unidade" é humano — nem compara nem grava', () => {
  const r = planejarCamposSdr({
    campo: conta({ [CAMPOS_SDR.TIPO_LEAD]: { valor: 'TRANSFERIDO DE OUTRA UNIDADE', opcoes: [] } }),
    nome: 'Lead', criadoEmEpoch: AGORA - 200 * DIA, primeiroContatoEpoch: null, referenciaEpoch: AGORA, primeiraVez: true,
    consulta: avaliacao(SPINE_STATUS.AGENDADO, 'TAMIRES'), feitoPelaIa: false, tratamento: null,
  });
  assert.equal(r.length, 0);
});

test('plano: sem consulta não decide o tipo de lead; conta sem os campos não faz nada', () => {
  const sem = planejarCamposSdr({
    campo: conta({ [CAMPOS_SDR.TIPO_LEAD]: { valor: null, opcoes: [] } }),
    nome: 'Lead', criadoEmEpoch: AGORA, primeiroContatoEpoch: null, referenciaEpoch: AGORA, primeiraVez: true, consulta: null, feitoPelaIa: false, tratamento: null,
  });
  assert.equal(sem.length, 0);
  const vazia = planejarCamposSdr({
    campo: () => null, nome: 'Lead', criadoEmEpoch: AGORA, primeiroContatoEpoch: null, referenciaEpoch: AGORA, primeiraVez: true,
    consulta: avaliacao(SPINE_STATUS.AGENDADO, 'TAMIRES'), feitoPelaIa: false,
    tratamento: { statusName: 'DESISTÊNCIA A PEDIDO DO PACIENTE', created: '2026-10-01T00:00:00Z', modified: '2026-09-20T14:00:00Z' },
  });
  assert.equal(vazia.length, 0);
});

test('plano: opção que a conta não tem não é proposta (evita 400 a cada varredura); a grafia da conta vence', () => {
  const base = { nome: 'Lead', criadoEmEpoch: AGORA - 200 * DIA, primeiroContatoEpoch: null, referenciaEpoch: AGORA, primeiraVez: true,
    consulta: avaliacao(SPINE_STATUS.AGENDADO, 'TAMIRES'), feitoPelaIa: false, tratamento: null };
  const outraLista = planejarCamposSdr({ ...base, campo: conta({ [CAMPOS_SDR.TIPO_LEAD]: { valor: null, opcoes: ['RESGATE DA BASE', 'NOVO CADASTRO'] } }) });
  assert.equal(outraLista.length, 0);
  const caixaAlta = planejarCamposSdr({ ...base, campo: conta({ [CAMPOS_SDR.TIPO_LEAD]: { valor: null, opcoes: ['RESGATE', 'CADASTRO'] } }) });
  assert.equal(caixaAlta[0].valor, 'RESGATE');
});

// ── Cópia do Tipo de lead para Tipo de agendamento e Tipo de fechamento (chave campos-sdr-tipos) ──
const TIPOS = ['Resgate', 'Cadastro'];
const baseCopia = {
  nome: 'Lead', criadoEmEpoch: AGORA - 2 * DIA, primeiroContatoEpoch: null, referenciaEpoch: AGORA, primeiraVez: false,
  consulta: avaliacao(SPINE_STATUS.ATENDIDO, 'RECEPÇÃO'), feitoPelaIa: false,
};

const SIM = { valor: 'Sim', opcoes: ['Sim', 'Não'] };

test('cópia dos tipos: só com copiarTipos; marca o item como cópia; copia o Tipo de lead do cartão, não o calculado', () => {
  const campos = conta({
    [CAMPOS_SDR.TIPO_LEAD]: { valor: 'Resgate', opcoes: [...TIPOS, 'TRANSFERIDO DE OUTRA UNIDADE'] },   // calculado seria Cadastro
    [CAMPOS_SDR.TIPO_AGENDAMENTO]: { valor: null, opcoes: TIPOS },
    [CAMPOS_SDR.TIPO_FECHAMENTO]: { valor: 'Cadastro', opcoes: TIPOS },
    '✓ Fechou tratamento': SIM,
  });
  const sem = planejarCamposSdr({ ...baseCopia, campo: campos, tratamento: null });
  assert.equal(sem.filter((x) => x.copia).length, 0);

  const r = planejarCamposSdr({ ...baseCopia, campo: campos, copiarTipos: true, tratamento: null });
  const por = Object.fromEntries(r.map((x) => [x.campo, x]));
  assert.equal(por[CAMPOS_SDR.TIPO_LEAD].copia, undefined);
  assert.equal(por[CAMPOS_SDR.TIPO_AGENDAMENTO].acao, 'gravar');
  assert.equal(por[CAMPOS_SDR.TIPO_AGENDAMENTO].valor, 'Resgate');
  assert.equal(por[CAMPOS_SDR.TIPO_AGENDAMENTO].copia, true);
  assert.equal(por[CAMPOS_SDR.TIPO_FECHAMENTO].acao, 'diverge');     // nunca sobrescreve
});

test('cópia dos tipos: Tipo de lead vazio não copia nada (o palpite não trava antes de alguém decidir)', () => {
  const r = planejarCamposSdr({
    ...baseCopia, copiarTipos: true, tratamento: null,
    campo: conta({
      [CAMPOS_SDR.TIPO_LEAD]: { valor: null, opcoes: TIPOS },
      [CAMPOS_SDR.TIPO_AGENDAMENTO]: { valor: null, opcoes: TIPOS },
      [CAMPOS_SDR.TIPO_FECHAMENTO]: { valor: null, opcoes: TIPOS },
      '✓ Fechou tratamento': SIM,
    }),
  });
  assert.deepEqual(r.filter((x) => x.copia), []);
});

test('cópia dos tipos: agendamento pede consulta; fechamento pede "Fechou tratamento = Sim"', () => {
  const campos = (fechou: CampoAtual | null) => conta({
    [CAMPOS_SDR.TIPO_LEAD]: { valor: 'Cadastro', opcoes: TIPOS },
    [CAMPOS_SDR.TIPO_AGENDAMENTO]: { valor: null, opcoes: TIPOS },
    [CAMPOS_SDR.TIPO_FECHAMENTO]: { valor: null, opcoes: TIPOS },
    ...(fechou ? { '✓ Fechou tratamento': fechou } : {}),
  });
  const naoFechou = planejarCamposSdr({ ...baseCopia, copiarTipos: true, tratamento: null, campo: campos(null) });
  assert.deepEqual(naoFechou.filter((x) => x.copia).map((x) => x.campo), [CAMPOS_SDR.TIPO_AGENDAMENTO]);
  const fechou = planejarCamposSdr({ ...baseCopia, copiarTipos: true, tratamento: null, consulta: null, campo: campos(SIM) });
  assert.deepEqual(fechou.filter((x) => x.copia).map((x) => x.campo), [CAMPOS_SDR.TIPO_FECHAMENTO]);
});

test('cópia dos tipos: "Transferido de outra unidade" não tem par nas listas — não copia nada', () => {
  const r = planejarCamposSdr({
    ...baseCopia, copiarTipos: true, tratamento: null,
    campo: conta({
      [CAMPOS_SDR.TIPO_LEAD]: { valor: 'TRANSFERIDO DE OUTRA UNIDADE', opcoes: [...TIPOS, 'TRANSFERIDO DE OUTRA UNIDADE'] },
      [CAMPOS_SDR.TIPO_AGENDAMENTO]: { valor: null, opcoes: TIPOS },
      [CAMPOS_SDR.TIPO_FECHAMENTO]: { valor: null, opcoes: TIPOS },
      '✓ Fechou tratamento': SIM,
    }),
  });
  assert.equal(r.length, 0);
});
