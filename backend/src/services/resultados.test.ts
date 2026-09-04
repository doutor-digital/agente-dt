import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classificarDesfecho, extrairComportamento } from './resultados.service.js';

const t = (s: string) => new Date(s);

/**
 * O livro de resultados é a "recompensa" da Sofia: marcou? compareceu? Um erro aqui
 * não aparece como erro — aparece como uma unidade parecendo boa quando não é.
 */
test('extrai o que a IA fez: latência da 1ª resposta, agenda consultada, horários oferecidos, preço, marcação', () => {
  const msgs = [
    { role: 'user', content: 'Oi, quero marcar', createdAt: t('2026-09-01T10:00:00Z') },
    { role: 'assistant', content: 'Oi! Me conta onde dói?', createdAt: t('2026-09-01T10:00:12Z') },
    { role: 'user', content: 'lombar', createdAt: t('2026-09-01T10:01:00Z') },
    { role: 'assistant', content: 'A consulta é R$ 250 antecipado ou R$ 350 no dia. Tenho terça 10h ou 14h.', createdAt: t('2026-09-01T10:01:20Z') },
    { role: 'user', content: '10h', createdAt: t('2026-09-01T10:02:00Z') },
    { role: 'assistant', content: '✅ Agendamento confirmado!', createdAt: t('2026-09-01T10:02:30Z') },
  ];
  const steps = [
    { kind: 'TOOL_RESULT', title: 'consultar_horarios 2026-09-08: 2 confirmado(s)', payload: { oferecer: ['10:00', '14:00'] }, createdAt: t('2026-09-01T10:01:10Z') },
    { kind: 'TOOL_RESULT', title: 'Consulta marcada: 2026-09-08 10:00 (idSchedule 555)', payload: { data: '2026-09-08', hora: '10:00', idSchedule: 555 }, createdAt: t('2026-09-01T10:02:25Z') },
  ];
  const c = extrairComportamento(msgs, steps);
  assert.equal(c.msgsPaciente, 3);
  assert.equal(c.msgsIa, 3);
  assert.equal(c.primeiraRespostaSeg, 12);
  assert.equal(c.consultasAgenda, 1);
  assert.equal(c.horariosOferecidos, 2);
  assert.equal(c.precoNaMsg, 2, 'o preço apareceu na 2ª mensagem da IA');
  assert.equal(c.agendouIa, true);
  assert.equal(c.agendadoPara, '2026-09-08T10:00');
  assert.equal(c.spineIdSchedule, 555);
});

test('sem marcação e sem preço: campos nulos, não zero disfarçado', () => {
  const c = extrairComportamento(
    [{ role: 'user', content: 'oi', createdAt: t('2026-09-01T10:00:00Z') }],
    [],
  );
  assert.equal(c.agendouIa, false);
  assert.equal(c.precoNaMsg, null);
  assert.equal(c.primeiraRespostaSeg, null);
});

const base = {
  agendouIa: false, agendouKommo: false, statusFranquia: null as number | null, consultaSumiu: false,
  situacaoKommo: null as string | null, dataConsulta: null as Date | null, ultimaMsgEm: t('2026-09-01T10:00:00Z'),
  agora: t('2026-09-04T12:00:00Z'),
};

test('a franquia manda: ATENDIDO = compareceu, NÃO COMPARECEU = faltou, DESMARCADO = cancelou (todos definitivos)', () => {
  assert.deepEqual(classificarDesfecho({ ...base, agendouIa: true, statusFranquia: 42 }), { desfecho: 'compareceu', compareceu: true, final: true });
  assert.deepEqual(classificarDesfecho({ ...base, agendouIa: true, statusFranquia: 40 }), { desfecho: 'faltou', compareceu: false, final: true });
  assert.deepEqual(classificarDesfecho({ ...base, agendouIa: true, statusFranquia: 57 }), { desfecho: 'cancelou', compareceu: null, final: true });
  assert.deepEqual(classificarDesfecho({ ...base, agendouIa: true, consultaSumiu: true }), { desfecho: 'cancelou', compareceu: null, final: true });
});

test('sem franquia, vale o campo do Kommo; "Não compareceu" não pode virar compareceu', () => {
  assert.equal(classificarDesfecho({ ...base, agendouKommo: true, situacaoKommo: 'Não compareceu' }).desfecho, 'faltou');
  assert.equal(classificarDesfecho({ ...base, agendouKommo: true, situacaoKommo: 'Compareceu' }).desfecho, 'compareceu');
  assert.equal(classificarDesfecho({ ...base, agendouKommo: true, situacaoKommo: 'Cancelado' }).desfecho, 'cancelou');
});

test('marcou para o futuro: agendado_futuro e ainda não é definitivo', () => {
  const r = classificarDesfecho({ ...base, agendouIa: true, statusFranquia: 37, dataConsulta: t('2026-09-10T13:00:00Z') });
  assert.deepEqual(r, { desfecho: 'agendado_futuro', compareceu: null, final: false });
});

test('consulta passou e ninguém registrou: sem_registro, definitivo só depois de 7 dias', () => {
  const cedo = classificarDesfecho({ ...base, agendouKommo: true, dataConsulta: t('2026-08-30T13:00:00Z') });
  assert.equal(cedo.desfecho, 'sem_registro');
  assert.equal(cedo.final, false);
  const tarde = classificarDesfecho({ ...base, agendouKommo: true, dataConsulta: t('2026-08-20T13:00:00Z') });
  assert.equal(tarde.final, true);
});

test('não marcou: em_conversa até 7 dias de silêncio, depois nao_agendou', () => {
  assert.equal(classificarDesfecho({ ...base, ultimaMsgEm: t('2026-09-03T10:00:00Z') }).desfecho, 'em_conversa');
  assert.deepEqual(classificarDesfecho({ ...base, ultimaMsgEm: t('2026-08-20T10:00:00Z') }), { desfecho: 'nao_agendou', compareceu: null, final: true });
});
