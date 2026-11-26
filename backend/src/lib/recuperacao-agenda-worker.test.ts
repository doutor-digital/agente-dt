import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { _semearCrmParaTeste } from './crm-compartilhado.js';
import {
  _limparMemoriaDaRecuperacao, configDaEvolutionDaRecuperacao, destinoDaRecuperacao, horaDaLista, limitesDaLista, listarRecuperacao, porQueOCartaoTira,
  type ArmazemDaLista, type DepsDaLista, type ItemParaGravar,
} from './recuperacao-agenda-worker.js';
import { apagadores, chaveDoPaciente } from './agenda-historico.js';
import type { KommoLead } from '../services/kommo.service.js';
import type { SpineSchedule, SpineTreatment } from '../services/spine.service.js';

process.env.AGENDA_HISTORICO_SEGREDO = 'segredo-de-teste-da-agenda-0123456789abcdef';
// quinta-feira 26/11/2026, 09h em São Paulo (12h UTC)
const AGORA = new Date('2026-11-26T12:00:00.000Z');
const unit = { id: 'u1', slug: 'acailandia-teste', kommoSubdomain: 'doutorherniaacailandia', spineEnabled: true, spineToken: 't', spineTimezone: 'America/Sao_Paulo', businessHoursTimezone: null, spineAgendaDays: [1, 2, 3, 4, 5], spineAgendaStart: '08:00', spineAgendaEnd: '18:00' } as unknown as Unit;
const ENV = { RECUPERACAO_DESTINOS: '{"acailandia-teste":"120363000000000000@g.us"}', RECUPERACAO_EVOLUTION_URL: 'http://evolution/sendText/x', EVOLUTION_ALERT_HEADER: 'apikey', EVOLUTION_ALERT_VALUE: 'k' };

beforeEach(() => _limparMemoriaDaRecuperacao());

// ── a agenda e o cartão falsos ──────────────────────────────────────────────────
let seq = 100;
const ag = (nome: string, dia: string, idStatus: number, o: Partial<SpineSchedule> = {}): SpineSchedule => ({
  idSchedule: ++seq, idTreatment: null, idStatus, statusName: null, clientName: nome, categoryName: 'AVALIAÇÃO', physicalTherapist: null,
  dateAttendanceUtc: `${dia}T14:00:00.000Z`, dateAttendanceLocal: null, dayLocal: dia, timeLocal: '11:00', isBusy: true, requiresManualValidation: false, modifiedUtc: `${dia}T10:00:00.000Z`, ...o,
});

function armazemFalso(): ArmazemDaLista & { itens: ItemParaGravar[]; concluidos: Array<{ idSchedule: number; envio: string }> } {
  const itens: ItemParaGravar[] = [];
  const concluidos: Array<{ idSchedule: number; envio: string }> = [];
  return {
    itens, concluidos,
    async contarDoDia(_u, modo, d) { return itens.filter((i) => i.modo === modo && i.dia === d && i.envio !== 'pendente').length; },
    async pendentesDoDia(_u, modo, d) { return itens.filter((i) => i.modo === modo && i.dia === d && i.envio === 'pendente').map((i) => i.idSchedule); },
    async jaListados(_u, modo) { return itens.filter((i) => i.modo === modo && i.envio !== 'pendente').map((i) => ({ idSchedule: i.idSchedule, pacienteChave: i.pacienteChave })); },
    async reivindicar(item) {
      const existente = itens.find((i) => i.idSchedule === item.idSchedule && i.modo === item.modo);
      if (existente && existente.envio !== 'pendente') return false;
      if (existente) { existente.envio = item.envio; return true; }
      itens.push({ ...item });
      return true;
    },
    async concluir(_u, idSchedule, modo, envio) {
      concluidos.push({ idSchedule, envio });
      const i = itens.find((x) => x.idSchedule === idSchedule && x.modo === modo);
      if (i) i.envio = envio;
    },
    async soltarPresos() {
      let n = 0;
      for (const i of itens) if (i.envio === 'enviando') { i.envio = 'incerto'; n++; }
      return n;
    },
  };
}

const cartao = (id: number, o: Partial<KommoLead> = {}): KommoLead => ({ id, name: 'x', status_id: 105, pipeline_id: 1, custom_fields_values: [], _embedded: { tags: [] }, ...o }) as KommoLead;

interface Montagem {
  agenda: SpineSchedule[];
  tratamentos?: SpineTreatment[];
  cartoes?: Record<string, { lead: KommoLead | 'erro'; confirmado?: boolean }>;
  nativos?: Array<{ id: number; name: string }>;
  envio?: 'ok' | 'recusado' | 'incerto';
}

function montar(m: Montagem, extra: Partial<DepsDaLista> = {}) {
  const armazem = armazemFalso();
  const enviados: string[] = [];
  const chamadas = { agenda: 0, tratamentos: 0, kommo: 0, registrar: 0, simular: 0 };
  const deps: DepsDaLista = {
    agora: AGORA, env: ENV, estado: 'ligado', grupo: null, pausaMs: 0, armazem,
    buscarAgenda: async () => { chamadas.agenda++; return { ok: true, agendamentos: m.agenda }; },
    buscarTratamentos: async () => { chamadas.tratamentos++; return { ok: true, tratamentos: m.tratamentos ?? [] }; },
    registrar: (async () => { chamadas.registrar++; return { registrados: 0 }; }) as unknown as DepsDaLista['registrar'],
    lancamentos: async () => new Map(),
    kommo: {
      getLead: async (id: number) => {
        chamadas.kommo++;
        const c = Object.values(m.cartoes ?? {}).find((x) => x.lead !== 'erro' && x.lead.id === id) ?? Object.values(m.cartoes ?? {}).find((x) => x.lead === 'erro');
        if (!c || c.lead === 'erro') throw new Error('Kommo fora');
        return c.lead;
      },
      listLossReasons: async () => m.nativos ?? [],
    },
    resolver: async (nome) => {
      const c = (m.cartoes ?? {})[nome];
      if (!c) return { leadId: null, leadConfirmado: true };
      if (c.lead === 'erro') return { leadId: 999, leadConfirmado: true };
      return { leadId: c.lead.id, leadConfirmado: c.confirmado ?? true };
    },
    enviar: async ({ texto }) => { enviados.push(texto); return m.envio ?? 'ok'; },
    simular: (() => { chamadas.simular++; }) as unknown as DepsDaLista['simular'],
    ...extra,
  };
  return { deps, armazem, enviados, chamadas };
}

// ── a hora, os limites, o destino ───────────────────────────────────────────────
test('hora da lista: dia de agenda, sem feriado, entre 8h e 12h na hora da unidade', () => {
  assert.equal(horaDaLista(unit, AGORA), true, 'quinta 09h');
  assert.equal(horaDaLista(unit, new Date('2026-11-26T10:30:00.000Z')), false, '07h30 ainda não');
  assert.equal(horaDaLista(unit, new Date('2026-11-26T15:00:00.000Z')), false, '12h já passou');
  assert.equal(horaDaLista(unit, new Date('2026-11-28T12:00:00.000Z')), false, 'sábado não é dia de agenda desta unidade');
  assert.equal(horaDaLista(unit, new Date('2026-11-27T12:00:00.000Z')), true, 'sexta');
  assert.equal(horaDaLista(unit, new Date('2026-11-20T12:00:00.000Z')), false, '20/11 é feriado nacional (Consciência Negra)');
  assert.equal(horaDaLista(unit, new Date('2026-12-25T12:00:00.000Z')), false, 'Natal');
});

test('a janela da lista é da lista, não do horário da clínica: quem atende só à tarde recebe a lista de manhã do mesmo jeito', () => {
  const tarde = { ...unit, spineAgendaStart: '13:00', spineAgendaEnd: '19:00' } as unknown as Unit;
  assert.equal(horaDaLista(tarde, AGORA), true);
  const semDias = { ...unit, spineAgendaDays: [] } as unknown as Unit;
  assert.equal(horaDaLista(semDias, AGORA), true, 'sem dias configurados vale segunda a sexta');
  assert.equal(horaDaLista(semDias, new Date('2026-11-28T12:00:00.000Z')), false);
});

test('limites: 15 por dia e 14 dias por padrão; o .env muda dentro de uma faixa; lixo volta ao padrão', () => {
  assert.deepEqual(limitesDaLista({}), { maximoPorDia: 15, dias: 14 });
  assert.deepEqual(limitesDaLista({ RECUPERACAO_MAX_POR_DIA: '5', RECUPERACAO_DIAS: '7' }), { maximoPorDia: 5, dias: 7 });
  assert.deepEqual(limitesDaLista({ RECUPERACAO_MAX_POR_DIA: '0', RECUPERACAO_DIAS: 'abc' }), { maximoPorDia: 15, dias: 14 });
  assert.deepEqual(limitesDaLista({ RECUPERACAO_MAX_POR_DIA: '500' }), { maximoPorDia: 15, dias: 14 });
});

test('destino: JSON slug → grupo; vazio, malformado ou de outra unidade = ninguém recebe', () => {
  assert.equal(destinoDaRecuperacao('a', '{"a":"123@g.us"}'), '123@g.us');
  assert.equal(destinoDaRecuperacao('a', "'{\"a\":\"123@g.us\"}'"), '123@g.us');
  assert.equal(destinoDaRecuperacao('b', '{"a":"123@g.us"}'), null);
  assert.equal(destinoDaRecuperacao('a', ''), null);
  assert.equal(destinoDaRecuperacao('a', undefined), null);
  assert.equal(destinoDaRecuperacao('a', 'não é json'), null);
});

test('a Evolution: a própria, ou a do aviso à recepção; sem chave não há envio', () => {
  assert.deepEqual(configDaEvolutionDaRecuperacao({ RECUPERACAO_EVOLUTION_URL: 'u', EVOLUTION_ALERT_HEADER: 'h', EVOLUTION_ALERT_VALUE: 'v' }), { url: 'u', header: 'h', valor: 'v' });
  assert.deepEqual(configDaEvolutionDaRecuperacao({ AVISO_CLINICA_AGENDAMENTO_EVOLUTION_URL: 'u2', EVOLUTION_ALERT_HEADER: 'h', EVOLUTION_ALERT_VALUE: 'v' })?.url, 'u2');
  assert.equal(configDaEvolutionDaRecuperacao({ RECUPERACAO_EVOLUTION_URL: 'u' }), null);
});

// ── o cartão que tira o paciente ────────────────────────────────────────────────
const NATIVOS = new Map([[7, 'Sem interesse'], [8, 'Sem condições financeiras']]);
const O = { agoraEpoch: Math.floor(AGORA.getTime() / 1000), tz: 'America/Sao_Paulo', motivosNativos: NATIVOS as ReadonlyMap<number, string> | null };

test('o cartão tira: não perturbar, motivo morto nativo, ganho; deixa: motivo trabalhável e cartão limpo', () => {
  assert.equal(porQueOCartaoTira(cartao(1, { _embedded: { tags: [{ id: 1, name: 'NAO_PERTURBAR' }] } }), O), 'nao-contatar');
  assert.equal(porQueOCartaoTira(cartao(1, { loss_reason_id: 7 }), O), 'motivo-morto');
  assert.equal(porQueOCartaoTira(cartao(1, { loss_reason_id: 8 }), O), null, '«sem condições financeiras» é trabalhável (decisão de 02/10)');
  assert.equal(porQueOCartaoTira(cartao(1, { status_id: 142 }), O), 'ganho');
  assert.equal(porQueOCartaoTira(cartao(1), O), null);
  assert.equal(porQueOCartaoTira(cartao(1, { loss_reason_id: 7 }), { ...O, motivosNativos: null }), 'motivo-nativo-desconhecido', 'a lista de motivos não veio: na dúvida sai');
});

// ── a rodada ────────────────────────────────────────────────────────────────────
const AGENDA_DE_HOJE = () => [
  ag('ANA PAULA LIMA', '2026-11-25', 57, { modifiedUtc: '2026-11-25T18:00:00.000Z' }),
  ag('BRUNO COSTA', '2026-11-24', 40),
  ag('CARLA DIAS', '2026-11-20', 57),
];

test('chave DESLIGADA: não faz nada — nem chama a franquia, nem grava, nem manda', async () => {
  const { deps, armazem, enviados, chamadas } = montar({ agenda: AGENDA_DE_HOJE() }, { estado: 'desligado' });
  const r = await listarRecuperacao(unit, deps);
  assert.equal(r.motivo, 'desligado');
  assert.deepEqual(chamadas, { agenda: 0, tratamentos: 0, kommo: 0, registrar: 0, simular: 0 });
  assert.deepEqual(armazem.itens, []);
  assert.deepEqual(enviados, []);
});

test('fora do horário da lista: não faz nada', async () => {
  const { deps, chamadas, enviados } = montar({ agenda: AGENDA_DE_HOJE() }, { agora: new Date('2026-11-26T20:00:00.000Z') });
  const r = await listarRecuperacao(unit, deps);
  assert.equal(r.motivo, 'fora-do-horario');
  assert.equal(chamadas.agenda, 0);
  assert.deepEqual(enviados, []);
});

test('«só no papel»: monta e GRAVA a lista (modo seco), registra o histórico, não manda nada', async () => {
  const { deps, armazem, enviados, chamadas } = montar({ agenda: AGENDA_DE_HOJE(), cartoes: { 'ANA PAULA LIMA': { lead: cartao(555) } } }, { estado: 'seco' });
  const r = await listarRecuperacao(unit, deps);
  assert.equal(r.listados, 3);
  assert.deepEqual(enviados, [], 'seco não manda');
  assert.equal(armazem.itens.length, 3);
  assert.equal(armazem.itens.every((i) => i.modo === 'seco' && i.envio === 'simulado'), true);
  assert.equal(chamadas.registrar, 1, 'a mesma leitura alimenta o histórico');
  assert.equal(chamadas.simular, 1, 'o que tem cartão aparece na tela «só no papel»');
});

test('ligada: manda o texto no grupo, sem telefone nem sobrenome, e marca como enviado', async () => {
  const { deps, armazem, enviados } = montar({ agenda: AGENDA_DE_HOJE(), cartoes: { 'ANA PAULA LIMA': { lead: cartao(555) } } });
  const r = await listarRecuperacao(unit, deps);
  assert.equal(r.listados, 3);
  assert.equal(enviados.length, 1);
  const t = enviados[0];
  assert.match(t, /1\. Ana — avaliação de 25\/11 .* às 11:00 — desmarcou depois do horário \(provável falta\)\n {3}https:\/\/doutorherniaacailandia\.kommo\.com\/leads\/detail\/555/);
  assert.match(t, /2\. Bruno — .* — faltou\n {3}\(cartão não achado, confira o opt-out\)/);
  assert.match(t, /3\. Carla — .* — desmarcou\n/);
  assert.doesNotMatch(t, /Lima|Costa|Dias/, 'sobrenome não vai');
  assert.equal(armazem.itens.every((i) => i.modo === 'ligado' && i.envio === 'enviado'), true);
  assert.equal(armazem.itens.find((i) => i.kommoLeadId === 555)?.pacienteChave, chaveDoPaciente('u1', 'ANA PAULA LIMA'));
});

test('ligada SEM destino: não manda e NÃO marca ninguém como listado (o dia não fica «feito» sem ter saído)', async () => {
  const { deps, armazem, enviados, chamadas } = montar({ agenda: AGENDA_DE_HOJE() }, { env: { ...ENV, RECUPERACAO_DESTINOS: '' } });
  const r = await listarRecuperacao(unit, deps);
  assert.equal(r.motivo, 'sem-destino');
  assert.deepEqual(enviados, []);
  assert.deepEqual(armazem.itens, []);
  assert.equal(chamadas.agenda, 0, 'nem gasta chamada na franquia');
});

test('ligada sem instância/chave da Evolution: não manda e não marca ninguém', async () => {
  const { deps, armazem } = montar({ agenda: AGENDA_DE_HOJE() }, { env: { RECUPERACAO_DESTINOS: ENV.RECUPERACAO_DESTINOS } });
  const r = await listarRecuperacao(unit, deps);
  assert.equal(r.motivo, 'sem-config');
  assert.deepEqual(armazem.itens, []);
});

test('teto por dia: com RECUPERACAO_MAX_POR_DIA=2 só os 2 mais recentes saem; o resto fica para outro dia', async () => {
  const { deps, armazem, enviados } = montar({ agenda: AGENDA_DE_HOJE() }, { env: { ...ENV, RECUPERACAO_MAX_POR_DIA: '2' } });
  const r = await listarRecuperacao(unit, deps);
  assert.equal(r.listados, 2);
  assert.equal(r.restantes, 1);
  assert.match(enviados[0], /\+1 ainda por conferir/);
  assert.doesNotMatch(enviados[0], /Carla/);
  assert.equal(armazem.itens.length, 2);
});

test('quem já foi listado não aparece de novo, nem no mesmo dia (outra rodada) nem no seguinte', async () => {
  const { deps, armazem, enviados } = montar({ agenda: AGENDA_DE_HOJE() });
  await listarRecuperacao(unit, deps);
  assert.equal(enviados.length, 1);
  _limparMemoriaDaRecuperacao(); // um restart no meio do dia
  const outra = await listarRecuperacao(unit, { ...deps });
  assert.equal(outra.listados, 0);
  assert.equal(enviados.length, 1, 'nada novo, nada mandado');
  assert.equal(armazem.itens.length, 3);
  const amanha = await listarRecuperacao(unit, { ...deps, agora: new Date('2026-11-27T12:00:00.000Z') });
  assert.equal(amanha.listados, 0);
  assert.equal(enviados.length, 1);
});

test('mesma pessoa, outra consulta desmarcada depois: o paciente não volta à lista dentro dos 14 dias', async () => {
  const primeira = ag('ANA PAULA LIMA', '2026-11-20', 57);
  const { deps, enviados } = montar({ agenda: [primeira] });
  await listarRecuperacao(unit, deps);
  _limparMemoriaDaRecuperacao();
  const montagem2 = montar({ agenda: [primeira, ag('ANA PAULA LIMA', '2026-11-25', 57)] }, { armazem: deps.armazem, agora: new Date('2026-11-27T12:00:00.000Z') });
  const r = await listarRecuperacao(unit, montagem2.deps);
  assert.equal(r.listados, 0);
  assert.equal(enviados.length, 1);
  assert.deepEqual(montagem2.enviados, []);
});

test('«não quero mais» no cartão (motivo de perda morto) tira da lista; motivo trabalhável fica; o resto da lista segue', async () => {
  const { deps, enviados, armazem } = montar({
    agenda: AGENDA_DE_HOJE(),
    nativos: [{ id: 7, name: 'Sem interesse' }, { id: 8, name: 'Sem condições financeiras' }],
    cartoes: { 'ANA PAULA LIMA': { lead: cartao(1, { loss_reason_id: 7 }) }, 'BRUNO COSTA': { lead: cartao(2, { loss_reason_id: 8 }) } },
  });
  const r = await listarRecuperacao(unit, deps);
  assert.deepEqual(r.saidasDoCartao, { 'motivo-morto': 1 });
  assert.equal(r.listados, 2);
  assert.doesNotMatch(enviados[0], /Ana/);
  assert.match(enviados[0], /Bruno/);
  assert.equal(armazem.itens.some((i) => i.pacienteChave === chaveDoPaciente('u1', 'ANA PAULA LIMA')), false, 'quem saiu pelo cartão não fica marcado como listado');
});

test('cartão que não pôde ser lido (Kommo fora): o paciente fica para outra rodada — na dúvida não liga', async () => {
  const { deps, enviados, armazem } = montar({ agenda: [ag('ANA PAULA LIMA', '2026-11-25', 57)], cartoes: { 'ANA PAULA LIMA': { lead: 'erro' } } });
  const r = await listarRecuperacao(unit, deps);
  assert.equal(r.incertos, 1);
  assert.equal(r.listados, 0);
  assert.deepEqual(enviados, []);
  assert.deepEqual(armazem.itens, []);
});

test('o telefone não provou o cartão (vários candidatos): a lista NÃO põe o link — «sem cartão achado» — mas o motivo morto do cartão ainda vale', async () => {
  const { deps, enviados, armazem } = montar({ agenda: [ag('ANA PAULA LIMA', '2026-11-25', 57)], cartoes: { 'ANA PAULA LIMA': { lead: cartao(555), confirmado: false } } });
  await listarRecuperacao(unit, deps);
  assert.doesNotMatch(enviados[0], /leads\/detail/);
  assert.match(enviados[0], /cartão não achado, confira o opt-out/);
  assert.equal(armazem.itens[0].kommoLeadId, null, 'palpite não vira dado gravado');
});

test('quem voltou a marcar e quem está em tratamento (franquia) não entra', async () => {
  const { deps, enviados } = montar({
    agenda: [
      ag('ANA PAULA LIMA', '2026-11-20', 57), ag('ANA PAULA LIMA', '2026-12-02', 37),
      ag('BRUNO COSTA', '2026-11-20', 40),
      ag('CARLA DIAS', '2026-11-20', 57),
    ],
    tratamentos: [{ idTreatment: 1, idClient: 9, clientName: 'BRUNO COSTA', category: null, local: null, degree: null, staffName: null, statusName: 'Em andamento', price: null, created: null }],
  });
  const r = await listarRecuperacao(unit, deps);
  assert.equal(r.listados, 1);
  assert.match(enviados[0], /Carla/);
  assert.doesNotMatch(enviados[0], /Ana|Bruno/);
});

test('agenda ou tratamentos indisponíveis (ou incompletos): sem lista — lista incompleta chamaria quem já voltou', async () => {
  const a = montar({ agenda: AGENDA_DE_HOJE() }, { buscarAgenda: async () => ({ ok: true, agendamentos: AGENDA_DE_HOJE(), truncada: true }) });
  assert.equal((await listarRecuperacao(unit, a.deps)).motivo, 'agenda-indisponivel');
  assert.deepEqual(a.enviados, []);
  _limparMemoriaDaRecuperacao();
  const b = montar({ agenda: AGENDA_DE_HOJE() }, { buscarTratamentos: async () => ({ ok: false, erro: '500', tratamentos: [] }) });
  assert.equal((await listarRecuperacao(unit, b.deps)).motivo, 'tratamentos-indisponiveis');
  assert.deepEqual(b.enviados, []);
  assert.deepEqual(b.armazem.itens, []);
});

test('a Evolution recusou: nada saiu, os itens ficam pendentes e a PRÓXIMA rodada manda de novo (sem perder ninguém)', async () => {
  const agenda = AGENDA_DE_HOJE();
  const { deps, armazem, enviados } = montar({ agenda, envio: 'recusado' });
  await listarRecuperacao(unit, deps);
  assert.equal(enviados.length, 1);
  assert.equal(armazem.itens.every((i) => i.envio === 'pendente'), true);
  const segunda = montar({ agenda }, { armazem: deps.armazem });
  const r = await listarRecuperacao(unit, segunda.deps);
  assert.equal(r.listados, 3);
  assert.equal(segunda.enviados.length, 1);
  assert.equal(armazem.itens.every((i) => i.envio === 'enviado'), true);
});

test('sem resposta da Evolution (pode ter saído): fica «incerto» e NUNCA repete', async () => {
  const { deps, armazem, enviados } = montar({ agenda: AGENDA_DE_HOJE(), envio: 'incerto' });
  await listarRecuperacao(unit, deps);
  _limparMemoriaDaRecuperacao();
  await listarRecuperacao(unit, deps);
  assert.equal(enviados.length, 1);
  assert.equal(armazem.itens.every((i) => i.envio === 'incerto'), true);
});

test('a lista passa de uma mensagem e a SEGUNDA não sai: só quem estava na primeira fica «enviado»; quem ficou na segunda fica pendente e volta', async () => {
  const agenda = Array.from({ length: 15 }, (_, i) => ag(`PACIENTE${String.fromCharCode(65 + i)} SOBRENOME`, '2026-11-25', 57));
  const cartoes = Object.fromEntries(agenda.map((a, i) => [a.clientName as string, { lead: cartao(30_000_000 + i) }]));
  const base = montar({ agenda, cartoes });
  let n = 0;
  const enviados: string[] = [];
  const deps = { ...base.deps, enviar: async ({ texto }: { texto: string }) => { enviados.push(texto); return ++n === 1 ? ('ok' as const) : ('recusado' as const); } };
  const r = await listarRecuperacao(unit, deps);
  assert.equal(r.listados, 15);
  assert.ok(enviados.length >= 2, 'a lista é mais de uma mensagem');
  assert.equal(enviados.length, 2, 'depois da falha as partes seguintes nem são tentadas');
  const enviadoNaPrimeira = base.armazem.itens.filter((i) => i.envio === 'enviado').length;
  const pendentes = base.armazem.itens.filter((i) => i.envio === 'pendente').length;
  assert.ok(enviadoNaPrimeira > 0 && pendentes > 0 && enviadoNaPrimeira + pendentes === 15, `${enviadoNaPrimeira} enviados + ${pendentes} pendentes`);
  // quem estava na primeira mensagem é o que o texto da primeira mostra
  for (const i of base.armazem.itens.filter((x) => x.envio === 'enviado')) assert.ok(i.idSchedule > 0);
  assert.match(enviados[0], /1\. Paciente/);
  // a próxima rodada manda só quem ficou pendente
  const depois: string[] = [];
  const segunda = await listarRecuperacao(unit, { ...base.deps, enviar: async ({ texto }) => { depois.push(texto); return 'ok'; } });
  assert.equal(segunda.listados, pendentes);
  assert.equal(base.armazem.itens.every((i) => i.envio === 'enviado'), true);
  assert.equal(depois.join('\n').match(/avaliação de/g)?.length, pendentes);
});

test('«provável falta» vale a hora em que o histórico viu o desmarque, não a última alteração do registro (uma edição depois da consulta não muda o que aconteceu)', async () => {
  const a = ag('ANA PAULA LIMA', '2026-11-25', 57, { modifiedUtc: '2026-11-26T09:00:00.000Z' }); // editada na quinta; consulta foi na quarta 11h local
  const comHistorico = montar({ agenda: [a] }, { lancamentos: async () => new Map([[a.idSchedule as number, new Date('2026-11-24T15:00:00.000Z')]]) });
  await listarRecuperacao(unit, comHistorico.deps);
  assert.match(comHistorico.enviados[0], /— desmarcou\n/, 'foi lançado ANTES do horário');
  _limparMemoriaDaRecuperacao();
  const semHistorico = montar({ agenda: [a] });
  await listarRecuperacao(unit, semHistorico.deps);
  assert.match(semHistorico.enviados[0], /provável falta/, 'sem o histórico vale a última alteração da franquia');
});

test('item que ficou «enviando» (o servidor caiu no meio) é solto como «incerto» na rodada seguinte: nunca repete e a medição o conta à parte', async () => {
  const agenda = [ag('ANA PAULA LIMA', '2026-11-25', 57)];
  const { deps, armazem } = montar({ agenda });
  armazem.itens.push({ unitId: 'u1', idSchedule: 1, pacienteChave: 'x', categoria: null, tipo: 'faltou', inicioEm: AGORA, modificadoEm: null, modo: 'ligado', dia: '2026-11-26', kommoLeadId: null, envio: 'enviando' });
  await listarRecuperacao(unit, deps);
  assert.equal(armazem.itens.find((i) => i.idSchedule === 1)?.envio, 'incerto');
});

test('lista simulada de manhã e a chave LIGADA no mesmo dia: a rodada «ligado» ainda sai (o dia fechado vale por modo)', async () => {
  const agenda = AGENDA_DE_HOJE();
  const seco = montar({ agenda }, { estado: 'seco' });
  await listarRecuperacao(unit, seco.deps);
  assert.equal(seco.enviados.length, 0);
  const ligada = montar({ agenda });
  const r = await listarRecuperacao(unit, ligada.deps);
  assert.equal(r.motivo, undefined);
  assert.equal(r.listados, 3);
  assert.equal(ligada.enviados.length, 1);
  // e dentro do mesmo modo o dia fecha depois da lista
  assert.equal((await listarRecuperacao(unit, ligada.deps)).motivo, 'ja-fez-hoje');
});

test('franquia fora do ar: tenta de novo a cada rodada, mas só até o teto de rodadas do dia (não martela até as 12h)', async () => {
  const { deps } = montar({ agenda: [] }, { buscarAgenda: async () => ({ ok: false, erro: '503', agendamentos: [] }) });
  const motivos: Array<string | undefined> = [];
  for (let i = 0; i < 8; i++) motivos.push((await listarRecuperacao(unit, deps)).motivo);
  assert.deepEqual(motivos.slice(0, 6), Array(6).fill('agenda-indisponivel'));
  assert.deepEqual(motivos.slice(6), ['ja-fez-hoje', 'ja-fez-hoje']);
});

test('unidade sem Kommo: nem lê a franquia (não dá para conferir quem disse «não quero mais») e o dia fecha', async () => {
  _semearCrmParaTeste([]);
  const semKommo = { ...unit, kommoAccessToken: null } as unknown as Unit;
  let leituras = 0;
  const { deps } = montar({ agenda: AGENDA_DE_HOJE() }, { kommo: undefined, resolver: undefined, buscarAgenda: async () => { leituras++; return { ok: true, agendamentos: [] }; } });
  assert.equal((await listarRecuperacao(semKommo, deps)).motivo, 'sem-kommo');
  assert.equal(leituras, 0);
  assert.equal((await listarRecuperacao(semKommo, deps)).motivo, 'ja-fez-hoje');
});

test('o servidor reinicia entre 8h e 12h depois da lista: NÃO sai uma 2ª mensagem no mesmo dia, mesmo com paciente novo', async () => {
  const velha = AGENDA_DE_HOJE();
  const primeira = montar({ agenda: velha });
  await listarRecuperacao(unit, primeira.deps);
  assert.equal(primeira.enviados.length, 1);
  _limparMemoriaDaRecuperacao(); // o deploy apagou a memória do dia; o banco ficou
  const depois = montar({ agenda: [...velha, ag('DANIELA NOVA', '2026-11-25', 57)] }, { armazem: primeira.deps.armazem });
  const r = await listarRecuperacao(unit, depois.deps);
  assert.equal(r.motivo, 'ja-fez-hoje');
  assert.deepEqual(depois.enviados, []);
  assert.equal(depois.chamadas.kommo, 0);
  // no dia seguinte volta a sair (a Daniela entra)
  const amanha = montar({ agenda: [...velha, ag('DANIELA NOVA', '2026-11-25', 57)] }, { armazem: primeira.deps.armazem, agora: new Date('2026-11-27T12:00:00.000Z') });
  await listarRecuperacao(unit, amanha.deps);
  assert.equal(amanha.enviados.length, 1);
  assert.match(amanha.enviados[0], /Daniela/);
});

test('depois de uma parte recusada, o retry do mesmo dia leva SÓ quem ficou pendente (candidato novo espera o dia seguinte)', async () => {
  const agenda = Array.from({ length: 15 }, (_, i) => ag(`PACIENTE${String.fromCharCode(65 + i)} SOBRENOME`, '2026-11-25', 57));
  const base = montar({ agenda });
  let n = 0;
  await listarRecuperacao(unit, { ...base.deps, enviar: async () => (++n === 1 ? 'ok' : 'recusado') });
  const pendentes = base.armazem.itens.filter((i) => i.envio === 'pendente').length;
  assert.ok(pendentes > 0);
  const retry = montar({ agenda: [...agenda, ag('NOVA PESSOA', '2026-11-25', 57)] }, { armazem: base.deps.armazem });
  const r = await listarRecuperacao(unit, retry.deps);
  assert.equal(r.listados, pendentes);
  assert.doesNotMatch(retry.enviados.join('\n'), /Nova/);
});

test('sem AGENDA_HISTORICO_SEGREDO a lista NÃO roda (a chave do paciente exige o segredo): nada lido, nada gravado, nada mandado', async () => {
  const guardado = process.env.AGENDA_HISTORICO_SEGREDO;
  delete process.env.AGENDA_HISTORICO_SEGREDO;
  try {
    const { deps, armazem, enviados, chamadas } = montar({ agenda: AGENDA_DE_HOJE() });
    const r = await listarRecuperacao(unit, deps);
    assert.equal(r.motivo, 'sem-segredo');
    assert.equal(chamadas.agenda, 0);
    assert.deepEqual(armazem.itens, []);
    assert.deepEqual(enviados, []);
  } finally {
    process.env.AGENDA_HISTORICO_SEGREDO = guardado;
  }
});

test('60 pacientes que o CARTÃO tira (opt-out, «sem interesse») não empurram os elegíveis para fora do teto de conferências', async () => {
  const excluidos = Array.from({ length: 60 }, (_, i) => ag(`SAI${String(i).padStart(2, '0')} CARTAO`, '2026-11-25', 57));
  const elegiveis = [ag('ELEGIVEL UM', '2026-11-24', 57), ag('ELEGIVEL DOIS', '2026-11-24', 40)];
  const cartoes = Object.fromEntries(excluidos.map((a, i) => [a.clientName as string, { lead: cartao(40_000_000 + i, { loss_reason_id: 7 }) }]));
  const { deps, enviados } = montar({ agenda: [...excluidos, ...elegiveis], cartoes, nativos: [{ id: 7, name: 'Sem interesse' }] });
  const r = await listarRecuperacao(unit, deps);
  assert.equal(r.saidasDoCartao['motivo-morto'], 60);
  assert.equal(r.listados, 2);
  assert.match(enviados[0], /Elegivel/);
});

test('quem o cartão tirou fica lembrado: a rodada seguinte não lê o cartão dele de novo', async () => {
  const a = ag('SAI CARTAO', '2026-11-25', 57);
  const m = { agenda: [a], cartoes: { 'SAI CARTAO': { lead: cartao(1, { loss_reason_id: 7 }) } }, nativos: [{ id: 7, name: 'Sem interesse' }] };
  const primeira = montar(m);
  await listarRecuperacao(unit, primeira.deps);
  assert.equal(primeira.chamadas.kommo, 1);
  const segunda = montar(m, { ignorarHorario: true }); // a mesma memória do processo, sem o «dia fechado» na frente
  const r = await listarRecuperacao(unit, segunda.deps);
  assert.equal(segunda.chamadas.kommo, 0);
  assert.equal(r.saidasDoCartao.lembrado, 1);
});

test('Kommo dividido (Petrópolis × Caxias): fora desta versão — o cartão achado poderia ser da outra unidade', async () => {
  const { deps, enviados, chamadas } = montar({ agenda: AGENDA_DE_HOJE() }, { grupo: { membros: [], contaUnitId: 'outra' } as never });
  const r = await listarRecuperacao(unit, deps);
  assert.equal(r.motivo, 'kommo-dividido');
  assert.equal(chamadas.agenda, 0);
  assert.deepEqual(enviados, []);
});

test('nunca lança: falha inesperada vira «falhou» e a rodada seguinte tenta de novo', async () => {
  const { deps } = montar({ agenda: AGENDA_DE_HOJE() }, { buscarAgenda: async () => { throw new Error('boom'); } });
  const r = await listarRecuperacao(unit, deps);
  assert.equal(r.motivo, 'falhou');
});

test('a purga da retenção também alcança a lista (itens) que passou do prazo', () => {
  assert.deepEqual(apagadores.map((a) => a.nome).sort(), ['eventos', 'itens']);
});
