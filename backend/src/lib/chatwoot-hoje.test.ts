/**
 * Tela "Hoje": números do dia em Belém, «A Lia separou», «Faça agora» (quentes primeiro) e «Por usuário hoje».
 * Agora = 2026-11-12 15:00 UTC (12:00 em Belém).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversasDasPaginas, diaEmBelem, montarHoje } from './chatwoot-hoje.js';

const AGORA = Date.parse('2026-11-12T15:00:00Z');
const s = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function conv(id: number, o: Record<string, any> = {}) {
  return {
    id,
    status: 'open',
    created_at: s('2026-11-01T12:00:00Z'),
    waiting_since: null,
    labels: [],
    custom_attributes: {},
    meta: { sender: { name: `Paciente ${id}`, phone_number: '+5594999990000' }, assignee: { name: 'Cleia' } },
    last_non_activity_message: null,
    ...o,
  };
}

test('dia em Belém vira à meia-noite de Belém (03:00 UTC)', () => {
  assert.equal(diaEmBelem(Date.parse('2026-11-12T02:59:00Z')), '2026-11-11');
  assert.equal(diaEmBelem(Date.parse('2026-11-12T03:00:00Z')), '2026-11-12');
});

test('páginas: junta, tira grupo e repetida', () => {
  const p = [{ data: { payload: [conv(1), conv(2, { meta: { sender: { identifier: '1203@g.us' } } })] } }, { data: { payload: [conv(1), conv(3)] } }];
  assert.deepEqual(conversasDasPaginas(p).map((c) => c.id), [1, 3]);
});

test('números do dia', () => {
  const lista = [
    conv(1, { created_at: s('2026-11-12T11:00:00Z') }), // chegou hoje (08:00 Belém)
    conv(2, { created_at: s('2026-11-12T02:00:00Z') }), // 23:00 de ontem em Belém: não é hoje
    conv(3, { waiting_since: s('2026-11-12T14:00:00Z') }), // esperando
    conv(4, { labels: ['sem-resposta'] }),
    conv(5, { custom_attributes: { etapa: 'Sofia qualifica' }, last_non_activity_message: { message_type: 1, created_at: s('2026-11-10T12:00:00Z') } }),
    conv(6, { custom_attributes: { data_consulta: '2026-11-12', situacao_consulta: 'Confirmado' } }),
    conv(7, { custom_attributes: { data_consulta: '2026-11-13', situacao_consulta: 'Agendado' } }),
    conv(8, { custom_attributes: { data_consulta: '2026-11-12' } }),
  ];
  const h = montarHoje(lista, AGORA, new Set([6, 99]));
  assert.equal(h.dia, '2026-11-12');
  assert.deepEqual(h.numeros, { chegaram: 1, esperando: 1, naoInteragiram: 2, agendaram: 1, naAgenda: 2, faltaConfirmar: 2 });
});

test('A Lia separou: não fecharam, retorno 60 dias, ver depois, faltaram (7 dias)', () => {
  const h = montarHoje(
    [
      conv(1, { custom_attributes: { etapa: 'Compareceu' } }),
      conv(2, { custom_attributes: { etapa: 'Pós-consulta', fechou_tratamento: true } }),
      conv(3, { custom_attributes: { data_alta: '2026-09-13' } }),
      conv(4, { custom_attributes: { data_alta: '2026-10-01' } }),
      conv(5, { custom_attributes: { retomar_em: '2026-11-12', motivo_espera: 'Exames' } }),
      conv(6, { custom_attributes: { retomar_em: '2026-11-20' } }),
      conv(7, { custom_attributes: { situacao_consulta: 'Não compareceu', data_consulta: '2026-11-10' } }),
      conv(8, { custom_attributes: { situacao_consulta: 'Não compareceu', data_consulta: '2026-10-01' } }),
    ],
    AGORA,
    new Set(),
  );
  assert.deepEqual(h.separou.naoFecharam.map((x) => x.id), [1]);
  assert.deepEqual(h.separou.retorno60.map((x) => x.id), [3]);
  assert.deepEqual(h.separou.verDepois.map((x) => x.id), [5]);
  assert.match(h.separou.verDepois[0]!.detalhe, /Exames · retomar em 12\/11\/2026/);
  assert.deepEqual(h.separou.faltaram.map((x) => x.id), [7]);
});

test('Faça agora: quentes primeiro, depois quem espera há mais tempo; resolvida não entra', () => {
  const h = montarHoje(
    [
      conv(1, { waiting_since: s('2026-11-12T14:50:00Z') }),
      conv(2, { waiting_since: s('2026-11-12T10:00:00Z') }),
      conv(3, { waiting_since: s('2026-11-12T14:55:00Z'), custom_attributes: { qualificacao: 'Quente' } }),
      conv(4, { waiting_since: s('2026-11-12T09:00:00Z'), status: 'resolved' }),
    ],
    AGORA,
    new Set(),
  );
  assert.deepEqual(h.facaAgora.map((x) => x.id), [3, 2, 1]);
  assert.match(h.facaAgora[0]!.detalhe, /^Quente · esperando você há 5 min/);
  assert.match(h.facaAgora[1]!.detalhe, /há 5 h/);
});

test('Por usuário hoje: abertas, esperando, responderam hoje e agendaram', () => {
  const h = montarHoje(
    [
      conv(1, { waiting_since: s('2026-11-12T14:00:00Z') }),
      conv(2, { last_non_activity_message: { message_type: 1, created_at: s('2026-11-12T13:00:00Z') } }),
      conv(3, { meta: { sender: { name: 'X' }, assignee: { name: 'Lorena' } }, status: 'resolved' }),
      conv(4, { meta: { sender: { name: 'Y' } } }),
    ],
    AGORA,
    new Set([2]),
  );
  const cleia = h.porUsuario.find((u) => u.nome === 'Cleia')!;
  assert.deepEqual(cleia, { nome: 'Cleia', conversas: 2, esperando: 1, responderamHoje: 1, agendaram: 1 });
  assert.deepEqual(h.porUsuario.find((u) => u.nome === 'Lorena'), { nome: 'Lorena', conversas: 0, esperando: 0, responderamHoje: 0, agendaram: 0 });
  assert.ok(h.porUsuario.find((u) => u.nome === 'Sem responsável'));
});
