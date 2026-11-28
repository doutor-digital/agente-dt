import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { etapaAgendadoDaUnidade, recusaDeAgendadoSemConsulta, TEXTO_RECUSA_AGENDADO, type DepsAgendadoSoDepoisDeMarcar } from './agendado-so-depois-de-marcar.js';

// Salto: scheduled_meeting = 113199875 (AGENDADO); CONFERIR NA FRANQUIA = 113199871 não está na lista da Sofia.
const AGENDADO = 113199875;
const salto = { id: 'u-salto', slug: 'doutor-hernia-salto', spineEnabled: true, pipelineIntents: { waiting_deferred: 113199867, scheduled_meeting: AGENDADO } } as unknown as Unit;

const AGORA = new Date('2026-11-28T00:05:11Z');

function deps(over: Partial<DepsAgendadoSoDepoisDeMarcar> = {}): DepsAgendadoSoDepoisDeMarcar & { leituras: string[] } {
  const leituras: string[] = [];
  return {
    leituras,
    franquiaDesmenteOCartao: async () => true,
    marcouNesteTurno: async () => { leituras.push('turno'); return false; },
    marcouPelaSofia: async () => { leituras.push('rastro'); return false; },
    lerCartao: async () => { leituras.push('cartao'); return { custom_fields_values: [] }; },
    cartaoTemConsulta: async () => false,
    agora: () => AGORA,
    ...over,
  };
}

test('Salto 5478545: AGENDADO sem consulta marcada é recusado (antes seguia e o cartão ia parar em CONFERIR)', async () => {
  const r = await recusaDeAgendadoSemConsulta({ unit: salto, leadId: 5478545, statusId: AGENDADO }, deps());
  assert.ok(r);
  assert.equal(r.texto, TEXTO_RECUSA_AGENDADO);
  assert.match(r.texto, /RECUSADO/);
  assert.match(r.texto, /agendar_consulta/); // neutro: cita a ferramenta sem afirmar que o paciente não tem consulta
});

test('agendar_consulta e mover_etapa na MESMA rodada (tools em paralelo): espera a marcação do turno e deixa passar', async () => {
  // o passo «Consulta marcada:» e a data no cartão ainda não existem quando o mover_etapa chega; quem sabe é o estado do turno
  const d = deps({ marcouNesteTurno: async () => true });
  assert.equal(await recusaDeAgendadoSemConsulta({ unit: salto, leadId: 1, statusId: AGENDADO }, d), null);
  assert.deepEqual(d.leituras, []);
});

test('depois de agendar_consulta dar certo (passo «Consulta marcada:» no rastro) o AGENDADO passa e nem lê o cartão', async () => {
  const d = deps({ marcouPelaSofia: async () => true });
  assert.equal(await recusaDeAgendadoSemConsulta({ unit: salto, leadId: 1, statusId: AGENDADO }, d), null);
  assert.deepEqual(d.leituras, ['turno']);
});

test('consulta marcada por gente (data no cartão de agora em diante) também libera o AGENDADO', async () => {
  const d = deps({ cartaoTemConsulta: async () => true });
  assert.equal(await recusaDeAgendadoSemConsulta({ unit: salto, leadId: 1, statusId: AGENDADO }, d), null);
});

test('outra etapa nunca é mexida: EM ESPERA, QUALIFICAÇÃO', async () => {
  for (const st of [113199867, 113199863, 113199739]) {
    assert.equal(await recusaDeAgendadoSemConsulta({ unit: salto, leadId: 1, statusId: st }, deps()), null);
  }
});

test('unidade sem franquia ligada: AGENDADO é a única prova que existe, passa', async () => {
  const semFranquia = { ...salto, spineEnabled: false } as unknown as Unit;
  assert.equal(await recusaDeAgendadoSemConsulta({ unit: semFranquia, leadId: 1, statusId: AGENDADO }, deps()), null);
});

test('unidade sem etapa scheduled_meeting, ou sem unidade: passa', async () => {
  const sem = { ...salto, pipelineIntents: { waiting_deferred: 1 } } as unknown as Unit;
  assert.equal(await recusaDeAgendadoSemConsulta({ unit: sem, leadId: 1, statusId: AGENDADO }, deps()), null);
  assert.equal(await recusaDeAgendadoSemConsulta({ unit: null, leadId: 1, statusId: AGENDADO }, deps()), null);
  assert.equal(etapaAgendadoDaUnidade(sem), null);
  assert.equal(etapaAgendadoDaUnidade(salto), AGENDADO);
});

test('falha ABERTA: se não deu para ler o rastro ou o cartão, deixa mover (não prende quem de fato marcou)', async () => {
  const rastro = deps({ marcouPelaSofia: async () => { throw new Error('banco fora'); } });
  assert.equal(await recusaDeAgendadoSemConsulta({ unit: salto, leadId: 1, statusId: AGENDADO }, rastro), null);
  const cartao = deps({ lerCartao: async () => { throw new Error('Kommo 429'); } });
  assert.equal(await recusaDeAgendadoSemConsulta({ unit: salto, leadId: 1, statusId: AGENDADO }, cartao), null);
});

test('a data de consulta lida usa "agora − 12 h" como corte: data de ciclo velho não libera', async () => {
  let corte: Date | null = null;
  const d = deps({ cartaoTemConsulta: async (_l, desde) => { corte = desde; return false; } });
  await recusaDeAgendadoSemConsulta({ unit: salto, leadId: 1, statusId: AGENDADO }, d);
  assert.equal(corte!.getTime(), AGORA.getTime() - 12 * 3600_000);
});

test('onde a franquia NÃO está movendo cartão (move/revisão desligados ou em seco), ninguém desmente o AGENDADO: passa sem ler nada', async () => {
  const d = deps({ franquiaDesmenteOCartao: async () => false });
  assert.equal(await recusaDeAgendadoSemConsulta({ unit: salto, leadId: 1, statusId: AGENDADO }, d), null);
  assert.deepEqual(d.leituras, []);
});

// ── a MESMA condição do sincronizador (franquia-sync-worker.ts, revisarPeloHistorico / sincronizarUnidade) ──
test('revisaoEscreveNoCartao: só quando sync, move e revisão estão LIGADOS e nada em "só no papel" (tela ou FRANQUIA_REVISAO_SECO)', async () => {
  const { revisaoEscreveNoCartao } = await import('./franquia-sync-worker.js');
  const { _semearParaTeste } = await import('./automacoes-estado.js');
  const slug = 'u-revisao';
  const estado = (sync: string, move: string, revisao: string) =>
    _semearParaTeste([
      { slug, automacao: 'franquia-sync', estado: sync as 'ligado' },
      { slug, automacao: 'franquia-move', estado: move as 'ligado' },
      { slug, automacao: 'franquia-revisao', estado: revisao as 'ligado' },
    ]);
  const antes = process.env.FRANQUIA_REVISAO_SECO;
  try {
    delete process.env.FRANQUIA_REVISAO_SECO;
    estado('ligado', 'ligado', 'ligado');
    assert.equal(revisaoEscreveNoCartao(slug), true);
    estado('seco', 'ligado', 'ligado'); // sync "só no papel": ninguém escreve no cartão
    assert.equal(revisaoEscreveNoCartao(slug), false);
    estado('ligado', 'seco', 'ligado');
    assert.equal(revisaoEscreveNoCartao(slug), false);
    estado('ligado', 'desligado', 'ligado');
    assert.equal(revisaoEscreveNoCartao(slug), false);
    estado('ligado', 'ligado', 'seco');
    assert.equal(revisaoEscreveNoCartao(slug), false);
    estado('ligado', 'ligado', 'desligado');
    assert.equal(revisaoEscreveNoCartao(slug), false);
    estado('desligado', 'ligado', 'ligado');
    assert.equal(revisaoEscreveNoCartao(slug), false);
    // a variável global de seco da revisão vale mesmo com tudo ligado na tela
    estado('ligado', 'ligado', 'ligado');
    process.env.FRANQUIA_REVISAO_SECO = '1';
    assert.equal(revisaoEscreveNoCartao(slug), false);
  } finally {
    if (antes === undefined) delete process.env.FRANQUIA_REVISAO_SECO;
    else process.env.FRANQUIA_REVISAO_SECO = antes;
    _semearParaTeste([]);
  }
});

test('o texto da recusa é neutro: não diz que o paciente "não tem consulta" nem manda oferecer horário de novo', () => {
  assert.doesNotMatch(TEXTO_RECUSA_AGENDADO, /não tem consulta|ainda não tem consulta/i);
  assert.match(TEXTO_RECUSA_AGENDADO, /NÃO ofereça horários de novo/);
});
