/**
 * Rotina diária, régua 1 — esquecidos por etapa (06/11/2026): cada etapa no prazo dela, a configuração por unidade, as travas do
 * cartão, o funil TRATAMENTO que nunca é varrido, a etiqueta que a conta não tem, os degraus prontos e o seco.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ETAPA } from './franquia-move.js';
import { AGORA, COM, DIA, TRAT, chamadas, ctx, escritas, leadsComTag, novo, poeMarca, simulacoes, tagsPostas, tracos, zerar } from './rotina-teste-util.js';
import { idDaMarca, pessoaDoCartao, type Ctx, type ResumoDaRegua } from './rotina-nucleo.js';
import { REGUAS_POR_ETAPA, configDasEtapas, estadoDasEtapas, varrerEtapas } from './rotina-etapas-worker.js';

beforeEach(zerar);

async function etapas(c: Ctx, seco: boolean): Promise<Record<string, ResumoDaRegua>> {
  const r: Record<string, ResumoDaRegua> = {};
  await varrerEtapas(c, seco, r);
  return r;
}

// ─── prazos ───────────────────────────────────────────────────────────────────────────────────────

test('os prazos padrão são os do João: QUALIFICAÇÃO 2/4/7, NÃO COMPARECEU 1/3/6, NEGOCIAÇÃO 2/5/9', () => {
  const c = configDasEtapas(null, {});
  assert.deepEqual(c.etapas, { qualificacao: [2, 4, 7], naocompareceu: [1, 3, 6], negociacao: [2, 5, 9] });
  assert.equal(c.toquesProntos, 1, 'só a ▶ Retomada está confirmada por padrão');
  assert.deepEqual(REGUAS_POR_ETAPA.map((r) => r.etapa), ['EM QUALIFICAÇÃO', 'NÃO COMPARECEU', 'EM NEGOCIAÇÃO']);
});

test('a unidade muda os prazos pelo pipelineIntents; prazo que não cresce volta ao padrão e fica anotado; a rede muda pelo ambiente', () => {
  const c = configDasEtapas({ rotina_qualificacao_d1: 3, rotina_qualificacao_d2: 5, rotina_naocompareceu_d2: 1, rotina_toques_prontos: 2 }, {});
  assert.deepEqual(c.etapas.qualificacao, [3, 5, 7]);
  assert.deepEqual(c.etapas.naocompareceu, [1, 3, 6]);
  assert.equal(c.invalidas.length, 1);
  assert.equal(c.toquesProntos, 2);
  assert.deepEqual(configDasEtapas({ rotina_negociacao_d3: 12 }, { ROTINA_ROBOS_DIAS_NEGOCIACAO: '3,6,10' }).etapas.negociacao, [3, 6, 12]);
});

test('cada etapa recebe no prazo dela: QUALIFICAÇÃO 2 d, NÃO COMPARECEU 1 d, NEGOCIAÇÃO 2 d; antes disso, nada', async () => {
  const q = novo({ etapa: [COM, 11], silencioDias: 2.1 });
  const qCedo = novo({ etapa: [COM, 11], silencioDias: 1.5 });
  const nc = novo({ etapa: [COM, 12], silencioDias: 1.1 });
  const ncCedo = novo({ etapa: [COM, 12], silencioDias: 0.5 });
  const ng = novo({ etapa: [COM, 13], silencioDias: 2.2 });
  const ngCedo = novo({ etapa: [COM, 13], silencioDias: 1.9 });
  const r = await etapas(ctx(), false);
  assert.deepEqual(leadsComTag().sort(), [q.lead.id, nc.lead.id, ng.lead.id].sort());
  for (const cedo of [qCedo, ncCedo, ngCedo]) assert.ok(!leadsComTag().includes(cedo.lead.id));
  assert.equal(r.qualificacao.porToque['1'], 1);
  assert.equal(r.naocompareceu.porToque['1'], 1);
  assert.equal(r.negociacao.porToque['1'], 1);
  assert.deepEqual(new Set(tagsPostas()), new Set(['▶ Retomada']));
});

test('o prazo da unidade vale: QUALIFICAÇÃO com d1=5 não recebe aos 3 dias', async () => {
  novo({ etapa: [COM, 11], silencioDias: 3 });
  await etapas(ctx({ intents: { rotina_qualificacao_d1: 5, rotina_qualificacao_d2: 8, rotina_qualificacao_d3: 12 } }), false);
  assert.equal(tagsPostas().length, 0);
});

test('NÃO COMPARECEU conta da ENTRADA na etapa: quem faltou ontem (última mensagem de 20 dias atrás) ainda não recebe; quem faltou há 2 dias, sim', async () => {
  const ontem = novo({ etapa: [COM, 12], silencioDias: 20, entrou: AGORA - 0.9 * DIA });
  const haDois = novo({ etapa: [COM, 12], silencioDias: 20, entrou: AGORA - 1.2 * DIA });
  await etapas(ctx(), false);
  assert.deepEqual(leadsComTag(), [haDois.lead.id]);
  assert.ok(ontem);
});

test('NÃO COMPARECEU: agendou por mensagem há 40 dias e faltou há 2 — a mensagem velha ainda vale para a âncora (a janela olha longe)', async () => {
  const x = novo({ etapa: [COM, 12], silencioDias: 40, entrou: AGORA - 1.2 * DIA });
  await etapas(ctx(), false);
  assert.deepEqual(leadsComTag(), [x.lead.id]);
});

test('QUALIFICAÇÃO e NEGOCIAÇÃO contam da última mensagem (decisão do João), mesmo com o cartão recém-chegado na etapa', async () => {
  const q = novo({ etapa: [COM, 11], silencioDias: 3, entrou: AGORA - 3600 });
  const ng = novo({ etapa: [COM, 13], silencioDias: 3, entrou: AGORA - 3600 });
  await etapas(ctx(), false);
  assert.deepEqual(leadsComTag().sort(), [q.lead.id, ng.lead.id].sort());
});

// ─── degraus, marca de ciclo ──────────────────────────────────────────────────────────────────────

test('1 envio por cartão por ciclo: a 2ª varredura no mesmo dia não repete, nem com a memória limpa', async () => {
  novo({ silencioDias: 3 });
  const c = ctx();
  await etapas(c, false);
  assert.equal(tagsPostas().length, 1);
  assert.equal(tracos.size, 1, 'a marca ficou gravada ANTES da etiqueta');
  chamadas.length = 0;
  const c2 = { ...ctx(), unit: c.unit };
  await etapas(c2, false);
  assert.equal(tagsPostas().length, 0, 'não repete');
});

test('a régua anda: com o 1º enviado há 2,5 dias e 4,5 de silêncio, sai o 2º degrau (▶ Retomada 2), e a marca fica', async () => {
  const a = novo({ silencioDias: 4.5 });
  const c = ctx({ intents: { rotina_toques_prontos: 3 } });
  poeMarca(idDaMarca(c.unit.id, pessoaDoCartao(a.lead), 'qualificacao', 1, a.paciente as number), c.unit.id, a.lead.id, 60);
  await etapas(c, false);
  assert.deepEqual(tagsPostas(), ['▶ Retomada 2']);
  assert.ok(tracos.has(idDaMarca(c.unit.id, pessoaDoCartao(a.lead), 'qualificacao', 2, a.paciente as number)));
});

test('depois do 3º degrau sem resposta não manda mais nada (quem move é o parados), sem gastar nem a chamada de mensagem', async () => {
  const a = novo({ silencioDias: 12 });
  const c = ctx({ intents: { rotina_toques_prontos: 3 } });
  for (const k of [1, 2, 3]) poeMarca(idDaMarca(c.unit.id, pessoaDoCartao(a.lead), 'qualificacao', k, a.paciente as number), c.unit.id, a.lead.id, (4 - k) * 48);
  const r = await etapas(c, false);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.qualificacao.esgotadas, 1);
  assert.ok(!chamadas.includes(`mensagem:${a.contato}`));
});

test('qualquer mensagem do paciente zera a régua: depois de responder, recomeça pelo 1º degrau', async () => {
  const a = novo({ silencioDias: 3 });
  const c = ctx({ intents: { rotina_toques_prontos: 3 } });
  poeMarca(idDaMarca(c.unit.id, pessoaDoCartao(a.lead), 'qualificacao', 1, a.paciente as number - 17 * DIA), c.unit.id, a.lead.id, 240); // o 1º saiu há 10 dias; ele respondeu há 3 e calou de novo
  await etapas(c, false);
  assert.deepEqual(tagsPostas(), ['▶ Retomada'], 'de novo o 1º, não o 2º');
});

// ─── travas ───────────────────────────────────────────────────────────────────────────────────────

test('travas do cartão: NO_FOLLOW_UP, NAO_PERTURBAR, CURRÍCULO, opt-out, consulta futura, ◷ Retomar em futuro, Pausar IA — ninguém recebe', async () => {
  novo({ tags: ['NO_FOLLOW_UP'] });
  novo({ tags: ['NAO_PERTURBAR'] });
  novo({ tags: ['CURRÍCULO'] });
  novo({ campos: { '✓ Opt-out WhatsApp': 'Sim' } });
  novo({ campos: { '◷ Data da Consulta': AGORA + 3 * DIA } });
  novo({ campos: { '◷ Retomar em': AGORA + 5 * DIA } });
  const pausar = novo();
  (pausar.lead.custom_fields_values as unknown[]).push({ field_id: 777, field_name: 'Pausar IA', values: [{ value: true }] });
  const livre = novo();
  const r = await etapas(ctx(), false);
  assert.deepEqual(leadsComTag(), [livre.lead.id]);
  assert.deepEqual(Object.keys(r.qualificacao.barrados).sort(), ['consulta-futura-cartao', 'nao-contatar', 'opt-out', 'pausar-ia', 'retomar-em']);
  assert.equal(chamadas.filter((x) => x.startsWith('mensagem')).length, 1, 'os travados nem gastaram a chamada de mensagem');
});

test('outras etapas e o funil TRATAMENTO nunca são varridos por esta régua', async () => {
  novo({ etapa: [COM, 14], silencioDias: 3 }); // EM ESPERA
  novo({ etapa: [COM, 15], silencioDias: 3 }); // AGENDADO
  novo({ etapa: [TRAT, 21], silencioDias: 5 });
  novo({ etapa: [TRAT, 22], silencioDias: 5 });
  await etapas(ctx(), false);
  assert.equal(chamadas.length, 0, 'nem leu o cartão');
});

test('no dia do aniversário o cartão de PACIENTE é do toque de aniversário (quando ele está ligado); lead que nunca consultou segue', async () => {
  const hoje = new Date(AGORA * 1000).toISOString().slice(5, 10);
  const nasc = Date.parse(`1980-${hoje}T03:00:00Z`) / 1000;
  novo({ etapa: [COM, 12], campos: { '◷ Data de nascimento': nasc, '◷ Data da Consulta': AGORA - 3 * DIA, '✓ Situação da consulta': 'Não compareceu' }, silencioDias: 2, entrou: AGORA - 2 * DIA });
  const lead = novo({ campos: { '◷ Data de nascimento': nasc } });
  const c = ctx();
  c.aniversarioLigado = true;
  const r = await etapas(c, false);
  assert.deepEqual(leadsComTag(), [lead.lead.id]);
  assert.equal(r.naocompareceu.barrados['aniversario-hoje'], 1);
  chamadas.length = 0;
  tracos.clear();
  const desligado = ctx(); // aniversário desligado: ninguém cede nada
  await etapas(desligado, false);
  assert.equal(tagsPostas().length, 2);
});

test('a mesma PESSOA em duas etapas (QUALIFICAÇÃO + NEGOCIAÇÃO) recebe um só modelo hoje', async () => {
  novo({ contato: 99, etapa: [COM, 11], silencioDias: 3 });
  novo({ contato: 99, etapa: [COM, 13], silencioDias: 3 });
  const r = await etapas(ctx(), false);
  assert.equal(tagsPostas().length, 1);
  assert.ok((r.qualificacao.seguradas['mesma-pessoa-hoje'] ?? 0) + (r.negociacao.seguradas['mesma-pessoa-hoje'] ?? 0) + (r.negociacao.barrados['ja-recebeu-toque-hoje'] ?? 0) >= 1);
});

// ─── etiqueta/gatilho da conta ────────────────────────────────────────────────────────────────────

test('a conta sem ▶ Retomada não faz nada nas etapas (e não cria etiqueta solta)', async () => {
  novo();
  const r = await etapas(ctx({ tags: ['NO_FOLLOW_UP', 'LOMBAR'] }), false);
  assert.equal(chamadas.length, 0, 'nem leu cartão');
  assert.equal(r.etapas.seguradas['sem-etiqueta-na-conta'], 1);
});

test('degrau cuja etiqueta a conta não tem: não manda, e no papel aparece o porquê', async () => {
  const a = novo({ silencioDias: 5 });
  const c = ctx({ intents: { rotina_toques_prontos: 3 }, tags: ['▶ Retomada'] });
  poeMarca(idDaMarca(c.unit.id, pessoaDoCartao(a.lead), 'qualificacao', 1, a.paciente as number), c.unit.id, a.lead.id, 72);
  const r = await etapas(c, true);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.qualificacao.seguradas['sem-etiqueta-na-conta'], 1);
  assert.ok(simulacoes.some((s) => s.acao === 'pularia' && /não tem a etiqueta ▶ Retomada 2/.test(s.motivo ?? '')));
});

test('degrau sem robô/gatilho confirmado (rotina_toques_prontos=1): quem já recebeu o 1º sai da fila e não volta', async () => {
  const a = novo({ silencioDias: 5 });
  const c = ctx();
  poeMarca(idDaMarca(c.unit.id, pessoaDoCartao(a.lead), 'qualificacao', 1, a.paciente as number), c.unit.id, a.lead.id, 72);
  const r = await etapas(c, false);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.qualificacao.seguradas['aguarda-proximo-degrau-pronto'], 1);
  assert.ok(!chamadas.includes(`mensagem:${a.contato}`));
});

// ─── seco ─────────────────────────────────────────────────────────────────────────────────────────

test('SECO não escreve nada e mostra por etapa e por degrau', async () => {
  novo({ etapa: [COM, 11], silencioDias: 3 });
  novo({ etapa: [COM, 12], silencioDias: 2, entrou: AGORA - 2 * DIA });
  novo({ etapa: [COM, 13], silencioDias: 3 });
  novo({ etapa: [COM, 13], silencioDias: 3, tags: ['NO_FOLLOW_UP'] });
  const r = await etapas(ctx(), true);
  assert.equal(escritas().length, 0);
  assert.equal(tracos.size, 0);
  const quem = simulacoes.filter((s) => s.acao === 'etiquetaria');
  assert.equal(quem.length, 3);
  assert.deepEqual(quem.map((s) => s.deEtapa).sort(), [ETAPA.NAO_COMPARECEU, ETAPA.NEGOCIACAO, ETAPA.QUALIFICACAO].sort());
  assert.ok(quem.every((s) => s.alvo === '1º toque · ▶ Retomada' && s.automacao === 'rotina-robos'));
  assert.equal(r.qualificacao.porToque['1'] + r.naocompareceu.porToque['1'] + r.negociacao.porToque['1'], 3);
});

test('o estado começa DESLIGADO e é só desta régua', () => {
  assert.equal(estadoDasEtapas('serra', undefined), 'desligado');
  assert.equal(estadoDasEtapas('serra', 'serra'), 'ligado');
  assert.equal(estadoDasEtapas('serra', 'salto'), 'desligado');
});
