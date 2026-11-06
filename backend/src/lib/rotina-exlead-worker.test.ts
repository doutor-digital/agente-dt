/**
 * Rotina diária, régua 2 — ex-lead que nunca agendou (06/11/2026): 30/60/90 d, quem já teve consulta, motivo encerrado, as travas da
 * ▶ Reativação do `etiquetas-auto` (responsável, nasceu em PERDIDO, voltou em outro cartão), âncora na perda, a Reativação que o
 * `etiquetas-auto` já pôs, e a pessoa com dois cartões.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import type { KommoLead } from '../services/kommo.service.js';
import { AGORA, COM, DIA, H, PERDIDO, SEM_FRANQUIA, campos, chamadas, ctx, escritas, extrasDoKommo, franquiaFalsa, leadsComTag, novo, poeMarca, simulacoes, tagsPostas, tracos, zerar } from './rotina-teste-util.js';
import { idDaMarca, pessoaDoCartao, type Ctx, type ResumoDaRegua } from './rotina-nucleo.js';
import { configDoExLead, estadoDoExLead, varrerExLead } from './rotina-exlead-worker.js';
import { nuncaAgendou } from './rotina-exlead-nunca.js';

beforeEach(zerar);

async function exlead(c: Ctx, seco: boolean): Promise<Record<string, ResumoDaRegua>> {
  const r: Record<string, ResumoDaRegua> = {};
  await varrerExLead(c, seco, r);
  return r;
}
/** Com a `_v2` aprovada o responsável não importa; os outros testes mostram o caso sem ela. */
const COM_V2 = [{ name: 'acai_sdr_reativacao_lead_frio', _embedded: { reviews: [{ status: 'approved' }] } }, { name: 'acai_sdr_reativacao_lead_frio_v2', _embedded: { reviews: [{ status: 'approved' }] } }];
const RESP = { '☻ Responsável agendamento': 'Ana' };

test('os prazos padrão são 30/60/90; a unidade muda; o estado começa DESLIGADO', () => {
  assert.deepEqual(configDoExLead(null, {}).dias, [30, 60, 90]);
  assert.deepEqual(configDoExLead({ rotina_exlead_d1: 20, rotina_exlead_d2: 45 }, {}).dias, [20, 45, 90]);
  assert.equal(configDoExLead({ rotina_exlead_toques_prontos: 3 }, {}).toquesProntos, 3);
  assert.equal(estadoDoExLead('serra', undefined), 'desligado');
  assert.equal(estadoDoExLead('serra', 'salto'), 'desligado');
});

test('30 dias desde a última mensagem em PERDIDO ou EM ESPERA → ▶ Reativação', async () => {
  const p = novo({ etapa: PERDIDO, silencioDias: 31, campos: RESP });
  const e = novo({ etapa: [COM, 14], silencioDias: 35, campos: RESP });
  const cedo = novo({ etapa: PERDIDO, silencioDias: 20, campos: RESP });
  await exlead(ctx(), false);
  assert.deepEqual(leadsComTag().sort(), [p.lead.id, e.lead.id].sort());
  assert.ok(!leadsComTag().includes(cedo.lead.id));
  assert.deepEqual(new Set(tagsPostas()), new Set(['▶ Reativação']));
});

test('quem já teve consulta (cartão ou franquia) NÃO é ex-lead', async () => {
  novo({ etapa: PERDIDO, silencioDias: 40, campos: { ...RESP, '✓ Situação da consulta': 'Atendido' } });
  const naFranquia = novo({ etapa: PERDIDO, silencioDias: 40, campos: RESP });
  franquiaFalsa.por = (id) => (id === naFranquia.lead.id ? { ...SEM_FRANQUIA, conhecido: true, temHistorico: true } : SEM_FRANQUIA);
  const r = await exlead(ctx(), false);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.exlead.barrados['ja-teve-consulta-no-cartao'], 1);
  assert.equal(r.exlead.seguradas['ja-agendou-na-franquia'], 1);
});

test('motivo de perda encerrado, NO_FOLLOW_UP, opt-out e CURRÍCULO nunca recebem', async () => {
  for (const m of ['Outra cidade', 'Clicou por engano', 'Outra patologia', 'Plano de Saúde', 'Sem interesse']) novo({ etapa: PERDIDO, silencioDias: 40, campos: { ...RESP, '⊘ Motivo do não agendamento': m } });
  novo({ etapa: PERDIDO, silencioDias: 40, tags: ['NO_FOLLOW_UP'], campos: RESP });
  novo({ etapa: PERDIDO, silencioDias: 40, campos: { ...RESP, '✓ Opt-out WhatsApp': 'Sim' } });
  novo({ etapa: PERDIDO, silencioDias: 40, tags: ['CURRÍCULO'], campos: RESP });
  const trabalhavel = novo({ etapa: PERDIDO, silencioDias: 40, campos: { ...RESP, '⊘ Motivo do não agendamento': 'Sem condições financeira' } });
  await exlead(ctx(), false);
  assert.deepEqual(leadsComTag(), [trabalhavel.lead.id]);
});

// ─── as travas da ▶ Reativação do etiquetas-auto ──────────────────────────────────────────────────

test('SEM a `_v2` aprovada: ☻ Responsável vazio ou que não é gente segura o 1º toque (o modelo sairia «Aqui é , da Doutor Hérnia»)', async () => {
  const vazio = novo({ etapa: PERDIDO, silencioDias: 40 });
  const bot = novo({ etapa: PERDIDO, silencioDias: 40, campos: { '☻ Responsável agendamento': 'Doutor Digital' } });
  const sofia = novo({ etapa: PERDIDO, silencioDias: 40, campos: { '☻ Responsável agendamento': 'I.A SOFIA' } });
  const ok = novo({ etapa: PERDIDO, silencioDias: 40, campos: RESP });
  const r = await exlead(ctx(), true);
  assert.equal(r.exlead.seguradas['responsavel-quebra-o-modelo'], 3);
  assert.deepEqual(simulacoes.filter((s) => s.acao === 'etiquetaria').map((s) => s.kommoLeadId), [ok.lead.id]);
  assert.ok(simulacoes.some((s) => s.kommoLeadId === vazio.lead.id && /vazio/.test(s.motivo ?? '')));
  assert.ok(bot && sofia);
});

test('COM a `_v2` aprovada o responsável vazio NÃO segura (o modelo diz «a equipe Doutor Digital»)', async () => {
  extrasDoKommo.modelos = COM_V2;
  const vazio = novo({ etapa: PERDIDO, silencioDias: 40 });
  await exlead(ctx(), false);
  assert.deepEqual(leadsComTag(), [vazio.lead.id]);
});

test('cartão que NASCEU em PERDIDO (importação/carga) não recebe: os 30 dias não são do paciente', async () => {
  extrasDoKommo.modelos = COM_V2;
  const carga = novo({ etapa: PERDIDO, silencioDias: 40, closed: AGORA - 40 * DIA, created: AGORA - 40 * DIA - 600 });
  const normal = novo({ etapa: PERDIDO, silencioDias: 40, closed: AGORA - 35 * DIA, created: AGORA - 90 * DIA });
  const r = await exlead(ctx(), false);
  assert.deepEqual(leadsComTag(), [normal.lead.id]);
  assert.equal(r.exlead.seguradas['nasceu-em-perdido'], 1);
  assert.ok(carga);
});

test('quem VOLTOU em outro cartão (aberto depois da perda) não recebe a reativação deste', async () => {
  extrasDoKommo.modelos = COM_V2;
  const antigo = novo({ etapa: PERDIDO, silencioDias: 40, closed: AGORA - 35 * DIA, contato: 9090 });
  // um cartão NOVO do mesmo contato, criado depois da perda
  const novoCartao = novo({ etapa: [COM, 11], silencioDias: 1, contato: 9090, created: AGORA - 5 * DIA });
  const r = await exlead(ctx(), false);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.exlead.seguradas['voltou-em-outro-cartao'], 1);
  assert.ok(antigo && novoCartao);
});

// ─── janela, âncora na perda, etiquetas-auto, pessoa ──────────────────────────────────────────────

test('estoque antigo (silêncio ≥ 60 d sem 1º toque) não entra de uma vez; o 2º e o 3º degraus exigem os degraus prontos', async () => {
  extrasDoKommo.modelos = COM_V2;
  novo({ etapa: PERDIDO, silencioDias: 75 });
  const r = await exlead(ctx(), false);
  assert.equal(r.exlead.foraDaJanela, 1);
  assert.equal(tagsPostas().length, 0);
  const a = novo({ etapa: PERDIDO, silencioDias: 62 });
  const c = ctx({ intents: { rotina_exlead_toques_prontos: 3 } });
  poeMarca(idDaMarca(c.unit.id, pessoaDoCartao(a.lead), 'exlead', 1, a.paciente as number), c.unit.id, a.lead.id, 32 * 24);
  await exlead(c, false);
  assert.deepEqual(tagsPostas(), ['▶ Reativação 2']);
});

test('o relógio também conta da ENTRADA em PERDIDO: o estoque que o parados perdeu depois de meses calado entra 30 dias depois da perda; a perda de hoje espera', async () => {
  extrasDoKommo.modelos = COM_V2;
  const calouHaMuito = novo({ etapa: PERDIDO, silencioDias: 100, closed: AGORA - 31 * DIA });
  const perdidoHoje = novo({ etapa: PERDIDO, silencioDias: 100, closed: AGORA - 2 * H });
  const r = await exlead(ctx(), false);
  assert.deepEqual(leadsComTag(), [calouHaMuito.lead.id]);
  assert.ok(perdidoHoje);
  assert.equal(r.exlead.esperando, 1);
});

test('a ▶ Reativação que o etiquetas-auto já pôs naquele PERDIDO conta como o 1º degrau (nada de mensagem em dobro)', async () => {
  extrasDoKommo.modelos = COM_V2;
  const a = novo({ etapa: PERDIDO, silencioDias: 33, closed: AGORA - 33 * DIA });
  const c = ctx();
  poeMarca(`etiqueta-${c.unit.id}-reativacao:${a.lead.id}:${AGORA - 33 * DIA}`, c.unit.id, a.lead.id, 72);
  await exlead(c, false);
  assert.equal(tagsPostas().length, 0, 'o 1º já saiu; o 2º é com 60 dias');
});

test('a mesma PESSOA em PERDIDO e em QUALIFICAÇÃO recebe um modelo só hoje (a marca é da pessoa)', async () => {
  extrasDoKommo.modelos = COM_V2;
  const perdido = novo({ etapa: PERDIDO, silencioDias: 40, contato: 4040 });
  const c = ctx();
  // a rotina de etapas já tocou o outro cartão da pessoa hoje
  poeMarca(idDaMarca(c.unit.id, 'c4040', 'qualificacao', 1, AGORA - 3 * DIA), c.unit.id, 77, 1);
  const r = await exlead(c, false);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.exlead.barrados['ja-recebeu-toque-hoje'], 1);
  assert.ok(perdido);
});

test('no seco registra por régua, não escreve, e a conta sem ▶ Reativação não faz nada', async () => {
  extrasDoKommo.modelos = COM_V2;
  novo({ etapa: PERDIDO, silencioDias: 31 });
  await exlead(ctx(), true);
  assert.equal(escritas().length, 0);
  assert.equal(tracos.size, 0);
  assert.deepEqual(simulacoes.map((s) => [s.automacao, s.acao, s.alvo]), [['rotina-exlead', 'etiquetaria', '1º toque · ▶ Reativação']]);
  chamadas.length = 0;
  const r = await exlead(ctx({ tags: ['LOMBAR'] }), false);
  assert.equal(chamadas.length, 0);
  assert.equal(r.exlead.seguradas['sem-etiqueta-na-conta'], 1);
});

test('nuncaAgendou: o cartão que mostra consulta, ou a franquia com histórico, desmente; erro da franquia lança', async () => {
  const unit = { id: 'u' } as Unit;
  const lead = (c: Record<string, unknown>) => ({ id: 1, name: 'A', custom_fields_values: campos(c) }) as unknown as KommoLead;
  assert.equal(await nuncaAgendou(unit, lead({}), async () => SEM_FRANQUIA), true);
  assert.equal(await nuncaAgendou(unit, lead({ '◷ Data da Consulta': AGORA }), async () => SEM_FRANQUIA), false);
  assert.equal(await nuncaAgendou(unit, lead({}), async () => ({ ...SEM_FRANQUIA, conhecido: true, temHistorico: true })), false);
  await assert.rejects(nuncaAgendou(unit, lead({}), async () => { throw new Error('franquia fora'); }));
});
