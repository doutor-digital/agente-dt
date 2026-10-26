import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agirNaDesistencia, textoTarefaCancelarNaFranquia, textoTarefaConferir, MARCA_OFERTA, MARCA_RECUSOU, type DepsDaAcao, type KommoDaAcao } from './desistencia-acao.js';
import { marcaVenceuSemResposta } from './desistencia-sem-resposta-worker.js';

const AGORA = new Date('2026-10-22T17:03:00Z');
const campo = (nome: string, valor: unknown) => ({ field_id: 1, field_name: nome, values: [{ value: valor }] });
const CONSULTA_EPOCH = 1792774800; // 23/10 14:00 -03

function montar(o: { lead?: object | null; vinculo?: string | null; ja?: Set<string>; criaFalha?: boolean; leadFalha?: boolean } = {}) {
  const tarefas: Array<{ leadId: number; text: string; completeAt: number; responsibleUserId?: number }> = [];
  const marcas: string[] = [];
  const tags: string[][] = [];
  const deps: DepsDaAcao = {
    agora: () => AGORA,
    avisoRecente: async (_u, _l, chave) => !!o.ja?.has(chave),
    marcarAviso: async (_u, _l, chave) => {
      marcas.push(chave);
    },
    consultaDoVinculo: async () => o.vinculo ?? null,
  };
  const kommo: KommoDaAcao = {
    getLead: async () => {
      if (o.leadFalha) throw new Error('Kommo fora');
      return ('lead' in o ? o.lead : { id: 1, name: 'Francisco 20/10/26', responsible_user_id: 777, custom_fields_values: [campo('◷ Data da Consulta', CONSULTA_EPOCH)] }) as never;
    },
    createTask: async (a) => {
      if (o.criaFalha) return null;
      tarefas.push(a);
      return { id: 9 };
    },
    addTag: async (a) => {
      tags.push(a.tags);
    },
  };
  const unit = { id: 'u1', slug: 'doutor-hernia-araguaina', spineTimezone: 'America/Araguaina', businessHoursTimezone: 'America/Araguaina' };
  return { deps, kommo, unit, tarefas, marcas, tags };
}

test('RECUSOU: tarefa URGENTE "CANCELAR NA FRANQUIA" para o RESPONSÁVEL do cartão, marca que para a nossa véspera/régua, NO_FOLLOW_UP', async () => {
  const m = montar();
  const r = await agirNaDesistencia({ unit: m.unit, leadId: 28861610, acao: 'recusou', trecho: 'não quero remarcar', kommo: () => m.kommo }, m.deps);
  assert.equal(r, 'tarefa_aberta');
  assert.equal(m.tarefas.length, 1);
  assert.match(m.tarefas[0].text, /^ALERTA · doutor-hernia-araguaina · \[Contato: Francisco\] URGENTE — CANCELAR NA FRANQUIA — Francisco, consulta 23\/10 às 14:00/);
  assert.equal(m.tarefas[0].responsibleUserId, 777);
  assert.equal(m.tarefas[0].completeAt - Math.floor(AGORA.getTime() / 1000), 30 * 60, 'prazo curto: é urgente');
  assert.ok(m.marcas.includes(MARCA_RECUSOU), 'a véspera e a régua param');
  assert.deepEqual(m.tags, [['NO_FOLLOW_UP']]);
});

test('RECUSOU: a marca de parar a véspera grava ANTES da tarefa — Kommo fora não deixa a véspera sair', async () => {
  const m = montar({ criaFalha: true });
  const r = await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'recusou', trecho: 'desisti', kommo: () => m.kommo }, m.deps);
  assert.equal(r, 'falhou');
  assert.ok(m.marcas.includes(MARCA_RECUSOU));
  assert.ok(!m.marcas.includes('desistencia_tarefa:cancelar'), 'a tarefa não foi criada: tenta de novo no próximo turno');
  assert.equal(m.tags.length, 0);
});

test('RECUSOU sem consulta no cartão mas COM vínculo futuro na franquia: age', async () => {
  const m = montar({ lead: { id: 1, name: 'Maria', custom_fields_values: [] }, vinculo: '2026-10-24T09:30' });
  const r = await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'recusou', trecho: 'não quero remarcar', kommo: () => m.kommo }, m.deps);
  assert.equal(r, 'tarefa_aberta');
  assert.match(m.tarefas[0].text, /consulta 24\/10 às 09:30/);
});

test('DÚVIDA sem consulta por vir (cartão e vínculo): "cancelei o plano" não vira tarefa', async () => {
  const m = montar({ lead: { id: 1, name: 'Maria', custom_fields_values: [] }, vinculo: '2026-10-20T09:30' });
  assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'duvida', trecho: 'x', kommo: () => m.kommo }, m.deps), 'sem_consulta');
  assert.equal(m.tarefas.length, 0);
  assert.equal(m.marcas.length, 0);
});

test('RECUSOU sem consulta por vir: a Sofia já prometeu "avisar a equipe" — vira tarefa "conferir", sem parar a véspera nem etiquetar', async () => {
  const m = montar({ lead: { id: 1, name: 'Maria', custom_fields_values: [] }, vinculo: '2026-10-20T09:30' });
  assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'recusou', trecho: 'não quero remarcar', kommo: () => m.kommo }, m.deps), 'tarefa_aberta');
  assert.match(m.tarefas[0].text, /CONFERIR COM O PACIENTE — Maria, consulta sem data no cartão nem na franquia/);
  assert.ok(!m.marcas.includes(MARCA_RECUSOU));
  assert.equal(m.tags.length, 0);
});

test('vínculo com a MESMA folga de 3 h do cartão: "não vou" às 14:30 para consulta das 14:00 ainda é desistência', async () => {
  const m = montar({ lead: { id: 1, name: 'Maria', custom_fields_values: [] }, vinculo: '2026-10-22T14:00' });
  // AGORA = 17:03Z = 14:03 local (Araguaína, -03)
  assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'duvida', trecho: 'x', kommo: () => m.kommo }, m.deps), 'tarefa_aberta');
});

test('cartão ilegível: não dá para saber se há consulta — não age e diz que falhou', async () => {
  const m = montar({ leadFalha: true });
  assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'recusou', trecho: 'x', kommo: () => m.kommo }, m.deps), 'falhou');
  assert.equal(m.marcas.length, 0);
});

test('DÚVIDA: tarefa "conferir com o paciente" SEM parar a véspera (nenhuma marca de recusa, nenhuma etiqueta)', async () => {
  const m = montar();
  const r = await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'duvida', trecho: 'acho que não vou conseguir', kommo: () => m.kommo }, m.deps);
  assert.equal(r, 'tarefa_aberta');
  assert.match(m.tarefas[0].text, /CONFERIR COM O PACIENTE — Francisco, consulta 23\/10 às 14:00/);
  assert.match(m.tarefas[0].text, /NÃO cancelou; a véspera segue/);
  assert.ok(!m.marcas.includes(MARCA_RECUSOU));
  assert.equal(m.tags.length, 0);
});

test('a mesma tarefa não abre duas vezes em 24 h', async () => {
  const m = montar({ ja: new Set(['desistencia_tarefa:cancelar']) });
  assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'recusou', trecho: 'x', kommo: () => m.kommo }, m.deps), 'ja_avisada');
  assert.equal(m.tarefas.length, 0);
  assert.ok(m.marcas.includes(MARCA_RECUSOU), 'mas a véspera continua parada');
});

test('OFERTA: só deixa a marca para o worker do "não respondeu"; não lê o cartão nem abre tarefa', async () => {
  const m = montar({ leadFalha: true });
  assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'oferta', trecho: 'Cancelei.', kommo: () => m.kommo }, m.deps), 'marcada');
  assert.deepEqual(m.marcas, [MARCA_OFERTA]);
  assert.equal(m.tarefas.length, 0);
});

test('os textos das tarefas', () => {
  const info = { slug: 's', nome: 'Francisco', quando: '23/10 às 14:00', trecho: 'não quero remarcar' };
  assert.match(textoTarefaCancelarNaFranquia(info), /URGENTE — CANCELAR NA FRANQUIA — Francisco, consulta 23\/10 às 14:00/);
  assert.match(textoTarefaCancelarNaFranquia(info), /Desmarcado/);
  assert.match(textoTarefaConferir(info), /CONFERIR COM O PACIENTE/);
});

test('silêncio depois da oferta: a marca só vence entre 2 h e 3 dias e se ele não escreveu depois', () => {
  const h = (n: number) => new Date(AGORA.getTime() - n * 3600_000);
  assert.equal(marcaVenceuSemResposta(h(1), AGORA, 0), false, 'ainda cedo');
  assert.equal(marcaVenceuSemResposta(h(2), AGORA, 0), true, 'duas horas, calado');
  assert.equal(marcaVenceuSemResposta(h(10), AGORA, 0), true, 'oferta das 20h30 olhada na manhã seguinte, sem depender do horário nem da janela de 24 h');
  assert.equal(marcaVenceuSemResposta(h(10), AGORA, 1), false, 'ele respondeu');
  assert.equal(marcaVenceuSemResposta(h(24 * 4), AGORA, 0), false, 'marca velha demais');
});
