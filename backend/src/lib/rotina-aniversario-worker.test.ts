/**
 * Rotina diária, régua 3 — aniversário (06/11/2026): a data é da FICHA da franquia (só com ⚙ idClient), tratamento ativo = só parabéns,
 * uma vez por ano por pessoa, nunca junto de outro toque no mesmo dia, atraso de fim de semana, o seco.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { COM, DIA, H, PERDIDO, TRAT, chamadas, ctx, escritas, fichas, leadsComTag, novo, poeMarca, simulacoes, tagsPostas, tracos, zerar, AGORA } from './rotina-teste-util.js';
import { idDaMarca, type Ctx, type ResumoDaRegua } from './rotina-nucleo.js';
import { _limparAniversariantes, naJanelaDoAniversario, statusDeFalecido, varrerAniversario } from './rotina-aniversario-worker.js';

beforeEach(() => {
  zerar();
  _limparAniversariantes();
});

const nasc = (iso: string) => Date.parse(`${iso}T03:00:00Z`) / 1000;
const HOJE_MD = '11-06';
async function aniversario(c: Ctx, seco: boolean): Promise<Record<string, ResumoDaRegua>> {
  const r: Record<string, ResumoDaRegua> = {};
  await varrerAniversario(c, seco, r);
  return r;
}
let idc = 100;
/** Paciente que faz anos hoje: ⚙ idClient no cartão E a mesma data na ficha da franquia. */
function paciente(extra: Parameters<typeof novo>[0] = {}, ficha: { birthdate?: string | null; status?: string | null; emTratamento?: boolean } = {}) {
  const idClient = ++idc;
  fichas.set(idClient, { birthdate: ficha.birthdate === undefined ? `1980-${HOJE_MD}` : ficha.birthdate, status: ficha.status ?? 'ATIVO', emTratamento: ficha.emTratamento });
  return novo({ ...extra, campos: { '◷ Data de nascimento': nasc(`1980-${HOJE_MD}`), '⚙ idClient (franquia)': idClient, ...(extra.campos ?? {}) } });
}
/** Unidade com franquia (sem ela o aniversário não sai). */
function comFranquia(c: Ctx): Ctx {
  (c.unit as { spineEnabled: boolean; spineToken: string }).spineEnabled = true;
  (c.unit as { spineEnabled: boolean; spineToken: string }).spineToken = 't';
  return c;
}

test('paciente que faz anos hoje (data da FICHA da franquia) recebe a ▶ Aniversário; quem faz amanhã, não', async () => {
  const hoje = paciente({ etapa: [COM, 15] });
  paciente({ etapa: [COM, 15] }, { birthdate: '1980-11-07' });
  await aniversario(comFranquia(ctx()), false);
  assert.deepEqual(leadsComTag(), [hoje.lead.id]);
  assert.deepEqual(tagsPostas(), ['▶ Aniversário']);
});

test('SEM ⚙ idClient não manda (nem com a data certa no cartão); sem franquia na unidade não manda; ficha que não responde não manda', async () => {
  const semId = novo({ etapa: [COM, 15], campos: { '◷ Data de nascimento': nasc(`1980-${HOJE_MD}`), '◷ Data da Consulta': AGORA - 30 * DIA } });
  const r = await aniversario(comFranquia(ctx()), false);
  assert.equal(tagsPostas().length, 0, 'o cartão sozinho não decide');
  assert.ok(semId);
  assert.equal(r.aniv.avaliados, 0, 'nem chega a avaliar: a peneira exige idClient');
  // unidade sem franquia
  paciente({ etapa: [COM, 15] });
  const sem = await aniversario(ctx(), false);
  assert.equal(sem.aniv.seguradas['unidade-sem-franquia'], 1);
  assert.equal(tagsPostas().length, 0);
  // ficha que não responde (idClient sem ficha no banco falso): erro → pula, não manda
  _limparAniversariantes();
  novo({ etapa: [COM, 15], campos: { '◷ Data de nascimento': nasc(`1980-${HOJE_MD}`), '⚙ idClient (franquia)': 999999 } });
  const erro = await aniversario(comFranquia(ctx()), false);
  assert.equal(erro.aniv.erros, 1);
});

test('a franquia é o cadastro: ficha com OUTRA data, ou sem data, não manda — o cartão sozinho não vale', async () => {
  paciente({ etapa: [COM, 15] }, { birthdate: '1980-03-15' });
  paciente({ etapa: [COM, 15] }, { birthdate: null });
  const r = await aniversario(comFranquia(ctx()), false);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.aniv.seguradas['franquia-diz-outra-data'], 1);
  assert.equal(r.aniv.seguradas['ficha-sem-data-de-nascimento'], 1);
});

test('a trava de falecido por status da ficha é DEFENSIVA e sem prova em ficha real (só «ATIVO» foi visto): se aparecer «óbito», não manda', async () => {
  assert.equal(statusDeFalecido('Óbito'), true);
  assert.equal(statusDeFalecido('Falecido'), true);
  assert.equal(statusDeFalecido('ATIVO'), false);
  assert.equal(statusDeFalecido(null), false);
  paciente({ etapa: [COM, 15] }, { status: 'Óbito' });
  const r = await aniversario(comFranquia(ctx()), false);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.aniv.barrados['falecido-na-franquia'], 1);
});

test('vale para ex-paciente em PERDIDO e para o funil TRATAMENTO (ALTA); o TRATAMENTO não é trava', async () => {
  const perdido = paciente({ etapa: PERDIDO });
  const alta = paciente({ etapa: [TRAT, 22] });
  await aniversario(comFranquia(ctx()), false);
  assert.deepEqual(leadsComTag().sort(), [perdido.lead.id, alta.lead.id].sort());
  assert.deepEqual(new Set(tagsPostas()), new Set(['▶ Aniversário']));
});

test('quem está em tratamento ativo (etapa EM TRATAMENTO ou tratamento em andamento na ficha): só parabéns; sem essa etiqueta na conta, não manda nada', async () => {
  paciente({ etapa: [TRAT, 21] });
  const naFicha = paciente({ etapa: [COM, 15] }, { emTratamento: true });
  const c = comFranquia(ctx());
  await aniversario(c, false);
  assert.deepEqual(tagsPostas(), ['▶ Aniversário tratamento', '▶ Aniversário tratamento']);
  chamadas.length = 0;
  tracos.clear();
  _limparAniversariantes();
  const r = await aniversario(comFranquia(ctx({ tags: ['▶ Aniversário'] })), false);
  assert.equal(tagsPostas().length, 0, 'convite não vale para quem já se trata');
  assert.equal(r.aniv.seguradas['sem-etiqueta-na-conta'], 2);
  assert.ok(naFicha);
});

test('sem a etiqueta ▶ Aniversário na conta não faz nada', async () => {
  paciente({ etapa: [COM, 15] });
  const r = await aniversario(comFranquia(ctx({ tags: ['LOMBAR'] })), false);
  assert.equal(chamadas.length, 0);
  assert.equal(r.aniv.seguradas['sem-etiqueta-na-conta'], 1);
});

test('uma vez por ano por PESSOA (a marca é do contato), e nunca junto de outro toque no mesmo dia (da rotina ou do etiquetas-auto)', async () => {
  const a = paciente({ etapa: [COM, 15], contato: 301 });
  const outro = paciente({ etapa: [COM, 15], contato: 302 });
  const doAuto = paciente({ etapa: [COM, 15], contato: 303 });
  const c = comFranquia(ctx());
  poeMarca(idDaMarca(c.unit.id, 'c301', 'aniv', 1, 2026), c.unit.id, 5, 3); // este contato já recebeu o aniversário de 2026
  poeMarca(`rotina-${c.unit.id}-c302-exlead-1-9`, c.unit.id, 6, 1); // este recebeu outra coisa da rotina hoje
  poeMarca(`etiqueta-${c.unit.id}-boas-vindas:${doAuto.lead.id}:1`, c.unit.id, doAuto.lead.id, 1); // e este, do etiquetas-auto
  const r = await aniversario(c, false);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.aniv.barrados['ja-recebeu-este-ano'], 1);
  assert.equal(r.aniv.barrados['ja-recebeu-toque-hoje'], 2);
  assert.ok(a && outro);
});

test('dois cartões da mesma pessoa: o parabéns sai uma vez só', async () => {
  paciente({ etapa: [COM, 15], contato: 404 });
  paciente({ etapa: [TRAT, 22], contato: 404 });
  await aniversario(comFranquia(ctx()), false);
  assert.equal(tagsPostas().length, 1);
});

test('NO_FOLLOW_UP, NAO_PERTURBAR, opt-out, CURRÍCULO e motivo de perda encerrado nunca recebem; Retomar em futuro NÃO impede', async () => {
  paciente({ tags: ['NO_FOLLOW_UP'] });
  paciente({ tags: ['NAO_PERTURBAR'] });
  paciente({ campos: { '✓ Opt-out WhatsApp': 'Sim' } });
  paciente({ tags: ['CURRÍCULO'] });
  paciente({ etapa: PERDIDO, campos: { '⊘ Motivo do não agendamento': 'Outra cidade' } });
  const livre = paciente({ etapa: [COM, 15], campos: { '◷ Retomar em': AGORA + 9 * DIA } });
  for (const c of [...(await import('./rotina-teste-util.js')).cartoes]) if (c.lead.status_id === 11) c.lead.status_id = 15;
  await aniversario(comFranquia(ctx()), false);
  assert.deepEqual(leadsComTag(), [livre.lead.id]);
});

test('aniversário atrasado: unidade fechada no fim de semana/feriado cumprimenta no 1º dia útil (até 3 dias); depois disso a data passou', async () => {
  const poeData = (c: ReturnType<typeof paciente>, iso: string) => {
    (c.lead.custom_fields_values as Array<{ field_name: string; values: Array<{ value: unknown }> }>).find((f) => f.field_name === '◷ Data de nascimento')!.values[0].value = nasc(iso);
  };
  const tres = paciente({ etapa: [COM, 15] }, { birthdate: '1980-11-03' });
  poeData(tres, '1980-11-03');
  const quatro = paciente({ etapa: [COM, 15] }, { birthdate: '1980-11-02' });
  poeData(quatro, '1980-11-02');
  await aniversario(comFranquia(ctx()), false);
  assert.deepEqual(leadsComTag(), [tres.lead.id]);
});

test('31/12 cumprimentado em 02/01: a marca leva o ano do aniversário (2026), e o parabéns de 31/12/2027 não é bloqueado', async () => {
  const dois = Date.UTC(2027, 0, 2, 13) / 1000;
  const x = paciente({ etapa: [COM, 15] }, { birthdate: '1980-12-31' });
  (x.lead.custom_fields_values as Array<{ field_name: string; values: Array<{ value: unknown }> }>).find((f) => f.field_name === '◷ Data de nascimento')!.values[0].value = nasc('1980-12-31');
  const c = comFranquia(ctx({ agora: dois }));
  await aniversario(c, false);
  assert.deepEqual(leadsComTag(), [x.lead.id]);
  assert.ok([...tracos.keys()].some((k) => k.endsWith('-aniv-1-2026')), 'ano em que fez anos, não o de hoje');
});

test('só de manhã, no fuso da unidade; fora da janela não lê nem o funil', async () => {
  paciente({ etapa: [COM, 15] });
  const r = await aniversario(comFranquia(ctx({ agora: Date.UTC(2026, 10, 6, 20, 0, 0) / 1000 })), false);
  assert.equal(chamadas.length, 0);
  assert.equal(r.aniv.seguradas['fora-da-janela-da-manha'], 1);
  assert.equal(naJanelaDoAniversario(Date.UTC(2026, 10, 6, 12, 30) / 1000, 'America/Sao_Paulo'), true);
  assert.equal(naJanelaDoAniversario(Date.UTC(2026, 10, 6, 11, 59) / 1000, 'America/Sao_Paulo'), false);
  assert.equal(naJanelaDoAniversario(Date.UTC(2026, 10, 6, 15, 0) / 1000, 'America/Sao_Paulo'), false);
  assert.equal(naJanelaDoAniversario(Date.UTC(2026, 10, 6, 13, 0) / 1000, 'America/Manaus'), true);
});

test('SECO: não escreve, não marca, registra por régua; o teto do dia vale e o laço para nele', async () => {
  for (let i = 0; i < 5; i++) paciente({ etapa: [COM, 15] });
  const r = await aniversario(comFranquia(ctx({ intents: { rotina_teto_dia: 3 } })), true);
  assert.equal(escritas().length, 0);
  assert.equal(tracos.size, 0);
  assert.deepEqual(simulacoes.filter((s) => s.acao === 'etiquetaria').map((s) => [s.automacao, s.alvo]), Array(3).fill(['rotina-aniversario', '1º toque · ▶ Aniversário']));
  assert.equal(r.aniv.paradoPeloTeto, true);
});

test('o teto do dia é um só para as réguas: o aniversário gasta a vaga das outras (marcas de hoje contam)', async () => {
  paciente({ etapa: [COM, 15] });
  const c = comFranquia(ctx({ intents: { rotina_teto_dia: 1 } }));
  poeMarca(`rotina-${c.unit.id}-c1-qualificacao-1-1`, c.unit.id, 1, 1);
  const r = await aniversario(c, false);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.aniv.paradoPeloTeto, true);
});

void H;
