/**
 * O bloco TRATAMENTO vindo da franquia.
 *
 * Dois riscos que estes testes prendem: gravar o protocolo ERRADO num campo que decide
 * preço, e contar desmarcação como falta — o que faria a clínica parecer que perde
 * paciente que não perdeu.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escritasDoTratamento, protocoloDoCartao } from './tratamento-para-cartao.js';

const OPCOES = [
  '01 Mês — PREVENTIVO CERVICAL', '01 Mês — MANUTENÇÃO CERVICAL', '01 Mês — MANUTENÇÃO LOMBAR',
  '01 Mês — DESCOMPRESSÃO CERVICAL', '01 Mês — DESCOMPRESSÃO LOMBAR', '02 Meses — POSTURAL',
  '03 Meses — LOMBAR CRÔNICO', '03 Meses — LOMBAR AGUDO', '03 Meses — CERVICAL CRÔNICO',
  '03 Meses — CERVICAL AGUDO',
];
const vazio = () => null;
const acha = (l: ReturnType<typeof escritasDoTratamento>, c: string) => l.find((e) => e.campo === c);

test('casa o protocolo da franquia com a opção do cartão, que são escritos diferente', () => {
  assert.equal(protocoloDoCartao('PROTOCOLO 03 MESES, LOMBAR, CRÔNICO', OPCOES), '03 Meses — LOMBAR CRÔNICO');
  assert.equal(protocoloDoCartao('PROTOCOLO 03 MESES, CERVICAL, AGUDO', OPCOES), '03 Meses — CERVICAL AGUDO');
});

test('protocolo ambíguo fica VAZIO — errar aqui erra o preço', () => {
  // "03 meses lombar" sem dizer se é crônico ou agudo: dois candidatos, nenhum vence.
  assert.equal(protocoloDoCartao('PROTOCOLO 03 MESES, LOMBAR', OPCOES), null);
});

test('protocolo que não existe no cartão não é inventado', () => {
  assert.equal(protocoloDoCartao('PROTOCOLO 12 MESES, JOELHO', OPCOES), null);
  assert.equal(protocoloDoCartao('', OPCOES), null);
  assert.equal(protocoloDoCartao(null, OPCOES), null);
  assert.equal(protocoloDoCartao('PROTOCOLO 03 MESES, LOMBAR, CRÔNICO', []), null);
});

test('a queixa do fisioterapeuta entra — mas só onde a IA não capturou nada', () => {
  const t = { assessment: { problem: 'DOR LOMBAR IRRADIADA PARA MIE' } };
  const cheio = escritasDoTratamento({ sessoes: [], tratamento: t, opcoesProtocolo: OPCOES, valorAtual: () => 'dor nas costas há 2 meses' });
  assert.equal(acha(cheio, '✎ Queixa'), undefined, 'o que o paciente disse com as palavras dele não se apaga');
  const vazioL = escritasDoTratamento({ sessoes: [], tratamento: t, opcoesProtocolo: OPCOES, valorAtual: vazio });
  assert.equal(acha(vazioL, '✎ Queixa')?.valor, 'DOR LOMBAR IRRADIADA PARA MIE');
});

test('preço zero não vira valor de tratamento', () => {
  const l = escritasDoTratamento({ sessoes: [], tratamento: { price: '0.00' }, opcoesProtocolo: OPCOES, valorAtual: vazio });
  assert.equal(acha(l, '¤ Valor do tratamento'), undefined);
});

test('conta as sessões e acha a última', () => {
  const sessoes = [
    { dateAttendance: '2026-09-01 10:00', statusName: 'ATENDIDO' },
    { dateAttendance: '2026-09-15 10:00', statusName: 'ATENDIDO' },
    { dateAttendance: '2026-09-20 10:00', statusName: 'NÃO COMPARECEU' },
  ];
  const l = escritasDoTratamento({ sessoes, tratamento: null, opcoesProtocolo: OPCOES, valorAtual: vazio });
  assert.equal(acha(l, '# Sessões previstas')?.valor, 3);
  assert.equal(acha(l, '✓ Compareceu à última sessão marcada')?.valor, 'Não');
  assert.ok(acha(l, '◷ Última sessão marcada'));
});

test('DESMARCADO e REMARCADO não são falta — só NÃO COMPARECEU', () => {
  const sessoes = [
    { dateAttendance: '2026-09-01 10:00', statusName: 'DESMARCADO' },
    { dateAttendance: '2026-09-02 10:00', statusName: 'REMARCADO' },
    { dateAttendance: '2026-09-03 10:00', statusName: 'NÃO COMPARECEU' },
    { dateAttendance: '2026-09-04 10:00', statusName: 'ATENDIDO' },
  ];
  const l = escritasDoTratamento({ sessoes, tratamento: null, opcoesProtocolo: OPCOES, valorAtual: vazio });
  assert.equal(acha(l, '# Nº de faltas em sessão')?.valor, 1, 'contar desmarcação faria a clínica parecer pior do que é');
});

test('nada da franquia, nada a gravar', () => {
  assert.equal(escritasDoTratamento({ sessoes: [], tratamento: null, opcoesProtocolo: OPCOES, valorAtual: vazio }).length, 0);
});

test('nenhuma escrita sobrescreve — o bloco de tratamento só preenche buraco', () => {
  const l = escritasDoTratamento({
    sessoes: [{ dateAttendance: '2026-09-01 10:00', statusName: 'ATENDIDO' }],
    tratamento: { price: '3680', typeName: 'PROTOCOLO 03 MESES, LOMBAR, CRÔNICO', assessment: { problem: 'x' } },
    opcoesProtocolo: OPCOES, valorAtual: vazio,
  });
  assert.ok(l.length >= 4);
  for (const e of l) assert.equal(e.sobrescreve, false, `${e.campo} não pode sobrescrever`);
});
