import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agirNaDesistencia, chaveDaTarefa, marcaDaConsulta, mesmaConsulta, textoTarefaCancelarNaFranquia, textoTarefaConferir, MARCA_OFERTA, MARCA_RECUSOU, chaveDaMarca, type DepsDaAcao, type KommoDaAcao } from './desistencia-acao.js';
import type { Estado } from './automacoes-estado.js';
import { devoTentarAgora, deveAvisarOJoao, marcaVenceuSemResposta, MAX_TENTATIVAS } from './desistencia-sem-resposta-worker.js';
import { voltouAtrasDeVerdade } from './vespera-segura.js';

const AGORA = new Date('2026-10-22T17:03:00Z');
const campo = (nome: string, valor: unknown) => ({ field_id: 1, field_name: nome, values: [{ value: valor }] });
const CONSULTA_EPOCH = 1792774800; // 23/10 14:00 -03
const ISO = '2026-10-23T14:00';
const RECUSA = chaveDaMarca(MARCA_RECUSOU, ISO);

function montar(o: { lead?: object | null; vinculo?: string | null; ja?: Set<string>; criaFalha?: boolean; leadFalha?: boolean; estado?: Estado } = {}) {
  const simulacoes: Array<{ acao: string; alvo: string; valor?: unknown }> = [];
  const tarefas: Array<{ leadId: number; text: string; completeAt: number; responsibleUserId?: number }> = [];
  const marcas: string[] = [];
  const tags: string[][] = [];
  const deps: DepsDaAcao = {
    agora: () => AGORA,
    avisoRecente: async (_u, _l, chave) => !!o.ja?.has(chave),
    marcarAviso: async (_u, _l, chave) => {
      marcas.push(chave);
    },
    marcadoEmPrefixo: async () => null,
    consultaDoVinculo: async () => o.vinculo ?? null,
    estado: () => o.estado ?? 'ligado',
    simular: (_u, _a, sim) => {
      simulacoes.push(sim);
    },
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
  return { deps, kommo, unit, tarefas, marcas, tags, simulacoes };
}

test('RECUSOU: tarefa URGENTE "CANCELAR NA FRANQUIA" para o RESPONSÁVEL do cartão, marca que para a nossa véspera/régua, NO_FOLLOW_UP', async () => {
  const m = montar();
  const r = await agirNaDesistencia({ unit: m.unit, leadId: 28861610, acao: 'recusou', trecho: 'não quero remarcar', kommo: () => m.kommo }, m.deps);
  assert.equal(r, 'tarefa_aberta');
  assert.equal(m.tarefas.length, 1);
  assert.match(m.tarefas[0].text, /^ALERTA · doutor-hernia-araguaina · \[Contato: Francisco\] URGENTE — CANCELAR NA FRANQUIA — Francisco, consulta 23\/10 às 14:00/);
  assert.equal(m.tarefas[0].responsibleUserId, 777);
  assert.equal(m.tarefas[0].completeAt - Math.floor(AGORA.getTime() / 1000), 30 * 60, 'prazo curto: é urgente');
  assert.ok(m.marcas.includes(RECUSA), 'a véspera e a régua param (a marca é DESTA consulta)');
  assert.deepEqual(m.tags, [['NO_FOLLOW_UP']]);
});

test('RECUSOU: a marca de parar a véspera grava ANTES da tarefa — Kommo fora não deixa a véspera sair', async () => {
  const m = montar({ criaFalha: true });
  const r = await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'recusou', trecho: 'desisti', kommo: () => m.kommo }, m.deps);
  assert.equal(r, 'falhou');
  assert.ok(m.marcas.includes(RECUSA));
  assert.ok(!m.marcas.includes(chaveDaTarefa('cancelar', ISO)), 'a tarefa não foi criada: tenta de novo no próximo turno');
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

test('cartão ilegível: sem consulta provada não abre tarefa e diz que falhou; DÚVIDA não grava nada', async () => {
  const m = montar({ leadFalha: true });
  assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'duvida', trecho: 'x', kommo: () => m.kommo }, m.deps), 'falhou');
  assert.equal(m.marcas.length + m.tarefas.length, 0);
});

test('RECUSOU com o cartão ilegível: a Sofia já prometeu — a marca (reversível) para a véspera e o worker refaz a tarefa depois', async () => {
  const m = montar({ leadFalha: true });
  assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'recusou', trecho: 'desisti', kommo: () => m.kommo }, m.deps), 'falhou');
  assert.deepEqual(m.marcas, [chaveDaMarca(MARCA_RECUSOU, '?')]);
  assert.equal(m.tarefas.length, 0);
});

test('REFAZENDO (worker): não regrava a marca de recusa — a data dela é a da recusa, é com ela que ele "volta atrás"', async () => {
  const m = montar();
  assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'recusou', trecho: 'desisti', kommo: () => m.kommo, refazendo: true }, m.deps), 'tarefa_aberta');
  assert.ok(!m.marcas.includes(MARCA_RECUSOU));
  assert.ok(m.marcas.includes(chaveDaTarefa('cancelar', ISO)));
  assert.match(m.tarefas[0].text, /etiqueta NO_FOLLOW_UP foi posta \(tire-a se ele voltar atrás\)/);
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
  const m = montar({ ja: new Set([chaveDaTarefa('cancelar', ISO)]) });
  assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'recusou', trecho: 'x', kommo: () => m.kommo }, m.deps), 'ja_avisada');
  assert.equal(m.tarefas.length, 0);
  assert.ok(m.marcas.includes(RECUSA), 'mas a véspera continua parada');
});

test('OFERTA: com consulta por vir, deixa a marca DESTA consulta para o worker do "não respondeu"; não abre tarefa', async () => {
  const m = montar();
  assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'oferta', trecho: 'Cancelei.', kommo: () => m.kommo }, m.deps), 'marcada');
  assert.deepEqual(m.marcas, [chaveDaMarca(MARCA_OFERTA, ISO)]);
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

test('a recusa cuja tarefa falhou é REFEITA: a marca de parar a véspera não é a chave de dedupe da tarefa (Codex leu como se fosse)', async () => {
  const falha = montar({ criaFalha: true });
  assert.equal(await agirNaDesistencia({ unit: falha.unit, leadId: 1, acao: 'recusou', trecho: 'desisti', kommo: () => falha.kommo }, falha.deps), 'falhou');
  // o worker chama de novo (Kommo voltou): a chave `desistencia_tarefa:cancelar` nunca foi gravada, então a tarefa sai
  const volta = montar({ ja: new Set([RECUSA]) });
  assert.equal(await agirNaDesistencia({ unit: volta.unit, leadId: 1, acao: 'recusou', trecho: 'desisti', kommo: () => volta.kommo }, volta.deps), 'tarefa_aberta');
  assert.equal(volta.tarefas.length, 1);
});

test('EM SECO (o padrão): RECUSOU registra "abriria tarefa / pararia a véspera / poria NO_FOLLOW_UP" e NÃO grava nada', async () => {
  const m = montar({ estado: 'seco' });
  const r = await agirNaDesistencia({ unit: m.unit, leadId: 28861610, acao: 'recusou', trecho: 'não quero remarcar', kommo: () => m.kommo }, m.deps);
  assert.equal(r, 'simulada');
  assert.equal(m.tarefas.length, 0, 'nenhuma tarefa no Kommo');
  assert.equal(m.marcas.length, 0, 'nenhuma marca: a véspera NÃO para');
  assert.equal(m.tags.length, 0, 'nenhuma etiqueta');
  assert.deepEqual(m.simulacoes.map((x) => `${x.acao}:${x.alvo}`), [
    'alertaria:tarefa URGENTE CANCELAR NA FRANQUIA',
    `gravaria:marca ${MARCA_RECUSOU} (para a véspera e a régua)`,
    'etiquetaria:NO_FOLLOW_UP',
  ]);
  assert.match(String(m.simulacoes[0].valor), /URGENTE — CANCELAR NA FRANQUIA — Francisco, consulta 23\/10 às 14:00/);
});

test('EM SECO: DÚVIDA e OFERTA também só registram', async () => {
  const a = montar({ estado: 'seco' });
  assert.equal(await agirNaDesistencia({ unit: a.unit, leadId: 1, acao: 'duvida', trecho: 'vou ver', kommo: () => a.kommo }, a.deps), 'simulada');
  assert.deepEqual(a.simulacoes.map((x) => x.alvo), ['tarefa CONFERIR COM O PACIENTE']);
  assert.equal(a.tarefas.length + a.marcas.length, 0);
  const b = montar({ estado: 'seco' });
  assert.equal(await agirNaDesistencia({ unit: b.unit, leadId: 1, acao: 'oferta', trecho: 'Cancelei.', kommo: () => b.kommo }, b.deps), 'simulada');
  assert.equal(b.marcas.length, 0, 'em seco nem a marca da oferta grava');
  assert.equal(b.simulacoes.length, 1);
});

test('DESLIGADA: não faz nem lê nada', async () => {
  const m = montar({ estado: 'desligado', leadFalha: true });
  for (const acao of ['oferta', 'recusou', 'duvida'] as const) {
    assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao, trecho: 'x', kommo: () => m.kommo }, m.deps), 'nada');
  }
  assert.equal(m.simulacoes.length + m.marcas.length + m.tarefas.length, 0);
});

// ── mediums do sênior (6f4447d) ────────────────────────────────────────────────────────────────────────────────

test('OFERTA: ele já CHOCOU horário no mesmo turno ("não vou poder ir amanhã, pode ser sexta às 10h?") → nenhuma marca de silêncio', async () => {
  const m = montar();
  assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'oferta', trecho: 'Não vou poder ir amanhã, pode ser sexta às 10h?', kommo: () => m.kommo }, m.deps), 'nada');
  assert.equal(m.marcas.length, 0);
});

test('OFERTA sem consulta por vir: nenhuma marca ("cancelei o plano" não vira tarefa de silêncio)', async () => {
  const m = montar({ lead: { id: 1, name: 'Maria', custom_fields_values: [] } });
  assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'oferta', trecho: 'Cancelei.', kommo: () => m.kommo }, m.deps), 'sem_consulta');
  assert.equal(m.marcas.length, 0);
});

test('SEM RESPOSTA: se hoje a consulta é OUTRA que a da marca, ele remarcou — não há o que avisar', async () => {
  const m = montar();
  assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'sem_resposta', trecho: 'Cancelei.', kommo: () => m.kommo, consultaDaMarca: '2026-10-22T10:00' }, m.deps), 'remarcou');
  assert.equal(m.tarefas.length, 0);
  assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'sem_resposta', trecho: 'Cancelei.', kommo: () => m.kommo, consultaDaMarca: ISO }, m.deps), 'tarefa_aberta');
});

test('a marca de recusa de OUTRA consulta não é a desta (remarcou → chave diferente → a véspera volta)', () => {
  assert.notEqual(chaveDaMarca(MARCA_RECUSOU, '2026-10-23T14:00'), chaveDaMarca(MARCA_RECUSOU, '2026-10-30T10:00'));
});

// ── refazer a tarefa de cancelar (bloqueante 2) ──────────────────────────────────────────────────────────────────

test('refazer: "ok, obrigada" e "tá bom" NÃO desfazem a recusa; só voltar atrás de verdade', () => {
  for (const t of ['ok, obrigada', 'tá bom', 'obrigado!', 'bom dia', 'ok', 'ok, vou aguardar o contato da equipe', 'vou procurar outro lugar', 'vou avisar meu marido', 'Pode cancelar, eu vou ter que faltar', 'não consegui folga, pode cancelar', 'resolvi cancelar', 'não deu certo, pode desmarcar']) assert.equal(voltouAtrasDeVerdade([t]), false, t);
  for (const t of ['consegui, vou sim', 'confirmo', 'quero manter', 'deu certo, eu vou', 'vou sim']) assert.equal(voltouAtrasDeVerdade([t]), true, t);
  assert.equal(voltouAtrasDeVerdade(['não vou lá não, pode cancelar']), false, '"não vou lá" é o contrário de confirmar');
  assert.equal(voltouAtrasDeVerdade([]), false);
});

test('depois de 12 falhas seguidas, avisa o João (uma vez)', () => {
  assert.equal(MAX_TENTATIVAS, 12);
  assert.equal(deveAvisarOJoao(11), false);
  assert.equal(deveAvisarOJoao(12), true);
  assert.equal(deveAvisarOJoao(13), false);
});

test('as marcas levam a consulta: 5 min de tolerância entre o horário do cartão e o da franquia; remarcou = outra marca', () => {
  assert.equal(mesmaConsulta('2026-10-23T14:00', '2026-10-23T14:05'), true);
  assert.equal(mesmaConsulta('2026-10-23T14:00', '2026-10-23T14:06'), false);
  assert.equal(mesmaConsulta('2026-10-23T14:00', '2026-10-30T14:00'), false);
  assert.equal(mesmaConsulta('?', '2026-10-23T14:00'), false);
  const marcas = [
    { ruleKey: `${MARCA_RECUSOU}:2026-10-23T14:00`, createdAt: new Date('2026-10-22T17:00:00Z') },
    { ruleKey: `${MARCA_RECUSOU}:?`, createdAt: new Date('2026-10-22T18:00:00Z') },
    { ruleKey: 'outra:2026-10-23T14:00', createdAt: new Date('2026-10-22T19:00:00Z') },
  ];
  assert.deepEqual(marcaDaConsulta(marcas, MARCA_RECUSOU, '2026-10-23T14:03'), new Date('2026-10-22T17:00:00Z'));
  assert.equal(marcaDaConsulta(marcas, MARCA_RECUSOU, '2026-10-30T10:00'), null, 'remarcada para outra data: a marca não vale');
});

test('REFAZENDO: se a consulta de hoje é OUTRA que a da marca, ele remarcou — não abre CANCELAR para a consulta nova', async () => {
  const m = montar();
  assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'recusou', trecho: 'x', kommo: () => m.kommo, refazendo: true, consultaDaMarca: '2026-10-01T10:00' }, m.deps), 'remarcou');
  assert.equal(m.tarefas.length, 0);
});

test('REFAZENDO a marca que ficou com "?" (cartão ilegível na hora): regrava com a consulta certa e a hora ORIGINAL da recusa', async () => {
  const m = montar();
  const original = new Date('2026-10-22T16:50:00Z');
  const gravadas: Array<{ chave: string; em: Date | undefined }> = [];
  m.deps.marcarAviso = async (_u, _l, chave, em) => {
    gravadas.push({ chave, em });
  };
  assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'recusou', trecho: 'desisti', kommo: () => m.kommo, refazendo: true, consultaDaMarca: '?', marcaEm: original }, m.deps), 'tarefa_aberta');
  const marca = gravadas.find((g) => g.chave === RECUSA);
  assert.ok(marca, 'a marca com a consulta certa existe');
  assert.deepEqual(marca?.em, original);
});

test('uma tarefa aberta nas últimas 24 h (IA calada / dúvida) nem lê o cartão', async () => {
  const m = montar();
  m.deps.marcadoEmPrefixo = async () => new Date(AGORA.getTime() - 3600_000);
  for (const acao of ['ia_calada', 'duvida'] as const) {
    assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao, trecho: 'Cancelei.', kommo: () => { throw new Error('não devia nem criar o cliente'); } }, m.deps), 'ja_avisada');
  }
});

test('sem_resposta pelo worker (confiavel): o texto não precisa parecer desistência (a marca já prova)', async () => {
  const m = montar();
  assert.equal(await agirNaDesistencia({ unit: m.unit, leadId: 1, acao: 'sem_resposta', trecho: 'não vou poder', kommo: () => m.kommo, confiavel: true }, m.deps), 'tarefa_aberta');
  const n = montar();
  assert.equal(await agirNaDesistencia({ unit: n.unit, leadId: 1, acao: 'sem_resposta', trecho: 'qualquer coisa', kommo: () => n.kommo, confiavel: true }, n.deps), 'tarefa_aberta');
  const o = montar();
  assert.equal(await agirNaDesistencia({ unit: o.unit, leadId: 1, acao: 'sem_resposta', trecho: 'qualquer coisa', kommo: () => o.kommo }, o.deps), 'nao_e');
});

test('depois de 12 falhas o worker passa ao backoff de 2 h, não desiste para sempre', () => {
  assert.equal(devoTentarAgora(undefined, 1000), true);
  assert.equal(devoTentarAgora(0, 1000), true);
  assert.equal(devoTentarAgora(5000, 1000), false);
  assert.equal(devoTentarAgora(5000, 5000), true);
});
